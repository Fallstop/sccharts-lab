// KIELER's GO-init optimisation (scg/processors/optimizer/GOInitOptimizer.xtend; basics.md B-7, B-34): when
// tick 1 starts with a straight sequence of assignments (the "GO block": initialisations, entry actions and
// untriggered immediate transitions from the initial states), every assignment of it whose right-hand side does
// not read an input runs in reset(), before the first inputs are read.
//
// The simulator reproduces what that means for inputs (a first-tick write of an input is overwritten by the
// environment's value, and input initial values hold until the environment sets the input: B-7), and runs the
// other assignments in written order (the intended semantics; KIELER's reordering, B-34, is reported with a
// 'kieler-bug' warning). randomize() in the GO block makes KIELER's C code fail (`null` undeclared).

import type { Diagnostic } from '../types'
import type { CEffect, CExpr, CRef, CVar } from './model'
import { walkExpr } from './model'
import { noKielerNode, predecessors, type SCG, type SNode, type Thread } from './scg'
import { basicBlocks, sameElseTargets, type Analysis, type BasicBlock } from './analysis'

export interface GoBlock {
    /** The GO block's assignment nodes in order. */
    nodes: SNode[]
    /** Of those, the ones KIELER moves into reset() (right-hand side without input). */
    moved: Set<SNode>
}

/**
 * The GO block: the assignments KIELER's generated `logic()` runs under its first `if (_GO)` (GOInitOptimizer looks
 * at nothing else), in order. With the analysis it is found on KIELER's own sequence (goSequence below); without
 * one (the chart is rejected before it is scheduled) it is the root entry's basic block.
 */
export function goBlock(scg: SCG, analysis?: Pick<Analysis, 'order' | 'joins'>): GoBlock {
    const nodes = analysis?.order.length ? goSequence(scg, analysis) : rootBlock(scg)
    const moved = new Set(nodes.filter(x => x.effect && !rhsReadsInput(x.effect)))
    return { nodes, moved }
}

/**
 * KIELER's basic block of the root entry: from the root entry through assignments (and single-region superstates,
 * which KIELER removes) up to the first node that control flow also reaches from elsewhere.
 */
function rootBlock(scg: SCG): SNode[] {
    const nodes: SNode[] = []
    const seen = new Set<SNode>()
    const preds = predecessors(scg)
    const extra = sameElseTargets(scg)
    const incoming = (x: SNode) => {
        let count = extra.get(x) ?? 0
        for (const p of preds.get(x) ?? []) count += p.kind === 'cond' && p.sameElse && !p.sameTarget && p.then === x ? 2 : 1
        return count
    }
    const step = (x: SNode | undefined) => (x && incoming(x) < 2 ? x : undefined)
    let n: SNode | undefined = step(scg.root.entry.next)
    while (n && !seen.has(n)) {
        seen.add(n)
        if (n.kind === 'assign') {
            nodes.push(n)
            n = step(n.next)
        } else if (n.kind === 'fork' && n.threads!.length === 1) {
            n = step(n.threads![0].entry.next)
        } else if (n.kind === 'entry') {
            n = step(n.next)
        } else {
            break
        }
    }
    return nodes
}

/** `_taken_transitions`, the one variable of every Taken Transition Signaling effect. */
const TAKEN = Symbol('_taken_transitions')

/** The variables of a node as KIELER's ConditionalMerger collects them: an assignment's target and the references
 *  of its expression (not the target's indices), a conditional's condition. */
function nodeVariables(n: SNode): unknown[] {
    const out: unknown[] = []
    const top = (v: CVar): CVar => (v.member ? top(v.member.of) : v)
    const refs = (e: CExpr | undefined) => walkExpr(e, x => {
        if (x.k === 'ref') out.push(x.v, top(x.v))
        else if (x.k === 'call' && x.target) out.push(x.target.v, top(x.target.v))
    })
    if (n.kind === 'cond') refs(n.expr)
    const f = n.kind === 'assign' ? n.effect : undefined
    if (!f) return out
    switch (f.k) {
        case 'assign': out.push(top(f.ref.v)); refs(f.expr); break
        case 'emit': out.push(top(f.ref.v)); refs(f.value); break
        case 'print': f.args.forEach(refs); break
        case 'call': refs(f.call); break
        case 'mark': if (!noKielerNode(n)) out.push(TAKEN); break
        default: break
    }
    return out
}

/**
 * The first `if (_GO)` of KIELER's sequentialized code, after the optimizers that run before GOInitOptimizer
 * (scg/processors: SimpleGuardExpressions, SimpleGuardSequentializer, optimizer/CopyPropagationV2, HaltStateRemover,
 * ConditionalMerger):
 *
 * - Every scheduling block is `g = <guard>; if (g) { its assignments }`, in the schedule's order. The root entry's
 *   block has the guard `_GO`. A block with exactly one predecessor that is not dead, reached by plain control flow
 *   (not through a conditional's branch), has that predecessor's guard, and copy propagation puts `_GO` in its
 *   place: a thread's entry after a fork, and a state that other transitions lead back to when the blocks they come
 *   from are dead (a way back that can never be taken). Its `if` is `if (_GO)` too.
 * - A halt state's two guards (`gD = pre(gS)`, `gS = g || gD`, used nowhere else) are removed.
 * - The conditional merger moves the body of a later `if (_GO)` into the one before it when nothing is left between
 *   them, or (its "wide span") when none of the variables it reads or writes was read or written by anything before
 *   it. One that stays where it is takes the later ones.
 * - The first statement of `logic()` must be an `if (_GO)`: when another block's guard comes first, there is no GO
 *   block at all.
 */
function goSequence(scg: SCG, analysis: Pick<Analysis, 'order' | 'joins'>): SNode[] {
    const { blocks } = basicBlocks(scg)
    const blockOf = new Map<SNode, BasicBlock>()
    for (const b of blocks) for (const n of b.nodes) blockOf.set(n, b)
    const live = (b: BasicBlock) => b.preds.filter(p => !p.dead)

    const guards = new Map<BasicBlock, boolean>()
    const guardedByGo = (b: BasicBlock): boolean => {
        const known = guards.get(b)
        if (known !== undefined) return known
        guards.set(b, false)
        let go = false
        if (b.dead || b.depthOf || b.sync) go = false
        else if (b.go) go = true
        else {
            const from = live(b)
            const last = from.length === 1 ? from[0].nodes[from[0].nodes.length - 1] : undefined
            // A later thread of a sequential fork (abort regions) waits for the threads before it.
            const sequential = last?.kind === 'fork' && last.preemptive && b.nodes[0] !== last.threads?.[0]?.entry
            go = !!last && last.kind !== 'cond' && !sequential && guardedByGo(from[0])
        }
        guards.set(b, go)
        return go
    }

    // A pause whose join still watches it keeps its guard.
    const watched = (surface: SNode) => {
        for (let t: Thread | undefined = surface.thread; t?.fork; t = t.fork.thread) {
            const info = analysis.joins.get(t.fork.join!)
            if (info && !info.dead && info.sync !== 'instantaneous' && info.counted.includes(t)) return true
        }
        return false
    }
    const haltSurface = (b: BasicBlock): boolean => {
        const s = b.nodes[0]
        if (b.nodes.length !== 1 || s.kind !== 'surface' || !s.depth) return false
        const depth = blockOf.get(s.depth)
        const from = live(b)
        return !!depth && depth.nodes.length === 1 && s.depth.next === s && from.length === 2 && from.includes(depth) && !watched(s)
    }
    const removed = (b: BasicBlock) => haltSurface(b) || (!!b.depthOf && haltSurface(b.depthOf))

    const first: SNode[] = []
    const seen = new Set<unknown>()
    /** The `if (_GO)` later ones are merged into: the first of all (`first`), or one that stayed where it was. */
    let dom: 'first' | 'other' | undefined
    let adjacent = false
    let i = 0
    const order = analysis.order
    while (i < order.length) {
        const block = blockOf.get(order[i])
        let j = i
        while (j < order.length && blockOf.get(order[j]) === block) j++
        const nodes = order.slice(i, j)
        i = j
        if (!block || block.dead) continue
        const variables = nodes.flatMap(nodeVariables)
        if (!guardedByGo(block)) {
            if (removed(block)) continue
            // Its guard (and its `if`) stays between the conditionals around it.
            if (!dom) return []
            adjacent = false
            for (const v of variables) seen.add(v)
            continue
        }
        const assignments = nodes.filter(n => n.kind === 'assign')
        // (A conditional's guard is computed in the block that ends with it.)
        const condition = nodes.some(n => n.kind === 'cond')
        if (assignments.some(n => !noKielerNode(n))) {
            if (!dom) {
                dom = 'first'
                first.push(...assignments)
                for (const v of variables) seen.add(v)
                adjacent = true
            } else if (adjacent || !variables.some(v => seen.has(v))) {
                if (dom === 'first') first.push(...assignments)
            } else {
                dom = 'other'
                adjacent = true
                for (const v of variables) seen.add(v)
            }
        }
        if (condition) {
            if (!dom) return []
            adjacent = false
            for (const v of variables) seen.add(v)
        }
    }
    return first
}

function readsInputIn(e: CExpr | undefined, skipIndices: boolean): boolean {
    let found = false
    const visit = (x: CExpr) => {
        if (x.k !== 'ref') return
        if (x.v.input) found = true
    }
    if (!e) return false
    if (skipIndices) {
        // GOInitOptimizer only looks at the assignment's expression (line 99), and does not notice inputs in indices.
        const visitNoIdx = (x: CExpr): void => {
            if (x.k === 'ref') {
                if (x.v.input) found = true
                return
            }
            if (x.k === 'op') x.args.forEach(visitNoIdx)
            else if (x.k === 'vector') x.values.forEach(visitNoIdx)
            else if (x.k === 'call') x.args.forEach(visitNoIdx)
        }
        visitNoIdx(e)
        return found
    }
    walkExpr(e, visit)
    return found
}

function rhsReadsInput(f: CEffect): boolean {
    switch (f.k) {
        case 'assign': return readsInputIn(f.expr, true)
        case 'print': return f.args.some(a => readsInputIn(a, true))
        case 'call': return f.call.args.some(a => readsInputIn(a, true))
        default: return false
    }
}

function vars(f: CEffect): { writes: Set<unknown>; reads: Set<unknown> } {
    const writes = new Set<unknown>()
    const reads = new Set<unknown>()
    if (f.k === 'assign') {
        writes.add(lowermost(f.ref).v)
        walkExpr(f.expr, x => { if (x.k === 'ref') reads.add(x.v) })
        if (f.op !== '=') reads.add(lowermost(f.ref).v)
    }
    return { writes, reads }
}

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

export function goBlockDiagnostics(block: GoBlock): Diagnostic[] {
    const out: Diagnostic[] = []
    for (const n of block.nodes) {
        if (n.effect?.k === 'randomize') {
            out.push({
                severity: 'error', code: 'randomize-tick1', span: n.effect.o.span,
                related: n.effect.o.by ? [n.effect.o.by] : undefined,
                message: 'randomize() in the first tick does not compile in KIELER',
                kieler: '‘null’ undeclared (first use in this function)\nCompiler did not return success (exit value != 0)',
                hint: 'KIELER moves first-tick code into its reset function and breaks `randomize()` there. Call `randomize()` later, e.g. on a delayed transition.',
            })
        }
    }
    // B-34: a moved assignment that crosses an earlier one reading an input and touching the same variables.
    const list = block.nodes
    let warned = false
    for (let j = 0; j < list.length && !warned; j++) {
        const later = list[j]
        if (!block.moved.has(later) || !later.effect) continue
        if (later.effect.k === 'assign' && lowermost(later.effect.ref).v.input) continue
        const b = vars(later.effect)
        for (let i = 0; i < j; i++) {
            const earlier = list[i]
            if (block.moved.has(earlier) || !earlier.effect) continue
            const a = vars(earlier.effect)
            const shared = [...b.writes].some(v => a.writes.has(v) || a.reads.has(v)) || [...a.writes].some(v => b.reads.has(v))
            if (shared) {
                out.push(kielerBug(later, 'KIELER runs this first-tick assignment before the earlier ones that read an input (its netlist GO-init optimisation reorders tick 1), so it computes different values here. The guide shows the order as written.'))
                warned = true
                break
            }
        }
    }
    for (const n of list) {
        if (n.effect?.k !== 'assign' || !block.moved.has(n)) continue
        let indexInput = false
        const target = lowermost(n.effect.ref)
        for (const i of target.idx) walkExpr(i, x => { if (x.k === 'ref' && x.v.input) indexInput = true })
        walkExpr(n.effect.expr, x => {
            if (x.k === 'ref') for (const i of x.idx) walkExpr(i, y => { if (y.k === 'ref' && y.v.input) indexInput = true })
        })
        if (indexInput) out.push(kielerBug(n, 'KIELER runs this first-tick assignment before the inputs are read (its GO-init optimisation does not notice inputs in array indices), so the index uses the input\'s value before tick 1. The guide uses the tick-1 input.'))
    }
    return out
}

function kielerBug(n: SNode, message: string): Diagnostic {
    const f = n.effect!
    return {
        severity: 'warning', code: 'kieler-bug', span: f.o.span, message,
        related: f.o.by ? [f.o.by] : undefined,
        hint: 'To get the same result in KIELER and the guide, avoid combining a first-tick assignment that reads an input with other updates of the same variables in tick 1.',
    }
}

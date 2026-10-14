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
import type { CEffect, CExpr, CRef } from './model'
import { walkExpr } from './model'
import { predecessors, type SCG, type SNode } from './scg'
import { sameElseTargets } from './analysis'

export interface GoBlock {
    /** The GO block's assignment nodes in order. */
    nodes: SNode[]
    /** Of those, the ones KIELER moves into reset() (right-hand side without input). */
    moved: Set<SNode>
}

/**
 * The GO block: KIELER's basic block of the root entry, i.e. from the root entry through assignments (and
 * single-region superstates, which KIELER removes) up to the first node that control flow also reaches from
 * elsewhere (two or more incoming control flows start a new basic block: an initial state that a transition
 * returns to is not part of it).
 */
export function goBlock(scg: SCG): GoBlock {
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
    const moved = new Set(nodes.filter(x => x.effect && !rhsReadsInput(x.effect)))
    return { nodes, moved }
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

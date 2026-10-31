// Data dependencies between concurrent SCG nodes, as KIELER's dependency analysis computes them
// (kicool/processors/dependencies/AbstractDependencyAnalysis.xtend, scg/processors/DependencyTransformationV2.xtend;
// concurrency.md 1.3, 1.4):
//
// - every assignment is an absolute write, a relative write (x op= e not reading x, x++, and old-style
//   x = ... x ... reading x exactly once) or, for its operands, a read; conditionals read their condition;
// - array accesses with constant indices are accesses to that cell, others to the whole array;
// - between concurrent accesses: absolute write -> relative write -> read; two absolute writes conflict
//   (edges both ways) unless confluent (same value or structurally equal expression); relative writes with
//   non-commuting operators conflict too.

import type { AssignOperator, Span } from '../types'
import { controlflowRegions, sameExpr, walkExpr, type CExpr, type CMethod, type CRef, type CState, type CStmt, type CVar } from './model'
import { noKielerNode, type SCG, type SNode, type Thread } from './scg'

export type AccessClass = 'write' | 'relative' | 'read'

export interface Access {
    node: SNode
    v: CVar
    /** Inside a method that is called at a conditional (not an assignment): KIELER's check for non-commuting update
     *  operators does not apply (AbstractDependencyAnalysis.processDependency only compares assignments). */
    anyOp?: boolean
    /** The access is inside this method, which KIELER does not inline (innerAccesses); `_effect<n>` is a code block. */
    via?: string
    /** Constant indices of a cell access, or undefined for the whole variable / a variable index. */
    cell?: string
    cls: AccessClass
    /** The assignment operator (for writes). */
    op?: AssignOperator | '++' | '--'
    expr?: CExpr
    span?: Span
}

export interface Dependency {
    from: SNode
    to: SNode
    v: CVar
    kind: 'write-write' | 'write-relative' | 'write-read' | 'relative-read'
    confluent: boolean
    /** The accesses that cause it. */
    a: Access
    b: Access
}

const PRIORITY: Record<AccessClass, number> = { write: 0, relative: 1, read: 2 }
const PLUS_MINUS = new Set(['++', '--', '+=', '-='])

function commuting(a: string | undefined, b: string | undefined): boolean {
    return a === b || (PLUS_MINUS.has(a ?? '') && PLUS_MINUS.has(b ?? ''))
}

/** Constant-index key of a reference (`a[1][2]` -> "1,2"), undefined if any index is not a literal. */
function cellKey(r: CRef): string | undefined {
    if (!r.idx.length) return undefined
    const parts: number[] = []
    for (const i of r.idx) {
        if (i.k === 'lit' && typeof i.v === 'number') parts.push(i.v)
        else if (i.k === 'lit' && typeof i.v === 'boolean') parts.push(i.v ? 1 : 0)
        else return undefined
    }
    return parts.join(',')
}

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

/** The reads of an expression: every variable reference, including those in indices. */
function reads(node: SNode, e: CExpr | undefined, out: Access[]) {
    walkExpr(e, x => {
        if (x.k === 'ref') out.push({ node, v: x.v, cell: cellKey(x), cls: 'read', span: x.span })
    })
}

/** The accesses of one SCG node. */
export function nodeAccesses(node: SNode): Access[] {
    const out: Access[] = []
    if (node.kind === 'cond') {
        reads(node, node.expr, out)
        return out
    }
    if (node.kind !== 'assign' || !node.effect) return out
    const f = node.effect
    switch (f.k) {
        case 'assign': {
            const rhs: Access[] = []
            reads(node, f.expr, rhs)
            const target = f.ref
            const low = lowermost(target)
            // A sub reference reads its parent (member access).
            if (target.sub) reads(node, { ...target, sub: undefined, idx: [] }, out)
            const isTarget = (a: Access) => a.v === low.v && a.cell === cellKey(low)
            const ownReads = rhs.filter(isTarget).length
            // The assignment's own reads of its target are dropped once the write is recorded (deps:200-205).
            for (const a of rhs) if (!isTarget(a)) out.push(a)
            // Index expressions are read.
            for (const i of low.idx) reads(node, i, out)
            let cls: AccessClass = 'write'
            if (ownReads > 0 && ownReads === 1 && f.op === '=') cls = 'relative'
            if (f.op !== '=' && ownReads === 0) cls = 'relative'
            out.push({ node, v: low.v, cell: cellKey(low), cls, op: f.op, expr: f.expr, span: f.o.span })
            return out
        }
        case 'print':
            for (const a of f.args) reads(node, a, out)
            return out
        case 'call': {
            const call = f.call
            call.args.forEach((a, i) => {
                const mode = call.paramAccess?.[i]
                if (mode === '!&' || mode === '&') {
                    walkExpr(a, x => {
                        if (x.k === 'ref') out.push({ node, v: x.v, cell: cellKey(x), cls: mode === '!&' ? 'write' : 'relative', span: x.span })
                    })
                } else {
                    reads(node, a, out)
                }
            })
            return out
        }
        case 'emit':
            reads(node, f.value, out)
            return out
        default:
            return out
    }
}

/**
 * The accesses inside the methods a node calls that KIELER does not inline (DependencyTransformationV2
 * .processInnerAccesses): the reads and writes of the method's body, its locals and parameters left out, count as the
 * calling node's, and the calling node's operator decides whether two updates commute (a call effect is an
 * assignment with `=`, so its `x += 1` conflicts with a concurrent `x += 1`; probe structure/probe-method-inner-*).
 */
export function innerAccesses(node: SNode, isInlined: (m: CMethod) => boolean): Access[] {
    const out: Access[] = []
    const op: AssignOperator | '++' | '--' | undefined = node.kind === 'assign' && node.effect?.k === 'assign' ? node.effect.op : node.kind === 'assign' ? '=' : undefined
    const anyOp = node.kind !== 'assign'
    const visiting = new Set<CMethod>()
    let via = ''
    const tag = () => (anyOp ? { anyOp, via } : { via })
    const calls = (e: CExpr | undefined, local: Set<CVar>) => walkExpr(e, x => { if (x.k === 'call' && !x.extern && x.target?.v.method) method(x.target.v.method, local) })
    const read = (e: CExpr | undefined, local: Set<CVar>) => {
        walkExpr(e, x => { if (x.k === 'ref' && !local.has(x.v)) out.push({ node, v: x.v, cell: cellKey(x), cls: 'read', span: x.span, ...tag() }) })
        calls(e, local)
    }
    const statements = (list: CStmt[], local: Set<CVar>) => {
        for (const st of list) {
            switch (st.k) {
                case 'do': {
                    const f = st.f
                    if (f.k === 'assign') {
                        const low = lowermost(f.ref)
                        const rhs: Access[] = []
                        walkExpr(f.expr, x => { if (x.k === 'ref') rhs.push({ node, v: x.v, cell: cellKey(x), cls: 'read', span: x.span }) })
                        const isTarget = (a: Access) => a.v === low.v && a.cell === cellKey(low)
                        const ownReads = rhs.filter(isTarget).length
                        for (const a of rhs) if (!isTarget(a) && !local.has(a.v)) out.push({ ...a, ...tag() })
                        calls(f.expr, local)
                        for (const i of low.idx) read(i, local)
                        if (local.has(low.v)) break
                        let cls: AccessClass = 'write'
                        if (ownReads === 1 && f.op === '=') cls = 'relative'
                        if (f.op !== '=' && ownReads === 0) cls = 'relative'
                        out.push({ node, v: low.v, cell: cellKey(low), cls, op, span: f.o.span, ...tag() })
                    } else if (f.k === 'print') f.args.forEach(a => read(a, local))
                    else if (f.k === 'call') { f.call.args.forEach(a => read(a, local)); calls(f.call, local) }
                    else if (f.k === 'emit') read(f.value, local)
                    break
                }
                case 'if': read(st.cond, local); statements(st.then, local); if (st.else) statements(st.else, local); break
                case 'while': read(st.cond, local); statements(st.body, local); break
                case 'for': statements(st.init, local); read(st.cond, local); statements(st.update, local); statements(st.body, local); break
                case 'return': read(st.expr, local); break
                case 'expr': read(st.e, local); break
                default: break
            }
        }
    }
    function method(m: CMethod, outer: Set<CVar>) {
        if (visiting.has(m)) return
        visiting.add(m)
        statements(m.body, new Set([...outer, ...m.params, ...m.locals]))
        visiting.delete(m)
    }
    const roots: Extract<CExpr, { k: 'call' }>[] = []
    const collect = (e: CExpr | undefined) => walkExpr(e, x => { if (x.k === 'call' && !x.extern && x.target?.v.method && !isInlined(x.target.v.method)) roots.push(x) })
    if (node.kind === 'cond') collect(node.expr)
    else if (node.kind === 'assign' && node.effect) {
        const f = node.effect
        if (f.k === 'call') collect(f.call)
        else if (f.k === 'assign') { f.ref.idx.forEach(collect); collect(f.expr) }
        else if (f.k === 'emit') collect(f.value)
        else if (f.k === 'print') f.args.forEach(collect)
    }
    for (const c of roots) {
        via = c.target!.v.name
        method(c.target!.v.method!, new Set())
    }
    return out
}

/** The user schedules of a node's effect (dataflow sequences, passes/userSchedule.ts). */
function schedulesOf(n: SNode): { group: object; priority: number }[] {
    return n.kind === 'assign' ? n.effect?.o.schedule ?? [] : []
}

/**
 * KIELER's scheduled dependencies: for every schedule object, its accesses of a variable in priority order; an
 * access comes before every access of a higher priority (a write-read dependency, read or write alike), and two
 * writes of the same priority conflict. Returns, per variable, the node pairs handled here (both directions).
 */
function scheduledDependencies(byVar: Map<CVar, Access[]>, deps: Dependency[], seen: Set<string>): Map<CVar, Set<string>> {
    const out = new Map<CVar, Set<string>>()
    for (const [v, list] of byVar) {
        const groups = new Map<object, { a: Access; priority: number }[]>()
        for (const a of list) {
            for (const s of schedulesOf(a.node)) {
                let g = groups.get(s.group)
                if (!g) groups.set(s.group, (g = []))
                g.push({ a, priority: s.priority })
            }
        }
        for (const [group, g] of groups) {
            const protocols = (group as { protocols?: string[] }).protocols
            for (const x of g) {
                for (const y of g) {
                    if (x.a.node === y.a.node || x.priority > y.priority) continue
                    if (x.a.cell !== undefined && y.a.cell !== undefined && x.a.cell !== y.a.cell) continue
                    let pairs = out.get(v)
                    if (!pairs) out.set(v, (pairs = new Set()))
                    pairs.add(`${x.a.node.id}>${y.a.node.id}`)
                    pairs.add(`${y.a.node.id}>${x.a.node.id}`)
                    const xw = x.a.cls !== 'read'
                    const yw = y.a.cls !== 'read'
                    // Accesses of a confluent priority do not depend on each other (KIELER's PriorityProtocol.CONFLUENT).
                    if (x.priority === y.priority && protocols?.[x.priority] === 'confluent') continue
                    if (x.priority === y.priority && xw && !yw) continue
                    if (!concurrentThreads(x.a.node.thread, y.a.node.thread)) continue
                    const kind: Dependency['kind'] = x.priority === y.priority && xw && yw ? 'write-write' : 'write-read'
                    const key = `${x.a.node.id}>${y.a.node.id}:${v.uid}:${kind}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    deps.push({ from: x.a.node, to: y.a.node, v, kind, confluent: kind === 'write-write' && confluent(x.a, y.a), a: x.a, b: y.a })
                }
            }
        }
    }
    return out
}

/**
 * Two threads are concurrent if, below their innermost common thread, they are in different threads of one fork, and
 * that fork is not the sequential preemptive fork of a state with abort regions (DependencyTransformationV2
 * .isConcurrentTo: "sequentially ordered by fork", abortRegions.ts).
 */
export function concurrentThreads(a: Thread, b: Thread): boolean {
    if (a === b) return false
    let x = a
    let y = b
    while (x.depth > y.depth) x = x.parent!
    while (y.depth > x.depth) y = y.parent!
    if (x === y) return false // one is inside the other: sequential
    while (x.parent !== y.parent) {
        x = x.parent!
        y = y.parent!
    }
    return x.fork === y.fork && !x.fork?.preemptive
}

/** KIELER's isConfluentTo for two absolute writes. */
function confluent(a: Access, b: Access): boolean {
    if (a.node.kind !== 'assign' || b.node.kind !== 'assign') return false
    if (a.op === '=' && b.op === '=') {
        if (!a.expr || !b.expr) return false
        return sameExpr(a.expr, b.expr)
    }
    return a.op !== undefined && a.op === b.op
}

/**
 * KIELER's search for accesses (DependencyTransformationV2.searchDependencies), where it ends early. It walks the graph
 * depth first from the root's entry with a stack (a fork pushes its join, then its threads; a conditional its else,
 * then its then branch) while `!nodes.empty && nodes.peek !== null`. A state without nodes (a referenced chart's state
 * whose first immediate transition goes back to it without trigger, scg.ts simpleState) leaves the flows into it
 * without target (SCGTransformation.transformSCGConnectNodes):
 *
 * - a thread entry still gets a flow, with no target node: null goes on the stack and the search ends there. The
 *   nodes still on the stack and those behind them get no accesses, so no data dependencies (`stop`);
 * - an assignment gets no flow, and the search skips it;
 * - a conditional, a depth or a join gets no flow either, and the search throws a NullPointerException (`crash`).
 *
 * Returns undefined if the search goes through the whole graph.
 */
export function dependencyReach(scg: SCG): { reached: Set<SNode>; stop?: SNode; crash?: SNode; into?: CState } | undefined {
    const visited = new Set<SNode | null>()
    const stack: (SNode | null)[] = []
    const reached = new Set<SNode>()
    let stop: SNode | undefined
    let into: CState | undefined
    /** The node a flow leads to in KIELER's graph (marks without KIELER effects are no nodes there). */
    const target = (n: SNode | undefined): { node?: SNode; state?: CState } => {
        let state: CState | undefined
        const seen = new Set<SNode>()
        while (n && noKielerNode(n) && !seen.has(n)) {
            seen.add(n)
            state = n.transition?.target ?? state
            n = n.next
        }
        return { node: n, state }
    }
    const push = (n: SNode) => {
        if (visited.has(n)) return
        visited.add(n)
        stack.push(n)
    }
    /** Follows a flow; false if KIELER throws on it. */
    const follow = (from: SNode, to: SNode | undefined, missing: 'stop' | 'skip' | 'crash'): boolean => {
        const t = target(to)
        if (t.node) {
            push(t.node)
            return true
        }
        into = t.state ?? from.transition?.target ?? (from.kind === 'entry' ? from.thread.region?.states.find(s => s.initial) : from.state?.out[0]?.target)
        if (missing === 'skip') return true
        if (missing === 'crash') return false
        if (!visited.has(null)) {
            visited.add(null)
            stack.push(null)
            stop = from
        }
        return true
    }
    let crash: SNode | undefined
    follow(scg.root.entry, scg.root.entry.next, 'stop')
    while (stack.length > 0 && stack[stack.length - 1] !== null) {
        const n = stack.pop()!
        reached.add(n)
        let ok = true
        switch (n.kind) {
            case 'assign':
                ok = follow(n, n.next, 'skip')
                break
            case 'entry':
                ok = follow(n, n.next, 'stop')
                break
            case 'depth': case 'join':
                ok = follow(n, n.next, 'crash')
                break
            case 'cond':
                // KIELER's equal-branch defect: its else flow also goes to the then branch's node.
                ok = follow(n, n.sameElse ? n.sameTarget ?? n.then : n.else, 'crash') && follow(n, n.then, 'crash')
                break
            case 'fork':
                if (n.join) push(n.join)
                for (const t of n.threads ?? []) push(t.entry)
                break
            case 'surface':
                if (n.depth) push(n.depth)
                break
            default:
                break
        }
        if (!ok) {
            crash = n
            break
        }
    }
    // The state without node itself: below single-region superstates (whose fork KIELER removed) if need be.
    for (let i = 0; into && i < 100; i++) {
        const regions = controlflowRegions(into)
        const initial = regions.length === 1 ? regions[0].states.find(x => x.initial) : undefined
        if (!initial) break
        into = initial
    }
    if (crash) return { reached, crash, into }
    return stop && stack.length > 0 ? { reached, stop, into } : undefined
}

/**
 * The concurrent dependencies among the given nodes (only those matter for scheduling; dependencies within one
 * thread are ordered by its control flow). `reached`: only these nodes' accesses count (dependencyReach).
 */
export function dependencies(nodes: SNode[], reached?: Set<SNode>, isInlined: (m: CMethod) => boolean = () => true): { deps: Dependency[]; accesses: Map<SNode, Access[]> } {
    const accesses = new Map<SNode, Access[]>()
    const byVar = new Map<CVar, Access[]>()
    for (const n of nodes) {
        const list = [...nodeAccesses(n), ...innerAccesses(n, isInlined)]
        accesses.set(n, list)
        if (reached && !reached.has(n)) continue
        for (const a of list) {
            let l = byVar.get(a.v)
            if (!l) byVar.set(a.v, (l = []))
            l.push(a)
        }
    }
    const deps: Dependency[] = []
    const seen = new Set<string>()
    // User schedules first (AbstractDependencyAnalysis.processDependencies): the accesses of one schedule object are
    // ordered by priority, whatever they are; those node pairs are left out of initialise-update-read below.
    const scheduled = scheduledDependencies(byVar, deps, seen)
    for (const [v, list] of byVar) {
        if (list.length < 2) continue
        const exclude = scheduled.get(v)
        for (const a of list) {
            for (const b of list) {
                if (a === b || a.node === b.node) continue
                if (exclude?.has(`${a.node.id}>${b.node.id}`)) continue
                if (PRIORITY[a.cls] > PRIORITY[b.cls]) continue
                // Different constant cells of an array do not interact (C-8).
                if (a.cell !== undefined && b.cell !== undefined && a.cell !== b.cell) continue
                let kind: Dependency['kind'] | undefined
                if (a.cls === 'write') kind = b.cls === 'write' ? 'write-write' : b.cls === 'relative' ? 'write-relative' : 'write-read'
                else if (a.cls === 'relative') {
                    if (b.cls === 'read') kind = 'relative-read'
                    else if (b.cls === 'relative' && !a.anyOp && !b.anyOp && !commuting(a.op, b.op)) kind = 'write-write'
                }
                if (!kind) continue
                if (!concurrentThreads(a.node.thread, b.node.thread)) continue
                const isConfluent = kind === 'write-write' && confluent(a, b)
                const key = `${a.node.id}>${b.node.id}:${v.uid}:${kind}`
                if (seen.has(key)) continue
                seen.add(key)
                deps.push({ from: a.node, to: b.node, v, kind, confluent: isConfluent, a, b })
            }
        }
    }
    return { deps, accesses }
}

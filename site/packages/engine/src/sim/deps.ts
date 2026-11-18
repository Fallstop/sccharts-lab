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
import { controlflowRegions, CVar, sameExpr, walkExpr, type CExpr, type CMethod, type CRef, type CState, type CStmt, type SchedEntry } from './model'
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
    /**
     * KIELER's ValuedObjectIdentifier below the variable: per level of `os[1].arr[2]` (the instance, then the member) its
     * constant indices, or `*` for none or one that is not a literal ("1/2", "1/*", "*").
     */
    sig: string
    /** The lowermost level has constant indices (isArraySpecificIdentifier). */
    specific: boolean
    /** No level has constant indices: the identifier the specific ones are also compared with. */
    generic: boolean
    /**
     * A member of the instance whose method (one KIELER does not inline) contains the access: KIELER reads it through
     * the method's own `self` parameter, so it only meets the accesses inside the same method, of any instance, and
     * never one outside (probes structure/probe-method-self-*).
     */
    bucket?: object
    cls: AccessClass
    /** The assignment operator (for writes). */
    op?: AssignOperator | '++' | '--'
    expr?: CExpr
    span?: Span
    /** Schedules of this access itself (a trigger's or a read's `schedule s 1`), besides its node's. */
    sched?: SchedEntry[]
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

/** The operator of an assignment node as KIELER's dependency analysis sees it (other effects are assignments with =). */
function nodeOp(node: SNode): string | undefined {
    if (node.kind !== 'assign') return undefined
    return node.effect?.k === 'assign' ? node.effect.op : '='
}

function commuting(a: string | undefined, b: string | undefined): boolean {
    return a === b || (PLUS_MINUS.has(a ?? '') && PLUS_MINUS.has(b ?? ''))
}

/** Constant indices (`a[1][2]` -> "1,2"), or `*` if there are none or one is not a literal. */
function constants(idx: CExpr[]): string {
    if (!idx.length) return '*'
    const parts: number[] = []
    for (const i of idx) {
        if (i.k === 'lit' && typeof i.v === 'number') parts.push(i.v)
        else if (i.k === 'lit' && typeof i.v === 'boolean') parts.push(i.v ? 1 : 0)
        else return '*'
    }
    return parts.join(',')
}

/**
 * KIELER's identifier of a reference (ValuedObjectIdentifier: the valued object, its constant indices, and the same of
 * the instance it is a member of). A member of an array of instances has the instance's dimensions in front of its
 * own (lower.ts declareMembers), so its indices are split by level here. Two identifiers are the same only if every
 * level is: `cells[n].v` and `cells[1].v` are different ones. `below` leaves out the levels down to that instance.
 */
function identifier(r: CRef, below?: CVar): Pick<Access, 'sig' | 'specific' | 'generic'> {
    const chain: CVar[] = []
    for (let v: CVar | undefined = r.v; v && v !== below; v = v.member?.of) chain.unshift(v)
    let at = below ? below.dims.length : 0
    const levels = chain.map((v, k) => {
        // The lowermost level takes what is left (an index beyond the declared dimensions too).
        const end = k === chain.length - 1 ? r.idx.length : at + v.dims.length - (v.member?.of.dims.length ?? 0)
        const level = constants(r.idx.slice(at, end))
        at = end
        return level
    })
    return { sig: levels.join('/'), specific: levels[levels.length - 1] !== '*', generic: levels.every(l => l === '*') }
}

/** Whether KIELER compares two accesses of one variable: those of one identifier, and a specific one (`a[1]`) with the
 *  accesses of the identifier without any index (AbstractDependencyAnalysis.addDependencies). */
function interacting(a: Access, b: Access): boolean {
    return a.sig === b.sig || (a.generic && b.specific) || (b.generic && a.specific)
}

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

/**
 * A member access reads the instances it goes through: `a.q.v` reads `a.q` and `a` (KIELER makes an access for every
 * reference of the chain). Only `a.q = a.p`, a write of the whole instance, ever meets these reads: it comes before
 * every concurrent access of a member of `a.q` (probes structure/probe-struct-assign-*).
 */
function instanceReads(node: SNode, r: CRef, out: Access[]) {
    for (let v = r.v.member?.of; v; v = v.member?.of) {
        out.push({ node, v, ...identifier({ k: 'ref', v, idx: r.idx.slice(0, v.dims.length) }), cls: 'read', span: r.span })
    }
}

/** The reads of an expression: every variable reference, including those in indices. */
function reads(node: SNode, e: CExpr | undefined, out: Access[]) {
    walkExpr(e, x => {
        if (x.k !== 'ref') return
        out.push({ node, v: x.v, ...identifier(x), cls: 'read', span: x.span, ...(x.sched ? { sched: x.sched } : {}) })
        instanceReads(node, x, out)
    })
}

/** The accesses of one SCG node. */
export function nodeAccesses(node: SNode): Access[] {
    const out: Access[] = []
    if (node.kind === 'cond') {
        reads(node, node.expr, out)
        // A trigger's schedule goes to every reference it reads (SCGTransformation: the trigger schedule).
        const top = node.expr?.sched
        if (top) for (const a of out) a.sched = [...(a.sched ?? []), ...top]
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
            instanceReads(node, low, out)
            const lowId = identifier(low)
            const isTarget = (a: Access) => a.v === low.v && a.sig === lowId.sig
            const ownReads = rhs.filter(isTarget).length
            // The assignment's own reads of its target are dropped once the write is recorded (deps:200-205).
            for (const a of rhs) if (!isTarget(a)) out.push(a)
            // Index expressions are read.
            for (const i of low.idx) reads(node, i, out)
            let cls: AccessClass = 'write'
            if (ownReads > 0 && ownReads === 1 && f.op === '=') cls = 'relative'
            if (f.op !== '=' && ownReads === 0) cls = 'relative'
            out.push({ node, v: low.v, ...lowId, cls, op: f.op, expr: f.expr, span: f.o.span })
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
                        if (x.k === 'ref') out.push({ node, v: x.v, ...identifier(x), cls: mode === '!&' ? 'write' : 'relative', span: x.span })
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
export function innerAccesses(node: SNode, isInlined: (m: CMethod) => boolean, buckets = new Map<string, object>()): Access[] {
    const out: Access[] = []
    const op: AssignOperator | '++' | '--' | undefined = node.kind === 'assign' && node.effect?.k === 'assign' ? node.effect.op : node.kind === 'assign' ? '=' : undefined
    // The calling node's expression: KIELER's check for two writes of one value compares the nodes (isConfluentTo).
    const expr = node.kind === 'assign' ? (node.effect?.k === 'assign' ? node.effect.expr : node.effect?.k === 'call' ? node.effect.call : undefined) : undefined
    const anyOp = node.kind !== 'assign'
    const visiting = new Set<CMethod>()
    let via = ''
    /** The method KIELER keeps as a function around the access, and its instance (`self`), if it is a class's. */
    let self: { id: string; inst: CVar } | undefined
    const tag = () => (anyOp ? { anyOp, via } : { via })
    /** The identifier of a reference inside the method: a member of `self` is the method's own (Access.bucket). */
    const key = (r: CRef): Pick<Access, 'sig' | 'specific' | 'generic' | 'bucket'> => {
        if (!self) return identifier(r)
        const path: string[] = []
        let v: CVar | undefined = r.v
        for (; v && v !== self.inst; v = v.member?.of) path.unshift(v.member?.name ?? v.name)
        if (!v) return identifier(r)
        const id = `${self.id}|${path.join('.')}`
        let bucket = buckets.get(id)
        if (!bucket) buckets.set(id, (bucket = { id }))
        return { ...identifier(r, self.inst), bucket }
    }
    const calls = (e: CExpr | undefined, local: Set<CVar>) => walkExpr(e, x => { if (x.k === 'call' && !x.extern && x.target?.v.method) method(x.target.v, local) })
    const read = (e: CExpr | undefined, local: Set<CVar>) => {
        walkExpr(e, x => { if (x.k === 'ref' && !local.has(x.v)) out.push({ node, v: x.v, ...key(x), cls: 'read', span: x.span, ...tag() }) })
        calls(e, local)
    }
    const statements = (list: CStmt[], local: Set<CVar>) => {
        for (const st of list) {
            switch (st.k) {
                case 'do': {
                    const f = st.f
                    if (f.k === 'assign') {
                        const low = lowermost(f.ref)
                        const lowKey = key(low)
                        const rhs: Access[] = []
                        walkExpr(f.expr, x => { if (x.k === 'ref') rhs.push({ node, v: x.v, ...key(x), cls: 'read', span: x.span }) })
                        const isTarget = (a: Access) => a.v === low.v && a.sig === lowKey.sig
                        const ownReads = rhs.filter(isTarget).length
                        for (const a of rhs) if (!isTarget(a) && !local.has(a.v)) out.push({ ...a, ...tag() })
                        calls(f.expr, local)
                        for (const i of low.idx) read(i, local)
                        if (local.has(low.v)) break
                        let cls: AccessClass = 'write'
                        if (ownReads === 1 && f.op === '=') cls = 'relative'
                        if (f.op !== '=' && ownReads === 0) cls = 'relative'
                        out.push({ node, v: low.v, ...lowKey, cls, op, expr, span: f.o.span, ...tag() })
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
    function method(mv: CVar, outer: Set<CVar>) {
        const m = mv.method!
        if (visiting.has(m)) return
        visiting.add(m)
        // A method KIELER inlines into this one reads through this one's `self`; one it keeps has its own.
        const saved = self
        // (A chart instance's method, `ref C g`: the class KIELER makes of the declaration, and the instance.)
        if (!isInlined(m)) {
            self = mv.member ? { id: mv.decl ?? mv.name, inst: mv.member.of }
                : m.instance ? { id: `${m.cls}|${mv.decl?.split('/').pop()}`, inst: m.instance } : undefined
        }
        statements(m.body, new Set([...outer, ...m.params, ...m.locals]))
        self = saved
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
        via = c.target!.v.display ?? c.target!.v.name
        self = undefined
        method(c.target!.v, new Set())
    }
    return out
}

/** The user schedules of an access: its node's effect's (passes/userSchedule.ts) and its own. */
function schedulesOf(a: Access): SchedEntry[] {
    const node = a.node.kind === 'assign' ? a.node.effect?.o.schedule ?? [] : []
    return a.sched ? [...node, ...a.sched] : node
}

/** KIELER's PriorityProtocol of each priority of a schedule object: a `schedule` declaration's or a generated one's. */
function protocolsOf(group: object): string[] | undefined {
    if (group instanceof CVar) return group.priorities?.map(p => (p === 'commuting' ? 'confluent' : 'conflict'))
    return (group as { protocols?: string[] }).protocols
}

/**
 * KIELER's scheduled dependencies: for every schedule object, its accesses of a variable in priority order; an
 * access comes before every access of a higher priority (a write-read dependency, read or write alike), and two
 * writes of the same priority conflict. Returns, per variable, the node pairs handled here (both directions).
 */
function scheduledDependencies(byVar: Map<object, Access[]>, deps: Dependency[], seen: Set<string>): Map<object, Set<string>> {
    const out = new Map<object, Set<string>>()
    for (const [bucket, list] of byVar) {
        const v = list[0].v
        const groups = new Map<object, { a: Access; priority: number }[]>()
        for (const a of list) {
            for (const s of schedulesOf(a)) {
                let g = groups.get(s.group)
                if (!g) groups.set(s.group, (g = []))
                g.push({ a, priority: s.priority })
            }
        }
        for (const [group, g] of groups) {
            const protocols = protocolsOf(group)
            for (const x of g) {
                for (const y of g) {
                    if (x.a.node === y.a.node || x.priority > y.priority) continue
                    if (!interacting(x.a, y.a)) continue
                    let pairs = out.get(bucket)
                    if (!pairs) out.set(bucket, (pairs = new Set()))
                    pairs.add(`${x.a.node.id}>${y.a.node.id}`)
                    pairs.add(`${y.a.node.id}>${x.a.node.id}`)
                    const xw = x.a.cls !== 'read'
                    const yw = y.a.cls !== 'read'
                    // KIELER quirk: a scheduled access's priority takes the place of its access class, and priority 1
                    // is GLOBAL_RELATIVE_WRITE, so two assignments at priority 1 whose operators do not commute (+= and
                    // =) are a write-write pair, whatever the protocol and even for a read (processDependency).
                    const [xo, yo] = [nodeOp(x.a.node), nodeOp(y.a.node)]
                    if (x.priority === 1 && y.priority === 1 && xo && yo && !x.a.anyOp && !y.a.anyOp && !commuting(xo, yo)) {
                        if (!concurrentThreads(x.a.node.thread, y.a.node.thread)) continue
                        const key = `${x.a.node.id}>${y.a.node.id}:${v.uid}:write-write`
                        if (seen.has(key)) continue
                        seen.add(key)
                        deps.push({ from: x.a.node, to: y.a.node, v, kind: 'write-write', confluent: confluent(x.a, y.a), a: x.a, b: y.a })
                        continue
                    }
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

const SAME_VALUE_OPS = new Set(['||', '|', '&&', '&'])
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/'])

/**
 * KIELER's areOldConfluentSetter (KEffectsDependencyExtensions): two old-style updates `x = x op e` of one variable,
 * each naming it once, as a direct operand, count as the same write when the operators combine: the same one of
 * + - * /, a mix of + and -, a mix of * and /, or the same one of || | && & with the same literal. It only shows where
 * such updates are compared as writes: at one priority of a schedule (`x = x + 1 schedule s 0` next to
 * `x = x + 2 schedule s 0` is accepted; probes schedules/probe-schedule-old-setter-*).
 */
function oldConfluentSetters(a: Access, b: Access): boolean {
    const [x, y] = [a.expr, b.expr]
    if (x?.k !== 'op' || y?.k !== 'op' || a.v !== b.v) return false
    const once = (e: CExpr, v: CVar) => {
        let n = 0
        walkExpr(e, r => { if (r !== e && r.k === 'ref' && r.v === v) n++ })
        return n === 1
    }
    const operand = (e: Extract<CExpr, { k: 'op' }>, v: CVar) => e.args.some(r => r.k === 'ref' && r.v === v)
    if (!once(x, a.v) || !once(y, b.v) || !operand(x, a.v) || !operand(y, b.v)) return false
    if (x.op === y.op) {
        if (SAME_VALUE_OPS.has(x.op)) {
            if (x.args.length !== 2 || y.args.length !== 2) return false
            const [p, q] = [x.args.find(r => r.k === 'lit'), y.args.find(r => r.k === 'lit')]
            return p?.k === 'lit' && q?.k === 'lit' && p.t === q.t && p.v === q.v
        }
        return ARITHMETIC_OPS.has(x.op)
    }
    const both = (ops: string[]) => ops.includes(x.op) && ops.includes(y.op)
    return both(['+', '-']) || both(['*', '/'])
}

/** KIELER's isConfluentTo for two absolute writes. */
function confluent(a: Access, b: Access): boolean {
    if (a.node.kind !== 'assign' || b.node.kind !== 'assign') return false
    if (a.op === '=' && b.op === '=') {
        if (!a.expr || !b.expr) return false
        return sameExpr(a.expr, b.expr) || oldConfluentSetters(a, b)
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
    // The accesses KIELER compares with each other: those of one variable, or of one method's `self` member.
    const byVar = new Map<object, Access[]>()
    const buckets = new Map<string, object>()
    for (const n of nodes) {
        const list = [...nodeAccesses(n), ...innerAccesses(n, isInlined, buckets)]
        accesses.set(n, list)
        if (reached && !reached.has(n)) continue
        for (const a of list) {
            const bucket = a.bucket ?? a.v
            let l = byVar.get(bucket)
            if (!l) byVar.set(bucket, (l = []))
            l.push(a)
        }
    }
    const deps: Dependency[] = []
    const seen = new Set<string>()
    // User schedules first (AbstractDependencyAnalysis.processDependencies): the accesses of one schedule object are
    // ordered by priority, whatever they are; those node pairs are left out of initialise-update-read below.
    const scheduled = scheduledDependencies(byVar, deps, seen)
    for (const [bucket, list] of byVar) {
        if (list.length < 2) continue
        const v = list[0].v
        const exclude = scheduled.get(bucket)
        for (const a of list) {
            for (const b of list) {
                if (a === b || a.node === b.node) continue
                if (exclude?.has(`${a.node.id}>${b.node.id}`)) continue
                if (PRIORITY[a.cls] > PRIORITY[b.cls]) continue
                // Different constant cells of an array do not interact (C-8).
                if (!interacting(a, b)) continue
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

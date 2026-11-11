// Static analysis of the SCG, as KIELER's netlist chain does it (scg/system/de.cau.cs.kieler.scg.netlist.kico):
//
// 1. Thread analysis (ThreadAnalyzer, SCGThreadExtensions.getThreadControlFlowTypes): is a thread's exit reached
//    in the tick it starts, always (instantaneous), sometimes (potentially instantaneous) or never (delayed)?
// 2. Loop analysis (LoopAnalyzerV2, TarjanSCC): strongly connected components of the graph of control flow
//    within a tick plus concurrent, non-confluent data dependencies. Such loops give KIELER's
//    "Potential instantaneous loop" warning.
// 3. Structural depth join (StructuralDepthJoinProcessor): a fork and join inside such a loop with a potentially
//    instantaneous thread is "schizophrenic" (re-entered in the tick it is left). KIELER copies the loop's nodes
//    of that thread; the copies, reached when the thread starts, cannot reach the thread's exit.
// 4. Scheduling (SimpleGuardScheduler on the guards of SimpleGuardExpressions): the graph with every join's
//    synchronizer dependencies must be acyclic, or KIELER rejects the chart ("The SCG is NOT asc-schedulable!").
//    The topological order is the schedule the simulator runs.

import type { Dependency } from './deps'
import { predecessors, successors, type SCG, type SNode, type Thread } from './scg'

export type PathType = 'instantaneous' | 'potentially' | 'delayed' | 'disconnected'

/** `any`: KIELER's ParOrSynchronizer for the par-or join of a state with abort regions (abortRegions.ts). */
export type SyncKind = 'instantaneous' | 'depth' | 'surface' | 'any'

export interface JoinInfo {
    join: SNode
    sync: SyncKind
    /** A dead join (some thread can never exit) never fires (BasicBlockTransformation's dead blocks). */
    dead: boolean
    /** Threads the join's guard waits for (KIELER's counted exits). */
    counted: Thread[]
    /** Instantaneous synchronizer: the one exit it reads. */
    first?: Thread
}

export interface Analysis {
    /** Thread path types after curing. */
    pathTypes: Map<Thread, PathType>
    /** Nodes in KIELER's instantaneous loops (before curing): the warning. */
    loops: SNode[][]
    /** Forks KIELER cures (schizophrenic). */
    cured: SNode[]
    joins: Map<SNode, JoinInfo>
    /** Remaining cycles: the chart is not schedulable. */
    cycles: SNode[][]
    /** Topological order of all nodes (when there are no cycles). */
    order: SNode[]
    /** A KIELER compiler failure emulated (e.g. "A cured fork still seems to be schizophrenic"). */
    failure?: string
    /** The concurrent, non-confluent dependencies after curing (what the schedule respects). */
    deps: Dependency[]
    /**
     * Curing cut these paths of source transitions into a thread's exit (concurrency.md K-3): when the thread is
     * re-entered in the tick it is left, KIELER does not let it terminate in that tick.
     */
    lostTerminations: { thread: Thread; node: SNode }[]
    /**
     * Some curing step had a choice between superstates (two or more cureable forks, neither inside the other).
     * KIELER takes them in the order of a hash map of EMF objects, which changes from run to run.
     */
    ambiguous: boolean
    /** The forks to choose from at the first such choice. */
    choice?: SNode[]
    /** At each choice, how many forks KIELER may have taken first (see AnalysisInput.script). */
    decisions: number[]
    /** Positions of the cured forks in the graph before curing, in cure order (to compare runs). */
    curedAt: number[]
    /**
     * Abort regions (abortRegions.ts): a thread entry or depth of a preemptive fork's thread does not run when one of
     * these thread exits ran earlier in the tick.
     */
    preemption: Map<SNode, SNode[]>
    /** The scheduling blocks depend on each other in a cycle although the nodes do not (the node order is used). */
    blockCycle?: boolean
}

// ---------------------------------------------------------------------------------------------------
// Thread path types
// ---------------------------------------------------------------------------------------------------

function combineDirect(old: PathType, type: PathType): PathType {
    switch (old) {
        case 'disconnected': return type
        case 'instantaneous': return type === 'disconnected' ? old : type === 'instantaneous' ? type : 'potentially'
        case 'delayed': return type === 'disconnected' ? old : type === 'delayed' ? type : 'potentially'
        case 'potentially': return old
    }
}

function combineFork(old: PathType, type: PathType): PathType {
    switch (old) {
        case 'disconnected': return type
        case 'instantaneous': return type === 'disconnected' ? old : type === 'delayed' || type === 'instantaneous' ? type : 'potentially'
        case 'delayed': return old
        case 'potentially': return type === 'disconnected' ? old : type === 'delayed' ? type : 'potentially'
    }
}

/** getThreadControlFlowTypes, ported: the worklist algorithm with KIELER's handling of loops. */
export function threadPathTypes(scg: SCG): Map<Thread, PathType> {
    const temp = new Map<SNode, PathType>()
    const next: SNode[] = [scg.root.entry]
    const queued = new Set<SNode>([scg.root.entry])
    const inNext = (n: SNode) => queued.has(n)
    const shift = () => { queued.delete(next.shift()!) }
    const unshift = (n: SNode) => { next.unshift(n); queued.add(n) }
    let guard = 0
    while (next.length > 0 && guard++ < 10_000_000) {
        const n = next[0]
        if (n.kind === 'exit') {
            temp.set(n, 'instantaneous')
            shift()
        } else if (n.kind === 'fork') {
            let joinType: PathType = 'disconnected'
            let allDefined = true
            const join = n.join!
            if (temp.has(join)) joinType = temp.get(join)!
            else {
                allDefined = false
                unshift(join)
            }
            let sourcesType: PathType = 'disconnected'
            for (const t of n.threads!) {
                const s = t.entry
                if (temp.has(s)) sourcesType = combineFork(sourcesType, temp.get(s)!)
                else if (inNext(s)) sourcesType = combineFork(sourcesType, 'instantaneous')
                else {
                    allDefined = false
                    unshift(s)
                }
            }
            if (allDefined) {
                temp.set(n, combineFork(joinType, sourcesType))
                shift()
            }
        } else if (n.kind === 'surface') {
            temp.set(n, 'delayed')
            shift()
            const d = n.depth!
            if (!temp.has(d) && !inNext(d)) {
                next.push(d)
                queued.add(d)
            }
        } else {
            const targets = n.kind === 'cond' ? [n.then, n.else] : [n.next]
            let type: PathType = 'disconnected'
            let allDefined = true
            for (const t of targets) {
                if (!t) continue
                if (temp.has(t)) type = combineDirect(type, temp.get(t)!)
                else if (inNext(t)) type = combineDirect(type, 'instantaneous')
                else {
                    allDefined = false
                    unshift(t)
                }
            }
            if (allDefined) {
                temp.set(n, type)
                shift()
            }
        }
    }
    const raw = new Map<Thread, PathType>()
    for (const t of scg.threads) {
        const type = temp.get(t.entry)
        if (type !== undefined) raw.set(t, type)
    }
    specialForkJoins(scg, raw)
    // FinalThreadProcessor (after the thread analysis): a final region's thread is potentially instantaneous.
    const out = new Map<Thread, PathType>()
    for (const [t, type] of raw) out.set(t, t.final ? 'potentially' : type)
    return out
}

const ORDINAL: Record<PathType, number> = { instantaneous: 1, potentially: 2, delayed: 3, disconnected: 4 }
const BY_ORDINAL: PathType[] = ['disconnected', 'instantaneous', 'potentially', 'delayed', 'disconnected']

/**
 * ThreadAnalyzer.postProcessSpecialForkJoins for abort regions: in a sequential preemptive fork a thread after a
 * (potentially) instantaneous one is (potentially) instantaneous too; for a par-or join the same backwards.
 */
function specialForkJoins(scg: SCG, types: Map<Thread, PathType>) {
    const degraded = new Set<Thread>()
    const forks = scg.nodes.filter(n => n.kind === 'fork' && (n.preemptive || n.join?.any))
    for (const fork of forks) {
        if (!fork.preemptive) continue
        let fastest = ORDINAL.disconnected
        for (const t of fork.threads!) {
            const current = types.get(t)
            if (current === undefined) continue
            const o = ORDINAL[current]
            if (o < fastest) fastest = o
            else if (o > fastest && fastest < ORDINAL.delayed) {
                types.set(t, BY_ORDINAL[fastest])
                degraded.add(t)
            }
        }
    }
    for (const fork of forks) {
        if (!fork.join?.any || !fork.preemptive) continue
        let fastest = ORDINAL.disconnected
        for (const t of [...fork.threads!].reverse()) {
            const current = types.get(t)
            if (current === undefined) continue
            const o = ORDINAL[current]
            if (o < fastest && !degraded.has(t)) fastest = o
            else if (o > fastest) types.set(t, BY_ORDINAL[fastest])
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// Strongly connected components (Tarjan, iterative)
// ---------------------------------------------------------------------------------------------------

export function stronglyConnected(nodes: SNode[], neighbours: (n: SNode) => SNode[]): SNode[][] {
    const index = new Map<SNode, number>()
    const low = new Map<SNode, number>()
    const onStack = new Set<SNode>()
    const stack: SNode[] = []
    const result: SNode[][] = []
    let counter = 0
    const contained = new Set(nodes)
    for (const start of nodes) {
        if (index.has(start)) continue
        const work: { n: SNode; it: SNode[]; i: number }[] = [{ n: start, it: neighbours(start).filter(x => contained.has(x)), i: 0 }]
        index.set(start, counter)
        low.set(start, counter)
        counter++
        stack.push(start)
        onStack.add(start)
        while (work.length) {
            const top = work[work.length - 1]
            if (top.i < top.it.length) {
                const m = top.it[top.i++]
                if (!index.has(m)) {
                    index.set(m, counter)
                    low.set(m, counter)
                    counter++
                    stack.push(m)
                    onStack.add(m)
                    work.push({ n: m, it: neighbours(m).filter(x => contained.has(x)), i: 0 })
                } else if (onStack.has(m)) {
                    low.set(top.n, Math.min(low.get(top.n)!, index.get(m)!))
                }
            } else {
                work.pop()
                if (work.length) {
                    const parent = work[work.length - 1].n
                    low.set(parent, Math.min(low.get(parent)!, low.get(top.n)!))
                }
                if (low.get(top.n) === index.get(top.n)) {
                    const scc: SNode[] = []
                    let w: SNode
                    do {
                        w = stack.pop()!
                        onStack.delete(w)
                        scc.push(w)
                    } while (w !== top.n)
                    result.push(scc)
                }
            }
        }
    }
    return result
}

// ---------------------------------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------------------------------

const threadIndexCache = new WeakMap<SNode[], Map<Thread, SNode[]>>()

/** Nodes of a thread including nested threads (KIELER's getAllThreadNodesAndThreads / getThreadNodes). */
export function threadNodes(scg: SCG, t: Thread): SNode[] {
    let index = threadIndexCache.get(scg.nodes)
    if (!index) {
        index = new Map()
        for (const n of scg.nodes) {
            for (let y: Thread | undefined = n.thread; y; y = y.parent) {
                if (n === y.exit) continue
                let l = index.get(y)
                if (!l) index.set(y, (l = []))
                l.push(n)
            }
        }
        threadIndexCache.set(scg.nodes, index)
    }
    return index.get(t) ?? []
}

/** Keeps the thread index up to date when copies are added to scg.nodes. */
function addToThreadIndex(scg: SCG, nodes: SNode[]) {
    const index = threadIndexCache.get(scg.nodes)
    if (!index) return
    for (const n of nodes) {
        for (let y: Thread | undefined = n.thread; y; y = y.parent) {
            if (n === y.exit) continue
            let l = index.get(y)
            if (!l) index.set(y, (l = []))
            l.push(n)
        }
    }
}

/** Nodes reachable from the thread's entry without passing a join, surface or exit (StructuralDepthJoin.isInSurface). */
function surfaceNodes(t: Thread): SNode[] {
    const seen = new Set<SNode>()
    const stack: SNode[] = [t.entry]
    while (stack.length) {
        const h = stack.pop()!
        if (seen.has(h)) continue
        seen.add(h)
        for (const n of successors(h)) {
            if (n.kind === 'join' || n.kind === 'surface' || n.kind === 'exit') continue
            if (!seen.has(n)) stack.push(n)
        }
    }
    return [...seen]
}

/** Are two threads (or nodes in them) in different threads of one fork, below their innermost common thread? */
export function concurrent(a: Thread, b: Thread): boolean {
    const chain = (t: Thread) => {
        const out: Thread[] = []
        for (let x: Thread | undefined = t; x; x = x.parent) out.unshift(x)
        return out
    }
    const ca = chain(a)
    const cb = chain(b)
    let i = 0
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++
    // One contains the other (or the same thread): they follow one another.
    if (i === ca.length || i === cb.length) return false
    // Different child threads of the common thread: concurrent if started by the same fork.
    return ca[i].fork === cb[i].fork
}

export interface AnalysisInput {
    scg: SCG
    deps: Dependency[]
    /**
     * Which of several cureable forks to cure. KIELER iterates over a hash map of forks whose order is fixed within a
     * run but changes from run to run, and cures the first cureable fork (innermost first) in that order. A choice is
     * a curing step where more than one fork can be first in some order consistent with the earlier steps (the fork
     * cured at a step comes before every other candidate of that step). At the k-th choice the analysis cures the
     * `script[k]`-th of those forks in node order (default 0: the first).
     */
    script?: number[]
}

export function analyse({ scg, deps, script = [] }: AnalysisInput): Analysis {
    let pathTypes = threadPathTypes(scg)
    const forkThreads = new Map<SNode, Thread[]>()
    for (const n of scg.nodes) if (n.kind === 'fork') forkThreads.set(n, n.threads!)

    // Concurrent, non-confluent dependencies as adjacency (mutable: curing adds copies and removes some).
    let active = deps.filter(d => !d.confluent)
    const depOut = () => {
        const m = new Map<SNode, SNode[]>()
        for (const d of active) {
            let l = m.get(d.from)
            if (!l) m.set(d.from, (l = []))
            l.push(d.to)
        }
        return m
    }

    const loopNeighbours = (out: Map<SNode, SNode[]>) => (n: SNode): SNode[] => {
        const s = successors(n)
        const d = out.get(n)
        return d ? [...s, ...d] : s
    }
    const loops = stronglyConnected(scg.nodes, loopNeighbours(depOut())).filter(c => c.length > 1)
    const cured: SNode[] = []
    const lostTerminations: Analysis['lostTerminations'] = []
    let failure: string | undefined
    let choice: SNode[] | undefined
    let ambiguous = false
    const decisions: number[] = []
    const position = new Map(scg.nodes.map((n, i) => [n, i]))
    const curedAt: number[] = []
    // What the run's order is known to be: `after.get(x)` are forks known to come after x.
    const after = new Map<SNode, Set<SNode>>()
    const comesBefore = (a: SNode, b: SNode): boolean => {
        const seen = new Set<SNode>()
        const stack = [a]
        while (stack.length) {
            const x = stack.pop()!
            for (const y of after.get(x) ?? []) {
                if (y === b) return true
                if (!seen.has(y)) { seen.add(y); stack.push(y) }
            }
        }
        return false
    }

    // Structural depth join: cure schizophrenic forks, innermost first, until none is left. KIELER re-runs its loop
    // analysis after each cure, but StructuralDepthJoinProcessor keeps the loop data it fetched at the start (the
    // analysis stores a new object in the environment), so the critical nodes are always the first analysis's.
    const critical = new Set(loops.flat())
    for (let iteration = 0; iteration <= forkThreads.size; iteration++) {
        const cureable: SNode[] = []
        const preds = predecessorsOf(scg)
        for (const [fork, threads] of forkThreads) {
            if (!critical.has(fork) || !critical.has(fork.join!)) continue
            if (threads.some(t => pathTypes.get(t) === 'potentially') && hasConcurrentDelay(fork, pathTypes, preds)) cureable.push(fork)
        }
        let curedOne = false
        // A fork that contains another cureable fork waits (innermost first).
        const insideOf = (inner: SNode, outer: SNode) => {
            for (let t: Thread | undefined = inner.thread; t; t = t.parent) if (t.fork === outer) return true
            return false
        }
        const candidates = cureable.filter(fork => !cureable.some(other => other !== fork && insideOf(other, fork)))
        let order = candidates
        if (candidates.length > 1) {
            // The forks that can be first in the run's order (no other candidate is known to come before them).
            const options = candidates.filter(c => !candidates.some(d => d !== c && comesBefore(d, c)))
            if (options.length > 1) ambiguous = true
            // Forks in concurrent regions are cured independently (each cure copies its own region's nodes), so only
            // forks that follow another option make a difference: those are the choices worth trying.
            const worth = options.filter((o, i) => i === 0 || options.some(p => p !== o && !concurrent(p.thread, o.thread)))
            let first = options[0]
            if (worth.length > 1) {
                const k = decisions.length
                decisions.push(worth.length)
                choice ??= worth
                first = worth[Math.min(script[k] ?? 0, worth.length - 1)]
            }
            let set = after.get(first)
            if (!set) after.set(first, (set = new Set()))
            for (const c of candidates) if (c !== first) set.add(c)
            order = [first, ...candidates.filter(f => f !== first)]
        }
        for (const fork of order) {
            if (cured.includes(fork)) {
                failure = 'Structural Depth Join: A cured fork still seems to be shizophrenic. This should not happen. Aborting compilation.'
                break
            }
            active = cure(scg, fork, forkThreads.get(fork)!, critical, pathTypes, active, preds, lostTerminations)
            cured.push(fork)
            curedAt.push(position.get(fork) ?? -1)
            curedOne = true
            break
        }
        if (failure || !curedOne) break
    }

    // Synchronizers (SynchronizerSelector, Surface/Depth/InstantaneousSynchronizer) and the final graph.
    const { blocks: blockList, alive } = basicBlocks(scg)
    const joins = new Map<SNode, JoinInfo>()
    for (const [fork, threads] of forkThreads) {
        const join = fork.join!
        const types = threads.map(t => pathTypes.get(t) ?? 'disconnected')
        const reachable = (t: Thread) => alive.has(t.exit)
        let sync: SyncKind
        if (join.any) sync = 'any'
        else if (types.every(t => t === 'instantaneous')) sync = 'instantaneous'
        else if (types.every((t, i) => t === 'delayed' || t === 'instantaneous' || (t === 'potentially' && threads[i].final)) && types.includes('delayed')) sync = 'depth'
        else sync = 'surface'
        const delayFound = types.some(t => t !== 'instantaneous')
        // A par-or join (ParOrSynchronizer) waits for any live exit, final threads included.
        const counted = sync === 'any' ? threads.filter(reachable) : threads.filter((t, i) => !t.final && reachable(t) && (!delayFound || types[i] !== 'instantaneous'))
        joins.set(join, { join, sync, counted, first: sync === 'instantaneous' ? threads[0] : undefined, dead: !alive.has(join) })
    }

    // Dependency graph for scheduling: control flow within the tick (but a join depends on its synchronizer's
    // inputs instead of its incoming control flow), plus the remaining concurrent dependencies.
    const preds = new Map<SNode, SNode[]>()
    const addEdge = (from: SNode, to: SNode) => {
        let l = preds.get(to)
        if (!l) preds.set(to, (l = []))
        l.push(from)
    }
    const outEdges = new Map<SNode, SNode[]>()
    const add = (from: SNode, to: SNode) => {
        addEdge(from, to)
        let l = outEdges.get(from)
        if (!l) outEdges.set(from, (l = []))
        l.push(to)
    }
    const reached = alive
    for (const n of scg.nodes) {
        if (!reached.has(n)) continue
        for (const m of successors(n)) {
            if (m.kind === 'join') continue
            add(n, m)
        }
    }
    // What guard expressions reference besides their predecessors (for kielerSchedule): a join's synchronizer inputs,
    // the exits that preempt an abort region's entry or depth.
    const guardRefs = new Map<SNode, SNode[]>()
    const ref = (from: SNode, to: SNode) => {
        add(from, to)
        let l = guardRefs.get(to)
        if (!l) guardRefs.set(to, (l = []))
        l.push(from)
    }
    for (const info of joins.values()) {
        if (!reached.has(info.join)) continue
        if (info.sync === 'instantaneous') {
            if (info.first) ref(info.first.exit, info.join)
            continue
        }
        if (info.sync === 'any') {
            for (const t of info.counted) ref(t.exit, info.join)
            continue
        }
        for (const t of info.counted) ref(t.exit, info.join)
        if (info.sync === 'surface') {
            for (const t of info.counted) for (const n of threadNodes(scg, t)) if (n.kind === 'surface' && reached.has(n)) ref(n, info.join)
        }
    }
    for (const d of active) if (reached.has(d.from) && reached.has(d.to)) add(d.from, d.to)
    // Abort regions: the sequential order of a preemptive fork's threads and their preemption guards.
    const preemption = new Map<SNode, SNode[]>()
    const sequentialEdges: [SNode, SNode][] = []
    for (const fork of scg.nodes) {
        if (fork.kind !== 'fork' || !fork.preemptive || !reached.has(fork)) continue
        // A state re-entered in the tick it finishes gets KIELER's surface/depth separation and reincarnation guards
        // instead (not simulated: abortRegions.ts reports it as unsupported).
        if (!fork.reincarnation) sequentialOrder(scg, fork, reached, (from, to) => { add(from, to); sequentialEdges.push([from, to]) })
        const threads = fork.threads!
        threads.forEach((t, i) => {
            // A later thread does not start when an earlier one finished in this tick (its entry guard).
            const before = threads.slice(0, i).map(x => x.exit).filter(e => reached.has(e))
            if (i > 0 && before.length && reached.has(t.entry)) {
                for (const e of before) ref(e, t.entry)
                preemption.set(t.entry, [...(preemption.get(t.entry) ?? []), ...before])
            }
            // Its depths do not resume when one of the threads 0 .. i-2 finished in this tick (KIELER's take(i - 1)).
            const earlier = threads.slice(0, Math.max(0, i - 1)).map(x => x.exit).filter(e => reached.has(e))
            if (!earlier.length) return
            for (const n of threadNodes(scg, t)) {
                if (n.kind !== 'depth' || !reached.has(n)) continue
                for (const e of earlier) ref(e, n)
                preemption.set(n, [...(preemption.get(n) ?? []), ...earlier])
            }
        })
    }

    const nodes = scg.nodes.filter(n => reached.has(n))
    const sccs = stronglyConnected(nodes, n => outEdges.get(n) ?? [])
    const cycles = sccs.filter(c => c.length > 1 || (outEdges.get(c[0]) ?? []).includes(c[0]))

    let order: SNode[] = []
    let blockCycle = false
    if (!cycles.length) {
        const scheduled = kielerSchedule(scg, blockList, active.filter(d => reached.has(d.from) && reached.has(d.to)), guardRefs, sequentialEdges)
        blockCycle = !scheduled
        order = scheduled ?? topologicalOrder(nodes, preds)
    }

    // Only copies that stayed (reachable from the thread's start) lose a termination.
    const present = new Set(scg.nodes)
    const lost = lostTerminations.filter(l => present.has(l.node) && alive.has(l.node))
    return { pathTypes, loops, cured, joins, cycles, order, failure, deps: active, lostTerminations: lost, ambiguous, choice, decisions, curedAt, preemption, blockCycle }
}

/**
 * The nodes that are not dead in KIELER's basic block analysis (BasicBlockTransformation), with its quirks:
 *
 * - Basic blocks are made by a depth-first walk from the root entry (a conditional's then before its else, a
 *   fork's threads in order, then its join; a node with several incoming control flows starts a block), then from
 *   every node not yet in a block, in KIELER's node order. A copy of a fork made by the schizophrenia cure has no
 *   join (EMF does not copy the two-way fork/join link), so the walk does not continue after it.
 * - Liveness is one pass over the blocks in that order, not a fixpoint: a block is alive if some predecessor
 *   block before it is alive (blocks start dead), a join if no thread's exit block is dead (final threads
 *   excepted), a depth if its surface's block is alive, and the root entry's block is.
 *
 * So a block whose only live predecessors come later in the order stays dead (concurrency.md K-1: a join
 * reached only through a cured fork's copy). Dead nodes never run (their guard is false) and take no part in
 * scheduling.
 */
export function liveNodes(scg: SCG): Set<SNode> {
    return basicBlocks(scg).alive
}

/** A basic block of KIELER's BasicBlockTransformation (liveNodes). */
export interface BasicBlock { nodes: SNode[]; preds: BasicBlock[]; dead: boolean; go: boolean; sync: boolean; depthOf?: BasicBlock; final: boolean }

/** KIELER's basic blocks in creation order, and the nodes that are not dead (see liveNodes). */
export function basicBlocks(scg: SCG): { blocks: BasicBlock[]; alive: Set<SNode> } {
    type Block = BasicBlock
    const preds = predecessors(scg)
    const extra = sameElseTargets(scg)
    const incoming = (n: SNode) => {
        let count = extra.get(n) ?? 0
        for (const p of preds.get(n) ?? []) count += p.kind === 'cond' && p.sameElse && !p.sameTarget && p.then === n ? 2 : 1
        return count
    }
    const blockOf = new Map<SNode, Block>()
    const blocks: Block[] = []
    const insert = (nodes: SNode[], from: Block[]): Block => {
        const head = nodes[0]
        const last = nodes[nodes.length - 1]
        const b: Block = {
            nodes, preds: [...from], dead: true, go: from.length === 0 && head.kind === 'entry', sync: head.kind === 'join',
            final: last.kind === 'exit' && last === last.thread.exit && last.thread.final,
        }
        if (head.kind === 'depth') {
            b.depthOf = from[0]
            b.preds = []
            if (head.thread.final) b.final = true
        }
        blocks.push(b)
        for (const n of nodes) blockOf.set(n, b)
        return b
    }
    const create = (root: SNode | undefined, from: Block[]) => {
        if (!root) return
        const known = blockOf.get(root)
        if (known) {
            known.preds.push(...from)
            return
        }
        const nodes: SNode[] = []
        let node: SNode | undefined = root
        while (node) {
            nodes.push(node)
            if (node.kind === 'cond') {
                const b = insert(nodes, from)
                if (node.then) create(node.then, [b])
                if (node.else) create(node.else, [b])
                else if (node.sameElse) create(node.sameTarget ?? node.then, [b])
                return
            }
            if (node.kind === 'surface') {
                const b = insert(nodes, from)
                create(node.depth, [b])
                return
            }
            if (node.kind === 'fork') {
                const b = insert(nodes, from)
                for (const t of node.threads!) {
                    create(t.entry, [b])
                    create(t.exit, [])
                }
                if (!node.copyOf) create(node.join, node.threads!.map(t => blockOf.get(t.exit)!).filter(Boolean))
                return
            }
            let next: SNode | undefined = node.next
            if (next && blockOf.has(next) && incoming(next) < 2) next = undefined
            if (!next || next.kind === 'join') {
                insert(nodes, from)
                return
            }
            if (incoming(next) > 1) {
                const b = insert(nodes, from)
                create(next, [b])
                return
            }
            node = next
        }
    }
    // The walk recurses as deep as the graph; KIELER's does too. Node order: originals as KIELER creates them,
    // then the cure's copies in the order they were made.
    const rank = new Map(scg.nodes.map((n, i) => [n, n.copyOf ? scg.nodes.length + i : n.gen ?? i]))
    const order = [...scg.nodes].sort((a, b) => rank.get(a)! - rank.get(b)!)
    create(scg.root.entry, [])
    for (const n of order) if (!blockOf.has(n)) create(n, [])
    for (const b of blocks) {
        if (b.go) b.dead = false
        else if (b.sync && !b.nodes[0].any) b.dead = b.preds.some(p => p.dead && !p.final)
        else if (b.depthOf) b.dead = b.depthOf.dead
        else b.dead = !b.preds.some(p => !p.dead)
    }
    const alive = new Set<SNode>()
    for (const b of blocks) if (!b.dead) for (const n of b.nodes) alive.add(n)
    return { blocks, alive }
}

/**
 * The schedule as KIELER's netlist makes it (SimpleGuardTransformation, SimpleGuardScheduler, SimpleGuardSequentializer):
 * the live basic blocks are cut into scheduling blocks (a node with an incoming concurrent dependency starts a new
 * one), each scheduling block is one guard, and the guards are sorted topologically by a depth-first search that
 * takes them in creation order and pulls in their dependencies in the order KIELER created them: control dependencies
 * between the scheduling blocks of a basic block, then the data dependencies (by source node), then the references
 * of the guard expression (the predecessors' last scheduling blocks; a join's thread exits and surfaces; an abort
 * region's preempting exits), then the order of sequential forks. A scheduling block's nodes run together, right
 * after its guard. Data does not depend on this order (it respects every dependency); what does are random() and
 * print, whose calls run in this order. Returns undefined if the blocks depend on each other in a cycle.
 */
function kielerSchedule(scg: SCG, blocks: BasicBlock[], deps: Dependency[], extraPreds: Map<SNode, SNode[]>, sequential: [SNode, SNode][]): SNode[] | undefined {
    interface SB { nodes: SNode[]; block: BasicBlock; index: number; deps: SB[]; next?: SB }
    const rank = new Map(scg.nodes.map((n, i) => [n, n.copyOf ? scg.nodes.length + i : n.gen ?? i]))
    const incomingDeps = new Map<SNode, Dependency[]>()
    for (const d of deps) {
        let l = incomingDeps.get(d.to)
        if (!l) incomingDeps.set(d.to, (l = []))
        l.push(d)
    }
    const sbs: SB[] = []
    const sbOf = new Map<SNode, SB>()
    const sbsOf = new Map<BasicBlock, SB[]>()
    for (const b of blocks) {
        if (b.dead) continue
        const list: SB[] = []
        for (const n of b.nodes) {
            const last = list[list.length - 1]
            if (!last || incomingDeps.get(n)?.length) {
                const sb: SB = { nodes: [n], block: b, index: list.length, deps: [] }
                if (last) last.next = sb
                list.push(sb)
                sbs.push(sb)
            } else {
                last.nodes.push(n)
            }
            sbOf.set(n, list[list.length - 1])
        }
        sbsOf.set(b, list)
    }
    const addDep = (to: SB, from: SB | undefined) => { if (from && from !== to) to.deps.push(from) }
    for (const sb of sbs) {
        const list = sbsOf.get(sb.block)!
        // Control dependencies within the basic block (from the third scheduling block on).
        if (sb.index >= 2) addDep(sb, list[sb.index - 1])
    }
    // Data dependencies, by source node.
    for (const d of [...deps].sort((a, b) => (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0))) addDep(sbOf.get(d.to)!, sbOf.get(d.from))
    // The guard expressions' references.
    for (const sb of sbs) {
        const b = sb.block
        if (sb.index > 0) {
            addDep(sb, sbsOf.get(b)![0])
            continue
        }
        const head = sb.nodes[0]
        if (b.sync || head.kind === 'entry' || head.kind === 'depth') {
            for (const p of extraPreds.get(head) ?? []) addDep(sb, sbOf.get(p))
        }
        if (b.go || b.depthOf || b.sync) continue
        for (const p of b.preds) {
            if (p.dead) continue
            const pl = sbsOf.get(p)
            addDep(sb, pl?.[pl.length - 1])
        }
    }
    for (const [from, to] of sequential) addDep(sbOf.get(to)!, sbOf.get(from))

    const state = new Map<SB, 1 | 2>()
    const order: SB[] = []
    let failed = false
    const visit = (sb: SB) => {
        state.set(sb, 1)
        for (const d of sb.deps) if (!state.has(d)) visit(d)
        if (sb.deps.some(d => state.get(d) !== 2)) {
            failed = true
            return
        }
        state.set(sb, 2)
        order.push(sb)
        // The next scheduling block of the basic block right away, when it only waits for this one.
        const next = sb.next
        if (next && next.index >= 2 && !state.has(next) && next.deps.every(d => state.get(d) === 2)) visit(next)
    }
    for (const sb of sbs) {
        if (!state.has(sb)) visit(sb)
        if (failed) return undefined
    }
    return order.flatMap(sb => sb.nodes)
}

/** The extra incoming flow KIELER's graph has for the shared target of an equal-branch conditional behind marks. */
export function sameElseTargets(scg: SCG): Map<SNode, number> {
    const out = new Map<SNode, number>()
    for (const n of scg.nodes) if (n.kind === 'cond' && n.sameElse && n.sameTarget) out.set(n.sameTarget, (out.get(n.sameTarget) ?? 0) + 1)
    return out
}

/** All nodes reachable from the root entry (control flow, surface -> depth). */
export function reachableNodes(scg: SCG): Set<SNode> {
    const seen = new Set<SNode>()
    const stack = [scg.root.entry]
    while (stack.length) {
        const n = stack.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        if (n.kind === 'surface') stack.push(n.depth!)
        else for (const m of successors(n)) stack.push(m)
    }
    return seen
}

/**
 * StructuralDepthJoinProcessor.hasConcurrentDelay: a depth-first search up the incoming control flows to the first
 * fork. KIELER's search list starts with the incoming flows in order (the first is looked at first), and pushes
 * each node's predecessors in front (the last is looked at first).
 */
function hasConcurrentDelay(node: SNode, types: Map<Thread, PathType>, preds: Map<SNode, SNode[]>, visited = new Set<SNode>()): boolean {
    if (node.kind === 'fork' && node.threads!.some(t => types.get(t) === 'delayed')) return true
    visited.add(node)
    const stack = [...(preds.get(node) ?? [])].filter(x => !visited.has(x)).reverse()
    while (stack.length) {
        const head = stack.pop()!
        visited.add(head)
        if (head.kind === 'fork') return hasConcurrentDelay(head, types, preds, visited)
        for (const p of preds.get(head) ?? []) if (!visited.has(p)) stack.push(p)
    }
    return false
}

/** Control-flow predecessors in the order of KIELER's incoming ControlFlow links (a depth has none from its surface). */
function predecessorsOf(scg: SCG): Map<SNode, SNode[]> {
    return predecessors(scg)
}

/** StructuralDepthJoinProcessor.transformSDJ and the dependency clean-up after it. Returns the new dependency list. */
function cure(scg: SCG, fork: SNode, threads: Thread[], critical: Set<SNode>, types: Map<Thread, PathType>, deps: Dependency[], before: Map<SNode, SNode[]>, lost: Analysis['lostTerminations']): Dependency[] {
    const schizo: SNode[] = []
    const mapping = new Map<SNode, SNode>()
    let out = [...deps]
    for (const t of threads) {
        if (types.get(t) !== 'potentially') continue
        const nodes = threadNodes(scg, t).filter(n => critical.has(n) && n.kind !== 'exit' && n.kind !== 'entry')
        const local = new Map<SNode, SNode>()
        for (const p of nodes) {
            // copyNode: the copy's control flows still lead to the originals' targets (appended to their incoming
            // flows, in copy order).
            const seq = { ...p.seq, threads: p.seq?.threads ? p.threads!.map(() => scg.seq++) : undefined }
            if (p.kind === 'cond') {
                if (p.then) seq.then = scg.seq++
                if (p.else) seq.else = scg.seq++
            } else if (p.kind !== 'fork' && p.kind !== 'surface' && p.next) {
                seq.next = scg.seq++
            }
            const copy: SNode = { ...p, id: scg.nodes.length, copyOf: p, seq }
            scg.nodes.push(copy)
            local.set(p, copy)
            mapping.set(p, copy)
            schizo.push(copy)
            p.schizo = copy
        }
        addToThreadIndex(scg, [...local.values()])
        // Control flow among copies goes to copies (appended to the copies' incoming flows); flows into exits are
        // dropped.
        for (const copy of local.values()) {
            const seq = copy.seq!
            const redirect = (n: SNode | undefined, slot: 'next' | 'then' | 'else'): SNode | undefined => {
                if (!n) return n
                const c = local.get(n)
                if (c) seq[slot] = scg.seq++
                const to = c ?? n
                if (to.kind === 'exit') {
                    if (copy.transition?.origin) lost.push({ thread: t, node: copy })
                    return undefined
                }
                return to
            }
            if (copy.kind === 'cond') {
                copy.then = redirect(copy.then, 'then')
                copy.else = redirect(copy.else, 'else')
            } else if (copy.kind === 'fork') {
                // The copy forks into the original threads (entries are not copied).
            } else if (copy.kind === 'surface') {
                // A surface copy keeps its depth.
            } else {
                copy.next = redirect(copy.next, 'next')
            }
        }
        const first = t.entry.next ? local.get(t.entry.next) : undefined
        if (first) {
            t.entry.next = first
            ;(t.entry.seq ??= {}).next = scg.seq++
        }
        types.set(t, 'delayed')
        // Dependencies: copies get the original's outgoing and incoming data dependencies (copyNode(true)).
        const added: Dependency[] = []
        for (const d of out) {
            const from = local.get(d.from)
            const to = local.get(d.to)
            if (from) added.push({ ...d, from })
            if (to) added.push({ ...d, to })
        }
        out.push(...added)
    }
    propagateDelay(fork, types, before)
    // Concurrent dependencies between copies and nodes outside the threads' surfaces are removed.
    const threadSet = new Set(threads.flatMap(t => threadNodes(scg, t)))
    const surfaceSet = new Set(threads.flatMap(t => surfaceNodes(t)))
    const inSurface = (n: SNode): boolean => !threadSet.has(n) || surfaceSet.has(n)
    const isSchizo = new Set(schizo)
    out = out.filter(d => {
        if (isSchizo.has(d.from) && !inSurface(d.to)) return false
        if (isSchizo.has(d.to) && !inSurface(d.from)) return false
        return true
    })
    // Copies that nothing but other copies reach are removed.
    const preds = predecessorsOf(scg)
    const unreachable = new Set<SNode>()
    for (const s of schizo) {
        const visited = new Set<SNode>([s])
        const incoming = [...(preds.get(s) ?? [])]
        let reachable = false
        while (incoming.length) {
            const n = incoming.pop()!
            if (visited.has(n)) continue
            visited.add(n)
            if (!isSchizo.has(n)) {
                reachable = true
                break
            }
            incoming.push(...(preds.get(n) ?? []))
        }
        if (!reachable) unreachable.add(s)
    }
    if (unreachable.size) {
        const index = threadIndexCache.get(scg.nodes)
        scg.nodes = scg.nodes.filter(n => !unreachable.has(n))
        scg.nodes.forEach((n, i) => { n.id = i })
        if (index) {
            for (const [t, list] of index) index.set(t, list.filter(n => !unreachable.has(n)))
            threadIndexCache.set(scg.nodes, index)
        }
        out = out.filter(d => !unreachable.has(d.from) && !unreachable.has(d.to))
    }
    return out
}

/** StructuralDepthJoinProcessor.propagateDelay: the threads around a cured fork become delayed too. */
function propagateDelay(fork: SNode, types: Map<Thread, PathType>, preds: Map<SNode, SNode[]>) {
    const visited = new Set<SNode>()
    const stack: SNode[] = [fork]
    while (stack.length) {
        const head = stack.pop()!
        if (head.kind === 'entry') {
            types.set(head.thread, 'delayed')
            const parentFork = head.thread.fork
            if (parentFork) propagateDelay(parentFork, types, preds)
            return
        }
        visited.add(head)
        const next = head.kind === 'join' ? [head.fork!] : (preds.get(head) ?? []).filter(x => !visited.has(x))
        stack.push(...next)
    }
}

/**
 * SimpleGuardTransformation's control dependencies for a sequential fork: for each thread and the next, the last
 * duty nodes (conditionals and assignments) of the thread's surface come before the next thread's entry, and the
 * last duty nodes of its depth before the first duty nodes after every depth of the next thread.
 */
function sequentialOrder(scg: SCG, fork: SNode, reached: Set<SNode>, add: (from: SNode, to: SNode) => void) {
    const preds = predecessorsOf(scg)
    const duty = (n: SNode) => n.kind === 'cond' || n.kind === 'assign'
    const preceding = (start: SNode, limit: SNode): SNode[] => {
        if (duty(start)) return [start]
        const out: SNode[] = []
        const visited = new Set<SNode>([start])
        const next = (preds.get(start) ?? []).filter(x => x !== limit)
        const queued = new Set(next)
        while (next.length) {
            const node = next.shift()!
            queued.delete(node)
            visited.add(node)
            if (duty(node)) { out.push(node); continue }
            for (const p of preds.get(node) ?? []) if (!visited.has(p) && !queued.has(p)) { next.push(p); queued.add(p) }
        }
        return out
    }
    const succeeding = (start: SNode, limit: SNode): SNode[] => {
        if (duty(start)) return [start]
        const out: SNode[] = []
        const visited = new Set<SNode>([start])
        const next = successors(start).filter(x => x !== limit)
        const queued = new Set(next)
        while (next.length) {
            const node = next.shift()!
            queued.delete(node)
            visited.add(node)
            if (duty(node)) { out.push(node); continue }
            for (const m of successors(node)) if (!visited.has(m) && !queued.has(m)) { next.push(m); queued.add(m) }
        }
        return out
    }
    const threads = fork.threads!
    const sd = threads.map(surfaceDepth)
    for (let i = 0; i < threads.length - 1; i++) {
        const t = threads[i]
        const { surface, depth } = sd[i]
        const next = threads[i + 1]
        const lastSurface = [...surface].filter(n => n.kind === 'surface' || n === t.exit)
        for (const last of new Set(lastSurface.flatMap(n => preceding(n, t.entry)).filter(n => surface.has(n)))) {
            if (reached.has(last) && reached.has(next.entry)) add(last, next.entry)
        }
        const lastDepth = [...depth].filter(n => n.kind === 'surface' || n === t.exit)
        const lastDepthDuty = new Set(lastDepth.flatMap(n => preceding(n, t.entry)).filter(n => depth.has(n)))
        if (!lastDepthDuty.size) continue
        const firsts = new Set(threadNodes(scg, next).filter(n => n.kind === 'depth').flatMap(d => succeeding(d, next.exit)))
        for (const last of lastDepthDuty) for (const first of firsts) if (reached.has(last) && reached.has(first)) add(last, first)
    }
}

/** SCGThreadExtensions.calculateSurfaceDepth: the nodes of a thread reached from its entry, and from its depths. */
function surfaceDepth(t: Thread): { surface: Set<SNode>; depth: Set<SNode> } {
    const surface = new Set<SNode>()
    const depth = new Set<SNode>()
    const end = t.exit
    const starts: SNode[] = [t.entry]
    const started = new Set<SNode>([t.entry])
    while (starts.length) {
        const start = starts.shift()!
        const inSurface = start.kind === 'entry'
        const into = inSurface ? surface : depth
        into.add(start)
        const visited = new Set<SNode>([start])
        const next = [...successors(start)]
        const queued = new Set(next)
        while (next.length) {
            const node = next.shift()!
            queued.delete(node)
            visited.add(node)
            into.add(node)
            if (node.kind === 'surface') {
                const d = node.depth!
                if (!started.has(d)) { started.add(d); starts.push(d) }
                continue
            }
            for (const m of successors(node)) {
                if (m === end) into.add(m)
                else if (!visited.has(m) && !into.has(m) && !queued.has(m)) { next.push(m); queued.add(m) }
            }
        }
    }
    return { surface, depth }
}

/** Topological order by depth-first search, pulling dependencies first (KIELER's topologicalScheduling). */
function topologicalOrder(nodes: SNode[], preds: Map<SNode, SNode[]>): SNode[] {
    const order: SNode[] = []
    const state = new Map<SNode, 1 | 2>()
    for (const start of nodes) {
        if (state.has(start)) continue
        const stack: { n: SNode; i: number }[] = [{ n: start, i: 0 }]
        state.set(start, 1)
        while (stack.length) {
            const top = stack[stack.length - 1]
            const p = preds.get(top.n) ?? []
            if (top.i < p.length) {
                const m = p[top.i++]
                if (!state.has(m)) {
                    state.set(m, 1)
                    stack.push({ n: m, i: 0 })
                }
            } else {
                stack.pop()
                state.set(top.n, 2)
                order.push(top.n)
            }
        }
    }
    return order
}

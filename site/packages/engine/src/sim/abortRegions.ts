// Abort regions in the SCG (preemption.md P-62): KIELER's SCGAbortRegionProcessor
// (sccharts/processors/scg/SCGAbortRegionProcessor.xtend), run right after the SCG is built, before the superfluous
// thread and fork removers. The SCCharts-level Abort Region processor does nothing in the netlist chain. What KIELER
// rejects (abort regions in the middle, abort regions alone) is reported here, for the forks the SCG has (states that
// cannot be reached have none, passes/abortRegion.ts).
//
// A state's threads are sorted into leading abort regions ("strong"), the other regions ("content") and trailing
// abort regions ("weak"). With one content thread the state's fork becomes a sequential preemptive fork and its join
// a par-or (`any`) join; with several, the content threads stay in the state's fork, which moves into a thread of
// its own inside a new preemptive fork whose threads are the leading abort regions, that content thread and the
// trailing abort regions (KIELER's nesting, with its node and control-flow order). What the netlist makes of that:
//
// - the threads of a preemptive fork run one after the other, in order (SimpleGuardTransformation's sequential
//   order; their accesses are not concurrent, DependencyTransformationV2.isConcurrentTo);
// - a later thread does not start if an earlier one finished in the tick it was entered (its entry guard);
// - in later ticks, the depth of thread i is suppressed when one of the threads 0 .. i-2 finished in this tick
//   (KIELER's `entries.take(indexOf(own) - 1)`: the thread just before it is left out, so with a single abort region
//   in front the other regions still react in the tick it finishes: P-62's "weak effect");
// - the par-or join fires as soon as any thread finishes, and in the next tick no depth inside its threads resumes
//   (`!pre(join)`).
//
// A state with abort regions that can be left and entered again in the same tick (its join leads back to its fork
// without a pause: thread reincarnation) gets KIELER's extra guards (SimpleGuardExpressions):
//
// - a later thread starts again when an earlier one finished and was entered again in this tick (`entry && exit` of
//   the earlier thread); KIELER rejects this unless every earlier thread is delayed (analysis.ts);
// - a pause reached after the join fired survives it when its "revival" guard held (revivals below).

import type { Diagnostic } from '../types'
import type { SCG, SNode, Thread } from './scg'
import { successors } from './scg'
import { abortRegionErrors } from './passes/abortRegion'

/** Applies SCGAbortRegionProcessor to the graph; returns its errors. */
export function abortRegionsSCG(scg: SCG, nameOf: (id: string) => string | undefined = () => undefined): Diagnostic[] {
    const out: Diagnostic[] = []
    const forks = scg.nodes.filter(n => n.kind === 'fork' && n.threads!.some(t => t.region?.abort))
    const done: SNode[] = []
    for (const fork of forks) {
        const strong: Thread[] = []
        const content: Thread[] = []
        const weak: Thread[] = []
        let type = 0
        let illegal = false
        for (const t of fork.threads!) {
            if (t.region?.abort) {
                if (type === 0) strong.push(t)
                else { weak.push(t); type = 2 }
            } else if (type === 2) {
                illegal = true
            } else {
                content.push(t)
                type = 1
            }
        }
        if (illegal || !content.length) {
            const id = fork.state?.origin ?? fork.state?.about
            const error = abortRegionErrors(fork.threads!.map(t => t.region), id, (id && nameOf(id)) ?? fork.state?.name ?? 'This state')
            if (error) out.push(error)
            continue
        }
        if (content.length === 1) {
            fork.preemptive = true
            fork.join!.any = true
            done.push(fork)
        } else {
            done.push(nest(scg, fork, strong, content, weak))
        }
    }
    for (const fork of done) if (feedback(fork)) fork.reincarnation = true
    return out
}

/** SCGAbortRegionProcessor's nesting of several content threads into a thread of a new preemptive fork. */
function nest(scg: SCG, fork: SNode, strong: Thread[], content: Thread[], weak: Thread[]): SNode {
    const join = fork.join!
    const parent = fork.thread
    const gen = fork.gen ?? fork.id
    const joinGen = join.gen ?? join.id
    const abortFork: SNode = { id: scg.nodes.length, kind: 'fork', thread: parent, state: fork.state, preemptive: true, gen: gen - 0.4 }
    const abortJoin: SNode = { id: scg.nodes.length + 1, kind: 'join', thread: parent, state: fork.state, any: true, gen: joinGen + 0.4 }
    abortFork.join = abortJoin
    abortJoin.fork = abortFork
    const thread = {
        id: scg.threads.length, fork: abortFork, parent, depth: parent.depth + 1, final: false,
        rank: Math.min(...fork.threads!.map(t => t.rank)) - 0.5,
    } as Thread
    const entry: SNode = { id: scg.nodes.length + 2, kind: 'entry', thread, gen: gen - 0.3 }
    const exit: SNode = { id: scg.nodes.length + 3, kind: 'exit', thread, gen: joinGen + 0.3 }
    thread.entry = entry
    thread.exit = exit
    scg.nodes.push(abortFork, abortJoin, entry, exit)
    scg.threads.push(thread)

    const forkSeq = new Map(fork.threads!.map((t, i) => [t, fork.seq?.threads?.[i] ?? scg.seq++]))
    const threadSeq: number[] = []
    // Leading abort regions: their entry flows move to the new fork (same flows), their exits flow into the new join.
    for (const t of strong) {
        threadSeq.push(forkSeq.get(t)!)
        t.fork = abortFork
        retargetExit(scg, t, abortJoin)
    }
    // The flows into the fork now lead into the new fork.
    for (const n of scg.nodes) {
        if (n === abortFork) continue
        if (n.kind === 'cond') {
            if (n.then === fork) { n.then = abortFork; (n.seq ??= {}).then = scg.seq++ }
            if (n.else === fork) { n.else = abortFork; (n.seq ??= {}).else = scg.seq++ }
        } else if (n.kind !== 'fork' && n.kind !== 'surface' && n.next === fork) {
            n.next = abortFork
            ;(n.seq ??= {}).next = scg.seq++
        }
    }
    threadSeq.push(scg.seq++)
    entry.next = fork
    entry.seq = { next: scg.seq++ }
    // The new join continues where the state's join did (the same flow), the old join ends the content thread.
    abortJoin.next = join.next
    abortJoin.seq = { next: join.seq?.next }
    join.next = exit
    ;(join.seq ??= {}).next = scg.seq++
    exit.next = abortJoin
    exit.seq = { next: scg.seq++ }
    for (const t of weak) {
        threadSeq.push(forkSeq.get(t)!)
        t.fork = abortFork
        retargetExit(scg, t, abortJoin)
    }
    abortFork.threads = [...strong, thread, ...weak]
    abortFork.seq = { threads: threadSeq }
    fork.threads = content
    fork.seq = { ...(fork.seq ?? {}), threads: content.map(t => forkSeq.get(t)!) }
    fork.thread = thread
    join.thread = thread
    for (const t of content) t.parent = thread
    const depthOf = (t: Thread): number => (t.parent ? depthOf(t.parent) + 1 : 0)
    for (const t of scg.threads) t.depth = depthOf(t)
    scg.nodes.sort((a, b) => (a.gen ?? a.id) - (b.gen ?? b.id))
    scg.nodes.forEach((n, i) => { n.id = i; n.gen = i })
    return abortFork
}

function retargetExit(scg: SCG, t: Thread, join: SNode) {
    t.exit.next = join
    ;(t.exit.seq ??= {}).next = scg.seq++
}

/** SCGControlFlowExtensions.nodeExistsPath(join, fork, false): the join leads back to its fork within a tick. */
function feedback(fork: SNode): boolean {
    const seen = new Set<SNode>()
    const work = [fork.join!]
    while (work.length) {
        const n = work.pop()!
        if (n === fork) return true
        if (seen.has(n)) continue
        seen.add(n)
        for (const m of successors(n)) if (!seen.has(m)) work.push(m)
    }
    return false
}

/** The thread of a preemptive fork a node's thread belongs to, and its index (undefined: not inside one). */
export function preemptiveAncestors(t: Thread): { fork: SNode; index: number }[] {
    const out: { fork: SNode; index: number }[] = []
    for (let x: Thread | undefined = t; x?.fork; x = x.parent) {
        if (x.fork.preemptive) out.push({ fork: x.fork, index: x.fork.threads!.indexOf(x) })
    }
    return out
}

/**
 * A pause that survives a par-or join that fired in the tick it was reached: when `when` ran in that tick and
 * `unless` (if any) did not.
 */
export interface Revival { when: SNode; unless?: SNode }

/** A control flow: its source, its slot among the source's outgoing flows, its target. */
interface Flow { from: SNode; key: string; to: SNode }

function outgoing(n: SNode): Flow[] {
    switch (n.kind) {
        case 'cond': {
            const out: Flow[] = []
            if (n.then) out.push({ from: n, key: `${n.id}t`, to: n.then })
            if (n.else) out.push({ from: n, key: `${n.id}e`, to: n.else })
            return out
        }
        case 'fork': return n.threads!.map((t, i) => ({ from: n, key: `${n.id}f${i}`, to: t.entry }))
        case 'surface': return []
        default: return n.next ? [{ from: n, key: `${n.id}n`, to: n.next }] : []
    }
}

/** SCGControlFlowExtensions.MAX_CONTROLFLOW_ACCUMULATION. */
const MAX_PATH = 100

/** The nodes reached from `source`'s outgoing flows (not `source` itself unless a flow leads back to it). */
function forward(source: SNode, flows: (n: SNode) => Flow[]): Set<SNode> {
    const seen = new Set<SNode>()
    const work = flows(source).map(f => f.to)
    while (work.length) {
        const n = work.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        for (const f of flows(n)) work.push(f.to)
    }
    return seen
}

/** The nodes from which `target` is reached over the flows `use` accepts (`target` included). */
function backward(target: SNode, incoming: Map<SNode, Flow[]>, use: (f: Flow) => boolean): Set<SNode> {
    const seen = new Set<SNode>([target])
    const work = [target]
    while (work.length) {
        const n = work.pop()!
        for (const f of incoming.get(n) ?? []) if (use(f) && !seen.has(f.from)) { seen.add(f.from); work.push(f.from) }
    }
    return seen
}

/**
 * SimpleGuardExpressions.createDepthBlockGuardExpression for the depths of threads under a par-or fork whose join
 * leads back to it (the innermost such fork; KIELER: "currently only works for single revival"), by surface. The
 * pause survives the join when the last node before it on the first path from the fork's thread entry into it ran,
 * provided every node on that path is reached only from such paths and leads only along them; otherwise when the
 * depth's own thread entry ran and, if the fork's thread can reach another of its pauses or the depth's thread its
 * exit, that exit did not.
 *
 * KIELER lists every path (getInstantaneousControlFlows), which can be exponentially many: here the flows on some
 * path are those between a node the entry reaches and one that reaches the pause, and the first path whose nodes
 * all pass the check is found depth first (KIELER's order) along such nodes' flows only.
 */
export function revivals(scg: SCG, alive: Set<SNode>): Map<SNode, Revival> {
    const out = new Map<SNode, Revival>()
    if (!scg.nodes.some(n => n.reincarnation)) return out
    const cache = new Map<SNode, Flow[]>()
    const flows = (n: SNode): Flow[] => {
        let l = cache.get(n)
        if (!l) cache.set(n, (l = outgoing(n)))
        return l
    }
    const incoming = new Map<SNode, Flow[]>()
    for (const n of scg.nodes) for (const f of flows(n)) {
        let l = incoming.get(f.to)
        if (!l) incoming.set(f.to, (l = []))
        l.push(f)
    }
    const reachedFrom = new Map<SNode, Set<SNode>>()
    for (const depth of scg.nodes) {
        if (depth.kind !== 'depth' || !depth.surface || !alive.has(depth)) continue
        const surface = depth.surface
        const own = depth.thread
        let inFork: Thread | undefined
        for (let x: Thread | undefined = own; x?.fork; x = x.parent) {
            const f = x.fork
            if (f.join?.any && f.reincarnation && alive.has(f)) { inFork = x; break }
        }
        if (!inFork) continue
        const entry = inFork.entry
        let ahead = reachedFrom.get(entry)
        if (!ahead) reachedFrom.set(entry, (ahead = forward(entry, flows)))
        if (!ahead.has(surface)) continue
        const from = (n: SNode) => n === entry || ahead.has(n)
        const behind = backward(surface, incoming, () => true)
        const onPath = (f: Flow) => from(f.from) && behind.has(f.to)
        // KIELER's fixpoint stops after one round (it compares the filtered list with itself).
        const good = (s: SNode) =>
            (s.kind === 'entry' || s.kind === 'join' || (incoming.get(s) ?? []).every(onPath))
            && (s.kind === 'fork' || flows(s).every(onPath))
        const usable = (f: Flow) => onPath(f) && good(f.from)
        const leads = backward(surface, incoming, usable)
        const path: Flow[] = []
        const walk = (f: Flow): Flow | undefined => {
            if (!usable(f) || !leads.has(f.to) || path.includes(f)) return undefined
            if (f.to === surface) return f
            if (path.length === MAX_PATH) return undefined
            path.push(f)
            for (const g of flows(f.to)) {
                const last = walk(g)
                if (last) return last
            }
            path.pop()
            return undefined
        }
        let last: Flow | undefined
        for (const f of flows(entry)) if ((last = walk(f))) break
        if (last) {
            out.set(surface, { when: last.from })
            continue
        }
        const other = scg.nodes.some(n => n.kind === 'surface' && n !== surface && within(n.thread, inFork) && ahead.has(n))
            || (alive.has(own.exit) && ahead.has(own.exit))
        out.set(surface, other ? { when: own.entry, unless: own.exit } : { when: own.entry })
    }
    return out
}

function within(t: Thread, outer: Thread): boolean {
    for (let x: Thread | undefined = t; x; x = x.parent) if (x === outer) return true
    return false
}

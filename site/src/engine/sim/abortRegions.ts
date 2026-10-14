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
// without a pause) needs KIELER's thread reincarnation guards, which the simulator does not implement: such charts
// get the `unsupported` info.

import type { Diagnostic } from '../types'
import type { SCG, SNode, Thread } from './scg'
import { successors } from './scg'
import { abortRegionErrors } from './passes/abortRegion'

/** Applies SCGAbortRegionProcessor to the graph; returns its errors and the `unsupported` info for charts it cannot simulate. */
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
    for (const fork of done) {
        if (!feedback(fork)) continue
        fork.reincarnation = true
        const id = fork.state?.origin ?? fork.state?.about
        const name = (id && nameOf(id)) ?? fork.state?.name
        out.push({
            severity: 'info', code: 'unsupported', related: id ? [id] : undefined,
            message: `The guide's simulator cannot run abort regions in a state that is left and entered again in the same tick${name ? ` (\`${name}\`)` : ''}`,
            hint: 'KIELER gives the regions of such a state extra "reincarnation" conditions that the simulator does not reproduce. The official KIELER tools run this chart. Making the transition that re-enters the state delayed lets the guide run it.',
        })
    }
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

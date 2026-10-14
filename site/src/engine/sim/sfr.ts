// KIELER's SCG clean-ups that run right after the SCG is built (sccharts.netlist.kico: str, then sfr):
//
// - Superfluous Thread Remover (scg/processors/optimizer/SuperfluousThreadRemover.xtend): a thread whose entry
//   leads straight to its exit (a region that is just a final state) is removed; a fork left without threads is
//   removed and its predecessors continue after the join.
// - Superfluous Fork Remover (scg/processors/optimizer/SuperfluousForkRemover.xtend): a superstate with a single
//   region needs no fork and join, so control flow into the fork goes straight to the region's first node, and
//   control flow into the region's exit goes straight to the join's successor.
//
// Everything later in KIELER's chain (thread analysis, loops, schizophrenia curing, synchronizers) sees the graph
// without these threads and forks, so the simulator does the same. Ported with the rerouting order (forks in the
// order KIELER created them, flows removed at the end) and the crashes (concurrency.md T-6, K-1):
// - a superstate below the root left without threads (its only region was just a final state): observed to
//   crash KIELER ("The compiler failed during compilation setup."), the root does not;
// - a later single-region superstate with a named region that is only reachable through the join of a superstate
//   removed before it: getThreadEntry finds no thread and `ancestorEntry.name` throws;
// - a single-region superstate whose region starts in a state without node, entered other than from a thread's
//   entry: the flows into it are re-routed to nothing, and ThreadAnalyzer throws on them.

import type { Diagnostic } from '../types'
import { allStates, readableName, type CState } from './model'
import type { SCG, SNode, Thread } from './scg'

type Slot = 'next' | 'then' | 'else' | number

interface Flow {
    from: SNode
    slot: Slot
    to: SNode | undefined
    /** Creation rank (scg.ts): rewiring appends the flow to its new target's incoming flows. */
    seq: number
}

export function removeSuperfluousForks(scg: SCG, core: CState): Diagnostic[] {
    const out: Diagnostic[] = []
    const flows: Flow[] = []
    const byTarget = new Map<SNode, Set<Flow>>()
    const own = new Map<SNode, Flow[]>()
    const place = (f: Flow, to: SNode | undefined) => {
        if (f.to) byTarget.get(f.to)?.delete(f)
        f.to = to
        if (to) {
            let set = byTarget.get(to)
            if (!set) byTarget.set(to, (set = new Set()))
            set.add(f)
        }
    }
    const retarget = (f: Flow, to: SNode | undefined) => {
        place(f, to)
        f.seq = scg.seq++
    }
    const pending: Flow[] = []
    const add = (from: SNode, slot: Slot, to: SNode | undefined, seq: number | undefined) => {
        if (!to) return
        const f: Flow = { from, slot, to, seq: seq ?? Infinity }
        pending.push(f)
        let l = own.get(from)
        if (!l) own.set(from, (l = []))
        l.push(f)
    }
    for (const n of scg.nodes) {
        switch (n.kind) {
            case 'cond': add(n, 'then', n.then, n.seq?.then); add(n, 'else', n.else, n.seq?.else); break
            case 'fork': n.threads!.forEach((t, i) => add(n, i, t.entry, n.seq?.threads?.[i])); break
            case 'surface': break
            default: add(n, 'next', n.next, n.seq?.next)
        }
    }
    // Incoming flows in KIELER's order.
    pending.sort((a, b) => a.seq - b.seq)
    for (const f of pending) {
        const to = f.to
        f.to = undefined
        place(f, to)
        flows.push(f)
    }
    const incoming = (n: SNode) => [...(byTarget.get(n) ?? [])]
    const flowOf = (n: SNode) => own.get(n)?.[0]

    /** SCGThreadExtensions.getThreadEntry on the current flows. */
    const threadEntry = (node: SNode): SNode | undefined => {
        const work: Flow[] = node.kind === 'join' ? incoming(node.fork!) : incoming(node)
        const marked = new Set<Flow>()
        const push = (list: Flow[]) => { for (const f of list) if (!marked.has(f)) work.push(f) }
        while (work.length) {
            const f = work.shift()!
            if (marked.has(f)) continue
            marked.add(f)
            const prev = f.from
            if (prev.kind === 'join') push(incoming(prev.fork!))
            else if (prev.kind === 'entry') return prev
            else if (prev.kind === 'depth') push(incoming(prev.surface!))
            else push(incoming(prev))
        }
        return undefined
    }

    const crash = (fork: SNode, message: string, hint: string, kieler: string, also: (string | undefined)[] = []) => {
        const state = fork.state?.origin ?? fork.state?.about
        const related = [...also, state].filter((x): x is string => !!x)
        out.push({ severity: 'error', code: 'kieler-crash', message, kieler, hint, related: related.length ? [...new Set(related)] : undefined })
    }

    // KIELER's node order: states in pre-order (SCGTransformation.transformSCGGenerateNodes).
    const forks = allStates(core).map(s => scg.stateNodes.get(s)).filter((n): n is SNode => n?.kind === 'fork')
    const removedNodes = new Set<SNode>()
    const removedThreads = new Set<Thread>()

    // Superfluous Thread Remover.
    const threadsLeft = new Map<SNode, Thread[]>(forks.map(f => [f, [...f.threads!]]))
    // Entries in KIELER's node order.
    for (const t of [...scg.threads].sort((a, b) => a.rank - b.rank)) {
        if (!t.fork || flowOf(t.entry)?.to !== t.exit) continue
        const fork = t.fork
        for (const f of incoming(t.entry)) retarget(f, undefined)
        removedNodes.add(t.entry)
        removedNodes.add(t.exit)
        removedThreads.add(t)
        const left = (threadsLeft.get(fork) ?? fork.threads!).filter(x => x !== t)
        threadsLeft.set(fork, left)
        if (left.length === 0) {
            if (!fork.state?.root) {
                crash(fork, 'KIELER\'s compiler crashes on a superstate whose only region is just a final state',
                    'Give the region a state to start in before the final state, or remove the superstate.',
                    'The compiler failed during compilation setup. (after SuperfluousThreadRemover)')
                return out
            }
            const after = flowOf(fork.join!)?.to
            for (const f of incoming(fork)) retarget(f, after)
            removedNodes.add(fork)
            removedNodes.add(fork.join!)
        }
    }
    for (const fork of forks) fork.threads = threadsLeft.get(fork) ?? fork.threads

    for (const fork of forks) {
        if (removedNodes.has(fork) || fork.threads!.length !== 1) continue
        const t = fork.threads![0]
        const join = fork.join!
        const ancestor = threadEntry(fork)
        const entryTarget = flowOf(t.entry)?.to
        const forkIncoming = incoming(fork)
        // The region starts in a state without node (a referenced chart's state whose first immediate transition goes
        // back to it, scg.ts simpleState): KIELER's entry flow has no target, and the flows into the fork are re-routed
        // to nothing. ThreadAnalyzer then walks the threads and throws on such a flow unless it is a thread's entry's.
        if (!entryTarget && forkIncoming.some(f => f.from.kind !== 'entry')) {
            const id = fork.state?.origin ?? fork.state?.about
            crash(fork, `KIELER's compiler crashes on this chart: a transition leads into ${fork.state?.name ? `\`${fork.state.name}\`` : 'a superstate'}, whose only region starts in a state without code`,
                'In a referenced chart, KIELER drops a state whose first immediate transition goes back to it without a trigger (the transition has no take counter there), so that state has no code. Such a loop would not let the tick end anyway: give the transition a trigger, or make it delayed.',
                'java.lang.NullPointerException in ThreadAnalyzer (SCGThreadExtensions.getAllThreadNodesAndThreads; the lab server reports: The compiler failed during compilation setup.)',
                id ? [id] : [])
            return out
        }
        for (const f of forkIncoming) retarget(f, entryTarget)
        const joinTarget = flowOf(join)?.to
        const exitIncoming = incoming(t.exit)
        if (exitIncoming.length && !joinTarget) {
            crash(fork, 'KIELER\'s compiler crashes on this superstate (its region ends, but nothing follows)',
                'Add a transition after the superstate.', 'Cannot re-route join flows without next target. The SCG seems to be broken.')
            return out
        }
        for (const f of exitIncoming) retarget(f, joinTarget)
        if (t.region?.name && !ancestor) {
            // The superstate before it: reached only through its join, which cannot fire.
            const before: (CState | undefined)[] = []
            const seen = new Set<SNode>()
            const back = forkIncoming.map(f => f.from)
            while (back.length) {
                const n = back.pop()!
                if (seen.has(n)) continue
                seen.add(n)
                if (n.kind === 'join') before.push(n.fork!.state)
                else if (n.kind === 'assign' || n.kind === 'cond') back.push(...incoming(n).map(f => f.from))
            }
            const names = [...new Set(before.map(s => readableName(s)).filter(Boolean))]
            crash(fork, `KIELER's compiler crashes on this chart: ${names.length ? names.map(n => `\`${n}\``).join(', ') : 'a superstate'} can never finish (a region without a final state), but its \`join to\` leads to a state with an entry action or a named region`,
                'A `join to` waits for every region to reach a final state: add a final state to the superstate\'s region, or remove the `join to` transition.',
                'java.lang.NullPointerException in SuperfluousForkRemover (the lab server reports: The compiler failed during compilation setup.)',
                before.map(s => s?.origin ?? s?.about))
            return out
        }
        for (const n of [fork, join, t.entry, t.exit]) removedNodes.add(n)
        removedThreads.add(t)
    }
    if (!removedNodes.size) return out

    // Write the flows back (flows of removed nodes vanish with them).
    for (const n of scg.nodes) {
        if (removedNodes.has(n)) continue
        if (n.kind === 'fork') continue
        if (n.kind === 'cond') {
            n.then = undefined
            n.else = undefined
        } else if (n.kind !== 'surface') {
            n.next = undefined
        }
    }
    for (const f of flows) {
        if (removedNodes.has(f.from)) continue
        const n = f.from
        const seq = (n.seq ??= {})
        if (f.slot === 'then') { n.then = f.to; seq.then = f.seq }
        else if (f.slot === 'else') { n.else = f.to; seq.else = f.seq }
        else if (f.slot === 'next') { n.next = f.to; seq.next = f.seq }
    }
    for (const n of scg.nodes) {
        if (n.kind !== 'fork' || removedNodes.has(n)) continue
        const own_ = own.get(n) ?? []
        ;(n.seq ??= {}).threads = n.threads!.map(th => own_.find(f => f.to === th.entry)?.seq ?? Infinity)
    }

    // Nodes of removed threads now belong to the enclosing thread.
    const live = (t: Thread): Thread => {
        let x = t
        while (removedThreads.has(x)) x = x.parent!
        return x
    }
    for (const n of scg.nodes) n.thread = live(n.thread)
    for (const t of scg.threads) {
        if (removedThreads.has(t)) continue
        if (t.parent) t.parent = live(t.parent)
    }
    const depthOf = (t: Thread): number => (t.parent ? depthOf(t.parent) + 1 : 0)
    scg.threads = scg.threads.filter(t => !removedThreads.has(t))
    for (const t of scg.threads) t.depth = depthOf(t)
    for (const [s, n] of scg.stateNodes) {
        if (!removedNodes.has(n)) continue
        let target: SNode | undefined = n
        for (let guard = 0; target && removedNodes.has(target) && guard < 1000; guard++) {
            if (target.kind === 'fork') target = target.threads!.length ? flowOf(target.threads![0].entry)?.to : flowOf(target.join!)?.to
            else if (target.kind === 'entry' || target.kind === 'join' || target.kind === 'exit') target = flowOf(target)?.to
            else target = undefined
        }
        if (target && !removedNodes.has(target)) scg.stateNodes.set(s, target)
        else scg.stateNodes.delete(s)
    }
    scg.nodes = scg.nodes.filter(n => !removedNodes.has(n))
    scg.nodes.forEach((n, i) => { n.id = i })
    return out
}

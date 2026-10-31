// The sequentially constructive graph (SCG) of the core chart: what KIELER's core chain (Trigger/Effect,
// Surface/Depth: sccharts/processors/TriggerEffect.xtend, SurfaceDepth.xtend) and its SCG transformation
// (sccharts/processors/scg/SCGTransformation.xtend) produce, built in one step.
//
//   superstate        fork -> one thread per control-flow region (entry ... exit) -> join -> termination target
//   final state       the thread's exit (a final state without outgoing transitions)
//   simple state      surface: the immediate transitions in priority order (conditionals), then a pause;
//                     depth (next tick): all transitions in priority order, then back to the pause
//   transition        one assignment node per effect, then the target state's first node
//
// Only nodes reachable from the root entry exist (KIELER's dead code removal). Every node knows the core state
// and transition or action it implements, so everything maps back to the source.
//
// The graph also has KIELER's shape where later analyses depend on it:
// - the effects Trigger/Effect moves into states of their own are one chain, shared by an immediate
//   transition's surface copy and its depth original;
// - Surface/Depth's depth transition optimisation (DTO): when the last transitions are immediate, the depth
//   continues in the surface's conditionals for them instead of testing them again;
// - every control flow has KIELER's creation rank (`seq`): the order of a node's incoming control flows in
//   KIELER's EMF model, which decides where its depth-first searches look first (the schizophrenia cure's
//   hasConcurrentDelay, propagateDelay). Flows are created state by state in region order (generated states
//   come after the written ones: first Trigger/Effect's, then Surface/Depth's), flows into final states move to
//   the region's exit afterwards (trimExitNodes), and later rewiring appends (scg.seq).

import type { Span } from '../types'
import type { CEffect, CExpr, CRegion, CState, CTransition } from './model'
import { allStates, controlflowRegions, controlflowRegionsContainStates, isImplicitlyImmediate, regionsMayTerminate } from './model'

export type NodeKind = 'entry' | 'exit' | 'assign' | 'cond' | 'fork' | 'join' | 'surface' | 'depth'

/** Creation ranks of a node's outgoing control flows (fork: one per thread). */
export interface FlowSeq {
    next?: number
    then?: number
    else?: number
    threads?: number[]
}

export interface SNode {
    id: number
    kind: NodeKind
    /** The innermost thread the node belongs to (a fork and its join belong to the parent thread). */
    thread: Thread
    next?: SNode
    then?: SNode
    else?: SNode
    /** fork: its threads in region order. */
    threads?: Thread[]
    /** fork -> join, join -> fork. */
    join?: SNode
    fork?: SNode
    /** surface -> depth, depth -> surface. */
    depth?: SNode
    surface?: SNode
    /** assign: the effect. */
    effect?: CEffect
    /** cond: the condition. */
    expr?: CExpr
    /** The core state this node implements part of. */
    state?: CState
    /** cond: the transition whose trigger it tests; assign: the transition whose effect it runs. */
    transition?: CTransition
    /** A schizophrenic surface copy made by the structural depth join (analysis.ts). */
    schizo?: SNode
    /** Copies keep a link to the node they copy. */
    copyOf?: SNode
    /** KIELER's creation rank of each outgoing control flow. */
    seq?: FlowSeq
    /** Position in KIELER's node list (SCGTransformation creates nodes state by state; copies come last). */
    gen?: number
    /** cond: KIELER also has an else flow to the then branch's node (the netlist's equal-branch defect). */
    sameElse?: boolean
    /** cond with `sameElse`: the node both branches reach in KIELER's graph, when the simulator's then branch first
     *  passes marks KIELER has no nodes for (a referenced chart's transitions, scg.ts weightOf). */
    sameTarget?: SNode
    /** fork: KIELER's SEQUENTIAL_PREEMPTIVE fork of a state with abort regions (abortRegions.ts): its threads run
     *  in order and finishing ones preempt later ones. */
    preemptive?: boolean
    /** join: a par-or join (`any`): it fires as soon as any of its threads finishes (abort regions). */
    any?: boolean
    /** fork: a preemptive fork whose join leads back to it within a tick (KIELER's thread reincarnation). */
    reincarnation?: boolean
    /**
     * assign, cond: a node of a method's (or code block's) body that KIELER's Methods processor copied into the
     * graph (structure/methods.ts inline), `name` as called. Its conditions are the body's `if` tests, not a check of
     * the transition the call is on. `jumpsBack`: a `goto` from this node to a label before it (the body loops within
     * the tick, which KIELER cannot schedule).
     */
    method?: { name: string; jumpsBack?: { label: string; span?: Span } }
}

export interface Thread {
    id: number
    entry: SNode
    exit: SNode
    /** The region the thread runs (undefined for the root thread). */
    region?: CRegion
    /** The fork that starts the thread (undefined for the root thread). */
    fork?: SNode
    parent?: Thread
    depth: number
    /** A final region's thread (KIELER: exit.final). */
    final: boolean
    /** Position of the thread's entry in KIELER's node list (SCGTransformation creates nodes in region order). */
    rank: number
}

export interface SCG {
    nodes: SNode[]
    threads: Thread[]
    root: Thread
    /** First node of each core state (as KIELER's state-to-node mapping). */
    stateNodes: Map<CState, SNode>
    /** Problems found while building (instantaneous loops through states without nodes, KIELER crashes). */
    problems: { message: string; states: CState[]; kieler?: string }[]
    /** The next free control-flow rank: rewiring a flow appends it to its new target's incoming flows. */
    seq: number
    /**
     * Transitions (tracker ids) of referenced charts that have no nodes: KIELER merges a state whose only transition is
     * immediate, untriggered and effectless into its target. The source-level configuration follows them on entry.
     */
    silentHops?: string[]
}

type Key = number[]
type Slot = 'next' | 'then' | 'else'

/** After the root's flows ([0, ...]): flows moved into region exits by trimExitNodes. */
const TRIMMED = 1
/** A state's flows after those of its regions (the join's). */
const LAST = 1e9

function compareKeys(a: Key, b: Key): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
    return a.length - b.length
}

/** Number of KIELER effects an effect stands for: the TTS reset is one per transition, action marks none. */
function weightOf(e: CEffect, ttsCount: number): number {
    if (e.k !== 'mark') return 1
    // Action marks and the preemption passes' tracker hooks are not KIELER effects.
    if (e.m.kind === 'action' || e.m.kind === 'enterRegions' || e.m.kind === 'resume') return 0
    // Transitions of a referenced chart's copy are not counted by Taken Transition Signaling (structure.md S-15).
    if (e.m.kind === 'take' && e.m.index < 0) return 0
    if (e.m.kind === 'ttsReset') return Math.max(1, ttsCount)
    return 1
}

/** A mark node that stands for no KIELER effect (KIELER's graph has no node for it, weightOf). */
export function noKielerNode(n: SNode | undefined): boolean {
    return n?.kind === 'assign' && n.effect?.k === 'mark' && weightOf(n.effect, 1) === 0
}

/** KIELER's equals2 (KExpressionsCompareExtensions): structural for operators, references and literals only. */
function equals2(a: CExpr | undefined, b: CExpr | undefined): boolean {
    if (!a || !b) return a === b
    if (a.k !== b.k) return false
    switch (a.k) {
        case 'lit': return a.t === (b as typeof a).t && a.v === (b as typeof a).v
        case 'host': return a.text === (b as typeof a).text
        case 'ref': {
            const o = b as typeof a
            return a.v === o.v && a.idx.length === o.idx.length && a.idx.every((x, i) => equals2(x, o.idx[i]))
        }
        case 'op': {
            const o = b as typeof a
            return a.op === o.op && a.args.length === o.args.length && a.args.every((x, i) => equals2(x, o.args[i]))
        }
        case 'vector': {
            const o = b as typeof a
            return a.values.length === o.values.length && a.values.every((x, i) => equals2(x, o.values[i]))
        }
        default: return false
    }
}

class Builder {
    readonly nodes: SNode[] = []
    readonly threads: Thread[] = []
    readonly stateNodes = new Map<CState, SNode>()
    readonly problems: SCG['problems'] = []
    private readonly resolving = new Set<CState>()
    /** States being merged into the target of their silent transition (simpleState), and the silent cycles found. */
    private readonly silentMerging = new Set<CState>()
    private readonly silentCycle = new Set<CState>()
    /** Creation keys of the flows (converted to ranks at the end). */
    private readonly keys = new Map<SNode, { next?: Key; then?: Key; else?: Key; threads?: Key[] }>()
    /** Position of every state and region in KIELER's SCG connection order. */
    private readonly pos = new Map<CState, Key>()
    private readonly rpos = new Map<CRegion, Key>()
    /** Pre-order index (Surface/Depth handles states in this order). */
    private readonly pre = new Map<CState, number>()
    /** Trigger/Effect: per transition it splits, the key of the state each effect ends in (undefined: no state). */
    private readonly te = new Map<CTransition, (Key | undefined)[]>()
    /** Shared effect chains of the transitions Trigger/Effect splits. */
    private readonly teChains = new Map<CTransition, SNode | null>()
    /** The final state a state's node is (final states, and states that only pass on to one). */
    private readonly finalOf = new Map<CState, CState>()
    /** Node creation keys in KIELER's node list. */
    private readonly genKeys = new Map<SNode, Key>()
    /** Transitions of referenced charts that KIELER's optimisations remove (the tracker follows them on entry). */
    readonly silentHops: string[] = []
    /** States a depth was redirected into by DTO across states (one more incoming transition in KIELER's model). */
    private readonly dtoIncoming = new Map<CState, number>()

    constructor(root: CState, private readonly ttsCount: number) {
        const visit = (s: CState, key: Key) => {
            this.pos.set(s, key)
            controlflowRegions(s).forEach((r, ri) => {
                const rk = [...key, ri]
                this.rpos.set(r, rk)
                r.states.forEach((x, i) => visit(x, [...rk, 0, i]))
            })
        }
        visit(root, [0])
        allStates(root).forEach((s, i) => this.pre.set(s, i))
        // Trigger/Effect handles the transitions in containment order (a state's inner transitions before its own)
        // and appends each effect state to the target's region.
        let te = 0
        const visitTE = (s: CState) => {
            for (const r of controlflowRegions(s)) for (const x of r.states) visitTE(x)
            for (const t of s.out) {
                if (!this.splits(t)) continue
                const region = this.rpos.get(t.target.parent!) ?? [0]
                this.te.set(t, t.effects.map(e => {
                    const w = weightOf(e, this.ttsCount)
                    if (!w) return undefined
                    te += w
                    return [...region, 1, te - 1]
                }))
            }
        }
        visitTE(root)
    }

    private weight(t: CTransition): number {
        return t.effects.reduce((n, e) => n + weightOf(e, this.ttsCount), 0)
    }

    /** TriggerEffect: does it move the transition's effects into states of their own? */
    splits(t: CTransition): boolean {
        const w = this.weight(t)
        return ((t.trigger !== undefined || t.delay !== 'immediate' || t.preemption === 'termination') && w > 0) || w > 1
    }

    /** After Trigger/Effect, does the transition still carry effects? */
    keepsEffects(t: CTransition): boolean {
        return !this.splits(t) && this.weight(t) > 0
    }

    node(kind: NodeKind, thread: Thread, extra: Partial<SNode>, gen: Key): SNode {
        const n: SNode = { id: this.nodes.length, kind, thread, ...extra }
        this.nodes.push(n)
        this.genKeys.set(n, gen)
        return n
    }

    thread(parent: Thread | undefined, region: CRegion | undefined, fork: SNode | undefined): Thread {
        const t = {
            id: this.threads.length, region, fork, parent, depth: parent ? parent.depth + 1 : 0, final: !!region?.final, rank: 0,
        } as Thread
        this.threads.push(t)
        const R = region ? this.rpos.get(region) ?? [] : []
        t.entry = this.node('entry', t, {}, [...R, -1, 0])
        t.exit = this.node('exit', t, {}, [...R, -1, 1])
        return t
    }

    /** Sets a control flow. `target`: the state it leads to (a flow into a final state moves to the region's exit). */
    private link(src: SNode, slot: Slot, to: SNode | undefined, key: Key, target?: CState) {
        src[slot] = to
        if (!to) return
        let k = this.keys.get(src)
        if (!k) this.keys.set(src, (k = {}))
        const final = target && to.kind === 'exit' && to === to.thread.exit ? this.finalOf.get(target) : undefined
        k[slot] = final ? [TRIMMED, ...(this.pos.get(final) ?? []), ...key] : key
    }

    private threadKey(fork: SNode, key: Key) {
        let k = this.keys.get(fork)
        if (!k) this.keys.set(fork, (k = {}))
        ;(k.threads ??= []).push(key)
    }

    /** The first node of state `s` in thread `t` (built on first use). */
    stateNode(s: CState, t: Thread): SNode | undefined {
        const known = this.stateNodes.get(s)
        if (known) return known
        if (this.resolving.has(s)) {
            // A cycle of states merged into the targets of their silent transitions (a referenced chart's immediate
            // transitions without trigger have no KIELER effects): Surface/Depth merges them into one state with an
            // untriggered self-loop, which it then drops (simpleState). The states have no node, as for that loop.
            const path = [...this.resolving].slice([...this.resolving].indexOf(s))
            if (path.every(x => this.silentMerging.has(x))) {
                for (const x of path) this.silentCycle.add(x)
                return undefined
            }
            // A cycle of immediate transitions without trigger and effects: no node in between.
            this.problems.push({ message: 'instantaneous loop of transitions without trigger and effects', states: [...this.resolving] })
            const loop = this.node('assign', t, { state: s }, [...(this.pos.get(s) ?? [0]), 0])
            this.stateNodes.set(s, loop)
            this.link(loop, 'next', loop, this.pos.get(s) ?? [0])
            return loop
        }
        if (s.root || controlflowRegionsContainStates(s)) return this.superstate(s, t)
        if (s.final && s.out.length === 0) {
            this.stateNodes.set(s, t.exit)
            this.finalOf.set(s, s)
            return t.exit
        }
        return this.simpleState(s, t)
    }

    /**
     * The state a region starts in: SCGTransformation takes the first initial state of the region after
     * Surface/Depth. A region has several only after Deferred copied an initial state (passes/deferred.ts: like
     * EcoreUtil.copy, the copy keeps the flag); Surface/Depth's superfluous immediate transition optimisation then
     * replaces a simple state whose first transition is delayed by its `_Pause` state, at the end of the region.
     */
    private initialOf(region: CRegion): CState | undefined {
        const initials = region.states.filter(x => x.initial)
        if (initials.length < 2) return initials[0]
        const movedBySurfaceDepth = (s: CState): boolean => {
            if (controlflowRegionsContainStates(s)) return false
            if (s.out.length === 0) return !s.final
            const t0 = s.out[0]
            if (s.out.length === 1 && t0.preemption === 'termination') return false
            if (s.out.length === 1 && t0.trigger === undefined && !isImplicitlyImmediate(t0) && !this.keepsEffects(t0)) return false
            if (s.out.length > 1 && conditionalPattern(this, t0, s.out[1])) return false
            // Immediate transitions are duplicated to the front and keep the state; it is merged only without them.
            return !s.out.some(x => x.delay === 'immediate')
        }
        return initials.find(x => !movedBySurfaceDepth(x)) ?? initials[0]
    }

    private superstate(s: CState, t: Thread): SNode {
        const P = this.pos.get(s) ?? [0]
        const fork = this.node('fork', t, { state: s }, [...P, -1, 0])
        const join = this.node('join', t, { state: s }, [...P, -1, 1])
        fork.join = join
        join.fork = fork
        this.stateNodes.set(s, fork)
        fork.threads = []
        controlflowRegions(s).forEach((region, ri) => {
            const R = this.rpos.get(region) ?? [...P, ri]
            const child = this.thread(t, region, fork)
            fork.threads!.push(child)
            this.threadKey(fork, [...R, -3])
            this.link(child.exit, 'next', join, [...R, -2])
            const initial = this.initialOf(region)
            this.link(child.entry, 'next', initial ? this.stateNode(initial, child) : undefined, [...R, -1], initial)
        })
        if (s.out.length > 0) {
            this.chainFrom(join, 'next', s.out[0], t, [...P, LAST], P)
        } else if (s.root) {
            this.link(join, 'next', t.exit, [...P, LAST])
        } else if (!s.final && regionsMayTerminate(s)) {
            // Surface/Depth: a halt superstate that may terminate continues in __sd_HaltState (a pause loop).
            const halt = [...(this.rpos.get(s.parent!) ?? P), 2, this.pre.get(s) ?? 0, 0]
            const surface = this.node('surface', t, { state: s }, [...halt, 0])
            const depth = this.node('depth', t, { state: s }, [...halt, 1])
            surface.depth = depth
            depth.surface = surface
            this.link(depth, 'next', surface, [...halt, 0])
            this.link(join, 'next', surface, [...P, LAST])
        } else {
            this.link(join, 'next', t.exit, [...P, LAST])
        }
        return fork
    }

    private simpleState(s: CState, t: Thread): SNode | undefined {
        const P = this.pos.get(s) ?? [0]
        const R = this.rpos.get(s.parent!) ?? P
        const preIndex = this.pre.get(s) ?? 0
        let generated = 0
        /** The next state Surface/Depth creates for this state. */
        const sd = (): Key => [...R, 2, preIndex, generated++]

        // The first immediate transition is an untriggered self-loop with no KIELER effects (in a referenced chart):
        // Surface/Depth's clean-ups (superfluous conditional states, then superfluous immediate transitions) drop it and
        // the transitions after it. The state is left without transitions, so KIELER's SCG has no node for it: control
        // that reaches it ends there (the thread neither pauses nor exits, and its join treats it as done).
        const firstImmediate = s.out.find(x => x.delay === 'immediate')
        if (firstImmediate && firstImmediate.target === s && firstImmediate.trigger === undefined && silentTake(firstImmediate)) return undefined
        if (s.out.length === 0) {
            // A halt state: KIELER adds a delayed self-loop; after Surface/Depth's clean-ups its pause is a
            // generated state.
            const key = sd()
            const surface = this.node('surface', t, { state: s }, [...key, 0])
            const depth = this.node('depth', t, { state: s }, [...key, 1])
            surface.depth = depth
            depth.surface = surface
            this.link(depth, 'next', surface, [...key, 0])
            this.stateNodes.set(s, surface)
            return surface
        }
        const out = s.out
        const t0 = out[0]
        if (out.length === 1 && t0.trigger === undefined && !isImplicitlyImmediate(t0) && !this.keepsEffects(t0)) {
            // Surface/Depth leaves a plain pause alone: the state is the pause.
            const surface = this.node('surface', t, { state: s }, [...P, 0])
            const depth = this.node('depth', t, { state: s }, [...P, 1])
            surface.depth = depth
            depth.surface = surface
            this.stateNodes.set(s, surface)
            this.resolving.add(s)
            this.chainFrom(depth, 'next', t0, t, [...P, 0], P)
            this.resolving.delete(s)
            return surface
        }

        // Surface/Depth: the immediate transitions are copied to the front (they are the surface); the originals
        // count as delayed, so the pause comes before them and the depth checks every transition in order.
        const surfaceItems = out.filter(x => x.delay === 'immediate')
        const order: { t: CTransition; surface: boolean }[] = [
            ...surfaceItems.map(x => ({ t: x, surface: true })),
            ...out.map(x => ({ t: x, surface: false })),
        ]
        // DTO: the depth's last transitions continue in the surface's conditionals for them.
        // Pairs are compared from the back (the surface's last conditional with the depth's last one) while they
        // have the same target and equal triggers; the comparison stops at the state itself, whose incoming
        // transitions come from elsewhere.
        let merged = 0
        while (merged < surfaceItems.length && merged < out.length) {
            const a = surfaceItems[surfaceItems.length - 1 - merged]
            const b = out[out.length - 1 - merged]
            const sameTarget = a === b || (!this.splits(a) && !this.splits(b) && a.target === b.target)
            const sameTrigger = (a.trigger === undefined && b.trigger === undefined) || equals2(a.trigger, b.trigger)
            if (!sameTarget || !sameTrigger) break
            merged++
        }
        // KIELER's DTO does not stop at the state: when the state has exactly one incoming transition, an immediate one,
        // it goes on comparing the depth's next transition (from the back) with the first other transition of that
        // transition's source, and merges them too: the depth then continues in the predecessor (SurfaceDepth.xtend,
        // the loop over stateAfterDepth). This happens with the connector the Abort transformation puts before the
        // target of a superstate's join: the depth re-runs the connector, and its transition counts again.
        let continueAt: CState | undefined
        if (surfaceItems.length > 0 && merged === surfaceItems.length) {
            let at: CState = s
            while (merged < out.length) {
                if (at.incoming.length !== 1 || (this.dtoIncoming.get(at) ?? 0) > 0 || at.initial) break
                const t1 = at.incoming[0]
                if (t1.delay !== 'immediate') break
                const k1 = t1.source
                const k1Out = this.untransformedOut(k1, s)
                const tk1 = k1Out?.find(x => x !== t1)
                const tk2 = out[out.length - 1 - merged]
                if (!tk1 || k1 === s) break
                const sameTarget = !this.splits(tk1) && !this.splits(tk2) && tk1.target === tk2.target
                const sameTrigger = (tk1.trigger === undefined && tk2.trigger === undefined) || equals2(tk1.trigger, tk2.trigger)
                if (!sameTarget || !sameTrigger) break
                merged++
                continueAt = k1
                at = k1
            }
            if (continueAt) this.dtoIncoming.set(continueAt, (this.dtoIncoming.get(continueAt) ?? 0) + 1)
        }
        const depthCount = out.length - merged
        const surfaceFirst: SNode[] = []

        let first: SNode | undefined
        let pause: SNode | undefined
        /** Where the next node of the chain is attached (its flow's source, slot and key). */
        let attach: { src: SNode; slot: Slot; key: Key } | undefined
        const register = (n: SNode | undefined) => {
            if (!first && n) {
                first = n
                this.stateNodes.set(s, n)
            }
        }
        this.resolving.add(s)
        let ended = false
        let depthIndex = 0
        for (let i = 0; i < order.length; i++) {
            const item = order[i]
            if (!item.surface && !pause) {
                const key = sd()
                sd() // _Depth (merged into the next state by the optimisations)
                pause = this.node('surface', t, { state: s }, [...key, 0])
                const depth = this.node('depth', t, { state: s }, [...key, 1])
                pause.depth = depth
                depth.surface = pause
                if (attach) this.link(attach.src, attach.slot, pause, attach.key)
                register(pause)
                attach = { src: depth, slot: 'next', key: [...key, 0] }
            }
            if (!item.surface) {
                if (depthIndex === depthCount) {
                    // Merged by DTO: continue in the surface's conditional for this transition (or in the predecessor).
                    const target = continueAt ? this.stateNode(continueAt, t) : surfaceFirst[surfaceItems.length - merged]
                    if (attach && target) this.link(attach.src, attach.slot, target, attach.key)
                    ended = true
                    break
                }
                depthIndex++
            }
            const holder = i === 0 && item.surface ? P : sd()
            const tr = item.t
            if (tr.trigger !== undefined) {
                const cond = this.node('cond', t, { state: s, transition: tr, expr: tr.trigger }, [...holder, 0])
                if (attach) this.link(attach.src, attach.slot, cond, attach.key)
                register(cond)
                if (item.surface) surfaceFirst.push(cond)
                this.chainFrom(cond, 'then', tr, t, [...holder, 0], holder)
                attach = { src: cond, slot: 'else', key: [...holder, 1] }
            } else {
                // Untriggered: always taken; the rest of the chain is unreachable.
                // A referenced chart's transitions are effectless in KIELER (their take marks are not KIELER effects):
                // Surface/Depth's superfluous immediate transition optimisation merges such a state into its target.
                const silent = silentTake(tr)
                if (!first && (!tr.effects.length || silent)) {
                    const hops = this.silentHops.length
                    if (silent) for (const e of tr.effects) if (e.k === 'mark' && e.m.kind === 'take') this.silentHops.push(e.m.key ?? e.m.transition)
                    // The state has no node of its own: it is its target's node.
                    this.silentMerging.add(s)
                    const target = this.stateNode(tr.target, t)
                    this.silentMerging.delete(s)
                    // In a silent cycle the region stays in the state it entered (the tracker follows no hop).
                    if (!target && this.silentCycle.has(s)) this.silentHops.length = hops
                    this.resolving.delete(s)
                    if (!this.stateNodes.has(s) && target) this.stateNodes.set(s, target)
                    const final = this.finalOf.get(tr.target)
                    if (final && target?.kind === 'exit') this.finalOf.set(s, final)
                    return target
                }
                const head = this.chainHead(tr, t, holder, register)
                if (attach) this.link(attach.src, attach.slot, head.node, attach.key, head.target)
                else register(head.node)
                if (item.surface) surfaceFirst.push(head.node!)
                ended = true
                break
            }
        }
        if (!ended && attach && pause) this.link(attach.src, attach.slot, pause, attach.key)
        this.resolving.delete(s)
        return first
    }

    /**
     * The outgoing transitions KIELER's DTO sees on state `k` while it transforms `s`: those of the chart if Surface/Depth
     * has not transformed `k` yet (it comes later in pre-order) or leaves it alone; undefined if it rewrote `k` (its
     * other transitions then lead into Surface/Depth's own states, which no transition of `s` targets).
     */
    private untransformedOut(k: CState, s: CState): CTransition[] | undefined {
        if ((this.pre.get(k) ?? 0) > (this.pre.get(s) ?? 0)) return k.out
        if (k.root || (k.out.length === 0 && k.final)) return k.out
        if (k.out.length === 0) return controlflowRegionsContainStates(k) && !regionsMayTerminate(k) ? k.out : undefined
        const t0 = k.out[0]
        if (k.out.length === 1 && t0.preemption === 'termination') return k.out
        const imm0 = isImplicitlyImmediate(t0)
        if (k.out.length === 1 && t0.trigger === undefined && imm0 === this.keepsEffects(t0)) return k.out
        if (k.out.length > 1 && conditionalPattern(this, t0, k.out[1])) return k.out.slice(0, 2)
        return undefined
    }

    /**
     * The nodes of a transition, linked from `src`: one assignment per effect (Trigger/Effect), then the target
     * state's first node. `holder` is the state that keeps the transition's effects when Trigger/Effect does not
     * move them.
     */
    chainFrom(src: SNode, slot: Slot, tr: CTransition, t: Thread, key: Key, holder: Key) {
        const head = this.chainHead(tr, t, holder, undefined, (n) => this.link(src, slot, n, key))
        if (head.attached) return
        this.link(src, slot, head.node, key, head.target)
    }

    /**
     * Builds the transition's chain and returns its first node (`target`: the state it is, when the transition has
     * no effects). `onFirst` hears about the first effect node before the target is built, so recursion through
     * the target finds the state resolved; `attachFirst` links it (then `attached` is true).
     */
    private chainHead(tr: CTransition, t: Thread, holder: Key, onFirst?: (n: SNode) => void, attachFirst?: (n: SNode) => void): { node: SNode | undefined; target?: CState; attached?: boolean } {
        if (!tr.effects.length) return { node: this.stateNode(tr.target, t), target: tr.target }
        const split = this.te.get(tr)
        if (split) {
            const shared = this.teChains.get(tr)
            if (shared) {
                onFirst?.(shared)
                attachFirst?.(shared)
                return { node: shared, attached: !!attachFirst }
            }
        }
        let first: SNode | undefined
        let last: SNode | undefined
        let lastKey: Key = holder
        tr.effects.forEach((effect, i) => {
            const own = split ? split.slice(i).find(k => k !== undefined) ?? holder : holder
            const n = this.node('assign', t, { state: tr.source, transition: tr, effect }, [...own, 0])
            if (last) this.link(last, 'next', n, lastKey)
            if (!first) {
                first = n
                if (split) this.teChains.set(tr, n)
                onFirst?.(n)
                attachFirst?.(n)
            }
            last = n
            if (weightOf(effect, this.ttsCount) > 0) lastKey = split ? [...(split[i] ?? holder), 0] : [...holder, 0]
        })
        this.link(last!, 'next', this.stateNode(tr.target, t), lastKey, tr.target)
        return { node: first, attached: !!attachFirst }
    }

    /** Converts the creation keys to ranks (the order of every node's incoming control flows in KIELER). */
    finish(): number {
        const all: { key: Key; set: (seq: number) => void }[] = []
        for (const [n, k] of this.keys) {
            const seq: FlowSeq = (n.seq = {})
            for (const slot of ['next', 'then', 'else'] as const) {
                const key = k[slot]
                if (key) all.push({ key, set: v => { seq[slot] = v } })
            }
            if (k.threads) {
                seq.threads = []
                k.threads.forEach((key, i) => all.push({ key, set: v => { seq.threads![i] = v } }))
            }
        }
        all.sort((a, b) => compareKeys(a.key, b.key))
        all.forEach((x, i) => x.set(i))
        const order = [...this.nodes].sort((a, b) => compareKeys(this.genKeys.get(a) ?? [], this.genKeys.get(b) ?? []))
        order.forEach((n, i) => { n.gen = i })
        // Threads in KIELER's node order (entries are created region by region).
        const ranked = [...this.threads].sort((a, b) => compareKeys(a.region ? this.rpos.get(a.region) ?? [] : [], b.region ? this.rpos.get(b.region) ?? [] : []))
        ranked.forEach((th, i) => { th.rank = i })
        return all.length
    }
}

/** A referenced chart's transition with no KIELER effects: only its take mark (index -1, not counted, scg.ts weightOf). */
function silentTake(t: CTransition): boolean {
    return t.effects.length > 0 && t.effects.every(e => e.k === 'mark' && e.m.kind === 'take' && e.m.index < 0)
}

/** After Trigger/Effect: does the transition keep its effects (immediate, untriggered, not a termination, one effect)? */
function effectless(b: Builder, t: CTransition): boolean {
    return !b.keepsEffects(t)
}

/** SurfaceDepth's "conditional" shape: an immediate triggered transition, then an immediate default, both without effects. */
function conditionalPattern(b: Builder, t0: CTransition, t1: CTransition): boolean {
    return isImplicitlyImmediate(t0) && t0.trigger !== undefined && effectless(b, t0) &&
        isImplicitlyImmediate(t1) && t1.trigger === undefined && effectless(b, t1)
}

/** `ttsCount`: the number of transitions Taken Transition Signaling counts (its reset is one effect each). */
export function buildSCG(root: CState, ttsCount = 1): SCG {
    const b = new Builder(root, ttsCount)
    // Surface/Depth runs on every state (reachable or not) and recognises an already normalised conditional
    // (an immediate triggered transition, then an immediate default): it deletes the transitions after the second
    // by index while the list shrinks, so with four or more transitions KIELER throws (SurfaceDepth.xtend).
    for (const s of allStates(root)) {
        if (s.root || controlflowRegionsContainStates(s) || s.out.length < 4) continue
        if (conditionalPattern(b, s.out[0], s.out[1])) {
            b.problems.push({
                message: 'conditional-pattern', states: [s],
                kieler: 'org.eclipse.emf.common.util.BasicEList$BasicIndexOutOfBoundsException: index=3, size=3 (SurfaceDepth)',
            })
            break
        }
    }
    const rootThread = b.thread(undefined, undefined, undefined)
    const first = b.stateNode(root, rootThread)
    rootThread.entry.next = first
    // KIELER's netlist gives a conditional whose two branches lead to the same node the condition on both paths
    // (the guard becomes `(g && c) || (g && c)`): the else branch never passes control. This arises when a
    // generated state has a triggered and an untriggered transition to the same target without effects (the
    // watcher region of a superstate with several delayed strong aborts, the last without trigger).
    // Marks that are no KIELER effects (a referenced chart's transitions carry such take marks) are no nodes there.
    const silent = (x: SNode | undefined): x is SNode => x?.kind === 'assign' && x.effect?.k === 'mark' && weightOf(x.effect, ttsCount) === 0 && x.next !== undefined
    const through = (x: SNode | undefined) => {
        const seen = new Set<SNode>()
        while (silent(x) && !seen.has(x)) {
            seen.add(x)
            x = x.next
        }
        return x
    }
    for (const n of b.nodes) {
        if (n.kind !== 'cond' || n.then === undefined || n.else === undefined) continue
        const target = through(n.then)
        if (target !== through(n.else)) continue
        n.else = undefined
        n.sameElse = true
        if (target !== n.then) n.sameTarget = target
        b.problems.push({ message: 'same-branches', states: n.state ? [n.state] : [] })
    }
    const count = b.finish()
    // The root entry's flow is created last.
    rootThread.entry.seq = { next: count }
    return { nodes: b.nodes, threads: b.threads, root: rootThread, stateNodes: b.stateNodes, problems: b.problems, seq: count + 1, silentHops: b.silentHops }
}

/** Successors of a node within a tick (a surface ends the tick; its depth is reached in the next one). */
export function successors(n: SNode): SNode[] {
    switch (n.kind) {
        case 'cond': return [n.then, n.else].filter((x): x is SNode => x !== undefined)
        case 'fork': return n.threads!.map(t => t.entry)
        case 'surface': return []
        default: return n.next ? [n.next] : []
    }
}

/** Successors including the surface -> depth step (for reachability). */
export function allSuccessors(n: SNode): SNode[] {
    return n.kind === 'surface' ? [n.depth!] : successors(n)
}

/**
 * Control-flow predecessors in the order of KIELER's incoming control flows (a depth has none from its surface).
 * Flows without a rank (should not happen) come last.
 */
export function predecessors(scg: SCG): Map<SNode, SNode[]> {
    const lists = new Map<SNode, { from: SNode; seq: number }[]>()
    const add = (from: SNode, to: SNode, seq: number | undefined) => {
        let l = lists.get(to)
        if (!l) lists.set(to, (l = []))
        l.push({ from, seq: seq ?? Infinity })
    }
    for (const n of scg.nodes) {
        const seq = n.seq
        switch (n.kind) {
            case 'cond':
                if (n.then) add(n, n.then, seq?.then)
                if (n.else) add(n, n.else, seq?.else)
                break
            case 'fork':
                n.threads!.forEach((t, i) => add(n, t.entry, seq?.threads?.[i]))
                break
            case 'surface':
                break
            default:
                if (n.next) add(n, n.next, seq?.next)
        }
    }
    const m = new Map<SNode, SNode[]>()
    for (const [to, l] of lists) {
        if (l.length > 1) l.sort((a, b) => a.seq - b.seq)
        m.set(to, l.map(x => x.from))
    }
    return m
}

/**
 * A copy of the graph (nodes, threads, state mapping) that analyses can change independently; `map` takes an
 * original node to its copy.
 */
export function cloneSCG(scg: SCG): { scg: SCG; map: Map<SNode, SNode> } {
    const map = new Map<SNode, SNode>()
    const tmap = new Map<Thread, Thread>()
    for (const n of scg.nodes) map.set(n, { ...n, seq: n.seq ? { ...n.seq, threads: n.seq.threads ? [...n.seq.threads] : undefined } : undefined })
    for (const t of scg.threads) tmap.set(t, { ...t })
    const m = (n: SNode | undefined) => (n ? map.get(n) ?? n : n)
    const mt = (t: Thread | undefined) => (t ? tmap.get(t) ?? t : t)
    for (const c of map.values()) {
        c.thread = mt(c.thread)!
        c.next = m(c.next)
        c.then = m(c.then)
        c.else = m(c.else)
        c.join = m(c.join)
        c.fork = m(c.fork)
        c.depth = m(c.depth)
        c.surface = m(c.surface)
        c.schizo = m(c.schizo)
        c.copyOf = m(c.copyOf)
        c.sameTarget = m(c.sameTarget)
        if (c.threads) c.threads = c.threads.map(t => mt(t)!)
    }
    for (const c of tmap.values()) {
        c.entry = m(c.entry)!
        c.exit = m(c.exit)!
        c.fork = m(c.fork)
        c.parent = mt(c.parent)
    }
    const stateNodes = new Map<CState, SNode>()
    for (const [st, n] of scg.stateNodes) stateNodes.set(st, m(n)!)
    return {
        scg: { nodes: scg.nodes.map(n => map.get(n)!), threads: scg.threads.map(t => tmap.get(t)!), root: tmap.get(scg.root)!, stateNodes, problems: scg.problems, seq: scg.seq, silentHops: scg.silentHops },
        map,
    }
}

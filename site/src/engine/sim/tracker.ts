// The source-level configuration: which states of the chart as written are active. The executor runs KIELER's
// rewritten chart; every source transition carries a `take` mark there, and when one fires this tracker leaves
// its source state (with everything active inside, innermost first) and enters its target (with the initial
// states of its regions, recursively). That gives TickResult.active, entered and exited in source terms,
// whatever the passes did to the structure.

import type { Region, State, Transition } from '../types'

interface StateInfo {
    state: State
    parent?: RegionInfo
}

interface RegionInfo {
    region: Region
    parent: StateInfo
    initial?: State
}

export interface TrackerSnapshot {
    active: Map<string, string>
    history: Map<string, string>
    pending?: Map<string, 'shallow' | 'deep' | undefined>
}

/** How a preemption pass refines a take (exec.ts passes the take mark's fields, model.ts `Mark`). */
export interface TakeOptions {
    /** The history KIELER applies (it ignores nested history keywords, preemption.md P-51). */
    history?: 'reset' | 'shallow' | 'deep'
    /** The target is entered now, its regions one tick later (deferred entry, P-54 a). */
    deferEntry?: boolean
    /** KIELER's history record of a source region: the state a history entry resumes there (passes/history.ts). */
    record?: (regionId: string) => string | undefined
}

export class Tracker {
    private readonly states = new Map<string, StateInfo>()
    private readonly regions = new Map<string, RegionInfo>()
    private readonly transitions = new Map<string, Transition>()
    /** Active state per region id. */
    private active = new Map<string, string>()
    /** Last active state per region id (for history transitions). */
    private history = new Map<string, string>()
    /** States entered by a deferred transition whose regions are entered in the next tick (with this history). */
    private pending = new Map<string, 'shallow' | 'deep' | undefined>()
    entered: string[] = []
    exited: string[] = []
    /** The states entered in this tick by their internal ids (a for-region copy's carry the copy key, structure/track.ts). */
    enteredInternal: string[] = []
    /** Transitions taken as soon as their source is entered (scg.ts silentHops: KIELER merged the source away). */
    autoTake = new Set<string>()

    /**
     * `report`: the id a state is reported by (structure/track.ts: a for-region copy's states have internal ids
     * with a copy key; they are reported, and drawn, as the source state).
     */
    constructor(private readonly root: State, private readonly report: (id: string) => string = id => id) {
        const visit = (s: State, parent?: RegionInfo) => {
            const info: StateInfo = { state: s, parent }
            this.states.set(s.id, info)
            for (const t of s.transitions) this.transitions.set(t.id, t)
            for (const r of s.regions) {
                if (r.regionType === 'dataflow') continue
                const ri: RegionInfo = { region: r, parent: info, initial: r.states.find(x => x.initial) }
                this.regions.set(r.id, ri)
                for (const c of r.states) visit(c, ri)
            }
        }
        visit(root)
    }

    snapshot(): TrackerSnapshot {
        return { active: new Map(this.active), history: new Map(this.history), pending: new Map(this.pending) }
    }

    restore(s: TrackerSnapshot) {
        this.active = new Map(s.active)
        this.history = new Map(s.history)
        this.pending = new Map(s.pending ?? [])
    }

    reset() {
        this.active.clear()
        this.history.clear()
        this.pending.clear()
    }

    beginTick() {
        this.entered = []
        this.exited = []
        this.enteredInternal = []
    }

    /** Tick 1: the root and its initial states are entered. */
    start(): string[] {
        const before = this.entered.length
        this.entered.push(this.root.id)
        this.enteredInternal.push(this.root.id)
        this.enterRegions(this.root, undefined)
        this.settle()
        return this.entered.slice(before)
    }

    /** A source transition fired: returns the exited and entered states (in order). */
    take(id: string, options: TakeOptions = {}): { exited: string[]; entered: string[] } {
        const t = this.transitions.get(id)
        const e0 = this.entered.length
        const x0 = this.exited.length
        if (!t) return { exited: [], entered: [] }
        const source = this.states.get(t.source)
        const target = t.target ? this.states.get(t.target) : undefined
        const history = options.history ?? t.history
        if (source) this.exitState(source)
        if (target && options.deferEntry) {
            // Deferred entry one tick late: the state now, its regions when enterRegionsOf() is called.
            this.entered.push(this.report(target.state.id))
            this.enteredInternal.push(target.state.id)
            if (target.parent) this.active.set(target.parent.region.id, target.state.id)
            this.pending.set(target.state.id, history === 'shallow' || history === 'deep' ? history : undefined)
        } else if (target) {
            this.enterState(target, history, false, options.record)
        }
        this.settle()
        return { exited: this.exited.slice(x0), entered: this.entered.slice(e0) }
    }

    /** The second tick of a deferred entry (passes/deferred.ts): the state's regions are entered now. */
    enterRegionsOf(id: string, record?: TakeOptions['record']): string[] {
        const info = this.states.get(id)
        const e0 = this.entered.length
        if (!info || !this.pending.has(id)) return []
        const history = this.pending.get(id)
        this.pending.delete(id)
        if (info.parent && this.active.get(info.parent.region.id) !== id) return []
        this.enterRegions(info.state, history, record)
        this.settle()
        return this.entered.slice(e0)
    }

    /** Follows the transitions KIELER merged away (autoTake) out of the active states. */
    private settle() {
        if (!this.autoTake.size) return
        for (let guard = 0; guard < 100; guard++) {
            let moved = false
            for (const id of this.autoTake) {
                const t = this.transitions.get(id)
                const source = t ? this.states.get(t.source) : undefined
                if (!t || !source?.parent || this.active.get(source.parent.region.id) !== source.state.id) continue
                const target = t.target ? this.states.get(t.target) : undefined
                if (!target || target === source) continue
                this.exitState(source)
                this.enterState(target)
                moved = true
            }
            if (!moved) return
        }
    }

    /**
     * Weak suspend's way back (passes/weakSuspend.ts, P-46): `id` is the active state of its region again, quietly
     * (no entry actions); what the region moved on to in this tick is left, and the state's own regions are as they
     * were. Returns the states that were left, or undefined if the region was in `id` all along.
     */
    resume(id: string): string[] | undefined {
        const info = this.states.get(id)
        if (!info?.parent) return undefined
        const region = info.parent.region.id
        const current = this.active.get(region)
        if (current === id) return undefined
        const x0 = this.exited.length
        const ci = current !== undefined ? this.states.get(current) : undefined
        if (ci) this.exitState(ci)
        this.active.set(region, id)
        const restore = (s: State) => {
            for (const r of s.regions) {
                const ri = this.regions.get(r.id)
                if (!ri || this.active.has(r.id)) continue
                const remembered = this.history.get(r.id)
                const next = (remembered ? this.states.get(remembered)?.state : undefined) ?? ri.initial
                if (!next) continue
                this.active.set(r.id, next.id)
                restore(next)
            }
        }
        restore(info.state)
        return this.exited.slice(x0)
    }

    /**
     * A state's regions stop (the par-or join of a state with abort regions fired, preemption.md P-62): every state
     * inside it is left, the state itself stays active. Returns the states that were left.
     */
    stopRegions(id: string): string[] {
        const info = this.states.get(id)
        if (!info) return []
        const x0 = this.exited.length
        for (const r of info.state.regions) {
            const current = this.active.get(r.id)
            if (current === undefined) continue
            const ci = this.states.get(current)
            if (ci) this.exitState(ci)
            this.history.set(r.id, current)
        }
        return this.exited.slice(x0)
    }

    private exitState(info: StateInfo) {
        for (const r of info.state.regions) {
            const ri = this.regions.get(r.id)
            if (!ri) continue
            const current = this.active.get(r.id)
            if (current !== undefined) {
                const ci = this.states.get(current)
                if (ci) this.exitState(ci)
                this.history.set(r.id, current)
            }
        }
        this.exited.push(this.report(info.state.id))
        this.pending.delete(info.state.id)
        if (info.parent) {
            if (this.active.get(info.parent.region.id) === info.state.id) this.active.delete(info.parent.region.id)
        }
    }

    private enterState(info: StateInfo, history?: Transition['history'], deep = false, record?: TakeOptions['record']) {
        this.entered.push(this.report(info.state.id))
        this.enteredInternal.push(info.state.id)
        if (info.parent) this.active.set(info.parent.region.id, info.state.id)
        this.enterRegions(info.state, history === 'shallow' || history === 'deep' ? history : deep ? 'deep' : undefined, record)
    }

    private enterRegions(s: State, history: 'shallow' | 'deep' | undefined, record?: TakeOptions['record']) {
        for (const r of s.regions) {
            const ri = this.regions.get(r.id)
            if (!ri) continue
            // KIELER's record where the History pass made one (it is what KIELER resumes), else the last active state.
            const remembered = history ? record?.(r.id) ?? this.history.get(r.id) : undefined
            const next = remembered ? this.states.get(remembered)?.state : ri.initial
            if (!next) continue
            const ni = this.states.get(next.id)!
            this.enterState(ni, undefined, history === 'deep' && remembered !== undefined, record)
        }
    }

    /** Ids of the active states, root first, each state before its children. */
    activeStates(): string[] {
        return [...new Set(this.activeInternal().map(this.report))]
    }

    /** The active states by their internal ids (a for-region copy's carry the copy key), root first. */
    activeInternal(): string[] {
        const out: string[] = [this.root.id]
        const visit = (s: State) => {
            for (const r of s.regions) {
                const current = this.active.get(r.id)
                if (current === undefined) continue
                out.push(current)
                const ci = this.states.get(current)
                if (ci) visit(ci.state)
            }
        }
        visit(this.root)
        return out
    }

    /** The state a source region was in when it was last left (for history notes). */
    lastActive(regionId: string): string | undefined {
        const id = this.history.get(regionId)
        return id === undefined ? undefined : this.report(id)
    }

    /** The active state of a source region (for "pause" log lines). */
    activeIn(regionId: string): string | undefined {
        return this.active.get(regionId)
    }

    regionOf(stateId: string): string | undefined {
        return this.states.get(stateId)?.parent?.region.id
    }
}

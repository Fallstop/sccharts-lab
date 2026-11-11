// The preemption passes' part of a tick's log (exec.ts calls these): how a take moves the source-level
// configuration when KIELER applies history differently from what is written (P-51) or enters a state one tick
// late (deferred, P-54), weak suspend's way back (P-46), and which states were (weakly) suspended in the tick.
// Every event is in source terms; notes are plain-English sentences that describeTick passes on.

import type { State, TraceEvent, TraceSeen, Transition } from '../types'
import type { CVar, Mark } from './model'
import type { SuspendInfo } from './passes/suspend'
import type { HistoryRecord } from './passes/history'
import type { TakeOptions, Tracker } from './tracker'
import { seenText } from './reasons'

type TakeMark = Extract<Mark, { kind: 'take' }>
export type HookMark = Extract<Mark, { kind: 'enterRegions' | 'resume' }>

/** What the tracker needs from a take mark (undefined: a plain take). */
export function takeOptions(m: TakeMark): TakeOptions | undefined {
    if (m.history === undefined && !m.deferEntry) return undefined
    return { history: m.history, deferEntry: m.deferEntry }
}

export function isHook(m: Mark): m is HookMark {
    return m.kind === 'enterRegions' || m.kind === 'resume'
}

/** Source states by id, for the sentences. */
export class StateNames {
    private readonly states = new Map<string, State>()
    private readonly parents = new Map<string, State>()
    private readonly transitions = new Map<string, Transition>()
    constructor(root: State) {
        const visit = (s: State) => {
            this.states.set(s.id, s)
            for (const t of s.transitions) this.transitions.set(t.id, t)
            for (const r of s.regions) for (const c of r.states) {
                this.parents.set(c.id, s)
                visit(c)
            }
        }
        visit(root)
    }
    name(id: string): string {
        const s = this.states.get(id)
        return s ? s.label ?? s.name : id
    }
    state(id: string): State | undefined {
        return this.states.get(id)
    }
    parent(id: string): State | undefined {
        return this.parents.get(id)
    }
    transition(id: string): Transition | undefined {
        return this.transitions.get(id)
    }
}

const list = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/** A note in plain text and in Markdown: `build` gets how to write a name (as it is, or as code). */
export function note(related: string[], build: (c: (name: string) => string) => string): Extract<TraceEvent, { kind: 'note' }> {
    return { kind: 'note', related, text: build(n => n), markdown: build(n => '`' + n.replace(/`/g, "'") + '`') }
}

/** Notes after a take with refined options: the history KIELER applied, a deferred entry. */
export function takeNotes(transition: string, options: TakeOptions, entered: string[], names: StateNames, tracker?: Tracker): TraceEvent[] {
    const out: TraceEvent[] = []
    const tr = names.transition(transition)
    const target = tr?.target
    const written = tr?.history
    if (!target) return out
    const name = names.name(target)
    if (options.deferEntry) {
        out.push(note([transition, target], c => `${c(name)} is entered quietly (deferred): nothing of ${c(name)} runs in this tick, not even its entry actions, and its inner states start in the next tick.`))
    }
    if (written === 'shallow' || written === 'deep') {
        if (options.history === 'reset' && names.state(target)?.regions.some(r => r.states.length > 0)) {
            out.push(note([transition, target], c => `KIELER ignores this ${written === 'shallow' ? 'shallow history' : 'history'}: ${c(name)} is nested in a state that is not itself the target of a history transition, so it restarts from its initial state${entered.length > 2 ? 's' : ''}.`))
        } else if (!options.deferEntry) {
            const inner = entered.filter(id => id !== target)
            // KIELER records a state when it is entered; a deferred entry does not record it (Deferred drops the entry action).
            const unrecorded = inner.filter(id => {
                const region = tracker?.regionOf(id)
                const last = region ? tracker?.lastActive(region) : undefined
                return last !== undefined && last !== id
            })
            if (inner.length) out.push(note([transition, target, ...inner], c => `${c(name)} resumes with its ${written === 'shallow' ? 'shallow history: its own regions continue' : 'history: it continues'} in ${list(inner.map(id => c(names.name(id))))}, ${unrecorded.length
                ? `the last state${inner.length > 1 ? 's' : ''} KIELER recorded: a state entered by a deferred transition is not recorded, because KIELER removes the entry actions of such a state, including the one that records it`
                : `the state${inner.length > 1 ? 's' : ''} it was in when it was left`}.`))
        }
    }
    return out
}

/** Reads KIELER's history records (passes/history.ts) for the tracker: the state a region's record resumes. */
export function historyRecordReader(records: Map<string, HistoryRecord> | undefined, value: (v: CVar) => number): TakeOptions['record'] {
    if (!records?.size) return undefined
    return regionId => {
        const r = records.get(regionId)
        return r ? r.states[value(r.v)] : undefined
    }
}

/** Applies a tracker hook and returns its events. */
export function hookEvents(m: HookMark, tracker: Tracker, names: StateNames, record?: TakeOptions['record']): TraceEvent[] {
    const out: TraceEvent[] = []
    if (m.kind === 'enterRegions') {
        const entered = tracker.enterRegionsOf(m.state, record)
        for (const id of entered) out.push({ kind: 'enter', state: id })
        if (entered.length) out.push(note([m.state, ...entered], c => `One tick after its deferred entry, ${c(names.name(m.state))} starts: ${list(entered.map(id => c(names.name(id))))} ${entered.length > 1 ? 'are' : 'is'} entered now.`))
        return out
    }
    const exited = tracker.resume(m.state)
    if (!exited) return out
    for (const id of exited) out.push({ kind: 'exit', state: id })
    const left = exited.filter(id => names.parent(id)?.id === names.parent(m.state)?.id)
    out.push(note([m.state, m.suspended, ...left], c => `${c(names.name(m.suspended))} is weakly suspended, so ${left.length ? `what happened in its region is undone: ${list(left.map(id => c(names.name(id))))} ${left.length > 1 ? 'are' : 'is'} forgotten and ` : ''}control goes back to ${c(names.name(m.state))}, quietly (no entry actions).`))
    return out
}

/**
 * The (weakly) suspended states of the tick, from their flags after the tick (`value(flag)`: its value; `seen(flag)`:
 * what the suspend triggers read when the flag was computed).
 */
export function suspendEvents(suspends: SuspendInfo[] | undefined, active: Set<string>, value: (v: CVar) => boolean, names: StateNames, seen?: (v: CVar) => TraceSeen[] | undefined): TraceEvent[] {
    const out: TraceEvent[] = []
    for (const s of suspends ?? []) {
        if (!active.has(s.state)) continue
        const flag = value(s.flag)
        if (!s.weak && !flag) {
            const read = seen?.(s.flag)
            out.push(read?.length ? { kind: 'suspend', state: s.state, reason: seenText(read), seen: read } : { kind: 'suspend', state: s.state })
        } else if (s.weak && flag) {
            out.push(note([s.state], c => `${c(names.name(s.state))} is weakly suspended in this tick: its inside reacts, but at the end of the tick every region inside it goes back to the state it was in after the last tick without weak suspension.`))
        }
    }
    return out
}

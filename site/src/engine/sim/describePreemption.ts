// describeTick's sentences for preemption (describe.ts calls these): what a strong or weak abort meant for the
// inside of a superstate, count delays, suspended states, and the notes the executor logged for history,
// deferred entries and weak suspension (preemptionLog.ts).

import type { State, TickResult, TraceSeen, Transition } from '../types'
import { formatExpression, stateDisplayName } from '../format'
import { PLAIN, type Fmt } from './describeStructure'

export interface DescribeIndex {
    states: Map<string, State>
    parents: Map<string, State>
}

function ordinal(n: number): string {
    const tens = n % 100
    if (tens >= 11 && tens <= 13) return `${n}th`
    switch (n % 10) {
        case 1: return `${n}st`
        case 2: return `${n}nd`
        case 3: return `${n}rd`
        default: return `${n}th`
    }
}

const hasInside = (s: State | undefined) => !!s && s.regions.some(r => r.states.length > 0)

/** "held" for a trigger, or the count delay's "held for the 3rd time while S was active". */
export function heldPhrase(t: Transition, from: string): string {
    return t.triggerDelay !== undefined && t.triggerDelay > 1 ? `held for the ${ordinal(t.triggerDelay)} time while ${from} was active` : 'held'
}

/** A count delay's " for the 3rd time while S was active", or nothing. */
export function countPhrase(t: Transition, from: string): string {
    return t.triggerDelay !== undefined && t.triggerDelay > 1 ? ` for the ${ordinal(t.triggerDelay)} time while ${from} was active` : ''
}

/** For a waiting count delay: " (the 3rd time)". */
export function countSuffix(t: Transition): string {
    return t.triggerDelay !== undefined && t.triggerDelay > 1 ? ` (the ${ordinal(t.triggerDelay)} time)` : ''
}

/** What an abort of a superstate meant for its inside (appended to the transition's sentence). */
export function abortClause(t: Transition, idx: DescribeIndex, f: Fmt = PLAIN): string {
    const source = idx.states.get(t.source)
    if (!hasInside(source)) return ''
    const name = f.code(stateDisplayName(source!))
    if (t.preemption === 'strong') return `, so the inside of ${name} did not react in this tick (a strong abort)`
    if (t.preemption === 'weak') return `, after the inside of ${name} finished its reaction for this tick (a weak abort)`
    return ''
}

/** The states suspended in this tick: one sentence each. */
export function suspendSentences(result: TickResult, idx: DescribeIndex, f: Fmt = PLAIN): string[] {
    const out: string[] = []
    for (const e of result.log) {
        if (e.kind !== 'suspend') continue
        const s = idx.states.get(e.state)
        if (!s) continue
        const name = f.code(stateDisplayName(s))
        const triggers = s.actions.filter(a => a.kind === 'suspend' && !a.weak && a.trigger).map(a => a.trigger!)
        const text = triggers.map(x => f.code(formatExpression(x))).join(' or ')
        // What the triggers read when the suspension was decided (exec.ts), not after the tick.
        const why = f.md && e.seen?.length ? seenPhrase(e.seen, f) : e.reason ?? ''
        out.push(`${name} is suspended${text ? ` because ${text} holds${why ? ` (${why})` : ''}` : ''}: nothing inside ${name} moves in this tick and its own transitions wait too.`)
    }
    return out
}

/** The executor's plain-English notes (history, deferred entries, weak suspension, KIELER's GO block). */
export function noteSentences(result: TickResult, f: Fmt = PLAIN): string[] {
    const out: string[] = []
    for (const e of result.log) {
        if (e.kind !== 'note') continue
        const text = f.md ? e.markdown ?? e.text : e.text
        if (!out.includes(text)) out.push(text)
    }
    return out
}

/** What a trigger read, "n was 0 and S was present", with names and values as code in Markdown (reasons.ts seenText). */
export function seenPhrase(seen: TraceSeen[], f: Fmt = PLAIN): string {
    const show = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? `{${v.map(show).join(', ')}}` : typeof v === 'string' ? JSON.stringify(v) : String(v))
    const parts = seen.map(s => (s.signal ? `${f.code(s.name)} was ${s.value ? 'present' : 'absent'}` : `${f.code(s.name)} was ${f.code(show(s.value))}`))
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Is the state (or an ancestor) suspended in this tick? Its transitions are not waiting for their triggers then. */
export function suspendedHere(stateId: string, result: TickResult, idx: DescribeIndex): boolean {
    const suspended = new Set(result.log.flatMap(e => (e.kind === 'suspend' ? [e.state] : [])))
    if (!suspended.size) return false
    for (let s: State | undefined = idx.states.get(stateId); s; s = idx.parents.get(s.id)) if (suspended.has(s.id)) return true
    return false
}

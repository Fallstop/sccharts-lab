// describeTick's view of references and for-regions (structure.md): a referenced chart's states and transitions are
// reported as `<reference state>/<id in the referenced chart>` (dataflow and `ref` instances:
// `<declaration>/<id>`), and a transition of a for-region copy is followed in the log by a note naming the copy.

import type { Program, ScopeCall, State, TickResult, TraceEvent, Transition } from '../types'
import { formatExpression, stateDisplayName } from '../format'
import { REFERENCE_SEPARATOR } from './structure/instance'
import { FOR_COPY_NOTE } from './passes/forRegion'

interface Index {
    states: Map<string, State>
    transitions: Map<string, Transition>
}

/** How describeTick writes names: as they are, or (Markdown) as code. */
export interface Fmt {
    md: boolean
    code(s: string): string
}

export const PLAIN: Fmt = { md: false, code: s => s }
export const MARKDOWN: Fmt = { md: true, code: s => '`' + s.replace(/`/g, "'") + '`' }

/** Splits an instance element's id at its innermost reference: the instance prefix and the id in the referenced chart. */
function split(id: string): { prefix: string; inner: string } | undefined {
    const i = id.lastIndexOf(REFERENCE_SEPARATOR)
    return i < 0 ? undefined : { prefix: id.slice(0, i), inner: id.slice(i + 1) }
}

/** The name of a reference state or `ref` declaration an instance prefix stands for. */
function instanceName(prefix: string, idx: Index): string {
    const d = prefix.lastIndexOf('$')
    if (d >= 0 && !prefix.slice(d).includes('.')) return prefix.slice(d + 1)
    const s = resolveState(prefix, idx)
    return s ? stateDisplayName(s) : prefix
}

/** The source state an id stands for, also inside instances. */
export function resolveState(id: string, idx: Index): State | undefined {
    const s = idx.states.get(id)
    if (s) return s
    const parts = split(id)
    return parts ? idx.states.get(parts.inner) : undefined
}

/** One reference an element is inside of: the reference state's (or `ref` declaration's) name and the chart. */
export interface InstanceInfo {
    name: string
    chart: string
    /** The referenced chart's inputs and outputs bound to another name: formal -> the actual as written. */
    bindings: Map<string, string>
}

/** Where an element of an instance is: the references it is inside of (innermost first), or a base chart. */
export interface Within {
    instances: InstanceInfo[]
    /** Inherited from this chart (passes/inheritance.ts prefixes the inheriting state). */
    inherited?: string
}

/** The formals of a chart (its inputs and outputs, in order) bound by a reference's arguments (KIELER's pointer). */
function bindingsOf(call: ScopeCall | undefined, chart: State | undefined): Map<string, string> {
    const out = new Map<string, string>()
    if (!call || !chart) return out
    const formals = chart.declarations.filter(d => d.declKind === 'variable' && (d.input || d.output)).flatMap(d => d.valuedObjects.map(v => v.name))
    let ptr = 0
    for (const p of call.parameters) {
        if (p.binding !== undefined) {
            const i = formals.indexOf(p.binding)
            if (i < 0) continue
            ptr = i
        }
        if (ptr >= formals.length) continue
        const actual = formatExpression(p.expression)
        if (actual !== formals[ptr]) out.set(formals[ptr], actual)
        ptr++
    }
    return out
}

/** The references an instance element's id is inside of, innermost first. */
function withinOf(id: string, idx: Index & { charts?: Map<string, State> }): Within | undefined {
    const parts = split(id)
    if (!parts) return undefined
    const chart = parts.inner.split(/[.:!$-]/)[0]
    // Inherited regions (passes/inheritance.ts) are prefixed with the inheriting state, `super` copies with `<it>/super`.
    if (parts.prefix.endsWith(`${REFERENCE_SEPARATOR}super`) || idx.states.get(parts.prefix)?.isRoot) return { instances: [], inherited: chart }
    const instances: InstanceInfo[] = []
    let prefix: string | undefined = parts.prefix
    let inner = chart
    while (prefix !== undefined) {
        const state = resolveState(prefix, idx)
        instances.push({ name: instanceName(prefix, idx), chart: inner, bindings: bindingsOf(state?.reference, idx.charts?.get(inner)) })
        const up = split(prefix)
        if (!up) break
        inner = up.inner.split(/[.:!$-]/)[0]
        prefix = up.prefix
    }
    return { instances }
}

/**
 * "Inside `Left` (a copy of `PushSwitch`, with `press` bound to `left`)", innermost reference first; `read` are the
 * names the sentence mentions (bindings of other formals are left out).
 */
export function withinPhrase(w: Within, f: Fmt, read: string[] = []): string {
    if (w.inherited) return `In the part inherited from ${f.code(w.inherited)}`
    return w.instances.map((x, i) => {
        const bound = read.filter(n => x.bindings.has(n)).map(n => `${f.code(n)} bound to ${f.code(x.bindings.get(n)!)}`)
        return `${i === 0 ? 'Inside' : 'inside'} ${f.code(x.name)} (a copy of ${f.code(x.chart)}${i === 0 && bound.length ? `, with ${list(bound)}` : ''})`
    }).join(' ')
}

/** The source transition an id stands for, and where it is when it belongs to a referenced chart's copy. */
export function resolveTransition(id: string, idx: Index): { t: Transition; within?: Within } | undefined {
    const t = idx.transitions.get(id)
    if (t) return { t }
    const parts = split(id)
    if (!parts) return undefined
    const inner = idx.transitions.get(parts.inner)
    if (!inner) return undefined
    return { t: inner, within: withinOf(id, idx) }
}

/** "`Off` (inside `Left`)": a state, and the copy it is in when it is in one. */
export function stateInCopy(id: string, idx: Index, f: Fmt): string | undefined {
    const s = resolveState(id, idx)
    if (!s) return undefined
    const w = withinOf(id, idx)
    const name = f.code(stateDisplayName(s))
    if (!w?.instances.length) return name
    return `${name} (inside ${w.instances.map(x => f.code(x.name)).join(' inside ')})`
}

/**
 * A readable name for any element id of a tick (states, transitions, regions, actions), also inside the copies of
 * referenced charts and for-region copies: `{ name: 'Off → On', within: 'inside Left (a copy of PushSwitch)' }`.
 * For "Explain this tick" and anything else that shows log events. Undefined for ids it does not know.
 */
export function elementName(id: string, idx: Index & { regions?: Map<string, { name?: string; parent: State }>; actions?: Map<string, { kind: string; owner: State }> }, f: Fmt = PLAIN): { name: string; within?: string } | undefined {
    const where = withinOf(id, idx)
    const within = where ? withinPhrase(where, f).replace(/^Inside/, 'inside').replace(/^In the part/, 'in the part') : undefined
    const t = resolveTransition(id, idx)
    if (t) {
        const src = resolveState(t.t.source, idx)
        const dst = t.t.target ? resolveState(t.t.target, idx) : undefined
        const name = `${f.code(src ? stateDisplayName(src) : t.t.source)} → ${f.code(dst ? stateDisplayName(dst) : t.t.targetName ?? '?')}`
        return within ? { name, within } : { name }
    }
    const inner = split(id)?.inner ?? id
    const s = idx.states.get(id) ?? idx.states.get(inner)
    if (s) {
        // A copy's root is the referenced chart itself: "PushSwitch inside Left".
        if (s.isRoot && where?.instances.length) return { name: f.code(s.name), within: `inside ${where.instances.map(x => f.code(x.name)).join(' inside ')}` }
        const name = f.code(stateDisplayName(s))
        return within ? { name, within } : { name }
    }
    const r = idx.regions?.get(id) ?? idx.regions?.get(inner)
    if (r) {
        const name = r.name ? `region ${f.code(r.name)} of ${f.code(stateDisplayName(r.parent))}` : `a region of ${f.code(stateDisplayName(r.parent))}`
        return within ? { name, within } : { name }
    }
    const a = idx.actions?.get(id) ?? idx.actions?.get(inner)
    if (a) {
        const name = `the ${a.kind} action of ${f.code(stateDisplayName(a.owner))}`
        return within ? { name, within } : { name }
    }
    return undefined
}

/** For each taken transition (in `result.taken` order), the for-region copy it fired in, as a phrase. */
export function copyPhrases(result: TickResult, f: Fmt = PLAIN): (string | undefined)[] {
    const out: (string | undefined)[] = []
    const log = result.log
    for (let i = 0; i < log.length; i++) {
        if (log[i].kind !== 'take') continue
        const notes: string[] = []
        for (let j = i + 1; j < log.length; j++) {
            const e = log[j]
            if (e.kind === 'note' && e.related?.[0] === FOR_COPY_NOTE) notes.push(f.md ? e.markdown ?? e.text : e.text)
            else if (e.kind !== 'exit' && e.kind !== 'enter') break
        }
        out.push(notes.length ? notes.join(' ') : undefined)
    }
    return out
}

/** The log without the copy notes (they are folded into the transitions' sentences). */
export function withoutCopyNotes(result: TickResult): TickResult {
    return { ...result, log: result.log.filter((e: TraceEvent) => !(e.kind === 'note' && e.related?.[0] === FOR_COPY_NOTE)) }
}

/** "`Off` (inside `Left`)" for the instances active in tick 1, as phrases for "The chart starts in ...". */
export function instanceLeaves(result: TickResult, idx: Index, f: Fmt = PLAIN): string[] {
    const out: string[] = []
    for (const id of result.active) {
        const parts = split(id)
        if (!parts) continue
        const s = idx.states.get(parts.inner)
        // (A reference state inside a copy is no leaf: its own copy's states are listed.)
        if (!s || s.isRoot || s.reference || s.regions.some(r => r.states.some(c => result.active.includes(`${parts.prefix}${REFERENCE_SEPARATOR}${c.id}`)))) continue
        out.push(stateInCopy(id, idx, f) ?? f.code(stateDisplayName(s)))
    }
    return out
}

export type { Program }

const dataflowCache = new WeakMap<Program, Set<string>>()

/** Ids of the dataflow regions of every chart of the program. */
function dataflowRegions(program: Program): Set<string> {
    const cached = dataflowCache.get(program)
    if (cached) return cached
    const out = new Set<string>()
    const visit = (s: State) => {
        for (const r of s.regions) {
            if (r.regionType === 'dataflow') out.add(r.id)
            r.states.forEach(visit)
        }
    }
    program.charts.forEach(visit)
    dataflowCache.set(program, out)
    return out
}

function show(v: unknown): string {
    if (Array.isArray(v)) return `{${v.map(show).join(', ')}}`
    if (typeof v === 'string') return JSON.stringify(v)
    return String(v)
}

function list(items: string[]): string {
    return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The period actions of the program by id, with their state (for "the period of S"). */
const periodCache = new WeakMap<Program, Map<string, { state: State; value?: number }>>()

function periods(program: Program): Map<string, { state: State; value?: number }> {
    const cached = periodCache.get(program)
    if (cached) return cached
    const out = new Map<string, { state: State; value?: number }>()
    const visit = (s: State) => {
        for (const a of s.actions) {
            if (a.kind !== 'period') continue
            const t = a.trigger
            out.set(a.id, { state: s, value: t && (t.kind === 'int' || t.kind === 'float') ? t.value : undefined })
        }
        for (const r of s.regions) r.states.forEach(visit)
    }
    program.charts.forEach(visit)
    periodCache.set(program, out)
    return out
}

/**
 * Sentences about clocks, periods and dataflow regions: "Time passed: the clock t advanced to 300 (deltaT = 100).",
 * "The dataflow equations computed O = true." `before` come before the transitions (time passes first), `after`
 * after them; `quiet` are the variables these sentences cover (left out of "x is now ...").
 */
export function structureSentences(result: TickResult, program: Program, f: Fmt = PLAIN): { before: string[]; after: string[]; quiet: Set<string>; dataflow: boolean } {
    const before: string[] = []
    const after: string[] = []
    const quiet = new Set<string>()
    const clocks: string[] = []
    let simulated: unknown
    const regions = dataflowRegions(program)
    const periodActions = periods(program)
    const computed = new Map<string, unknown>()
    const dt = result.inputs.deltaT
    for (const e of result.log) {
        if (e.kind !== 'write' || e.how !== 'update') continue
        const period = periodActions.get(e.by)
        if (period) {
            // The period's clock advances (passes/period.ts); the period elapses when it reaches the period.
            const name = f.code(stateDisplayName(period.state))
            const v = typeof e.value === 'number' ? e.value : undefined
            if (period.value !== undefined && v !== undefined) {
                before.push(v >= period.value
                    ? `The period of ${name} elapsed (${f.code(show(v))} of ${f.code(show(period.value))} time units), so ${name}'s inside reacts in this tick.`
                    : `The period of ${name} has not elapsed yet (${f.code(show(v))} of ${f.code(show(period.value))} time units): ${name}'s inside waits.`)
            }
            continue
        }
        // A clock's increment is written by its own declaration (`t += deltaT`, passes/timedAutomata.ts).
        if (e.by.endsWith(`$${e.variable}`)) {
            if (e.variable === 'deltaT') simulated = e.value
            else if (!clocks.includes(`${e.variable}:${e.value}`)) clocks.push(`${e.variable}:${e.value}`)
            quiet.add(e.variable)
        }
        if (regions.has(e.by)) computed.set(e.variable, e.value)
    }
    if (simulated !== undefined) before.unshift(`${f.code('@SimulateSleep')}: ${f.code('deltaT')} is the ${f.code('sleepT')} the chart asked for in the previous tick, ${f.code(show(simulated))}.`)
    if (clocks.length) {
        const parts = clocks.map(c => { const i = c.lastIndexOf(':'); return `${f.code(c.slice(0, i))} advanced to ${f.code(c.slice(i + 1))}` })
        before.push(`Time passed: ${clocks.length === 1 ? 'the clock' : 'the clocks'} ${list(parts)}${dt !== undefined && dt !== null ? ` (${f.code(`deltaT = ${show(dt)}`)})` : ''}.`)
    }
    if (computed.size) {
        after.push(`The dataflow equations computed ${list([...computed].map(([k, v]) => f.code(`${k} = ${show(v)}`)))}.`)
        for (const k of computed.keys()) quiet.add(k)
    }
    if ('sleepT' in result.values) {
        quiet.add('sleepT')
        after.push(`${f.code(`sleepT = ${show(result.values.sleepT)}`)}: how long the environment may wait before the next tick.`)
    }
    return { before, after, quiet, dataflow: regions.size > 0 }
}

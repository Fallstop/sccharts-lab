// The timing diagram of a simulation: which lanes to draw (inputs, outputs, chosen locals, one lane per
// region with its active state) and their values in each tick. Pure; renderWave draws the result.

import type { Region, State, TickResult, Value, VariableInfo } from '~engine/types'
// Types only: link.ts (a page script, before any island) imports this module, and must not pull in the engine.
import type { TraceableVariable } from '~engine/index'
import { labelWidthFor, renderWave, waveText, type SignalSample, type WaveRow, type WaveValue } from '../frame/wave'
import { formatValue } from './inputs'
import { stateName } from './lines'

export interface Lane {
    key: string
    name: string
    title?: string
    kind: WaveRow['kind']
    role: NonNullable<WaveRow['role']>
    /** A pure signal: the screen-reader table says present / absent. */
    presence?: boolean
    /** An array variable: `sample` gives it already written out (`{1, 2, 3}`). */
    array?: boolean
    sample: (t: TickResult) => WaveValue | SignalSample
    /** Region lanes: the active state's id. */
    ref?: (t: TickResult) => string | undefined
    /** Region lanes: the active state was entered in this tick (a new segment even for the same state). */
    entered?: (t: TickResult) => boolean
    /** Region lanes: length of the longest state name. */
    longest?: number
    /** Region lanes: the region is frozen by a `suspend` in this tick (drawn hatched). */
    suspended?: (t: TickResult) => boolean
}

/**
 * For-region copies (structure.md S-23). The engine reports a copy's states by the ids of the one region the diagram
 * draws; with `TickResult.copies` it also says, per copy, which of them are active and which were entered. `values`
 * are the counter's values, in KIELER's order of the copies.
 */
export interface ForCopies {
    region: string
    counter: string
    values: (number | string)[]
}
/** One copy in a tick (the engine's TickResult.copies). */
export interface CopyState {
    region: string
    value: number | string
    active: string[]
    entered: string[]
    /** The states left in this copy during the tick, should the engine report them (it does not yet: copyMarks works
     *  them out from the tick before). */
    exited?: string[]
}
/** The copies of a tick, when the engine reports them. */
export const copiesOf = (t: TickResult): CopyState[] | undefined => (t as TickResult & { copies?: CopyState[] }).copies

/** What a state of a for-region did in each of its copies in one tick: the counter's values of the copies it is
 *  active in, was entered in and was left in (`left` is undefined when that cannot be known: no tick before). */
export interface CopyMarks {
    /** The for-region's copies. */
    of: number
    counter?: string
    active: (number | string)[]
    entered: (number | string)[]
    left?: (number | string)[]
}

/**
 * Per state of a for-region with two or more copies: in which copies it is active, entered and left in the tick
 * (structure.md S-23). The diagram draws the region once, so its highlight is the union of the copies; this is what
 * its accessible name says instead (markCopies). The engine reports each copy's active and entered states; a state
 * left in a copy is one that was active there after `prev` or entered in the tick, and is not active at its end, or
 * was entered more often than it is active at the end (left and entered again): `wasActive + entries - isActive`
 * exits. `prev`: the tick before (`null` before tick 1; `undefined` when unknown, and then `left` is too, from tick 2
 * on). `counters`: each for-region's counter name (CompileResult.forCopies).
 */
export function copyMarks(tick: TickResult, prev: TickResult | null | undefined, counters: Record<string, string> = {}): Map<string, CopyMarks> {
    const out = new Map<string, CopyMarks>()
    const copies = copiesOf(tick)
    if (!copies?.length) return out
    const before = prev ? copiesOf(prev) : undefined
    const total = new Map<string, number>()
    for (const c of copies) total.set(c.region, (total.get(c.region) ?? 0) + 1)
    const knowsLeft = prev !== undefined || tick.tick <= 1
    for (const c of copies) {
        const of = total.get(c.region) ?? 0
        if (of < 2) continue
        const was = new Set(before?.find((p) => p.region === c.region && String(p.value) === String(c.value))?.active ?? [])
        const now = new Set(c.active)
        const entries = new Map<string, number>()
        for (const id of c.entered) entries.set(id, (entries.get(id) ?? 0) + 1)
        const ids = new Set([...now, ...entries.keys(), ...was, ...(c.exited ?? [])])
        for (const id of ids) {
            const m = out.get(id) ?? { of, counter: counters[c.region] || undefined, active: [], entered: [], left: knowsLeft || c.exited ? [] : undefined }
            if (now.has(id)) m.active.push(c.value)
            if (entries.has(id)) m.entered.push(c.value)
            const exits = c.exited ? c.exited.filter((x) => x === id).length : (was.has(id) ? 1 : 0) + (entries.get(id) ?? 0) - (now.has(id) ? 1 : 0)
            if (m.left && (c.exited || knowsLeft) && exits > 0) m.left.push(c.value)
            out.set(id, m)
        }
    }
    // A state that only stayed out of every copy (it was neither active, entered nor left anywhere) says nothing.
    for (const [id, m] of out) if (!m.active.length && !m.entered.length && !m.left?.length) out.delete(id)
    return out
}

/** "active in 2 of 3 copies (i = 0 and 2), entered in this tick in the copy i = 2, left in this tick in the copy
 *  i = 1": a state's marks across the copies, for its accessible name. */
export function copyPhrase(m: CopyMarks): string {
    const values = (vs: (number | string)[]) => (vs.length === 1 ? String(vs[0]) : `${vs.slice(0, -1).join(', ')} and ${vs[vs.length - 1]}`)
    const which = (vs: (number | string)[]) => (m.counter ? `${m.counter} = ${values(vs)}` : `${vs.length === 1 ? 'the copy for' : 'the copies for'} ${values(vs)}`)
    const inCopies = (vs: (number | string)[]) => (m.counter ? `in ${vs.length === 1 ? 'the copy' : 'the copies'} ${which(vs)}` : `in ${which(vs)}`)
    const parts: string[] = []
    if (m.active.length) parts.push(`active in ${m.active.length} of ${m.of} copies (${which(m.active)})`)
    if (m.entered.length) parts.push(`entered in this tick ${inCopies(m.entered)}`)
    if (m.left?.length) parts.push(`left in this tick ${inCopies(m.left)}`)
    return parts.join(', ')
}

/** The for-regions of a run with the copies its ticks report (empty when they report none). */
export function forCopiesIn(history: TickResult[]): ForCopies[] {
    const by = new Map<string, ForCopies>()
    for (const t of history) {
        for (const c of copiesOf(t) ?? []) {
            const f = by.get(c.region) ?? { region: c.region, counter: '', values: [] }
            if (!f.values.some((v) => String(v) === String(c.value))) f.values.push(c.value)
            by.set(c.region, f)
        }
    }
    return [...by.values()]
}

/** A state (by id) contains this region or state id: ids nest as `<state>:<region>` and `<state>.<state>`. */
const inside = (id: string, state: string) => id.startsWith(`${state}:`) || id.startsWith(`${state}.`) || id.startsWith(`${state}/`)

/** The region is frozen in this tick: a `suspend` of one of its ancestor states held (the log's suspend events). */
function suspendedIn(t: TickResult, region: string): boolean {
    return t.log.some((e) => e.kind === 'suspend' && inside(region, e.state))
}

/** Some region lane is suspended in some tick of the run (the trace then shows its legend). */
export function hasSuspension(lanes: Lane[], history: TickResult[]): boolean {
    return lanes.some((l) => l.suspended && history.some((t) => l.suspended!(t)))
}

const scalar = (v: Value | undefined): WaveValue => (Array.isArray(v) ? formatValue(v) : (v as WaveValue))

function variableLane(v: VariableInfo): Lane {
    const role: Lane['role'] = v.input ? 'input' : v.output ? 'output' : 'local'
    const title = `${v.input && v.output ? 'input output' : v.input ? 'input' : v.output ? 'output' : 'local'} ${v.signal ? (v.valued ? `signal ${v.type}` : 'signal') : v.type} ${v.name}`
    if (v.signal && !v.valued) return { key: v.name, name: v.name, title, kind: 'bool', role, presence: true, sample: (t) => !!t.present[v.name] }
    if (v.signal) {
        return {
            key: v.name, name: v.name, title, kind: 'signal', role,
            sample: (t) => ({ present: !!t.present[v.name], value: scalar(t.values[v.name] ?? t.values[`${v.name}_val`]) }),
        }
    }
    if (v.type === 'bool' && !v.dims.length) return { key: v.name, name: v.name, title, kind: 'bool', role, sample: (t) => !!t.values[v.name] }
    return { key: v.name, name: v.name, title, kind: 'value', role, array: v.dims.length > 0 || undefined, sample: (t) => scalar(t.values[v.name] ?? null) }
}

/** Lanes for the regions of a chart, outermost first, each showing the region's active state. A lane is
 *  named after its region (`HandleA`), or after the state that contains it (`WaitAB`, `WaitAB:2` when it
 *  has several unnamed regions); the root's only region is `state`. The full path is the lane's title. */
export function regionLanes(chart: State, copies: ForCopies[] = []): Lane[] {
    type Copy = { region: string; counter: string; value: number | string }
    const found: { r: Region; parent: State; index: number; count: number; copy?: Copy }[] = []
    const visit = (s: State, copy?: Copy) => {
        const flows = s.regions.filter((r) => r.regionType === 'controlflow' && r.states.length > 0)
        flows.forEach((r, i) => {
            const f = copy ? undefined : copies.find((c) => c.region === r.id && c.values.length > 0)
            // A for-region with its copies reported: one lane per copy, and per copy for the regions inside it.
            const each: (Copy | undefined)[] = f ? f.values.map((value) => ({ region: r.id, counter: f.counter || r.forLoop?.variable || 'i', value })) : [copy]
            for (const c of each) {
                found.push({ r, parent: s, index: i, count: flows.length, copy: c })
                for (const st of r.states) visit(st, c)
            }
        })
    }
    visit(chart)
    const short = found.map(({ r, parent, index, count, copy }) => {
        const own = r.name ?? r.label
        if (own) return own
        // The root's only region is the chart's state; a copy of an unnamed for-region there is "region i=1".
        if (parent.isRoot) return count === 1 ? (copy?.region === r.id ? 'region' : 'state') : `region ${index + 1}`
        return count === 1 ? parent.name : `${parent.name}:${index + 1}`
    })
    return found.map((f, i) => {
        const clash = short.filter((n, j) => n === short[i] && found[j].copy === f.copy).length > 1
        const path = f.parent.isRoot ? '' : stateName(f.parent.id, chart.id)
        const base = clash && path ? `${path}.${short[i]}` : short[i]
        const name = f.copy ? `${base} ${f.copy.counter}=${f.copy.value}` : base
        return regionLane(f.r, f.parent, f.index, f.count, path, name, f.copy)
    })
}

function regionLane(r: Region, parent: State, index: number, count: number, path: string, name: string, copy?: { region: string; counter: string; value: number | string }): Lane {
    const own = r.name ?? r.label
    const ids = new Set(r.states.map((s) => s.id))
    // In a copy: that copy's states (TickResult.copies); otherwise the states the tick reports active.
    const none: { active: string[]; entered: string[] } = { active: [], entered: [] }
    const states = (t: TickResult): { active: string[]; entered: string[] } =>
        copy ? (copiesOf(t)?.find((c) => c.region === copy.region && String(c.value) === String(copy.value)) ?? none) : t
    const activeIn = (t: TickResult) => states(t).active.find((id) => ids.has(id))
    const what = own ? `region ${own}` : parent.isRoot ? (count === 1 ? 'the chart' : `region ${index + 1} of the chart`) : count === 1 ? `the region of ${path}` : `region ${index + 1} of ${path}`
    const which = copy ? `, in the copy with ${copy.counter} = ${copy.value}` : ''
    return {
        key: `region:${r.id}${copy ? `|${copy.region}=${copy.value}` : ''}`,
        name,
        title: `Active state of ${what}${own && path ? ` (in ${path})` : ''}${which}`,
        kind: 'value',
        role: 'state',
        sample: (t) => {
            const id = activeIn(t)
            return id ? r.states.find((s) => s.id === id)!.name : null
        },
        ref: activeIn,
        longest: Math.max(...r.states.map((s) => s.name.length)),
        entered: (t) => {
            const id = activeIn(t)
            return !!id && states(t).entered.includes(id)
        },
        suspended: (t) => !!activeIn(t) && suspendedIn(t, r.id),
    }
}

/** The value of a variable outside KIELER's data pool in a tick (`SimTickResult.trace`, by the variable's key). */
const traced = (t: TickResult, key: string): Value | undefined => (t as TickResult & { trace?: Record<string, Value> }).trace?.[key]

/** A local of an inner state or region, or a member of an instance, named by where it is declared: `Outer.count`
 *  (the state path, as region lanes write it), `Run:Count.n` (a region's), `pt.x` (a member: its own name). */
export function qualifiedName(v: TraceableVariable, chart: State | undefined): string {
    if (v.member || v.scope.kind === 'chart' || !chart) return v.name
    return `${stateName(v.scope.id, chart.id)}.${v.name}`
}

/** What one entry of `show` names: a variable of KIELER's data pool, or one only the trace has. */
export type ShowTarget = { pool: VariableInfo; trace?: undefined } | { pool?: undefined; trace: TraceableVariable }

/**
 * Resolves `show` (Sim's and Compare's prop, the playground's Variables). An entry names, in this order of
 * preference: a variable of KIELER's data pool (the interface) by its name; else one of `traceable` (the
 * engine's `traceableVariables`: inner locals and members) by its key (`Chart.Outer$count`, `pt.x`), by its
 * qualified name (`Outer.count`, see `qualifiedName`), or by its name alone when no other traceable variable has
 * it. `unknown` lists the entries that name nothing, `ambiguous` the bare names several inner locals share (with
 * the qualified names that tell them apart).
 */
export function resolveShow(show: string[], iface: VariableInfo[], chart: State | undefined, traceable: TraceableVariable[] = []): { targets: ShowTarget[]; unknown: string[]; ambiguous: { name: string; candidates: string[] }[] } {
    const targets: ShowTarget[] = []
    const unknown: string[] = []
    const ambiguous: { name: string; candidates: string[] }[] = []
    const inner = traceable.filter((v) => !v.inPool)
    for (const n of show) {
        const pool = iface.find((v) => v.name === n)
        if (pool) {
            targets.push({ pool })
            continue
        }
        const exact = inner.find((v) => v.key === n) ?? inner.find((v) => qualifiedName(v, chart) === n)
        if (exact) {
            targets.push({ trace: exact })
            continue
        }
        const named = inner.filter((v) => v.name === n)
        if (named.length === 1 && !traceable.some((v) => v.inPool && v.name === n)) targets.push({ trace: named[0] })
        else if (named.length > 1) ambiguous.push({ name: n, candidates: named.map((v) => qualifiedName(v, chart)) })
        else unknown.push(n)
    }
    // Each variable once, at its first mention.
    const seen = new Set<string>()
    return {
        targets: targets.filter((t) => {
            const k = t.pool ? `pool:${t.pool.name}` : `trace:${t.trace.key}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
        }),
        unknown,
        ambiguous,
    }
}

function typeWords(v: { signal: boolean; valued: boolean; type: string; dims: number[] }): string {
    const type = v.signal ? (v.valued ? `signal ${v.type}` : 'signal') : v.type
    return v.dims.length ? `${type}${v.dims.map((d) => `[${d < 0 ? '' : d}]`).join('')}` : type
}

/** A lane for a variable outside the data pool: its values come from `SimTickResult.trace`. A local signal is its
 *  presence (pure) or its value (valued). Keyed by the qualified name, so that Compare matches the same local of
 *  two charts. */
function traceLane(v: TraceableVariable, chart: State | undefined): Lane {
    const qualified = qualifiedName(v, chart)
    const where = v.member ? `member ${typeWords(v)} ${v.member.member} of ${v.member.instance}` : `local ${typeWords(v)} ${v.name}${v.scope.kind === 'chart' ? '' : /^an? /.test(v.scope.name) ? ` in ${v.scope.name}` : ` of ${v.scope.kind} ${v.scope.name}`}`
    const base = { key: `trace:${qualified}`, name: v.name, title: where, role: 'local' as const }
    if (v.signal && !v.valued) return { ...base, kind: 'bool', presence: true, sample: (t) => !!traced(t, v.key) }
    if (v.type === 'bool' && !v.dims.length && !v.signal) return { ...base, kind: 'bool', sample: (t) => !!traced(t, v.key) }
    return { ...base, kind: 'value', array: v.dims.length > 0 || undefined, sample: (t) => scalar(traced(t, v.key) ?? null) }
}

/**
 * The lanes of a chart: inputs, then outputs (both in declaration order), then the locals named in `show`,
 * then one lane per region. With `show`, only the named variables are traced (still in that grouping). `show`
 * may name inner locals and members (`resolveShow`) when `traceable` (the engine's `traceableVariables` of the
 * chart) is given; their lanes follow the top-level locals, in the order named, each under its own name, or its
 * qualified name (`Outer.count`) where two lanes would share one.
 */
export function lanesFor(iface: VariableInfo[], chart: State | undefined, show?: string[], regions = true, copies: ForCopies[] = [], traceable?: TraceableVariable[]): Lane[] {
    const order = (v: VariableInfo) => (v.input ? 0 : v.output ? 1 : 2)
    let lanes: Lane[]
    if (show) {
        const { targets } = resolveShow(show, iface, chart, traceable)
        const pool = targets.flatMap((t) => (t.pool ? [t.pool] : []))
        lanes = [...pool].sort((a, b) => order(a) - order(b)).map(variableLane)
        const inner = targets.flatMap((t) => (t.trace ? [traceLane(t.trace, chart)] : []))
        const names = [...lanes, ...inner].map((l) => l.name)
        for (const l of inner) if (names.filter((n) => n === l.name).length > 1) l.name = l.key.slice('trace:'.length)
        lanes.push(...inner)
    } else {
        lanes = iface.filter((v) => (v.input || v.output) && !v.const).sort((a, b) => order(a) - order(b)).map(variableLane)
    }
    if (regions && chart) lanes.push(...regionLanes(chart, copies))
    return lanes
}

export interface TraceView {
    /** Ticks computed (history). */
    history: TickResult[]
    /** The tick shown (0 = none). */
    cursor: number
    /** Width available in px: as many tick columns as fit are drawn (the trace scrolls sideways beyond). */
    width: number
    /** At most this many ticks are drawn (the latest ones around the cursor). */
    window?: number
    /** Empty columns fill the width after the last tick (default; room for the ticks to come). `false` draws
     *  only the ticks of the history: a run that is over (Predict's scenario). */
    fill?: boolean
}

/** The window of ticks to draw: up to `window` ticks ending at the last tick, but always including the
 *  cursor. Returns [first tick index (0-based), count]. */
export function traceWindow(total: number, cursor: number, window = 120): [number, number] {
    if (total <= window) return [0, total]
    let from = total - window
    if (cursor - 1 < from) from = Math.max(0, cursor - Math.floor(window / 2))
    return [from, Math.min(window, total - from)]
}

export function traceRows(lanes: Lane[], ticks: TickResult[]): WaveRow[] {
    return lanes.map((l) => ({
        name: l.name,
        title: l.title,
        kind: l.kind,
        role: l.role,
        presence: l.presence,
        values: ticks.map((t) => l.sample(t)),
        refs: l.ref ? ticks.map((t) => l.ref!(t)) : undefined,
        breaks: l.entered ? ticks.map((t) => l.entered!(t)) : undefined,
        hatch: l.suspended ? ticks.map((t) => l.suspended!(t)) : undefined,
    }))
}

/** Tick columns are wide enough for the longest state name (a state often holds for one tick only), within
 *  40 to 72 px. */
export function columnWidthFor(lanes: Lane[]): number {
    let longest = 0
    for (const l of lanes) if (l.role === 'state' && l.longest) longest = Math.max(longest, l.longest)
    return Math.max(40, Math.min(72, Math.ceil(longest * 7.2 + 14)))
}

/** Header markers for the ticks [from, from + count) of a run: 'error' (a run-time error), 'term' (the tick in
 *  which the chart terminated: the first whose `terminated` is set). Keys are columns (0 = tick from + 1). */
export function tickMarks(history: TickResult[], from: number, count: number): Record<number, 'term' | 'error'> {
    const marks: Record<number, 'term' | 'error'> = {}
    for (let i = 0; i < count; i++) {
        const t = history[from + i]
        if (!t) break
        if (t.error) marks[i] = 'error'
        else if (t.terminated && !history[from + i - 1]?.terminated) marks[i] = 'term'
    }
    return marks
}

/** The tick (1-based) in which the chart terminated, if it has. */
export function terminationTick(history: TickResult[]): number | undefined {
    const i = history.findIndex((t) => t.terminated && !t.error)
    return i < 0 ? undefined : i + 1
}

/**
 * How two charts stepped together differ in termination at tick `cursor`, as inline Markdown for Compare's
 * difference line: "`OnceBool` terminated in tick 2; `Once` did not." (in that tick), "...; `Once` has not." (in
 * later ticks), "`A` terminated in tick 4, `B` earlier, in tick 2." (in the tick the second one does), "Both charts
 * terminated in tick 3." Empty when neither has terminated, or both did before the tick shown.
 */
export function terminationText(a: { name: string; history: TickResult[] }, b: { name: string; history: TickResult[] }, cursor: number): string {
    const ta = terminationTick(a.history.slice(0, cursor))
    const tb = terminationTick(b.history.slice(0, cursor))
    const A = `\`${a.name}\``
    const B = `\`${b.name}\``
    if (ta !== undefined && tb === undefined) return `${A} terminated in tick ${ta}; ${B} ${ta === cursor ? 'did not' : 'has not'}.`
    if (tb !== undefined && ta === undefined) return `${B} terminated in tick ${tb}; ${A} ${tb === cursor ? 'did not' : 'has not'}.`
    if (ta !== undefined && tb !== undefined && Math.max(ta, tb) === cursor) {
        if (ta === tb) return `Both charts terminated in tick ${cursor}.`
        return ta > tb ? `${A} terminated in tick ${ta}, ${B} earlier, in tick ${tb}.` : `${B} terminated in tick ${tb}, ${A} earlier, in tick ${ta}.`
    }
    return ''
}

/** Width of a tick column in which the longest value of these rows (bus lanes) is written in full. */
export function valueColumnWidth(rows: WaveRow[]): number {
    let longest = 0
    for (const r of rows) {
        if (r.kind === 'bool') continue
        for (const v of r.values) {
            const value = typeof v === 'object' && v !== null ? (v as SignalSample).value : (v as WaveValue)
            longest = Math.max(longest, waveText(value).length)
        }
    }
    return Math.ceil(longest * 7.2 + 14)
}

/**
 * The tick column width: wide enough for the longest state name (columnWidthFor), and, while the ticks drawn all
 * fit the width available at that size, for the longest value too, so that a short trace writes `97321` in full
 * instead of `97…` (a long one keeps the narrower columns and scrolls; a cut value has its full text as a tooltip).
 */
export function columnWidthForTrace(lanes: Lane[], rows: WaveRow[], count: number, width: number, labelWidth: number): number {
    const base = columnWidthFor(lanes)
    const full = Math.min(160, valueColumnWidth(rows))
    if (full <= base) return base
    return Math.max(count, 1) * full <= width - labelWidth - 14 ? full : base
}

/** The whole timing diagram for a simulation view, as SVG markup. */
export function traceSvg(lanes: Lane[], view: TraceView, title?: string): string {
    const [from, count] = traceWindow(view.history.length, view.cursor, view.window)
    const ticks = view.history.slice(from, from + count)
    const rows = traceRows(lanes, ticks)
    const marks = tickMarks(view.history, from, count)
    const shownCol = view.cursor - 1 - from
    const labelWidth = labelWidthFor(lanes.map((l) => l.name))
    const columnWidth = columnWidthForTrace(lanes, rows, count, view.width, labelWidth)
    const fit = view.fill === false ? count : Math.max(4, Math.floor((view.width - labelWidth - 14) / columnWidth))
    return renderWave(rows, {
        columns: Math.max(fit, count),
        firstTick: from + 1,
        cursor: shownCol >= 0 ? shownCol : -1,
        labelWidth,
        columnWidth,
        future: view.cursor < view.history.length ? Math.max(0, shownCol + 1) : undefined,
        hit: true,
        marks,
        stickyLabels: true,
        table: true,
        title: title ?? (view.history.length ? `Timing diagram, ticks ${from + 1} to ${from + count}${view.cursor ? `, showing tick ${view.cursor}` : ''}` : 'Timing diagram, no ticks yet'),
    })
}

export interface ComparedChart {
    name: string
    lanes: Lane[]
    history: TickResult[]
}

/** Values of the outputs both charts have, per tick: true where they disagree. */
export function differences(a: ComparedChart, b: ComparedChart): Map<string, boolean[]> {
    const out = new Map<string, boolean[]>()
    const shared = a.lanes.filter((l) => l.role !== 'state' && l.role !== 'input' && b.lanes.some((m) => m.key === l.key && m.role === l.role))
    for (const l of shared) {
        const m = b.lanes.find((x) => x.key === l.key)!
        const n = Math.min(a.history.length, b.history.length)
        out.set(l.key, Array.from({ length: n }, (_, i) => JSON.stringify(l.sample(a.history[i])) !== JSON.stringify(m.sample(b.history[i]))))
    }
    return out
}

/**
 * The timing diagram of two charts stepped together: the inputs once (they are the same for both), then
 * each chart's outputs and region lanes under its name. Outputs both charts have are marked in the ticks
 * where they differ.
 */
export function compareSvg(inputs: Lane[], inputHistory: TickResult[], a: ComparedChart, b: ComparedChart, view: Omit<TraceView, 'history'>): string {
    const total = Math.max(a.history.length, b.history.length)
    const [from, count] = traceWindow(total, view.cursor, view.window)
    const diff = differences(a, b)
    const rowsFor = (history: TickResult[], lanes: Lane[], group: string | undefined) =>
        traceRows(lanes, history.slice(from, from + count)).map((r, i) => ({
            ...r,
            group,
            // Each chart's termination (and run-time errors) in its own caption row.
            groupMarks: group !== undefined && i === 0 ? tickMarks(history, from, count) : undefined,
            marks: diff.get(lanes[i].key)?.slice(from, from + count),
        }))
    const own = (c: ComparedChart) => c.lanes.filter((l) => l.role !== 'input')
    const rows = [
        ...rowsFor(inputHistory, inputs, undefined),
        ...rowsFor(a.history, own(a), a.name),
        ...rowsFor(b.history, own(b), b.name === a.name ? `${b.name} (2)` : b.name),
    ]
    const lanes = [...inputs, ...own(a), ...own(b)]
    const labelWidth = labelWidthFor(lanes.map((l) => l.name))
    const columnWidth = columnWidthForTrace(lanes, rows, count, view.width, labelWidth)
    const fit = Math.max(4, Math.floor((view.width - labelWidth - 14) / columnWidth))
    const shownCol = view.cursor - 1 - from
    return renderWave(rows, {
        columns: Math.max(fit, count),
        firstTick: from + 1,
        cursor: shownCol >= 0 ? shownCol : -1,
        labelWidth,
        columnWidth,
        future: view.cursor < total ? Math.max(0, shownCol + 1) : undefined,
        hit: true,
        stickyLabels: true,
        table: true,
        title: total ? `Timing diagram of ${a.name} and ${b.name}, ticks ${from + 1} to ${from + count}` : `Timing diagram of ${a.name} and ${b.name}, no ticks yet`,
    })
}

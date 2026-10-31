// The simulation's "Variables" picker: which of the chart's variables the timing diagram traces (SimPanel's `show`).
// Every variable a reader may want to trace is offered (the engine's `traceableVariables`), grouped as a reader thinks
// of them: the inputs, the outputs, the chart's locals (with the state or region an inner one belongs to), the
// members of its class and struct instances, and time (clocks, and the `deltaT` / `sleepT` KIELER adds to a timed
// chart). The default is what KIELER's data pool lists for the chart: its inputs, outputs and top-level locals. The
// reader's choice is remembered per chart (by name) in local storage, guarded: without storage the default applies.
// Pure apart from the storage helpers.

import { traceableVariables, type CompileResult, type TraceableVariable } from '../../engine/index'
import { lanesFor } from '../sim/trace'
import { storageGet, storageSet } from './share'

export type VarGroup = TraceableVariable['group']

export interface VarChoice {
    /** What SimPanel's `show` takes: KIELER's name in the data pool, else the engine's trace key. */
    name: string
    /** The name as written in the chart (`x`, `pt.x`). */
    label: string
    group: VarGroup
    /** Where an inner local is declared ("in state `Run`"); undefined for the chart's own variables. */
    scope?: string
    /** What it is, as declared: "input bool", "output signal int", "clock", "added by KIELER: input float". */
    detail: string
    /** Traced unless the reader says otherwise: it is in KIELER's data pool. */
    byDefault: boolean
}

export const GROUP_TITLES: Record<VarGroup, string> = {
    input: 'Inputs',
    output: 'Outputs',
    local: 'Locals',
    member: 'Members',
    time: 'Time',
}
const ORDER: VarGroup[] = ['input', 'output', 'local', 'member', 'time']

function typeWords(v: TraceableVariable): string {
    const type = v.signal ? (v.valued ? `signal ${v.type}` : 'signal') : v.type
    return v.dims.length ? `${type}${v.dims.map(d => `[${d < 0 ? '' : d}]`).join('')}` : type
}

function detailOf(v: TraceableVariable, scope: string | undefined): string {
    const io = v.input && v.output ? 'input output' : v.input ? 'input' : v.output ? 'output' : ''
    const where = scope ? `, ${scope}` : ''
    if (v.added) return `added by KIELER: ${io} ${typeWords(v)}`
    if (v.type === 'clock' || v.type === 'clock-time') return `${io ? `${io} ` : ''}clock${where}`
    if (v.member) return `member of ${v.member.instance}: ${typeWords(v)}`
    return `${io || 'local'} ${typeWords(v)}${where}`
}

export interface VariableChoices {
    /** What the reader can trace, in the order the picker lists them (each group in declaration order). */
    choices: VarChoice[]
    /** Variables the panel cannot draw a lane for (none, since SimPanel traces inner locals and members): not
     *  offered. */
    untraceable: number
}

/** The variables a reader can trace. `canTrace` says whether the panel draws a lane for a name (default: SimPanel's
 *  own lanes, `lanesFor`). */
export function variableChoices(result: Pick<CompileResult, 'interface' | 'index' | 'chart'>, canTrace?: (name: string) => boolean): VariableChoices {
    const traceable = traceableVariables(result)
    // SimPanel draws a lane for a name of the data pool and for any other traceable variable (by its key).
    const can = canTrace ?? (name => lanesFor(result.interface, result.chart, [name], false, [], traceable).length > 0)
    const choices: VarChoice[] = []
    let untraceable = 0
    for (const v of traceable) {
        if (!can(v.key)) {
            untraceable++
            continue
        }
        // "in state Run", "in region Count", "in a region of Run" (an unnamed one).
        const scope = v.scope.kind === 'chart' || v.member ? undefined : /^an? /.test(v.scope.name) ? `in ${v.scope.name}` : `in ${v.scope.kind} ${v.scope.name}`
        choices.push({ name: v.key, label: v.name, group: v.group, scope, detail: detailOf(v, scope), byDefault: v.inPool })
    }
    choices.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group))
    return { choices, untraceable }
}

/** The default: KIELER's data pool for the chart (its inputs, outputs and top-level locals). */
export function defaultShow(choices: VarChoice[]): string[] {
    return choices.filter(c => c.byDefault).map(c => c.name)
}

/** A reader's choice for a chart: what was traced, and which variables the chart had then (a variable added since
 *  gets its default). */
export interface SavedChoice {
    known: string[]
    show: string[]
}

/** What to trace: the saved choice where it applies, the default for everything it does not know. */
export function resolveShow(choices: VarChoice[], saved: SavedChoice | undefined): string[] {
    if (!saved) return defaultShow(choices)
    const known = new Set(saved.known)
    const shown = new Set(saved.show)
    return choices.filter(c => (known.has(c.name) ? shown.has(c.name) : c.byDefault)).map(c => c.name)
}

/** The choice equals the default (nothing to remember). */
export function isDefault(choices: VarChoice[], show: string[]): boolean {
    const d = defaultShow(choices)
    return d.length === show.length && d.every(n => show.includes(n))
}

const key = (chart: string) => `sccharts-guide:playground:variables:${chart}`

export function loadChoice(chart: string): SavedChoice | undefined {
    const text = storageGet(key(chart))
    if (!text) return undefined
    try {
        const data = JSON.parse(text) as Partial<SavedChoice>
        if (!Array.isArray(data.known) || !Array.isArray(data.show)) return undefined
        return { known: data.known.filter(n => typeof n === 'string'), show: data.show.filter(n => typeof n === 'string') }
    } catch {
        return undefined
    }
}

/** Remembers the choice for the chart (or forgets it when it is the default). */
export function saveChoice(chart: string, choices: VarChoice[], show: string[]): void {
    if (isDefault(choices, show)) storageSet(key(chart), null)
    else storageSet(key(chart), JSON.stringify({ known: choices.map(c => c.name), show }))
}

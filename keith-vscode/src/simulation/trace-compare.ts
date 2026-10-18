/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { formatTraceValue, sameTraceValue, TraceRecord, TraceRole, traceTimes } from './trace-file'

// Compares runs of models, usually two implementations of one spec fed the same inputs.
// The tests load this file without VS Code, so it must stay free of vscode imports.

export interface NamedTrace {
    /** How the report names the run, e.g. the trace's file name. */
    label: string
    trace: TraceRecord
}

/** A variable taking a new value: at the first tick, and wherever it differs from the tick before. */
export interface ValueChange {
    tick: number
    time?: number
    value: unknown
}

/**
 * `tick`: tick n of one trace against tick n of the others. `time`: every trace has times (runs
 * on a timed sequence, or ticked with deltaT), so the values are compared at every moment any
 * trace ticks. That still works when the models tick at different moments and different rates.
 */
export type Alignment = 'tick' | 'time'

export interface VariableComparison {
    name: string
    role?: TraceRole
    /** Ticks (or, aligned by time, moments) compared one to one. */
    compared: number
    /** Ticks, or times in seconds, where a trace differs from the first. */
    differing: number[]
    /** Aligned by time: for how many seconds some trace differs from the first. */
    differingFor?: number
    /** Per trace, the changes of value. */
    changes: ValueChange[][]
    /** Every trace goes through the same values in the same order, whenever it does so. */
    sameSequence: boolean
    /** Largest distance, in ticks, between the n-th change of a trace and of the first. */
    worstTickShift: number
    /** The same in seconds, when every trace has times. */
    worstTimeShift?: number
}

export interface TraceComparison {
    alignment: Alignment
    traces: { label: string; model?: string; ticks: number; duration?: number }[]
    /** Aligned by time: the moments compared run up to here, the end of the shortest trace. */
    until?: number
    /** Variables in every trace, inputs first, then outputs, then the rest. */
    variables: VariableComparison[]
    /** Variables only some traces have, with the traces that have them. */
    partial: { name: string; labels: string[] }[]
}

const ROLE_ORDER: (TraceRole | undefined)[] = ['input', 'output', 'local', undefined]

/** Times closer than this are one moment. */
const EPSILON = 1e-9

function round(value: number): number {
    return Math.round(value * 1e9) / 1e9
}

function changesOf(trace: TraceRecord, name: string, times: number[] | undefined): ValueChange[] {
    const changes: ValueChange[] = []
    trace.ticks.forEach((tick, index) => {
        const value = tick[name]
        const last = changes[changes.length - 1]
        if (value === undefined || (last && sameTraceValue(last.value, value))) return
        changes.push({ tick: index + 1, time: times?.[index], value })
    })
    return changes
}

/** The value a variable holds after `tick`, or at `time`, from its changes. */
export function valueOf(changes: ValueChange[], alignment: Alignment, at: number): unknown {
    let value: unknown
    for (const change of changes) {
        const moment = alignment === 'time' ? change.time ?? 0 : change.tick
        if (moment > at + (alignment === 'time' ? EPSILON : 0)) break
        value = change.value
    }
    return value
}

/** Tick by tick for the ticks every trace has. */
function differingTicks(traces: NamedTrace[], name: string, shared: number): number[] {
    const differing: number[] = []
    for (let tick = 1; tick <= shared; tick++) {
        const reference = traces[0].trace.ticks[tick - 1][name]
        if (traces.some(({ trace }) => !sameTraceValue(trace.ticks[tick - 1][name], reference))) differing.push(tick)
    }
    return differing
}

/** At every moment any trace ticks, up to `until`; also how long the values differ in total. */
function differingTimes(
    changes: ValueChange[][],
    moments: number[],
    until: number
): { differing: number[]; differingFor: number } {
    const differing: number[] = []
    let differingFor = 0
    moments.forEach((moment, index) => {
        const reference = valueOf(changes[0], 'time', moment)
        if (changes.some((other) => !sameTraceValue(valueOf(other, 'time', moment), reference))) {
            differing.push(moment)
            differingFor += (moments[index + 1] ?? until) - moment
        }
    })
    return { differing, differingFor: round(differingFor) }
}

/**
 * Compares the traces against the first: tick by tick (or moment by moment, see
 * {@link Alignment}), and change by change. Changes still line up when one model reacts a few
 * ticks, or a fraction of a second, later than the other.
 */
export function compareTraces(traces: NamedTrace[]): TraceComparison {
    if (traces.length < 2) throw new Error('Pick at least two traces to compare.')
    const times = traces.map(({ trace }) => traceTimes(trace))
    const timed = times.every((entry) => entry !== undefined && entry.length > 0)
    // Runs that read the same deltaT every tick tick at the same moments: compare tick by tick.
    const sameGrid =
        timed &&
        times.every(
            (entry) =>
                entry!.length === times[0]!.length &&
                entry!.every((time, index) => Math.abs(time - times[0]![index]) <= EPSILON)
        )
    const alignment: Alignment = timed && !sameGrid ? 'time' : 'tick'
    const names = new Map<string, { role?: TraceRole; labels: string[] }>()
    traces.forEach(({ label, trace }) =>
        trace.variables.forEach(({ name, role }) => {
            const entry = names.get(name) ?? { role, labels: [] }
            entry.role = entry.role ?? role
            entry.labels.push(label)
            names.set(name, entry)
        })
    )
    const common = Array.from(names.entries())
        .filter(([, entry]) => entry.labels.length === traces.length)
        .sort(([, a], [, b]) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    const shared = Math.min(...traces.map(({ trace }) => trace.ticks.length))
    const until = alignment === 'time' ? Math.min(...times.map((entry) => entry![entry!.length - 1])) : undefined
    const moments =
        alignment === 'time'
            ? Array.from(new Set(times.flatMap((entry) => entry!.filter((time) => time <= until! + EPSILON))))
                  .sort((a, b) => a - b)
                  .filter((time, index, all) => index === 0 || time - all[index - 1] > EPSILON)
            : []

    const variables = common.map(([name, { role }]): VariableComparison => {
        const changes = traces.map(({ trace }, index) => changesOf(trace, name, times[index]))
        const [first, ...rest] = changes
        const sameSequence = rest.every(
            (other) =>
                other.length === first.length &&
                other.every((change, index) => sameTraceValue(change.value, first[index].value))
        )
        let worstTickShift = 0
        let worstTimeShift = timed ? 0 : undefined
        rest.forEach((other) =>
            other.slice(0, first.length).forEach((change, index) => {
                worstTickShift = Math.max(worstTickShift, Math.abs(change.tick - first[index].tick))
                if (worstTimeShift !== undefined) {
                    const shift = Math.abs((change.time ?? 0) - (first[index].time ?? 0))
                    worstTimeShift = Math.max(worstTimeShift, round(shift))
                }
            })
        )
        const base = { name, role, changes, sameSequence, worstTickShift, worstTimeShift }
        if (alignment === 'time') {
            return { ...base, compared: moments.length, ...differingTimes(changes, moments, until!) }
        }
        return { ...base, compared: shared, differing: differingTicks(traces, name, shared) }
    })

    return {
        alignment,
        traces: traces.map(({ label, trace }, index) => ({
            label,
            model: trace.model,
            ticks: trace.ticks.length,
            duration: times[index]?.[times[index]!.length - 1],
        })),
        until,
        variables,
        partial: Array.from(names.entries())
            .filter(([, entry]) => entry.labels.length < traces.length)
            .map(([name, entry]) => ({ name, labels: entry.labels })),
    }
}

function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function code(value: unknown): string {
    const text = formatTraceValue(value)
    return text === '' ? '—' : `\`${text.replace(/`/g, "'")}\``
}

function seconds(time: number): string {
    return `${Number(time.toFixed(6))} s`
}

function signed(value: number, unit = ''): string {
    const rounded = Number(value.toFixed(6))
    return `${rounded >= 0 ? '+' : ''}${rounded}${unit}`
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** Where a difference is: "tick 5", or "3.3 s". */
function place(alignment: Alignment, at: number): string {
    return alignment === 'time' ? seconds(at) : `tick ${at}`
}

/** When a change happened, in the terms that matter for the alignment. */
function when(alignment: Alignment, change: ValueChange): string {
    if (change.time === undefined) return `tick ${change.tick}`
    return alignment === 'time'
        ? `${seconds(change.time)} (tick ${change.tick})`
        : `tick ${change.tick} (${seconds(change.time)})`
}

/** The values of a variable at a tick or moment, one per trace, as "a / b". */
function valuesAt(comparison: TraceComparison, variable: VariableComparison, at: number): string {
    return variable.changes
        .map((changes, index) => {
            const beyond = comparison.alignment === 'tick' && comparison.traces[index].ticks < at
            return code(beyond ? undefined : valueOf(changes, comparison.alignment, at))
        })
        .join(' / ')
}

/**
 * The comparison as Markdown, for the editor's preview: what was compared, a summary per
 * variable, every change of the variables that differ, and the first ticks (or moments) that differ.
 */
export function comparisonMarkdown(
    comparison: TraceComparison,
    options: { maxRows?: number; preamble?: string[] } = {}
): string {
    const { traces, variables, alignment } = comparison
    const maxRows = options.maxRows ?? 200
    const labels = traces.map((trace) => trace.label)
    const byTime = alignment === 'time'
    const lines: string[] = ['# Trace comparison', '', ...(options.preamble ?? [])]
    if (options.preamble?.length) lines.push('')
    lines.push('| | Trace | Model | Ticks | Simulated time |', '|---|---|---|---|---|')
    traces.forEach((trace, index) =>
        lines.push(
            `| ${index === 0 ? 'Reference' : index + 1} | ${cell(trace.label)} | ${cell(trace.model ?? '—')} | ${
                trace.ticks
            } | ${trace.duration === undefined ? '—' : seconds(trace.duration)} |`
        )
    )
    lines.push('')
    if (byTime) {
        lines.push(
            'The traces tick at different moments, so they are compared in time: at every moment one of ' +
                `them ticks, up to ${seconds(comparison.until ?? 0)}, each holds the value of its last tick.`,
            ''
        )
    } else if (new Set(traces.map((trace) => trace.ticks)).size > 1) {
        lines.push(
            `The traces have different lengths, so ticks are compared up to tick ${Math.min(
                ...traces.map((trace) => trace.ticks)
            )}. Value changes are compared over the whole of each trace.`,
            ''
        )
    }

    const inputs = variables.filter((variable) => variable.role === 'input')
    const differentInputs = inputs.filter((variable) => variable.differing.length > 0)
    if (inputs.length > 0) {
        lines.push(
            differentInputs.length === 0
                ? `**Inputs:** the same in every trace (${inputs
                      .map((variable) => `\`${variable.name}\``)
                      .join(', ')}).`
                : `**Inputs differ:** ${differentInputs
                      .map((variable) => `\`${variable.name}\` from ${place(alignment, variable.differing[0])}`)
                      .join(', ')}. Differences in the outputs may come from the inputs.`,
            ''
        )
    }

    lines.push('## Summary', '')
    if (variables.length === 0) {
        lines.push('The traces have no variables in common.', '')
    } else {
        lines.push(
            `| Variable | Role | ${
                byTime ? 'Differs for' : 'Ticks that differ'
            } | First difference | Value changes | Same order | Largest shift |`,
            '|---|---|---|---|---|---|---|'
        )
        variables.forEach((variable) => {
            const first = variable.differing[0]
            const firstText =
                first === undefined ? '—' : `${place(alignment, first)}: ${valuesAt(comparison, variable, first)}`
            const extent = byTime
                ? `${seconds(variable.differingFor ?? 0)} of ${seconds(comparison.until ?? 0)}`
                : `${variable.differing.length} of ${variable.compared}`
            let shift = byTime ? seconds(variable.worstTimeShift ?? 0) : plural(variable.worstTickShift, 'tick')
            if (!byTime && variable.worstTimeShift !== undefined) shift += ` (${seconds(variable.worstTimeShift)})`
            lines.push(
                `| \`${variable.name}\` | ${variable.role ?? '—'} | ${extent} | ${cell(firstText)} | ${variable.changes
                    .map((changes) => changes.length)
                    .join(' / ')} | ${variable.sameSequence ? 'yes' : '**no**'} | ${shift} |`
            )
        })
        lines.push(
            '',
            '*Value changes* counts the first tick and every tick where the value is new. *Same order*: every ' +
                'trace goes through the same values in the same order, whenever it does so. *Largest shift*: the ' +
                'furthest apart the n-th change of a trace and of the reference are.',
            ''
        )
    }
    if (comparison.partial.length > 0) {
        lines.push(
            `**Not in every trace:** ${comparison.partial
                .map((entry) => `\`${entry.name}\` (${entry.labels.map(cell).join(', ')})`)
                .join(', ')}.`,
            ''
        )
    }

    // Outputs always: their changes are the run's timeline. Other variables when they differ or move.
    const changed = variables.filter(
        (variable) =>
            variable.role === 'output' ||
            (variable.role !== 'input' &&
                (variable.differing.length > 0 ||
                    !variable.sameSequence ||
                    (byTime ? (variable.worstTimeShift ?? 0) > 0 : variable.worstTickShift > 0)))
    )
    if (changed.length > 0) lines.push('## Value changes', '')
    changed.forEach((variable) => {
        lines.push(`### \`${variable.name}\``, '')
        lines.push(`| # | ${labels.map(cell).join(' | ')} | Shift |`, `|---|${labels.map(() => '---|').join('')}---|`)
        const rows = Math.max(...variable.changes.map((changes) => changes.length))
        for (let index = 0; index < Math.min(rows, maxRows); index++) {
            const reference = variable.changes[0][index]
            const entries = variable.changes.map((changes) => changes[index])
            const shifts = entries.slice(1).map((entry) => {
                if (!entry || !reference) return '—'
                const ticks = signed(entry.tick - reference.tick)
                if (entry.time === undefined || reference.time === undefined) return ticks
                const time = signed(entry.time - reference.time, ' s')
                return byTime ? time : `${ticks} (${time})`
            })
            const differs = entries.some(
                (entry) => !entry || !reference || !sameTraceValue(entry.value, reference.value)
            )
            lines.push(
                `| ${index + 1}${differs ? ' ≠' : ''} | ${entries
                    .map((entry) => (entry ? `${code(entry.value)} at ${when(alignment, entry)}` : '—'))
                    .map(cell)
                    .join(' | ')} | ${shifts.join(', ')} |`
            )
        }
        if (rows > maxRows) lines.push('', `${rows - maxRows} more changes are in the CSV of this comparison.`)
        lines.push('')
    })

    const differing = Array.from(new Set(variables.flatMap((variable) => variable.differing))).sort((a, b) => a - b)
    if (differing.length > 0) {
        const columns = variables.filter((variable) => variable.differing.length > 0)
        lines.push(byTime ? '## Moments that differ' : '## Ticks that differ', '')
        lines.push(
            `Values are shown as ${labels.map(cell).join(' / ')}.`,
            '',
            `| ${byTime ? 'Time' : 'Tick'} | ${columns.map((variable) => `\`${variable.name}\``).join(' | ')} |`,
            `|---|${columns.map(() => '---|').join('')}`
        )
        differing
            .slice(0, maxRows)
            .forEach((at) =>
                lines.push(
                    `| ${byTime ? seconds(at) : at} | ${columns
                        .map((variable) =>
                            variable.differing.includes(at) ? cell(valuesAt(comparison, variable, at)) : ''
                        )
                        .join(' | ')} |`
                )
            )
        if (differing.length > maxRows) {
            lines.push('', `${differing.length - maxRows} more ${byTime ? 'moments' : 'ticks'} differ.`)
        }
        lines.push('')
    } else if (variables.length > 0) {
        lines.push(
            byTime
                ? 'Every variable the traces share has the same value at every moment compared.'
                : 'Every variable the traces share has the same value at every tick they share.',
            ''
        )
    }
    return `${lines.join('\n')}\n`
}

function csvCell(text: string): string {
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Every change of every shared variable, aligned by its position: one row per n-th change, with
 * each trace's tick, time and value. The table behind "Value changes", for further analysis.
 */
export function comparisonCsv(comparison: TraceComparison): string {
    const timed = comparison.variables.some((variable) => variable.worstTimeShift !== undefined)
    const header = ['variable', 'role', 'change']
    comparison.traces.forEach(({ label }) => {
        header.push(`${label} tick`)
        if (timed) header.push(`${label} time`)
        header.push(`${label} value`)
    })
    const rows = [header]
    comparison.variables.forEach((variable) => {
        const count = Math.max(...variable.changes.map((changes) => changes.length))
        for (let index = 0; index < count; index++) {
            const row = [variable.name, variable.role ?? '', String(index + 1)]
            variable.changes.forEach((changes) => {
                const change = changes[index]
                row.push(change ? String(change.tick) : '')
                if (timed) row.push(change?.time === undefined ? '' : String(change.time))
                row.push(change ? formatTraceValue(change.value) : '')
            })
            rows.push(row)
        }
    })
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

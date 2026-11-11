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

import { formatTraceValue, sameTraceValue } from './trace-record'
import { valueOf } from './trace-compare'
import type { Alignment, TraceComparison, ValueChange, VariableComparison } from './trace-compare'

// A comparison of traces as a Markdown report and as a CSV of every value change.

function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function code(value: unknown): string {
    const text = formatTraceValue(value)
    return text === '' ? '-' : `\`${text.replace(/`/g, "'")}\``
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
            `| ${index === 0 ? 'Reference' : index + 1} | ${cell(trace.label)} | ${cell(trace.model ?? '-')} | ${
                trace.ticks
            } | ${trace.duration === undefined ? '-' : seconds(trace.duration)} |`
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
                first === undefined ? '-' : `${place(alignment, first)}: ${valuesAt(comparison, variable, first)}`
            const extent = byTime
                ? `${seconds(variable.differingFor ?? 0)} of ${seconds(comparison.until ?? 0)}`
                : `${variable.differing.length} of ${variable.compared}`
            let shift = byTime ? seconds(variable.worstTimeShift ?? 0) : plural(variable.worstTickShift, 'tick')
            if (!byTime && variable.worstTimeShift !== undefined) shift += ` (${seconds(variable.worstTimeShift)})`
            lines.push(
                `| \`${variable.name}\` | ${variable.role ?? '-'} | ${extent} | ${cell(firstText)} | ${variable.changes
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

    const { printed } = comparison
    if (printed) {
        const shift = byTime
            ? seconds(printed.worstTimeShift ?? 0)
            : `${plural(printed.worstTickShift, 'tick')}${
                  printed.worstTimeShift === undefined ? '' : ` (${seconds(printed.worstTimeShift)})`
              }`
        lines.push(
            `**Printed:** ${printed.lines.map((entries) => entries.length).join(' / ')} lines; ${
                printed.sameSequence ? 'the same text in the same order' : '**not the same text in the same order**'
            }; largest shift ${shift}.`,
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
                if (!entry || !reference) return '-'
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
                    .map((entry) => (entry ? `${code(entry.value)} at ${when(alignment, entry)}` : '-'))
                    .map(cell)
                    .join(' | ')} | ${shifts.join(', ')} |`
            )
        }
        if (rows > maxRows) lines.push('', `${rows - maxRows} more changes are in the CSV of this comparison.`)
        lines.push('')
    })

    if (printed) {
        lines.push('## Printed', '')
        lines.push(`| # | ${labels.map(cell).join(' | ')} | Shift |`, `|---|${labels.map(() => '---|').join('')}---|`)
        const rows = Math.max(...printed.lines.map((each) => each.length))
        for (let index = 0; index < Math.min(rows, maxRows); index++) {
            const reference = printed.lines[0][index]
            const entries = printed.lines.map((each) => each[index])
            const shifts = entries.slice(1).map((entry) => {
                if (!entry || !reference) return '-'
                const ticks = signed(entry.tick - reference.tick)
                if (entry.time === undefined || reference.time === undefined) return ticks
                const time = signed(entry.time - reference.time, ' s')
                return byTime ? time : `${ticks} (${time})`
            })
            const differs = entries.some((entry) => !entry || !reference || entry.text !== reference.text)
            lines.push(
                `| ${index + 1}${differs ? ' ≠' : ''} | ${entries
                    .map((entry) =>
                        entry ? `${code(entry.text)} at ${when(alignment, { ...entry, value: entry.text })}` : '-'
                    )
                    .map(cell)
                    .join(' | ')} | ${shifts.join(', ')} |`
            )
        }
        if (rows > maxRows) lines.push('', `${rows - maxRows} more lines are in the CSV of this comparison.`)
        lines.push('')
    }

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
 * Printed lines follow as rows of their own, the n-th line of each trace in one row.
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
    const { printed } = comparison
    if (printed) {
        const count = Math.max(...printed.lines.map((entries) => entries.length))
        for (let index = 0; index < count; index++) {
            // The role column marks these rows; no variable is called "(printed)".
            const row = ['(printed)', 'printed', String(index + 1)]
            printed.lines.forEach((entries) => {
                const entry = entries[index]
                row.push(entry ? String(entry.tick) : '')
                if (timed) row.push(entry?.time === undefined ? '' : String(entry.time))
                row.push(entry ? entry.text : '')
            })
            rows.push(row)
        }
    }
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

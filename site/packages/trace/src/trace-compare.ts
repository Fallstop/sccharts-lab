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

import { sameTraceValue, traceTimes } from './trace-record'
import type { TraceRecord, TraceRole } from './trace-record'

// Compares runs of models, usually two implementations of one spec fed the same inputs. The reports
// are in comparison-report.ts.

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

/** The lines the models printed, each with its tick, lined up the n-th with the n-th like value changes. */
export interface PrintedComparison {
    /** Per trace, every printed line in order. */
    lines: { tick: number; time?: number; text: string }[][]
    /** Every trace printed the same lines in the same order. */
    sameSequence: boolean
    worstTickShift: number
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
    /** When any trace printed something. */
    printed?: PrintedComparison
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

    let printed: PrintedComparison | undefined
    if (traces.some(({ trace }) => trace.printed?.some((lines) => lines.length > 0))) {
        const lines = traces.map(({ trace }, index) =>
            (trace.printed ?? []).flatMap((texts, tick) =>
                texts.map((text) => ({ tick: tick + 1, time: times[index]?.[tick], text }))
            )
        )
        const [first, ...rest] = lines
        let worstTickShift = 0
        let worstTimeShift = timed ? 0 : undefined
        rest.forEach((other) =>
            other.slice(0, first.length).forEach((line, index) => {
                worstTickShift = Math.max(worstTickShift, Math.abs(line.tick - first[index].tick))
                if (worstTimeShift !== undefined) {
                    worstTimeShift = Math.max(
                        worstTimeShift,
                        round(Math.abs((line.time ?? 0) - (first[index].time ?? 0)))
                    )
                }
            })
        )
        printed = {
            lines,
            sameSequence: rest.every(
                (other) =>
                    other.length === first.length && other.every((line, index) => line.text === first[index].text)
            ),
            worstTickShift,
            worstTimeShift,
        }
    }

    return {
        alignment,
        printed,
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

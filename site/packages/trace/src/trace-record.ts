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

import { isTimeDelta } from './helper'

// Simulation traces in memory: what Save writes, and what Replay and Compare read. The formats are in
// ktrace.ts, csv.ts, json.ts and xml.ts; trace-file.ts reads and writes them.

export type TraceRole = 'input' | 'output' | 'local'

export interface TraceVariable {
    name: string
    /** Unknown when the file does not record it, as in CSV. */
    role?: TraceRole
    /** The model's type name (bool, int, float, string), when known. */
    type?: string
}

/** A run of a model: every variable's value after each tick. */
export interface TraceRecord {
    /** File name of the simulated model, when known. */
    model?: string
    variables: TraceVariable[]
    /** `ticks[i]` holds the values after tick i + 1. A value the file never gave is undefined. */
    ticks: Record<string, unknown>[]
    /** Ticks (1-based) after which a replay stops running, from KTrace `pause`. */
    pauses?: number[]
    /** Things the reader dropped or guessed, worth telling the user. */
    notes?: string[]
    /**
     * Seconds at each tick, for a run on a timed sequence. In a sequence, the moments its rows
     * happen: such a sequence describes input changes in time rather than per tick.
     */
    times?: number[]
    /** What the model printed during each tick, line by line: `printed[i]` for tick i + 1. */
    printed?: string[][]
}

export type TraceFormat = 'ktrace' | 'csv' | 'json' | 'xml'

export const TRACE_FORMATS: { format: TraceFormat; label: string; extension: string }[] = [
    { format: 'ktrace', label: 'KTrace', extension: 'ktrace' },
    { format: 'csv', label: 'CSV', extension: 'csv' },
    { format: 'json', label: 'JSON', extension: 'json' },
    { format: 'xml', label: 'XML', extension: 'xml' },
]

/** Identifies this lab's JSON and XML traces. */
export const TRACE_FORMAT_ID = 'sccharts-lab-trace'

export class TraceFileError extends Error {
    constructor(message: string, line?: number) {
        super(line === undefined ? message : `Line ${line}: ${message}`)
        this.name = 'TraceFileError'
    }
}

export function traceFormatOf(fileName: string): TraceFormat | undefined {
    const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    return TRACE_FORMATS.find((entry) => entry.extension === extension)?.format
}

/** Values are the same when they are equal, or are primitives that print the same (CSV reads `"7"` as 7). */
export function sameTraceValue(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((entry, index) => sameTraceValue(entry, b[index]))
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = Object.keys(a)
        return (
            keys.length === Object.keys(b).length &&
            keys.every((key) =>
                sameTraceValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
            )
        )
    }
    const primitive = (value: unknown) => ['boolean', 'number', 'string'].includes(typeof value)
    return primitive(a) && primitive(b) && String(a) === String(b)
}

/** Text for a value in a report or a CSV cell: arrays and structs as JSON, strings as they are. */
export function formatTraceValue(value: unknown): string {
    if (value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
}

/** The variable that tells timed models how much time passed in a tick, if the trace has one. */
export function timeDeltaOf(trace: TraceRecord): TraceVariable | undefined {
    return trace.variables.find(
        (variable) =>
            variable.role !== 'output' &&
            variable.role !== 'local' &&
            isTimeDelta({ id: variable.name, categories: [] })
    )
}

/**
 * Seconds after each tick: the times a timed run recorded, else the running sum of the time
 * delta; undefined without either.
 */
export function traceTimes(trace: TraceRecord): number[] | undefined {
    if (trace.times) return trace.times
    const delta = timeDeltaOf(trace)
    if (!delta) return undefined
    let time = 0
    return trace.ticks.map((tick) => {
        const value = Number(tick[delta.name])
        if (Number.isFinite(value)) time += value
        // Float sums drift (0.1 + 0.2); a trace's times are only ever read to the microsecond.
        return Math.round(time * 1e9) / 1e9
    })
}

/** The printed lines per tick, or undefined when no tick printed anything. */
export function printedOf(lines: string[][] | undefined): string[][] | undefined {
    return lines?.some((tick) => tick.length > 0) ? lines : undefined
}

/** The record with only the inputs, as replayed into another model. */
export function inputsOnly(trace: TraceRecord): TraceRecord {
    const variables = trace.variables.filter((variable) => variable.role === 'input')
    return {
        ...trace,
        printed: undefined,
        variables,
        ticks: trace.ticks.map((tick) => Object.fromEntries(variables.map(({ name }) => [name, tick[name]]))),
    }
}

/** Fills in the values a sparse file left out with the tick before's. */
export function carryForward(ticks: Record<string, unknown>[], variables: TraceVariable[]): Record<string, unknown>[] {
    const last: Record<string, unknown> = {}
    return ticks.map((tick) => {
        const full: Record<string, unknown> = {}
        variables.forEach(({ name }) => {
            if (tick[name] !== undefined) last[name] = tick[name]
            full[name] = last[name]
        })
        return full
    })
}

/** Times given per tick count only without a time delta, which they would merely repeat. */
export function givenTimes(
    times: (number | undefined)[],
    variables: TraceVariable[],
    where: (index: number) => string
): number[] | undefined {
    const hasDelta = variables.some((variable) => isTimeDelta({ id: variable.name, categories: [] }))
    if (hasDelta || times.every((time) => time === undefined)) return undefined
    return times.map((time, index) => {
        if (time === undefined || !Number.isFinite(time)) throw new TraceFileError(`${where(index)} has no time.`)
        return time
    })
}

export function typeOfValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return value.length > 0 ? typeOfValue(value[0]) : undefined
    if (typeof value === 'boolean') return 'bool'
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
    if (typeof value === 'string') return 'string'
    return undefined
}

/** Adds the variables a reader met, in order of first appearance. */
export class VariableList {
    readonly variables: TraceVariable[] = []

    private readonly byName = new Map<string, TraceVariable>()

    add(name: string, role?: TraceRole, type?: string): TraceVariable {
        let variable = this.byName.get(name)
        if (!variable) {
            variable = { name, role, type }
            this.byName.set(name, variable)
            this.variables.push(variable)
        } else {
            variable.role = variable.role ?? role
            // A float literal anywhere makes the variable a float, even when it began as 0.
            variable.type = variable.type === 'int' && type === 'float' ? type : variable.type ?? type
        }
        return variable
    }

    get(name: string): TraceVariable | undefined {
        return this.byName.get(name)
    }
}

/**
 * Text in a CSV cell or an XML element as a value. Arrays and structs are JSON; for strings the
 * type decides, since a string input may well hold "12" or "true".
 */
export function decodeText(text: string, type?: string): unknown {
    const trimmed = text.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            return JSON.parse(trimmed)
        } catch {
            // Not JSON after all: an ordinary string.
        }
    }
    if (type === 'string') return text
    if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed)
    if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16)
    return text
}

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

import { carryForward, givenTimes, printedOf, TRACE_FORMAT_ID, TraceFileError, traceTimes, typeOfValue, VariableList } from './trace-record'
import type { TraceRecord, TraceRole } from './trace-record'

// This lab's JSON trace.

const GROUPS: { key: string; role?: TraceRole }[] = [
    { key: 'inputs', role: 'input' },
    { key: 'outputs', role: 'output' },
    { key: 'locals', role: 'local' },
    { key: 'values' },
]

function groupOf(role: TraceRole | undefined): string {
    return GROUPS.find((group) => group.role === role)?.key ?? 'values'
}

/** One tick per line, so a long run stays readable and diffs well. */
export function writeJson(trace: TraceRecord): string {
    const times = traceTimes(trace)
    const header = {
        format: TRACE_FORMAT_ID,
        version: 1,
        ...(trace.model ? { model: trace.model } : {}),
        variables: trace.variables.map((variable) => ({
            name: variable.name,
            ...(variable.role ? { role: variable.role } : {}),
            ...(variable.type ? { type: variable.type } : {}),
        })),
    }
    const ticks = trace.ticks.map((tick, index) => {
        const entry: Record<string, unknown> = { tick: index + 1 }
        if (times) entry.time = times[index]
        if (trace.printed?.[index]?.length) entry.printed = trace.printed[index]
        trace.variables.forEach(({ name, role }) => {
            if (tick[name] === undefined) return
            const group = groupOf(role)
            entry[group] = { ...((entry[group] as Record<string, unknown>) ?? {}), [name]: tick[name] }
        })
        return `    ${JSON.stringify(entry)}`
    })
    const head = JSON.stringify(header, null, 2).replace(/\n}$/, '')
    return `${head},\n  "ticks": [\n${ticks.join(',\n')}\n  ]\n}\n`
}

/**
 * Reads this lab's JSON trace. Ticks may list only what changes, so an input sequence can be
 * written by hand: `{"ticks": [{"inputs": {"start": true}}, {}, {"inputs": {"start": false}}]}`.
 */
export function readJson(text: string): TraceRecord {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        throw new TraceFileError(`The file is not valid JSON: ${error instanceof Error ? error.message : error}`)
    }
    const root = Array.isArray(parsed) ? { ticks: parsed } : (parsed as Record<string, unknown>)
    if (!root || typeof root !== 'object' || !Array.isArray(root.ticks)) {
        throw new TraceFileError('Expected an object with a "ticks" array.')
    }
    const list = new VariableList()
    if (Array.isArray(root.variables)) {
        root.variables.forEach((variable: unknown, index: number) => {
            const entry = variable as Record<string, unknown>
            if (!entry || typeof entry.name !== 'string') throw new TraceFileError(`Variable ${index + 1} has no name.`)
            const role = ['input', 'output', 'local'].includes(entry.role as string)
                ? (entry.role as TraceRole)
                : undefined
            list.add(entry.name, role, typeof entry.type === 'string' ? entry.type : undefined)
        })
    }
    const times: (number | undefined)[] = []
    const printed: string[][] = []
    const ticks = (root.ticks as unknown[]).map((tick, index) => {
        if (!tick || typeof tick !== 'object' || Array.isArray(tick)) {
            throw new TraceFileError(`Tick ${index + 1} is not an object.`)
        }
        const { time, printed: lines } = tick as Record<string, unknown>
        times.push(typeof time === 'number' ? time : undefined)
        if (lines !== undefined && !(Array.isArray(lines) && lines.every((line) => typeof line === 'string'))) {
            throw new TraceFileError(`"printed" of tick ${index + 1} is not a list of strings.`)
        }
        printed.push((lines as string[] | undefined) ?? [])
        const values: Record<string, unknown> = {}
        GROUPS.forEach(({ key, role }) => {
            const group = (tick as Record<string, unknown>)[key]
            if (group === undefined) return
            if (!group || typeof group !== 'object' || Array.isArray(group)) {
                throw new TraceFileError(`"${key}" of tick ${index + 1} is not an object.`)
            }
            Object.entries(group).forEach(([name, value]) => {
                list.add(name, role, typeOfValue(value))
                if (value !== null) values[name] = value
            })
        })
        return values
    })
    return {
        model: typeof root.model === 'string' ? root.model : undefined,
        variables: list.variables,
        ticks: carryForward(ticks, list.variables),
        times: givenTimes(times, list.variables, (index) => `Tick ${index + 1}`),
        printed: printedOf(printed),
    }
}

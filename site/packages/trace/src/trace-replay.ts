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

import { inputValue } from './data-pool'
import { isCompatibleInput } from './input-value'
import type { ReplayState } from './protocol'
import { formatTraceValue, sameTraceValue } from './trace-record'
import type { TraceRecord } from './trace-record'

// Drives a running simulation's inputs from a trace file, tick by tick, and checks its outputs
// against the file's.

/** A variable of the running model, as far as replaying is concerned. */
export interface ReplayTarget {
    id: string
    input: boolean
    output: boolean
    type?: string
}

export interface ReplayMismatch {
    tick: number
    name: string
    expected: unknown
    actual: unknown
}

const MAX_PROBLEMS = 5

/** A file value in the model's terms: strings for string inputs, 0 and 1 for booleans. */
export function coerceInput(value: unknown, type: string | undefined): unknown {
    if (Array.isArray(value)) return value.map((entry) => coerceInput(entry, type))
    if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value)
    if (type === 'bool' && (value === 0 || value === 1)) return value === 1
    return inputValue(value, type)
}

/**
 * The file's inputs are matched to the model's by name. Inputs the model does not have are
 * ignored, and the model's other inputs stay under the user's control. The file's first row is
 * the tick after `offset`, and the tick number alone decides the values, so stepping back and
 * running again gives the same run. Ticks below are the simulation's, rows the file's.
 */
export class TraceReplay {
    /** Inputs the file sets and the model reads. */
    readonly driven: string[]

    /** Inputs in the file that the model does not have. */
    readonly ignored: string[]

    /** Inputs of the model that the file does not set. */
    readonly unset: string[]

    /** Outputs in both, checked after every tick the file covers. */
    readonly checked: string[]

    private readonly problems: string[] = []

    private readonly mismatches = new Map<number, ReplayMismatch[]>()

    private readonly targets: Map<string, ReplayTarget>

    constructor(
        readonly label: string,
        readonly trace: TraceRecord,
        targets: ReplayTarget[],
        /** False when another model's outputs are not expected to match, as in a batch comparison. */
        readonly checkOutputs = true,
        /** The model the replay belongs to; a restart of the same model keeps replaying. */
        readonly modelUri?: string,
        /** The simulation's tick before the file's first row: the tick at which replaying began. */
        readonly offset = 0
    ) {
        this.targets = new Map(targets.map((target) => [target.id, target]))
        const fileInputs = trace.variables.filter((variable) => variable.role !== 'output' && variable.role !== 'local')
        this.driven = fileInputs.filter(({ name }) => this.targets.get(name)?.input).map(({ name }) => name)
        this.ignored = fileInputs
            .filter(({ name, role }) => role === 'input' && !this.targets.get(name)?.input)
            .map(({ name }) => name)
        this.unset = targets.filter((target) => target.input && !this.driven.includes(target.id)).map(({ id }) => id)
        this.checked = checkOutputs
            ? trace.variables
                  .filter(({ name, role }) => role !== 'input' && role !== 'local' && this.targets.get(name)?.output)
                  .map(({ name }) => name)
            : []
    }

    get length(): number {
        return this.trace.ticks.length
    }

    /** The simulation's tick at which the file ends. */
    get end(): number {
        return this.offset + this.length
    }

    /** The file's row for a tick of the simulation, if the file covers that tick. */
    private row(tick: number): Record<string, unknown> | undefined {
        return tick > this.offset ? this.trace.ticks[tick - this.offset - 1] : undefined
    }

    /** The same file and settings against a fresh run of a model, e.g. after a restart, from tick 1. */
    rebind(targets: ReplayTarget[], modelUri?: string): TraceReplay {
        return new TraceReplay(this.label, this.trace, targets, this.checkOutputs, modelUri)
    }

    /**
     * The values the model reads at `tick` (1-based), in its types. `current` gives an input's
     * present value, which a file value must fit. Empty outside the file.
     */
    inputsFor(tick: number, current: (id: string) => unknown): Map<string, unknown> {
        const values = new Map<string, unknown>()
        const row = this.row(tick)
        if (!row) return values
        this.driven.forEach((name) => {
            if (row[name] === undefined) return
            const target = this.targets.get(name)!
            const value = coerceInput(row[name], target.type)
            if (isCompatibleInput(value, current(name))) {
                values.set(name, value)
            } else if (this.problems.length < MAX_PROBLEMS) {
                const problem = `${name} cannot be ${formatTraceValue(row[name])} (row ${tick - this.offset})`
                if (!this.problems.includes(problem)) this.problems.push(problem)
            }
        })
        return values
    }

    /** Compares the model's outputs after `tick` with the file's. */
    check(tick: number, actual: (id: string) => unknown): ReplayMismatch[] {
        const row = this.row(tick)
        if (!row) return []
        const found = this.checked
            .filter((name) => row[name] !== undefined && !sameTraceValue(actual(name), row[name]))
            .map((name) => ({ tick, name, expected: row[name], actual: actual(name) }))
        if (found.length > 0) this.mismatches.set(tick, found)
        else this.mismatches.delete(tick)
        return found
    }

    /** Forgets what was checked after `tick`, when the simulation went back to it. */
    rewindTo(tick: number): void {
        Array.from(this.mismatches.keys())
            .filter((key) => key > tick)
            .forEach((key) => this.mismatches.delete(key))
    }

    /** The file asks to stop running after this tick (KTrace `pause`). */
    pausesAfter(tick: number): boolean {
        return this.trace.pauses?.includes(tick - this.offset) ?? false
    }

    /** Where the file's value differs from the model's, for one variable. */
    mismatchesOf(name: string): ReplayMismatch[] {
        return Array.from(this.mismatches.values()).flatMap((entries) => entries.filter((entry) => entry.name === name))
    }

    state(tick: number): ReplayState {
        const ticks = Array.from(this.mismatches.keys()).sort((a, b) => a - b)
        const first = ticks.length > 0 ? this.mismatches.get(ticks[0]) : undefined
        return {
            label: this.label,
            length: this.length,
            tick: Math.max(0, Math.min(tick - this.offset, this.length)),
            checked: this.checked,
            ignored: this.ignored,
            unset: this.unset,
            mismatchTicks: ticks.length,
            firstMismatch: first && {
                tick: ticks[0],
                text: first
                    .map(
                        (entry) =>
                            `${entry.name} is ${formatTraceValue(entry.actual)}, the trace has ${formatTraceValue(
                                entry.expected
                            )}`
                    )
                    .join('; '),
            },
            problems: [...this.problems],
            notes: this.trace.notes ?? [],
        }
    }
}

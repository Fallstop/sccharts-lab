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

import { TraceRecord } from './trace-file'

// When the ticks of a run on a timed sequence happen. A timed sequence lists input changes at
// moments in seconds rather than per tick, so models that keep time differently (clocks, or a
// counted timer input) can be run under the same conditions.
// The tests load this file without VS Code, so it must stay free of vscode imports.

/** Times closer than this are the same moment: float sums of periods never land exactly. */
const EPSILON = 1e-9

/** A run stops after this many ticks, in case a model keeps asking to wake up at once. */
export const MAX_TIMED_TICKS = 1000000

/**
 * How a model is ticked. `clock`: at the sequence's moments and whenever the model asks to wake
 * up (its sleep output), with the time since the last tick as the time delta, as KIELER's
 * dynamic ticks do. `timer`: at the sequence's moments and every `period` seconds, with
 * `input` true on the timer's ticks and false on the others. `events`: at the sequence's moments only.
 */
export type TickMode =
    | { kind: 'clock'; delta: string; sleep?: string }
    | { kind: 'timer'; input: string; period: number }
    | { kind: 'events' }

export interface TimedTick {
    /** Seconds since the start of the run. */
    time: number
    /** What the model reads: the sequence's values at this moment, plus the time delta or the timer. */
    inputs: Record<string, unknown>
    /** For a timer: the timer fired at this tick. */
    timer: boolean
}

/** The moments of a timed sequence, with what changes at each. */
export function timedEvents(sequence: TraceRecord): { time: number; values: Record<string, unknown> }[] {
    const { times } = sequence
    if (!times) throw new Error('The sequence has no time column.')
    let last = -Infinity
    return sequence.ticks.map((values, index) => {
        const time = times[index]
        if (!Number.isFinite(time) || time < 0) {
            throw new Error(`Row ${index + 1} of the sequence has no valid time.`)
        }
        if (time < last - EPSILON) {
            throw new Error(
                `The sequence's times must not go backwards: row ${index + 1} is at ${time} s, after ${last} s.`
            )
        }
        last = time
        const changed: Record<string, unknown> = {}
        Object.entries(values).forEach(([name, value]) => {
            if (value !== undefined) changed[name] = value
        })
        return { time, values: changed }
    })
}

/**
 * Hands out the ticks of one run in order. The first tick is at time 0. Call `next` with the
 * model's sleep output after each tick; it returns undefined once the run reaches `until`.
 */
export class TimedSchedule {
    private readonly events: { time: number; values: Record<string, unknown> }[]

    private index = 0

    private now = 0

    private started = false

    private count = 0

    constructor(
        sequence: TraceRecord,
        private readonly mode: TickMode,
        /** Seconds; the last tick is at or before this moment. */
        private readonly until: number
    ) {
        this.events = timedEvents(sequence)
        const inputs = sequence.variables.filter((variable) => variable.role !== 'output' && variable.role !== 'local')
        if (mode.kind === 'clock' && inputs.some((variable) => variable.name === mode.delta)) {
            throw new Error(`A timed sequence must not set ${mode.delta}: the run computes it from the times.`)
        }
        if (mode.kind === 'timer' && !(mode.period > 0)) throw new Error('The timer period must be positive.')
    }

    /** Ticks handed out so far. */
    get ticks(): number {
        return this.count
    }

    next(sleep?: unknown): TimedTick | undefined {
        if (this.count >= MAX_TIMED_TICKS) return undefined
        let time: number
        if (!this.started) {
            time = 0
        } else {
            const candidates = [this.events[this.index]?.time ?? Infinity]
            if (this.mode.kind === 'clock' && typeof sleep === 'number' && sleep > 0) {
                // A float residue can leave a sleep too short to move the clock; still honour it.
                candidates.push(this.now + Math.max(sleep, 1e-6))
            }
            if (this.mode.kind === 'timer') candidates.push(this.nextTimer())
            time = Math.min(...candidates)
            if (!Number.isFinite(time) || time > this.until + EPSILON) return undefined
        }
        const inputs: Record<string, unknown> = {}
        while (this.index < this.events.length && this.events[this.index].time <= time + EPSILON) {
            Object.assign(inputs, this.events[this.index].values)
            this.index++
        }
        let timer = false
        if (this.mode.kind === 'clock') {
            inputs[this.mode.delta] = this.started ? round(time - this.now) : 0
        } else if (this.mode.kind === 'timer') {
            timer = this.started && Math.abs(time - this.nextTimer()) <= EPSILON
            inputs[this.mode.input] = timer
        }
        this.started = true
        this.now = time
        this.count++
        return { time: round(time), inputs, timer }
    }

    /** The first timer edge after the last tick. */
    private nextTimer(): number {
        const { period } = this.mode as { period: number }
        return (Math.floor(this.now / period + EPSILON) + 1) * period
    }
}

function round(value: number): number {
    return Math.round(value * 1e9) / 1e9
}

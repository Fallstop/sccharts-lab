// SPDX-License-Identifier: EPL-2.0
//
// Running a model of the in-browser engine on an input sequence, as the extension's "Run models on a sequence"
// does on KIELER's server (trace-tools.ts runTicked, runTimed): a number of ticks, one per row (the last values
// staying after the sequence ends); or, for a sequence with times, for a number of seconds, ticked at the
// sequence's moments and as the model keeps time (TimedSchedule). The run's trace and the notes the extension puts
// in its report come back; compareTraces and comparisonMarkdown({ preamble }) compare several models' runs.

import { createSimulation } from '@sccharts-lab/engine'
import type { CompileResult } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'
import { inputValue } from './data-pool'
import { initialValue, poolVariables, traceFromRun } from './engine'
import { SimulationReplay } from './engine-replay'
import { isTimeDelta } from './helper'
import { isCompatibleInput } from './input-value'
import { formatTraceValue } from './trace-record'
import type { TraceRecord } from './trace-record'
import { coerceInput } from './trace-replay'
import { MAX_TIMED_TICKS, TimedSchedule } from './trace-timing'
import type { TickMode } from './trace-timing'

export interface SequenceRun {
    trace: TraceRecord
    /** What the extension's report says about the run: inputs the sequence does not set or the model lacks, ... */
    notes: string[]
}

const code = (name: string) => `\`${name}\``

/**
 * Runs `ticks` ticks of a fresh simulation with its inputs from `sequence` (in the model's names: `renameTrace`
 * first where they differ). `label` names the model in the notes.
 */
export function runOnSequence(result: CompileResult, sequence: TraceRecord, ticks: number, options: { label?: string; model?: string } = {}): SequenceRun {
    const label = options.label ?? options.model ?? 'The model'
    const simulation = createSimulation(result)
    const replay = new SimulationReplay(result, simulation, sequence, { label, checkOutputs: false })
    if (ticks > 0) replay.run((step) => step.tick.tick >= ticks)
    // After the sequence's end its last values stay.
    while (simulation.tick < ticks && !replay.error) simulation.step({})
    const trace = traceFromRun(result, simulation, { model: options.model })
    const notes: string[] = []
    const { unset, ignored } = replay.replay
    if (unset.length) {
        const kept = unset.map((name) => `${code(name)} = ${formatTraceValue(trace.ticks[0]?.[name])}`).join(', ')
        notes.push(`${label}: the sequence does not set ${kept} (the value at tick 1).`)
    }
    if (ignored.length) notes.push(`${label} has no input ${ignored.map(code).join(', ')}.`)
    if (replay.error) notes.push(`${label} stopped after ${trace.ticks.length} ticks: ${replay.error.message}.`)
    return { trace, notes }
}

/**
 * Runs a fresh simulation on a timed sequence (`sequence.times`) up to `until` seconds. A model with `deltaT` ticks at
 * the sequence's moments and when its `sleepT` wakes it, with the time since as `deltaT`; another model as `mode`
 * says (default: only at the sequence's moments). The trace has the time of each tick.
 */
export function runOnTimedSequence(
    result: CompileResult,
    sequence: TraceRecord,
    until: number,
    options: { label?: string; model?: string; mode?: TickMode } = {}
): SequenceRun {
    const label = options.label ?? options.model ?? 'The model'
    const variables = poolVariables(result)
    const inputs = variables.filter((v) => v.input)
    const delta = inputs.find((v) => isTimeDelta({ id: v.name, categories: [] }))
    const sleep = variables.find((v) => /^[#_]*sleepT$/i.test(v.name))
    const notes: string[] = []
    let mode: TickMode = options.mode ?? { kind: 'events' }
    if (delta) {
        mode = { kind: 'clock', delta: delta.name, sleep: sleep?.name }
    } else if (mode.kind === 'timer' && !inputs.some((v) => v.name === (mode as { input: string }).input)) {
        notes.push(`${label} has no input ${code(mode.input)}, so it ticked only at the sequence's moments.`)
        mode = { kind: 'events' }
    }
    const simulation = createSimulation(result)
    let schedule: TimedSchedule
    try {
        schedule = new TimedSchedule(sequence, mode, until)
    } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message : error}`)
        return { trace: { variables: [], ticks: [] }, notes }
    }
    const byName = new Map(inputs.map((v) => [v.name, v]))
    const current = new Map<string, unknown>(inputs.map((v) => [v.name, initialValue(v)]))
    const times: number[] = []
    const unfit = new Set<string>()
    let wake: unknown
    let failed: string | undefined
    for (let tick = schedule.next(); tick; tick = schedule.next(wake)) {
        // As the extension queues them: in the inputs' types, refusing values that do not fit.
        const given: Record<string, Value> = {}
        for (const [name, raw] of Object.entries(tick.inputs)) {
            const input = byName.get(name)
            if (!input || raw === undefined) continue
            const value = coerceInput(raw, input.type)
            if (isCompatibleInput(value, current.get(name))) {
                given[name] = value as Value
                current.set(name, value)
            } else {
                unfit.add(name)
            }
        }
        const ran = simulation.step(given)
        if (ran.error) {
            failed = ran.error.message
            break
        }
        for (const v of inputs) if (ran.pool[v.name] !== undefined) current.set(v.name, inputValue(ran.pool[v.name], v.type))
        times.push(tick.time)
        wake = mode.kind === 'clock' && mode.sleep ? ran.pool[mode.sleep] : undefined
    }
    const run = traceFromRun(result, simulation, { model: options.model })
    const trace = { ...run, times: times.slice(0, run.ticks.length) }
    const set = new Set(sequence.variables.filter((v) => v.role !== 'output' && v.role !== 'local').map(({ name }) => name))
    const how =
        mode.kind === 'clock'
            ? `at the sequence's moments and when its clock woke it${mode.sleep ? ` (${code(mode.sleep)})` : ''}`
            : mode.kind === 'timer'
              ? `at the sequence's moments and every ${Number((mode.period * 1000).toFixed(6))} ms, with ${code(mode.input)} true on the timer's ticks`
              : "only at the sequence's moments"
    notes.push(`${label} ticked ${times.length} times, ${how}.`)
    const ignored = Array.from(set).filter((name) => !byName.has(name))
    if (ignored.length > 0) notes.push(`${label} has no input ${ignored.map(code).join(', ')}.`)
    const own = new Set([delta?.name, mode.kind === 'timer' ? mode.input : undefined])
    const unset = inputs.filter((v) => !set.has(v.name) && !own.has(v.name))
    if (unset.length > 0) {
        const kept = unset.map((v) => `${code(v.name)} = ${formatTraceValue(trace.ticks[0]?.[v.name])}`)
        notes.push(`${label}: the sequence does not set ${kept.join(', ')} (the value at the first tick).`)
    }
    if (unfit.size > 0) notes.push(`${label}: the sequence's values for ${Array.from(unfit).join(', ')} do not fit its inputs.`)
    if (failed) notes.push(`${label} stopped after ${times.length} ticks: ${failed}.`)
    if (schedule.ticks >= MAX_TIMED_TICKS) notes.push(`${label} reached ${MAX_TIMED_TICKS} ticks and was stopped.`)
    return { trace, notes }
}

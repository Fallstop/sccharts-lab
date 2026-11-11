// The Trace tab's work, without the DOM (Svelte and the panel are in TraceTab.svelte and trace-tab.ts): a run saved as
// a trace file, a trace file planned as a replay, the run compared with saved traces. The files are the SCCharts Lab
// extension's (@sccharts-lab/trace, byte for byte the same).
//
// A replay is played through the simulation panel as a tour (the machinery of shared runs and of the comparison's
// test run): the file is replayed once into a fresh simulation here (`replayTrace`: inputs matched by name, after the
// renames, in the model's types; outputs checked after every tick), and the inputs each tick read become the tour's
// ticks, each note saying what differed. The engine is deterministic, so the panel's run is this run.

import type { CompileResult } from '@sccharts-lab/engine'
import type { TickResult } from '@sccharts-lab/engine/types'
import {
    comparisonCsv,
    comparisonMarkdown,
    compareTraces,
    formatTraceValue,
    inputsOnly,
    readTrace,
    replayTrace,
    suggestRenames,
    traceColumns,
    traceFromRun,
    TRACE_FORMATS,
    writeTrace,
    type NamedTrace,
    type RenameSuggestion,
    type Renames,
    type ReplayMismatch,
    type ReplayState,
    type TraceComparison,
    type TraceFormat,
    type TraceRecord,
} from '@sccharts-lab/trace'
import { runInputs } from './run-tour'
import type { Scenario } from '../frame/examples'

/** Trace files: what Replay and Compare open, by extension. */
export const TRACE_FILE = /\.(ktrace|csv|json|xml)$/i
export const TRACE_ACCEPT = TRACE_FORMATS.map(f => `.${f.extension}`).join(',')

const code = (s: string) => '`' + s.replace(/`/g, "'") + '`'
const shown = (v: unknown) => (formatTraceValue(v) === '' ? '""' : formatTraceValue(v))

// ----- Save ------------------------------------------------------------------------------------------------------

/** A free file name for a saved run: `<Chart>-run.csv`, `<Chart>-inputs.ktrace`, then `-2`, `-3`. */
export function traceFileName(chart: string, format: TraceFormat, inputs: boolean, taken: Iterable<string> = []): string {
    const ext = TRACE_FORMATS.find(f => f.format === format)!.extension
    const stem = `${chart.replace(/[^\w.-]+/g, '') || 'chart'}-${inputs ? 'inputs' : 'run'}`
    const all = new Set([...taken].map(t => t.toLowerCase()))
    for (let n = 1; ; n++) {
        const name = `${stem}${n > 1 ? `-${n}` : ''}.${ext}`
        if (!all.has(name.toLowerCase())) return name
    }
}

/** The run (its ticks so far) as a file: the whole run, or its inputs as an input sequence. */
export function runFile(result: CompileResult, history: readonly TickResult[], o: { format: TraceFormat; inputs: boolean; model: string }): string {
    const trace = traceFromRun(result, history as Parameters<typeof traceFromRun>[1], { model: o.model })
    return writeTrace(o.inputs ? inputsOnly(trace) : trace, o.format)
}

// ----- Replay ----------------------------------------------------------------------------------------------------

export interface ReplayPlan {
    label: string
    /** The file's names to the model's, applied. */
    renames: Renames
    /** Names in the file that the model lacks and could be one of the model's (`suggestRenames`). */
    suggestions: RenameSuggestion[]
    /** The tour the simulation panel plays: the inputs each tick read, a note per tick. */
    scenario: Scenario
    /** Every output that differs, and per tick. */
    mismatches: ReplayMismatch[]
    byTick: Map<number, ReplayMismatch[]>
    /** The file's inputs that drive the model, and its outputs that are checked. */
    inputs: string[]
    outputs: string[]
    /** Per tick of the file: its values, and the model's after the tick. */
    file: Record<string, unknown>[]
    model: Record<string, unknown>[]
    state: ReplayState
    /** The model stopped at a runtime error (its message, and the tick). */
    error?: { tick: number; message: string }
}

/** The differences of a tick in words: "`count` is 1; the file has 2." */
export function tickNote(mismatches: ReplayMismatch[]): string {
    return mismatches.map(m => `${code(m.name)} is ${code(shown(m.actual))}; the file has ${code(shown(m.expected))}.`).join(' ')
}

/** Reads a trace file; the reader's error (with its line) as the message when it is not one. */
export function readTraceFile(text: string, name: string): { trace: TraceRecord } | { error: string } {
    try {
        return { trace: readTrace(text, name) }
    } catch (e) {
        return { error: (e as Error).message }
    }
}

/** Replays `trace` into a fresh simulation of `result` and plans the tour that shows it in the panel. */
export function planReplay(result: CompileResult, trace: TraceRecord, label: string, renames: Renames = {}): ReplayPlan {
    const columns = traceColumns(result)
    const suggestions = suggestRenames(trace.variables, columns).filter(s => !(s.from in renames))
    const outcome = replayTrace(result, trace, { label, renames })
    const replay = outcome.replay
    const history = replay.simulation.history
    const byTick = new Map<number, ReplayMismatch[]>()
    for (const m of outcome.mismatches) byTick.set(m.tick, [...(byTick.get(m.tick) ?? []), m])
    const { ticks } = runInputs(result, history as TickResult[])
    const errorTick = history.findIndex(t => t.error)
    const scenario: Scenario = {
        expect: 'ok',
        ticks: ticks.map((inputs, i) => {
            const diffs = byTick.get(i + 1)
            const error = history[i]?.error
            return { inputs, note: error ? `The model stopped: ${error.message}` : diffs ? tickNote(diffs) : 'The outputs are the same as in the file.' }
        }),
    }
    const renamedFile = replay.replay.trace
    return {
        label,
        renames,
        suggestions,
        scenario,
        mismatches: outcome.mismatches,
        byTick,
        inputs: replay.replay.driven,
        outputs: replay.replay.checked,
        file: renamedFile.ticks,
        model: outcome.run.ticks,
        state: outcome.state,
        ...(errorTick >= 0 ? { error: { tick: errorTick + 1, message: history[errorTick].error!.message } } : {}),
    }
}

/** The replay in one sentence: how many ticks, how many differ and where first. */
export function replaySummary(plan: ReplayPlan): string {
    const n = plan.state.length
    const ran = plan.model.length
    const ticks = `${n} ${n === 1 ? 'tick' : 'ticks'}`
    if (!plan.outputs.length) return `${ticks}; the file has none of the model's outputs, so nothing is checked.`
    const differing = plan.byTick.size
    if (!differing) return plan.error ? `The outputs match the file until the model stops in tick ${plan.error.tick}.` : `The outputs match the file in all ${ticks}.`
    const first = [...plan.byTick.keys()][0]
    const where = `${differing} of ${ran} ${ran === 1 ? 'tick' : 'ticks'} differ`
    return `${where}; first in tick ${first}: ${tickNote(plan.byTick.get(first)!)}`
}

// ----- Compare ---------------------------------------------------------------------------------------------------

/** The run in the panel (first, the reference) against saved traces: the extension's report and its CSV. */
export function compareRun(result: CompileResult, history: readonly TickResult[], label: string, files: NamedTrace[], model?: string): { comparison: TraceComparison; markdown: string; csv: string } {
    const run: NamedTrace = { label, trace: traceFromRun(result, history as Parameters<typeof traceFromRun>[1], { model }) }
    const comparison = compareTraces([run, ...files])
    return { comparison, markdown: comparisonMarkdown(comparison), csv: comparisonCsv(comparison) }
}

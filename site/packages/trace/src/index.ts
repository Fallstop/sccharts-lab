// SPDX-License-Identifier: EPL-2.0
//
// @sccharts-lab/trace: the SCCharts Lab extension's simulation traces (save, replay, compare) for the web IDE, on
// the in-browser engine. README.md has the API and the formats.

// Files: KTrace (KIELER's), CSV, JSON and XML.
export {
    formatTraceValue,
    inputsOnly,
    printedOf,
    readTrace,
    sameTraceValue,
    timeDeltaOf,
    TRACE_FORMAT_ID,
    TRACE_FORMATS,
    TraceFileError,
    traceFormatOf,
    traceTimes,
    writeTrace,
} from './trace-file'
export type { TraceFormat, TraceRecord, TraceRole, TraceVariable } from './trace-file'

// Comparing runs.
export { compareTraces, valueOf } from './trace-compare'
export type { Alignment, NamedTrace, PrintedComparison, TraceComparison, ValueChange, VariableComparison } from './trace-compare'
export { comparisonCsv, comparisonMarkdown } from './comparison-report'

// Replaying a trace into a model, matching names, timed sequences.
export { coerceInput, TraceReplay } from './trace-replay'
export type { ReplayMismatch, ReplayTarget } from './trace-replay'
export type { ReplayState } from './protocol'
export {
    couldMatch,
    describeRenames,
    forgetAliases,
    nameKey,
    rememberAliases,
    renameTrace,
    sameKind,
    suggestRenames,
    unmatched,
} from './trace-rename'
export type { Alias, NamedVariable, Renames, RenameSuggestion } from './trace-rename'
export { MAX_TIMED_TICKS, TimedSchedule, timedEvents } from './trace-timing'
export type { TickMode, TimedTick } from './trace-timing'

// The in-browser engine's runs as traces, and replaying into its simulations.
export { compareRuns, initialValue, poolVariables, traceColumns, traceFromRun } from './engine'
export type { EngineRun, PoolVariable, TraceOptions } from './engine'
export { replayTargets, replayTrace, SimulationReplay } from './engine-replay'
export type { EngineReplayOptions, ReplayOutcome, ReplayStep } from './engine-replay'
export { runOnSequence, runOnTimedSequence } from './engine-sequence'
export type { SequenceRun } from './engine-sequence'

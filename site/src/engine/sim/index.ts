// The simulator's public face: compile a resolved chart into an executable model (compileChart in compile.ts,
// called from compile() in ../index.ts) and run it (createSimulation). See README.md for the architecture.

import type { Diagnostic, State, TickResult, Value, VariableInfo } from '../types'
import type { ModelIndex } from '../parser/resolve'
import { compileChart, type CompiledChart } from './compile'
import { ExecutableChart, SimRunner, type SimTickResult } from './exec'

export { compileChart, type CompiledChart } from './compile'
export type { PoolValue, SimTickResult } from './exec'
export { describeTick, elementName, rememberImports, type DescribeOptions } from './describe'

/**
 * Codes of the diagnostics the simulator's compilation adds to compile() (KIELER's compiler and code generator
 * stage, after the front end). Tests that compare the front end with KIELER's validator can filter them out.
 */
export const SIMULATOR_CODES: ReadonlySet<string> = new Set([
    'unsupported', 'causality-cycle', 'instantaneous-loop', 'kieler-crash', 'cardinality', 'unsigned-shift',
    'array-assignment', 'vector-ignore', 'string-arithmetic', 'empty-method', 'for-outer-counter', 'val-not-signal', 'duplicate-declaration', 'c-keyword', 'c-name', 'c-string', 'c-float-modulo', 'extern-not-called', 'static-access', 'count-delay-reset',
    'unsupported-combine', 'randomize-tick1', 'randomize-stdlib', 'region-action-final', 'kieler-quirk', 'kieler-bug', 'kieler-loop-warning',
    'kieler-nondeterministic', 'kieler-divergence', 'pre-placement',
    // The kinds of scheduling cycle (all "The SCG is NOT asc-schedulable!" in KIELER).
    'write-conflict', 'update-conflict', 'emission-conflict', 'val-cycle', 'abort-trigger-cycle', 'suspend-abort-cycle', 'period-abort-cycle',
    // Structure passes (references, for-regions, dataflow, clocks, methods).
    'binding-expression', 'recursive-reference', 'for-counter-assignment', 'dataflow-for', 'unknown-type', 'shared-clock',
    'clock-variable', 'clock-array', 'timing-constraint', 'default-sleep', 'method-without-value', 'method-without-return', 'for-counter-method',
    'inheritance-conflict', 'module-call', 'method-twice', 'inline-loop', 'signal-member', 'unpack-instances',
    // Preemption passes (suspend, weak suspend, abort regions).
    'suspend-without-trigger', 'abort-region-order', 'abort-region-alone', 'abort-region-loop',
    // Final polish (engine-5).
    'conditional-without-else', 'index-out-of-range', 'c-array-address',
])

/** The engine's Simulation (docs-internal/ARCHITECTURE.md). */
export interface Simulation {
    readonly interface: VariableInfo[]
    /** Completed ticks. */
    readonly tick: number
    readonly history: SimTickResult[]
    /** Runs one tick. Missing inputs keep their previous value, as in KIELER. */
    step(inputs?: Record<string, Value>): SimTickResult
    reset(): void
    /** Goes back to the state after tick `toTick` (0: before the first tick); later history is dropped. */
    rewind(toTick: number): void
    /** KIELER's taken-transition counters of a tick, in Taken Transition Signaling order (the oracle's `taken`). */
    takenCounts(result: TickResult): number[]
}

/** What createSimulation needs from compile(). */
export interface SimulationInput {
    ok: boolean
    chart?: State
    diagnostics: Diagnostic[]
    interface: VariableInfo[]
    index?: ModelIndex
    /** Set by compile() when the chart passed the simulator's static checks. */
    sim?: CompiledChart
}

export function createSimulation(result: SimulationInput): Simulation {
    if (!result.ok || !result.chart) return rejectedSimulation(result, result.sim)
    const compiled = result.sim ?? compileChart(result.chart, result.index)
    if (!result.ok || !compiled || !compiled.runnable || !result.chart) return rejectedSimulation(result, compiled)
    const exe = new ExecutableChart(compiled, result.interface)
    const runner = new SimRunner(exe, result.chart)
    const history: SimTickResult[] = []
    const inputsLog: Record<string, Value>[] = []
    const snapshots: ReturnType<SimRunner['snapshot']>[] = [runner.snapshot()]
    return {
        interface: result.interface,
        get tick() { return history.length },
        get history() { return history },
        step(inputs: Record<string, Value> = {}) {
            const r = runner.step(history.length + 1, inputs)
            history.push(r)
            inputsLog.push({ ...inputs })
            snapshots.push(runner.snapshot())
            return r
        },
        reset() {
            runner.reset()
            history.length = 0
            inputsLog.length = 0
            snapshots.length = 0
            snapshots.push(runner.snapshot())
        },
        rewind(toTick: number) {
            const n = Math.max(0, Math.min(Math.floor(toTick), history.length))
            runner.restore(snapshots[n])
            history.length = n
            inputsLog.length = n
            snapshots.length = n + 1
        },
        takenCounts(r: TickResult) {
            return runner.takenCounts(r)
        },
    }
}

/** A chart that cannot run: every step reports the first error. */
function rejectedSimulation(result: SimulationInput, compiled: CompiledChart | undefined): Simulation {
    const history: SimTickResult[] = []
    const unsupported = compiled?.diagnostics.find(d => d.code === 'unsupported')
    const error: Diagnostic = result.diagnostics.find(d => d.severity === 'error') ??
        compiled?.diagnostics.find(d => d.severity === 'error') ??
        (unsupported ? { ...unsupported, severity: 'error' } : undefined) ??
        { severity: 'error', code: 'no-chart', message: 'There is no chart to run' }
    return {
        interface: result.interface,
        get tick() { return history.length },
        get history() { return history },
        step(inputs: Record<string, Value> = {}) {
            const r: SimTickResult = {
                tick: history.length + 1, inputs, values: {}, present: {}, active: [], entered: [], exited: [], taken: [], actions: [],
                terminated: false, terminatedNow: false, log: [], printed: [], error, pool: {}, trace: {},
            }
            history.push(r)
            return r
        },
        reset() { history.length = 0 },
        rewind(toTick: number) { history.length = Math.max(0, Math.min(toTick, history.length)) },
        takenCounts() { return [] },
    }
}

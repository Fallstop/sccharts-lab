// SPDX-License-Identifier: EPL-2.0
//
// Replaying a trace into a simulation of the in-browser engine, as the extension's Replay does on KIELER's server:
// the file's inputs drive the model tick by tick (matched by name, after renames, in the model's types), and after
// each tick the model's outputs are checked against the file's. TraceReplay does the matching and the checking;
// this drives a Simulation with it.

import { createSimulation } from '@sccharts-lab/engine'
import type { CompileResult, Simulation, SimTickResult } from '@sccharts-lab/engine'
import type { Diagnostic, Value } from '@sccharts-lab/engine/types'
import { inputValue } from './data-pool'
import { initialValue, poolVariables, traceFromRun } from './engine'
import type { PoolVariable } from './engine'
import type { ReplayState } from './protocol'
import type { TraceRecord } from './trace-record'
import { renameTrace } from './trace-rename'
import type { Renames } from './trace-rename'
import { TraceReplay } from './trace-replay'
import type { ReplayMismatch, ReplayTarget } from './trace-replay'

type Compiled = Pick<CompileResult, 'sim' | 'chart' | 'interface' | 'index'>

export interface EngineReplayOptions {
    /** How the replay names the file, e.g. its file name (ReplayState.label). Default `trace`. */
    label?: string
    /** False when another model's outputs are not expected to match, as in a batch comparison. Default true. */
    checkOutputs?: boolean
    /** The file's names to the model's (`suggestRenames` proposes them); applied before matching. */
    renames?: Renames
}

/** One tick driven by the file. */
export interface ReplayStep {
    tick: SimTickResult
    /** The inputs the file gave this tick, in the model's types. */
    inputs: Record<string, unknown>
    /** Checked outputs that differ from the file after this tick. */
    mismatches: ReplayMismatch[]
    /** The file asks to stop running after this tick (KTrace `pause`). */
    pause: boolean
}

/** What the model's variables are for replaying: every pool variable, inputs and outputs as KIELER marks them. */
export function replayTargets(result: Compiled): ReplayTarget[] {
    return poolVariables(result).map(({ name, input, output, type }) => ({ id: name, input, output, type }))
}

/**
 * Drives `simulation` from a trace, starting with its next tick (the file's first row is the tick after the ones
 * already run, as when the extension starts replaying during a run). `step()` runs one tick of the file;
 * `run()` runs to the end of the file, stopping early where `stop` says so.
 */
export class SimulationReplay {
    readonly replay: TraceReplay

    private readonly variables: Map<string, PoolVariable>

    constructor(
        readonly result: Compiled,
        readonly simulation: Simulation,
        trace: TraceRecord,
        options: EngineReplayOptions = {}
    ) {
        const variables = poolVariables(result)
        this.variables = new Map(variables.map((v) => [v.name, v]))
        const renamed = options.renames ? renameTrace(trace, options.renames) : trace
        this.replay = new TraceReplay(
            options.label ?? 'trace',
            renamed,
            replayTargets(result),
            options.checkOutputs ?? true,
            undefined,
            simulation.tick
        )
    }

    /** The file has driven its last row. */
    get done(): boolean {
        return this.simulation.tick >= this.replay.end
    }

    /** A variable's value after the last tick (before the first: an input's starting value), as the model holds it. */
    private current(name: string): unknown {
        const variable = this.variables.get(name)
        const history = this.simulation.history
        for (let index = history.length - 1; index >= 0; index--) {
            const value = history[index].pool[name]
            if (value !== undefined) return inputValue(value, variable?.type)
        }
        if (!variable?.input) return undefined
        return initialValue(variable)
    }

    /** The value checked against the file: the pool after the tick, a name it leaves out keeping its value. */
    private actual(name: string): unknown {
        const history = this.simulation.history
        for (let index = history.length - 1; index >= 0; index--) {
            const value = history[index].pool[name]
            if (value !== undefined) return value
        }
        return undefined
    }

    /** Runs the next tick with the file's inputs; undefined once the file has ended or the model has stopped. */
    step(): ReplayStep | undefined {
        if (this.done || this.error) return undefined
        const next = this.simulation.tick + 1
        const inputs = Object.fromEntries(this.replay.inputsFor(next, (id) => this.current(id)))
        const tick = this.simulation.step(inputs as Record<string, Value>)
        const mismatches = tick.error ? [] : this.replay.check(tick.tick, (id) => this.actual(id))
        return { tick, inputs, mismatches, pause: this.replay.pausesAfter(tick.tick) }
    }

    /** Runs to the end of the file, or until `stop` returns true for a tick, or a runtime error stops the model. */
    run(stop: (step: ReplayStep) => boolean = () => false): ReplayStep[] {
        const steps: ReplayStep[] = []
        for (let step = this.step(); step; step = this.step()) {
            steps.push(step)
            if (step.tick.error || stop(step)) break
        }
        return steps
    }

    /** The runtime error that stopped the model, if any. */
    get error(): Diagnostic | undefined {
        return this.simulation.history.find((tick) => tick.error)?.error
    }

    /** Goes back to the state after `tick` (simulation and checks), e.g. for stepping back during a replay. */
    rewindTo(tick: number): void {
        this.simulation.rewind(tick)
        this.replay.rewindTo(tick)
    }

    /** What a view shows: progress, the file's inputs the model lacks and the other way round, the first mismatch. */
    state(): ReplayState {
        return this.replay.state(this.simulation.tick)
    }
}

export interface ReplayOutcome {
    replay: SimulationReplay
    /** Every tick that differs, with each output that differs. */
    mismatches: ReplayMismatch[]
    /** The outputs that differ at the first tick that differs. */
    firstMismatch?: ReplayMismatch[]
    /** The replayed run as a trace (what Save would write). */
    run: TraceRecord
    state: ReplayState
    error?: Diagnostic
}

/**
 * Replays the whole trace into a simulation of `result` (a fresh one unless `simulation` is given, which then goes
 * on from its current tick) and reports every output that differs from the file. `stopAtMismatch` stops at the
 * first tick that differs, as the extension's Run does. `model` names the model in the replayed run's trace.
 */
export function replayTrace(
    result: CompileResult,
    trace: TraceRecord,
    options: EngineReplayOptions & { simulation?: Simulation; stopAtMismatch?: boolean; model?: string } = {}
): ReplayOutcome {
    const simulation = options.simulation ?? createSimulation(result)
    const replay = new SimulationReplay(result, simulation, trace, options)
    const steps = replay.run((step) => !!options.stopAtMismatch && step.mismatches.length > 0)
    const mismatches = steps.flatMap((step) => step.mismatches)
    const first = steps.find((step) => step.mismatches.length > 0)
    return {
        replay,
        mismatches,
        ...(first ? { firstMismatch: first.mismatches } : {}),
        run: traceFromRun(result, simulation, { model: options.model }),
        state: replay.state(),
        ...(replay.error ? { error: replay.error } : {}),
    }
}

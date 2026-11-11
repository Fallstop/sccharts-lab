// The engine adapter on small charts: the trace of a run, replaying it step by step, renames, comparison.
// tests/trace/engine-traces.test.ts checks the same against every KIELER recording.

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { compile, createSimulation } from '@sccharts-lab/engine'
import { comparisonMarkdown } from './comparison-report'
import { compareRuns, traceColumns, traceFromRun } from './engine'
import { replayTargets, replayTrace, SimulationReplay } from './engine-replay'
import { inputsOnly, readTrace, writeTrace } from './trace-file'
import { suggestRenames } from './trace-rename'

const COUNTER = `scchart Counter {
  input bool up
  input string name
  output signal int beep
  output int count = 0
  output string shown = "none"
  int hidden = 0
  initial state Idle
    if up do count++; hidden += 2; beep(count); shown = name go to Idle
}
`

/** The same counter with other names and a slower beep: a second implementation to compare. */
const COUNTER_B = `scchart CounterB {
  input bool Up
  input string name
  output signal int beep
  output int count = 0
  output string shown = "none"
  initial state Idle
    if Up do count++; beep(count); shown = name go to Wait
  state Wait
    go to Idle
}
`

function run(source: string, inputs: Record<string, boolean | string>[]) {
    const result = compile(source)
    assert.ok(result.ok)
    const simulation = createSimulation(result)
    for (const values of inputs) simulation.step(values)
    return { result, simulation }
}

const INPUTS: Record<string, boolean | string>[] = [{ up: false, name: 'a' }, { up: true }, { up: true, name: '12' }, { up: false }]

test('a run is a trace with KIELER’s pool as columns: inputs, outputs (a valued signal’s value too), locals', () => {
    const { result, simulation } = run(COUNTER, INPUTS)
    assert.deepEqual(
        traceColumns(result).map(({ name, role, type }) => `${name}:${role}:${type}`),
        // An unset string (name) is not in the pool before tick 1: it comes after the other inputs.
        ['up:input:bool', 'name:input:string', 'beep:output:bool', 'beep_val:output:int', 'count:output:int', 'shown:output:string', 'beep_curval:local:int', 'hidden:local:int']
    )
    const trace = traceFromRun(result, simulation, { model: 'Counter.sctx' })
    assert.equal(trace.model, 'Counter.sctx')
    assert.deepEqual(trace.ticks[2], { up: true, name: '12', beep: true, beep_val: 2, count: 2, shown: '12', beep_curval: 2, hidden: 4 })
    assert.equal(
        writeTrace(trace, 'ktrace'),
        [
            '// Counter.sctx: 4 ticks, saved by SCCharts Lab',
            'up = false name = "a" => beep = false beep_val = 0 count = 0 shown = "none";',
            'up = true => beep = true beep_val = 1 count = 1 shown = "a";',
            'name = "12" => beep_val = 2 count = 2 shown = "12";',
            'up = false => beep = false;',
            '',
        ].join('\n')
    )
    // Replay targets are KIELER's pool in its order (by name within inputs, outputs, the rest).
    assert.deepEqual(
        replayTargets(result).filter((t) => t.input).map((t) => t.id),
        ['name', 'up']
    )
})

test('replaying a run’s file into a fresh simulation gives the run again, in every format', () => {
    const { result, simulation } = run(COUNTER, INPUTS)
    const trace = traceFromRun(result, simulation)
    for (const format of ['ktrace', 'csv', 'json', 'xml'] as const) {
        const outcome = replayTrace(result, readTrace(writeTrace(trace, format), format), { label: `run.${format}` })
        assert.deepEqual(outcome.mismatches, [], format)
        assert.deepEqual(outcome.run.ticks, trace.ticks, format)
        assert.equal(outcome.state.tick, 4, format)
        // A CSV has no roles: its columns that are outputs of the model are checked.
        assert.deepEqual(outcome.state.checked, ['beep', 'beep_val', 'count', 'shown'], format)
    }
})

test('a replay steps tick by tick, stops at the first mismatch, honours pause and can go back', () => {
    const { result: a, simulation: runA } = run(COUNTER, INPUTS)
    const file = readTrace(writeTrace(traceFromRun(a, runA), 'ktrace').replace('up = true =>', 'up = true pause =>'), 'ktrace')
    const b = compile(COUNTER_B)
    // CounterB calls the input Up: matched by spelling, as the extension suggests.
    const renames = Object.fromEntries(suggestRenames(file.variables, traceColumns(b)).map(({ from, to }) => [from, to]))
    assert.deepEqual(renames, { up: 'Up' })
    const replay = new SimulationReplay(b, createSimulation(b), file, { label: 'counter.ktrace', renames })
    assert.deepEqual(replay.replay.driven, ['Up', 'name'])
    const first = replay.step()!
    assert.deepEqual(first.inputs, { Up: false, name: 'a' })
    assert.equal(first.pause, false)
    const second = replay.step()!
    assert.equal(second.pause, true, 'the file pauses after its second row')
    assert.deepEqual(second.mismatches, [])
    const third = replay.step()!
    // CounterB waits a tick after counting: its count lags behind the file's.
    assert.deepEqual(
        third.mismatches.map((m) => [m.name, m.actual, m.expected]),
        [
            ['beep', false, true],
            ['beep_val', 1, 2],
            ['count', 1, 2],
            ['shown', 'a', '12'],
        ]
    )
    assert.equal(replay.state().firstMismatch?.text, 'beep is false, the trace has true; beep_val is 1, the trace has 2; count is 1, the trace has 2; shown is a, the trace has 12')
    assert.equal(replay.state().firstMismatch?.tick, 3)
    replay.rewindTo(2)
    assert.equal(replay.state().mismatchTicks, 0, 'going back forgets the later checks')
    assert.equal(replay.simulation.tick, 2)
    const rest = replay.run((step) => step.mismatches.length > 0)
    assert.equal(rest.length, 1, 'running stops at the first tick that differs')
    assert.equal(replay.done, false)
})

test('the inputs of a run replay into another model; a CSV without roles drives inputs and checks outputs', () => {
    const { result, simulation } = run(COUNTER, INPUTS)
    const sequence = inputsOnly(traceFromRun(result, simulation))
    assert.deepEqual(
        sequence.variables.map((v) => v.name),
        ['up', 'name']
    )
    const b = compile(COUNTER_B)
    const outcome = replayTrace(b, readTrace(writeTrace(sequence, 'csv'), 'csv'), { renames: { up: 'Up' }, checkOutputs: false })
    assert.deepEqual(outcome.state.unset, [])
    assert.deepEqual(outcome.state.checked, [])
    assert.deepEqual(outcome.run.ticks.map((t) => t.count), [0, 1, 1, 1])
})

test('runs of two models compare as their traces', () => {
    const a = run(COUNTER, INPUTS)
    const b = run(COUNTER_B, INPUTS.map(({ up, ...rest }) => ({ ...rest, ...(up === undefined ? {} : { Up: up }) })))
    const comparison = compareRuns([
        { label: 'Counter', ...a, run: a.simulation },
        { label: 'CounterB', ...b, run: b.simulation },
    ])
    const count = comparison.variables.find((v) => v.name === 'count')!
    assert.deepEqual(count.differing, [3, 4])
    assert.ok(comparison.partial.some((p) => p.name === 'hidden'))
    assert.match(comparisonMarkdown(comparison), /\| `count` \| output \| 2 of 4 \|/)
})

test('a runtime error ends the trace; a chart that does not compile has no columns', () => {
    const { result, simulation } = run(
        `scchart Divide {
  input int d
  output int q = 0
  initial state S
    do q = 10 / d go to S
}
`,
        []
    )
    simulation.step({ d: 2 })
    simulation.step({ d: 5 })
    simulation.step({ d: 0 })
    simulation.step({ d: 1 })
    const trace = traceFromRun(result, simulation, { inputs: 'read' })
    assert.deepEqual(
        trace.ticks.map((t) => t.q),
        [0, 2]
    )
    const broken = compile('scchart Broken { initial state A go to Nowhere }')
    assert.deepEqual(traceColumns(broken), [])
    assert.deepEqual(traceFromRun(broken, createSimulation(broken)).ticks, [])
})

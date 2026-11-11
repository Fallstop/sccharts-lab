// Ported from keith-vscode/test/traces.test.cjs: comparison, replay, timed sequences and renames.

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { comparisonCsv, comparisonMarkdown } from './comparison-report'
import { printedRun, run, timedSequence } from './test-fixtures'
import { compareTraces } from './trace-compare'
import type { NamedTrace } from './trace-compare'
import { readTrace, writeTrace } from './trace-file'
import type { TraceRecord, TraceVariable } from './trace-file'
import { couldMatch, forgetAliases, nameKey, rememberAliases, renameTrace, suggestRenames } from './trace-rename'
import type { Alias, NamedVariable } from './trace-rename'
import { TraceReplay } from './trace-replay'
import type { ReplayTarget } from './trace-replay'
import { TimedSchedule } from './trace-timing'

/** Two implementations of one light: B switches a tick later the second time. */
const lights = (): NamedTrace[] => {
    const variables: TraceVariable[] = [
        { name: 'deltaT', role: 'input', type: 'float' },
        { name: 'go', role: 'input', type: 'bool' },
        { name: 'light', role: 'output', type: 'int' },
    ]
    const a = { model: 'A.sctx', variables, ticks: [0, 0, 1, 1, 2, 2].map((light) => ({ deltaT: 0.5, go: false, light })) }
    const b = {
        model: 'B.sctx',
        variables: [...variables, { name: 'now', role: 'local', type: 'int' } as TraceVariable],
        ticks: [0, 0, 1, 1, 1, 2].map((light, now) => ({ deltaT: 0.5, go: false, light, now })),
    }
    return [
        { label: 'A.csv', trace: a },
        { label: 'B.csv', trace: b },
    ]
}

test('a comparison lines up the changes of each variable and measures how far apart they are', () => {
    const comparison = compareTraces(lights())
    assert.deepEqual(
        comparison.variables.map((v) => v.name),
        ['deltaT', 'go', 'light']
    )
    assert.equal(comparison.alignment, 'tick', 'the same deltaT every tick is the same grid')
    const light = comparison.variables[2]
    assert.deepEqual(light.differing, [5])
    assert.ok(light.sameSequence)
    assert.equal(light.worstTickShift, 1)
    assert.equal(light.worstTimeShift, 0.5)
    assert.deepEqual(
        light.changes[1].map((c) => [c.tick, c.time, c.value]),
        [
            [1, 0.5, 0],
            [3, 1.5, 1],
            [6, 3, 2],
        ]
    )
    assert.deepEqual(comparison.partial, [{ name: 'now', labels: ['B.csv'] }])
    assert.equal(comparison.traces[0].duration, 3)
})

test('the comparison report summarises, lists the changes and the ticks that differ', () => {
    const markdown = comparisonMarkdown(compareTraces(lights()), { preamble: ['Ran on seq.csv.'] })
    assert.match(markdown, /^# Trace comparison\n\nRan on seq\.csv\.\n/)
    assert.match(markdown, /\| Reference \| A\.csv \| A\.sctx \| 6 \| 3 s \|/)
    assert.match(markdown, /\*\*Inputs:\*\* the same in every trace \(`deltaT`, `go`\)\./)
    assert.match(markdown, /\| `light` \| output \| 1 of 6 \| tick 5: `2` \/ `1` \| 3 \/ 3 \| yes \| 1 tick \(0\.5 s\) \|/)
    assert.match(markdown, /\| 3 \| `2` at tick 5 \(2\.5 s\) \| `2` at tick 6 \(3 s\) \| \+1 \(\+0\.5 s\) \|/)
    assert.match(markdown, /\*\*Not in every trace:\*\* `now` \(B\.csv\)\./)
    assert.match(markdown, /## Ticks that differ[\s\S]*\| 5 \| `2` \/ `1` \|/)
    const csv = comparisonCsv(compareTraces(lights())).split('\n')
    assert.equal(csv[0], 'variable,role,change,A.csv tick,A.csv time,A.csv value,B.csv tick,B.csv time,B.csv value')
    assert.ok(csv.includes('light,output,3,5,2.5,2,6,3,2'))
})

test('a comparison notices other orders and other inputs', () => {
    const [a, b] = lights()
    b.trace.ticks[4].light = 3
    b.trace.ticks[1].go = true
    const comparison = compareTraces([a, b])
    assert.equal(comparison.alignment, 'tick')
    assert.equal(comparison.variables.find((v) => v.name === 'light')?.sameSequence, false)
    const markdown = comparisonMarkdown(comparison)
    assert.match(markdown, /\*\*Inputs differ:\*\* `go` from tick 2\./)
    assert.match(markdown, /\| \*\*no\*\* \|/)
    assert.throws(() => compareTraces([a]), /at least two/)
})

test('empty cells of the report are a hyphen, as the extension writes them since it dropped em-dashes', () => {
    const [a] = lights()
    const markdown = comparisonMarkdown(compareTraces([a, { label: 'C', trace: { ...a.trace, model: undefined } }]))
    assert.match(markdown, /\| 2 \| C \| - \| 6 \| 3 s \|/)
    assert.doesNotMatch(markdown, /—/)
})

const targets: ReplayTarget[] = [
    { id: 'start', input: true, output: false, type: 'bool' },
    { id: 'name', input: true, output: false, type: 'string' },
    { id: 'deltaT', input: true, output: false, type: 'float' },
    { id: 'count', input: false, output: true, type: 'int' },
]
const sequence = (): TraceRecord => ({
    variables: [
        { name: 'start', role: 'input' },
        { name: 'name', role: 'input' },
        { name: 'Timer', role: 'input' },
        { name: 'count', role: 'output' },
    ],
    ticks: [
        { start: 1, name: 12, Timer: true, count: 0 },
        { start: 0, name: 12, Timer: false, count: 1 },
        { start: 'x', name: 12, Timer: false, count: 2 },
    ],
    pauses: [2],
})
const current: Record<string, unknown> = { start: false, name: '', deltaT: 1 }
const currentOf = (id: string) => current[id]

test('a replay matches inputs by name and gives values in the model’s types', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets)
    assert.deepEqual(replay.driven, ['start', 'name'])
    assert.deepEqual(replay.ignored, ['Timer'])
    assert.deepEqual(replay.unset, ['deltaT'])
    assert.deepEqual(replay.checked, ['count'])
    assert.deepEqual(Object.fromEntries(replay.inputsFor(1, currentOf)), { start: true, name: '12' })
    assert.deepEqual(Object.fromEntries(replay.inputsFor(2, currentOf)), { start: false, name: '12' })
    assert.deepEqual(Object.fromEntries(replay.inputsFor(3, currentOf)), { name: '12' })
    assert.deepEqual(replay.state(3).problems, ['start cannot be x (row 3)'])
    assert.equal(replay.inputsFor(4, currentOf).size, 0, 'nothing past the end')
    assert.ok(replay.pausesAfter(2))
})

test('a replay checks outputs, forgets later mismatches on rewind, and can skip checking', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets, true, 'file:///A.sctx')
    assert.deepEqual(
        replay.check(1, () => 0),
        []
    )
    assert.deepEqual(
        replay.check(2, () => 5),
        [{ tick: 2, name: 'count', expected: 1, actual: 5 }]
    )
    replay.check(3, () => 9)
    assert.equal(replay.state(3).mismatchTicks, 2)
    assert.deepEqual(replay.state(3).firstMismatch, { tick: 2, text: 'count is 5, the trace has 1' })
    assert.deepEqual(
        replay.mismatchesOf('count').map((m) => m.tick),
        [2, 3]
    )
    replay.rewindTo(2)
    assert.equal(replay.state(2).mismatchTicks, 1)
    assert.deepEqual(
        replay.check(2, () => 1),
        [],
        'the same tick run again with the right value'
    )
    assert.equal(replay.state(2).mismatchTicks, 0)
    const rebound = replay.rebind(targets, 'file:///A.sctx')
    assert.equal(rebound.modelUri, 'file:///A.sctx')
    assert.equal(rebound.state(0).mismatchTicks, 0)
    const quiet = new TraceReplay('seq.csv', sequence(), targets, false)
    assert.deepEqual(quiet.checked, [])
    assert.deepEqual(
        quiet.check(2, () => 5),
        []
    )
})

test('a clock model ticks at the sequence’s moments and when its sleep output asks, with the time since', () => {
    const schedule = new TimedSchedule(timedSequence(), { kind: 'clock', delta: 'deltaT', sleep: 'sleepT' }, 2)
    const ticks = []
    // The model sleeps 1 s after every tick.
    for (let tick = schedule.next(); tick; tick = schedule.next(1)) ticks.push([tick.time, tick.inputs.deltaT, tick.inputs.press])
    assert.deepEqual(ticks, [
        [0, 0, false],
        [0.3, 0.3, true],
        [0.4, 0.1, false],
        [1.4, 1, undefined],
    ])
    assert.throws(
        () => new TimedSchedule(readTrace('time,deltaT\n0,1\n', 'csv'), { kind: 'clock', delta: 'deltaT' }, 1),
        /no valid time|has no time column/
    )
})

test('a timer model ticks every period with the timer input set, and at the moments in between with it clear', () => {
    const schedule = new TimedSchedule(timedSequence(), { kind: 'timer', input: 'Timer', period: 0.25 }, 1)
    const ticks = []
    for (let tick = schedule.next(); tick; tick = schedule.next()) ticks.push([tick.time, tick.inputs.Timer, tick.inputs.press])
    assert.deepEqual(ticks, [
        [0, false, false],
        [0.25, true, undefined],
        [0.3, false, true],
        [0.4, false, false],
        [0.5, true, undefined],
        [0.75, true, undefined],
        [1, true, undefined],
    ])
    const events = new TimedSchedule(timedSequence(), { kind: 'events' }, 5)
    const times = []
    for (let tick = events.next(); tick; tick = events.next()) times.push(tick.time)
    assert.deepEqual(times, [0, 0.3, 0.4])
    assert.throws(() => new TimedSchedule(readTrace('time,a\n1,1\n0,2\n', 'csv'), { kind: 'events' }, 1), /must not go backwards/)
})

test('timed runs compare by their recorded times', () => {
    const variables: TraceVariable[] = [{ name: 'light', role: 'output' }]
    const a = { variables, ticks: [{ light: 0 }, { light: 1 }], times: [0, 2] }
    const b = { variables, ticks: [{ light: 0 }, { light: 0 }, { light: 1 }], times: [0, 1, 2.5] }
    const comparison = compareTraces([
        { label: 'A', trace: a },
        { label: 'B', trace: b },
    ])
    assert.equal(comparison.alignment, 'time')
    assert.equal(comparison.until, 2)
    const light = comparison.variables[0]
    assert.equal(light.worstTickShift, 1)
    assert.equal(light.worstTimeShift, 0.5)
    // Moments 0, 1 and 2: B still shows 0 at 2 s, the end of the shorter trace.
    assert.deepEqual(light.differing, [2])
    const markdown = comparisonMarkdown(comparison)
    assert.match(markdown, /compared in time: at every moment one of them ticks, up to 2 s/)
    assert.match(markdown, /\| `light` \| output \| 0 s of 2 s \| 2 s: `1` \/ `0` \| 2 \/ 2 \| yes \| 0\.5 s \|/)
    assert.match(markdown, /\| 2 \| `1` at 2 s \(tick 2\) \| `1` at 2\.5 s \(tick 3\) \| \+0\.5 s \|/)
    assert.match(markdown, /## Moments that differ[\s\S]*\| 2 s \| `1` \/ `0` \|/)
    // Differences in between moments add up to how long the runs disagree.
    const c = { variables, ticks: [{ light: 0 }, { light: 1 }, { light: 0 }, { light: 0 }], times: [0, 0.5, 1.5, 3] }
    const d = { variables, ticks: [{ light: 0 }, { light: 0 }], times: [0, 3] }
    assert.equal(
        compareTraces([
            { label: 'C', trace: c },
            { label: 'D', trace: d },
        ]).variables[0].differingFor,
        1
    )
    assert.match(writeTrace(b, 'csv'), /^tick,time,light\n1,0,0\n2,1,0\n3,2.5,1\n$/)
})

test('a replay started later puts the file’s first row at the next tick', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets, true, undefined, 5)
    assert.equal(replay.inputsFor(5, currentOf).size, 0, 'tick 5 ran before replaying began')
    assert.deepEqual(Object.fromEntries(replay.inputsFor(6, currentOf)), { start: true, name: '12' })
    assert.equal(replay.end, 8)
    assert.ok(replay.pausesAfter(7), 'the file pauses after its row 2')
    assert.deepEqual(
        replay.check(7, () => 9),
        [{ tick: 7, name: 'count', expected: 1, actual: 9 }]
    )
    assert.deepEqual(replay.state(7).firstMismatch?.tick, 7, 'mismatches are at the simulation’s ticks')
    assert.equal(replay.state(7).tick, 2, 'progress counts the file’s rows')
    assert.equal(replay.rebind(targets).offset, 0, 'a restart replays from tick 1')
})

test('the comparison lines up printed lines like value changes', () => {
    const late = printedRun()
    late.printed = [[], [], ['Snapshot taken'], ['a, "quoted"', 'second line', '']]
    const comparison = compareTraces([
        { label: 'A', trace: printedRun() },
        { label: 'B', trace: late },
    ])
    assert.equal(comparison.printed?.sameSequence, true)
    assert.equal(comparison.printed?.worstTickShift, 1)
    const markdown = comparisonMarkdown(comparison)
    assert.match(markdown, /\*\*Printed:\*\* 4 \/ 4 lines; the same text in the same order; largest shift 1 tick\./)
    assert.match(markdown, /## Printed\n\n\| # \| A \| B \| Shift \|/)
    assert.match(markdown, /\| 1 \| `Snapshot taken` at tick 2 \| `Snapshot taken` at tick 3 \| \+1 \|/)
    const csv = comparisonCsv(comparison)
    assert.match(csv, /\n\(printed\),printed,1,2,Snapshot taken,3,Snapshot taken\n/)

    const other = printedRun()
    other.printed = [[], ['Snapshot failed'], [], []]
    const differing = comparisonMarkdown(
        compareTraces([
            { label: 'A', trace: printedRun() },
            { label: 'C', trace: other },
        ])
    )
    assert.match(differing, /\*\*Printed:\*\* 4 \/ 1 lines; \*\*not the same text in the same order\*\*/)
    assert.match(differing, /\| 1 ≠ \| `Snapshot taken` at tick 2 \| `Snapshot failed` at tick 2 \| \+0 \|/)
    // Without prints there is no printed section.
    assert.doesNotMatch(
        comparisonMarkdown(
            compareTraces([
                { label: 'A', trace: run() },
                { label: 'B', trace: run() },
            ])
        ),
        /Printed/
    )
})

test('names that differ only in case and separators are suggested as one, inputs with inputs', () => {
    const file: NamedVariable[] = [
        { name: 'NS_Car', role: 'input' },
        { name: 'ped_button', role: 'input' },
        { name: 'NS_Green', role: 'output' },
        { name: 'extra', role: 'input' },
    ]
    const model: NamedVariable[] = [
        { name: 'nsCar', role: 'input' },
        { name: 'PedButton', role: 'input' },
        { name: 'nsgreen', role: 'output' },
        { name: 'other', role: 'output' },
    ]
    assert.equal(nameKey('NS_Green'), nameKey('ns-green'))
    assert.deepEqual(
        suggestRenames(file, model).map(({ from, to, reason }) => [from, to, reason]),
        [
            ['NS_Car', 'nsCar', 'spelling'],
            ['ped_button', 'PedButton', 'spelling'],
            ['NS_Green', 'nsgreen', 'spelling'],
        ]
    )
    // An input never pairs with an output, however it is spelled.
    assert.deepEqual(suggestRenames([{ name: 'go', role: 'input' }], [{ name: 'GO', role: 'output' }]), [])
    // A file without roles (CSV) pairs with either.
    assert.equal(suggestRenames([{ name: 'go' }], [{ name: 'GO', role: 'output' }]).length, 1)
    // Two names that both fit one are a guess, not a suggestion.
    assert.deepEqual(suggestRenames([{ name: 'a_b' }, { name: 'aB' }], [{ name: 'ab' }]), [])
    // Remembered pairs come first and need no likeness.
    const remembered: Alias[] = [['camera', 'cam']]
    assert.deepEqual(
        suggestRenames([{ name: 'cam' }], [{ name: 'camera' }], remembered).map(({ to, reason }) => [to, reason]),
        [['camera', 'remembered']]
    )
    assert.equal(couldMatch([{ name: 'x', role: 'input' }], [{ name: 'y', role: 'output' }]), false)
    assert.equal(couldMatch([{ name: 'x', role: 'input' }], [{ name: 'y', role: 'input' }]), true)
    assert.equal(couldMatch([{ name: 'x' }], [{ name: 'x' }]), false)
})

test('a renamed trace keeps its values, times and printed lines, and refuses to merge two variables', () => {
    const renamed = renameTrace({ ...printedRun(), times: [0, 1, 2, 3] }, { snap: 'Snap', busy: 'Busy' })
    assert.deepEqual(
        renamed.variables.map(({ name }) => name),
        ['Snap', 'Busy']
    )
    assert.deepEqual(renamed.ticks[1], { Snap: true, Busy: true })
    assert.deepEqual(renamed.times, [0, 1, 2, 3])
    assert.deepEqual(renamed.printed, printedRun().printed)
    // A swap is fine; two names onto one, or onto a name the trace has, is not.
    assert.deepEqual(renameTrace(printedRun(), { snap: 'busy', busy: 'snap' }).ticks[1], { busy: true, snap: true })
    assert.throws(() => renameTrace(printedRun(), { snap: 'x', busy: 'x' }), /cannot both become x/)
    assert.throws(() => renameTrace(printedRun(), { snap: 'busy' }), /has a variable busy already/)
    // A replay then drives the model's input from the renamed column.
    const replay = new TraceReplay('cam.csv', renameTrace(printedRun(), { snap: 'shutter' }), [
        { id: 'shutter', input: true, output: false, type: 'bool' },
    ])
    assert.deepEqual(replay.driven, ['shutter'])
    assert.deepEqual(Array.from(replay.inputsFor(1, () => false)), [['shutter', true]])
})

test('remembered aliases put the newest first and forget declined pairs either way round', () => {
    let aliases = rememberAliases([], { a: 'A' })
    aliases = rememberAliases(aliases, { b: 'B', A: 'a' })
    assert.deepEqual(aliases, [
        ['b', 'B'],
        ['A', 'a'],
    ])
    assert.deepEqual(forgetAliases(aliases, { a: 'A' }), [['b', 'B']])
    assert.equal(rememberAliases([], Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`x${i}`, `y${i}`]))).length, 200)
})

test('renames read only their own names: a variable called constructor keeps its name and values', () => {
    const trace: TraceRecord = { variables: [{ name: 'a', role: 'input' }, { name: 'constructor', role: 'input' }], ticks: [{ a: 1, constructor: 5 }] }
    const renamed = renameTrace(trace, { a: 'A' })
    assert.deepEqual(renamed.variables.map(v => v.name), ['A', 'constructor'])
    assert.deepEqual(renamed.ticks[0], { A: 1, constructor: 5 })
})

test('a rename into a name that stays (no rename, or one to itself) is refused, never two columns of one name', () => {
    const trace: TraceRecord = { variables: [{ name: 'a' }, { name: 'b' }], ticks: [{ a: 1, b: 2 }] }
    assert.throws(() => renameTrace(trace, { a: 'b', b: 'b' }), /already/)
    assert.throws(() => renameTrace(trace, { a: 'b' }), /already/)
    assert.deepEqual(renameTrace(trace, { a: 'b', b: 'a' }).ticks[0], { b: 1, a: 2 })
})

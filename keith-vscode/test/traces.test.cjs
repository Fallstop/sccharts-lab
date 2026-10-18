const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = createLoader()
const { readTrace, writeTrace, traceFormatOf, traceTimes, inputsOnly, sameTraceValue } = load('src/simulation/trace-file.ts')
const { compareTraces, comparisonMarkdown, comparisonCsv } = load('src/simulation/trace-compare.ts')
const { TraceReplay } = load('src/simulation/trace-replay.ts')

/** A run of the Types fixture: every kind of value the data pool holds. */
const run = () => ({
    model: 'Types.sctx',
    variables: [
        { name: 'arr', role: 'input', type: 'int' },
        { name: 'f', role: 'input', type: 'float' },
        { name: 's', role: 'input', type: 'string' },
        { name: 'reset', role: 'input', type: 'bool' },
        { name: 'sum', role: 'output', type: 'int' },
        { name: 'g', role: 'output', type: 'float' },
        { name: 'hidden', role: 'local', type: 'int' },
    ],
    ticks: [
        { arr: [1, 2], f: 1.5, s: 'a "q", b', reset: true, sum: 0, g: 0, hidden: 0 },
        { arr: [1, 2], f: 1.5, s: 'a "q", b', reset: false, sum: 3, g: 3, hidden: 1 },
        { arr: [3, 4], f: 2, s: '12', reset: false, sum: 7, g: 4, hidden: 2 },
    ],
})

test('KTrace is written the way KIELER writes it: changes only, floats with a point, keywords escaped', () => {
    assert.equal(
        writeTrace(run(), 'ktrace'),
        [
            '// Types.sctx: 3 ticks, saved by SCCharts Lab',
            'arr = {1, 2} f = 1.5 s = "a \\"q\\", b" ^reset = true => sum = 0 g = 0.0;',
            '^reset = false => sum = 3 g = 3.0;',
            'arr = {3, 4} f = 2.0 s = "12" => sum = 7 g = 4.0;',
            '',
        ].join('\n')
    )
})

test('KTrace reads back with every value carried forward, and so does what the KIELER server saves', () => {
    const back = readTrace(writeTrace(run(), 'ktrace'), 'ktrace')
    assert.deepEqual(back.variables.map((v) => [v.name, v.role, v.type]), [
        ['arr', 'input', 'int'], ['f', 'input', 'float'], ['s', 'input', 'string'], ['reset', 'input', 'bool'],
        ['sum', 'output', 'int'], ['g', 'output', 'float'],
    ])
    assert.deepEqual(back.ticks[2], { arr: [3, 4], f: 2, s: '12', reset: false, sum: 7, g: 4 })
    // Verbatim output of keith/simulation/saveTrace for the Types fixture.
    const server = readTrace(
        'arr ={1 , 2} f = 1.5 S = true s = "a \\"q\\" b" => g = 0.0 echo = "" sum = 0 T = false ;\n' +
            'S = false => g = 3.0 echo = "a \\"q\\" b" sum = 3 ;\n' +
            'arr ={3 , 4} f = 2.0 => g = 4.0 sum = 7 ;\n',
        'ktrace'
    )
    assert.equal(server.ticks.length, 3)
    assert.deepEqual(server.ticks[2], { arr: [3, 4], f: 2, S: false, s: 'a "q" b', g: 4, echo: 'a "q" b', sum: 7, T: false })
    assert.equal(server.variables.find((v) => v.name === 'g').type, 'float')
})

test('KTrace comments, pragmas, named ticks, pause and further traces are understood', () => {
    const trace = readTrace(
        [
            '#include "other.ktrace"',
            '// a sequence',
            'reset;',
            'first: start = true /* pressed */;',
            ';',
            'start = false => count = -2 pause;',
            'reset;',
            'start = true;',
        ].join('\n'),
        'ktrace'
    )
    assert.deepEqual(trace.ticks, [{ start: true, count: undefined }, { start: true, count: undefined }, { start: false, count: -2 }])
    assert.deepEqual(trace.pauses, [3])
    assert.deepEqual(trace.notes, ['The file holds more than one trace; only the first is used.'])
})

test('KTrace that cannot be replayed is refused with the line and the reason', () => {
    assert.throws(() => readTrace('a = true;\nb = true goto a;', 'ktrace'), /Line 2: Traces that loop with goto/)
    assert.throws(() => readTrace('arr[0] = 1;', 'ktrace'), /Line 1: Assign the whole array/)
    assert.throws(() => readTrace('x = y;', 'ktrace'), /Only literal values can be replayed.*found "y"/)
    assert.throws(() => readTrace('x = 1', 'ktrace'), /Expected ";" at the end/)
    assert.throws(() => readTrace('// nothing\n', 'ktrace'), /no ticks/)
})

test('CSV has a row per tick, a time column next to deltaT, and reads back', () => {
    const timed = {
        variables: [
            { name: 'deltaT', role: 'input', type: 'float' },
            { name: 'note', role: 'input', type: 'string' },
            { name: 'light', role: 'output', type: 'int' },
        ],
        ticks: [
            { deltaT: 0.1, note: 'a, "b"', light: 0 },
            { deltaT: 0.2, note: 'line\nbreak', light: 1 },
            { deltaT: 0.7, note: '', light: undefined },
        ],
    }
    const text = writeTrace(timed, 'csv')
    assert.equal(
        text,
        'tick,time,deltaT,note,light\n1,0.1,0.1,"a, ""b""",0\n2,0.3,0.2,"line\nbreak",1\n3,1,0.7,"",\n'
    )
    assert.deepEqual(traceTimes(timed), [0.1, 0.3, 1])
    const back = readTrace(text, 'csv')
    assert.deepEqual(back.variables.map((v) => v.name), ['deltaT', 'note', 'light'])
    // An empty cell keeps the value of the row before; "" is the empty string.
    assert.deepEqual(back.ticks, [
        { deltaT: 0.1, note: 'a, "b"', light: 0 },
        { deltaT: 0.2, note: 'line\nbreak', light: 1 },
        { deltaT: 0.7, note: '', light: 1 },
    ])
})

test('a hand-written CSV sequence only notes the changes; arrays are JSON', () => {
    const trace = readTrace('﻿start,arr,speed\r\ntrue,"[1,2]",1\r\n,,\r\nfalse,,2.5\r\n', 'csv')
    assert.deepEqual(trace.ticks, [
        { start: true, arr: [1, 2], speed: 1 },
        { start: true, arr: [1, 2], speed: 1 },
        { start: false, arr: [1, 2], speed: 2.5 },
    ])
    assert.equal(trace.variables.find((v) => v.name === 'speed').type, 'float')
    assert.throws(() => readTrace('a,a\n1,2\n', 'csv'), /names a twice/)
    assert.throws(() => readTrace('a\n1,2\n', 'csv'), /Line 2: The row has 2 cells/)
})

test('JSON and XML keep roles and types, and a string input of "12" stays a string', () => {
    for (const format of ['json', 'xml']) {
        const back = readTrace(writeTrace(run(), format), format)
        assert.equal(back.model, 'Types.sctx', format)
        assert.deepEqual(back.variables, run().variables, format)
        assert.deepEqual(back.ticks, run().ticks, format)
    }
    const json = JSON.parse(writeTrace(run(), 'json'))
    assert.equal(json.format, 'sccharts-lab-trace')
    assert.deepEqual(json.ticks[0], {
        tick: 1,
        inputs: { arr: [1, 2], f: 1.5, s: 'a "q", b', reset: true },
        outputs: { sum: 0, g: 0 },
        locals: { hidden: 0 },
    })
    assert.match(writeTrace(run(), 'xml'), /<input name="s">a &quot;q&quot;, b<\/input>/)
})

test('hand-written JSON and XML sequences may be sparse', () => {
    const json = readTrace('{"ticks": [{"inputs": {"start": true}}, {}, {"inputs": {"start": false}}]}', 'json')
    assert.deepEqual(json.ticks, [{ start: true }, { start: true }, { start: false }])
    assert.equal(json.variables[0].role, 'input')
    const xml = readTrace(
        '<trace><!-- by hand --><tick><input name="start">true</input></tick><tick/><tick><input name="start">false</input><value name="x">a &amp; b</value></tick></trace>',
        'xml'
    )
    assert.deepEqual(xml.ticks, [{ start: true, x: undefined }, { start: true, x: undefined }, { start: false, x: 'a & b' }])
    assert.throws(() => readTrace('<trace><tick></trace>', 'xml'), /<\/trace> closes <tick>/)
    assert.throws(() => readTrace('{"ticks": [1]}', 'json'), /Tick 1 is not an object/)
})

test('formats come from the extension; values compare across formats', () => {
    assert.equal(traceFormatOf('a/b/Run.KTRACE'), 'ktrace')
    assert.equal(traceFormatOf('run.csv'), 'csv')
    assert.equal(traceFormatOf('run.txt'), undefined)
    assert.ok(sameTraceValue('12', 12))
    assert.ok(sameTraceValue([1, 2], [1, 2]))
    assert.ok(!sameTraceValue(true, 1))
    assert.deepEqual(inputsOnly(run()).variables.map((v) => v.name), ['arr', 'f', 's', 'reset'])
    assert.deepEqual(Object.keys(inputsOnly(run()).ticks[0]), ['arr', 'f', 's', 'reset'])
})

/** Two implementations of one light: B switches a tick later the second time. */
const lights = () => {
    const variables = [
        { name: 'deltaT', role: 'input', type: 'float' },
        { name: 'go', role: 'input', type: 'bool' },
        { name: 'light', role: 'output', type: 'int' },
    ]
    const a = { model: 'A.sctx', variables, ticks: [0, 0, 1, 1, 2, 2].map((light) => ({ deltaT: 0.5, go: false, light })) }
    const b = { model: 'B.sctx', variables: [...variables, { name: 'now', role: 'local', type: 'int' }], ticks: [0, 0, 1, 1, 1, 2].map((light, now) => ({ deltaT: 0.5, go: false, light, now })) }
    return [{ label: 'A.csv', trace: a }, { label: 'B.csv', trace: b }]
}

test('a comparison lines up the changes of each variable and measures how far apart they are', () => {
    const comparison = compareTraces(lights())
    assert.deepEqual(comparison.variables.map((v) => v.name), ['deltaT', 'go', 'light'])
    assert.equal(comparison.alignment, 'tick', 'the same deltaT every tick is the same grid')
    const light = comparison.variables[2]
    assert.deepEqual(light.differing, [5])
    assert.ok(light.sameSequence)
    assert.equal(light.worstTickShift, 1)
    assert.equal(light.worstTimeShift, 0.5)
    assert.deepEqual(light.changes[1].map((c) => [c.tick, c.time, c.value]), [[1, 0.5, 0], [3, 1.5, 1], [6, 3, 2]])
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
    assert.equal(comparison.variables.find((v) => v.name === 'light').sameSequence, false)
    const markdown = comparisonMarkdown(comparison)
    assert.match(markdown, /\*\*Inputs differ:\*\* `go` from tick 2\./)
    assert.match(markdown, /\| \*\*no\*\* \|/)
    assert.throws(() => compareTraces([a]), /at least two/)
})

const targets = [
    { id: 'start', input: true, output: false, type: 'bool' },
    { id: 'name', input: true, output: false, type: 'string' },
    { id: 'deltaT', input: true, output: false, type: 'float' },
    { id: 'count', input: false, output: true, type: 'int' },
]
const sequence = () => ({
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

test('a replay matches inputs by name and gives values in the model’s types', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets)
    assert.deepEqual(replay.driven, ['start', 'name'])
    assert.deepEqual(replay.ignored, ['Timer'])
    assert.deepEqual(replay.unset, ['deltaT'])
    assert.deepEqual(replay.checked, ['count'])
    const current = { start: false, name: '', deltaT: 1 }
    assert.deepEqual(Object.fromEntries(replay.inputsFor(1, (id) => current[id])), { start: true, name: '12' })
    assert.deepEqual(Object.fromEntries(replay.inputsFor(2, (id) => current[id])), { start: false, name: '12' })
    assert.deepEqual(Object.fromEntries(replay.inputsFor(3, (id) => current[id])), { name: '12' })
    assert.deepEqual(replay.state(3).problems, ['start cannot be x (row 3)'])
    assert.equal(replay.inputsFor(4, (id) => current[id]).size, 0, 'nothing past the end')
    assert.ok(replay.pausesAfter(2))
})

test('a replay checks outputs, forgets later mismatches on rewind, and can skip checking', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets, true, 'file:///A.sctx')
    assert.deepEqual(replay.check(1, () => 0), [])
    assert.deepEqual(replay.check(2, () => 5), [{ tick: 2, name: 'count', expected: 1, actual: 5 }])
    replay.check(3, () => 9)
    assert.equal(replay.state(3).mismatchTicks, 2)
    assert.deepEqual(replay.state(3).firstMismatch, { tick: 2, text: 'count is 5, the trace has 1' })
    assert.deepEqual(replay.mismatchesOf('count').map((m) => m.tick), [2, 3])
    replay.rewindTo(2)
    assert.equal(replay.state(2).mismatchTicks, 1)
    assert.deepEqual(replay.check(2, () => 1), [], 'the same tick run again with the right value')
    assert.equal(replay.state(2).mismatchTicks, 0)
    const rebound = replay.rebind(targets, 'file:///A.sctx')
    assert.equal(rebound.modelUri, 'file:///A.sctx')
    assert.equal(rebound.state(0).mismatchTicks, 0)
    const quiet = new TraceReplay('seq.csv', sequence(), targets, false)
    assert.deepEqual(quiet.checked, [])
    assert.deepEqual(quiet.check(2, () => 5), [])
})

const { TimedSchedule } = load('src/simulation/trace-timing.ts')

/** Input changes at moments in seconds: a press at 0.3 s, released at 0.4 s. */
const timedSequence = () => readTrace('time,press\n0,false\n0.3,true\n0.4,false\n', 'csv')

test('a sequence with a time column and no deltaT is timed, and every format keeps its times', () => {
    const sequence = timedSequence()
    assert.deepEqual(sequence.times, [0, 0.3, 0.4])
    assert.deepEqual(sequence.variables.map((v) => v.name), ['press'])
    for (const format of ['csv', 'json', 'xml']) {
        assert.deepEqual(readTrace(writeTrace(sequence, format), format).times, [0, 0.3, 0.4], format)
    }
    // With deltaT the time column is the running sum, nothing more.
    assert.equal(readTrace('tick,time,deltaT\n1,1,1\n2,3,2\n', 'csv').times, undefined)
    assert.throws(() => readTrace('time,press\n0,false\n,true\n', 'csv'), /Line 3: the row has no time/)
})

test('a clock model ticks at the sequence’s moments and when its sleep output asks, with the time since', () => {
    const schedule = new TimedSchedule(timedSequence(), { kind: 'clock', delta: 'deltaT', sleep: 'sleepT' }, 2)
    const ticks = []
    // The model sleeps 1 s after every tick.
    for (let tick = schedule.next(); tick; tick = schedule.next(1)) ticks.push([tick.time, tick.inputs.deltaT, tick.inputs.press])
    assert.deepEqual(ticks, [[0, 0, false], [0.3, 0.3, true], [0.4, 0.1, false], [1.4, 1, undefined]])
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
    const variables = [{ name: 'light', role: 'output' }]
    const a = { variables, ticks: [{ light: 0 }, { light: 1 }], times: [0, 2] }
    const b = { variables, ticks: [{ light: 0 }, { light: 0 }, { light: 1 }], times: [0, 1, 2.5] }
    const comparison = compareTraces([{ label: 'A', trace: a }, { label: 'B', trace: b }])
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
    assert.equal(compareTraces([{ label: 'C', trace: c }, { label: 'D', trace: d }]).variables[0].differingFor, 1)
    assert.match(writeTrace(b, 'csv'), /^tick,time,light\n1,0,0\n2,1,0\n3,2.5,1\n$/)
})

test('a replay started later puts the file’s first row at the next tick', () => {
    const replay = new TraceReplay('seq.csv', sequence(), targets, true, undefined, 5)
    const current = { start: false, name: '', deltaT: 1 }
    assert.equal(replay.inputsFor(5, (id) => current[id]).size, 0, 'tick 5 ran before replaying began')
    assert.deepEqual(Object.fromEntries(replay.inputsFor(6, (id) => current[id])), { start: true, name: '12' })
    assert.equal(replay.end, 8)
    assert.ok(replay.pausesAfter(7), 'the file pauses after its row 2')
    assert.deepEqual(replay.check(7, () => 9), [{ tick: 7, name: 'count', expected: 1, actual: 9 }])
    assert.deepEqual(replay.state(7).firstMismatch.tick, 7, 'mismatches are at the simulation’s ticks')
    assert.equal(replay.state(7).tick, 2, 'progress counts the file’s rows')
    assert.equal(replay.rebind(targets).offset, 0, 'a restart replays from tick 1')
})

test('in a one-column CSV a blank line is a tick that keeps the value; elsewhere blank lines are spacing', () => {
    assert.deepEqual(readTrace('start\nfalse\ntrue\n\n\nfalse\n\n\n', 'csv').ticks.map((t) => t.start), [false, true, true, true, false])
    assert.deepEqual(readTrace('\na,b\n1,2\n\n3,4\n,\n', 'csv').ticks, [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 3, b: 4 }])
})

const printedRun = () => ({
    model: 'Camera.sctx',
    variables: [
        { name: 'snap', role: 'input', type: 'bool' },
        { name: 'busy', role: 'output', type: 'bool' },
    ],
    ticks: [
        { snap: true, busy: false },
        { snap: true, busy: true },
        { snap: false, busy: false },
        { snap: false, busy: false },
    ],
    printed: [[], ['Snapshot taken'], ['a, "quoted"', 'second line'], ['']],
})

test('printed lines survive CSV, JSON and XML, one CSV cell per tick with its line breaks', () => {
    const csv = writeTrace(printedRun(), 'csv')
    assert.equal(
        csv,
        [
            'tick,printed,snap,busy',
            '1,,true,false',
            '2,Snapshot taken,true,true',
            '3,"a, ""quoted""\nsecond line",false,false',
            '4,"",false,false',
            '',
        ].join('\n')
    )
    for (const format of ['csv', 'json', 'xml']) {
        const back = readTrace(writeTrace(printedRun(), format), format)
        assert.deepEqual(back.printed, printedRun().printed, format)
        assert.deepEqual(back.ticks, printedRun().ticks, format)
    }
    // KTrace has no place for it: a comment KIELER skips, and nothing comes back.
    const ktrace = writeTrace(printedRun(), 'ktrace')
    assert.match(ktrace, /=> busy = true; \/\/ printed "Snapshot taken"\n/)
    assert.match(ktrace, /\/\/ printed "a, \\"quoted\\"" "second line"/)
    assert.equal(readTrace(ktrace, 'ktrace').printed, undefined)
    // An input sequence has no printed text, and a run that printed nothing writes no column.
    assert.equal(inputsOnly(printedRun()).printed, undefined)
    assert.doesNotMatch(writeTrace({ ...printedRun(), printed: [[], [], [], []] }, 'csv'), /printed/)
})

test('variables named time or printed read back as themselves', () => {
    const trace = {
        variables: [
            { name: 'time', role: 'input', type: 'int' },
            { name: 'printed', role: 'output', type: 'bool' },
        ],
        ticks: [
            { time: 1, printed: false },
            { time: 2, printed: true },
        ],
    }
    const csv = writeTrace(trace, 'csv')
    assert.equal(csv.split('\n')[0], 'tick,time,printed,time,printed')
    const back = readTrace(csv, 'csv')
    assert.deepEqual(back.variables.map((variable) => variable.name), ['time', 'printed'])
    assert.deepEqual(back.ticks, trace.ticks)
    assert.equal(back.times, undefined)
    assert.equal(back.printed, undefined)
})

test('the comparison lines up printed lines like value changes', () => {
    const late = printedRun()
    late.printed = [[], [], ['Snapshot taken'], ['a, "quoted"', 'second line', '']]
    const comparison = compareTraces([
        { label: 'A', trace: printedRun() },
        { label: 'B', trace: late },
    ])
    assert.equal(comparison.printed.sameSequence, true)
    assert.equal(comparison.printed.worstTickShift, 1)
    const markdown = comparisonMarkdown(comparison)
    assert.match(markdown, /\*\*Printed:\*\* 4 \/ 4 lines; the same text in the same order; largest shift 1 tick\./)
    assert.match(markdown, /## Printed\n\n\| # \| A \| B \| Shift \|/)
    assert.match(markdown, /\| 1 \| `Snapshot taken` at tick 2 \| `Snapshot taken` at tick 3 \| \+1 \|/)
    const csv = comparisonCsv(comparison)
    assert.match(csv, /\n\(printed\),printed,1,2,Snapshot taken,3,Snapshot taken\n/)

    const other = printedRun()
    other.printed = [[], ['Snapshot failed'], [], []]
    const differing = comparisonMarkdown(compareTraces([{ label: 'A', trace: printedRun() }, { label: 'C', trace: other }]))
    assert.match(differing, /\*\*Printed:\*\* 4 \/ 1 lines; \*\*not the same text in the same order\*\*/)
    assert.match(differing, /\| 1 ≠ \| `Snapshot taken` at tick 2 \| `Snapshot failed` at tick 2 \| \+0 \|/)
    // Without prints there is no printed section.
    assert.doesNotMatch(comparisonMarkdown(compareTraces([{ label: 'A', trace: run() }, { label: 'B', trace: run() }])), /Printed/)
})

const { suggestRenames, renameTrace, couldMatch, rememberAliases, forgetAliases, nameKey } = load(
    'src/simulation/trace-rename.ts'
)

test('names that differ only in case and separators are suggested as one, inputs with inputs', () => {
    const file = [
        { name: 'NS_Car', role: 'input' },
        { name: 'ped_button', role: 'input' },
        { name: 'NS_Green', role: 'output' },
        { name: 'extra', role: 'input' },
    ]
    const model = [
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
    assert.deepEqual(
        suggestRenames([{ name: 'cam' }], [{ name: 'camera' }], [['camera', 'cam']]).map(({ to, reason }) => [to, reason]),
        [['camera', 'remembered']]
    )
    assert.equal(couldMatch([{ name: 'x', role: 'input' }], [{ name: 'y', role: 'output' }]), false)
    assert.equal(couldMatch([{ name: 'x', role: 'input' }], [{ name: 'y', role: 'input' }]), true)
    assert.equal(couldMatch([{ name: 'x' }], [{ name: 'x' }]), false)
})

test('a renamed trace keeps its values, times and printed lines, and refuses to merge two variables', () => {
    const renamed = renameTrace({ ...printedRun(), times: [0, 1, 2, 3] }, { snap: 'Snap', busy: 'Busy' })
    assert.deepEqual(renamed.variables.map(({ name }) => name), ['Snap', 'Busy'])
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
    assert.deepEqual(aliases, [['b', 'B'], ['A', 'a']])
    assert.deepEqual(forgetAliases(aliases, { a: 'A' }), [['b', 'B']])
    assert.equal(rememberAliases([], Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`x${i}`, `y${i}`]))).length, 200)
})

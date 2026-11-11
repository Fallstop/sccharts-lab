// Ported from keith-vscode/test/traces.test.cjs: the trace formats. The same assertions, so a trace this package
// writes is the file the extension writes.

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { printedRun, run, timedSequence } from './test-fixtures'
import { inputsOnly, readTrace, sameTraceValue, traceFormatOf, traceTimes, writeTrace } from './trace-file'
import type { TraceFormat, TraceRecord } from './trace-file'

const variable = (trace: TraceRecord, name: string) => trace.variables.find((v) => v.name === name)

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
    assert.deepEqual(
        back.variables.map((v) => [v.name, v.role, v.type]),
        [
            ['arr', 'input', 'int'],
            ['f', 'input', 'float'],
            ['s', 'input', 'string'],
            ['reset', 'input', 'bool'],
            ['sum', 'output', 'int'],
            ['g', 'output', 'float'],
        ]
    )
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
    assert.equal(variable(server, 'g')?.type, 'float')
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
    assert.deepEqual(trace.ticks, [
        { start: true, count: undefined },
        { start: true, count: undefined },
        { start: false, count: -2 },
    ])
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
    const timed: TraceRecord = {
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
    assert.equal(text, 'tick,time,deltaT,note,light\n1,0.1,0.1,"a, ""b""",0\n2,0.3,0.2,"line\nbreak",1\n3,1,0.7,"",\n')
    assert.deepEqual(traceTimes(timed), [0.1, 0.3, 1])
    const back = readTrace(text, 'csv')
    assert.deepEqual(
        back.variables.map((v) => v.name),
        ['deltaT', 'note', 'light']
    )
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
    assert.equal(variable(trace, 'speed')?.type, 'float')
    assert.throws(() => readTrace('a,a\n1,2\n', 'csv'), /names a twice/)
    assert.throws(() => readTrace('a\n1,2\n', 'csv'), /Line 2: The row has 2 cells/)
})

test('JSON and XML keep roles and types, and a string input of "12" stays a string', () => {
    for (const format of ['json', 'xml'] as const) {
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
    assert.deepEqual(xml.ticks, [
        { start: true, x: undefined },
        { start: true, x: undefined },
        { start: false, x: 'a & b' },
    ])
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
    assert.deepEqual(
        inputsOnly(run()).variables.map((v) => v.name),
        ['arr', 'f', 's', 'reset']
    )
    assert.deepEqual(Object.keys(inputsOnly(run()).ticks[0]), ['arr', 'f', 's', 'reset'])
})

test('readTrace also takes a file name (new in the package)', () => {
    const text = writeTrace(run(), 'csv')
    assert.deepEqual(readTrace(text, 'runs/Run.CSV').ticks, readTrace(text, 'csv').ticks)
    assert.throws(() => readTrace(text, 'run.txt'), /run\.txt is not a trace/)
})

test('a sequence with a time column and no deltaT is timed, and every format keeps its times', () => {
    const sequence = timedSequence()
    assert.deepEqual(sequence.times, [0, 0.3, 0.4])
    assert.deepEqual(
        sequence.variables.map((v) => v.name),
        ['press']
    )
    for (const format of ['csv', 'json', 'xml'] as const) {
        assert.deepEqual(readTrace(writeTrace(sequence, format), format).times, [0, 0.3, 0.4], format)
    }
    // With deltaT the time column is the running sum, nothing more.
    assert.equal(readTrace('tick,time,deltaT\n1,1,1\n2,3,2\n', 'csv').times, undefined)
    assert.throws(() => readTrace('time,press\n0,false\n,true\n', 'csv'), /Line 3: the row has no time/)
})

test('in a one-column CSV a blank line is a tick that keeps the value; elsewhere blank lines are spacing', () => {
    assert.deepEqual(
        readTrace('start\nfalse\ntrue\n\n\nfalse\n\n\n', 'csv').ticks.map((t) => t.start),
        [false, true, true, true, false]
    )
    assert.deepEqual(readTrace('\na,b\n1,2\n\n3,4\n,\n', 'csv').ticks, [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
        { a: 3, b: 4 },
    ])
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
    for (const format of ['csv', 'json', 'xml'] as TraceFormat[]) {
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
    const trace: TraceRecord = {
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
    assert.deepEqual(
        back.variables.map((v) => v.name),
        ['time', 'printed']
    )
    assert.deepEqual(back.ticks, trace.ticks)
    assert.equal(back.times, undefined)
    assert.equal(back.printed, undefined)
})

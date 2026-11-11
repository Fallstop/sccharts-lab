// Running engine models on input sequences, as the extension's "Run models on a sequence".

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { compile } from '@sccharts-lab/engine'
import { runOnSequence, runOnTimedSequence } from './engine-sequence'
import { readTrace } from './trace-file'

const PRESS = `scchart Press {
  input bool press
  input int level
  output int count = 0
  initial state Wait
    if press do count++ go to Wait
}
`

test('a model runs a number of ticks on a sequence, its last values staying after the end', () => {
    const sequence = readTrace('press,mode\ntrue,1\nfalse,1\ntrue,2\n', 'csv')
    const { trace, notes } = runOnSequence(compile(PRESS), sequence, 5, { label: 'Press.sctx', model: 'Press.sctx' })
    assert.deepEqual(
        trace.ticks.map((t) => [t.press, t.count]),
        [
            [true, 0],
            [false, 0],
            [true, 1],
            [true, 2],
            [true, 3],
        ]
    )
    assert.deepEqual(notes, ['Press.sctx: the sequence does not set `level` = 0 (the value at tick 1).'])
    assert.equal(runOnSequence(compile(PRESS), sequence, 2).trace.ticks.length, 2)
})

const TIMED = `scchart Hold {
  input bool press
  output bool lit = false
  clock t
  initial state Off
    if press do lit = true go to On
  state On
    if t >= 1 do lit = false go to Off
}
`

test('a model with a clock ticks at the sequence’s moments and when its sleep output wakes it', () => {
    const sequence = readTrace('time,press\n0,false\n0.3,true\n0.4,false\n', 'csv')
    const { trace, notes } = runOnTimedSequence(compile(TIMED), sequence, 3, { label: 'Hold' })
    assert.equal(trace.times?.[0], 0)
    assert.deepEqual(trace.times?.slice(0, 3), [0, 0.3, 0.4])
    assert.deepEqual(
        trace.ticks.slice(0, 3).map((t) => t.deltaT),
        [0, 0.3, 0.1]
    )
    assert.match(notes[0], /^Hold ticked \d+ times, at the sequence's moments and when its clock woke it \(`sleepT`\)\.$/)
    const press = compile(PRESS)
    const events = runOnTimedSequence(press, sequence, 3, { label: 'Press', mode: { kind: 'timer', input: 'tick', period: 0.5 } })
    assert.deepEqual(events.trace.times, [0, 0.3, 0.4])
    assert.equal(events.notes[0], "Press has no input `tick`, so it ticked only at the sequence's moments.")
    const timer = runOnTimedSequence(compile(PRESS.replace('input int level', 'input bool tick')), sequence, 1, { mode: { kind: 'timer', input: 'tick', period: 0.5 } })
    assert.deepEqual(
        timer.trace.ticks.map((t) => [timer.trace.times![timer.trace.ticks.indexOf(t)], t.tick]),
        [
            [0, false],
            [0.3, false],
            [0.4, false],
            [0.5, true],
            [1, true],
        ]
    )
})

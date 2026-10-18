const assert = require('node:assert/strict')
const { test } = require('node:test')
const { StepController } = require('./load-typescript.cjs')()('src/simulation/step-controller.ts')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('slow server acknowledgements apply back pressure and pause/resume never duplicates a loop', async (t) => {
    let count = 0
    const steps = new StepController(async () => { count++ })
    t.after(() => steps.reset())
    const first = steps.run(() => 1)
    await sleep(15)
    assert.equal(count, 1)
    steps.pause()
    const second = steps.run(() => 1)
    assert.equal(count, 1)
    steps.acknowledge()
    await sleep(15)
    assert.equal(count, 2)
    steps.reset()
    await Promise.all([first, second])
    await sleep(15)
    assert.equal(count, 2)
})

test('reset cancels pending ticks and wakes sleeping run loops', async () => {
    let count = 0
    const steps = new StepController(async () => { count++ })
    const running = steps.run(() => 60000)
    steps.acknowledge()
    await Promise.resolve()
    steps.reset()
    await running
    assert.equal(count, 1)
})

test('send failure and missing tick responses fail instead of hanging', async () => {
    const failed = new StepController(async () => { throw new Error('disconnected') })
    await assert.rejects(failed.step(), /disconnected/)
    const stalled = new StepController(async () => {}, 10)
    await assert.rejects(stalled.step(), /did not respond/)
})

test('a paced run waits for what pace returned before the next tick, even at delay 0', async (t) => {
    let count = 0
    const steps = new StepController(async () => {
        count++
        // The server answers at once.
        setImmediate(() => steps.acknowledge())
    })
    t.after(() => steps.reset())
    const draws = []
    const run = steps.run(
        () => 0,
        () => new Promise((resolve) => draws.push(resolve))
    )
    await sleep(15)
    assert.equal(count, 1, 'the second tick waits for the first one to be drawn')
    draws.shift()()
    await sleep(15)
    assert.equal(count, 2)
    // Without a pace the run does not wait.
    steps.pause()
    await run
    let free = 0
    const unpaced = new StepController(async () => {
        free++
        setImmediate(() => unpaced.acknowledge())
    })
    const loop = unpaced.run(() => 0)
    await sleep(15)
    unpaced.reset()
    await loop
    assert.ok(free > 2, `${free} ticks`)
})

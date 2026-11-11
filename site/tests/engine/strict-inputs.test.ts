// The engine package as a program uses it: `strict` catches an input name that is no input of the chart (a typo), with
// the input it most likely meant; without it the name goes into the data pool, as in KIELER's simulation. And a broken
// import says how to give the engine the other files.
import { describe, expect, test } from 'vitest'
import { compile, createSimulation } from '@sccharts-lab/engine'

const TOGGLE = 'scchart Toggle {\n  input bool button\n  input signal int level\n  output bool light = false\n  initial state Off\n    if button do light = true go to On\n  state On\n}\n'

describe('input names', () => {
    test('strict: a typo throws, naming the input it most likely meant; the inputs and a valued signal\'s _val pass', () => {
        const sim = createSimulation(compile(TOGGLE), { strict: true })
        expect(() => sim.step({ buton: true })).toThrow(/`buton` is not an input of the chart \(did you mean `button`\?\)/)
        expect(sim.tick).toBe(0)
        sim.step({ button: true, level: true, level_val: 3 })
        // Tick 1 enters the initial state; its delayed transition fires in tick 2.
        expect(sim.step({ button: true }).values.light).toBe(true)
    })
    test('without strict, KIELER\'s behaviour: the name goes into the data pool and the chart does not see it', () => {
        const tick = createSimulation(compile(TOGGLE)).step({ buton: true })
        expect(tick.values.light).toBe(false)
        expect(tick.pool.buton).toBe(true)
    })
})

describe('a broken import', () => {
    test('says how to give the engine the other files', () => {
        const d = compile('import "missing"\nscchart X {\n  initial state A\n}\n').diagnostics.find(x => x.code === 'broken-import')
        expect(d?.hint).toContain('compile(source, { files })')
        expect(d?.hint).not.toContain('In this guide')
    })
})

describe('an input given as undefined', () => {
    test('keeps its value, as one left out does (a list of steps of different shapes type-checks)', () => {
        const sim = createSimulation(compile(TOGGLE))
        const steps: { button?: boolean; level?: boolean }[] = [{ button: true }, { level: true }]
        sim.step(steps[0])
        expect(sim.step({ button: undefined, ...steps[1] }).values.light).toBe(true)
    })
})

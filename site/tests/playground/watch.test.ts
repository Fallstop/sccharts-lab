// The simulation's watch (watch.ts): an expression over the chart's data pool, evaluated by the engine for the tick
// shown, as the chart itself would evaluate it.
import { describe, expect, test } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { Value } from '../../src/engine/types'
import { compileWatch, holds, type Watch, type WatchTick } from '../../src/components/playground/watch'
import fs from 'node:fs'

const chart = `scchart Mix {
  input int x
  input float f
  input bool b
  input signal S
  input signal int V
  output int y
  output string name = "idle"
  int arr[3] = {1, 2, 3}
  immediate during do y = (x * 7) / 3 + pre(x)
  initial state A
}
`
const compiled = compile(chart)
const watch = (text: string): Watch => {
    const w = compileWatch(text, compiled)
    if ('error' in w) throw new Error(w.error)
    return w
}
/** Each tick of a run with these inputs, as the panel reports it (the data pool and the engine's trace). */
function run(inputs: Record<string, Value>[], c = compiled): WatchTick[] {
    const sim = createSimulation(c)
    return inputs.map(i => sim.step(i) as WatchTick)
}
const pools = run([
    { x: 4, f: 0.5, b: true, S: false, V: true, V_val: 5 },
    { x: 10, f: 1.5, b: false, S: true, V: false },
    { x: -7, f: 2, b: true },
])
const at = (text: string, n: number) => watch(text).at(pools, n)

describe('the watch', () => {
    test('means what it means in the chart: the same expression gives the chart\'s own output', () => {
        expect(compiled.ok).toBe(true)
        for (const n of [2, 3]) expect(at('(x * 7) / 3 + pre(x)', n)).toEqual({ value: pools[n - 1].pool!.y })
    })

    test("C's arithmetic: integer division truncates, a float operand makes it a float", () => {
        expect(at('x / 3', 3)).toEqual({ value: -2 })
        expect(at('x % 3', 3)).toEqual({ value: -1 })
        expect(at('x + f', 2)).toEqual({ value: 11.5 })
        expect(at('x > 5 && !b', 2)).toEqual({ value: true })
        expect(at('b ? x : 0', 2)).toEqual({ value: 0 })
    })

    test('signals: a name is its presence, val() its value (kept while absent), pre() the tick before', () => {
        expect(at('S', 1)).toEqual({ value: false })
        expect(at('S', 2)).toEqual({ value: true })
        expect(at('val(V) * 2', 2)).toEqual({ value: 10 })
        expect(at('pre(S) || V', 2)).toEqual({ value: false })
        expect(at('pre(V)', 2)).toEqual({ value: true })
        expect(at('pre(pre(x))', 3)).toEqual({ value: 4 })
    })

    test('locals and arrays by index; not strings, which C compares by where they are stored', () => {
        expect(at('arr[1] + arr[2]', 1)).toEqual({ value: 5 })
        expect((compileWatch('name == "idle"', compiled) as { error: string }).error).toMatch(/^The watch cannot read strings/)
    })

    test('pre needs the ticks before; no tick, no value', () => {
        expect(at('pre(x)', 1)).toEqual({ none: '`pre` has a value from tick 2 on.' })
        expect(at('pre(pre(x))', 2)).toEqual({ none: '`pre` has a value from tick 3 on.' })
        expect(at('x', 0)).toEqual({ none: 'Run a tick first.' })
    })

    test('what it cannot be, said in words', () => {
        const error = (text: string) => (compileWatch(text, compiled) as { error: string }).error
        expect(error('')).toBe('Type an expression.')
        expect(error('x +')).toMatch(/./)
        expect(error('z > 1')).toBe("`z` is not one of the chart's inputs, outputs or variables.")
        expect(error('a.b > 1')).toBe('`a.b` is not a member of an instance, a variable of a state (written as `State.name`) or a value of an enum.')
        expect(error('arr > 1')).toBe('`arr` is an array: give an index, as in `arr[0]`.')
        expect(error('x = 3; y')).toBe('One expression, without a semicolon.')
        expect(error('val(x)')).toBe('`val` reads the value of a valued signal.')
        expect(error('random()')).toMatch(/not calls, random\(\) or host code/)
    })

    test('the locals of inner states, as `State.name` or by their name alone, from the engine\'s trace', () => {
        // learn/hierarchy/shadow: the output `count` and `Outer`'s own `count` (10, then 11 once press holds).
        const shadow = compile(fs.readFileSync('src/examples/learn/hierarchy/shadow.sctx', 'utf8'))
        const ticks = run([{ press: false }, { press: true }], shadow)
        const value = (text: string, n: number) => {
            const w = compileWatch(text, shadow)
            if ('error' in w) throw new Error(w.error)
            return w.at(ticks, n)
        }
        // A pool name wins: `count` is the output (1); `Outer.count` the local.
        expect(value('count', 2)).toEqual({ value: 1 })
        expect(value('Outer.count', 1)).toEqual({ value: 10 })
        expect(value('Outer.count', 2)).toEqual({ value: 11 })
        expect(value('Outer.count - pre(Outer.count) + seen', 2)).toEqual({ value: 12 })
        // A name only an inner state has, alone.
        const inner = compile('scchart In {\n  input bool tap\n  initial state Run {\n    int laps = 0\n    signal int lap\n    initial state A\n      if tap do laps++; lap(laps) go to A\n  }\n}\n')
        expect(inner.ok).toBe(true)
        const t2 = run([{ tap: true }, { tap: true }, { tap: true }, { tap: false }], inner)
        const w = compileWatch('laps * 10 + val(Run.lap)', inner)
        if ('error' in w) throw new Error(w.error)
        // An absent valued signal keeps its value: tick 4 has no lap, `val` is still 2.
        expect([1, 2, 3, 4].map(n => w.at(t2, n))).toEqual([{ value: 0 }, { value: 11 }, { value: 22 }, { value: 22 }])
        expect((compileWatch('Run.lap', inner) as { error: string }).error).toBe('The watch can read the value of `Run.lap`, a valued signal of an inner state, as `val(Run.lap)`, but not its presence.')
        // Two inner states with a variable of the same name: say which to write.
        const two = compile('scchart Two {\n  region A:\n  initial state P {\n    int n = 1\n    initial state X\n  }\n  region B:\n  initial state Q {\n    int n = 2\n    initial state Y\n  }\n}\n')
        expect((compileWatch('n > 0', two) as { error: string }).error).toBe('Several inner states have a variable `n`: write `P.n` or `Q.n`.')
        const both = compileWatch('P.n + Q.n', two)
        if ('error' in both) throw new Error(both.error)
        expect(both.at(run([{}], two), 1)).toEqual({ value: 3 })
    })

    test('members of instances and enum values', () => {
        // advanced/data-types/scoreboard: each instance's own `count`.
        const board = compile(fs.readFileSync('src/examples/advanced/data-types/scoreboard.sctx', 'utf8'))
        const ticks = run([{}, { homeGoal: true }, { homeGoal: true, awayGoal: true }], board)
        const w = compileWatch('home.count * 10 + away.count', board)
        if ('error' in w) throw new Error(w.error)
        expect([1, 2, 3].map(n => w.at(ticks, n))).toEqual([{ value: 0 }, { value: 10 }, { value: 21 }])
        const whole = compileWatch('home', board)
        expect('error' in whole ? whole.error : '').toBe("`home` is not one of the chart's inputs, outputs or variables.")
        // advanced/data-types/fan: `Speed.HIGH` is 2, its position, as KIELER's Enum processor makes it.
        const fan = compile(fs.readFileSync('src/examples/advanced/data-types/fan.sctx', 'utf8'))
        const spins = run([{ button: true }, { button: true }, { button: true }, { button: true }], fan)
        const high = compileWatch('speed == Speed.HIGH', fan)
        if ('error' in high) throw new Error(high.error)
        // Tick 1 enters Run; then OFF to LOW, LOW to HIGH, HIGH to OFF.
        expect([1, 2, 3, 4].map(n => high.at(spins, n))).toEqual([{ value: false }, { value: false }, { value: true }, { value: false }])
        expect((compileWatch('speed == Speed.FAST', fan) as { error: string }).error).toBe('`Speed` has no value `FAST`: its values are `OFF`, `LOW`, `HIGH`.')
    })

    test('Run until stops where it holds: true, or a number other than 0', () => {
        expect(holds({ value: true })).toBe(true)
        expect(holds({ value: 2 })).toBe(true)
        expect(holds({ value: 0 })).toBe(false)
        expect(holds({ value: false })).toBe(false)
        expect(holds({ none: 'x' })).toBe(false)
    })
})

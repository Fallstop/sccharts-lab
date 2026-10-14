// `show` beyond KIELER's data pool: the locals of inner states and regions (`Outer.count`, by the engine's key
// `Chart.Outer$count`, or by a name no other variable has) and the members of instances (`home.count`), traced from
// `SimTickResult.trace`; and the build-time check that names a typo.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation, traceableVariables } from '../../src/engine/index'
import { lanesFor, qualifiedName, resolveShow, traceRows, traceSvg } from '../../src/components/sim/trace'
import { showProblems } from '../../src/components/frame/show'

const read = (id: string) => fs.readFileSync(new URL(`../../src/examples/${id}.sctx`, import.meta.url), 'utf8')
const run = (source: string, inputs: Record<string, unknown>[]) => {
    const c = compile(source)
    const sim = createSimulation(c)
    return { c, traceable: traceableVariables(c), history: inputs.map((i) => sim.step(i as never)) }
}

describe('show: inner locals', () => {
    // learn/hierarchy's Shadowing: the output `count` and `Outer`'s own local `count`.
    const { c, traceable, history } = run(read('learn/hierarchy/shadow'), [{ press: false }, { press: true }, { press: false }])

    it('resolves a local by its qualified name or its engine key, and the pool name first', () => {
        const inner = traceable.find((v) => !v.inPool)!
        expect(inner.key).toBe('Shadowing.Outer$count')
        expect(qualifiedName(inner, c.chart)).toBe('Outer.count')
        for (const name of ['Outer.count', 'Shadowing.Outer$count']) {
            expect(resolveShow([name], c.interface, c.chart, traceable).targets).toEqual([{ trace: inner }])
        }
        // `count` is the output (KIELER's data pool wins).
        expect(resolveShow(['count'], c.interface, c.chart, traceable).targets[0].pool?.name).toBe('count')
    })

    it('draws the inner local from the trace, named by its state where two lanes would share a name', () => {
        const lanes = lanesFor(c.interface, c.chart, ['count', 'Outer.count'], false, [], traceable)
        expect(lanes.map((l) => [l.name, l.role])).toEqual([
            ['count', 'output'],
            ['Outer.count', 'local'],
        ])
        expect(lanes[1].title).toBe('local int count of state Outer')
        const rows = traceRows(lanes, history)
        // The press in tick 2 increments Outer's count (10 to 11); the output stays 1.
        expect(rows[0].values).toEqual([1, 1, 1])
        expect(rows[1].values).toEqual([10, 11, 11])
        // Alone, it keeps its own name.
        expect(lanesFor(c.interface, c.chart, ['Outer.count'], false, [], traceable).map((l) => l.name)).toEqual(['count'])
    })

    it('leaves inner names out without the traceable list (and never throws)', () => {
        expect(lanesFor(c.interface, c.chart, ['Outer.count'], false).length).toBe(0)
    })

    it('draws a lane per name once, and traces the same into the SVG', () => {
        const lanes = lanesFor(c.interface, c.chart, ['Outer.count', 'Shadowing.Outer$count'], false, [], traceable)
        expect(lanes.length).toBe(1)
        expect(traceSvg(lanes, { history, cursor: 3, width: 640 })).toContain('11')
    })
})

describe('show: a bare name, signals and booleans', () => {
    const source = `scchart Inner {
  input bool tap
  output bool done
  region Main:
  initial state Run {
    signal S
    bool flag = false
    int n = 0
    initial state A
      if tap do S; flag = true; n++ go to B
    state B
      if tap do n++ go to A
  }
  region Other:
  initial state Idle {
    int n = 5
    initial state I
  }
}`
    const { c, traceable, history } = run(source, [{ tap: false }, { tap: true }, { tap: true }])

    it('compiles', () => expect(c.ok).toBe(true))

    it('takes a name no other variable has, and says when several inner locals share one', () => {
        expect(resolveShow(['flag'], c.interface, c.chart, traceable).targets.map((t) => t.trace?.name)).toEqual(['flag'])
        const r = resolveShow(['n'], c.interface, c.chart, traceable)
        expect(r.targets).toEqual([])
        expect(r.ambiguous).toEqual([{ name: 'n', candidates: ['Run.n', 'Idle.n'] }])
        expect(resolveShow(['nope'], c.interface, c.chart, traceable).unknown).toEqual(['nope'])
    })

    it('draws a local signal as its presence and a local bool as a level', () => {
        const lanes = lanesFor(c.interface, c.chart, ['S', 'flag', 'Run.n', 'Idle.n'], false, [], traceable)
        expect(lanes.map((l) => [l.name, l.kind, !!l.presence])).toEqual([
            ['S', 'bool', true],
            ['flag', 'bool', false],
            ['Run.n', 'value', false],
            ['Idle.n', 'value', false],
        ])
        const rows = traceRows(lanes, history)
        expect(rows[0].values).toEqual([false, true, false])
        expect(rows[1].values).toEqual([false, true, true])
        expect(rows[2].values).toEqual([0, 1, 2])
        expect(rows[3].values).toEqual([5, 5, 5])
    })
})

describe('show: members of instances', () => {
    const { c, traceable, history } = run(read('advanced/data-types/scoreboard'), [
        { homeGoal: false, awayGoal: false, newMatch: false },
        { homeGoal: true },
        { homeGoal: false, awayGoal: true },
    ])

    it('traces a member by instance.member', () => {
        const lanes = lanesFor(c.interface, c.chart, ['homeScore', 'home.count', 'away.count'], false, [], traceable)
        expect(lanes.map((l) => [l.name, l.title])).toEqual([
            ['homeScore', 'output int homeScore'],
            ['home.count', 'member int count of home'],
            ['away.count', 'member int count of away'],
        ])
        const rows = traceRows(lanes, history)
        expect(rows[1].values).toEqual([0, 1, 1])
        expect(rows[2].values).toEqual([0, 0, 1])
    })
})

describe('showProblems (the build-time check of <Sim show> and <Compare show>)', () => {
    const shadow = compile(read('learn/hierarchy/shadow'))
    const board = compile(read('advanced/data-types/scoreboard'))

    it('accepts pool names, inner locals and members', () => {
        expect(showProblems(['press', 'count', 'Outer.count'], [shadow])).toBeUndefined()
        expect(showProblems(['home.count'], [board])).toBeUndefined()
        // Compare: a name counts when either chart has it.
        expect(showProblems(['Outer.count', 'home.count'], [shadow, board])).toBeUndefined()
    })

    it('names the typo and what is known', () => {
        expect(showProblems(['Outer.cnt'], [shadow])).toBe(
            'show names Outer.cnt, but Shadowing has no variable of that name (top-level, added by the compiler, an inner local as State.name, or a member as instance.member). Known: press, count, seen, Outer.count.'
        )
        expect(showProblems(['x'], [shadow, board])).toMatch(/^show names x, but neither Shadowing nor Scoreboard has a variable of that name/)
    })
})

// Timing diagram details: per-chart termination in Compare, termination in the difference line, short traces that
// write values in full, suspended spans, for-region copies (one lane per copy, and the diagram's count badge), and
// the trace's hidden table that must not widen the scroll area.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { TickResult } from '../../src/engine/types'
import { hatchPath, renderWave } from '../../src/components/frame/wave'
import { columnWidthFor, columnWidthForTrace, compareSvg, forCopiesIn, hasSuspension, lanesFor, regionLanes, terminationText, traceRows, traceSvg, type CopyState } from '../../src/components/sim/trace'

const read = (id: string) => fs.readFileSync(new URL(`../../src/examples/${id}.sctx`, import.meta.url), 'utf8')
const tick = (t: Partial<TickResult> & { tick: number }): TickResult => ({
    inputs: {}, values: {}, present: {}, active: [], entered: [], exited: [], taken: [], actions: [], terminated: false, log: [], printed: [], ...t,
})
const run = (id: string, inputs: Record<string, unknown>[]) => {
    const c = compile(read(id))
    const sim = createSimulation(c)
    return { c, history: inputs.map((i) => sim.step(i as never)) }
}

describe('termination when two charts run together', () => {
    const a = { name: 'OnceBool', history: [tick({ tick: 1 }), tick({ tick: 2, terminated: true }), tick({ tick: 3, terminated: true })] }
    const b = { name: 'Once', history: [tick({ tick: 1 }), tick({ tick: 2 }), tick({ tick: 3 })] }

    it('says which chart terminated, in that tick and later', () => {
        expect(terminationText(a, b, 1)).toBe('')
        expect(terminationText(a, b, 2)).toBe('`OnceBool` terminated in tick 2; `Once` did not.')
        expect(terminationText(a, b, 3)).toBe('`OnceBool` terminated in tick 2; `Once` has not.')
        expect(terminationText(b, a, 2)).toBe('`OnceBool` terminated in tick 2; `Once` did not.')
    })

    it('says when the second one catches up, and when both terminate together', () => {
        const late = { name: 'Late', history: [tick({ tick: 1 }), tick({ tick: 2 }), tick({ tick: 3, terminated: true })] }
        expect(terminationText(a, late, 3)).toBe('`Late` terminated in tick 3, `OnceBool` earlier, in tick 2.')
        expect(terminationText(a, a, 2)).toBe('Both charts terminated in tick 2.')
        expect(terminationText(a, a, 3)).toBe('')
        // After Back: only the ticks up to the one shown count.
        expect(terminationText(a, late, 2)).toBe('`OnceBool` terminated in tick 2; `Late` did not.')
    })

    it('draws a termination triangle in each chart\'s own caption row', () => {
        const once = run('learn/signals/once', [{ start: false }, { start: true }])
        const bool = run('learn/signals/once-bool', [{ start: false }, { start: true }])
        const inputs = lanesFor(once.c.interface.filter((v) => v.input), undefined)
        const svg = compareSvg(
            inputs,
            once.history,
            { name: 'Once', lanes: lanesFor(once.c.interface, once.c.chart), history: once.history },
            { name: 'OnceBool', lanes: lanesFor(bool.c.interface, bool.c.chart), history: bool.history },
            { cursor: 2, width: 600 },
        )
        expect((svg.match(/class="wv-term"/g) ?? []).length).toBe(1)
        expect(svg).toContain('<title>OnceBool terminated in this tick</title>')
        expect(svg).toContain('Tick 2, shown, OnceBool terminated')
    })
})

describe('short traces write values in full', () => {
    it('widens the columns while every tick fits, and keeps them narrow once the trace is long', () => {
        const { c, history } = run('advanced/for-regions/copy-order', [{}])
        const lanes = lanesFor(c.interface, c.chart)
        const rows = traceRows(lanes, history)
        expect(columnWidthFor(lanes)).toBeLessThan(48)
        expect(columnWidthForTrace(lanes, rows, 1, 640, 60)).toBeGreaterThanOrEqual(5 * 7.2 + 14)
        expect(columnWidthForTrace(lanes, rows, 40, 640, 60)).toBe(columnWidthFor(lanes))
        const svg = traceSvg(lanes, { history, cursor: 1, width: 640 })
        expect(svg).toContain('>97321</text>')
        expect(svg).not.toContain('97…')
    })
})

describe('the hidden table', () => {
    it('sits in a hidden wrapper, so a long run does not widen the trace\'s scroll area', () => {
        const html = renderWave([{ name: 'x', kind: 'value', values: [1, 2, 3] }], { columns: 3, table: true })
        expect(html).toMatch(/<div class="sc-visually-hidden wv-table-wrap"><table class="wv-table">[\s\S]*<\/table><\/div>$/)
    })
})

describe('suspended spans', () => {
    it('hatches a state lane in the ticks a suspend freezes it, and says so in the table', () => {
        const { c, history } = run('advanced/suspend/microwave', [{ doorOpen: false }, { doorOpen: false }, { doorOpen: true }, { doorOpen: true }, { doorOpen: false }])
        const lanes = lanesFor(c.interface, c.chart)
        expect(hasSuspension(lanes, history)).toBe(true)
        const inner = lanes.find((l) => l.name === 'Cooking')!
        expect(history.map((t) => inner.suspended!(t))).toEqual([false, false, true, true, false])
        const svg = traceSvg(lanes, { history, cursor: 5, width: 640 })
        expect((svg.match(/class="wv-hatch"/g) ?? []).length).toBe(1)
        expect(svg).toContain('<td>Heating, suspended</td>')
        // The lane of the region the suspended state is in is not frozen.
        expect(history.map((t) => lanes.find((l) => l.name === 'state')!.suspended!(t))).toEqual([false, false, false, false, false])
    })

    it('draws hatching inside its box', () => {
        const d = hatchPath(10, 20, 30, 10, 5)
        for (const [, x, y] of d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)) {
            expect(Number(x)).toBeGreaterThanOrEqual(10)
            expect(Number(x)).toBeLessThanOrEqual(40)
            expect(Number(y)).toBeGreaterThanOrEqual(20)
            expect(Number(y)).toBeLessThanOrEqual(30)
        }
    })
})

describe('for-region copies', () => {
    const { c } = run('advanced/for-regions/seatbelts', [{}])
    const chart = c.chart!
    const region = 'Seatbelts.Checking:Seat'
    const copy = (value: number, state: string, entered = false): CopyState => ({ region, value, active: [`Seatbelts.Checking.${state}`], entered: entered ? [`Seatbelts.Checking.${state}`] : [] })
    const t1 = tick({ tick: 1, active: ['Seatbelts', 'Seatbelts.Checking', 'Seatbelts.Checking.Open'], ...{ copies: [0, 1, 2, 3].map((v) => copy(v, 'Open', true)) } })
    const t2 = tick({
        tick: 2,
        active: ['Seatbelts', 'Seatbelts.Checking', 'Seatbelts.Checking.Open', 'Seatbelts.Checking.Fastened'],
        ...{ copies: [copy(0, 'Open'), copy(1, 'Fastened', true), copy(2, 'Open'), copy(3, 'Fastened', true)] },
    })

    it('finds the copies the ticks report', () => {
        expect(forCopiesIn([t1, t2])).toEqual([{ region, counter: '', values: [0, 1, 2, 3] }])
        expect(forCopiesIn([tick({ tick: 1 })])).toEqual([])
    })

    it('gives each copy a lane of its own, named with the counter', () => {
        const lanes = regionLanes(chart, forCopiesIn([t1, t2]))
        expect(lanes.map((l) => l.name)).toEqual(['state', 'Seat i=0', 'Seat i=1', 'Seat i=2', 'Seat i=3'])
        expect(lanes.map((l) => l.sample(t2))).toEqual(['Checking', 'Open', 'Fastened', 'Open', 'Fastened'])
        expect(lanes[2].entered!(t2)).toBe(true)
        expect(lanes[1].entered!(t2)).toBe(false)
        expect(lanes[1].title).toBe('Active state of region Seat (in Checking), in the copy with i = 0')
    })

    it('keeps one lane per region when the ticks report no copies', () => {
        expect(regionLanes(chart).map((l) => l.name)).toEqual(['state', 'Seat'])
    })

    it('draws the engine\'s own report: the copies before the first tick (CompileResult.forCopies), then per tick', () => {
        const { c: real, history } = run('advanced/for-regions/seatbelts', [{ buckled: [true, false, false, false] }, {}, { buckled: [true, true, false, true] }])
        const forCopies = (real as typeof real & { forCopies?: { region: string; counter: string; values: number[] }[] }).forCopies
        expect(forCopies).toEqual([{ region, counter: 'i', values: [0, 1, 2, 3], name: 'Seat' }])
        const lanes = lanesFor(real.interface, real.chart, undefined, true, forCopies)
        expect(lanes.map((l) => l.name)).toEqual(['buckled', 'chime', 'state', 'Seat i=0', 'Seat i=1', 'Seat i=2', 'Seat i=3'])
        expect(traceRows(lanes, history).slice(3).map((r) => r.values)).toEqual([
            ['Open', 'Fastened', 'Fastened'],
            ['Open', 'Open', 'Fastened'],
            ['Open', 'Open', 'Open'],
            ['Open', 'Open', 'Fastened'],
        ])
    })

    it('names the copies of an unnamed for-region of the chart "region i=n"', () => {
        const { c: real, history } = run('advanced/for-regions/local-per-copy', [{}])
        const names = lanesFor(real.interface, real.chart, undefined, true, forCopiesIn(history)).map((l) => l.name)
        expect(names).toEqual(['sum', 'region i=1', 'W i=1', 'region i=2', 'W i=2', 'region i=3', 'W i=3'])
    })
})

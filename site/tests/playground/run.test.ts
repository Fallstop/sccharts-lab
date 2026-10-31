// "Copy link to this run": the inputs of every tick in the link (share.ts), replayed as a tour (run-tour.ts). The
// replay must be the same run: every example with a scenario is run, shared, decoded and replayed through the
// panel's own model (Timeline), tick by tick.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { TickResult, Value } from '../../src/engine/types'
import { Timeline } from '../../src/components/sim/timeline'
import { initialInputs } from '../../src/components/sim/inputs'
import { chartFromHash, decodeRun, encodeRun, hasRun, makeRun, MAX_RUN_TICKS, runFromHash, runUrl, sourceFromHash, type SharedRun } from '../../src/components/playground/share'
import { inputChanges, runInputs, sharedRunTour } from '../../src/components/playground/run-tour'

const chart = `scchart Mixer {
  input signal int V
  input int level[3]
  input string tag
  input bool press
  output int o = 0

  initial state A
    if V do o = val(V) + level[1] go to A
}
`

/** Runs `inputs` (what the reader sent, tick by tick) and returns the engine's history. */
function run(source: string, inputs: Record<string, Value>[]): TickResult[] {
    const sim = createSimulation(compile(source))
    for (const i of inputs) sim.step(i)
    return sim.history
}

/** What a run looks like, tick by tick: the values, the presence of signals, the active states. */
const shape = (h: TickResult[]) => h.map(t => JSON.stringify([t.values, t.present, [...t.active].sort(), t.error?.message ?? null]))

/** The run a reader shares: the inputs every tick ran with, and the tick shown. */
function share(source: string, history: TickResult[], cursor: number): SharedRun & { exact: number } {
    const found = runInputs(compile(source), history)
    return { ...makeRun(found.ticks, cursor), exact: found.exact }
}

const plain = ({ ticks, at }: SharedRun): SharedRun => ({ ticks, at })

/** Replays a shared run as SimPanel does: a Timeline with the tour, stepped through every scripted tick. */
function replay(source: string, shared: SharedRun): TickResult[] {
    const compiled = compile(source)
    const tour = sharedRunTour(shared, compiled.interface)
    const timeline = new Timeline(createSimulation(compiled), initialInputs(compiled.interface), tour)
    for (let i = 0; i < tour.ticks.length; i++) timeline.step()
    return timeline.history
}

describe('the run in the link', () => {
    test('round trip: valued signals, arrays, strings; a string never set is left out', () => {
        const history = run(chart, [{}, { V: true, V_val: 4, level: [1, 2] }, { press: true }, {}, { V: false, tag: 'x' }])
        const shared = share(chart, history, 3)
        expect(shared.exact).toBe(5)
        expect(shared.at).toBe(3)
        expect(shared.ticks).toHaveLength(5)
        expect(shared.ticks[0]).not.toHaveProperty('tag')
        expect(shared.ticks[1]).toEqual({ V: true, V_val: 4, level: [1, 2, 0], press: false })
        expect(shared.ticks[4]).toEqual({ V: false, V_val: 4, level: [1, 2, 0], press: true, tag: 'x' })
        expect(decodeRun(encodeRun(shared))).toEqual(plain(shared))
    })

    test('only the changes are stored, so a long run of the same inputs stays short', () => {
        const history = run(chart, Array.from({ length: 300 }, (_, i) => ({ press: i % 50 === 0 })))
        const enc = encodeRun(share(chart, history, 300))
        expect(enc.length).toBeLessThan(400)
        expect(enc).toMatch(/^[A-Za-z0-9+\-$]+$/)
        expect(decodeRun(enc)!.ticks).toHaveLength(300)
    })

    test('the tick shown is kept within the run', () => {
        const history = run(chart, [{}, {}])
        expect(share(chart, history, 0).at).toBe(1)
        expect(share(chart, history, 9).at).toBe(2)
        expect(decodeRun(encodeRun({ ticks: [{}, {}], at: 7 }))!.at).toBe(2)
    })

    test('a run is cut after MAX_RUN_TICKS ticks', () => {
        const rows = Array.from({ length: MAX_RUN_TICKS + 5 }, () => ({ a: false }))
        expect(makeRun(rows, MAX_RUN_TICKS + 5).ticks).toHaveLength(MAX_RUN_TICKS)
        expect(makeRun(rows, MAX_RUN_TICKS + 5).at).toBe(MAX_RUN_TICKS)
    })

    test('damaged or foreign runs give null', () => {
        expect(decodeRun('')).toBeNull()
        expect(decodeRun('not lz')).toBeNull()
        expect(runFromHash('#run=%%%')).toBeNull()
        expect(runFromHash('#code=abc')).toBeNull()
        expect(hasRun('#code=abc&run=xyz')).toBe(true)
        expect(hasRun('#code=abc')).toBe(false)
    })

    test('links: an example as it is keeps ?example=; anything else carries its source', () => {
        const shared: SharedRun = { ticks: [{ press: true }, { press: true }], at: 2 }
        const a = new URL(runUrl('https://sccharts.jmw.nz/playground/?example=old&solution=x#code=old', shared, { example: 'learn/first-chart/toggle' }))
        expect(a.search).toBe('?example=learn/first-chart/toggle')
        expect(runFromHash(a.hash)).toEqual(shared)
        expect(sourceFromHash(a.hash)).toBeNull()
        const b = new URL(runUrl('https://sccharts.jmw.nz/playground/?example=old', shared, { source: chart }))
        expect(b.search).toBe('')
        expect(sourceFromHash(b.hash)).toBe(chart)
        expect(runFromHash(b.hash)).toEqual(shared)
        expect(chartFromHash(b.hash)).toBeUndefined()
        // Another chart of the file than the first is named.
        const c = new URL(runUrl('https://sccharts.jmw.nz/playground/', shared, { source: chart, name: 'Second' }))
        expect(chartFromHash(c.hash)).toBe('Second')
        expect(runFromHash(c.hash)).toEqual(shared)
        expect(chartFromHash('#chart=%E0')).toBeUndefined()
        expect(chartFromHash('#chart=a%20b')).toBeUndefined()
    })
})

describe('the replay is the same run', () => {
    test('a chart that writes its own input: the tick ran with what its trigger read, the input keeps what the chart wrote', () => {
        const source = `scchart Latch {\n  input int x = 0\n  input signal S\n  output int y = 0\n\n  initial state A\n    if x > 2 do x = 0; y++; S go to A\n}\n`
        const history = run(source, [{ x: 1 }, { x: 3 }, {}, { x: 5 }, {}])
        // The engine reports the value after the tick (0); the tick ran with 3.
        expect(history[1].inputs.x).toBe(0)
        const shared = share(source, history, 5)
        expect(shared.exact).toBe(5)
        expect(shared.ticks.map(t => t.x)).toEqual([1, 3, 0, 5, 0])
        expect(shape(replay(source, decodeRun(encodeRun(shared))!))).toEqual(shape(history))
    })

    test('a value only an effect read before the chart overwrote it: the engine reports what the tick ran with (ranWith)', () => {
        const source = `scchart Swap {\n  input bool press\n  input int x = 0\n  output int y = 0\n\n  initial state A\n    if press do y = x; x = 0 go to A\n}\n`
        const history = run(source, [{}, { press: true, x: 5 }, {}])
        expect(history[1].values.y).toBe(5)
        expect(history[1].inputs.x).toBe(0)
        const shared = share(source, history, 3)
        expect(shared.exact).toBe(3)
        expect(shared.ticks.map(t => t.x)).toEqual([0, 5, 0])
        expect(shape(replay(source, decodeRun(encodeRun(shared))!))).toEqual(shape(history))
    })

    test('the inputs are the engine\'s ranWith, checked by a replay', () => {
        const history = run(chart, [{ press: true }, { V: true, V_val: 3 }])
        // A result changed by hand (another run's inputs) no longer replays the same: exact says from which tick.
        const forged = history.map((t, i) => (i === 1 ? { ...t, ranWith: { ...t.ranWith!, V_val: 9 } } : t))
        expect(runInputs(compile(chart), history).exact).toBe(2)
        expect(runInputs(compile(chart), forged)).toMatchObject({ exact: 1, ticks: [{ press: true }, { V: true, V_val: 9 }] })
    })

    test('every example with a scenario', () => {
        const root = path.resolve('src/examples')
        const ids: string[] = []
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) walk(full)
                else if (e.name.endsWith('.scenario.json')) ids.push(full.slice(0, -'.scenario.json'.length))
            }
        }
        walk(root)
        let checked = 0
        for (const id of ids) {
            const scenario = JSON.parse(fs.readFileSync(`${id}.scenario.json`, 'utf8'))
            if (scenario.expect === 'error' || scenario.imports?.length || !fs.existsSync(`${id}.sctx`)) continue
            const source = fs.readFileSync(`${id}.sctx`, 'utf8')
            const compiled = compile(source)
            if (!compiled.ok || compiled.diagnostics.some(d => d.code === 'unsupported')) continue
            const history = run(source, scenario.ticks.map((t: { inputs?: Record<string, Value> }) => t.inputs ?? {}))
            if (!history.length) continue
            const found = share(source, history, history.length)
            expect(found.exact, path.relative(root, id)).toBe(history.length)
            expect(shape(replay(source, decodeRun(encodeRun(found))!)), path.relative(root, id)).toEqual(shape(history))
            checked++
        }
        expect(checked).toBeGreaterThan(100)
    })
})

describe('the notes of a shared run', () => {
    const iface = compile(chart).interface

    test('say which inputs changed, and where the others stand, in the guide\'s words', () => {
        const tour = sharedRunTour({ ticks: [{ press: false }, { V: true, V_val: 4, press: false }, { V: true, V_val: 4, press: true }, { V: true, V_val: 5, press: true }, { V: false, V_val: 5, press: true }, { V: false, V_val: 5, press: true, level: [1, 0, 0] }, { V: false, V_val: 5, press: true, level: [1, 0, 0], tag: 'hi' }], at: 1 }, iface)
        expect(tour.ticks.map(t => t.note)).toEqual([
            'In tick 1 every input has its initial value: `V` is absent (its value is `0`); `level` is `{0, 0, 0}`; `tag` is unset; `press` is `false`.',
            'In this tick `V` is present with the value `4`; `level` stays `{0, 0, 0}`; `tag` stays unset; `press` stays `false`.',
            'In this tick `press` is `true`; `V` stays present with the value `4`; `level` stays `{0, 0, 0}`; `tag` stays unset.',
            'In this tick `V` has the value `5`; `level` stays `{0, 0, 0}`; `tag` stays unset; `press` stays `true`.',
            'In this tick `V` is absent; `level` stays `{0, 0, 0}`; `tag` stays unset; `press` stays `true`.',
            'In this tick `level` is `{1, 0, 0}`; `V` stays absent (its value is `5`); `tag` stays unset; `press` stays `true`.',
            'In this tick `tag` is `"hi"`; `V` stays absent (its value is `5`); `level` stays `{1, 0, 0}`; `press` stays `true`.',
        ])
        expect(tour.ticks[1].inputs).toEqual({ V: true, V_val: 4, press: false })
    })

    test('inputs that stand alike are named together; tick 1 says what every input is', () => {
        const abro = compile('scchart ABRO {\n  input signal A, B, R\n  output signal O\n  initial state S\n}\n').interface
        const tour = sharedRunTour({ ticks: [{ A: true, B: false, R: false }, { A: false, B: true, R: false }, { A: false, B: true, R: false }, { A: true, B: true, R: true }], at: 1 }, abro)
        expect(tour.ticks.map(t => t.note)).toEqual([
            'In tick 1 `A` is present; `B` and `R` are absent.',
            'In this tick `A` is absent and `B` is present; `R` stays absent.',
            'In this tick no input changes: `A` and `R` stay absent; `B` stays present.',
            'In this tick `A` is present and `R` is present; `B` stays present.',
        ])
    })

    test('a chart with many inputs: only what changed; a chart without inputs says so', () => {
        const many = compile(`scchart Many {\n  input bool ${Array.from({ length: 7 }, (_, i) => `i${i}`).join(', ')}\n  initial state S\n}\n`).interface
        expect(sharedRunTour({ ticks: [{ i0: true }, { i0: true }], at: 1 }, many).ticks.map(t => t.note)).toEqual(['In tick 1 `i0` is `true`.', 'In this tick no input changes.'])
        const none = compile('scchart Alone {\n  output int n = 0\n  initial state S\n    do n++ go to S\n}\n').interface
        expect(sharedRunTour({ ticks: [{}, {}], at: 1 }, none).ticks.map(t => t.note)).toEqual(['The chart has no inputs.', 'The chart has no inputs.'])
    })

    test('several changes in one sentence', () => {
        expect(inputChanges({ press: false, V: false }, { press: true, V: true, tag: 'hi' }, iface)).toEqual(['`press` is `true`', '`V` is present', '`tag` is `"hi"`'])
    })
})

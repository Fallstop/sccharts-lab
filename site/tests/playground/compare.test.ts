// "Compare with the model solution": the reader's chart on the solution's scenario, outputs against KIELER's
// recording of the solution, in plain words.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { compile, createSimulation, type CompileResult, type Simulation } from '../../src/engine/index'
import { compareWithSolution, summary, tickList } from '../../src/components/playground/compare'

// A simulation can be replaced for one compile result (a construct the simulator meets only when a tick reaches it).
const fakes = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('../../src/engine/index', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/engine/index')>()
    return { ...actual, createSimulation: (r: CompileResult) => (fakes.get(r) as Simulation | undefined) ?? actual.createSimulation(r) }
})

const ex = (id: string) => path.resolve('src/examples', id)
const read = (id: string) => fs.readFileSync(`${ex(id)}.sctx`, 'utf8')
const json = (id: string, kind: string) => JSON.parse(fs.readFileSync(`${ex(id)}.${kind}.json`, 'utf8'))
const solution = (id: string) => ({ scenario: json(id, 'scenario'), recording: json(id, 'oracle') })

/** Every exercise of the guide: [starter, solution], from the pages' <TryIt>. */
function exercises(): [string, string][] {
    const out: [string, string][] = []
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) walk(full)
            else if (e.name.endsWith('.mdx')) {
                for (const m of fs.readFileSync(full, 'utf8').matchAll(/<TryIt\b([^>]*)>/g)) {
                    const a = /example="([^"]+)"/.exec(m[1])?.[1], s = /solution="([^"]+)"/.exec(m[1])?.[1]
                    if (a && s) out.push([a, s])
                }
            }
        }
    }
    walk(path.resolve('src/content/docs'))
    return out
}

describe('compare with the model solution', () => {
    test('a starter that does not count yet: the first difference in plain words', () => {
        const { scenario, recording } = solution('learn/actions/stopwatch-solution')
        const c = compareWithSolution(compile(read('learn/actions/stopwatch-start')), scenario, recording)
        expect(c.status).toBe('differs')
        expect(c.interface).toEqual([])
        expect(c.outputs.sort()).toEqual(['elapsed', 'running'])
        expect(c.ticks.slice(0, 2)).toEqual([true, true])
        expect(c.differences[0].message).toBe('In tick 3 your `elapsed` is 0; the model solution has 1.')
        expect(c.firstTick?.tick).toBe(3)
        expect(summary(c)).toBe("Your outputs (`elapsed`, `running`) match the model solution's in ticks 1 and 2. In tick 3 your `elapsed` is 0; the model solution has 1.")
    })
    test('the solution itself matches, and so does every exercise solution of the guide', () => {
        const all = exercises()
        expect(all.length).toBeGreaterThan(10)
        for (const [, sol] of all) {
            if (!fs.existsSync(`${ex(sol)}.scenario.json`) || !fs.existsSync(`${ex(sol)}.oracle.json`)) continue
            const { scenario, recording } = solution(sol)
            if (!recording.ok) continue
            const c = compareWithSolution(compile(read(sol)), scenario, recording)
            expect([c.status, c.differences.slice(0, 2), c.interface], sol).toEqual(['match', [], []])
            expect(summary(c), sol).toMatch(/match(es)? the model solution's in all \d+ ticks/)
        }
    })
    test('interface problems are named, and the rest is still compared', () => {
        const { scenario, recording } = solution('learn/actions/stopwatch-solution')
        const reader = compile(`scchart Stopwatch {
  input bool start
  output int running = 0
  output int elapsed = 0
  initial state S
}`)
        const c = compareWithSolution(reader, scenario, recording)
        expect(c.interface.map(p => [p.kind, p.name])).toEqual(expect.arrayContaining([['missing-input', 'stop'], ['type', 'running']]))
        expect(c.interface.find(p => p.name === 'running')?.message).toBe('Output `running` is an int in your chart; in the model solution it is a bool.')
        expect(c.outputs).toEqual(['elapsed'])
        const missing = compareWithSolution(compile('scchart S {\n  input bool start, stop\n  initial state A\n}'), scenario, recording)
        expect(missing.status).toBe('cannot')
        expect(missing.interface.map(p => p.message)).toContain("Your chart has no output `elapsed`; the model solution's is an int.")
    })
    test('compile errors and charts with nothing to run', () => {
        const { scenario, recording } = solution('learn/actions/stopwatch-solution')
        const c = compareWithSolution(compile('scchart S {\n  output bool running\n  initial state A\n  go to B\n}'), scenario, recording)
        expect(c.status).toBe('cannot')
        expect(c.reason).toBe('Your chart does not compile yet, so it cannot be compared.')
        expect(c.errors?.length).toBeGreaterThan(0)
    })
    test('a chart the guide cannot run (host code) cannot run in the browser, so it is not compared', () => {
        const { scenario, recording } = solution('advanced/host-code/gauge-method')
        const c = compareWithSolution(compile(read('advanced/host-code/gauge')), scenario, recording)
        expect(c.status).toBe('cannot')
        expect(c.unsupported).toBe(true)
        expect(c.differences).toEqual([])
        expect(c.runtime).toBeUndefined()
        expect(summary(c)).toBe('Your chart cannot run in the browser, so it cannot be compared here.')
        // Why, with its line (the panel lists it).
        expect(c.errors?.map(d => [d.span?.line, d.message])).toEqual([[6, 'This chart uses extern functions, which cannot run in the browser']])
    })
    test('a construct the simulator meets only in a tick: the same, not a run-time error or a difference', () => {
        const { scenario, recording } = solution('advanced/host-code/gauge-method')
        const reader = compile(read('advanced/host-code/gauge-method'))
        // The engine's own simulation (no fake yet), which fails from tick 2 on as the engine does on such a construct.
        const real = createSimulation(reader)
        const error = { severity: 'error' as const, code: 'unsupported', message: 'The simulator cannot call the host function clamp() in the browser', span: { start: 0, end: 1, line: 7, col: 3, endLine: 7, endCol: 4 } }
        fakes.set(reader, { step: (i?: Record<string, never>) => (real.tick >= 1 ? { ...real.history[0], error } : real.step(i)) })
        const c = compareWithSolution(reader, scenario, recording)
        fakes.delete(reader)
        expect(c.status).toBe('cannot')
        expect(c.unsupported).toBe(true)
        expect(c.runtime).toBeUndefined()
        expect(c.ticks).toEqual([])
        expect(summary(c)).toBe('Your chart cannot run in the browser, so it cannot be compared here.')
        expect(c.errors?.[0].message).toMatch(/clamp\(\) in the browser/)
    })
    test('signals: presence, and values only when emitted', () => {
        const recording = {
            ok: true,
            interface: { A: { type: 'bool', properties: ['input', 'signal'] }, O: { type: 'bool', properties: ['output', 'signal'] }, V: { type: 'int', properties: ['output', 'signal'] } },
            ticks: [
                { step: 1, inputs: { A: false }, values: { A: false, O: false, V: false, V_val: 0 } },
                { step: 2, inputs: { A: true }, values: { A: true, O: true, V: true, V_val: 5 } },
            ],
        }
        const scenario = { ticks: [{ inputs: { A: false } }, { inputs: { A: true } }] }
        const reader = compile(`scchart S {
  input signal A
  output signal O
  output signal int V
  initial state W
  if A do V(4) go to D
  state D
}`)
        const c = compareWithSolution(reader, scenario, recording)
        expect(c.ticks).toEqual([true, false])
        expect(c.differences.map(d => d.message)).toEqual([
            'In tick 2 your chart does not emit `O`; the model solution does.',
            'In tick 2 your chart emits `V` with 4; the model solution emits it with 5.',
        ])
        expect(c.firstTick?.rows).toEqual([
            { name: 'O', yours: 'absent', theirs: 'emitted', same: false },
            { name: 'V', yours: 'emitted, 4', theirs: 'emitted, 5', same: false },
        ])
    })
    test("the model solution's locals (a class instance and its members too) are not the reader's business", () => {
        const recording = {
            ok: true,
            interface: {
                lap: { type: 'bool', properties: ['input'] },
                laps: { type: 'int', properties: ['output'] },
                'Counter.count': { type: 'int', properties: [] },
                counter: { type: 'class', properties: [] },
            },
            ticks: [{ step: 1, inputs: { lap: true }, values: { lap: true, laps: 1, counter: { count: 1 } } }],
        }
        const reader = compile(`scchart Laps {\n  input bool lap\n  output int laps = 0\n  initial state A\n    if lap do laps++ go to A\n}`)
        const c = compareWithSolution(reader, { ticks: [{ inputs: { lap: true } }] }, recording)
        expect(c.interface).toEqual([])
        expect(c.status).toBe('differs')
    })
    test('tick lists read as English', () => {
        expect(tickList([1])).toBe('tick 1')
        expect(tickList([1, 2])).toBe('ticks 1 and 2')
        expect(tickList([1, 2, 3, 5])).toBe('ticks 1 to 3 and 5')
        expect(tickList([1, 3, 5])).toBe('ticks 1, 3 and 5')
        expect(tickList([1, 2, 5])).toBe('ticks 1, 2 and 5')
        expect(tickList([1, 4, 5, 7, 8])).toBe('ticks 1, 4, 5, 7 and 8')
        expect(tickList([1, 2, 4, 5, 6, 8, 9])).toBe('ticks 1, 2, 4 to 6, 8 and 9')
    })
    test('one output takes a singular verb', () => {
        const base = { status: 'differs', total: 3, interface: [], runtime: undefined } as const
        const c = { ...base, outputs: ['light'], ticks: [true, false, true], differences: [{ tick: 2, message: 'In tick 2 your `light` is false; the model solution has true.' }] }
        expect(summary(c as never)).toBe("Your output `light` matches the model solution's in ticks 1 and 3. In tick 2 your `light` is false; the model solution has true.")
        expect(summary({ ...c, ticks: [false, false, false], differences: [{ tick: 1, message: 'x' }] } as never)).toBe("Your output `light` differs from the model solution's from tick 1. x")
    })
})

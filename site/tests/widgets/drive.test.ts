// The widgets drive the engine the way KIELER's environment does: the guided tour (and every later Step) must
// give exactly what feeding the scenario's inputs straight to the engine gives. Checked on every example and
// every conformance chart that has a scenario and that the engine runs.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { Value } from '../../src/engine/types'
import { initialInputs } from '../../src/components/sim/inputs'
import { pairStepper, unionInputs } from '../../src/components/sim/pair'
import { Timeline } from '../../src/components/sim/timeline'

const root = path.resolve(import.meta.dirname, '../..')
function* scenarios(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) yield* scenarios(full)
        else if (e.name.endsWith('.scenario.json')) yield full
    }
}

const cases = [...scenarios(path.join(root, 'src/examples')), ...scenarios(path.join(root, 'tests/conformance'))]
    .map((file) => ({ file, chart: file.replace(/\.scenario\.json$/, '.sctx'), scenario: JSON.parse(fs.readFileSync(file, 'utf8')) }))
    .filter((c) => fs.existsSync(c.chart) && c.scenario.expect !== 'error' && !c.scenario.system)

/** The files a scenario imports, by file name (as the widgets pass them to compile). */
const filesOf = (chart: string, imports?: string[]) =>
    Object.fromEntries((imports ?? []).map((f) => [path.basename(f), fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')]))

const strip = (t: { values: unknown; present: unknown; active: unknown; taken: unknown; terminated: unknown; error?: { message: string } }) =>
    JSON.stringify([t.values, t.present, t.active, t.taken, t.terminated, t.error?.message])

describe('the widgets drive the engine like the scenario does', () => {
    it(`finds charts to check (${cases.length})`, () => {
        expect(cases.length).toBeGreaterThan(50)
    })
    for (const c of cases) {
        const name = path.relative(root, c.chart)
        it(name, () => {
            const source = fs.readFileSync(c.chart, 'utf8')
            const compiled = compile(source, { files: filesOf(c.chart, c.scenario.imports) })
            if (!compiled.ok) return // not the widgets' business (rejected, or not supported by the engine yet)
            const direct = createSimulation(compiled)
            for (const t of c.scenario.ticks) direct.step(t.inputs ?? {})
            const widget = createSimulation(compiled)
            const timeline = new Timeline(widget, initialInputs(compiled.interface), c.scenario)
            for (let i = 0; i < c.scenario.ticks.length; i++) timeline.step()
            expect(widget.history.map(strip)).toEqual(direct.history.map(strip))
            // Back to tick 1 and Step again: replayed, identical.
            timeline.goto(1)
            for (let i = 1; i < c.scenario.ticks.length; i++) timeline.step()
            expect(widget.history.map(strip)).toEqual(direct.history.map(strip))
            // A reader who sets the scenario's inputs with the controls, tick by tick, gets the same run.
            const free = createSimulation(compiled)
            const reader = new Timeline(free, initialInputs(compiled.interface))
            for (const t of c.scenario.ticks) {
                const now = reader.controls()
                reader.edit({ levels: { ...now.levels, ...(t.inputs ?? {}) }, pulses: [] })
                reader.step()
            }
            expect(free.history.map(strip)).toEqual(direct.history.map(strip))
        })
    }
})

// <Compare>: the guided tour plays one scenario on both charts. Each chart must run exactly as if the scenario's
// inputs (those it declares) were fed to it alone, in the tour and when a reader sets them by hand.
const docs = path.join(root, 'src/content/docs')
function* mdx(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) yield* mdx(full)
        else if (e.name.endsWith('.mdx')) yield full
    }
}
const attr = (tag: string, name: string) => new RegExp(`\\b${name}=(?:"([^"]*)"|\\{(false)\\})`).exec(tag)
const compares = [...mdx(docs)].flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(/<Compare\b([\s\S]*?)\/>/g)].map((m) => {
        const tag = m[1]
        const s = attr(tag, 'scenario')
        return { page: path.relative(root, file), a: attr(tag, 'a')?.[1] ?? '', b: attr(tag, 'b')?.[1] ?? '', scenario: (s ? (s[2] ? false : s[1]) : undefined) as string | false | undefined }
    })
)
const exampleFile = (id: string, ext: string) => path.join(root, 'src/examples', `${id}${ext}`)
const readScenario = (id: string) => (fs.existsSync(exampleFile(id, '.scenario.json')) ? JSON.parse(fs.readFileSync(exampleFile(id, '.scenario.json'), 'utf8')) : undefined)

describe('Compare: the tour drives both charts like the scenario does', () => {
    it(`finds comparisons (${compares.length})`, () => {
        expect(compares.length).toBeGreaterThan(20)
    })
    for (const c of compares) {
        const scenarioId: string | false = c.scenario === undefined || c.scenario === 'a' ? c.a : c.scenario === 'b' ? c.b : c.scenario
        const scenario = scenarioId ? readScenario(scenarioId) : undefined
        if (!scenario || scenario.expect === 'error') continue
        it(`${c.page}: ${c.a} and ${c.b}`, () => {
            const load = (id: string) => {
                const sc = readScenario(id)
                return compile(fs.readFileSync(exampleFile(id, '.sctx'), 'utf8'), { files: filesOf(exampleFile(id, '.sctx'), sc?.imports) })
            }
            const ca = load(c.a)
            const cb = load(c.b)
            if (!ca.ok || !cb.ok) return // shown as rejected or not runnable, no tour
            const keys = (iface: typeof ca.interface) => new Set(Object.keys(initialInputs(iface).levels))
            const direct = (compiled: typeof ca) => {
                const sim = createSimulation(compiled)
                const k = keys(compiled.interface)
                for (const t of scenario.ticks) sim.step(Object.fromEntries(Object.entries(t.inputs ?? {}).filter(([n]) => k.has(n))) as never)
                return sim.history.map(strip)
            }
            const union = unionInputs(ca.interface, cb.interface)
            const run = (tour: boolean) => {
                const sa = createSimulation(ca)
                const sb = createSimulation(cb)
                const { stepper, readPool } = pairStepper(sa, ca.interface, sb, cb.interface)
                const t = new Timeline(stepper, initialInputs(union), tour ? scenario : undefined, readPool)
                for (const tick of scenario.ticks) {
                    if (!tour) {
                        const now = t.controls()
                        const named = Object.fromEntries(Object.entries(tick.inputs ?? {}).filter(([n]) => n in now.levels)) as Record<string, Value>
                        t.edit({ levels: { ...now.levels, ...named }, pulses: [] })
                    }
                    t.step()
                }
                return [sa.history.map(strip), sb.history.map(strip)]
            }
            const expected = [direct(ca), direct(cb)]
            expect(run(true)).toEqual(expected)
            expect(run(false)).toEqual(expected)
        })
    }
})

describe('Compare: inputs only one chart has', () => {
    it('keep the value the reader set (read from that chart\'s data pool)', () => {
        const a = compile('scchart A {\n  input bool x\n  output bool o\n  initial state S\n  if x do o = true go to S\n}')
        const b = compile('scchart B {\n  input bool y\n  output bool o\n  initial state S\n  if y do o = true go to S\n}')
        const sa = createSimulation(a)
        const sb = createSimulation(b)
        const { stepper, readPool } = pairStepper(sa, a.interface, sb, b.interface)
        const t = new Timeline(stepper, initialInputs(unionInputs(a.interface, b.interface)), undefined, readPool)
        t.edit({ levels: { x: false, y: true }, pulses: [] })
        t.step()
        expect(t.controls().levels).toEqual({ x: false, y: true })
        t.step()
        expect(sb.history.map((h) => h.inputs.y ?? (h as unknown as { pool: Record<string, unknown> }).pool.y)).toEqual([true, true])
    })
})

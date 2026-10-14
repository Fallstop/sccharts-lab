// Expanded references and the simulator agree on ids: the engine reports the states, transitions and actions of a
// referenced chart's instance as `<reference state id>/<id in the referenced chart>` (src/engine/sim/STATUS.md), and
// a diagram laid out with `references: 'expanded'` draws exactly those elements with exactly those data-ids. Every
// chart with a reference state among the examples and the conformance probes is simulated with its scenario, and
// every id of every tick must be in the expanded diagram (so <Chart>/<Sim> can highlight an instance's inner states).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import { layoutChart, renderSvg, tickClasses } from '../../src/diagram'
import type { Value } from '../../src/engine/types'

const site = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) yield* walk(full)
        else if (e.name.endsWith('.sctx')) yield full
    }
}

interface Scenario {
    ticks?: { inputs?: Record<string, Value> }[]
    imports?: string[]
    expect?: string
}

const cases = ['src/examples', 'tests/conformance/structure']
    .flatMap(d => [...walk(path.join(site, d))])
    .filter(f => /^\s*(initial\s+|final\s+)*state\s+\w+\s+is\s+(?!final\b)\w/m.test(fs.readFileSync(f, 'utf8')))
    .sort()

let instanceIds = 0

describe('expanded references carry the ids the simulator reports', () => {
    it('finds charts with references', () => expect(cases.length).toBeGreaterThan(20))
    for (const file of cases) {
        const rel = path.relative(site, file)
        it(rel, async () => {
            const scenarioFile = file.replace(/\.sctx$/, '.scenario.json')
            const scenario: Scenario = fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {}
            const files: Record<string, string> = {}
            for (const f of scenario.imports ?? []) files[path.basename(f)] = fs.readFileSync(path.join(path.dirname(file), f), 'utf8')
            const result = compile(fs.readFileSync(file, 'utf8'), { files })
            if (!result.ok || !result.chart || !result.program) return
            const charts = result.index?.programs.flatMap(p => p.charts)
            const layout = await layoutChart(result.chart, { program: result.program, charts, references: 'expanded' })
            const svg = renderSvg(layout)
            const drawn = new Set([...svg.matchAll(/ data-id="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')))
            const sim = createSimulation(result)
            const missing = new Set<string>()
            for (const t of scenario.ticks?.length ? scenario.ticks : [{}, {}, {}]) {
                const r = sim.step(t.inputs ?? {})
                if (r.error) break
                const ids = [...r.active, ...r.entered, ...r.exited, ...r.taken, ...r.actions, ...Object.keys(tickClasses(r))]
                for (const id of ids) {
                    if (id.includes('/')) instanceIds++
                    if (!drawn.has(id)) missing.add(id)
                }
                if (r.terminated) break
            }
            expect([...missing], `${rel}: ids the simulator reports but the expanded diagram does not draw`).toEqual([])
        })
    }
    it('checked ids inside instances (not only the referencing charts\' own)', () => expect(instanceIds).toBeGreaterThan(100))
})

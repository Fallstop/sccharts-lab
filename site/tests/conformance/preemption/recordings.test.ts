// Checks that the preemption conformance suite is complete and its KIELER recordings are current:
// every chart has a scenario and an oracle recording made from the same chart and inputs, the
// recording agrees with the scenario's "expect", tick 1 sets every input, and every tick has a note.
// (The engine-vs-oracle comparison lives with the simulator; this only guards the suite itself.)
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const charts = fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).sort()

// Same hash as tools/oracle/record.mjs (scenarioHash), so a stale recording is detected.
function scenarioHash(model: string, scenario: any): string {
    const ticks = (scenario.ticks ?? []).map((t: any) => t.inputs ?? {})
    return crypto.createHash('sha1').update(JSON.stringify([model, ticks, scenario.system ?? 'netlist', scenario.imports ?? null])).digest('hex')
}

describe('preemption conformance suite', () => {
    it('has charts', () => {
        expect(charts.length).toBeGreaterThan(40)
    })

    for (const chart of charts) {
        const base = chart.slice(0, -'.sctx'.length)
        describe(base, () => {
            const model = fs.readFileSync(path.join(dir, chart), 'utf8')
            const scenarioFile = path.join(dir, `${base}.scenario.json`)
            const oracleFile = path.join(dir, `${base}.oracle.json`)

            it('has a scenario and a current recording', () => {
                expect(fs.existsSync(scenarioFile)).toBe(true)
                expect(fs.existsSync(oracleFile)).toBe(true)
                const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
                const recording = JSON.parse(fs.readFileSync(oracleFile, 'utf8'))
                expect(recording.hash).toBe(scenarioHash(model, scenario))
            })

            it('agrees with the expected outcome', () => {
                const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
                const recording = JSON.parse(fs.readFileSync(oracleFile, 'utf8'))
                const expected = scenario.expect ?? 'ok'
                if (expected === 'ok') {
                    expect(recording.ok, recording.errors?.join(' | ')).toBe(true)
                    expect(recording.ticks.length).toBe(scenario.ticks.length)
                } else {
                    expect(recording.ok).toBe(false)
                    if (scenario.errorIncludes) expect(recording.errors.some((e: string) => e.includes(scenario.errorIncludes))).toBe(true)
                }
            })

            it('sets every input in tick 1 and explains every tick', () => {
                const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
                const recording = JSON.parse(fs.readFileSync(oracleFile, 'utf8'))
                for (const tick of scenario.ticks) expect(typeof tick.note === 'string' && tick.note.length > 0).toBe(true)
                if (recording.ok) {
                    const inputs = Object.entries(recording.interface ?? {})
                        .filter(([, v]: [string, any]) => v.properties?.includes('input'))
                        .map(([k]) => k)
                    expect(Object.keys(scenario.ticks[0].inputs).sort()).toEqual(expect.arrayContaining(inputs.sort()))
                }
            })
        })
    }
})

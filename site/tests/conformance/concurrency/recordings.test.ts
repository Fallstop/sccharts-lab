// Integrity of the "concurrency" conformance suite (hierarchy, termination, concurrent regions, signals,
// valued signals, pre): every probe chart has a scenario and an up-to-date KIELER recording that agrees with
// the scenario's "expect", every tick has a note, and tick 1 sets every input. The engine's own conformance
// run (engine vs recording) lives with the simulator; this file only guards the recordings themselves.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

interface Scenario {
    ticks: { inputs?: Record<string, unknown>; note?: string }[]
    expect?: 'ok' | 'error'
    errorIncludes?: string
    system?: string
    imports?: string[]
}

interface Recording {
    hash: string
    ok: boolean
    errors: string[]
    interface?: Record<string, { type: string; properties: string[] }>
    ticks: { step: number; inputs: Record<string, unknown>; values: Record<string, unknown> }[]
}

/** Same formula as tools/oracle/record.mjs (scenarioHash), so a stale recording is detected. */
function scenarioHash(model: string, scenario: Scenario): string {
    const ticks = (scenario.ticks ?? []).map(t => t.inputs ?? {})
    return crypto.createHash('sha1').update(JSON.stringify([model, ticks, scenario.system ?? 'netlist', null])).digest('hex')
}

const charts = fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).sort()

describe('concurrency conformance recordings', () => {
    it('has the probe charts', () => {
        expect(charts.length).toBeGreaterThanOrEqual(25)
    })

    for (const chart of charts) {
        const base = chart.slice(0, -'.sctx'.length)
        it(base, () => {
            const model = fs.readFileSync(path.join(dir, chart), 'utf8')
            const scenarioFile = path.join(dir, `${base}.scenario.json`)
            const recordingFile = path.join(dir, `${base}.oracle.json`)
            expect(fs.existsSync(scenarioFile), `${base}.scenario.json missing`).toBe(true)
            expect(fs.existsSync(recordingFile), `${base}.oracle.json missing (run pnpm oracle:record)`).toBe(true)
            const scenario: Scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
            const recording: Recording = JSON.parse(fs.readFileSync(recordingFile, 'utf8'))

            expect(recording.hash, 'recording is stale: re-run pnpm oracle:record').toBe(scenarioHash(model, scenario))
            expect(scenario.ticks.length).toBeGreaterThan(0)
            for (const [i, tick] of scenario.ticks.entries()) {
                expect(typeof tick.note === 'string' && tick.note.trim().length > 0, `tick ${i + 1} has no note`).toBe(true)
            }

            const expected = scenario.expect ?? 'ok'
            if (expected === 'error') {
                expect(recording.ok, 'KIELER accepts a chart the scenario expects to be rejected').toBe(false)
                if (scenario.errorIncludes) {
                    expect(recording.errors.some(e => e.includes(scenario.errorIncludes!)), `no error includes "${scenario.errorIncludes}"`).toBe(true)
                }
                return
            }
            expect(recording.ok, `KIELER rejects it: ${recording.errors.join(' | ').slice(0, 300)}`).toBe(true)
            expect(recording.ticks.length).toBe(scenario.ticks.length)
            const inputs = Object.entries(recording.interface ?? {}).filter(([, v]) => v.properties.includes('input')).map(([k]) => k)
            const first = scenario.ticks[0].inputs ?? {}
            for (const input of inputs) expect(first, `tick 1 does not set input ${input}`).toHaveProperty(input)
        })
    }
})

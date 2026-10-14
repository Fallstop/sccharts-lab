// The engine against KIELER: every oracle recording under tests/conformance, src/examples and tests/engine/kieler
// (the simulator's own probes of KIELER defects; found when the suite runs, so new examples are included
// automatically) is replayed in the guide's simulator and compared
// tick by tick with what the real KIELER compiler and simulator did.
//
// - KIELER rejected the chart (recording ok = false): the engine must reject it with an error.
// - Otherwise: the recorded inputs are fed tick by tick and compared: every key of KIELER's data pool (a missing
//   key is a null string), the taken-transition counters (KIELER's Taken Transition Signaling order) and the
//   first tick in which the chart terminated.
//
// Skipped, with the reason printed: scenarios for the priority-based compiler, scenarios that need something the
// engine does not emulate, KIELER bugs the engine deliberately does not reproduce, and charts using a feature
// whose transformation is not implemented yet (the engine says "unsupported").
//
// Known failures live in engine-expected-failures.json (id or glob -> reason); remove entries as they pass.

import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, createSimulation, type PoolValue } from '../../src/engine/index'
import type { Value } from '../../src/engine/types'

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, '../..')

interface Scenario {
    ticks: { inputs?: Record<string, Value> }[]
    expect?: 'ok' | 'error'
    system?: string
    imports?: string[]
    needs?: string[]
    kielerBug?: string
    /**
     * The engine stops with this runtime error in this tick. `frozen`: KIELER's C simulation died there too (a
     * division by zero), so its data pool must stay that of the tick before from then on (basics.md B-20); without
     * it, the guide stops deliberately where KIELER computes something it cannot predict (memory.ts).
     */
    runtimeError?: { tick: number; code: string; frozen?: boolean }
}

interface Recording {
    ok: boolean
    errors: string[]
    ticks: { step: number; values: Record<string, PoolValue>; taken?: number[]; terminated?: boolean }[]
}

interface Case {
    id: string
    area: string
    chart: string
    scenario: Scenario
    recording: Recording
}

/** Features of KIELER's environment the engine emulates (scenario `needs`). */
const EMULATED_NEEDS = new Set<string>(['c-strings', 'c-random'])


function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

function collect(): Case[] {
    const out: Case[] = []
    for (const root of ['tests/conformance', 'src/examples', 'tests/engine/kieler']) {
        for (const file of walk(path.join(site, root))) {
            if (!file.endsWith('.oracle.json')) continue
            const base = file.slice(0, -'.oracle.json'.length)
            const chart = `${base}.sctx`
            const scenarioFile = `${base}.scenario.json`
            if (!fs.existsSync(chart) || !fs.existsSync(scenarioFile)) continue
            const rel = path.relative(path.join(site, root), base).split(path.sep).join('/')
            const id = root === 'src/examples' ? `examples/${rel}` : root === 'tests/engine/kieler' ? `kieler-probes/${rel}` : rel
            const area = root === 'src/examples' ? `examples/${rel.split('/')[0]}`
                : root === 'tests/engine/kieler' ? 'kieler-probes' : rel.split('/')[0]
            out.push({
                id, area, chart,
                scenario: JSON.parse(fs.readFileSync(scenarioFile, 'utf8')),
                recording: JSON.parse(fs.readFileSync(file, 'utf8')),
            })
        }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
}

const expectedFailures: Record<string, string> = (() => {
    const file = path.join(here, 'engine-expected-failures.json')
    if (!fs.existsSync(file)) return {}
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('//')))
})()

function expectedFailure(id: string): string | undefined {
    if (expectedFailures[id]) return expectedFailures[id]
    for (const [pattern, reason] of Object.entries(expectedFailures)) {
        if (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1))) return reason
    }
    return undefined
}

/** Values of KIELER's data pool: scalars, arrays and the objects of class and struct instances. */
function same(a: PoolValue | undefined, b: PoolValue | undefined): boolean {
    if (a === undefined || a === null) return b === undefined || b === null
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((x, i) => same(x, b[i]))
    }
    if (typeof a === 'object' || typeof b === 'object') {
        if (typeof a !== 'object' || typeof b !== 'object' || !b) return false
        const keys = new Set([...Object.keys(a), ...Object.keys(b)])
        return [...keys].every(k => same(a[k], (b as Record<string, PoolValue>)[k]))
    }
    return a === b
}

const show = (v: PoolValue | undefined) => (v === undefined ? 'absent' : JSON.stringify(v))

/** Runs one case; returns the differences (empty: it matches KIELER) or a skip reason. */
function run(c: Case): { skip?: string; problems: string[] } {
    const { scenario, recording } = c
    if (scenario.system && scenario.system !== 'netlist') return { skip: `system ${scenario.system}`, problems: [] }
    const missing = (scenario.needs ?? []).filter(n => !EMULATED_NEEDS.has(n))
    if (missing.length) return { skip: `needs ${missing.join(', ')}`, problems: [] }

    const source = fs.readFileSync(c.chart, 'utf8')
    const files: Record<string, string> = {}
    for (const f of scenario.imports ?? []) files[path.basename(f)] = fs.readFileSync(path.join(path.dirname(c.chart), f), 'utf8')
    const result = compile(source, { files })
    const errors = result.diagnostics.filter(d => d.severity === 'error')
    const unsupported = result.diagnostics.find(d => d.code === 'unsupported')
    if (!recording.ok && result.ok && unsupported) return { skip: `unsupported: ${unsupported.message} (KIELER rejects the chart)`, problems: [] }
    if (!recording.ok) {
        if (result.ok && scenario.kielerBug) return { skip: `KIELER bug not reproduced: ${scenario.kielerBug}`, problems: [] }
        if (result.ok) return { problems: [`KIELER rejects this chart (${(recording.errors[0] ?? '').split('\n')[0].slice(0, 120)}) but the engine accepts it`] }
        return { problems: [] }
    }
    if (unsupported) return { skip: `unsupported: ${unsupported.message}`, problems: [] }
    if (!result.ok) return { problems: [`KIELER accepts this chart but the engine rejects it: ${errors.map(e => `${e.code}: ${e.message}`).join(' | ').slice(0, 300)}`] }

    const sim = createSimulation(result)
    const problems: string[] = []
    let kielerTerminated = -1
    let engineTerminated = -1
    for (let i = 0; i < scenario.ticks.length; i++) {
        const tick = i + 1
        const expected = recording.ticks[i]
        const actual = sim.step(scenario.ticks[i].inputs ?? {})
        const stop = scenario.runtimeError
        if (stop && tick >= stop.tick) {
            if (actual.error?.code !== stop.code || actual.error.tick !== stop.tick) problems.push(`tick ${tick}: expected the runtime error ${stop.code} of tick ${stop.tick}, engine ${actual.error ? `${actual.error.code} of tick ${actual.error.tick}` : 'none'}`)
            // KIELER's process died in that tick: its pool stays the one of the tick before (or the initial one).
            const before = recording.ticks[stop.tick - 2]?.values
            if (stop.frozen && expected && before && !same(expected.values, before)) problems.push(`tick ${tick}: KIELER's values changed after its simulation died`)
            if (stop.frozen && expected && !before && expected.taken?.some(n => n !== 0)) problems.push(`tick ${tick}: KIELER took transitions after its simulation died`)
            continue
        }
        if (actual.error) {
            problems.push(`tick ${tick}: runtime error ${actual.error.message}`)
            break
        }
        if (!expected) break
        for (const [key, value] of Object.entries(expected.values)) {
            if (!same(actual.pool[key], value)) problems.push(`tick ${tick}: ${key} expected ${show(value)}, engine ${show(actual.pool[key])}`)
        }
        for (const [key, value] of Object.entries(actual.pool)) {
            if (!(key in expected.values) && value !== null) problems.push(`tick ${tick}: ${key} = ${show(value)} is not in KIELER's data pool`)
        }
        if (expected.taken) {
            const counts = sim.takenCounts(actual)
            if (!same(counts, expected.taken)) problems.push(`tick ${tick}: taken expected ${JSON.stringify(expected.taken)}, engine ${JSON.stringify(counts)}`)
        }
        if (expected.terminated && kielerTerminated < 0) kielerTerminated = tick
        if (actual.terminatedNow && engineTerminated < 0) engineTerminated = tick
        if (problems.length > 12) break
    }
    if (kielerTerminated !== engineTerminated && !problems.length) {
        problems.push(`terminates in tick ${kielerTerminated < 0 ? 'never' : kielerTerminated} in KIELER, ${engineTerminated < 0 ? 'never' : engineTerminated} in the engine`)
    }
    // A KIELER bug the engine does not reproduce (it runs the intended semantics and warns instead).
    if (problems.length && scenario.kielerBug) return { skip: `KIELER bug not reproduced: ${scenario.kielerBug}`, problems: [] }
    return { problems }
}

const cases = collect()
const stats = new Map<string, { pass: number; fail: number; expectedFail: number; skip: number }>()
const skipped: string[] = []
const fixed: string[] = []

describe('engine conformance with KIELER', () => {
    it('finds the recordings', () => {
        expect(cases.length).toBeGreaterThan(300)
    })

    for (const c of cases) {
        it(c.id, () => {
            const s = stats.get(c.area) ?? { pass: 0, fail: 0, expectedFail: 0, skip: 0 }
            stats.set(c.area, s)
            const { skip, problems } = run(c)
            if (skip) {
                s.skip++
                skipped.push(`${c.id}: ${skip}`)
                return
            }
            const known = expectedFailure(c.id)
            if (problems.length && known) {
                s.expectedFail++
                return
            }
            if (!problems.length && known) fixed.push(c.id)
            if (problems.length) s.fail++
            else s.pass++
            expect(problems, `${c.id} (${path.relative(site, c.chart)})\n  ${problems.join('\n  ')}`).toEqual([])
        })
    }

    afterAll(() => {
        const rows = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))
        const lines = rows.map(([area, s]) => `${area.padEnd(32)} pass ${String(s.pass).padStart(3)}  fail ${String(s.fail).padStart(3)}  expected-fail ${String(s.expectedFail).padStart(3)}  skip ${String(s.skip).padStart(3)}`)
        console.log(`\nEngine conformance per area:\n${lines.join('\n')}`)
        if (process.env.ENGINE_SKIPS) console.log(`\nSkipped:\n  ${skipped.join('\n  ')}`)
        if (fixed.length) console.log(`\nNow passing (remove from engine-expected-failures.json):\n  ${fixed.join('\n  ')}`)
    })
})

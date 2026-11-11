// One chart through the C code generator, gcc and the harness, compared tick by tick with the engine's simulation
// and, when there is one, with KIELER's recording (the same comparison as tests/conformance/engine.test.ts: every key
// of KIELER's data pool, the taken-transition counters and the termination tick).

import { compile, createSimulation, generateC, type GeneratedC, type PoolValue, type SimTickResult } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'
import { compileAndRun, type RunResult } from './gcc'
import { harness, parseOutput, type HarnessTick } from './harness'

export interface Scenario {
    ticks: { inputs?: Record<string, Value> }[]
    expect?: 'ok' | 'error'
    system?: string
    imports?: string[]
    needs?: string[]
    kielerBug?: string
    runtimeError?: { tick: number; code: string; frozen?: boolean }
}

export interface Recording {
    ok: boolean
    errors: string[]
    ticks: { step: number; values: Record<string, PoolValue>; taken?: number[]; terminated?: boolean }[]
}

export interface Case {
    id: string
    source: string
    files?: Record<string, string>
    inputs: Record<string, Value>[]
    scenario?: Scenario
    recording?: Recording
}

export type Verdict =
    /** C, engine (and KIELER, when recorded) agree in every compared tick. */
    | 'match'
    /** KIELER rejects the chart and so does the engine (no code to generate) or gcc (host code). */
    | 'rejected'
    | 'skipped'
    | 'mismatch'

export interface CaseResult {
    id: string
    verdict: Verdict
    /** Why it was skipped, or which comparison failed. */
    reason?: string
    problems: string[]
    /** What was compared: ticks against the engine, ticks against KIELER. */
    engineTicks: number
    kielerTicks: number
    /** gcc's warnings for the generated files (not main.c). */
    warnings?: string
    /** Explained differences from KIELER (a `kieler-bug` scenario: the engine and the C code do the intended thing). */
    explained?: string
    hostCode?: boolean
}

export function same(a: PoolValue | undefined, b: PoolValue | undefined): boolean {
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
    if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b))
    return a === b
}

const show = (v: PoolValue | undefined) => (v === undefined ? 'absent' : JSON.stringify(v))

/** Engine errors after which KIELER's process is dead too (the C program dies of SIGFPE). */
const CRASHES = new Set(['division-by-zero', 'division-overflow'])

/** Generates the C code (with taken counters, for the comparison) of a compiled chart. */
export function generate(source: string, files?: Record<string, string>): { gen: GeneratedC; result: ReturnType<typeof compile> } {
    const result = compile(source, { files })
    return { gen: generateC(result, { takenTransitions: true }), result }
}

export async function checkCase(c: Case, options: { keep?: string } = {}): Promise<CaseResult> {
    const base = { id: c.id, problems: [] as string[], engineTicks: 0, kielerTicks: 0 }
    const sc = c.scenario
    if (sc?.system && sc.system !== 'netlist') return { ...base, verdict: 'skipped', reason: `system ${sc.system}` }
    const { gen, result } = generate(c.source, c.files)
    const rec = c.recording
    const unsupported = result.ok ? result.diagnostics.find(d => d.code === 'unsupported') : undefined
    if (rec && !rec.ok) {
        if (!result.ok) return { ...base, verdict: 'rejected', reason: 'KIELER and the engine reject the chart' }
        if (!gen.ok) return { ...base, verdict: unsupported ? 'skipped' : 'mismatch', reason: unsupported ? `unsupported: ${unsupported.message}` : 'KIELER rejects the chart', problems: unsupported ? [] : [`KIELER rejects the chart, the engine accepts it: ${rec.errors[0]?.split('\n')[0]}`] }
        // Host code: KIELER's gcc rejected its code; gcc must reject ours.
        const run = await compileAndRun(gen.files, harness(gen, c.inputs), options)
        if (run.compileError) return { ...base, verdict: 'rejected', reason: 'KIELER rejects the chart and gcc rejects the generated code', hostCode: gen.hostCode }
        if (sc?.kielerBug) return { ...base, verdict: 'skipped', reason: `KIELER bug not reproduced: ${sc.kielerBug}` }
        return { ...base, verdict: 'mismatch', problems: [`KIELER rejects the chart (${rec.errors[0]?.split('\n')[0]}) but gcc compiles the generated code`], hostCode: gen.hostCode }
    }
    if (!result.ok) {
        // A random chart the engine rejects (as KIELER would): there is no code to compare.
        if (!rec) return { ...base, verdict: 'rejected', reason: 'the engine rejects the chart' }
        return { ...base, verdict: 'mismatch', problems: [`the engine rejects the chart: ${result.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join(' | ').slice(0, 200)}`] }
    }
    if (!gen.ok) {
        const why = gen.diagnostics.map(d => d.message).join(' | ')
        return { ...base, verdict: unsupported ? 'skipped' : 'mismatch', reason: unsupported ? `unsupported: ${unsupported.message}` : undefined, problems: unsupported ? [] : [`no C code: ${why}`] }
    }

    // The engine's run (none for host code, which the simulator cannot run).
    const engine: { tick: SimTickResult; taken: number[] }[] = []
    const sim = gen.hostCode ? undefined : createSimulation(result)
    if (sim) for (const given of c.inputs) { const t = sim.step(given); engine.push({ tick: t, taken: sim.takenCounts(t) }) }
    const run = await compileAndRun(gen.files, harness(gen, c.inputs), options)
    if (run.compileError) return { ...base, verdict: 'mismatch', problems: [`gcc rejects the generated code: ${run.compileError.split('\n').slice(0, 6).join(' | ')}`], hostCode: gen.hostCode }
    const out = parseOutput(run.stdout)
    const warnings = generatedWarnings(run, gen)
    const r: CaseResult = { ...base, verdict: 'match', warnings, hostCode: gen.hostCode }
    if (sim) compareWithEngine(r, gen, engine, out, run)
    if (rec) compareWithKieler(r, c, gen, rec, out, run)
    if (r.problems.length) r.verdict = 'mismatch'
    return r
}

/** gcc's warnings about the generated files (main.c is the harness's). */
function generatedWarnings(run: RunResult, gen: GeneratedC): string | undefined {
    const lines = run.warnings.split('\n').filter(l => /warning:/.test(l) && (l.startsWith(gen.source) || l.startsWith(gen.header)))
    return lines.length ? lines.join('\n') : undefined
}

function knownKeys(gen: GeneratedC): Set<string> {
    const out = new Set<string>()
    for (const v of gen.variables) if (v.pool !== undefined) out.add(v.poolObject ?? v.pool)
    return out
}

function compareWithEngine(r: CaseResult, gen: GeneratedC, engine: { tick: SimTickResult; taken: number[] }[], out: { ticks: HarnessTick[]; diedIn?: number }, run: RunResult) {
    const known = knownKeys(gen)
    for (let i = 0; i < engine.length; i++) {
        const tick = i + 1
        const e = engine[i].tick
        const ct = out.ticks[i]
        if (e.error) {
            if (CRASHES.has(e.error.code ?? '')) {
                if (out.diedIn !== tick || ct) r.problems.push(`engine: tick ${tick}: the engine stops (${e.error.code}), the C program ${ct ? 'runs on' : run.timedOut ? 'times out' : `stops in tick ${out.diedIn ?? '?'}`}`)
            }
            // Otherwise the guide stops where it cannot predict what C does (an index outside the known struct, ...).
            return
        }
        if (!ct) {
            r.problems.push(`engine: tick ${tick}: the C program ${run.timedOut ? 'timed out' : run.signal ? `died (${run.signal})` : 'stopped'}`)
            return
        }
        r.engineTicks++
        const before = r.problems.length
        for (const [key, value] of Object.entries(ct.pool)) if (!same(value, e.pool[key])) r.problems.push(`engine: tick ${tick}: ${key} is ${show(value)} in C, ${show(e.pool[key])} in the engine`)
        for (const [key, value] of Object.entries(e.pool)) {
            if (key in ct.pool || value === null) continue
            if (!known.has(key)) continue
            r.problems.push(`engine: tick ${tick}: ${key} = ${show(value)} in the engine is missing in C`)
        }
        const printed = e.printed.join('')
        if (printed !== ct.printed) r.problems.push(`engine: tick ${tick}: printed ${JSON.stringify(ct.printed)} in C, ${JSON.stringify(printed)} in the engine`)
        const taken = engine[i].taken
        if (ct.taken && !same(ct.taken.slice(0, taken.length), taken)) r.problems.push(`engine: tick ${tick}: taken ${JSON.stringify(ct.taken)} in C, ${JSON.stringify(taken)} in the engine`)
        if (ct.terminated !== e.terminatedNow) r.problems.push(`engine: tick ${tick}: _TERM is ${ct.terminated} in C, terminated ${e.terminatedNow} in the engine`)
        if (r.problems.length > before + 8) return
    }
}

function compareWithKieler(r: CaseResult, c: Case, gen: GeneratedC, rec: Recording, out: { ticks: HarnessTick[]; diedIn?: number }, run: RunResult) {
    const problems: string[] = []
    const known = knownKeys(gen)
    const stop = c.scenario?.runtimeError
    let kielerTerminated = -1
    let cTerminated = -1
    for (let i = 0; i < rec.ticks.length && i < c.inputs.length; i++) {
        const tick = i + 1
        const expected = rec.ticks[i]
        const ct = out.ticks[i]
        if (stop && tick >= stop.tick) {
            if (stop.frozen && (out.diedIn !== stop.tick || out.ticks.length >= stop.tick)) problems.push(`KIELER: tick ${stop.tick}: KIELER's simulation died (${stop.code}), the C program ${out.ticks.length >= stop.tick ? 'runs on' : `stops in tick ${out.diedIn ?? '?'}`}`)
            break
        }
        if (!ct) {
            problems.push(`KIELER: tick ${tick}: the C program ${run.timedOut ? 'timed out' : run.signal ? `died (${run.signal})` : 'stopped'}`)
            break
        }
        r.kielerTicks++
        for (const [key, value] of Object.entries(expected.values)) {
            if (!(key in ct.pool) && !known.has(key)) continue
            if (!same(ct.pool[key], value)) problems.push(`KIELER: tick ${tick}: ${key} is ${show(ct.pool[key])} in C, ${show(value)} in KIELER`)
        }
        for (const [key, value] of Object.entries(ct.pool)) if (!(key in expected.values) && value !== null) problems.push(`KIELER: tick ${tick}: ${key} = ${show(value)} is not in KIELER's data pool`)
        if (expected.taken && ct.taken && !same(ct.taken.slice(0, expected.taken.length), expected.taken)) problems.push(`KIELER: tick ${tick}: taken ${JSON.stringify(ct.taken)} in C, ${JSON.stringify(expected.taken)} in KIELER`)
        if (expected.terminated && kielerTerminated < 0) kielerTerminated = tick
        if (ct.terminated && cTerminated < 0) cTerminated = tick
        if (problems.length > 8) break
    }
    if (kielerTerminated !== cTerminated && !problems.length) problems.push(`KIELER: terminates in tick ${kielerTerminated < 0 ? 'never' : kielerTerminated} in KIELER, ${cTerminated < 0 ? 'never' : cTerminated} in C`)
    if (problems.length && c.scenario?.kielerBug) {
        r.explained = `kieler-bug: ${c.scenario.kielerBug}`
        return
    }
    r.problems.push(...problems)
}

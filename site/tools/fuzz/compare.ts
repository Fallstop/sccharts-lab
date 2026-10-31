// Compares the engine with one oracle result (tools/oracle/oracle.mjs): acceptance, KIELER's data pool, the
// taken-transition counters and the termination tick, tick by tick (as tests/conformance/engine.test.ts does).

import { compile, createSimulation, SIMULATOR_CODES, type PoolValue } from '../../src/engine/index'
import type { Value } from '../../src/engine/types'

export interface OracleResult {
    ok: boolean
    errors: string[]
    ticks: { step: number; values: Record<string, PoolValue>; taken?: number[]; terminated?: boolean }[]
    /** KIELER's LSP diagnostics (parser, linker, validator): severity 1 error, 2 warning, 3 info. */
    diagnostics?: { severity: number; message: string; line: number; column: number; code?: string }[]
}

export type OutcomeKind =
    /** Same verdict, same behaviour in every tick. */
    | 'match'
    /** Both reject. */
    | 'both-reject'
    /** KIELER rejects, the engine accepts. */
    | 'engine-accepts'
    /** KIELER accepts, the engine rejects. */
    | 'engine-rejects'
    /** KIELER's verdict or behaviour changes from run to run and the engine says so (`kieler-nondeterministic`, or
     *  the kieler-quirk info about cure orders): not a mismatch. */
    | 'nondeterministic'
    /** Both accept, a tick differs. */
    | 'behaviour'
    /** The engine cannot simulate the chart (code 'unsupported'). */
    | 'unsupported'
    /** The engine's front end rejects the chart with a syntax error (a generator bug, or a parser difference). */
    | 'syntax'
    /** The oracle failed (timeout, server error). */
    | 'oracle-failure'
    /** The engine threw. */
    | 'engine-crash'
    /** Both accept and agree on every tick, but the validator's warnings or infos (positions) differ. */
    | 'diagnostics'

export interface Outcome {
    kind: OutcomeKind
    /** One line. */
    detail: string
    diffs?: string[]
    /** First tick that differs (behaviour). */
    tick?: number
}

export const MISMATCH: ReadonlySet<OutcomeKind> = new Set(['engine-accepts', 'engine-rejects', 'behaviour', 'engine-crash', 'diagnostics'])

const show = (v: PoolValue | undefined) => (v === undefined ? 'absent' : JSON.stringify(v))

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

/** The engine's verdict alone (no oracle): 'ok', an error code, 'unsupported' or 'syntax'. */
export function engineVerdict(model: string, files?: Record<string, string>): string {
    try {
        const r = compile(model, { files })
        const errors = r.diagnostics.filter(d => d.severity === 'error')
        if (errors.some(d => d.code === 'parse')) return 'syntax'
        if (errors.length) return errors[0].code ?? 'error'
        if (r.diagnostics.some(d => d.code === 'unsupported')) return 'unsupported'
        return 'ok'
    } catch (e) {
        return `crash: ${(e as Error).message}`
    }
}

export function compareWithOracle(model: string, inputs: Record<string, Value>[], rec: OracleResult, files?: Record<string, string>): Outcome {
    let result
    try {
        result = compile(model, { files })
        void result.ok
    } catch (e) {
        return { kind: 'engine-crash', detail: `compile threw: ${(e as Error).message}` }
    }
    const errors = result.diagnostics.filter(d => d.severity === 'error')
    if (errors.some(d => d.code === 'parse')) return { kind: 'syntax', detail: errors[0].message }
    const kieler = (rec.errors[0] ?? '').split('\n')[0]
    if (!rec.ok && /^(Timeout|simulation did not start|tick \d+:)/.test(kieler)) return { kind: 'oracle-failure', detail: kieler }
    if (!rec.ok) {
        if (!result.ok) return { kind: 'both-reject', detail: `${errors[0]?.code}: ${kieler}` }
        return { kind: 'engine-accepts', detail: `KIELER: ${kieler}` }
    }
    if (!result.ok) {
        if (errors.some(d => d.code === 'kieler-nondeterministic')) return { kind: 'nondeterministic', detail: 'KIELER accepted this run' }
        return { kind: 'engine-rejects', detail: errors.map(e => `${e.code}: ${e.message}`).join(' | ').slice(0, 300) }
    }
    const unsupported = result.diagnostics.find(d => d.code === 'unsupported')
    if (unsupported) return { kind: 'unsupported', detail: unsupported.message }
    let sim
    try {
        sim = createSimulation(result)
    } catch (e) {
        return { kind: 'engine-crash', detail: `createSimulation threw: ${(e as Error).message}` }
    }
    const kielerTickError = rec.errors.find(e => /^tick \d+:/.test(e))
    const diffs: string[] = []
    let first: number | undefined
    let kt = -1
    let et = -1
    for (let i = 0; i < rec.ticks.length; i++) {
        const tick = i + 1
        const expected = rec.ticks[i]
        let actual
        try {
            actual = sim.step(inputs[i] ?? {})
        } catch (e) {
            return { kind: 'engine-crash', detail: `step ${tick} threw: ${(e as Error).message}` }
        }
        const before = diffs.length
        if (actual.error) {
            if (!kielerTickError) diffs.push(`tick ${tick}: engine runtime error ${actual.error.message}`)
            break
        }
        for (const [key, value] of Object.entries(expected.values)) {
            if (!same(actual.pool[key], value)) diffs.push(`tick ${tick}: ${key} KIELER ${show(value)}, engine ${show(actual.pool[key])}`)
        }
        for (const [key, value] of Object.entries(actual.pool)) {
            if (!(key in expected.values) && value !== null) diffs.push(`tick ${tick}: ${key} = ${show(value)} is not in KIELER's pool`)
        }
        if (expected.taken) {
            const counts = sim.takenCounts(actual)
            if (!same(counts, expected.taken)) diffs.push(`tick ${tick}: taken KIELER ${JSON.stringify(expected.taken)}, engine ${JSON.stringify(counts)}`)
        }
        if (expected.terminated && kt < 0) kt = tick
        if (actual.terminatedNow && et < 0) et = tick
        if (diffs.length > before && first === undefined) first = tick
        if (diffs.length > 12) break
    }
    if (kielerTickError && !diffs.length && !sim.history.some(h => h.error)) diffs.push(`KIELER: ${kielerTickError}, engine: no runtime error`)
    if (kt !== et && !diffs.length) {
        diffs.push(`terminates in tick ${kt < 0 ? 'never' : kt} in KIELER, ${et < 0 ? 'never' : et} in the engine`)
        first = Math.min(kt < 0 ? Infinity : kt, et < 0 ? Infinity : et)
    }
    if (diffs.length) {
        // The engine knows that KIELER's cure order, which changes from run to run, decides the behaviour here.
        if (result.diagnostics.some(d => d.code === 'kieler-quirk' && /differently from one compilation to the next/.test(d.message))) {
            return { kind: 'nondeterministic', detail: `behaviour depends on KIELER's cure order: ${diffs[0]}`, diffs, tick: first }
        }
        return { kind: 'behaviour', detail: diffs[0], diffs, tick: first }
    }
    const diag = diagnosticDifference(result.diagnostics, rec)
    if (diag) return { kind: 'diagnostics', detail: diag }
    return { kind: 'match', detail: `${rec.ticks.length} ticks` }
}

/** Engine diagnostics KIELER's front end does not have (the guide's notes) and KIELER's own that the engine words as
 *  an error of the compile stage (corpus.test.ts makes the same exceptions). */
const ENGINE_ONLY = new Set(['swallowed-line', 'ternary-grouping'])

/** The warnings and infos of KIELER's front end (positions) against the engine's, or undefined when they agree. */
function diagnosticDifference(ours: { severity: string; code?: string; span?: { line: number; col: number }; message: string }[], rec: OracleResult): string | undefined {
    if (!rec.diagnostics) return undefined
    const sev = ['', 'error', 'warning', 'info']
    const kieler = rec.diagnostics.filter(d => (d.severity === 2 || d.severity === 3) && !String(d.code ?? '').startsWith('org.eclipse.emf'))
        .map(d => `${sev[d.severity]} ${d.line}:${d.column}`).sort()
    const engine = ours.filter(d => (d.severity === 'warning' || d.severity === 'info') && !SIMULATOR_CODES.has(d.code ?? '') && !ENGINE_ONLY.has(d.code ?? '') && d.code !== 'unsupported' && d.span)
        .map(d => `${d.severity} ${d.span!.line}:${d.span!.col}`).sort()
    if (JSON.stringify(kieler) === JSON.stringify(engine)) return undefined
    const onlyK = kieler.filter(x => !engine.includes(x))
    const onlyE = engine.filter(x => !kieler.includes(x))
    const k = rec.diagnostics.filter(d => onlyK.includes(`${sev[d.severity]} ${d.line}:${d.column}`)).map(d => `${d.line}:${d.column} ${d.message.split('\n')[0]}`)
    const e = ours.filter(d => d.span && onlyE.includes(`${d.severity} ${d.span.line}:${d.span.col}`)).map(d => `${d.span!.line}:${d.span!.col} ${d.code} ${d.message}`)
    return `front end: KIELER only [${k.join(' | ')}] engine only [${e.join(' | ')}]`
}

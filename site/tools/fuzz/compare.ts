// Compares the engine with one oracle result (tools/oracle/oracle.mjs): acceptance, KIELER's data pool, the
// taken-transition counters and the termination tick, tick by tick (as tests/conformance/engine.test.ts does).

import { compile, createSimulation, replaySeeds, SIMULATOR_CODES, type PoolValue, type Simulation, type SimTickResult } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'

export interface OracleResult {
    ok: boolean
    errors: string[]
    /** `clock`: the clock (whole seconds) just before and after the tick; a randomize() in it seeded with one of them. */
    ticks: { step: number; values: Record<string, PoolValue>; taken?: number[]; terminated?: boolean; clock?: [number, number] }[]
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

/** What differs between a tick of the engine and KIELER's recording of it: the data pool and the taken counters. */
function tickDifferences(sim: Simulation, actual: SimTickResult, expected: OracleResult['ticks'][number], tick: number): string[] {
    const diffs: string[] = []
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
    return diffs
}

/**
 * The seeds KIELER's randomize() calls used in a recorded run, per tick (undefined: no call): clock seconds around
 * each tick (`clock`) for which the engine's run is the recorded one, in the data pool and in the transitions taken
 * (a random number may show in nothing but the path). Undefined when no choice of seeds gives the recording (the
 * engine differs from KIELER somewhere else too), or when the engine cannot run the chart.
 */
export function resolveSeeds(model: string, inputs: Record<string, Value>[], rec: OracleResult, files?: Record<string, string>, address?: number): (number[] | undefined)[] | undefined {
    const result = compile(model, { files })
    if (!rec.ok || !result.ok || result.diagnostics.some(d => d.code === 'unsupported')) return undefined
    const window = (i: number): number[] => {
        // The seconds the oracle saw around the tick first, then a second of slack on either side: its clock and the
        // simulation's are read at different moments.
        const [from, to] = rec.ticks[i].clock ?? [0, 0]
        return [...Array.from({ length: to - from + 1 }, (_, k) => from + k), to + 1, from - 1]
    }
    /** The seeds chosen so far, per tick and call. */
    const chosen: number[][] = []
    /** Calls of the last tick run that had no chosen seed yet. */
    let open = 0
    const sim = createSimulation(result, {
        address,
        seed: ({ tick, index }) => {
            const known = chosen[tick - 1]?.[index]
            if (known === undefined) open++
            return known ?? rec.ticks[tick - 1].clock?.[0] ?? 0
        },
    })
    let runs = 0
    /** Tick i + 1 of a fresh run with the chosen seeds (a simulation keeps the seeds of the ticks it ran). */
    const run = (i: number): SimTickResult => {
        runs++
        sim.reset()
        for (let k = 0; k < i; k++) sim.step(inputs[k] ?? {})
        open = 0
        return sim.step(inputs[i] ?? {})
    }
    // One call at a time: how many calls a tick makes can depend on the seeds of the calls before.
    const attempt = (i: number, seeds: number[]): boolean => {
        if (runs > 20000) return false
        chosen.length = i
        chosen[i] = seeds
        const actual = run(i)
        if (open > 0) {
            // Time does not go backwards, within a tick or from one tick to the next.
            const earliest = Math.max(-Infinity, ...chosen.slice(0, i + 1).flat())
            return window(i).some(second => second >= earliest && attempt(i, [...seeds, second]))
        }
        return !actual.error && tickDifferences(sim, actual, rec.ticks[i], i + 1).length === 0 && solve(i + 1)
    }
    const solve = (i: number): boolean => i >= rec.ticks.length || attempt(i, [])
    if (!solve(0)) return undefined
    return Array.from({ length: rec.ticks.length }, (_, i) => (chosen[i]?.length ? chosen[i] : undefined))
}

/**
 * Where KIELER's struct lay in a recorded run of a chart that makes a number of an address (the engine's
 * `c-address-value` warning: a float array assigned to an int): the address changes with every start of KIELER's
 * simulation, and only its low 32 bits show. Found from the first values that differ when the engine runs with the
 * low bits 0; null when the chart shows no address in its values (a printed one is not recorded), undefined when no
 * address gives the recording (the engine differs from KIELER in something else too).
 */
export function resolveAddress(model: string, inputs: Record<string, Value>[], rec: OracleResult, files?: Record<string, string>, seed?: (call: { tick: number; index: number }) => number | undefined): number | null | undefined {
    const result = compile(model, { files })
    if (!rec.ok || !result.ok || !result.diagnostics.some(d => d.code === 'c-address-value')) return null
    const zero = 0x555500000000
    /** The numbers that differ (KIELER's, the engine's) up to the first tick that differs, and whether the run is the
     *  recorded one. */
    const run = (address: number | undefined): { pairs: [number, number][]; same: boolean } => {
        const sim = createSimulation(result, { address, seed })
        const pairs: [number, number][] = []
        let other = false
        const visit = (k: PoolValue | undefined, e: PoolValue | undefined) => {
            if (typeof k === 'number' && typeof e === 'number') { if (k !== e) pairs.push([k, e]) }
            else if (Array.isArray(k) && Array.isArray(e) && k.length === e.length) k.forEach((x, i) => visit(x, e[i]))
            else if (k && e && typeof k === 'object' && typeof e === 'object' && !Array.isArray(k) && !Array.isArray(e)) for (const key of Object.keys(k)) visit(k[key], (e as Record<string, PoolValue>)[key])
            else if (!same(k, e)) other = true
        }
        for (let i = 0; i < rec.ticks.length && !other && !pairs.length; i++) {
            const actual = sim.step(inputs[i] ?? {})
            if (actual.error) { other = true; break }
            for (const [key, value] of Object.entries(rec.ticks[i].values)) visit(value, actual.pool[key])
            if (rec.ticks[i].taken && !same(sim.takenCounts(actual), rec.ticks[i].taken)) other = true
        }
        return { pairs, same: !other && !pairs.length }
    }
    const first = run(zero)
    // The trial address gives the recording: no address shows, unless the engine's own default would show one.
    if (first.same) return run(undefined).same ? null : zero
    // KIELER's struct comes from malloc: its address is a multiple of 16 (an odd one would fit any number).
    const aligned = (low: number) => low % 16 === 0
    // A value is the address plus or minus something the engine knows (the first tick that shows it tells).
    for (const [k, e] of first.pairs.slice(0, 4)) {
        // (Twice the address too, `x *= fa` from 2: half the difference, with either top bit.)
        const half = ((k - e) >>> 0) % 2 === 0 ? [((k - e) >>> 0) / 2, ((k - e) >>> 0) / 2 + 0x80000000] : []
        for (const low of [(k - e) >>> 0, (e - k) >>> 0, ...half]) {
            if (aligned(low) && run(zero + low).same) return zero + low
        }
    }
    // The address shows in nothing but the path taken (a trigger compares it): one of each sign and size.
    for (const low of [0x80000000, 0x40000000, 0xc0000000, 0x10000000, 0xf0000000, 0x7fffff00]) {
        if (run(zero + low).same) return zero + low
    }
    return undefined
}

/**
 * The seeds and the address of a recorded run together. A chart can show both (a random number and an address in
 * one pool): then neither is found without the other, so the address is looked for with the clock's own seconds as
 * the seeds, and the seeds with that address.
 */
export function resolveRun(model: string, inputs: Record<string, Value>[], rec: OracleResult, files?: Record<string, string>): { seeds?: (number[] | undefined)[]; address?: number | null } {
    const seeded = rec.ticks.some(t => t.clock) && /\brandomize\b/.test([model, ...Object.values(files ?? {})].join('\n'))
    if (!seeded) return { address: resolveAddress(model, inputs, rec, files) }
    const seeds = resolveSeeds(model, inputs, rec, files)
    if (seeds) {
        const address = resolveAddress(model, inputs, rec, files, replaySeeds(seeds.map(x => ({ seeds: x }))))
        if (address !== undefined) return { seeds, address }
    }
    for (const pick of [0, 1]) {
        const address = resolveAddress(model, inputs, rec, files, call => rec.ticks[call.tick - 1]?.clock?.[pick])
        if (typeof address !== 'number') continue
        const both = resolveSeeds(model, inputs, rec, files, address)
        if (both) return { seeds: both, address }
    }
    return { seeds, address: undefined }
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
        // KIELER seeded each randomize() with its clock: the engine gets the seconds that give KIELER's run, if any do.
        // A chart that shows an address: the one KIELER's struct had in the recorded run.
        const { seeds, address } = resolveRun(model, inputs, rec, files)
        const seed = seeds ? replaySeeds(seeds.map(s => ({ seeds: s }))) : undefined
        sim = createSimulation(result, { seed, address: address ?? undefined })
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
        diffs.push(...tickDifferences(sim, actual, expected, tick))
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

// Checks the "basics" conformance suite against its KIELER recordings: every chart has a scenario and an
// up-to-date oracle recording, the recording agrees with the scenario's "expect", and the claims the spec
// (docs-internal/semantics/basics.md) makes about each chart hold in the recorded trace. The engine's own
// conformance test compares the simulator with the same recordings.
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
    inputsLeftUnset?: string[]
    kielerBug?: string
}

interface Recording {
    hash: string
    ok: boolean
    system: string
    errors: string[]
    interface?: Record<string, { type: string; properties: string[] }>
    ticks: { step: number; values: Record<string, unknown>; taken?: number[]; terminated?: boolean }[]
}

/** Same hash as tools/oracle/record.mjs (which cannot be imported: it records on load). */
function scenarioHash(model: string, scenario: Scenario): string {
    const ticks = (scenario.ticks ?? []).map(t => t.inputs ?? {})
    return crypto.createHash('sha1').update(JSON.stringify([model, ticks, scenario.system ?? 'netlist', scenario.imports ?? null])).digest('hex')
}

const names = fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).map(f => f.slice(0, -5)).sort()

function load(name: string) {
    const model = fs.readFileSync(path.join(dir, `${name}.sctx`), 'utf8')
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, `${name}.scenario.json`), 'utf8')) as Scenario
    const recording = JSON.parse(fs.readFileSync(path.join(dir, `${name}.oracle.json`), 'utf8')) as Recording
    return { model, scenario, recording }
}

// What the spec says each chart does, tick by tick: a subset of the recorded values (`taken` and
// `terminated` refer to the oracle's taken[] and _TERM). Every listed value must match the recording.
type Claim = Record<string, unknown>
const claims: Record<string, Claim[]> = {
    '01-first-tick': [{ x: 1, taken: [1, 0] }, { x: 11, taken: [0, 1] }, { x: 11 }],
    '02-delayed-waits': [{ x: 0, taken: [0] }, { x: 1, taken: [1] }, { x: 1 }],
    '03-immediate-chain': [{ x: 15, taken: [1, 1, 1, 0] }, { x: 15, taken: [0, 0, 0, 1] }, { x: 15 }],
    '04-delayed-then-immediate': [{ x: 0 }, { x: 11, taken: [1, 1, 0] }, { x: 111, taken: [0, 0, 1] }, { x: 111 }],
    '05-cycle-with-one-delay': [{ x: 0, taken: [1, 0, 0] }, { x: 1, taken: [1, 1, 1] }, { x: 2, taken: [1, 1, 1] }, { x: 2, taken: [0, 0, 0] }],
    '06-priority-first-wins': [
        { x: 0 }, { x: 1, taken: [1, 0, 0, 0, 0, 0] }, { x: 1, taken: [0, 0, 0, 1, 0, 0] }, { x: 2, taken: [0, 1, 0, 0, 0, 0] },
        { x: 2, taken: [0, 0, 0, 0, 1, 0] }, { x: 3, taken: [0, 0, 1, 0, 0, 0] }, { x: 3, taken: [0, 0, 0, 0, 0, 1] },
    ],
    '07-entry-tick-immediate-only': [{ x: 2, taken: [0, 1] }, { x: 2 }],
    '08-priority-delayed-beats-immediate': [{ x: 0 }, { x: 1, taken: [1, 0] }, { x: 1 }],
    '09-no-trigger': [{ x: 0 }, { x: 1, taken: [1, 0, 0] }, { x: 2, taken: [0, 0, 1] }, { x: 2 }],
    '10-immediate-after-untriggered-delayed': [{ x: 2, taken: [0, 1] }, { x: 2 }],
    '11-self-loop-every-tick': [{ x: 0 }, { x: 1 }, { x: 2 }, { x: 3 }],
    '12-self-loop-reenters': [{ x: 0, entries: 1 }, { x: 1, entries: 2 }, { x: 2, entries: 3 }, { x: 3, entries: 4 }],
    '13-self-loop-reinitialises-locals': [{ x: 0 }, { x: 11 }, { x: 11 }, { x: 11 }],
    '14-superstate-reinitialises-locals': [{ seen: 0 }, { seen: 1, taken: [1, 1, 0] }, { seen: 1 }, { seen: 1, taken: [0, 0, 1] }, { seen: 1 }, { seen: 2 }],
    '15-effects-sequential': [{ x: 0 }, { x: 5, y: 1, z: 6 }, { x: 5, y: 1, z: 6 }],
    '16-trigger-sees-earlier-effects': [{ x: 1, y: 1, taken: [1, 1, 0] }, { y: 1 }],
    '23-root-final-terminates': [{ x: 0, terminated: false }, { x: 1, terminated: true }, { x: 1, terminated: false, taken: [0] }, { x: 1, terminated: false }],
    '24-terminate-in-tick-one': [{ x: 7, terminated: true }, { x: 7, terminated: false }],
    '25-root-final-with-outgoing': [{ x: 0 }, { x: 0, terminated: true }, { x: 0, taken: [0, 0], terminated: false }, { x: 0 }],
    '26-final-with-immediate-outgoing': [{ x: 5, terminated: false, taken: [1, 1] }, { x: 5, terminated: false }],
    '27-final-outgoing-in-running-parent': [{ x: 0 }, { x: 0, taken: [1, 0] }, { x: 1, taken: [0, 1] }, { x: 1, taken: [1, 0] }, { x: 2 }],
    '28-default-values': [{ I: 0, B: false, F: 0, x: 0, b: false, f: 0, localInt: 0, localBool: false, localFloat: 0, S: undefined, s: undefined, localString: undefined }, {}],
    '29-initialiser-reads-input': [{ y: 5, z: 6 }, { y: 5, z: 6 }, { y: 5, z: 6 }],
    '30-initialiser-order': [{ x: 5, y: 1 }, { x: 5, y: 1 }],
    '31-input-initial-value': [{ I: 42, J: 3, B: true }, { x: 42, y: 3, b: true }, { x: 1, y: 3, b: false }],
    '32-const': [{ a: [0, 0, 0], N: undefined, M: undefined }, { x: 7, y: 6, f: 1.5, b: true }, { x: 16 }],
    '36-inputs-persist': [{ count: 0 }, { last: 5, count: 0 }, { count: 1, last: 5 }, { count: 2, last: 9 }, { count: 2 }],
    '37-input-written-by-chart': [{ seen: 0, I: 1 }, { seen: 1, I: 11 }, { seen: 11, I: 21 }, { seen: 7, I: 17 }, { seen: 17 }],
    '38-int-division': [{}, { q: 3, r: 1, f: 3 }, { q: -3, r: -1 }, { q: -3, r: 1 }, { q: 3, r: -1 }],
    '39-int-overflow': [{}, { sum: -2147483648, product: -2, negated: -2147483647 }, { sum: -2147483647, product: 0, negated: -2147483648 }],
    '40-float-literals': [{}, { a: 0.10000000149011612, b: 2.5, c: 0.3333333333333333, d: 0.3000000029802322, e: 1500, i: 7, j: -7, k: 3 }, { d: 0.7000000029802322 }],
    '41-float-comparison': [
        { lit: 0.10000000149011612 },
        { inputEqualsLiteral: false, variableEqualsLiteral: true, inputBelowLiteral: true, exact: false },
        { inputBelowLiteral: false, exact: false },
    ],
    '43-int-as-trigger': [{ x: 0 }, { x: 0 }, { x: 1 }, { x: 2 }],
    '44-bool-int-mixing': [
        {},
        { plus: 2, logical: 1, nonZero: true, negation: false, big: true, fromBool: 5, twice: 10, wrapped: false, half: false },
        { plus: 1, logical: 0, nonZero: false, negation: true },
    ],
    '45-bitwise-and-shifts': [{}, { and: 8, or: 14, xor: 6, not: -13, shl: 48, shr: -6, neg: -12 }, { and: 1, or: 3, xor: 2, not: -2, shl: 4, shr: -1, neg: -1 }],
    '47-ternary': [{}, { pick: 20, guarded: 3, keep: 1, sum: 21, nested: 3 }, { pick: 10, keep: 5, sum: 11, nested: 1 }, { guarded: 0, nested: 2 }],
    '48-ternary-binds-tight': [{ y: 0 }, { y: 0 }, { y: 0 }, { y: 0 }],
    '49-logic-short-circuit': [{}, { p: false, r: true, s: true, t: true }, { p: false, r: false, s: false, t: false }],
    '50-assignment-operators': [
        { add: 10 },
        { add: 15, sub: 5, mul: 50, div: 2, mod: 1, and: 4, or: 13, xor: 9, shl: 12, shr: -4, inc: 1, dec: -1 },
        { add: 20, sub: 0, mul: 250, div: 0, mod: 1, and: 4, or: 13, xor: 12, shl: 48, shr: -1, inc: 2, dec: -2 },
    ],
    '51-min-max-assign': [{}, { lowest: 4, highest: 10, fl: 1.5 }, { lowest: 4, highest: 21, fl: 1.5 }, { lowest: -3, highest: 21, fl: -3 }],
    '52-compound-assign-float-to-int': [{}, { x: 7, y: 10, f: 2.5 }, { x: 7, y: 15, f: 3.5 }],
    '53-arrays': [
        { arr: [1, 2, 3, 4, 5], partial: [7, 8, 0], flags: [false, false] },
        { arr: [6, 7, 8, 9, 10] },
        { arr: [0, 0, 108, 9, 10], grid: [[1, 2], [20, 4]], flags: [false, true], sum: 10 },
        { arr: [0, 0, 108, 9, 110], sum: 110 },
    ],
    '54-vector-assign-sequential': [{ arr: [1, 2, 3] }, { arr: [2, 3, 2] }, { arr: [3, 2, 3] }],
    '58-input-array-partial': [{}, { s: 123 }, { s: 423, A: [4, 2, 3] }, { s: 423 }],
    '59-strings': [
        { copy: undefined, t: 'hi' },
        { inputEqualsLiteral: false, variableEqualsLiteral: true, literalEqualsLiteral: true, isNull: true, copy: 'hi' },
        { isNull: false, copy: 'ho', inputEqualsLiteral: false },
    ],
    '61-random': [{ r: 0, percent: 0 }, { r: 0.8401877284049988, percent: 39 }, { r: 0.7830992341041565, percent: 79 }, { r: 0.911647379398346, percent: 19 }],
    '62-taken-transition-order': [
        { taken: [0, 0, 0, 0, 0, 0] }, { taken: [0, 0, 1, 0, 0, 0] }, { taken: [0, 0, 0, 1, 0, 0] }, { taken: [1, 0, 0, 0, 0, 0] },
        { taken: [0, 0, 0, 0, 1, 0] }, { taken: [0, 0, 0, 0, 0, 1] }, { taken: [0, 1, 0, 0, 0, 0] }, { taken: [0, 0, 0, 0, 0, 0] },
    ],
    '63-kieler-bug-tick1-reorder': [{ y: 3, z: 11 }, { y: 3, z: 11 }],
    '64-kieler-bug-tick1-reorder-priority': [{ y: 13, z: 14 }, { y: 13, z: 14 }],
    '65-kieler-bug-tick1-input-index': [{ arr: [5, 0, 0] }, { arr: [5, 0, 0] }],
    '66-kieler-bug-compound-then-read': [{ count: 1, shown: 1 }, { count: 2, shown: 1 }, { count: 3, shown: 1 }],
    '67-kieler-bug-compound-then-read-priority': [{ count: 1, shown: 1 }, { count: 2, shown: 2 }, { count: 3, shown: 3 }],
    '68-input-initial-value-priority': [{ J: 42 }, { x: 42, y: 42, b: true }, { x: 1, y: 42, b: false }],
    '69-first-chart-is-simulated': [{ a: 0, b: undefined, J: undefined, taken: [0] }, { a: 1, taken: [1] }, { a: 1 }],
    '70-region-local-initialised-once': [{ seen: 0 }, { seen: 1 }, { seen: 11 }, { seen: 12 }, { seen: 22 }],
    '71-loop-bounded-counter-priority': [{ x: 3, taken: [3] }, { x: 3, taken: [0] }],
    '72-self-loop-exit-effect-entry': [{ log: 3 }, { log: 3123 }, { log: 3123123 }],
    '73-loop-through-join-with-pause': [{ x: 0, taken: [0, 0, 0] }, { x: 1, taken: [1, 1, 1] }, { x: 2 }, { x: 3 }],
    '75-const-after-input-output': [{ o: 0, M: undefined, N: undefined }, { o: 7, taken: [1] }],
}

describe('basics conformance suite', () => {
    it('has 25 or more charts, each with a scenario and a recording', () => {
        expect(names.length).toBeGreaterThanOrEqual(25)
        for (const name of names) {
            expect(fs.existsSync(path.join(dir, `${name}.scenario.json`)), `${name}.scenario.json`).toBe(true)
            expect(fs.existsSync(path.join(dir, `${name}.oracle.json`)), `${name}.oracle.json`).toBe(true)
        }
    })

    for (const name of names) {
        describe(name, () => {
            const { model, scenario, recording } = load(name)
            const expected = scenario.expect ?? 'ok'

            it('recording is up to date', () => {
                expect(recording.hash).toBe(scenarioHash(model, scenario))
                expect(recording.system).toBe(scenario.system ?? 'netlist')
            })

            it(`KIELER ${expected === 'ok' ? 'accepts' : 'rejects'} it`, () => {
                expect(recording.ok, recording.errors.join(' | ')).toBe(expected === 'ok')
                if (expected === 'error' && scenario.errorIncludes)
                    expect(recording.errors.some(e => e.includes(scenario.errorIncludes!)), recording.errors.join(' | ')).toBe(true)
                if (expected === 'ok') expect(recording.ticks.length).toBe(scenario.ticks.length)
            })

            it('every tick has a note', () => {
                for (const tick of scenario.ticks) expect(tick.note?.length ?? 0).toBeGreaterThan(10)
            })

            if (expected === 'ok') {
                it('sets every input in tick 1', () => {
                    const inputs = Object.entries(recording.interface ?? {}).filter(([, v]) => v.properties.includes('input')).map(([k]) => k)
                    const unset = new Set(scenario.inputsLeftUnset ?? [])
                    for (const input of inputs) if (!unset.has(input)) expect(scenario.ticks[0].inputs ?? {}, input).toHaveProperty(input)
                })

                it('matches the claims of the spec', () => {
                    const list = claims[name]
                    expect(list, `no claims written for ${name}`).toBeDefined()
                    expect(list.length).toBe(recording.ticks.length)
                    list.forEach((claim, i) => {
                        const tick = recording.ticks[i]
                        for (const [key, value] of Object.entries(claim)) {
                            const actual = key === 'taken' ? tick.taken : key === 'terminated' ? tick.terminated : tick.values[key]
                            expect(actual, `${name} tick ${i + 1} ${key}`).toEqual(value)
                        }
                    })
                })
            }
        })
    }
})

// Checks the "structure" conformance suite (references, imports, for-regions, dataflow, time, methods and SCL,
// enums/structs/classes, host code, static/global, compilation systems) against its KIELER recordings: every chart
// has a scenario and an up-to-date oracle recording, the recording agrees with the scenario's "expect", and the
// claims the spec (docs-internal/semantics/structure.md) makes about each chart hold in the recorded trace. The
// engine's own conformance test compares the simulator with the same recordings.
//
// Scenario fields beyond the common format:
//   imports    files next to the chart that the oracle loads with it (import "...")
//   needs      ["c-hostcode"] / ["c-strings"] / ["c-random"]: the recorded behaviour comes from C (host code
//              and gcc, char* string comparison, glibc rand()) that a TypeScript engine cannot run as such; the
//              engine should report such charts as unsupported, or emulate the C behaviour (spec S-49, S-50),
//              rather than be compared blindly.
//   kielerBug  the recorded behaviour is a defect of KIELER, reproduced on purpose (fidelity), with the reason.
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
    needs?: string[]
    kielerBug?: string
}

interface Recording {
    hash: string
    ok: boolean
    system: string
    errors: string[]
    warnings: string[]
    diagnostics?: { severity: number; message: string }[]
    interface?: Record<string, { type: string; properties: string[] }>
    ticks: { step: number; values: Record<string, unknown>; taken?: number[]; terminated?: boolean }[]
}

/** Same hash as tools/oracle/record.mjs (which cannot be imported: it records on load). */
function scenarioHash(model: string, scenario: Scenario): string {
    const ticks = (scenario.ticks ?? []).map(t => t.inputs ?? {})
    const imports = scenario.imports
        ? Object.fromEntries(scenario.imports.map(f => [path.basename(f), fs.readFileSync(path.join(dir, f), 'utf8')]))
        : null
    return crypto.createHash('sha1').update(JSON.stringify([model, ticks, scenario.system ?? 'netlist', imports])).digest('hex')
}

const names = fs.readdirSync(dir).filter(f => f.endsWith('.scenario.json')).map(f => f.slice(0, -'.scenario.json'.length)).sort()

function load(name: string) {
    const model = fs.readFileSync(path.join(dir, `${name}.sctx`), 'utf8')
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, `${name}.scenario.json`), 'utf8')) as Scenario
    const recording = JSON.parse(fs.readFileSync(path.join(dir, `${name}.oracle.json`), 'utf8')) as Recording
    return { model, scenario, recording }
}

// What the spec says each accepted chart does, tick by tick: a subset of the recorded values (`taken` and
// `terminated` refer to the oracle's taken[] and _TERM; `undefined` means "not in the data pool").
type Claim = Record<string, unknown>
const claims: Record<string, Claim[]> = {
    '01-two-roots-first-wins': [{ X: false, Y: undefined, taken: [0] }, { X: true, taken: [1] }],
    '02-reference-explicit': [{ speaker: false, beep: undefined }, { speaker: true }, { speaker: true }, { speaker: false }],
    '03-reference-order': [{ led: false }, { led: true }, { led: false }],
    '04-reference-implicit': [{ speaker: false }, { speaker: true }],
    '05-binding-order-continues-after-explicit': [{ o: 0 }, { o: 712 }],
    '06-reference-literal-input': [{ led: false }, { led: true }, { led: false }],
    '07-reference-output-initialised-on-entry': [{ o: 100 }, { o: 101 }, { o: 102 }, { o: 100, taken: [1] }, { o: 101 }],
    '08-reference-instances-are-independent': [{ a: 0, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }],
    '09-reference-join': [{ done: false, steps: 0 }, { done: true, steps: 1, taken: [1] }, { done: true }],
    '10-reference-weak-abort': [{ o: 0 }, { o: 1 }, { o: 2 }, { o: 3, taken: [1] }, { o: 3, taken: [0] }],
    '11-reference-strong-abort': [{ o: 0 }, { o: 1 }, { o: 2 }, { o: 3, taken: [0] }, { o: 3, taken: [1] }, { o: 3 }],
    '12-reference-root-actions': [{ log: 1 }, { log: 11, taken: [1] }, { log: 11 }],
    '13-reference-input-written-through': [{ z: 3, o: 0 }, { z: 4, o: 4 }, { z: 5, o: 5 }],
    '14-reference-signals': [
        { count: 0, Beat: false, W: false },
        { count: 1, Beat: true, W: true, W_val: 8 },
        { count: 1, Beat: false, W: false, W_val: 8 },
        { count: 2, Beat: true },
    ],
    '15-reference-arrays': [{ s: 0, m: 0 }, { s: 15, m: 50 }],
    '16-import': [{ speaker: false }, { speaker: true }],
    '23-warn-join-never-terminates': [{ done: false }, { done: false, taken: [0] }],
    '24-region-is-super': [{ o: 0 }, { o: 1 }, { o: 1 }, { o: 1 }, { o: 2 }],
    '26-reference-taken-transitions': [{ X: false, taken: [0, 0] }, { X: false, taken: [1, 0] }, { X: true, taken: [0, 1] }],
    '28-duplicate-root-names': [{ o: 0, p: undefined, taken: [0] }, { o: 1, taken: [1] }],
    '29-ref-declaration-instance': [{ O: true }, { O: false }],
    '30-for-range': [{ O: false, i: undefined }, { O: false }, { O: false }, { O: true, taken: [1, 1] }],
    '31-for-array': [{ n: 0 }, { n: 2, taken: [2] }, { n: 3, taken: [1], terminated: true }],
    '32-for-descending-and-order': [{ s: 97321, taken: [1, 3, 1], terminated: true }],
    '40-dataflow-basic': [{ O: false }, { O: false }, { O: true }, { O: false }],
    '41-dataflow-order-independent': [{ X: 2, Y: 4, Z: 3 }, { X: 6, Y: 12, Z: 11 }],
    '42-dataflow-init-fby-pre': [
        { arrow: 0, followed: 0, arrowPre: 0, previous: 0 },
        { arrow: 6, followed: 5, arrowPre: 5, previous: 5 },
        { arrow: 9, followed: 6, arrowPre: 6, previous: 6 },
    ],
    '43-dataflow-delay-precedence': [{ N1: 1, N2: 0 }, { N1: 2, N2: 1 }, { N1: 3, N2: 2 }],
    '44-dataflow-sequential': [{ X: 21 }, { X: 51 }],
    '45-dataflow-self-update': [{ N: 1, X: 1 }, { N: 2, X: 3 }, { N: 3, X: 6 }],
    '46-dataflow-sfby': [{ two: 1, chain: 1 }, { two: 20, chain: 2 }, { two: 30, chain: 2 }, { two: 40, chain: 2 }],
    '47-dataflow-ref-instances': [{ O: false, P: false }, { O: true, P: false }, { O: false, P: false }],
    '48-dataflow-ref-restarts': [{ O: 0 }, { O: 1 }, { O: 2 }, { O: 2 }, { O: 1 }, { O: 2 }],
    '49-dataflow-once': [{ X: 2, terminated: true }, { X: 2, terminated: false }],
    '58-dataflow-concurrent-updates': [{ X: 5, Y: 8, Z: 3, W: 10 }, { X: 13, Y: 22, Z: 7, W: 20 }],
    '57-dataflow-delay-chains': [{ arrows: 1, fbys: 1 }, { arrows: 20, fbys: 2 }, { arrows: 30, fbys: 10 }, { arrows: 40, fbys: 20 }],
    '50-dataflow-reentry-restarts-delays': [{ A: 0, B: 0 }, { A: 6, B: 5 }, { A: 0, B: 0, taken: [1] }, { A: 8, B: 7 }],
    '51-fby-blocks-termination': [{ doneX: false, doneY: true }, { doneX: false, doneY: true }],
    '52-dataflow-ternary-precedence': [{ wrong: 0, right: 2 }, { wrong: 0, right: 5 }],
    '60-clock-timeout': [
        { t: 0, sleepT: 300, done: false },
        { t: 100, sleepT: 200 },
        { t: 200, sleepT: 100 },
        { t: 300, sleepT: 1000, done: true, terminated: true },
        { t: 300 },
    ],
    '61-clock-reset-blink': [
        { t: 0, sleepT: 500, on: false },
        { t: 250, sleepT: 250 },
        { t: 0, sleepT: 200, on: true, taken: [1, 0] },
        { t: 100, sleepT: 100 },
        { t: 0, sleepT: 500, on: false, taken: [0, 1] },
        { t: 300, sleepT: 200 },
        { t: 0, on: true, taken: [1, 0] },
    ],
    '62-clock-not-reset': [{ t: 0 }, { t: 250 }, { t: 500, on: true }, { t: 600, on: false }, { t: 700, on: true }],
    '63-clock-local-restarts': [
        { sleepT: 300, timeout: false, t: undefined },
        { sleepT: 200 },
        { sleepT: 100 },
        { sleepT: 300, timeout: false, taken: [1, 1] },
        { sleepT: 200 },
        { sleepT: 100 },
        { sleepT: 1000, timeout: true, taken: [0, 1] },
    ],
    '64-clock-greater-and-default-sleep': [{ sleepT: 50 }, { t: 50, sleepT: 50 }, { t: 100, sleepT: 1, a: false }, { t: 101, sleepT: 50, a: true }],
    '65-clock-integer-type': [{ sleepT: 300 }, { t: 150, sleepT: 150 }, { t: 300, done: true }],
    '66-clock-simulate-sleep': [{ sleepT: 300, n: 0 }, { deltaT: 300, n: 1 }, { n: 2 }],
    '69-period': [{ n: 0, sleepT: 300 }, { n: 0 }, { n: 0 }, { n: 1 }, { n: 1 }, { n: 2, sleepT: 250 }, { n: 3 }, { n: 3, sleepT: 50 }],
    '70-period-hard-reset': [{ n: 0 }, { n: 0 }, { n: 0 }, { n: 1 }, { n: 1 }, { n: 2, sleepT: 300 }, { n: 2 }, { n: 3 }],
    '72-period-guards-entry-actions': [
        { e1: 0, e2: 1, n1: 0, n2: 0 },
        { e1: 0, e2: 1, n1: 0, n2: 0 },
        { e1: 0, e2: 1, n1: 0, n2: 0 },
        { e1: 1, e2: 2, n1: 1, n2: 1, taken: [1, 1] },
    ],
    '73-clock-greedy-bound': [{ sleepT: 1000 }, { x: 500, sleepT: 500 }, { x: 0, n: 1, sleepT: 1 }, { x: 100, sleepT: 900 }],
    '75-methods': [{ y: 9, s: 3, count: 0 }, { y: 17, count: 1, big: false }, { y: 17, count: 2, big: true }],
    '76-code-effect': [{ a: 0, b: 0 }, { a: 1, b: 2 }, { a: 2, b: 4 }, { a: 3, b: 0 }],
    '77-hostcode-backticks': [{ x: 0, y: 0 }, { x: 42, y: 42 }],
    '78-extern-function': [{ x: 0, y: 0, z: 0 }, { x: 6, y: -12, z: 7 }],
    '81-print': [{ n: 0 }, { n: 1 }],
    '82-string-equality-c': [{ hit: false, mode: 'idle' }, { hit: false, mode: 'idle' }],
    '83-random-c': [{ r: 0, i: 5 }, { r: 0.8401877284049988, i: 0 }, { r: 0.7830992341041565, i: 0 }],
    '85-static-local': [
        { kept: 1, plain: 1, St85Visits_region0_A___visits: 1 },
        { kept: 1 },
        { kept: 2, plain: 1 },
        { kept: 2 },
        { kept: 3, plain: 1 },
    ],
    '86-global-in-instances': [{ shared: 0 }, { shared: 2 }, { shared: 4 }],
    '91-priority-runs-guarded-loop': [{ n: 0 }, { n: 5, taken: [5, 5] }, { n: 5, taken: [0, 0] }],
    '92-netlist-first-tick-input-write': [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    '93-priority-first-tick-input-write': [{ x: 7, y: 7 }, { x: 2, y: 2 }],
    '95-for-declaration-shared': [{ sum: 15, taken: [3], terminated: true }],
    '98-hostcode-java-import': [{ x: 0, taken: [0] }, { x: 1, taken: [1] }],
    '99-randomize-after-tick-1': [{ n: 0 }, { n: 1, taken: [1] }, { n: 1 }],
    // Silent transitions and states without code in referenced charts (S-15a)
    '158-reference-silent-self-loop': [{ x: 0 }, { x: 0 }, { x: 1 }, { x: 1 }, { x: 1 }, { x: 2 }, { x: 2 }],
    '159-reference-silent-cycle': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 6 }],
    '161-reference-equal-branches': [{ x: 0 }, { x: 0, taken: [1] }, { x: 0 }, { x: 0 }, { x: 0 }, { x: 0 }, { x: 0 }],
    '162-reference-dependency-stop': [
        { S: false, y: 0 }, { S: false, y: 0 }, { S: false, y: 0 }, { S: false, y: 0 },
        { S: false, y: 0 }, { S: false, y: 0 }, { S: false, y: 0 }, { S: false, y: 0 },
    ],
    '164-reference-nodeless-single-region': [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 1, z: 1 }, { x: 2, y: 2, z: 1 },
        { x: 3, y: 3, z: 1 }, { x: 4, y: 4, z: 2 }, { x: 4, y: 5, z: 3 }, { x: 5, y: 6, z: 3 },
    ],
    // Object-oriented data (section 8)
    '100-enum-values': [{ c: 2, d: 0, n: 0 }, { c: 0, n: 1 }, { c: 1, n: 2, isGreen: false }, { isGreen: true }],
    '101-enum-copy': [{ a: 1, b: 2, same: false }, { b: 1, same: false }, { same: true }],
    '102-enum-io': [{ last: 2, moves: 0 }, { last: 0, moves: 1 }, { last: 1, moves: 2 }, { last: 1, moves: 2 }],
    '103-enum-from-other-chart': [{ b: 0 }, { b: 1 }, { b: 1, terminated: true }],
    '106-struct-members': [
        { p: { x: 0, y: 5, seen: false, hist: [0, 0, 0] }, q: { x: 0, y: 5, seen: false, hist: [0, 0, 0] } },
        { p: { x: 1, y: 5, seen: false, hist: [0, 10, 0] }, q: { x: 0, y: 10, seen: true, hist: [0, 0, 0] } },
        { p: { x: 2, y: 5, seen: false, hist: [0, 10, 20] } },
    ],
    '107-struct-nested': [
        { l: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, width: 1 } },
        { l: { a: { x: 3, y: 0 }, b: { x: 0, y: 4 }, width: 1 } },
        { l: { a: { x: 3, y: 0 }, b: { x: 0, y: 4 }, width: 1 } },
    ],
    '108-struct-concurrent-members': [{ sum: 0 }, { sum: 3, p: { x: 1, y: 2 } }, { sum: 3 }],
    '112-struct-in-nested-state': [{ seen: 0, p: undefined }, { seen: 5 }, { seen: 6 }, { seen: 6 }, { seen: 5 }],
    '113-class-fields-methods': [
        { c1: { count: 10 }, c2: { count: 10 } },
        { b: 15, report: 115, c1: { count: 10 }, c2: { count: 15 } },
        { a: 11, report: 111, c1: { count: 11 } },
        { b: 20, report: 120, c2: { count: 20 } },
    ],
    '114-class-private-helpers': [{ O: 0, c: { v: 0 } }, { O: 2, c: { v: 2 } }, { O: 4, c: { v: 4 } }],
    '115-class-method-trigger': [{ done: false, c: { v: 0 } }, { done: false, c: { v: 1 } }, { done: true, c: { v: 2 }, terminated: true }, { c: { v: 2 } }],
    '120-class-concurrent-calls': [{ seen: 0 }, { seen: 2, c: { v: 2 } }, { seen: 4, c: { v: 4 } }],
    '121-class-overload-by-count': [{ O: 0 }, { O: 11, c: { v: 11 } }, { O: 22 }],
    '122-unpack-class': [{ acc_sum: 1, acc: undefined }, { acc_sum: 3, O: 3 }, { acc_sum: 3 }],
    '124-class-inner': [{ o: { in: { v: 0 }, w: 0 } }, { o: { in: { v: 1 }, w: 1 } }, { o: { in: { v: 2 }, w: 2 } }],
    '125-class-instance-array': [{ cs: [{ v: 0 }, { v: 0 }] }, { cs: [{ v: 1 }, { v: 0 }] }, { cs: [{ v: 2 }, { v: 0 }] }],
    '126-chart-class': [
        { O: 0, c: { counter: 0, step: 1 } },
        { O: 1, c: { counter: 1, step: 1 } },
        { O: 6, c: { counter: 6, step: 5 } },
        { O: 11 },
    ],
    '127-chart-class-regions': [{ O: 0, t: undefined }, { O: 1 }, { O: 2, taken: [1, 1, 0] }, { O: 2 }, { O: 1 }],
    '130-chart-class-inheritance': [
        { O1: 0, O2: 0, counter1: { St130Counter_counter: 0, counting: true }, counter2: { St130Counter_counter: 0, counting: false } },
        { O1: 1 },
        { O1: 2 },
        { O1: 2, O2: 0, counter1: { St130Counter_counter: 2, counting: false }, counter2: { St130Counter_counter: 0, counting: true } },
        { O2: 1 },
        { O2: 2 },
        { O1: 2, O2: 2 },
        { O1: 3, O2: 2 },
    ],
    '131-override-method': [{ O: 0, P: 0, Q: 0 }, { O: 5, P: 10, Q: 2 }, { O: 5, P: 10, Q: 2 }],
    '134-protected-field': [{ O: 0, s: { St134Base_secret: 21 } }, { O: 42 }, { O: 42 }],
    '138-override-super-keeps-base': [{ O: 0, P: 0 }, { O: 5, P: 2 }, { O: 5, P: 2 }],
    '157-struct-const-member': [{ c: { v: 0 } }, { c: { v: 1 } }, { c: { v: 2 } }, { c: { v: 3 }, taken: [1] }, { c: { v: 3 }, taken: [0] }],
    // SCL in methods and code effects (S-44a..S-44f)
    '139-scl-semicolons': [{ a: 0, b: 0, c: 0, d: 0 }, { a: 1, b: 10, c: 10, d: 4 }, { a: 2, b: 10, c: 10, d: 8 }],
    '143-scl-if-else': [{ grade: 0, tripled: 0, t: undefined }, { grade: 1, tripled: 21 }, { grade: 2, tripled: 36 }, { grade: 0, tripled: 9 }],
    '145-scl-loops': [{ sum: 0, bits: 0, first: 0 }, { sum: 10, bits: 1, first: 7 }, { sum: 28, bits: 3, first: 10 }],
    '147-scl-early-return': [{ y: 0 }, { y: 10 }, { y: 0 }, { y: 7 }],
    '150-scl-parameter-inlined-vs-function': [{ ya: 0, yb: 0 }, { a: 9, b: 4, ya: 9, yb: 9 }, { a: 9, b: 4 }],
    '152-scl-blocks-in-actions': [{ e: 1, d: 0 }, { d: 1 }, { d: 2, x: 22, p: 1, q: 2 }, { e: 2, d: 0 }],
    '153-scl-goto-forward': [{ O: 0, P: 0 }, { O: 1, P: 1 }, { O: 1, P: 2 }, { O: 2, P: 3 }],
    '154-scl-function-dependencies': [
        { seen: 0, seenTotal: 0 },
        { seen: 5, seenTotal: 2, data: [5, 5], total: 2 },
        { seen: 10, seenTotal: 4 },
    ],
}

// Editor diagnostics and compiler warnings the spec quotes (substring of a warning or diagnostic message).
const quotedWarnings: Record<string, string> = {
    '04-reference-implicit': 'Valued Objects are bound implicitly!\nsecond, ',
    '07-reference-output-initialised-on-entry': 'Potential instantaneous loop.',
    '23-warn-join-never-terminates': 'The referenced SCChart does not terminate, but you are using a termination to proceed.',
    '28-duplicate-root-names': "There are multiple root states with the same name. 'St28Twin'",
    '44-dataflow-sequential': 'ValuedObject with name _St44Seq_local_seq0 is contained in the model but not in VariableStore.',
    '61-clock-reset-blink': 'Potential instantaneous loop through the timed transitions on t.',
    '82-string-equality-c': 'comparison with string literal results in unspecified behavior',
    '90-netlist-rejects-guarded-loop': 'There is an immediate loop. The model is not SASC.',
    '96-err-import-pragma': 'Broken Import: There is no SCCharts model with the given name.',
    '159-reference-silent-cycle': 'There is an immediate loop. The model is not SASC.',
}

describe('structure conformance suite', () => {
    it('has 25 or more charts, each with a chart and a recording', () => {
        expect(names.length).toBeGreaterThanOrEqual(25)
        for (const name of names) {
            expect(fs.existsSync(path.join(dir, `${name}.sctx`)), `${name}.sctx`).toBe(true)
            expect(fs.existsSync(path.join(dir, `${name}.oracle.json`)), `${name}.oracle.json`).toBe(true)
        }
    })

    it('every accepted chart has claims, and every claim belongs to a chart', () => {
        const accepted = names.filter(n => (load(n).scenario.expect ?? 'ok') === 'ok')
        expect(Object.keys(claims).sort()).toEqual(accepted)
    })

    it('chart names are unique across the suite (the oracle resolves references by name)', () => {
        const seen = new Map<string, string>()
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sctx'))) {
            for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/^\s*scchart\s+(\w+)/gm)) {
                // 28-duplicate-root-names repeats its own name on purpose; across files names never repeat.
                if (seen.get(m[1]) !== file) expect(seen.get(m[1]), `${m[1]} in ${file}`).toBeUndefined()
                seen.set(m[1], file)
                expect(m[1], `${m[1]} in ${file} carries the St<NN> prefix`).toMatch(/^St\d\d/)
            }
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
                if (expected === 'error') expect(scenario.errorIncludes, 'error scenarios name the message').toBeTruthy()
                if (expected === 'error' && scenario.errorIncludes)
                    expect(recording.errors.some(e => e.includes(scenario.errorIncludes!)), recording.errors.join(' | ')).toBe(true)
                if (expected === 'ok') expect(recording.ticks.length).toBe(scenario.ticks.length)
            })

            it('every tick has a note', () => {
                expect(scenario.ticks.length).toBeGreaterThan(0)
                for (const tick of scenario.ticks) expect(tick.note?.length ?? 0).toBeGreaterThan(10)
            })

            if (quotedWarnings[name]) {
                it('gives the warning the spec quotes', () => {
                    const messages = [...recording.warnings, ...(recording.diagnostics ?? []).map(d => d.message)]
                    expect(messages.some(m => m.includes(quotedWarnings[name])), messages.join(' | ')).toBe(true)
                })
            }

            if (expected === 'ok') {
                it('sets every input in tick 1', () => {
                    const inputs = Object.entries(recording.interface ?? {}).filter(([, v]) => v.properties.includes('input')).map(([k]) => k)
                    for (const input of inputs) expect(scenario.ticks[0].inputs ?? {}, input).toHaveProperty(input)
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

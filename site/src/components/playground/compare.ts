// "Compare with the model solution" (exercises: /playground/?example=<starter>&solution=<id>): the reader's chart
// runs on the inputs of the model solution's scenario, and every output the solution declares is compared, tick by
// tick, with KIELER's recording of the solution. Pure (no DOM): the playground renders the result.
//
// It is a comparison, not a grade: another chart can solve an exercise its own way, and one run of inputs cannot
// show that a chart is right. The wording says so.

import { createSimulation, type CompileResult } from '../../engine/index'
import type { Diagnostic, Value, VariableInfo } from '../../engine/types'
import type { Scenario } from '../frame/examples'
import type { Recording } from './sources'

/** An input or output of the model solution, as KIELER reports it. */
export interface SolutionVariable {
    name: string
    input: boolean
    output: boolean
    signal: boolean
    /** KIELER's type: bool, int, float, string (a pure signal is a bool signal). */
    type: string
}

export interface InterfaceProblem {
    name: string
    kind: 'missing-output' | 'missing-input' | 'not-output' | 'not-input' | 'kind' | 'type'
    message: string
}

export interface OutputDifference {
    tick: number
    name: string
    /** Plain words: "In tick 3 your `light` is false; the model solution has true." */
    message: string
    yours: string
    theirs: string
}

export interface Comparison {
    /** match: every compared output agrees in every tick; differs; cannot: the chart does not compile, cannot run
     *  here, or shares no output with the solution. */
    status: 'match' | 'differs' | 'cannot'
    /** Why it cannot be compared (compile errors, an unsupported construct, no common output). */
    reason?: string
    errors?: Diagnostic[]
    interface: InterfaceProblem[]
    /** The outputs compared (the solution's outputs that the reader's chart has, of the same kind). */
    outputs: string[]
    /** Ticks in the scenario. */
    total: number
    /** Per tick that ran: did every compared output agree? */
    ticks: boolean[]
    differences: OutputDifference[]
    /** The values in the first tick that differs, output by output (for a small table). */
    firstTick?: { tick: number; rows: { name: string; yours: string; theirs: string; same: boolean }[] }
    /** The reader's chart stopped with a run-time error. */
    runtime?: { tick: number; message: string }
    /** KIELER runs the chart, but the guide's simulator cannot (host code, a construct it does not implement): the
     *  chart cannot run in the browser, so it is not compared (`errors` says why, with the line). */
    unsupported?: boolean
}

/** What the comparison says of a chart the guide's simulator cannot run (an `unsupported` diagnostic, at compile time
 *  or when a tick reaches the construct): not "different", but not comparable here. */
const CANNOT_RUN = 'Your chart cannot run in the browser, so it cannot be compared here.'

/** The solution's interface, from KIELER's recording. KIELER lists a valued signal `V` as a bool signal plus the
 *  generated `V_val` (its value, with the value's type) and `V_curval`; those two are folded into `V`. */
export function solutionInterface(recording: Recording): SolutionVariable[] {
    const all = recording.interface ?? {}
    return Object.entries(all)
        .filter(([, v]) => !v.properties.includes('sccharts-generated'))
        .map(([name, v]) => {
            const signal = v.properties.includes('signal')
            const value = signal ? all[`${name}_val`] : undefined
            return {
                name,
                input: v.properties.includes('input'),
                output: v.properties.includes('output'),
                signal,
                type: value?.properties.includes('signal-value') ? value.type : v.type === 'pure' ? 'bool' : v.type,
            }
        })
}

const code = (name: string) => `\`${name}\``

/** How a value reads in a sentence. */
export function showValue(v: unknown): string {
    if (v === undefined || v === null) return 'unset'
    if (Array.isArray(v)) return `[${v.map(showValue).join(', ')}]`
    if (typeof v === 'string') return JSON.stringify(v)
    // A minus sign in prose is U+2212 (DESIGN.md).
    if (typeof v === 'number' && v < 0) return `\u2212${String(-v)}`
    return String(v)
}

function same(a: unknown, b: unknown): boolean {
    if (a === undefined || a === null) return b === undefined || b === null
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((x, i) => same(x, b[i]))
    }
    if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
    return a === b
}

const kindOf = (signal: boolean, valued: boolean, type: string) => (signal ? (valued ? `${type} signal` : 'signal') : type)

function readerKind(v: VariableInfo) {
    return kindOf(v.signal, v.signal && !!v.valued, v.type)
}

function solutionKind(v: SolutionVariable) {
    return kindOf(v.signal, v.signal && v.type !== 'bool', v.type)
}

/** Interface differences that matter for the comparison. */
export function compareInterface(reader: VariableInfo[], solution: SolutionVariable[]): { problems: InterfaceProblem[]; outputs: SolutionVariable[] } {
    const problems: InterfaceProblem[] = []
    const outputs: SolutionVariable[] = []
    const byName = new Map(reader.map(v => [v.name, v]))
    for (const s of solution) {
        // The solution's locals (class instances and their members too) are its own business: the comparison
        // sets inputs and compares outputs.
        if (!s.input && !s.output) continue
        const r = byName.get(s.name)
        const role = s.output ? 'output' : 'input'
        if (!r) {
            if (s.output) problems.push({ name: s.name, kind: 'missing-output', message: `Your chart has no output ${code(s.name)}; the model solution's is ${article(solutionKind(s))} ${solutionKind(s)}.` })
            else problems.push({ name: s.name, kind: 'missing-input', message: `Your chart has no input ${code(s.name)}; the comparison sets it, so your chart cannot react to it.` })
            continue
        }
        if (s.output && !r.output) {
            problems.push({ name: s.name, kind: 'not-output', message: `${code(s.name)} is not an output of your chart; in the model solution it is.` })
            continue
        }
        if (s.input && !s.output && !r.input) {
            problems.push({ name: s.name, kind: 'not-input', message: `${code(s.name)} is not an input of your chart, so the comparison's values for it do not reach it.` })
            continue
        }
        const rk = readerKind(r), sk = solutionKind(s)
        if (rk !== sk) {
            const kind = r.signal !== s.signal ? 'kind' : 'type'
            problems.push({ name: s.name, kind, message: `${capital(role)} ${code(s.name)} is ${article(rk)} ${rk} in your chart; in the model solution it is ${article(sk)} ${sk}.` })
            continue
        }
        if (s.output) outputs.push(s)
    }
    return { problems, outputs }
}

function article(word: string) {
    return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function capital(word: string) {
    return word.charAt(0).toUpperCase() + word.slice(1)
}

/** The sentence for one output that differs in one tick. */
function differenceMessage(tick: number, s: SolutionVariable, yours: { present?: boolean; value: unknown }, theirs: { present?: boolean; value: unknown }): string {
    const at = `In tick ${tick}`
    if (s.signal && yours.present !== theirs.present) {
        return theirs.present
            ? `${at} your chart does not emit ${code(s.name)}; the model solution does${s.type !== 'bool' ? ` (with ${showValue(theirs.value)})` : ''}.`
            : `${at} your chart emits ${code(s.name)}; the model solution does not.`
    }
    if (s.signal) return `${at} your chart emits ${code(s.name)} with ${showValue(yours.value)}; the model solution emits it with ${showValue(theirs.value)}.`
    return `${at} your ${code(s.name)} is ${showValue(yours.value)}; the model solution has ${showValue(theirs.value)}.`
}

/** Runs the reader's chart on the solution's scenario and compares the outputs with KIELER's recording. */
export function compareWithSolution(reader: CompileResult, scenario: Scenario, recording: Recording): Comparison {
    const solution = solutionInterface(recording)
    const total = Math.min(scenario.ticks.length, recording.ticks?.length ?? 0)
    const base: Comparison = { status: 'cannot', interface: [], outputs: [], total, ticks: [], differences: [] }
    const errors = reader.diagnostics.filter(d => d.severity === 'error')
    if (!reader.ok || !reader.chart) {
        return { ...base, reason: errors.length ? 'Your chart does not compile yet, so it cannot be compared.' : 'There is no chart to compare yet.', errors }
    }
    const { problems, outputs } = compareInterface(reader.interface, solution)
    const out: Comparison = { ...base, interface: problems, outputs: outputs.map(o => o.name) }
    if (!outputs.length) {
        return { ...out, reason: solution.some(s => s.output) ? 'Your chart has none of the model solution\'s outputs (with the same type), so there is nothing to compare.' : 'The model solution has no outputs to compare.' }
    }
    // KIELER accepts the chart, but the guide's simulator cannot run it (host code, for example): say so, rather
    // than report every tick as different.
    const unsupported = reader.diagnostics.find(d => d.code === 'unsupported')
    if (unsupported) return { ...out, unsupported: true, reason: CANNOT_RUN, errors: [unsupported] }
    let sim
    try {
        sim = createSimulation(reader)
    } catch (error) {
        return { ...out, reason: `Your chart cannot be simulated: ${error instanceof Error ? error.message : String(error)}` }
    }
    for (let i = 0; i < total; i++) {
        const tick = i + 1
        const result = sim.step((scenario.ticks[i].inputs ?? {}) as Record<string, Value>) as { pool?: Record<string, Value>; error?: Diagnostic }
        if (result.error) {
            // A construct the simulator cannot run, reached in this tick: as above, not a difference.
            if (result.error.code === 'unsupported') return { ...base, interface: out.interface, outputs: out.outputs, ticks: [], differences: [], unsupported: true, reason: CANNOT_RUN, errors: [result.error] }
            out.runtime = { tick, message: result.error.message }
            break
        }
        const pool = result.pool ?? {}
        const expected = recording.ticks![i].values
        let ok = true
        const rows: { name: string; yours: string; theirs: string; same: boolean }[] = []
        for (const s of outputs) {
            const valued = s.signal && s.type !== 'bool'
            type Seen = { present?: boolean; value: unknown }
            const yours: Seen = { present: s.signal ? !!pool[s.name] : undefined, value: valued ? pool[`${s.name}_val`] : pool[s.name] }
            const theirs: Seen = { present: s.signal ? !!expected[s.name] : undefined, value: valued ? expected[`${s.name}_val`] : expected[s.name] }
            // A valued signal's value counts in the ticks it is emitted (it keeps its last value otherwise).
            const agree = s.signal
                ? yours.present === theirs.present && (!valued || !theirs.present || same(yours.value, theirs.value))
                : same(yours.value, theirs.value)
            const show = (v: Seen) => (s.signal ? (v.present ? (valued ? `emitted, ${showValue(v.value)}` : 'emitted') : 'absent') : showValue(v.value))
            rows.push({ name: s.name, yours: show(yours), theirs: show(theirs), same: agree })
            if (!agree) {
                ok = false
                out.differences.push({ tick, name: s.name, message: differenceMessage(tick, s, yours, theirs), yours: show(yours), theirs: show(theirs) })
            }
        }
        out.ticks.push(ok)
        if (!ok && !out.firstTick) out.firstTick = { tick, rows }
    }
    out.status = out.differences.length || out.runtime ? 'differs' : 'match'
    return out
}

/** Tick numbers as a short phrase: [1, 2, 3, 5] -> "ticks 1 to 3 and 5". */
export function tickList(ticks: number[]): string {
    if (!ticks.length) return 'no tick'
    const runs: [number, number][] = []
    for (const t of ticks) {
        const last = runs[runs.length - 1]
        if (last && t === last[1] + 1) last[1] = t
        else runs.push([t, t])
    }
    // A run of two ticks is two items of the list ("1, 2 and 5"), a longer one a span ("1 to 3 and 5").
    const parts = runs.flatMap(([a, b]) => (a === b ? [`${a}`] : b === a + 1 ? [`${a}`, `${b}`] : [`${a} to ${b}`]))
    const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    return `${ticks.length === 1 ? 'tick' : 'ticks'} ${joined}`
}

/** The comparison's headline. */
export function summary(c: Comparison): string {
    if (c.status === 'cannot') return c.reason ?? 'Your chart cannot be compared.'
    const matching = c.ticks.map((ok, i) => (ok ? i + 1 : 0)).filter(Boolean)
    const one = c.outputs.length === 1
    const outputs = one ? `output ${code(c.outputs[0])}` : `outputs (${c.outputs.map(code).join(', ')})`
    const match = one ? 'matches' : 'match'
    if (c.status === 'match') return `Your ${outputs} ${match} the model solution's in all ${c.total} ticks of its test run.`
    const lead = matching.length
        ? `Your ${outputs} ${match} the model solution's in ${tickList(matching)}.`
        : `Your ${outputs} ${one ? 'differs' : 'differ'} from the model solution's from tick 1.`
    const first = c.differences[0]
    if (c.runtime && (!first || c.runtime.tick <= first.tick)) return `${lead} In tick ${c.runtime.tick} your chart stops with a run-time error: ${c.runtime.message}`
    return `${lead} ${first.message}`
}

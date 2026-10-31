// A shared run: the inputs every tick of a simulation ran with (runInputs: the engine's TickResult.ranWith, checked
// by replaying the run), and the run as a tour through it (SimPanel's `scenario`): every tick sends all the inputs
// the tick ran with, and its note says which of them changed and, where the chart has a handful of inputs, where
// the others stand ("In this tick `A` is absent and `B` is present; `R` stays absent."). Pure (the engine runs in
// memory).

import { createSimulation, type CompileResult } from '../../engine/index'
import type { TickResult, Value, VariableInfo } from '../../engine/types'
import type { Scenario } from '../frame/examples'
import { controlsFor, formatValue, initialInputs, type InputControl } from '../sim/inputs'
import type { SharedRun } from './share'

type Row = Record<string, Value>

/** The input keys of a chart, as the controls and KIELER's pool name them (`V` and `V_val` for a valued signal). */
function inputKeys(iface: VariableInfo[]): string[] {
    return controlsFor(iface).flatMap(c => (c.valueKey ? [c.name, c.valueKey] : [c.name]))
}

/** What a tick did, for comparing a replayed tick with the original: the whole data pool, the states, the
 *  transitions, termination and errors. Equal inputs give an equal tick; so does an equal tick, for the run's future. */
function fingerprint(t: TickResult): string {
    const pool = (t as TickResult & { pool?: unknown }).pool ?? t.values
    return JSON.stringify([pool, t.present, [...t.active].sort(), t.taken, t.terminated, t.error?.message ?? null])
}

/**
 * The inputs every tick of `history` ran with, complete (every input key; a string never set is left out), so that
 * sending them again gives the same run: the engine's `TickResult.ranWith` (the inputs as the tick read them, before
 * the chart wrote any of its own inputs, B-10). The run is replayed with them to check it; `exact` is the number of
 * ticks, from the first, that come out the same (the whole pool, the states, the transitions). A hand-made result
 * without `ranWith` gives the inputs as they were after the tick.
 */
export function runInputs(compiled: CompileResult, history: TickResult[]): { ticks: Row[]; exact: number } {
    const keys = inputKeys(compiled.interface)
    const initial = initialInputs(compiled.interface).levels
    const after = (t: TickResult): Row => {
        const pool = ((t as TickResult & { pool?: Row }).pool ?? {}) as Row
        return Object.fromEntries(keys.map(k => [k, k in pool ? pool[k] : k in t.inputs ? t.inputs[k] : (initial[k] ?? null)]))
    }
    const sim = createSimulation(compiled)
    let exact = 0
    const ticks = history.map((t, k) => {
        const ran: Row = t.ranWith ?? after(t)
        const row = clean(Object.fromEntries(keys.filter(key => key in ran).map(key => [key, ran[key]])))
        // Replayed only as long as it agrees: after a difference the replay is another run.
        if (exact === k && fingerprint(sim.step(row)) === fingerprint(t)) exact = k + 1
        return row
    })
    return { ticks, exact }
}

const clean = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))

const code = (s: string) => '`' + s.replace(/`/g, "'") + '`'
const same = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function list(items: string[]): string {
    if (items.length < 2) return items.join('')
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** What changed between two ticks' inputs, as phrases ("`A` is present", "`V` is present with the value `4`"). */
export function inputChanges(before: Record<string, Value>, now: Record<string, Value>, iface: VariableInfo[]): string[] {
    const out: string[] = []
    const valued = new Set(iface.filter(v => v.input && v.signal && v.valued).map(v => v.name))
    const done = new Set<string>()
    for (const [key, value] of Object.entries(now)) {
        if (done.has(key) || same(before[key], value)) continue
        done.add(key)
        const owner = key.endsWith('_val') && valued.has(key.slice(0, -4)) ? key.slice(0, -4) : undefined
        if (owner) {
            // The value of a valued signal: said with its presence when that changed too.
            if (!same(before[owner], now[owner]) && !done.has(owner)) {
                done.add(owner)
                out.push(now[owner] ? `${code(owner)} is present with the value ${code(formatValue(value))}` : `${code(owner)} is absent (its value is ${code(formatValue(value))})`)
            } else out.push(`${code(owner)} has the value ${code(formatValue(value))}`)
            continue
        }
        const v = iface.find(x => x.name === key)
        if (v?.signal) {
            const val = `${key}_val`
            if (v.valued && val in now && !same(before[val], now[val]) && !done.has(val)) {
                done.add(val)
                out.push(value ? `${code(key)} is present with the value ${code(formatValue(now[val]))}` : `${code(key)} is absent (its value is ${code(formatValue(now[val]))})`)
            } else out.push(`${code(key)} is ${value ? 'present' : 'absent'}`)
        } else {
            out.push(`${code(key)} is ${code(formatValue(value))}`)
        }
    }
    return out
}

/** Up to this many inputs, a note says where every input stands; with more, only what changed. */
export const FULL_STATE_MAX = 6

/** Where an input stands, said after its name and "is" or "stays": "present", "absent", "`3`", "unset" (a string never
 *  set). `alone`: the words fit one input only (a valued signal's "its value"), so they are not shared with others. */
function standing(c: InputControl, row: Record<string, Value>): { words: string; alone: boolean } {
    if (c.signal && c.kind === 'bool') {
        if (!c.valued) return { words: row[c.name] ? 'present' : 'absent', alone: false }
        const value = code(formatValue(row[c.valueKey!]))
        return { words: row[c.name] ? `present with the value ${value}` : `absent (its value is ${value})`, alone: true }
    }
    const v = row[c.name]
    return { words: v === null || v === undefined ? 'unset' : code(formatValue(v)), alone: false }
}

/** "`B` and `R` stay absent; `x` stays `0`": the inputs, those that stand alike together, in declaration order. */
function standings(controls: InputControl[], row: Record<string, Value>, verb: 'is' | 'stays'): string[] {
    const groups: { names: string[]; words: string; alone: boolean }[] = []
    for (const c of controls) {
        const s = standing(c, row)
        const g = s.alone ? undefined : groups.find(x => !x.alone && x.words === s.words)
        if (g) g.names.push(code(c.name))
        else groups.push({ names: [code(c.name)], ...s })
    }
    const say = (n: number) => (verb === 'is' ? (n > 1 ? 'are' : 'is') : n > 1 ? 'stay' : 'stays')
    return groups.map(g => `${list(g.names)} ${say(g.names.length)} ${g.words}`)
}

/**
 * The run as a tour: each tick's inputs, and a note saying which inputs changed in it and, for a chart with up to
 * FULL_STATE_MAX inputs, where the others stand, so that every note gives the whole input of its tick ("In tick 1
 * `A` is present; `B` and `R` are absent.", "In this tick no input changes: `A` stays present; `B` and `R` stay
 * absent.").
 */
export function sharedRunTour(run: SharedRun, iface: VariableInfo[]): Scenario {
    const initial = initialInputs(iface).levels
    const controls = controlsFor(iface)
    const full = controls.length <= FULL_STATE_MAX
    let before: Record<string, Value> = initial
    const ticks = run.ticks.map((inputs, i) => {
        const now = { ...before, ...inputs }
        const changes = inputChanges(before, inputs, iface)
        const moved = (c: InputControl) => !same(before[c.name], now[c.name]) || (!!c.valueKey && !same(before[c.valueKey], now[c.valueKey]))
        const rest = full ? standings(controls.filter(c => !moved(c)), now, i === 0 ? 'is' : 'stays') : []
        const others = rest.length ? rest.join('; ') : ''
        before = now
        let note: string
        if (!controls.length) note = 'The chart has no inputs.'
        else if (i === 0) note = changes.length ? `In tick 1 ${list(changes)}${others && `; ${others}`}.` : `In tick 1 every input has its initial value${others && `: ${others}`}.`
        else if (changes.length) note = `In this tick ${list(changes)}${others && `; ${others}`}.`
        else note = `In this tick no input changes${others && `: ${others}`}.`
        return { inputs: inputs as Record<string, unknown>, note }
    })
    return { ticks, expect: 'ok' }
}

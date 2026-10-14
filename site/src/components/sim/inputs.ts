// Input controls from a chart's interface, and the reader's input state: levels that stay where the reader
// put them (inputs persist in KIELER's simulator and in SCCharts Lab, docs-internal/semantics/basics.md B-9)
// plus one-tick pulses. Pure; the Svelte components render it.
//
// Input names follow KIELER's data pool, as the scenarios do: a bool or a pure signal `A` is `A`; a valued
// input signal `V` is `V` (presence) and `V_val` (value).

import type { Value, ValueType, VariableInfo } from '~engine/types'

export type ControlKind = 'bool' | 'number' | 'string' | 'array'

export interface InputControl {
    /** The variable's name (the presence key for a valued signal). */
    name: string
    kind: ControlKind
    type: ValueType
    /** A signal (pure or valued): the switch is presence. */
    signal: boolean
    /** Valued signal: a presence switch plus a value field under `valueKey`. */
    valued: boolean
    /** Key of the value of a valued signal (`V_val`). */
    valueKey?: string
    /** Type of the value field (valued signals: the signal's type; otherwise `type`). */
    valueKind?: 'number' | 'string'
    int: boolean
    dims: number[]
}

/** What the controls hold: the level of every input key, and the inputs armed to be present for one tick. */
export interface InputState {
    levels: Record<string, Value>
    pulses: string[]
}

/** The input controls of an interface, in declaration order. Constants are not inputs. */
export function controlsFor(iface: VariableInfo[]): InputControl[] {
    const out: InputControl[] = []
    for (const v of iface) {
        if (!v.input || v.const) continue
        const int = v.type === 'int'
        if (v.dims.length) {
            out.push({ name: v.name, kind: 'array', type: v.type, signal: v.signal, valued: false, int, dims: v.dims })
        } else if (v.signal && v.valued) {
            out.push({
                name: v.name, kind: 'bool', type: v.type, signal: true, valued: true, valueKey: `${v.name}_val`,
                valueKind: v.type === 'string' ? 'string' : 'number', int, dims: [],
            })
        } else if (v.signal || v.type === 'bool' || v.type === 'pure') {
            out.push({ name: v.name, kind: 'bool', type: v.type, signal: v.signal, valued: false, int: false, dims: [] })
        } else if (v.type === 'int' || v.type === 'float') {
            out.push({ name: v.name, kind: 'number', type: v.type, signal: false, valued: false, int, dims: [] })
        } else if (v.type === 'string') {
            out.push({ name: v.name, kind: 'string', type: v.type, signal: false, valued: false, int: false, dims: [] })
        }
    }
    return out
}

const zero = (type: ValueType): Value => (type === 'bool' || type === 'pure' ? false : type === 'string' ? null : 0)

/** The controls' values before the first tick: declared initial values (B-7), else false / 0 / no string. */
export function initialInputs(iface: VariableInfo[]): InputState {
    const levels: Record<string, Value> = {}
    for (const c of controlsFor(iface)) {
        const v = iface.find((x) => x.name === c.name)!
        if (c.kind === 'array') {
            const n = c.dims[0] > 0 ? c.dims[0] : 0
            const init = Array.isArray(v.initialValue) ? v.initialValue : []
            levels[c.name] = Array.from({ length: n }, (_, i) => init[i] ?? zero(v.type))
        } else if (c.valued) {
            levels[c.name] = false
            levels[c.valueKey!] = v.initialValue ?? zero(v.type)
        } else {
            levels[c.name] = v.initialValue ?? zero(v.type)
        }
    }
    return { levels, pulses: [] }
}

/** The inputs a tick runs with: the levels, armed pulses present. Strings that were never set stay unset. */
export function effectiveInputs(state: InputState): Record<string, Value> {
    const out: Record<string, Value> = {}
    for (const [k, v] of Object.entries(state.levels)) if (v !== null) out[k] = v
    for (const p of state.pulses) out[p] = true
    return out
}

/** The controls after a tick: pulses released, levels kept. */
export function afterTick(state: InputState): InputState {
    return { levels: state.levels, pulses: [] }
}

/** Controls showing a recorded tick's inputs (for replaying a later tick after going back). */
export function stateFromInputs(base: InputState, inputs: Record<string, Value>): InputState {
    return { levels: { ...base.levels, ...inputs }, pulses: [] }
}

export function sameInputs(a: Record<string, Value>, b: Record<string, Value>): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false
    return true
}

/** Applies a scenario tick's inputs (only the inputs it names change) to the levels. */
export function applyScenarioInputs(state: InputState, inputs: Record<string, unknown> | undefined): InputState {
    return { levels: { ...state.levels, ...((inputs ?? {}) as Record<string, Value>) }, pulses: [] }
}

/**
 * Parses what the reader typed into a number field. `int` truncates towards zero as C does; an empty or
 * malformed field gives `undefined` (the control keeps its previous value).
 */
export function parseNumber(text: string, int: boolean): number | undefined {
    const t = text.trim()
    if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined
    const n = Number(t)
    if (!Number.isFinite(n)) return undefined
    if (!int) return n
    // C's int is 32 bits. KIELER's simulator reads inputs with cJSON, whose valueint saturates.
    return Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(n)))
}

/** Parses an array field: `1, 2, 3` or `[1, 2, 3]`; a shorter list sets the leading elements (B-9). */
export function parseArray(text: string, control: InputControl, previous: Value): Value[] | undefined {
    const t = text.trim().replace(/^[[{]|[\]}]$/g, '').trim()
    const prev = Array.isArray(previous) ? previous.slice() : []
    if (!t) return prev
    const parts = t.split(/\s*,\s*/)
    const out = prev.slice()
    for (let i = 0; i < parts.length; i++) {
        let v: Value | undefined
        if (control.type === 'bool') v = parts[i] === 'true' || parts[i] === '1' ? true : parts[i] === 'false' || parts[i] === '0' ? false : undefined
        else if (control.type === 'string') v = parts[i].replace(/^"|"$/g, '')
        else v = parseNumber(parts[i], control.int)
        if (v === undefined) return undefined
        out[i] = v
    }
    return out
}

/** A value as the controls and the trace show it. */
export function formatValue(v: Value | undefined): string {
    if (v === undefined || v === null) return ''
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
    // An array as SCTX writes one: {1, 2, 3}.
    if (Array.isArray(v)) return `{${v.map(formatValue).join(', ')}}`
    return JSON.stringify(v)
}

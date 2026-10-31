// C value semantics of KIELER's netlist C simulation (basics.md B-3, B-20..B-28):
//   int    32-bit two's complement, wraps; `/` truncates towards zero, `%` takes the dividend's sign
//   bool   a C `char`: an int stored in a bool keeps its char value (300 -> 44, 256 -> 0); reported as != 0
//   float  a C double; float literals are rounded to single precision when the chart is compiled (lower.ts)
//   string a `char*`: == compares pointers. Identical literals share one pointer (gcc merges them); a string
//          from the environment is a fresh pointer every tick; NULL is null.

export const INT_MIN = -2147483648
export const INT_MAX = 2147483647

/** A string as the C simulation sees it: its text and the identity of the pointer. */
export interface CString {
    s: string
    id: number
}

/** Run-time values: numbers for int, char (bool) and double, CString or null for strings, arrays nested. */
export type RValue = number | CString | null | RValue[]

/** Static C type of an expression or variable. */
export type CType = 'int' | 'bool' | 'float' | 'string' | 'null'

const literalIds = new Map<string, number>()
let freshId = 0

/** The pointer identity of a string literal: one per distinct text (gcc merges identical literals). */
export function literalString(text: string): CString {
    let id = literalIds.get(text)
    if (id === undefined) {
        id = ++freshId
        literalIds.set(text, id)
    }
    return { s: text, id }
}

/** A string received from the environment: never the same pointer as anything else. */
export function freshString(text: string): CString {
    return { s: text, id: ++freshId + 1_000_000_000 }
}

export function isCString(v: unknown): v is CString {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as CString).s === 'string'
}

/** C's conversion of a double to int as gcc does it on x86-64 (cvttsd2si): truncation; out of range and NaN give INT_MIN. */
export function doubleToInt(x: number): number {
    if (!(x > -2147483649 && x < 2147483648)) return INT_MIN
    return Math.trunc(x) | 0
}

/** Conversion to C `char` (bool variables). */
export function toChar(x: number, fromFloat = false): number {
    const i = fromFloat ? doubleToInt(x) : x | 0
    return (i << 24) >> 24
}

/** Converts a value of static type `from` for storage in a variable of type `to` (C assignment conversion). */
export function convert(v: RValue, from: CType, to: CType): RValue {
    if (typeof v !== 'number') return v
    switch (to) {
        case 'int': return from === 'float' ? doubleToInt(v) : v | 0
        case 'bool': return toChar(v, from === 'float')
        case 'float': return v
        default: return v
    }
}

/** The default value of a type (B-4): int 0, bool false, float 0.0, string NULL. */
export function defaultValue(type: CType): RValue {
    return type === 'string' || type === 'null' ? null : 0
}

/** Builds an array of the given dimensions filled with a value. */
export function makeArray(dims: number[], fill: () => RValue): RValue {
    if (!dims.length) return fill()
    const [n, ...rest] = dims
    return Array.from({ length: Math.max(0, n) }, () => makeArray(rest, fill))
}

export function cloneValue(v: RValue): RValue {
    return Array.isArray(v) ? v.map(cloneValue) : v
}

/** The C type of a declared variable type. */
export function ctypeOf(type: string | undefined): CType {
    switch (type) {
        case 'int': return 'int'
        case 'float': return 'float'
        case 'string': return 'string'
        case 'bool': case 'pure': return 'bool'
        default: return 'int'
    }
}

/** printf of one print() argument (B-30): int %d, bool %x, float %f, string %s. */
export function printfValue(v: RValue, type: CType): string {
    if (v === null) return '(null)'
    if (isCString(v)) return v.s
    if (Array.isArray(v)) return '?'
    switch (type) {
        case 'bool': return (v >>> 0).toString(16)
        case 'float': return v.toFixed(6)
        default: return String(v | 0)
    }
}

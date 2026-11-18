// C's typing of expressions, for arrays used as values (basics.md B-28a).
//
// An SCCharts array is a C array in the struct KIELER generates (`int a[2]` in `TickData`), and KIELER writes an
// expression into its C code as it is: where a chart names an array without all of its indices (`a`, or `m[1]` of
// `int m[2][2]`), the C code has the array there, and C makes a pointer of it. gcc then decides. Most uses do not
// compile (the chart is rejected), a few do, with pointer semantics: a pointer is true, two pointers compare by
// address, a difference of two pointers counts elements, an integer added to one moves it by elements.
//
// This module is that typing, in one place: the types (`CTy`), gcc's rules for every operator and for an assignment,
// an argument and a return (`binaryRule`, `unaryRule`, `conditionalRule`, `assignRule`: the result type or gcc's own
// error text), the values the operators give (`run` of a rule: addresses are plain numbers), and the walk over an
// expression that applies them (`CTyper`). The static check (pointerCheck.ts) and the simulator (eval.ts) both use
// the rules, so what the one accepts the other runs.

import type { CExpr, CRef, CVar } from './model'
import { additiveChain, countedDown, isAdditive } from './written'

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export type CTy =
    | { k: 'int' } | { k: 'char' } | { k: 'double' } | { k: 'float' } | { k: 'long' } | { k: 'void' }
    | { k: 'ptr'; to: CTy }
    /** An array as the pointee of a pointer to a row (`int (*)[2]`). */
    | { k: 'arr'; of: CTy; n: number }

export const INT: CTy = { k: 'int' }
export const CHAR: CTy = { k: 'char' }
export const DOUBLE: CTy = { k: 'double' }
/** C's `float`: random(). */
export const FLOAT: CTy = { k: 'float' }
/** `long int`: the difference of two pointers (ptrdiff_t). */
export const LONG: CTy = { k: 'long' }
export const ptr = (to: CTy): CTy => ({ k: 'ptr', to })
const STRING = ptr(CHAR)
const NULL_TYPE = ptr({ k: 'void' })

/** The type of a typed expression, with what the rules need beyond it. */
export interface Typed {
    t: CTy
    /** A null pointer constant: the literal 0 (or `false`, which KIELER writes as 0) and `null`. */
    zero?: boolean
    /** A string: a `char *` that comes from a string variable or literal (strings keep their own diagnostics). */
    str?: boolean
}

export const isPtr = (t: CTy): t is Extract<CTy, { k: 'ptr' }> => t.k === 'ptr'
const isInteger = (t: CTy) => t.k === 'int' || t.k === 'char' || t.k === 'long'
const isArith = (t: CTy) => isInteger(t) || t.k === 'double' || t.k === 'float'

export function sameTy(a: CTy, b: CTy): boolean {
    if (a.k !== b.k) return false
    if (a.k === 'ptr') return sameTy(a.to, (b as typeof a).to)
    if (a.k === 'arr') return a.n === (b as typeof a).n && sameTy(a.of, (b as typeof a).of)
    return true
}

/** gcc's spelling of a type: `int *`, `int (*)[2]`, `char **`, `long int`. */
export function tyName(t: CTy): string {
    const declare = (x: CTy, inner: string): string => {
        if (x.k === 'ptr') return declare(x.to, x.to.k === 'arr' ? `(*${inner})` : `*${inner}`)
        if (x.k === 'arr') return declare(x.of, `${inner}[${x.n}]`)
        const base = x.k === 'long' ? 'long int' : x.k
        return inner ? `${base} ${inner}` : base
    }
    return declare(t, '')
}

/** Bytes, as gcc lays the type out on x86-64. */
export function sizeOf(t: CTy): number {
    switch (t.k) {
        case 'int': case 'float': return 4
        case 'char': case 'void': return 1
        case 'double': case 'long': case 'ptr': return 8
        case 'arr': return t.n * sizeOf(t.of)
    }
}

/** The C type of one element of a variable; undefined for what this typing does not cover (host types). */
export function elementType(v: CVar): CTy | undefined {
    if (v.hostType) return undefined
    switch (v.type) {
        case 'int': return INT
        case 'bool': case 'pure': return CHAR
        case 'float': return DOUBLE
        case 'string': return STRING
        default: return undefined
    }
}

export const dimsOf = (v: CVar): number[] => v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : 0))

/** The type of an array of the given dimensions used as a value: a pointer to its first element (or row). */
export function decayed(element: CTy, dims: number[]): CTy {
    return ptr(dims.slice(1).reduceRight<CTy>((of, n) => ({ k: 'arr', of, n }), element))
}

/** Integer promotion and the usual arithmetic conversions. */
const promote = (t: CTy): CTy => (t.k === 'char' ? INT : t)
function arithmetic(a: CTy, b: CTy): CTy {
    if (a.k === 'double' || b.k === 'double') return DOUBLE
    if (a.k === 'float' || b.k === 'float') return FLOAT
    if (a.k === 'long' || b.k === 'long') return LONG
    return INT
}

// ---------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------
//
// An address is a plain number: KIELER's struct lies at `base` (SimulationOptions.address), a member at its offset
// (structLayout.ts). What is not in the struct gets an island of its own, far from every other: the local arrays of a
// method KIELER keeps as a C function (the stack, above the struct), string literals (below it) and strings from the
// environment (the heap, between the two). Within the struct every comparison and difference is what C computes.
// Between two islands the order is the order of the zones, and what C would compute from two unrelated addresses (a
// difference, the order of two locals) the simulator cannot know.

/** Where KIELER's struct lies when the system does not move programs around in memory (an example: the address
 *  changes with every start of KIELER's simulation, and nothing but a pointer made a number shows it). */
export const DEFAULT_ADDRESS = 0x55555555f100
const ISLAND = 2 ** 20
const LITERALS = 0x555555000000
const HEAP = 0x555600000000
const STACK = 0x7ffc00000000

/** The address of a local array of a C function (by its slot): an island on the stack. */
export const stackAddress = (slot: number): number => STACK + slot * ISLAND
/** The address of a string (by the identity of its pointer, values.ts): literals lie below the struct, strings from
 *  the environment above it. */
export const stringAddress = (id: number): number => (id >= 1_000_000_000 ? HEAP + (id - 1_000_000_000) * ISLAND : LITERALS - id * ISLAND)

export class AddressError extends Error {}

/** The island of an address (the struct is one). */
function island(p: number, base: number): number {
    if (p >= base - ISLAND / 2 && p < base + ISLAND / 2) return -1
    return Math.floor(p / ISLAND)
}

/** An integer as the address C compares a pointer with: sign-extended to 64 bits (a negative one is very high). */
const asAddress = (n: number): number => (n < 0 ? n + 2 ** 64 : n)

const MASK64 = (1n << 64n) - 1n

/** The exact long of a value that is a JS number (addresses and small longs are exact). */
const big = (v: number): bigint => BigInt(Math.trunc(v))
const wrap64 = (v: bigint): bigint => BigInt.asIntN(64, v)

/**
 * The difference of two pointers in elements of `size` bytes. C leaves an inexact division undefined; gcc computes
 * what its code generation gives: folded when it compiles the code (`folded`: both operands are members with constant
 * indices) the division truncates, at run time it shifts by the size's power of two and multiplies by the inverse of
 * the odd rest (probes pointers/probe-array-value-inexact-*).
 */
export function pointerDifference(p: number, q: number, size: number, folded: boolean): bigint {
    const bytes = big(p) - big(q)
    const n = BigInt(size)
    if (bytes % n === 0n) return bytes / n
    if (folded) return bytes / n
    let shift = 0n
    let odd = n
    while (odd % 2n === 0n) { odd /= 2n; shift++ }
    // (BigInt's >> is an arithmetic shift, as the machine's sar.)
    let inverse = 1n
    for (let i = 0; i < 6; i++) inverse = (inverse * (2n - odd * inverse)) & MASK64
    return wrap64((bytes >> shift) * inverse)
}

/** A long as the number the simulator keeps: exact while it fits in a double. */
export function longNumber(v: bigint): number {
    return Number(v)
}

/** C's long arithmetic (64 bits, wrapping), for the operators an int or long operand pair can have. */
export function longOperation(o: string, a: bigint, b: bigint): bigint | 'zero' | 'overflow' {
    switch (o) {
        case '+': return wrap64(a + b)
        case '-': return wrap64(a - b)
        case '*': return wrap64(a * b)
        case '/': case '%':
            if (b === 0n) return 'zero'
            if (a === -(1n << 63n) && b === -1n) return 'overflow'
            return o === '/' ? a / b : a % b
        case '&': return a & b
        case '|': return a | b
        case '^': return a ^ b
        // The machine masks a 64-bit shift count to six bits.
        case '<<': return wrap64(a << (b & 63n))
        case '>>': return a >> (b & 63n)
        case '>>>': return wrap64(BigInt.asUintN(64, a) >> (b & 63n))
        default: return 0n
    }
}

// ---------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------

/** What an operand is at run time: a number (an address is one) or, for a long, its exact value. */
export type Operand = number

export interface BinaryRule {
    t: Typed
    /**
     * The value, when a pointer is involved (undefined: plain numbers, which eval.ts computes as before). `base` is
     * the struct's address; `folded`: gcc computes a difference of the two operands when it compiles the code.
     * Throws AddressError for what depends on addresses the simulator cannot know.
     */
    run?: (a: number, b: number, base: number, folded: boolean) => number | bigint
    /** The operation is C's long arithmetic (an operand is a long): eval.ts computes it with longOperation. */
    long?: boolean
}

const invalidOperands = (o: string, a: CTy, b: CTy) => `invalid operands to binary ${o} (have ‘${tyName(promote(a))}’ and ‘${tyName(promote(b))}’)`

const RELATIONAL: Record<string, (a: number, b: number) => boolean> = {
    '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
}

/** Two addresses of different islands in the order C finds them in, or an AddressError when no rule gives it. */
function ordered(o: string, a: number, b: number, base: number): boolean {
    const [x, y] = [island(a, base), island(b, base)]
    if (o !== '==' && o !== '!=' && x !== y && a !== 0 && b !== 0 && zone(a) === zone(b)) {
        throw new AddressError('the order of two things that lie in unrelated places in memory')
    }
    return RELATIONAL[o](a, b)
}

const zone = (p: number): number => (p >= STACK ? 3 : p >= HEAP ? 2 : p >= LITERALS ? 1 : 0)

/**
 * gcc's rule for a binary operator: the result's type, or the text of its error. Only what involves a pointer is
 * judged: two numbers give their usual type and no error here (the checks for numbers are elsewhere).
 */
export function binaryRule(o: string, a: Typed, b: Typed): BinaryRule | { error: string } {
    const [x, y] = [a.t, b.t]
    const pointers = (isPtr(x) ? 1 : 0) + (isPtr(y) ? 1 : 0)
    const str = a.str || b.str
    if (!pointers) {
        const long = (x.k === 'long' || y.k === 'long') && isInteger(x) && isInteger(y)
        switch (o) {
            case '==': case '!=': case '<': case '<=': case '>': case '>=': case '&&': case '||': return { t: { t: INT } }
            case '<<': case '>>': case '>>>': return { t: { t: promote(x) }, long: x.k === 'long' }
            default: return { t: { t: arithmetic(x, y) }, long }
        }
    }
    switch (o) {
        case '&&': case '||': return { t: { t: INT } }
        case '+': {
            if (pointers === 2) return { error: invalidOperands(o, x, y) }
            const [p, n] = isPtr(x) ? [x, y] : [y as Extract<CTy, { k: 'ptr' }>, x]
            if (!isInteger(n)) return { error: invalidOperands(o, x, y) }
            const size = sizeOf(p.to)
            return { t: { t: p, str }, run: isPtr(x) ? (u, v) => u + v * size : (u, v) => v + u * size }
        }
        case '-': {
            if (isPtr(x) && isInteger(y)) {
                const size = sizeOf(x.to)
                return { t: { t: x, str }, run: (u, v) => u - v * size }
            }
            if (isPtr(x) && isPtr(y) && sameTy(x.to, y.to)) {
                const size = sizeOf(x.to)
                // (Rows without elements, `int m[2][0]`: nothing to count the distance in.)
                if (size === 0) return { error: 'arithmetic on pointer to an empty aggregate' }
                return {
                    t: { t: LONG },
                    run: (u, v, base, folded) => {
                        if (island(u, base) !== island(v, base)) throw new AddressError('the distance between two things that lie in unrelated places in memory')
                        return pointerDifference(u, v, size, folded)
                    },
                }
            }
            return { error: invalidOperands(o, x, y) }
        }
        case '==': case '!=': case '<': case '<=': case '>': case '>=': {
            if (pointers === 2) return { t: { t: INT }, run: (u, v, base) => (ordered(o, u, v, base) ? 1 : 0) }
            const other = isPtr(x) ? y : x
            if (!isInteger(other)) return { error: invalidOperands(o, x, y) }
            // (A null pointer constant is the address 0.)
            return { t: { t: INT }, run: isPtr(x) ? (u, v) => (RELATIONAL[o](u, asAddress(v)) ? 1 : 0) : (u, v) => (RELATIONAL[o](asAddress(u), v) ? 1 : 0) }
        }
        default: return { error: invalidOperands(o, x, y) }
    }
}

/** gcc's rule for `-e` and `~e` of a pointer (`!e` is an int for every scalar). */
export function unaryRule(o: string, a: Typed): { t: Typed } | { error: string } {
    if (o === '!') return { t: { t: INT } }
    if (isPtr(a.t)) return { error: o === 'neg' ? 'wrong type argument to unary minus' : 'wrong type argument to bit-complement' }
    return { t: { t: promote(a.t) } }
}

/** gcc's rule for the two branches of a conditional. */
export function conditionalRule(a: Typed, b: Typed): { t: Typed } | { error: string } {
    const [x, y] = [a.t, b.t]
    if (!isPtr(x) && !isPtr(y)) return { t: { t: arithmetic(x, y) } }
    const str = a.str || b.str
    if (isPtr(x) && isPtr(y)) {
        if (sameTy(x, y) || y.to.k === 'void') return { t: { t: x, str } }
        if (x.to.k === 'void') return { t: { t: y, str } }
        return { error: 'pointer type mismatch in conditional expression [-Wincompatible-pointer-types]' }
    }
    const [p, other] = isPtr(x) ? [a, b] : [b, a]
    if (!isInteger(other.t)) return { error: 'type mismatch in conditional expression' }
    if (!other.zero) return { error: 'pointer/integer type mismatch in conditional expression [-Wint-conversion]' }
    return { t: { t: p.t, str } }
}

/** Where a value is put: an assignment, the n-th argument of a C function, a function's return. */
export type Destination = { how: 'assign' } | { how: 'argument'; n: number; fn: string } | { how: 'return' }

/** gcc's error for a value of type `value` put into something of type `target`, or undefined when it compiles. */
export function assignRule(target: CTy, value: Typed, to: Destination = { how: 'assign' }): string | undefined {
    const v = value.t
    const [T, V] = [tyName(target), tyName(v)]
    const text = (assign: string, argument: (n: number, fn: string) => string, ret: string) => (to.how === 'assign' ? assign : to.how === 'argument' ? argument(to.n, to.fn) : ret)
    if (isPtr(target)) {
        if (isPtr(v)) {
            if (sameTy(target, v) || v.to.k === 'void' || target.to.k === 'void') return undefined
            return text(`assignment to ‘${T}’ from incompatible pointer type ‘${V}’ [-Wincompatible-pointer-types]`,
                (n, fn) => `passing argument ${n} of ‘${fn}’ from incompatible pointer type [-Wincompatible-pointer-types]`,
                `returning ‘${V}’ from a function with incompatible return type ‘${T}’ [-Wincompatible-pointer-types]`)
        }
        if (isInteger(v)) {
            if (value.zero) return undefined
            return text(`assignment to ‘${T}’ from ‘${V}’ makes pointer from integer without a cast [-Wint-conversion]`,
                (n, fn) => `passing argument ${n} of ‘${fn}’ makes pointer from integer without a cast [-Wint-conversion]`,
                `returning ‘${V}’ from a function with return type ‘${T}’ makes pointer from integer without a cast [-Wint-conversion]`)
        }
        return text(`incompatible types when assigning to type ‘${T}’ from type ‘${V}’`,
            (n, fn) => `incompatible type for argument ${n} of ‘${fn}’`,
            `incompatible types when returning type ‘${V}’ but ‘${T}’ was expected`)
    }
    if (!isPtr(v)) return undefined
    if (isInteger(target)) {
        return text(`assignment to ‘${T}’ from ‘${V}’ makes integer from pointer without a cast [-Wint-conversion]`,
            (n, fn) => `passing argument ${n} of ‘${fn}’ makes integer from pointer without a cast [-Wint-conversion]`,
            `returning ‘${V}’ from a function with return type ‘${T}’ makes integer from pointer without a cast [-Wint-conversion]`)
    }
    return text(`incompatible types when assigning to type ‘${T}’ from type ‘${V}’`,
        (n, fn) => `incompatible type for argument ${n} of ‘${fn}’`,
        `incompatible types when returning type ‘${V}’ but ‘${T}’ was expected`)
}

// ---------------------------------------------------------------------------------------------------
// The walk over an expression
// ---------------------------------------------------------------------------------------------------

/** What gcc refuses in an expression, with the expression it is about. */
export interface TypeProblem {
    kind: 'operands' | 'unary' | 'conditional' | 'subscript' | 'scalar-subscript' | 'vector'
    gcc: string
    /** The operator, or the whole expression the problem is in. */
    at: CExpr
    /** The operator's sign as written (`*`, `-`, `~`). */
    op?: string
    /** The operand that is a pointer (an array, a string), for the message. */
    pointer?: CExpr
    /** A string is involved (the existing string diagnostics word it). */
    str?: boolean
}

export interface TyperOptions {
    /**
     * A parameter of a method KIELER keeps as a C function: a single value in C (`int p`), whatever dimensions the
     * chart declares it with.
     */
    scalar?(v: CVar): boolean
    /** The type a method call has: its C function's return type (undefined: not known here, nothing is judged). */
    call?(e: Extract<CExpr, { k: 'call' }>, typer: CTyper): Typed | undefined
    report?(p: TypeProblem): void
    /** `null` is C's `((void *)0)`: the code includes a C header that defines NULL. */
    nullPointer?: boolean
    /** Two pointers subtracted or put in order (`-`, `<`, `<=`, `>`, `>=`): what C computes from two addresses.
     *  `left` is undefined when it is itself a result of the same operator chain. */
    pair?(o: string, left: CExpr | undefined, right: CExpr, at: CExpr): void
    /** An operator that compiles with a pointer among its operands: it computes with an address (`at`: the operator). */
    uses?(at: CExpr, typed: Typed): void
}

const lowermost = (r: CRef): CRef => (r.sub ? lowermost(r.sub) : r)

/** The reference's type from its variable and the number of its indices (see `CTyper.type`). */
export function referenceType(r: CRef, scalar?: (v: CVar) => boolean): { typed?: Typed; problem?: 'scalar-subscript' } {
    const low = lowermost(r)
    const v = low.v
    // Not a value this typing knows: a method, an object, an extern function, a host type.
    if (v.method || v.declKind || v.extern) return {}
    const element = elementType(v)
    if (!element) return {}
    for (let x: CRef | undefined = r; x; x = x.sub) if (x.unindexed) return {}
    const str = v.type === 'string'
    const dims = scalar?.(v) ? [] : dimsOf(v)
    const given = low.idx.length
    if (given > dims.length) {
        // (A string's character, `s[0]`, is legal C.)
        if (str && given === dims.length + 1) return { typed: { t: CHAR } }
        return { problem: 'scalar-subscript' }
    }
    if (given === dims.length) return { typed: { t: element, str } }
    return { typed: { t: decayed(element, dims.slice(given)) } }
}

/** A pointer whose value gcc knows where it compiles the code: a member with constant indices, or a conditional of
 *  such (gcc moves the operation into its branches). A difference of two of them is folded (pointerDifference). */
export function constantPointer(e: CExpr): boolean {
    if (e.k === 'ref') return !e.sub && e.idx.every(i => i.k === 'lit')
    if (e.k !== 'op') return false
    if (e.op === '?:') return e.args.length === 3 && constantPointer(e.args[1]) && constantPointer(e.args[2])
    // (`n + 0` is `n` for gcc; any other step is computed when the code runs.)
    const zero = (x: CExpr) => x.k === 'lit' && x.v === 0
    return (e.op === '+' || e.op === '-') && e.args.length === 2 && ((constantPointer(e.args[0]) && zero(e.args[1])) || (e.op === '+' && zero(e.args[0]) && constantPointer(e.args[1])))
}

export class CTyper {
    constructor(private readonly options: TyperOptions = {}) {}

    private report(p: TypeProblem) {
        this.options.report?.(p)
    }

    /**
     * The C type of an expression as KIELER writes it into its code, or undefined where this typing does not reach
     * (host code, extern calls): nothing is judged there. `self` is the value of a conditional without an else part,
     * the target of the assignment (or the guard) it is in.
     */
    type(e: CExpr, self?: Typed): Typed | undefined {
        switch (e.k) {
            case 'lit':
                if (e.t === 'string') return { t: STRING, str: true }
                if (e.t === 'float') return { t: DOUBLE }
                return { t: INT, zero: e.v === 0 || e.v === false }
            // KIELER's header defines NULL as 0 where no C header did before it.
            case 'null': return this.options.nullPointer ? { t: NULL_TYPE, zero: true } : { t: INT, zero: true }
            case 'random': return { t: FLOAT }
            case 'ref': return this.reference(e, self)
            case 'op': return this.operator(e, self)
            case 'call': {
                for (const a of e.args) this.type(a, undefined)
                return this.options.call?.(e, this)
            }
            case 'vector':
                // A whole constant array: KIELER's Const processor puts its initial value, a vector, in its place.
                this.report({ kind: 'vector', gcc: 'expected expression before ‘{’ token', at: e })
                return undefined
            default: return undefined
        }
    }

    private reference(r: CRef, self?: Typed): Typed | undefined {
        for (let x: CRef | undefined = r; x; x = x.sub) {
            for (const i of x.idx) {
                const t = this.type(i, self)
                if (t && isPtr(t.t)) this.report({ kind: 'subscript', gcc: 'array subscript is not an integer', at: i, pointer: pointerIn(i), str: t.str })
            }
        }
        const { typed, problem } = referenceType(r, this.options.scalar)
        if (problem) this.report({ kind: 'scalar-subscript', gcc: 'subscripted value is neither array nor pointer nor vector', at: r })
        return typed
    }

    /** A sum, a difference or a negation, term by term as C reads KIELER's text (written.ts). */
    private additive(e: Extract<CExpr, { k: 'op' }>, self?: Typed): Typed | undefined {
        const { terms } = additiveChain(e)
        let acc: Typed | undefined
        // The term the pointer so far comes from (`p + 1` is still a pointer into `p`).
        let source: CExpr | undefined
        terms.forEach((term, i) => {
            let t = this.type(term.atom, self)
            if (t && term.signs >= 2) {
                // `--x`: a variable's own type; anything else is gcc's error (written.ts reports it).
                t = term.signs === 2 && countedDown(term.atom) && !isPtr(t.t) ? { t: t.t } : undefined
            } else if (t && term.signs === 1) {
                const r = unaryRule('neg', t)
                if ('error' in r) {
                    this.report({ kind: 'unary', gcc: r.error, at: e, op: '-', pointer: pointerIn(term.atom), str: t.str })
                    t = undefined
                } else t = r.t
            }
            if (i === 0) { acc = t; source = t && isPtr(t.t) ? term.atom : undefined; return }
            if (!acc || !t) { acc = undefined; return }
            const o = term.minus ? '-' : '+'
            const r = binaryRule(o, acc, t)
            if ('error' in r) {
                this.report({ kind: 'operands', gcc: r.error, at: e, op: o, pointer: isPtr(t.t) ? pointerIn(term.atom) : pointerIn(e), str: acc.str || t.str })
                acc = undefined
                return
            }
            if (isPtr(acc.t) && isPtr(t.t)) this.options.pair?.(o, source, term.atom, e)
            if (isPtr(acc.t) || isPtr(t.t)) this.options.uses?.(e, isPtr(acc.t) ? acc : t)
            if (isPtr(t.t)) source = term.atom
            acc = r.t
            if (!isPtr(acc.t)) source = undefined
        })
        return acc
    }

    private operator(e: Extract<CExpr, { k: 'op' }>, self?: Typed): Typed | undefined {
        if (isAdditive(e)) return this.additive(e, self)
        const o = e.op
        if (o === '?:') {
            const [c, a, b] = e.args.map((x, i) => this.type(x, i === 0 ? undefined : self))
            if (c && isPtr(c.t)) this.options.uses?.(e, c)
            const other = e.args.length === 3 ? b : self
            if (!a || !other) return undefined
            const r = conditionalRule(a, other)
            if ('error' in r) {
                this.report({ kind: 'conditional', gcc: r.error, at: e, pointer: pointerIn(e.args[1]) ?? (e.args[2] ? pointerIn(e.args[2]) : undefined), str: a.str || other.str })
                // gcc goes on with the pointer's type (a mismatch of two pointers: `void *`).
                return isPtr(a.t) && isPtr(other.t) ? { t: NULL_TYPE } : isPtr(a.t) ? a : other
            }
            return r.t
        }
        const args = e.args.map(x => this.type(x, self))
        if (o === '!' || o === 'neg' || o === '~') {
            const a = args[0]
            if (!a) return undefined
            const r = unaryRule(o, a)
            if ('error' in r) {
                this.report({ kind: 'unary', gcc: r.error, at: e, op: o === 'neg' ? '-' : o, pointer: pointerIn(e.args[0]), str: a.str })
                return undefined
            }
            if (isPtr(a.t)) this.options.uses?.(e, a)
            return r.t
        }
        // `pre(x)` and `val(S)` are variables by the time the code is written; before that, their operand's type.
        if (o === 'pre' || o === 'val') return args[0]
        if (!BINARY.has(o) || args.length < 2) return undefined
        // KIELER's operators take any number of operands (`a + b + c`): C reads them from the left.
        let acc = args[0]
        for (let i = 1; i < args.length; i++) {
            const b = args[i]
            if (!acc || !b) { acc = undefined; continue }
            const r = binaryRule(o, acc, b)
            if ('error' in r) {
                const which = isPtr(acc.t) ? (i === 1 ? e.args[0] : e) : e.args[i]
                this.report({ kind: 'operands', gcc: r.error, at: e, op: o, pointer: pointerIn(which) ?? pointerIn(e), str: acc.str || b.str })
                acc = undefined
                continue
            }
            if (isPtr(acc.t) && isPtr(b.t) && o !== '==' && o !== '!=' && o !== '&&' && o !== '||') this.options.pair?.(o, i === 1 ? e.args[0] : undefined, e.args[i], e)
            if (isPtr(acc.t) || isPtr(b.t)) this.options.uses?.(e, isPtr(acc.t) ? acc : b)
            acc = r.t
        }
        return acc
    }
}

const BINARY = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '==', '!=', '<', '<=', '>', '>=', '&&', '||'])

/** The first reference in an expression that is an array without all its indices (or, failing that, a string). */
export function pointerIn(e: CExpr | undefined): CExpr | undefined {
    let array: CExpr | undefined
    let string: CExpr | undefined
    const visit = (x: CExpr) => {
        if (array) return
        if (x.k === 'lit' && x.t === 'string') string ??= x
        if (x.k === 'ref') {
            const t = referenceType(x).typed
            if (t && isPtr(t.t)) {
                if (t.str) string ??= x
                else array = x
                return
            }
            for (let r: CRef | undefined = x; r; r = r.sub) r.idx.forEach(visit)
        } else if (x.k === 'op' || x.k === 'call') x.args.forEach(visit)
    }
    if (e) visit(e)
    return array ?? string
}

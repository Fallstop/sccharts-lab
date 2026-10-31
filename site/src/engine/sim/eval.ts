// Expression and effect evaluation with the C semantics of KIELER's netlist C simulation. Expressions are
// compiled once into closures over a Runtime (the variable store), so a tick is a plain array walk.
//
// Types follow C: bool variables are `char` and promote to int; comparisons and logical operators give int
// 0/1; int arithmetic wraps at 32 bits; any double operand makes the operation double; random() is a C
// `float` (single precision) and so is arithmetic between it and ints. Assignments convert to the target's
// type as C does, and KIELER's code generator casts a float right-hand side of an int target to int before a
// compound operator is applied (basics.md B-27).

import type { Span } from '../types'
import type { CEffect, CExpr, CRef, CVar } from './model'
import type { Memory } from './memory'
import { random, type RandState } from './random'
import { compileMethodCall } from './structure/methods'
import {
    convert, ctypeOf, doubleToInt, INT_MIN, isCString, literalString, printfValue, toChar,
    type CString, type CType, type RValue,
} from './values'

/** A failure while running a tick (division by zero, index out of range, ...). */
export class SimError extends Error {
    constructor(message: string, readonly span?: Span, readonly code = 'runtime-error', readonly hint?: string) {
        super(message)
    }
}

export interface Runtime {
    vals: RValue[]
    rand: RandState
    /** Text printed in this tick (print() inside methods). */
    printed?: string[]
    /** What a write outside an array overwrote (memory.ts), for the log's notes (plain and Markdown); the executor
     *  empties it. */
    notes?: { text: string; markdown: string }[]
}

export type Fn = (rt: Runtime) => RValue

/** Static C type of evaluated expressions; 'f32' is C `float` (random()). */
export type EType = CType | 'f32'

export interface VarInfo {
    slot: number
    type: CType
    dims: number[]
}

export interface EvalContext {
    info(v: CVar): VarInfo
    /** Display name of a variable for messages. */
    label(v: CVar): string
    /** KIELER's struct of the chart's variables, for indices outside an array (memory.ts). */
    memory?: Memory
}

/** An index outside its array, as the flat (row-major) element number C computes from it: C reads or writes whatever
 *  is stored there (memory.ts). */
export class Far {
    constructor(readonly flat: number) {}
}

export interface Compiled {
    fn: Fn
    type: EType
}

const truthy = (v: RValue): boolean => (typeof v === 'number' ? v !== 0 : v !== null)
const num = (v: RValue): number => (typeof v === 'number' ? v : v === null ? 0 : isCString(v) ? v.id : 0)

/** KIELER's isFloatExpression (KExpressionsTypeExtensions.inferType == FLOAT): decides the (int) cast. */
export function isFloatExpression(e: CExpr): boolean {
    const has = (x: CExpr, t: 'float' | 'int' | 'bool' | 'string'): boolean => {
        switch (x.k) {
            case 'lit': return x.t === t
            case 'ref': return lowerType(x) === t
            case 'op': return x.args.some((a, i) => !(x.op === '?:' && i === 0) && has(a, t))
            default: return false
        }
    }
    const all = (x: CExpr, t: 'float' | 'int' | 'bool' | 'string'): boolean => {
        switch (x.k) {
            case 'lit': return x.t === t
            case 'ref': return lowerType(x) === t
            case 'op': return x.args.every((a, i) => (x.op === '?:' && i === 0) || all(a, t))
            default: return false
        }
    }
    const arithmetic = !has(e, 'bool') && !has(e, 'string') && (has(e, 'int') || has(e, 'float'))
    if (arithmetic && has(e, 'float')) return true
    if (all(e, 'bool') || all(e, 'int')) return false
    return all(e, 'float')
}

function lowerType(r: CRef): string {
    let x = r
    while (x.sub) x = x.sub
    return x.v.type === 'pure' ? 'bool' : x.v.type
}

function binaryType(a: EType, b: EType): EType {
    if (a === 'float' || b === 'float') return 'float'
    if (a === 'f32' || b === 'f32') return 'f32'
    return 'int'
}

const isNumeric = (t: EType) => t === 'int' || t === 'bool' || t === 'float' || t === 'f32'

export class ExprCompiler {
    constructor(readonly ctx: EvalContext) {}

    /**
     * What a conditional without an else part (`c ? a`) gives when `c` is false. KIELER's C code generator writes it
     * as `c ? a : __CONDSELF__` and replaces the placeholder by the target of the assignment it is in (`x = 1 +
     * (c ? 2)` is `x = 1 + (c ? 2 : x)`, `x += c ? 1` doubles x) or, for a condition, by the guard variable that holds
     * the condition's value (the value it had when last computed, exec.ts). Elsewhere gcc rejects the placeholder
     * (codegen.ts); the innermost enclosing one counts.
     */
    private readonly selves: (Compiled | undefined)[] = []

    /** Compiles with `self` as the value of a conditional without an else (see `selves`). */
    withSelf<T>(self: Compiled | undefined, compile: () => T): T {
        this.selves.push(self)
        try {
            return compile()
        } finally {
            this.selves.pop()
        }
    }

    compile(e: CExpr): Compiled {
        switch (e.k) {
            case 'lit': {
                if (e.t === 'string') {
                    const s = literalString(e.v as string)
                    return { fn: () => s, type: 'string' }
                }
                const v = e.t === 'bool' ? (e.v ? 1 : 0) : (e.v as number)
                return { fn: () => v, type: e.t === 'float' ? 'float' : 'int' }
            }
            case 'null': return { fn: () => null, type: 'null' }
            case 'ref': return this.read(e)
            case 'op': return this.op(e.op, e.args, e.span)
            case 'random': return { fn: rt => random(rt.rand), type: 'f32' }
            case 'vector': {
                const parts = e.values.map(v => this.compile(v))
                return { fn: rt => parts.map(p => p.fn(rt)), type: parts[0]?.type ?? 'int' }
            }
            case 'call': {
                // Methods (and code effects) run their SCL body (structure/methods.ts); host functions cannot run here.
                const method = e.extern ? undefined : e.target?.v.method
                if (method) return compileMethodCall(this, e, method)
                const span = e.span
                return { fn: () => { throw new SimError(`The simulator cannot call ${e.extern ? 'the host function ' : ''}${e.name}() in the browser`, span, 'unsupported') }, type: 'int' }
            }
            case 'host': {
                const span = e.span
                return { fn: () => { throw new SimError('The simulator cannot run host code', span, 'unsupported') }, type: 'int' }
            }
            case 'ignore': return { fn: () => 0, type: 'int' }
            case 'unsupported': {
                const span = e.span
                return { fn: () => { throw new SimError(`The simulator cannot evaluate ${e.what}`, span, 'unsupported') }, type: 'int' }
            }
        }
    }

    /** Reads a variable or an array element. */
    read(r: CRef): Compiled {
        if (r.sub) {
            const span = r.span
            return { fn: () => { throw new SimError(`The simulator cannot read members (${r.v.name}.${r.sub!.v.name}) yet`, span, 'unsupported') }, type: 'int' }
        }
        const info = this.ctx.info(r.v)
        const slot = info.slot
        const type: EType = info.type
        if (!r.idx.length) return { fn: rt => rt.vals[slot], type }
        const index = this.indexer(r, info)
        const memory = this.ctx.memory
        const name = this.ctx.label(r.v)
        const span = r.span
        return {
            fn: rt => {
                const path = index(rt)
                if (path instanceof Far) return memory!.read(rt, r.v, path.flat, name, span)
                let v = rt.vals[slot]
                for (const i of path) v = (v as RValue[])[i]
                return v
            },
            type,
        }
    }

    /**
     * Evaluates the indices of a reference. C only computes an address from them: indices of a multi-dimensional
     * array that are out of their range but land inside the array are that element (`m[0][3]` of `int m[2][3]` is
     * `m[1][0]`); outside the array the access goes to whatever KIELER stores there (`Far`, memory.ts), when the guide
     * knows it, and is a runtime error otherwise.
     */
    indexer(r: CRef, info: VarInfo): (rt: Runtime) => number[] | Far {
        const parts = r.idx.map(i => this.compile(i))
        const name = this.ctx.label(r.v)
        const span = r.span
        const dims = info.dims
        const full = parts.length === dims.length
        const count = dims.reduce((a, b) => a * b, 1)
        const memory = this.ctx.memory?.has(r.v) ? this.ctx.memory : undefined
        return rt => {
            const out: number[] = new Array(parts.length)
            let flat = 0
            let inside = true
            for (let k = 0; k < parts.length; k++) {
                const p = parts[k]
                let i = p.fn(rt) as number
                if (p.type === 'float' || p.type === 'f32') i = doubleToInt(i)
                if (k >= dims.length || ((i < 0 || i >= dims[k]) && !full)) {
                    throw new SimError(`Index ${i} is outside the array ${name}${dims.length ? ` (size ${dims.join(' × ')})` : ''}`, span, 'index-out-of-range',
                        'KIELER does not check array indices: its C code would read or write unrelated memory here. Keep indices between 0 and the size minus 1.')
                }
                if (i < 0 || i >= dims[k]) inside = false
                flat = flat * dims[k] + i
                out[k] = i
            }
            if (inside) return out
            if (flat >= 0 && flat < count) {
                for (let k = dims.length - 1, f = flat; k >= 0; k--) { out[k] = f % dims[k]; f = Math.floor(f / dims[k]) }
                return out
            }
            if (memory) return new Far(flat)
            throw new SimError(`Index ${flat} is outside the array ${name} (size ${dims.join(' × ')})`, span, 'index-out-of-range',
                `KIELER does not check array indices: its C code would read or write memory it uses for something else here, and the guide cannot tell what. Keep indices between 0 and ${count - 1}.`)
        }
    }

    private op(o: string, args: CExpr[], span?: Span): Compiled {
        const c = args.map(a => this.compile(a))
        // KIELER's operator expressions are n-ary (`a + b + c`, `a && b && c`): fold them from the left.
        if (c.length > 2 && o !== '?:') {
            let acc = this.binary(o, c[0], c[1], span, this.divisorName(args[1]))
            for (let i = 2; i < c.length; i++) acc = this.binary(o, acc, c[i], span, this.divisorName(args[i]))
            return acc
        }
        if (c.length === 2 && o !== '?:') return this.binary(o, c[0], c[1], span, this.divisorName(args[1]))
        return this.unary(o, c, span)
    }

    /** The divisor as the chart writes it (`b`, `b - 1`, `pre(n)`), for a division's hint; undefined when the guide
     *  cannot tell (a value KIELER computes in a variable of its own). */
    divisorName(e: CExpr | undefined): string | undefined {
        return e ? sourceText(e, v => this.ctx.label(v)) : undefined
    }

    private binary(o: string, a: Compiled, b: Compiled, span?: Span, divisor?: string): Compiled {
        switch (o) {
            case '&&': return { fn: rt => (truthy(a.fn(rt)) && truthy(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '||': return { fn: rt => (truthy(a.fn(rt)) || truthy(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '==': case '!=': {
                const eq = o === '=='
                if (!isNumeric(a.type) || !isNumeric(b.type)) {
                    // Strings and NULL compare as pointers (B-26).
                    return { fn: rt => (sameValue(a.fn(rt), b.fn(rt)) === eq ? 1 : 0), type: 'int' }
                }
                return { fn: rt => ((num(a.fn(rt)) === num(b.fn(rt))) === eq ? 1 : 0), type: 'int' }
            }
            case '<': return { fn: rt => (num(a.fn(rt)) < num(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '<=': return { fn: rt => (num(a.fn(rt)) <= num(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '>': return { fn: rt => (num(a.fn(rt)) > num(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '>=': return { fn: rt => (num(a.fn(rt)) >= num(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '&': return { fn: rt => num(a.fn(rt)) & num(b.fn(rt)), type: 'int' }
            case '|': return { fn: rt => num(a.fn(rt)) | num(b.fn(rt)), type: 'int' }
            case '^': return { fn: rt => num(a.fn(rt)) ^ num(b.fn(rt)), type: 'int' }
            case '<<': return { fn: rt => num(a.fn(rt)) << num(b.fn(rt)), type: 'int' }
            case '>>': return { fn: rt => num(a.fn(rt)) >> num(b.fn(rt)), type: 'int' }
            case '>>>': return { fn: rt => (num(a.fn(rt)) >>> num(b.fn(rt))) | 0, type: 'int' }
            case '+': case '-': case '*': case '/': case '%': return this.arithmetic(o, a, b, span, divisor)
            default: return this.unary(o, [a, b], span)
        }
    }

    private unary(o: string, c: Compiled[], span?: Span): Compiled {
        const [a] = c
        switch (o) {
            case '!': return { fn: rt => (truthy(a.fn(rt)) ? 0 : 1), type: 'int' }
            case '~': return { fn: rt => ~num(a.fn(rt)), type: 'int' }
            case 'neg': {
                if (a.type === 'float') return { fn: rt => -num(a.fn(rt)), type: 'float' }
                if (a.type === 'f32') return { fn: rt => -num(a.fn(rt)), type: 'f32' }
                return { fn: rt => (-num(a.fn(rt))) | 0, type: 'int' }
            }
            case '?:': {
                const [cond, then, other] = c
                if (!other) {
                    const self = this.selves[this.selves.length - 1]
                    if (self) return { fn: rt => (truthy(cond.fn(rt)) ? then.fn(rt) : self.fn(rt)), type: then.type }
                    return { fn: rt => (truthy(cond.fn(rt)) ? then.fn(rt) : 0), type: then.type }
                }
                const type: EType = then.type === 'string' || then.type === 'null' ? then.type : binaryType(then.type, other.type)
                return { fn: rt => (truthy(cond.fn(rt)) ? then.fn(rt) : other.fn(rt)), type }
            }
            case 'pre': case 'val': {
                return { fn: () => { throw new SimError(`${o}() was not translated`, span, 'internal') }, type: a?.type ?? 'int' }
            }
            default:
                return { fn: () => { throw new SimError(`The simulator cannot evaluate the operator ${o}`, span, 'unsupported') }, type: 'int' }
        }
    }

    private arithmetic(o: string, a: Compiled, b: Compiled, span?: Span, divisor?: string): Compiled {
        const type = binaryType(a.type, b.type)
        if (type === 'float' || type === 'f32') {
            const r = type === 'f32' ? Math.fround : (x: number) => x
            switch (o) {
                case '+': return { fn: rt => r(num(a.fn(rt)) + num(b.fn(rt))), type }
                case '-': return { fn: rt => r(num(a.fn(rt)) - num(b.fn(rt))), type }
                case '*': return { fn: rt => r(num(a.fn(rt)) * num(b.fn(rt))), type }
                case '/': return { fn: rt => r(num(a.fn(rt)) / num(b.fn(rt))), type }
                default: return {
                    fn: () => { throw new SimError('The % operator needs whole numbers (C has no % for floats)', span, 'float-modulo') }, type: 'int',
                }
            }
        }
        switch (o) {
            case '+': return { fn: rt => (num(a.fn(rt)) + num(b.fn(rt))) | 0, type: 'int' }
            case '-': return { fn: rt => (num(a.fn(rt)) - num(b.fn(rt))) | 0, type: 'int' }
            case '*': return { fn: rt => Math.imul(num(a.fn(rt)), num(b.fn(rt))), type: 'int' }
            case '/': return {
                fn: rt => {
                    const x = num(a.fn(rt)), y = num(b.fn(rt))
                    if (y === 0) throw divisionByZero(span, divisor)
                    if (x === INT_MIN && y === -1) throw overflowTrap(span)
                    return (x / y) | 0
                },
                type: 'int',
            }
            default: return {
                fn: rt => {
                    const x = num(a.fn(rt)), y = num(b.fn(rt))
                    if (y === 0) throw divisionByZero(span, divisor)
                    if (x === INT_MIN && y === -1) throw overflowTrap(span)
                    return (x % y) | 0
                },
                type: 'int',
            }
        }
    }
}

function sameValue(a: RValue, b: RValue): boolean {
    if (a === null || b === null) return a === b || (a === 0 && b === null) || (a === null && b === 0)
    if (isCString(a) && isCString(b)) return a.id === b.id
    return a === b
}

function divisionByZero(span?: Span, divisor?: string) {
    const test = divisor ? (/^[\w.[\]]+$/.test(divisor) ? `${divisor} != 0` : `(${divisor}) != 0`) : undefined
    return new SimError(divisor ? `Division by zero: \`${divisor}\` is 0` : 'Division by zero', span, 'division-by-zero',
        `KIELER's C simulation crashes here: from this tick on it only shows the values of the tick before, and so the guide's simulation stops too. ${divisor ? `Test that \`${divisor}\` is not 0 first, for example with \`if ${test}\` on the transition or around the division.` : 'Make sure the divisor is never 0, for example with a test before the division.'}`)
}

/** Binding strengths for sourceText (KIELER's grammar, from loosest). */
const STRENGTH: Record<string, number> = {
    '?:': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '<': 8, '<=': 8, '>': 8, '>=': 8,
    '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
}

/**
 * An expression of the working model as the chart writes it, with the reader's names (`label`): `b - 1`, `a[i]`,
 * `pre(n)`, `val(S)`. Undefined when it has parts the reader did not write (KIELER's own variables, host code).
 */
export function sourceText(e: CExpr, label: (v: CVar) => string): string | undefined {
    const atom = (x: CExpr): string | undefined => {
        const t = text(x)
        return t === undefined ? undefined : x.k === 'op' && x.op !== 'pre' && x.op !== 'val' && x.op !== '!' && x.op !== '~' && x.op !== 'neg' ? `(${t})` : t
    }
    const text = (x: CExpr): string | undefined => {
        switch (x.k) {
            case 'lit': return x.t === 'string' ? JSON.stringify(x.v) : x.t === 'float' && Number.isInteger(x.v) ? `${x.v}.0` : String(x.v)
            case 'ref': {
                let r: CRef | undefined = x
                const parts: string[] = []
                while (r) {
                    const v = r.v
                    let name = label(v)
                    if (v.generated) {
                        if (v.role === 'pre' && v.of && !v.of.generated) name = `pre(${label(v.of)})`
                        else if ((v.role === 'value' || v.role === 'curval') && v.of) name = `val(${label(v.of)})`
                        else return undefined
                    }
                    const idx = r.idx.map(i => text(i))
                    if (idx.some(i => i === undefined)) return undefined
                    parts.push(name + idx.map(i => `[${i}]`).join(''))
                    r = r.sub
                }
                return parts.join('.')
            }
            case 'op': {
                if (x.op === 'neg' || x.op === '!' || x.op === '~') {
                    const a = atom(x.args[0])
                    return a === undefined ? undefined : `${x.op === 'neg' ? '-' : x.op}${a}`
                }
                if (x.op === 'pre' || x.op === 'val') {
                    const a = text(x.args[0])
                    return a === undefined ? undefined : `${x.op}(${a})`
                }
                const strength = STRENGTH[x.op]
                if (strength === undefined) return undefined
                const parts = x.args.map(a => (a.k === 'op' && (STRENGTH[a.op] ?? 99) <= strength ? atom(a) : text(a)))
                if (parts.some(p => p === undefined)) return undefined
                if (x.op === '?:') return parts.length === 3 ? `${parts[0]} ? ${parts[1]} : ${parts[2]}` : `${parts[0]} ? ${parts[1]}`
                return parts.join(` ${x.op} `)
            }
            case 'call': {
                const args = x.args.map(a => text(a))
                return args.some(a => a === undefined) ? undefined : `${x.name}(${args.join(', ')})`
            }
            default: return undefined
        }
    }
    return text(e)
}

function overflowTrap(span?: Span) {
    return new SimError('-2147483648 / -1 does not fit in an int', span, 'division-overflow',
        'In C this division overflows and the processor stops the program, as for a division by zero.')
}

// ---------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------

/** What an executed effect did, for the log. */
export interface Write {
    v: CVar
    value: RValue
    /** Array element written (undefined for the whole variable). */
    index?: number[]
}

export type EffectFn = (rt: Runtime, printed: string[]) => Write | undefined

export function compileEffect(f: CEffect, ec: ExprCompiler): EffectFn {
    switch (f.k) {
        case 'assign': return compileAssign(f, ec)
        case 'print': {
            const parts = f.args.map(a => ({ c: ec.compile(a), format: printFormat(a) }))
            return (rt, printed) => {
                printed.push(parts.map(p => printfValue(p.c.fn(rt), p.format)).join(' '))
                return undefined
            }
        }
        case 'mark': return () => undefined
        case 'emit': {
            const span = f.o.span
            return () => { throw new SimError(`Internal: emission of ${f.ref.v.name} was not translated`, span, 'internal') }
        }
        case 'call': {
            const c = ec.compile(f.call)
            return rt => { c.fn(rt); return undefined }
        }
        case 'randomize': return () => undefined
        case 'host': {
            const span = f.o.span
            return () => { throw new SimError('The simulator cannot run host code', span, 'unsupported') }
        }
        case 'unsupported': {
            const span = f.o.span
            return () => { throw new SimError(`The simulator cannot run ${f.what} yet`, span, 'unsupported') }
        }
    }
}

/** printf conversions (B-30): string literal %s, int literal %d, float literal %f, variables by type; else %X. */
function printFormat(e: CExpr): CType {
    if (e.k === 'lit') return e.t === 'string' ? 'string' : e.t === 'float' ? 'float' : e.t === 'bool' ? 'bool' : 'int'
    if (e.k === 'ref') return ctypeOf(e.v.type)
    return 'int'
}

function compileAssign(f: Extract<CEffect, { k: 'assign' }>, ec: ExprCompiler): EffectFn {
    const target = f.ref
    if (target.sub) {
        const span = f.o.span
        return () => { throw new SimError(`The simulator cannot assign members (${target.v.name}.${target.sub!.v.name}) yet`, span, 'unsupported') }
    }
    const info = ec.ctx.info(target.v)
    const slot = info.slot
    const ttype = info.type
    const index = target.idx.length ? ec.indexer(target, info) : undefined
    const vref = target.v
    const elementCount = target.idx.length

    const name = ec.ctx.label(vref)
    const memory = ec.ctx.memory
    const get = (rt: Runtime, path: number[] | Far | undefined): RValue => {
        if (!path) return rt.vals[slot]
        if (path instanceof Far) return memory!.read(rt, vref, path.flat, name, target.span)
        let v = rt.vals[slot]
        for (const i of path) v = (v as RValue[])[i]
        return v
    }
    const set = (rt: Runtime, path: number[] | Far | undefined, value: RValue) => {
        if (!path) {
            rt.vals[slot] = value
            return
        }
        if (path instanceof Far) {
            // C writes whatever is stored there (memory.ts): say what, in the log.
            const { names } = memory!.write(rt, vref, path.flat, value, name, target.span)
            const shownValue = typeof value !== 'number' ? undefined : ttype === 'bool' ? String(value !== 0) : String(value)
            const say = (c: (s: string) => string) => {
                const what = names.length ? `${names.map(c).join(' and ')}, which ${names.length > 1 ? 'are' : 'is'} stored there` : `unused bytes next to ${c(name)}`
                return `${c(`${name}[${path.flat}]`)} is outside ${c(name)}, which has ${info.dims.reduce((a, b) => a * b, 1)} elements: KIELER's C code does not check, and writes ${shownValue === undefined ? 'the value' : c(shownValue)} into ${what}.`
            }
            ;(rt.notes ??= []).push({ text: say(x => x), markdown: say(x => '`' + x + '`') })
            return
        }
        let v = rt.vals[slot] as RValue[]
        for (let k = 0; k < path.length - 1; k++) v = v[path[k]] as RValue[]
        v[path[path.length - 1]] = value
    }
    const shown = (path: number[] | Far | undefined) => (path instanceof Far ? [path.flat] : path)
    const isArrayTarget = info.dims.length > elementCount

    if (f.op === '++' || f.op === '--') {
        const d = f.op === '++' ? 1 : -1
        return rt => {
            const path = index?.(rt)
            const old = get(rt, path) as number
            const value = ttype === 'float' ? old + d : ttype === 'bool' ? toChar(old + d) : (old + d) | 0
            set(rt, path, value)
            return { v: vref, value, index: shown(path) }
        }
    }

    if (!f.expr) return () => undefined
    const rhsExpr = f.expr
    if (isArrayTarget) {
        const span = f.o.span
        return () => { throw new SimError(`${ec.ctx.label(vref)} is an array: assign its elements (KIELER's C code cannot assign whole arrays)`, span, 'array-assignment') }
    }
    // A conditional without an else part keeps the target: KIELER generates `x = c ? e : x` (ExprCompiler.selves).
    const rhs = ec.withSelf({ fn: rt => get(rt, index?.(rt)), type: ttype }, () => ec.compile(rhsExpr))
    const rtype: CType = rhs.type === 'f32' ? 'float' : rhs.type
    const castRhs = ttype === 'int' && isFloatExpression(rhsExpr)
    const rhsFn: Fn = rhs.fn
    const rhsInt = (rt: Runtime) => {
        const v = rhsFn(rt)
        return castRhs || rtype === 'float' ? doubleToInt(num(v)) : (num(v) | 0)
    }

    if (f.op === '=') {
        return rt => {
            const path = index?.(rt)
            const v = rhsFn(rt)
            const value = castRhs ? doubleToInt(num(v)) : convert(v, rtype, ttype)
            set(rt, path, value)
            return { v: vref, value, index: shown(path) }
        }
    }

    const compute = compoundOperator(f.op, ttype, castRhs || rtype === 'int' || rtype === 'bool' ? 'int' : rtype, f.o.span, ec.divisorName(rhsExpr))
    return rt => {
        const path = index?.(rt)
        const old = get(rt, path) as number
        const operand = ttype === 'int' || (ttype === 'bool' && castRhs) ? rhsInt(rt) : num(rhsFn(rt))
        const value = compute(old, operand)
        set(rt, path, value)
        return { v: vref, value, index: shown(path) }
    }
}

/** x op= e for numeric targets; `rtype` is the (possibly cast) operand's type. */
function compoundOperator(o: string, ttype: CType, rtype: CType, span?: Span, divisor?: string): (x: number, y: number) => number {
    const floatOp = ttype === 'float' || rtype === 'float'
    const store = (v: number): number => (ttype === 'float' ? v : ttype === 'bool' ? toChar(v, floatOp) : floatOp ? doubleToInt(v) : v | 0)
    switch (o) {
        case '+=': return (x, y) => store(floatOp ? x + y : (x + y) | 0)
        case '-=': return (x, y) => store(floatOp ? x - y : (x - y) | 0)
        case '*=': return (x, y) => store(floatOp ? x * y : Math.imul(x, y))
        case '/=': return (x, y) => {
            if (floatOp) return store(x / y)
            if (y === 0) throw divisionByZero(span, divisor)
            if (x === INT_MIN && y === -1) throw overflowTrap(span)
            return store((x / y) | 0)
        }
        case '%=': return (x, y) => {
            if (y === 0) throw divisionByZero(span, divisor)
            if (x === INT_MIN && y === -1) throw overflowTrap(span)
            return store((x % y) | 0)
        }
        case '&=': return (x, y) => store(x & y)
        case '|=': return (x, y) => store(x | y)
        case '^=': return (x, y) => store(x ^ y)
        case '<<=': return (x, y) => store(x << y)
        case '>>=': return (x, y) => store(x >> y)
        case '>>>=': return (x, y) => store((x >>> y) | 0)
        case 'min=': return (x, y) => store(x < y ? x : y)
        case 'max=': return (x, y) => store(x > y ? x : y)
        default: return () => { throw new SimError(`Unknown assignment operator ${o}`, span, 'internal') }
    }
}

export type { CString }

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
import { newRandState, random, seedRandState, type RandState } from './random'
import { compileMethodCall } from './structure/methods'
import {
    AddressError, binaryRule, CHAR, constantPointer, DEFAULT_ADDRESS, DOUBLE, elementType, FLOAT, INT, isPtr, LONG, longOperation,
    referenceType, sizeOf, stackAddress, stringAddress, type CTy, type Typed,
} from './pointers'
import type { Place } from './structLayout'
import { additiveChain, countedDown, isAdditive, isMultiplicative, multiplicative } from './written'
import {
    convert, doubleToInt, INT_MIN, isCString, literalString, printfValue, toChar,
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
    /** The seed of the next randomize() (C's `time(NULL)`); the executor records what it gave. */
    seed?: () => number
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
    /** The members of a class or struct instance (variables and nested instances), for `a.q = a.p`. */
    members?(v: CVar): CVar[]
    /** Where a variable lies in KIELER's struct (structLayout.ts), for the address of an array (pointers.ts);
     *  undefined for what is not in the struct (the locals of a method KIELER keeps as a C function). */
    place?(v: CVar): Place | undefined
    /** The address of KIELER's struct (SimulationOptions.address). */
    address?: number
}

/** An index outside its array, as the flat (row-major) element number C computes from it: C reads or writes whatever
 *  is stored there (memory.ts). */
export class Far {
    constructor(readonly flat: number) {}
}

export interface Compiled {
    fn: Fn
    type: EType
    /**
     * The C type where it is not one of `type`'s numbers (pointers.ts): a pointer (an array without all its indices;
     * `fn` gives its address, a number) or a long (the difference of two pointers).
     */
    c?: CTy
    /** A long's exact value (`fn` gives it as a double, which is all a comparison or a float needs). */
    big?: (rt: Runtime) => bigint
    /** A pointer gcc knows when it compiles the code (pointers.ts constantPointer). */
    konst?: boolean
    /** A long gcc computes when it compiles the code: the distance of two pointers it knows (`a + 1 - a`). */
    folds?: boolean
    /** A pointer gcc knows, moved by numbers it knows (`a + 1`). */
    moved?: boolean
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

/** The operands of a comparison as C compares them: converted to their common type (a C float rounds an int). */
function operands(a: Compiled, b: Compiled): [(rt: Runtime) => number, (rt: Runtime) => number] {
    if (binaryType(a.type, b.type) !== 'f32') return [rt => num(a.fn(rt)), rt => num(b.fn(rt))]
    return [rt => Math.fround(num(a.fn(rt))), rt => Math.fround(num(b.fn(rt)))]
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
            case 'op':
                // A sum, a difference or a product as C reads KIELER's text of it (written.ts).
                if (isAdditive(e)) return this.additive(e)
                if (isMultiplicative(e)) {
                    const m = multiplicative(e)
                    if (m.regrouped) return this.compile(m.tree)
                }
                return this.op(e.op, e.args, e.span)
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
        // An array without all its indices is its address in KIELER's C code (pointers.ts).
        const pointer = r.idx.length < info.dims.length && !this.scalars.has(r.v) ? referenceType(r).typed?.t : undefined
        if (pointer) return this.address(r, info, pointer)
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
     * The parameters of the methods KIELER keeps as C functions: single values in C (`int p`), whatever dimensions
     * the chart declares them with (structure/methods.ts fills it).
     */
    readonly scalars = new Set<CVar>()

    /** The address of an array, or of a row of it: the struct's address, the member's offset and the indices' steps. */
    private address(r: CRef, info: VarInfo, c: CTy): Compiled {
        const place = this.ctx.place?.(r.v)
        const element = sizeOf(elementType(r.v)!)
        // (Not in the struct: a local array of a C function, on the stack.)
        const start = place ? (this.ctx.address ?? DEFAULT_ADDRESS) + place.offset : stackAddress(info.slot)
        const strides = place?.strides ?? info.dims.map((_, k) => element * info.dims.slice(k + 1).reduce((a, b) => a * b, 1))
        const parts = r.idx.map(i => this.compile(i))
        const konst = constantPointer(r)
        if (!parts.length) return { fn: () => start, type: 'int', c, konst }
        return {
            fn: rt => {
                let at = start
                for (let k = 0; k < parts.length; k++) {
                    let i = parts[k].fn(rt) as number
                    if (parts[k].type === 'float' || parts[k].type === 'f32') i = doubleToInt(i)
                    at += i * strides[k]
                }
                return at
            },
            type: 'int', c, konst,
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
        // An operand is a pointer or a long: C's rules for them (pointers.ts).
        if (c.some(x => x.c)) return this.pointerOp(o, c, args, span)
        // KIELER's operator expressions are n-ary (`a + b + c`, `a && b && c`): fold them from the left.
        if (c.length > 2 && o !== '?:') {
            let acc = this.binary(o, c[0], c[1], span, this.divisorName(args[1]), constantInt(args[1]))
            for (let i = 2; i < c.length; i++) acc = this.binary(o, acc, c[i], span, this.divisorName(args[i]), constantInt(args[i]))
            return acc
        }
        if (c.length === 2 && o !== '?:') {
            // Both operands written as numbers: gcc computes the shift itself, and a right shift by the width or more
            // is then 0 (-1 for a negative number), not what the machine's masked count gives (`1 >> 32`).
            const [left, right] = [constantInt(args[0]), constantInt(args[1])]
            if (o === '>>' && left !== undefined && right !== undefined && right >= 32) return { fn: () => (left < 0 ? -1 : 0), type: 'int' }
            return this.binary(o, c[0], c[1], span, this.divisorName(args[1]), right)
        }
        return this.unary(o, c, span)
    }

    /**
     * A sum, a difference or a negation, term by term as C reads the text KIELER writes (written.ts): parentheses
     * KIELER leaves out regroup it, and two minus signs in front of a variable are C's `--`.
     */
    private additive(e: Extract<CExpr, { k: 'op' }>): Compiled {
        const { terms } = additiveChain(e)
        const span = e.span
        const parts = terms.map(t => {
            if (t.signs >= 2) return this.countDown(t.atom, t.signs, span)
            const c = this.compile(t.atom)
            if (!t.signs) return c
            return c.c ? this.pointerOp('neg', [c], [t.atom], span) : this.unary('neg', [c], span)
        })
        let acc = parts[0]
        for (let i = 1; i < parts.length; i++) {
            const o = terms[i].minus ? '-' : '+'
            const known = terms[i].signs ? undefined : constantInt(terms[i].atom)
            acc = acc.c || parts[i].c
                ? this.pointerBinary(o, acc, parts[i], span, undefined, known)
                : this.binary(o, acc, parts[i], span, undefined, known)
        }
        return acc
    }

    /** `--x`: the variable loses 1 and the expression is its new value. */
    private countDown(atom: CExpr, signs: number, span?: Span): Compiled {
        if (signs > 2 || !countedDown(atom)) {
            // (The chart is rejected at compile time: written.ts.)
            return { fn: () => { throw new SimError('KIELER\'s C code does not compile: lvalue required as decrement operand', span, 'internal') }, type: 'int' }
        }
        const run = compileEffect({ k: 'assign', ref: atom, op: '--', o: { hidden: true, span } }, this)
        let r = atom
        while (r.sub) r = r.sub
        return { fn: rt => run(rt, [])!.value, type: this.ctx.info(r.v).type }
    }

    /** An operator with a pointer or a long among its operands, by C's rules (pointers.ts binaryRule). */
    private pointerOp(o: string, c: Compiled[], args: CExpr[], span?: Span): Compiled {
        if (o === '?:') {
            const [cond, then, other] = c
            const out = this.unary(o, c, span)
            const branches = other ? [then, other] : [then]
            const pointer = branches.find(x => x.c && isPtr(x.c))
            if (pointer) return { ...out, type: 'int', c: pointer.c, konst: branches.every(x => x.konst) }
            if (other && branches.some(x => x.c) && branches.every(x => x.c || x.type === 'int' || x.type === 'bool')) {
                const [a, b] = [exact(then), exact(other)]
                return { ...out, c: LONG, big: rt => (truthy(cond.fn(rt)) ? a(rt) : b(rt)) }
            }
            return out
        }
        if (c.length === 1) {
            const [a] = c
            if ((o === 'neg' || o === '~') && a.c?.k === 'long') {
                const x = exact(a)
                const value = o === 'neg' ? (rt: Runtime) => BigInt.asIntN(64, -x(rt)) : (rt: Runtime) => ~x(rt)
                return { fn: rt => Number(value(rt)), type: 'int', c: LONG, big: value }
            }
            return this.unary(o, c, span)
        }
        let acc = c[0]
        for (let i = 1; i < c.length; i++) acc = this.pointerBinary(o, acc, c[i], span, this.divisorName(args[i]), constantInt(args[i]))
        return acc
    }

    private pointerBinary(o: string, a: Compiled, b: Compiled, span?: Span, divisor?: string, known?: number): Compiled {
        const rule = binaryRule(o, typedOf(a), typedOf(b))
        // (The chart is rejected at compile time: pointerCheck.ts.)
        if ('error' in rule) return { fn: () => { throw new SimError(`KIELER's C code does not compile: ${rule.error}`, span, 'internal') }, type: 'int' }
        const c = isPtr(rule.t.t) || rule.t.t.k === 'long' ? rule.t.t : undefined
        if (rule.run) {
            const run = rule.run
            const base = this.ctx.address ?? DEFAULT_ADDRESS
            const folded = !!a.konst && !!b.konst
            const [x, y] = [addressOf(a), addressOf(b)]
            const value = (rt: Runtime): number | bigint => {
                try {
                    return run(x(rt), y(rt), base, folded)
                } catch (e) {
                    if (e instanceof AddressError) throw unknownAddress(e.message, span)
                    throw e
                }
            }
            if (c?.k === 'long') return { fn: rt => Number(value(rt)), type: 'int', c, big: rt => BigInt(value(rt)), folds: (!!a.konst || !!a.moved) && (!!b.konst || !!b.moved) }
            // (A pointer moved by a literal 0 is still one gcc knows: pointers.ts constantPointer.)
            return { fn: rt => value(rt) as number, type: 'int', c, konst: known === 0 && !!a.konst && (o === '+' || o === '-'), moved: known !== undefined && (!!a.konst || !!a.moved) && (o === '+' || o === '-') }
        }
        if (rule.long) {
            const [x, y] = [exact(a), exact(b)]
            // A literal count of 64 or more: gcc folds the left shift to 0, as it does for an int at 32.
            if (o === '<<' && known !== undefined && known >= 64) return { fn: rt => (x(rt), 0), type: 'int', c: LONG, big: rt => (x(rt), 0n) }
            // (To the right, gcc only folds when it knows the left operand too: a pointer moved by literals.)
            if (o === '>>' && known !== undefined && known >= 64 && a.folds) return { fn: () => 0, type: 'int', c: LONG, big: () => 0n }
            const value = (rt: Runtime): bigint => {
                const r = longOperation(o, x(rt), y(rt))
                if (r === 'zero') throw divisionByZero(span, divisor)
                if (r === 'overflow') throw overflowTrap(span)
                return r
            }
            return { fn: rt => Number(value(rt)), type: 'int', c: LONG, big: value }
        }
        // Two whole numbers, one of them a long: compared exactly (a double has 53 bits).
        const whole = (x: Compiled) => x.type !== 'float' && x.type !== 'f32' && (typeof x.c !== 'object' || !isPtr(x.c))
        const compare: Record<string, (p: bigint, q: bigint) => boolean> = {
            '==': (p, q) => p === q, '!=': (p, q) => p !== q, '<': (p, q) => p < q, '<=': (p, q) => p <= q, '>': (p, q) => p > q, '>=': (p, q) => p >= q,
        }
        if (compare[o] && (a.big || b.big) && whole(a) && whole(b) && isNumeric(a.type) && isNumeric(b.type)) {
            const [x, y] = [exact(a), exact(b)]
            const test = compare[o]
            return { fn: rt => (test(x(rt), y(rt)) ? 1 : 0), type: 'int' }
        }
        // A long beside a float, in a comparison or under && and ||: a number like any other.
        return this.binary(o, plain(a), plain(b), span, divisor, known)
    }

    /** The divisor as the chart writes it (`b`, `b - 1`, `pre(n)`), for a division's hint; undefined when the guide
     *  cannot tell (a value KIELER computes in a variable of its own). */
    divisorName(e: CExpr | undefined): string | undefined {
        return e ? sourceText(e, v => this.ctx.label(v)) : undefined
    }

    /** `known`: the right operand's value when gcc knows it at compile time (literals only), where gcc folds the
     *  operation instead of leaving it to the machine (probes tests/engine/kieler/codegen/probe-literal-*). */
    private binary(o: string, a: Compiled, b: Compiled, span?: Span, divisor?: string, known?: number): Compiled {
        switch (o) {
            case '&&': return { fn: rt => (truthy(a.fn(rt)) && truthy(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '||': return { fn: rt => (truthy(a.fn(rt)) || truthy(b.fn(rt)) ? 1 : 0), type: 'int' }
            case '==': case '!=': {
                const eq = o === '=='
                if (!isNumeric(a.type) || !isNumeric(b.type)) {
                    // Strings and NULL compare as pointers (B-26).
                    return { fn: rt => (sameValue(a.fn(rt), b.fn(rt)) === eq ? 1 : 0), type: 'int' }
                }
                const [x, y] = operands(a, b)
                return { fn: rt => ((x(rt) === y(rt)) === eq ? 1 : 0), type: 'int' }
            }
            case '<': case '<=': case '>': case '>=': {
                const [x, y] = operands(a, b)
                if (o === '<') return { fn: rt => (x(rt) < y(rt) ? 1 : 0), type: 'int' }
                if (o === '<=') return { fn: rt => (x(rt) <= y(rt) ? 1 : 0), type: 'int' }
                if (o === '>') return { fn: rt => (x(rt) > y(rt) ? 1 : 0), type: 'int' }
                return { fn: rt => (x(rt) >= y(rt) ? 1 : 0), type: 'int' }
            }
            case '&': return { fn: rt => num(a.fn(rt)) & num(b.fn(rt)), type: 'int' }
            case '|': return { fn: rt => num(a.fn(rt)) | num(b.fn(rt)), type: 'int' }
            case '^': return { fn: rt => num(a.fn(rt)) ^ num(b.fn(rt)), type: 'int' }
            // A literal count of 32 or more: gcc folds the left shift to 0 (a count only known at run time, and every
            // right shift, the machine masks to its low five bits, as JavaScript does).
            case '<<': return known !== undefined && known >= 32 ? { fn: rt => (a.fn(rt), 0), type: 'int' } : { fn: rt => num(a.fn(rt)) << num(b.fn(rt)), type: 'int' }
            case '>>': return { fn: rt => num(a.fn(rt)) >> num(b.fn(rt)), type: 'int' }
            case '>>>': return { fn: rt => (num(a.fn(rt)) >>> num(b.fn(rt))) | 0, type: 'int' }
            case '+': case '-': case '*': case '/': case '%': return this.arithmetic(o, a, b, span, divisor, known)
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
                // C converts the branch taken to the conditional's type: an int branch beside a C float one is rounded.
                if (type === 'f32') return { fn: rt => Math.fround(num(truthy(cond.fn(rt)) ? then.fn(rt) : other.fn(rt))), type }
                return { fn: rt => (truthy(cond.fn(rt)) ? then.fn(rt) : other.fn(rt)), type }
            }
            case 'pre': case 'val': {
                return { fn: () => { throw new SimError(`${o}() was not translated`, span, 'internal') }, type: a?.type ?? 'int' }
            }
            default:
                return { fn: () => { throw new SimError(`The simulator cannot evaluate the operator ${o}`, span, 'unsupported') }, type: 'int' }
        }
    }

    private arithmetic(o: string, a: Compiled, b: Compiled, span?: Span, divisor?: string, known?: number): Compiled {
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
            // By a literal -1, gcc negates instead of dividing (no trap: -2147483648 stays -2147483648), and `% -1` is 0.
            case '/': return known === -1 ? { fn: rt => -num(a.fn(rt)) | 0, type: 'int' } : {
                fn: rt => {
                    const x = num(a.fn(rt)), y = num(b.fn(rt))
                    if (y === 0) throw divisionByZero(span, divisor)
                    if (x === INT_MIN && y === -1) throw overflowTrap(span)
                    return (x / y) | 0
                },
                type: 'int',
            }
            default: return known === -1 ? { fn: rt => (a.fn(rt), 0), type: 'int' } : {
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

/** The C type of a compiled expression, for the rules of pointers.ts. */
function typedOf(x: Compiled): Typed {
    if (x.c) return { t: x.c }
    switch (x.type) {
        case 'float': return { t: DOUBLE }
        case 'f32': return { t: FLOAT }
        case 'bool': return { t: CHAR }
        case 'string': return { t: { k: 'ptr', to: CHAR }, str: true }
        case 'null': return { t: { k: 'ptr', to: { k: 'void' } }, zero: true }
        default: return { t: INT }
    }
}

/** An operand as the number C computes with: an address for a string. */
function addressOf(x: Compiled): (rt: Runtime) => number {
    return rt => {
        const v = x.fn(rt)
        return typeof v === 'number' ? v : v === null ? 0 : isCString(v) ? stringAddress(v.id) : 0
    }
}

/** A long or int operand's exact value. */
function exact(x: Compiled): (rt: Runtime) => bigint {
    return x.big ?? (rt => BigInt(Math.trunc(num(x.fn(rt)))))
}

/** A long as a plain number (the double C converts it to beside a float). */
const plain = (x: Compiled): Compiled => (x.c?.k === 'long' ? { fn: x.fn, type: 'int' } : x)

/** The low 32 bits of a pointer or a long, as the int a cast or a `%d` makes of it. */
export function lowInt(x: Compiled, base: number, span?: Span): Fn {
    if (x.big) { const value = x.big; return rt => Number(BigInt.asIntN(32, value(rt))) }
    return rt => {
        const v = x.fn(rt) as number
        // Only the struct's address is known (SimulationOptions.address).
        if (v !== 0 && Math.abs(v - base) >= 2 ** 19) throw unknownAddress('the address of something outside the chart\'s variables as a number', span)
        return Number(BigInt.asIntN(32, BigInt(Math.trunc(v))))
    }
}

function unknownAddress(what: string, span?: Span): SimError {
    return new SimError(`The simulator cannot compute ${what}`, span, 'unsupported',
        'KIELER\'s C code computes it from where the program\'s memory happens to lie, which changes from one start of the simulation to the next.')
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
            const base = ec.ctx.address ?? DEFAULT_ADDRESS
            const parts = f.args.map(a => {
                const c = ec.compile(a)
                // printf takes an int from where a pointer or a long was passed: its low 32 bits.
                return { c: c.c ? { fn: lowInt(c, base, f.o.span), type: 'int' as const } : c, format: printFormat(a) }
            })
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
        case 'randomize': return rt => {
            if (!rt.seed) return undefined
            // A call that already ran in KIELER's reset code (exec.ts) seeded then: here it only says so.
            const done = rt.rand.replay?.length ? rt.rand.replay.shift() : undefined
            const seed = done ?? rt.seed()
            if (done === undefined) {
                seedRandState(rt.rand, seed)
                rt.rand.tape?.push(seed)
            }
            const say = (c: (s: string) => string) => `${c('randomize()')} seeded the random numbers from the clock (seed ${seed}): ${c('random()')} starts a new sequence.`
            ;(rt.notes ??= []).push({ text: say(s => s), markdown: say(s => '`' + s + '`') })
            return undefined
        }
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

/**
 * printf conversions (B-30): string literal %s, int literal %d, float literal %f, bool literal %x, a variable or a
 * method call by its declared type; anything else (a calculation, a host type) %X, upper-case hex (KIELER's
 * CCodeSerializeHRExtensions: `printf("%X", (d->n + 1))`).
 */
function printFormat(e: CExpr): CType | 'hex' {
    if (e.k === 'lit') return e.t === 'string' ? 'string' : e.t === 'float' ? 'float' : e.t === 'bool' ? 'bool' : 'int'
    let r = e.k === 'ref' ? e : e.k === 'call' && !e.extern ? e.target : undefined
    if (!r) return 'hex'
    while (r.sub) r = r.sub
    const type = r.v.method ? r.v.method.returnType : r.v.type
    switch (type) {
        case 'bool': case 'pure': return 'bool'
        case 'int': return 'int'
        case 'float': return 'float'
        case 'string': return 'string'
        default: return 'hex'
    }
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
    // `a.q = a.p`, two nested instances of one struct: C copies the struct, so every member is copied (KIELER
    // accepts it for an instance inside an instance; probe structure/probe-struct-nested-assign).
    if (f.op === '=' && rhsExpr.k === 'ref' && !rhsExpr.sub && (vref.declKind === 'struct' || vref.declKind === 'class') && rhsExpr.v.declKind === vref.declKind && ec.ctx.members) {
        const members = ec.ctx.members
        const from = rhsExpr.idx.length ? ec.indexer(rhsExpr, ec.ctx.info(rhsExpr.v)) : undefined
        const pairs: { to: number; from: number }[] = []
        const collect = (a: CVar, b: CVar) => {
            const source = new Map(members(b).map(m => [m.member!.name, m]))
            for (const m of members(a)) {
                const other = source.get(m.member!.name)
                if (!other || m.declKind === 'method') continue
                if (m.declKind) collect(m, other)
                else pairs.push({ to: ec.ctx.info(m).slot, from: ec.ctx.info(other).slot })
            }
        }
        collect(vref, rhsExpr.v)
        const clone = (v: RValue): RValue => (Array.isArray(v) ? v.map(clone) : v)
        return rt => {
            const at = index?.(rt)
            const source = from?.(rt)
            if (at instanceof Far || source instanceof Far) return undefined
            for (const p of pairs) {
                let value = rt.vals[p.from]
                for (const i of source ?? []) value = (value as RValue[])[i]
                value = clone(value)
                if (!at?.length) rt.vals[p.to] = value
                else {
                    let v = rt.vals[p.to] as RValue[]
                    for (let k = 0; k < at.length - 1; k++) v = v[at[k]] as RValue[]
                    v[at[at.length - 1]] = value
                }
            }
            return undefined
        }
    }
    if (isArrayTarget) {
        const span = f.o.span
        return () => { throw new SimError(`${ec.ctx.label(vref)} is an array: assign its elements (KIELER's C code cannot assign whole arrays)`, span, 'array-assignment') }
    }
    // A conditional without an else part keeps the target: KIELER generates `x = c ? e : x` (ExprCompiler.selves).
    const compiled = ec.withSelf({ fn: rt => get(rt, index?.(rt)), type: ttype }, () => ec.compile(rhsExpr))
    const cast = ttype === 'int' && isFloatExpression(rhsExpr)
    // A long keeps its low bits in an int or a char; KIELER's `(int)` cast makes a number of a pointer (its address).
    const narrowed = compiled.c && (ttype === 'int' || ttype === 'bool') && (compiled.big || cast)
    if (narrowed && compiled.big && f.op !== '=') return compoundLong(f.op, compiled.big, ttype, f.o.span, ec.divisorName(rhsExpr), rt => {
        const path = index?.(rt)
        return { old: get(rt, path) as number, store: value => { set(rt, path, value); return { v: vref, value, index: shown(path) } } }
    })
    const rhs: Compiled = narrowed ? { fn: lowInt(compiled, ec.ctx.address ?? DEFAULT_ADDRESS, f.o.span), type: 'int' } : compiled
    const rtype: CType = rhs.type === 'f32' ? 'float' : rhs.type
    const castRhs = cast && !narrowed
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

    // Without KIELER's cast C applies the usual arithmetic conversions: `x += random()` on an int adds in single
    // precision and truncates the sum (KIELER's simulation: -5 + 0.84 gives -4), not the operand.
    const single = rhs.type === 'f32' && !castRhs && ttype !== 'float'
    const compute = compoundOperator(f.op, ttype, castRhs || rtype === 'int' || rtype === 'bool' ? 'int' : rtype, f.o.span, ec.divisorName(rhsExpr), single)
    const read = (rt: Runtime) => (castRhs || (ttype === 'int' && rtype !== 'float') ? rhsInt(rt) : num(rhsFn(rt)))
    // KIELER writes `x min= e` as `x = (x < e) ? x : e`: e is evaluated for the comparison and, when it wins, once
    // more for the value (a random() in it is drawn twice; probes tests/engine/kieler/codegen/probe-minmax-twice*).
    const minmax = f.op === 'min=' || f.op === 'max='
    return rt => {
        const path = index?.(rt)
        const old = get(rt, path) as number
        const operand = read(rt)
        let value: number
        if (!minmax) value = compute(old, operand)
        else if (f.op === 'min=' ? old < operand : old > operand) value = compute(old, old)
        else {
            const again = read(rt)
            value = compute(again, again)
        }
        set(rt, path, value)
        return { v: vref, value, index: shown(path) }
    }
}

/** `x op= e` with a long `e` (a difference of pointers) and an int or char `x`: C computes in long and keeps the low bits. */
function compoundLong(
    o: string, rhs: (rt: Runtime) => bigint, ttype: CType, span: Span | undefined, divisor: string | undefined,
    target: (rt: Runtime) => { old: number; store: (value: number) => Write },
): EffectFn {
    const narrow = (v: bigint) => Number(BigInt.asIntN(ttype === 'bool' ? 8 : 32, v))
    return rt => {
        const { old, store } = target(rt)
        const x = BigInt(old)
        const y = rhs(rt)
        if (o === 'min=' || o === 'max=') return store(narrow((o === 'min=' ? x < y : x > y) ? x : y))
        // A shift's type is its left operand's: an int.
        if (o === '<<=' || o === '>>=' || o === '>>>=') {
            const count = Number(y & 31n)
            return store(narrow(BigInt(o === '<<=' ? old << count : o === '>>=' ? old >> count : old >>> count)))
        }
        const r = longOperation(o.slice(0, -1), x, y)
        if (r === 'zero') throw divisionByZero(span, divisor)
        if (r === 'overflow') throw overflowTrap(span)
        return store(narrow(r))
    }
}

/** x op= e for numeric targets; `rtype` is the (possibly cast) operand's type. */
function compoundOperator(o: string, ttype: CType, rtype: CType, span?: Span, divisor?: string, single = false): (x: number, y: number) => number {
    const floatOp = ttype === 'float' || rtype === 'float'
    // `single`: a C float operand (random()) with an int or char target: the operation is in single precision.
    const f = single ? Math.fround : (v: number) => v
    const store = (v: number): number => (ttype === 'float' ? v : ttype === 'bool' ? toChar(f(v), floatOp) : floatOp ? doubleToInt(f(v)) : v | 0)
    switch (o) {
        case '+=': return (x, y) => store(floatOp ? f(x) + y : (x + y) | 0)
        case '-=': return (x, y) => store(floatOp ? f(x) - y : (x - y) | 0)
        case '*=': return (x, y) => store(floatOp ? f(x) * y : Math.imul(x, y))
        case '/=': return (x, y) => {
            if (floatOp) return store(f(x) / y)
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

/** The value of an int expression of literals only (gcc folds it when it compiles KIELER's C), else undefined. */
function constantInt(e: CExpr | undefined): number | undefined {
    const literal = (x: CExpr): boolean => (x.k === 'lit' ? x.t === 'int' : x.k === 'op' && x.op !== 'pre' && x.op !== 'val' && x.args.every(literal))
    if (!e || !literal(e)) return undefined
    try {
        const v = new ExprCompiler({ info: () => { throw new Error('no variables in a literal expression') }, label: v => v.name }).compile(e).fn({ vals: [], rand: newRandState() } as never)
        return typeof v === 'number' && Number.isInteger(v) ? v : undefined
    } catch {
        return undefined
    }
}

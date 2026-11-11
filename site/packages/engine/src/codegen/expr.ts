// Expressions and effects in C, as KIELER's CCodeSerializeHRExtensions writes them: variables as struct members
// (`d->x`), bools as 0/1, `random()` as `((float) rand() / RAND_MAX)`, `print` as one printf with a conversion per
// argument, `(int)(...)` around a float expression assigned to an int (basics.md B-27), `min=`/`max=` as conditionals,
// and a conditional without else (`c ? a`) completed with the assignment's target (B-24). Parentheses follow C's
// precedence, with the extra ones gcc's -Wparentheses asks for.

import { isFloatExpression } from '../sim/eval'
import type { CEffect, CExpr, CRef, CVar } from '../sim/model'

export interface ExprEnv {
    /** The C lvalue of a variable: `d->x`, or a method's parameter or local by its name. */
    access(v: CVar): string
    /** The C function of a method (`Chart_m`) and whether it takes the struct (`d`) first. */
    method(v: CVar): string
    /** The C code of an `extern` function (`extern "abs" abs`: `abs`). */
    externCode(name: string, target: CVar | undefined): string
    /** The struct pointer to pass to methods (`d`), or undefined inside a function without it. */
    structArg: string
    /** `#include`s the code needs (`<stdio.h>`, `<stdlib.h>`, `<time.h>`). */
    includes: Set<string>
    /** Something the generator cannot express (an internal error of the generator). */
    fail(message: string): void
    /** Array references whose index KIELER's code drops in a condition (sim/guardIndices.ts): the array's address. */
    dropped?: Set<CRef>
    /** The value of a conditional without else (KIELER's `__CONDSELF__`): the assignment's target or the guard. */
    self?: string
    /** `NULL` is used (the header then defines it when missing, as KIELER's does). */
    usesNull?: boolean
}

/** C's binding strengths (higher binds tighter). */
const PREC: Record<string, number> = {
    '?:': 3, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '<=': 10, '>': 10, '>=': 10,
    '<<': 11, '>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13,
}
const UNARY = 15
const ATOM = 20
const COMPARISON = new Set(['==', '!=', '<', '<=', '>', '>='])
const BITWISE = new Set(['&', '|', '^'])

interface Out { text: string; prec: number; op?: string }

const atom = (text: string): Out => ({ text, prec: ATOM })

/** A double literal that C reads back as exactly the same double. */
export function floatLiteral(v: number): string {
    if (Number.isNaN(v)) return '(0.0 / 0.0)'
    if (!Number.isFinite(v)) return v > 0 ? '(1.0 / 0.0)' : '(-1.0 / 0.0)'
    let s = String(v)
    if (!/[.eE]/.test(s)) s += '.0'
    return s.replace('e+', 'e')
}

/** A C string literal. */
export function stringLiteral(s: string): string {
    let out = '"'
    for (const ch of s) {
        const c = ch.codePointAt(0)!
        if (ch === '"' || ch === '\\') out += '\\' + ch
        else if (ch === '\n') out += '\\n'
        else if (ch === '\t') out += '\\t'
        else if (ch === '\r') out += '\\r'
        else if (c < 0x20 || c === 0x7f) out += '\\' + c.toString(8).padStart(3, '0')
        else out += ch
    }
    return out + '"'
}

function intLiteral(v: number): Out {
    if (v === -2147483648) return { text: '(-2147483647 - 1)', prec: ATOM }
    return v < 0 ? { text: String(v), prec: UNARY } : atom(String(v))
}

/** Whether a child expression needs parentheses as operand `index` of `parent` (C precedence and -Wparentheses). */
function needsParens(child: Out, parent: string, index: number): boolean {
    if (child.prec >= UNARY) return false
    const p = PREC[parent]
    if (child.prec < p) return true
    if (child.prec === p && index > 0) return true
    const op = child.op
    if (!op || op === parent) return false
    if (parent === '||' && op === '&&') return true
    if (BITWISE.has(parent) || parent === '<<' || parent === '>>') return true
    if (COMPARISON.has(parent) && COMPARISON.has(op)) return true
    return false
}

const wrap = (o: Out) => `(${o.text})`

export function expr(e: CExpr, env: ExprEnv): Out {
    switch (e.k) {
        case 'lit':
            switch (e.t) {
                case 'bool': return atom(e.v ? '1' : '0')
                case 'int': return intLiteral(e.v as number)
                case 'float': {
                    const v = e.v as number
                    return v < 0 || Object.is(v, -0) ? { text: floatLiteral(v), prec: UNARY } : atom(floatLiteral(v))
                }
                case 'string': return atom(stringLiteral(e.v as string))
            }
            break
        case 'null':
            env.usesNull = true
            return atom('NULL')
        case 'ref': return atom(ref(e, env))
        case 'op': return op(e.op, e.args, env)
        case 'random':
            env.includes.add('<stdlib.h>')
            return atom('((float) rand() / RAND_MAX)')
        case 'host': return { text: e.text, prec: 0 }
        case 'call': return atom(call(e, env))
        case 'vector':
            env.fail('a vector outside an assignment to an array')
            return atom('0')
        case 'ignore':
            env.fail('`_` outside a vector')
            return atom('0')
        case 'unsupported':
            env.fail(`${e.what}`)
            return atom('0')
    }
    return atom('0')
}

/** A reference: `d->x`, `d->a[i][j]`; in a condition, an array whose index KIELER drops is its address. */
export function ref(r: CRef, env: ExprEnv): string {
    if (env.dropped?.has(r)) return `((long) ${env.access(r.v)})`
    let s = env.access(r.v)
    for (const i of r.idx) s += `[${expr(i, env).text}]`
    if (r.sub) env.fail(`the member access ${r.v.name}.${r.sub.v.name}`)
    return s
}

function call(e: Extract<CExpr, { k: 'call' }>, env: ExprEnv): string {
    const args = e.args.map(a => expr(a, env).text)
    const target = e.target?.v
    if (e.extern || target?.extern || !target?.method) return `${env.externCode(e.name, target)}(${args.join(', ')})`
    return `${env.method(target)}(${[env.structArg, ...args].filter(Boolean).join(', ')})`
}

function op(o: string, args: CExpr[], env: ExprEnv): Out {
    const parts = args.map(a => expr(a, env))
    switch (o) {
        case '!': case '~': case 'neg': {
            const a = parts[0]
            const sign = o === 'neg' ? '-' : o
            const inner = a.prec < UNARY || (o === 'neg' && a.text.startsWith('-')) ? wrap(a) : a.text
            return { text: sign + inner, prec: UNARY }
        }
        case '?:': {
            const [c, t, f] = parts.map(p => (p.prec <= PREC['?:'] ? wrap(p) : p.text))
            // KIELER's `c ? a : __CONDSELF__`, completed with the enclosing assignment's target (or the guard).
            const other = f ?? env.self
            if (other === undefined) env.fail('a conditional without else outside an assignment')
            return { text: `${c} ? ${t} : ${other ?? '0'}`, prec: PREC['?:'], op: '?:' }
        }
        case 'pre': case 'val':
            env.fail(`${o}() that was not translated`)
            return atom('0')
    }
    const p = PREC[o]
    if (p === undefined || parts.length < 2) {
        env.fail(`the operator ${o}`)
        return atom('0')
    }
    const text = parts.map((x, i) => (needsParens(x, o, i) ? wrap(x) : x.text)).join(` ${o} `)
    return { text, prec: p, op: o }
}

/** printf's conversion for a print() argument (KIELER: by literal, by the variable's type, else `%X`). */
function printFormat(e: CExpr): string {
    if (e.k === 'lit') return e.t === 'string' ? '%s' : e.t === 'bool' ? '%x' : e.t === 'int' ? '%d' : '%f'
    let r: CRef | undefined = e.k === 'ref' ? e : e.k === 'call' ? e.target : undefined
    if (!r) return '%X'
    while (r.sub) r = r.sub
    const v = r.v
    const type = v.method ? (v.method.returnType === 'void' ? undefined : v.method.returnType) : v.type
    switch (type) {
        case 'bool': case 'pure': return '%x'
        case 'float': return '%f'
        case 'int': return '%d'
        case 'string': return '%s'
        default: return '%X'
    }
}

/** The C type of a variable written by an assignment: `int` targets get KIELER's `(int)` cast (B-27). */
function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

/** One effect as C statements (without indentation); [] for bookkeeping that has no C code. */
export function effect(f: CEffect, env: ExprEnv): string[] {
    switch (f.k) {
        case 'assign': return assignment(f, env)
        case 'print': {
            env.includes.add('<stdio.h>')
            const formats = f.args.map(printFormat).join(' ')
            // KIELER's serialize (not serializeHR) of parameters: an operation in parentheses.
            const args = f.args.map(a => { const o = expr(a, env); return o.prec < ATOM && o.prec > 0 ? `(${o.text})` : o.text })
            return [`printf(${[stringLiteral(formats), ...args].join(', ')});`]
        }
        case 'call': return [`${call(f.call, env)};`]
        case 'host': return [`${f.text};`]
        case 'randomize':
            env.includes.add('<stdlib.h>')
            env.includes.add('<time.h>')
            return ['srand(time(NULL));']
        case 'mark': return []
        case 'emit':
            env.fail(`an emission of ${f.ref.v.name} that was not translated`)
            return []
        case 'unsupported':
            env.fail(f.what)
            return []
    }
}

function assignment(f: Extract<CEffect, { k: 'assign' }>, env: ExprEnv): string[] {
    const target = ref(f.ref, env)
    if (f.op === '++' || f.op === '--') return [`${target}${f.op};`]
    const rhs = f.expr
    if (!rhs) return []
    if (rhs.k === 'vector') {
        // KIELER's splitAssignment: one assignment per element; `_` leaves an element as it is.
        const out: string[] = []
        const split = (v: Extract<CExpr, { k: 'vector' }>, prefix: string) => {
            v.values.forEach((x, i) => {
                if (x.k === 'ignore') return
                if (x.k === 'vector') split(x, `${prefix}[${i}]`)
                else out.push(...simple(`${prefix}[${i}]`, f.op, x, f.ref, env))
            })
        }
        split(rhs, target)
        return out
    }
    return simple(target, f.op, rhs, f.ref, env)
}

function simple(target: string, operator: string, rhs: CExpr, r: CRef, env: ExprEnv): string[] {
    const saved = env.self
    env.self = target
    const value = expr(rhs, env)
    env.self = saved
    let text = value.text
    if (lowermost(r).v.type === 'int' && isFloatExpression(rhs)) text = `(int)(${text})`
    else if ((operator === 'min=' || operator === 'max=') && value.prec < ATOM) text = `(${text})`
    if (operator === 'min=') return [`${target} = (${target} < ${text}) ? ${target} : ${text};`]
    if (operator === 'max=') return [`${target} = (${target} > ${text}) ? ${target} : ${text};`]
    return [`${target} ${operator} ${text};`]
}

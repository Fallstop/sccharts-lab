// A sum or difference as KIELER writes it into its C code (basics.md B-21a).
//
// KIELER's serializer (kexpressions KExpressionsSerializeHRExtensions.requiresParenthesis) decides the parentheses of
// an operand from the two operators: an operand of the same binding strength gets none in the first place of its
// parent, and none anywhere when it is the same operator as its parent and that operator is one of `+ - * && || & | ^
// ! ~` ("this will ignore user forces right associativity"). A minus sign is a subtraction with one operand there. For
// `+` and `*` that only regroups (`a + (b + c)` is written `a + b + c`), but for `-` it changes the value:
//
//   10 - (i - 2)     is written   10 - i - 2      (C subtracts from the left: 8 - i, not 12 - i)
//   -(i - 2)         is written   -i - 2
//   20 - (i + 2 - 1) is written   20 - i + 2 - 1  (the sum inside lost its place too)
//   - -i, -(-i)      is written   --i             (C's count-down operator: i loses 1, and the value is the new i)
//   - -5, - -(i + 1) is written   --5, --(i + 1)  (nothing to count down: gcc rejects it)
//
// So the engine reads a sum or difference as the list of terms C reads from that text (`additiveChain`), and the
// simulator, the typing of arrays (pointers.ts) and the C generator all work from the list. Probes
// tests/engine/kieler/written/probe-written-*.

import type { Diagnostic, Span } from '../types'
import { sourceText } from './eval'
import type { CEffect, CExpr, CStmt, CVar } from './model'
import { effectExprs } from './model'

type Op = Extract<CExpr, { k: 'op' }>

/** One term of the text C reads: `- --x` is { minus, signs: 2, atom: x }. */
export interface Term {
    /** The binary operator before it is `-` (the first term has none). */
    minus: boolean
    /** Minus signs written directly in front of it: one negates, two are C's `--`, more do not compile. */
    signs: number
    /** What follows: a name, a literal, or an operand KIELER puts in parentheses. */
    atom: CExpr
}

export interface Chain {
    terms: Term[]
    /** The text groups differently from the expression (parentheses KIELER leaves out around a difference). */
    regrouped: boolean
}

const isSum = (e: CExpr): boolean => e.k === 'op' && e.op === '+' && e.args.length >= 2
const isDifference = (e: CExpr): boolean => e.k === 'op' && e.op === '-' && e.args.length >= 2
const isMinus = (e: CExpr): boolean => e.k === 'op' && e.op === 'neg' && e.args.length === 1
export const isAdditive = (e: CExpr): boolean => isSum(e) || isDifference(e) || isMinus(e)

/** The terms of a sum, a difference or a negation, as C reads KIELER's text of it. */
export function additiveChain(e: Op): Chain {
    let regrouped = false
    const atom = (x: CExpr, minus: boolean, signs: number): Term[] => {
        // A negative literal is written with its sign.
        if (x.k === 'lit' && typeof x.v === 'number' && (x.v < 0 || Object.is(x.v, -0))) return [{ minus, signs: signs + 1, atom: { ...x, v: -x.v } }]
        return [{ minus, signs, atom: x }]
    }
    /** `x` written without parentheses where a term with `minus` and `signs` stands. */
    const inline = (x: Op, minus: boolean, signs: number): Term[] => {
        const terms = chain(x)
        terms[0] = { ...terms[0], minus, signs: terms[0].signs + signs }
        return terms
    }
    const chain = (x: Op): Term[] => {
        if (isMinus(x)) {
            const a: CExpr = x.args[0]
            // A difference (or another minus sign) under a minus sign has no parentheses: `-(p - q)` is `-p - q`.
            if (isDifference(a)) { regrouped = true; return inline(a as Op, false, 1) }
            if (isMinus(a)) return inline(a as Op, false, 1)
            return atom(a, false, 1)
        }
        const first: CExpr = x.args[0]
        // The first operand has no parentheses, whatever sum or difference it is.
        const out = isAdditive(first) ? inline(first as Op, false, 0) : atom(first, false, 0)
        const minus = isDifference(x)
        for (const a of x.args.slice(1) as CExpr[]) {
            // A later operand has none when it is the same operator: a sum in a sum, a difference (or a minus sign)
            // in a difference.
            if (minus ? isDifference(a) || isMinus(a) : isSum(a)) {
                if (minus && isDifference(a)) regrouped = true
                if (minus && isMinus(a) && isDifference((a as Op).args[0])) regrouped = true
                out.push(...inline(a as Op, minus, 0))
            } else out.push(...atom(a, minus, 0))
        }
        return out
    }
    return { terms: chain(e), regrouped }
}

const MULTIPLICATIVE = new Set(['*', '/', '%'])
export const isMultiplicative = (e: CExpr): e is Op => e.k === 'op' && MULTIPLICATIVE.has(e.op) && e.args.length >= 2

/**
 * A product, quotient or remainder as C reads KIELER's text of it. By the same rule as for sums (requiresParenthesis),
 * an operand of the same binding strength has no parentheses in the first place, and a product inside a product has
 * none anywhere; a quotient or remainder in a later place keeps them. So
 *
 *   100 * (i / 3 * 2)   is written   100 * i / 3 * 2     (C multiplies first: 100 * i / 3 * 2, not 100 * (i / 3) * 2)
 *   a * (b * c)         is written   a * b * c           (the same number for ints, another rounding for floats)
 *
 * `tree`: the expression grouped as C reads the text, from the left (the expression itself when nothing moves);
 * `changes`: a division or remainder moved, so the value can be another one.
 */
export function multiplicative(e: Op): { tree: Op; regrouped: boolean; changes: boolean } {
    let regrouped = false
    let changes = false
    type Step = { op: string; atom: CExpr }
    const chain = (x: Op): { first: CExpr; rest: Step[] } => {
        const a0: CExpr = x.args[0]
        const head = isMultiplicative(a0) ? chain(a0) : { first: a0, rest: [] as Step[] }
        const rest = [...head.rest]
        for (const a of x.args.slice(1) as CExpr[]) {
            if (x.op === '*' && isMultiplicative(a) && a.op === '*') {
                const inner = chain(a)
                regrouped = true
                if (inner.rest.some(st => st.op !== '*')) changes = true
                rest.push({ op: '*', atom: inner.first }, ...inner.rest)
            } else rest.push({ op: x.op, atom: a })
        }
        return { first: head.first, rest }
    }
    const c = chain(e)
    if (!regrouped) return { tree: e, regrouped, changes }
    let tree: CExpr = c.first
    for (const st of c.rest) tree = { k: 'op', op: st.op as Op['op'], args: [tree, st.atom], span: e.span }
    return { tree: tree as Op, regrouped, changes }
}

/** What `--x` counts down: a variable or an element (not an array, not a value). */
export function countedDown(atom: CExpr): atom is Extract<CExpr, { k: 'ref' }> {
    if (atom.k !== 'ref') return false
    let r = atom
    while (r.sub) r = r.sub
    return !r.v.method && !r.v.declKind && !r.v.extern && r.idx.length >= r.v.dims.length
}

/** What the code to check is made of (compile.ts). */
export interface WrittenCode {
    nodes: { effect?: CEffect; expr?: CExpr; transition?: { origin?: string; about?: string }; method?: unknown }[]
    functions: Iterable<CVar>
}

/**
 * The diagnostics for sums and differences KIELER's C code reads differently: an error where gcc rejects the `--`
 * (`lvalue required as decrement operand`), a kieler-quirk warning where the parentheses KIELER leaves out change the
 * value, or where two minus signs count a variable down.
 */
export function writtenDiagnostics(code: WrittenCode): Diagnostic[] {
    const out: Diagnostic[] = []
    const seen = new Set<string>()
    const label = (v: CVar) => v.display ?? v.name
    const text = (e: CExpr) => sourceText(e, label) ?? '...'
    const asWritten = (terms: Term[]): string => terms.map((t, i) => {
        const a = t.atom
        const inner = a.k === 'op' && a.op !== 'pre' && a.op !== 'val' && (isAdditive(a) || !['*', '/', '%', '!', '~'].includes(a.op)) ? `(${text(a)})` : text(a)
        return `${i ? (t.minus ? ' - ' : ' + ') : ''}${'-'.repeat(t.signs)}${inner}`
    }).join('')
    const visit = (e: CExpr | undefined, related: string[] | undefined) => {
        if (!e) return
        if (e.k === 'op' && isAdditive(e)) {
            const { terms, regrouped } = additiveChain(e)
            const span: Span | undefined = e.span
            const key = `${span?.start ?? text(e)}`
            // (The first pair gcc refuses, if any: a count-down that works in front of it does not hide it.)
            const refused = (t: Term) => t.signs > 2 || !countedDown(t.atom) || lowermostArray(t.atom)
            const twice = terms.find(t => t.signs >= 2 && refused(t)) ?? terms.find(t => t.signs >= 2)
            if (!seen.has(key) && (regrouped || twice)) {
                seen.add(key)
                if (twice && refused(twice)) {
                    out.push({
                        severity: 'error', code: 'c-decrement', span, related,
                        message: `KIELER writes the minus signs in front of \`${text(twice.atom)}\` next to each other, \`${asWritten(terms)}\`, which is C's count-down operator \`--\` with nothing to count down`,
                        kieler: 'lvalue required as decrement operand\nCompiler did not return success (exit value != 0)',
                        hint: 'KIELER leaves out the parentheses of a negation inside a negation, and C reads `--` as one operator, which needs a variable. Write the value without the double minus.',
                    })
                } else if (twice) {
                    out.push({
                        severity: 'warning', code: 'kieler-quirk', span, related,
                        message: `KIELER writes the two minus signs in front of \`${text(twice.atom)}\` next to each other, \`${asWritten(terms)}\`: C's count-down operator, which takes 1 off \`${text(twice.atom)}\` every time the expression is computed and gives the new value`,
                        hint: `KIELER leaves out the parentheses of a negation inside a negation, and C reads the two minus signs as \`--\`. The guide's simulation does the same. Write \`${text(twice.atom)}\` without the double minus.`,
                    })
                } else {
                    out.push({
                        severity: 'warning', code: 'kieler-quirk', span, related,
                        message: `KIELER's C code leaves out the parentheses of \`${text(e)}\`: it computes \`${asWritten(terms)}\``,
                        hint: 'KIELER writes a difference inside a difference (or under a minus sign) without its parentheses, and C then subtracts from the left. The guide\'s simulation does the same. Write the expression so that it needs no parentheses there (`a - b + c` for `a - (b - c)`), or compute the inner difference into a variable first.',
                    })
                }
            }
            for (const t of terms) atomParts(t.atom, related)
            return
        }
        atomParts(e, related)
    }
    /** The parts of an expression that is no sum or difference itself. */
    const atomParts = (e: CExpr, related: string[] | undefined) => {
        if (e.k === 'op' && isAdditive(e)) { visit(e, related); return }
        if (isMultiplicative(e)) {
            const m = multiplicative(e)
            const key = `*${e.span?.start ?? text(e)}`
            if (m.changes && !seen.has(key)) {
                seen.add(key)
                out.push({
                    severity: 'warning', code: 'kieler-quirk', span: e.span, related,
                    message: `KIELER's C code leaves out the parentheses of \`${text(e)}\`: it computes \`${text(m.tree)}\``,
                    hint: 'KIELER writes a product inside a product without its parentheses, and C then multiplies and divides from the left. The guide\'s simulation does the same. Divide first and keep the result in a variable, or put the division last.',
                })
            }
            if (m.regrouped) { atomParts(m.tree, related); return }
        }
        if (e.k === 'op' || e.k === 'call') e.args.forEach(a => visit(a, related))
        else if (e.k === 'ref') { for (let r: typeof e | undefined = e; r; r = r.sub) r.idx.forEach(i => visit(i, related)) }
        else if (e.k === 'vector') e.values.forEach(a => visit(a, related))
    }
    const effect = (f: CEffect, related: string[] | undefined) => {
        if (f.k === 'assign') visit(f.ref, related)
        for (const e of effectExprs(f)) visit(e, related)
    }
    const body = (list: CStmt[], related: string[] | undefined) => {
        for (const s of list) {
            if (s.k === 'do') effect(s.f, related)
            else if (s.k === 'if') { visit(s.cond, related); body(s.then, related); if (s.else) body(s.else, related) }
            else if (s.k === 'while') { visit(s.cond, related); body(s.body, related) }
            else if (s.k === 'for') { body(s.init, related); visit(s.cond, related); body(s.update, related); body(s.body, related) }
            else if (s.k === 'return') visit(s.expr, related)
            else if (s.k === 'expr') visit(s.e, related)
        }
    }
    for (const m of code.functions) body(m.method!.body, m.decl ? [m.decl] : undefined)
    for (const n of code.nodes) {
        const by = n.method ? undefined : n.transition?.origin ?? n.transition?.about
        const related = n.effect?.o.by ? [n.effect.o.by] : by ? [by] : undefined
        if (n.effect) effect(n.effect, related)
        visit(n.expr, related)
    }
    return out
}

function lowermostArray(e: CExpr): boolean {
    if (e.k !== 'ref') return false
    let r = e
    while (r.sub) r = r.sub
    return r.idx.length < r.v.dims.length
}

/** A sum or difference whose text C reads differently from the expression: its value is not its operands' values
 *  put together, so it is not folded piece by piece (fold.ts). */
export function readsDifferently(e: CExpr): boolean {
    if (e.k !== 'op' || !isAdditive(e)) return false
    const { terms, regrouped } = additiveChain(e)
    return regrouped || terms.some(t => t.signs >= 2)
}

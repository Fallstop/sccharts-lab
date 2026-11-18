// A defect of KIELER's netlist compiler (probes kieler/rare/probe-index-dropped-*, kieler/rare/probe-partial-eval-*):
// its partial evaluation (PartialAssignmentEvaluation, twice after the sequentializer, with kexpressions'
// PartialExpressionEvaluator) evaluates every condition's guard (`_c<g> = <condition>`) left to right, and gives up at
// the first plain variable, for which it knows no value. On the way it has already changed the condition: for an array
// reference it evaluates each index, and an index it cannot evaluate (`n % 2`) is put, as the very object, into a copy
// of the reference, which takes it out of the original. When the evaluation then gives up, the original stays, without
// that index: `ov[n] > 0 && a` becomes `ov > 0 && a`, while `a && ov[n] > 0` keeps it (the evaluation gives up at `a`
// before it reaches the element), and so does `ov[n] > 0` alone (nothing to give up at: the copy, which has the
// index, is used). The second pass meets what the first left: `ov[ov[n]] > 0 && a` loses the inner index in the
// first pass and the outer one in the second. With two indices that cannot be evaluated the copy gets the second one
// in the place of the first: `m[i][j] > 0`, with no plain variable after it, reads `m[j][j]`.
//
// What counts: only the indices of the variable the reference starts at (`cells[i].v`: the instance's; `c.arr[i]` and
// `rows[1].arr[i]` keep theirs), a member (`c.v`), `pre(x)` and `val(x)` are no plain variables (the evaluation goes
// on), a call of a chart's method or an extern function is one. Effects are not touched: they are inside the guards'
// branches, which the evaluator does not visit.
//
// The C code then uses the array itself, its address: never 0, so `ov > 0` and `!ok == false` hold, `ov == 0` and
// `ov < 3` do not; gcc rejects arithmetic other than + and - with it, comparisons with floats (`invalid operands to
// binary *`), an array as an index, and the member of an array of instances (`d->cells.v`). Official KIELER does the
// same.
//
// exec.ts evaluates such a condition as KIELER's C code has it: the array without its index is its address
// (pointers.ts, the typing of every array used as a value), and compile.ts reports it (`kieler-quirk` warning) or,
// where gcc fails, rejects the chart.

import type { Diagnostic } from '../types'
import { sourceText } from './eval'
import { guardError } from './pointerCheck'
import type { CExpr, CRef, CVar } from './model'

/** A condition as KIELER's C code has it. */
export interface GuardCondition {
    /** The condition after KIELER's partial evaluation. */
    expr: CExpr
    /** The array references in `expr` that lost indices (they are the array, or a row of it), with what was written. */
    dropped: Map<CRef, CRef>
    /** The references in `expr` whose indices are mixed up, with what was written. */
    mixed: Map<CRef, CRef>
    /** An element of an array of instances (or a call of its method) that lost its index: gcc rejects it. */
    instance?: { written: CExpr; array: CVar }
}

interface Out {
    /** The evaluation gave up (PartialExpressionEvaluator.eval returned null): the original stays. */
    abort: boolean
    /** The original as the evaluation left it. */
    orig: CExpr
    /** What the evaluation returns when it does not give up. */
    result: CExpr
}

type Ref = CRef | Extract<CExpr, { k: 'call' }>

/** The variable KIELER's reference starts at (the instance of `cells[i].v`). */
function rootOf(v: CVar): CVar {
    let root = v
    while (root.member) root = root.member.of
    return root
}

const VALUES = new Set(['lit', 'null', 'vector'])
const OPERANDS = new Set(['==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', 'neg', '!', '~', '?:'])

/** One run of KIELER's PartialExpressionEvaluator over a condition, with what it does to the condition itself. */
class Evaluation {
    /** References made here that lost an index or have them mixed up, with the reference they come from. */
    readonly lost = new Map<CExpr, CExpr>()
    readonly mixed = new Map<CExpr, CExpr>()

    constructor(private readonly before?: Evaluation) {}

    private source(e: CExpr): CExpr {
        return this.before?.lost.get(e) ?? this.before?.mixed.get(e) ?? e
    }

    evaluate(e: CExpr): Out {
        if (VALUES.has(e.k)) return { abort: false, orig: e, result: e }
        if (e.k === 'ref') {
            // The reference's own indices are those of the variable it starts at; a member is a sub-reference.
            const root = rootOf(e.v)
            const own = root === e.v ? e.idx.length : Math.min(e.idx.length, root.dims.length)
            return this.reference(e, e.idx, own, idx => ({ ...e, idx }), root !== e.v || !!e.sub)
        }
        if (e.k === 'call') {
            // A call of an instance's method is a reference to the instance with the method as sub-reference (the
            // element's indices are the first arguments here); its arguments are not looked at. Any other call cannot
            // be evaluated.
            const method = e.target?.v
            if (e.extern || !method?.member) return { abort: true, orig: e, result: e }
            return this.reference(e, e.args, Math.min(e.args.length, rootOf(method).dims.length), args => ({ ...e, args }), true)
        }
        if (e.k !== 'op') return { abort: true, orig: e, result: e }
        if (e.op === '&&' || e.op === '||') return this.logical(e)
        if (OPERANDS.has(e.op)) return this.operands(e)
        // pre, val and the dataflow operators are copied as they are.
        return { abort: false, orig: e, result: e }
    }

    private reference(e: Ref, indices: CExpr[], own: number, make: (indices: CExpr[]) => Ref, sub: boolean): Out {
        // A plain variable: the evaluator knows no value for it and gives up.
        if (!own && !sub) return { abort: true, orig: e, result: e }
        const rest = indices.slice(own)
        // The original's own indices (which shrink) and the copy's.
        const original = indices.slice(0, own)
        const copy = indices.slice(0, own)
        let mixed = false
        indices.slice(0, own).forEach((x, at) => {
            const r = this.evaluate(x)
            // `cp.indices.set(vor.indices.indexOf(expr), expr.evaluate)`: the position in what is left of the original.
            const position = original.indexOf(x)
            if (position !== at) mixed = true
            if (r.abort) {
                // The index itself goes into the copy, which takes it out of the original.
                copy[position] = r.orig
                original.splice(position, 1)
            } else {
                copy[position] = r.result
                original[position] = r.orig
            }
        })
        const changed = (list: CExpr[]) => list.length !== own || list.some((x, i) => x !== indices[i])
        const orig = changed(original) ? make([...original, ...rest]) : e
        const result = changed(copy) ? make([...copy, ...rest]) : e
        // What the new references are: without an index, or with the indices mixed up (as what they come from was).
        const wasLost = !!this.before?.lost.has(e)
        const wasMixed = !!this.before?.mixed.has(e)
        if (orig !== e) {
            if (original.length < own || wasLost) this.lost.set(orig, this.source(e))
            else if (wasMixed) this.mixed.set(orig, this.source(e))
        }
        if (result !== e) {
            if (wasLost) this.lost.set(result, this.source(e))
            else if (mixed || wasMixed) this.mixed.set(result, this.source(e))
        }
        return { abort: false, orig, result }
    }

    private logical(e: Extract<CExpr, { k: 'op' }>): Out {
        const seen: CExpr[] = []
        const kept: CExpr[] = []
        const original = () => (seen.some((x, i) => x !== e.args[i]) ? { ...e, args: [...seen, ...e.args.slice(seen.length)] } : e)
        for (const arg of e.args) {
            const r = this.evaluate(arg)
            seen.push(r.orig)
            if (r.abort) return { abort: true, orig: original(), result: e }
            if (r.result.k === 'lit') {
                // A literal ends the conjunction (false) or the disjunction (true), or is left out.
                const truthy = r.result.v !== false && r.result.v !== 0 && r.result.v !== ''
                if (truthy === (e.op === '||')) return { abort: false, orig: original(), result: { k: 'lit', t: 'bool', v: truthy } }
                continue
            }
            kept.push(r.result)
        }
        const same = kept.length === e.args.length && kept.every((x, i) => x === e.args[i])
        const result: CExpr = same ? e : kept.length === 0 ? { k: 'lit', t: 'bool', v: e.op === '&&' } : kept.length === 1 ? kept[0] : { ...e, args: kept }
        return { abort: false, orig: original(), result }
    }

    private operands(e: Extract<CExpr, { k: 'op' }>): Out {
        const seen: CExpr[] = []
        const results: CExpr[] = []
        const same = (list: CExpr[]) => list.every((x, i) => x === e.args[i])
        for (const arg of e.args) {
            const r = this.evaluate(arg)
            seen.push(r.orig)
            if (r.abort) return { abort: true, orig: same(seen) ? e : { ...e, args: [...seen, ...e.args.slice(seen.length)] }, result: e }
            results.push(r.result)
        }
        return { abort: false, orig: same(seen) ? e : { ...e, args: seen }, result: same(results) ? e : { ...e, args: results } }
    }
}

const cache = new WeakMap<CExpr, GuardCondition | null>()

/** The condition as KIELER's C code has it, or undefined if KIELER's partial evaluation leaves it as written. */
export function guardCondition(e: CExpr): GuardCondition | undefined {
    const known = cache.get(e)
    if (known !== undefined) return known ?? undefined
    // KIELER runs the evaluation twice (scg.netlist.kico): the second pass meets what the first left.
    const first = new Evaluation()
    const a = first.evaluate(e)
    const middle = a.abort ? a.orig : a.result
    const second = new Evaluation(first)
    const b = second.evaluate(middle)
    const expr = b.abort ? b.orig : b.result
    const out: GuardCondition = { expr, dropped: new Map(), mixed: new Map() }
    const visit = (x: CExpr) => {
        const lost = second.lost.get(x) ?? first.lost.get(x)
        const mixed = second.mixed.get(x) ?? first.mixed.get(x)
        if (lost) {
            if (x.k === 'ref' && rootOf(x.v) === x.v) out.dropped.set(x, lost as CRef)
            else out.instance ??= { written: lost, array: rootOf(x.k === 'call' ? x.target!.v : (x as CRef).v) }
        } else if (mixed && x.k === 'ref') out.mixed.set(x, mixed as CRef)
        if (x.k === 'ref') x.idx.forEach(visit)
        else if (x.k === 'op' || x.k === 'call') x.args.forEach(visit)
    }
    visit(expr)
    const changed = out.dropped.size > 0 || out.mixed.size > 0 || !!out.instance
    cache.set(e, changed ? out : null)
    return changed ? out : undefined
}

/**
 * The diagnostics for a condition KIELER's partial evaluation changes: what gcc rejects (the member of an array of
 * instances, arithmetic other than + and - with an array, a comparison with a float, an array as an index), else a
 * kieler-quirk warning. `written` is the condition as written, `label` names variables as the reader does.
 */
export function droppedIndexDiagnostics(written: CExpr, g: GuardCondition, label: (v: CVar) => string, related: string[] | undefined, chart = ''): Diagnostic[] {
    const text = (x: CExpr) => sourceText(x, label) ?? '...'
    const e = g.expr
    const why = 'A defect of KIELER\'s compiler: it tries to work out a condition ahead of time, takes a variable index out of an array element to do so, and gives up at the first plain variable after it without putting the index back'
    const fix = `Put a plain variable first (\`${plainFirst(written, label) ?? 'a && ...'}\`), or copy the element into a variable of its own before the test.`
    if (g.instance) {
        const element = text(g.instance.written)
        const array = g.instance.array
        return [{
            severity: 'error', code: 'c-array-address', span: g.instance.written.span, related,
            message: `KIELER's C code drops the index of \`${element}\` here and takes a member of the whole array \`${label(array)}\`, which gcc rejects`,
            kieler: `‘(${chart}_${array.hostType ?? array.name} *)&d->${array.name}’ is a pointer; did you mean to use ‘->’?\nCompiler did not return success (exit value != 0)`,
            hint: `${why}. ${fix}`,
        }]
    }
    // gcc's verdict on the condition as KIELER's code has it: the array without its index is a pointer (pointers.ts).
    const gcc = guardError(e)
    const first = [...g.dropped.values()][0] ?? [...g.mixed.values()][0]
    const element = text(first)
    const array = label(first.v)
    if (gcc && g.dropped.size) {
        return [{
            severity: 'error', code: 'c-array-address', span: first.span, related,
            message: `KIELER's C code drops the index of \`${element}\` here and computes with the array \`${array}\` itself, which gcc rejects`,
            kieler: `${gcc}\nCompiler did not return success (exit value != 0)`,
            hint: `${why}. ${fix}`,
        }]
    }
    if (!g.dropped.size) {
        const read = text([...g.mixed.keys()][0])
        return [{
            severity: 'warning', code: 'kieler-quirk', span: first.span, related,
            message: `KIELER's compiled code mixes up the indices of \`${element}\` in this condition: it reads \`${read}\``,
            hint: `A defect of KIELER's compiler: it tries to work out a condition ahead of time, and with two indices it cannot work out it puts the second in the place of the first. The guide's simulation does the same. Copy the element into a variable of its own before the test, or make one of the indices a constant.`,
        }]
    }
    return [{
        severity: 'warning', code: 'kieler-quirk', span: first.span, related,
        message: `KIELER's compiled code drops the index of \`${element}\` in this condition: it tests the address of the array \`${array}\`, which is never 0, instead of the element`,
        hint: `${why} (\`${text(written)}\`). The guide's simulation does the same. ${fix}`,
    }]
}

/** `a && ov[n] > 0` for `ov[n] > 0 && a`: the operands of a top-level && or || reordered, plain ones first. */
function plainFirst(e: CExpr, label: (v: CVar) => string): string | undefined {
    if (e.k !== 'op' || (e.op !== '&&' && e.op !== '||')) return undefined
    const plain = (x: CExpr) => x.k === 'ref' && !x.idx.length
    const ordered = [...e.args.filter(plain), ...e.args.filter(x => !plain(x))]
    if (ordered.every((x, i) => x === e.args[i])) return undefined
    return sourceText({ ...e, args: ordered }, label)
}

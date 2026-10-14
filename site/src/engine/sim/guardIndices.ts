// A defect of KIELER's netlist code generator (probes kieler/rare/probe-index-dropped-*): when it writes a
// condition's guard (`_c<g> = <condition>`, SimpleGuardSequentializer's copy of the guard), an array element whose
// index contains a variable loses its index if no plain variable comes before it in the condition and one comes
// after it (pre-order: `ov[n] > 0 && a` becomes `ov > 0 && a`, `a && ov[n] > 0` keeps it; a literal index is kept;
// a variable inside an index does not count as plain). The C code then uses the array itself, its address: never 0,
// so `ov > 0` and `!ok == false` hold, `ov == 0` and `ov < 3` do not; gcc rejects arithmetic other than + and - with
// it and comparisons with floats (`invalid operands to binary *`). Official KIELER 0.3.0 does the same.
//
// exec.ts evaluates such a condition with the address in place of the element (a large positive number, different
// for each array), and compile.ts reports it (`kieler-quirk` warning) or, where gcc fails, rejects the chart.

import type { Diagnostic } from '../types'
import { sourceText } from './eval'
import { walkExpr, type CExpr, type CRef, type CVar } from './model'

/** The array references of a condition whose index KIELER's C code drops (see above). */
export function droppedIndexRefs(e: CExpr): Set<CRef> {
    const out = new Set<CRef>()
    const order: { r: CRef; plain: boolean; variableIndex: boolean }[] = []
    const visit = (x: CExpr, inIndex: boolean) => {
        switch (x.k) {
            case 'ref': {
                const variableIndex = x.idx.some(i => { let found = false; walkExpr(i, y => { if (y.k === 'ref') found = true }); return found })
                if (!inIndex) order.push({ r: x, plain: !x.idx.length && !x.sub, variableIndex })
                for (const i of x.idx) visit(i, true)
                break
            }
            case 'op': for (const a of x.args) visit(a, inIndex); break
            case 'vector': for (const a of x.values) visit(a, inIndex); break
            case 'call': for (const a of x.args) visit(a, inIndex); break
            default: break
        }
    }
    visit(e, false)
    let plainBefore = false
    for (let i = 0; i < order.length; i++) {
        const o = order[i]
        if (o.plain) { plainBefore = true; continue }
        if (plainBefore || !o.variableIndex) continue
        if (order.slice(i + 1).some(x => x.plain)) out.add(o.r)
    }
    return out
}

/** A stand-in for the address of an array in KIELER's C code: large and positive, one per array. */
export function addressOf(v: CVar, slot: number): number {
    void v
    return 0x40000000 + slot * 64
}

/** The condition with the dropped elements replaced by their array's address (for exec.ts). */
export function withAddresses(e: CExpr, dropped: Set<CRef>, address: (v: CVar) => number): CExpr {
    const map = (x: CExpr): CExpr => {
        switch (x.k) {
            case 'ref': return dropped.has(x) ? { k: 'lit', t: 'int', v: address(x.v), span: x.span } : x
            case 'op': return { ...x, args: x.args.map(map) }
            case 'call': return { ...x, args: x.args.map(map) }
            default: return x
        }
    }
    return map(e)
}

const cType = (v: CVar): string => (v.type === 'float' ? 'double' : v.type === 'bool' || v.type === 'pure' ? 'char' : v.type === 'string' ? 'char*' : 'int')

/**
 * The diagnostics for a condition with dropped indices: what gcc rejects (arithmetic other than + and - with the
 * array, a comparison with a float), else a kieler-quirk warning. `label` names variables as the reader does.
 */
export function droppedIndexDiagnostics(e: CExpr, dropped: Set<CRef>, label: (v: CVar) => string, related: string[] | undefined): Diagnostic[] {
    const text = (x: CExpr) => sourceText(x, label) ?? '...'
    const type = (x: CExpr): string | undefined => {
        if (x.k === 'ref') return dropped.has(x) ? `${cType(x.v)} *` : x.idx.length || !x.v.dims.length ? cType(x.v) : `${cType(x.v)} *`
        if (x.k === 'lit') return x.t === 'float' ? 'double' : x.t === 'string' ? 'char *' : 'int'
        if (x.k === 'op' && (x.op === '+' || x.op === '-') && x.args.some(a => type(a)?.endsWith('*'))) return x.args.map(type).find(t => t?.endsWith('*'))
        if (x.k === 'op' && x.args.some(a => type(a) === 'double') && !['&&', '||', '!', '==', '!=', '<', '<=', '>', '>='].includes(x.op)) return 'double'
        return 'int'
    }
    let gcc: { op: string; a: string; b: string; at?: CExpr } | undefined
    walkExpr(e, x => {
        if (gcc || x.k !== 'op') return
        const types = x.args.map(type)
        const pointer = types.findIndex(t => t?.endsWith('*'))
        if (pointer < 0) return
        const other = types.find((t, i) => i !== pointer) ?? 'int'
        const symbol = x.op === 'neg' ? '-' : x.op
        const unary = x.op === 'neg' || x.op === '~'
        const bad = unary || ['*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(x.op)
            || (['+', '-', '<', '<=', '>', '>=', '==', '!='].includes(x.op) && other === 'double')
            || (x.op === '+' && types.filter(t => t?.endsWith('*')).length > 1)
        if (bad) gcc = { op: unary ? `unary ${symbol}` : `binary ${symbol}`, a: types[0] ?? 'int', b: types[1] ?? other, at: x }
    })
    const first = [...dropped][0]
    const element = text(first)
    const array = label(first.v)
    if (gcc) {
        return [{
            severity: 'error', code: 'c-array-address', span: first.span, related,
            message: `KIELER's C code drops the index of \`${element}\` here and computes with the array \`${array}\` itself, which gcc rejects`,
            kieler: gcc.op.startsWith('unary') ? `wrong type argument to ${gcc.op}\nCompiler did not return success (exit value != 0)` : `invalid operands to ${gcc.op} (have ‘${gcc.a}’ and ‘${gcc.b}’)\nCompiler did not return success (exit value != 0)`,
            hint: `A defect of KIELER's code generator: in a condition, an array element with a variable index loses the index when a plain variable comes after it and none before it. Put a plain variable first (\`${plainFirst(e, label) ?? 'a && ...'}\`), or copy the element into a variable of its own before the test.`,
        }]
    }
    return [{
        severity: 'warning', code: 'kieler-quirk', span: first.span, related,
        message: `KIELER's compiled code drops the index of \`${element}\` in this condition: it tests the address of the array \`${array}\`, which is never 0, instead of the element`,
        hint: `A defect of KIELER's code generator: in a condition, an array element with a variable index loses the index when a plain variable comes after it and none before it (\`${text(e)}\`). The guide's simulation does the same. Put a plain variable first (\`${plainFirst(e, label) ?? 'a && ...'}\`), or copy the element into a variable of its own before the test.`,
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

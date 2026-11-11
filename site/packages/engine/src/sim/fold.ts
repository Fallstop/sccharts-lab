// Constant folding (KIELER's PartialExpressionEvaluator as used by the Const processor): operator expressions
// whose operands are all literals are replaced by their value, computed with the simulator's C semantics.

import type { CExpr } from './model'
import { ExprCompiler, SimError } from './eval'
import { newRandState } from './random'

const BOOLEAN_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', '&&', '||', '!'])

const compiler = new ExprCompiler({
    info: () => { throw new Error('no variables in constant expressions') },
    label: v => v.name,
})

export function foldConstants(e: CExpr): CExpr {
    if (e.k === 'vector') return { ...e, values: e.values.map(foldConstants) }
    if (e.k === 'ref') return { ...e, idx: e.idx.map(foldConstants) }
    if (e.k !== 'op') return e
    const args = e.args.map(foldConstants)
    const folded: CExpr = { ...e, args }
    if (e.op === 'pre' || e.op === 'val') return folded
    if (!args.every(a => a.k === 'lit' && a.t !== 'string')) return folded
    try {
        const c = compiler.compile(folded)
        const value = c.fn({ vals: [], rand: newRandState() })
        if (typeof value !== 'number') return folded
        if (BOOLEAN_OPS.has(e.op)) return { k: 'lit', t: 'bool', v: value !== 0, span: e.span }
        if (c.type === 'float' || c.type === 'f32') return { k: 'lit', t: 'float', v: value, span: e.span }
        return { k: 'lit', t: 'int', v: value, span: e.span }
    } catch (error) {
        if (error instanceof SimError) return folded
        throw error
    }
}

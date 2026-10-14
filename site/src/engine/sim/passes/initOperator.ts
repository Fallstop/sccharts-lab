// KIELER's Init Operator processor (sccharts/processors/InitOperator.xtend). Owner: the structure workstream.
// structure.md S-28 .. S-30.
//
// `a -> pre(b)` becomes `a fby b` first. Every other `a -> ... -> c` becomes a helper variable `__iop_<k>` of the state
// enclosing the action (a transition's: the state containing its source) and a final region `__iop_<k>` there:
// `__Init_` -immediate/ __iop_k = a-> `__Delay_` -delayed/ __iop_k = c-> `__Loop_` -immediate-> `__Delay_`. The middle operands
// are dropped. The region is final, so it never keeps its state from terminating.

import type { Pass, PassContext } from './context'
import {
    createControlflowRegion, createImmediateTransitionTo, createInitialState, createState, createTransitionTo, createVar,
    ref, type CExpr,
} from '../model'
import { helperType, operatorUses, replaceIn, rootHelperClash } from '../structure/delays'

const PREFIX = '__iop_'

/** `a -> pre(b)` is `a fby b` (replaceInitPreByFby, recursively on the operands). */
function initPreToFby(e: CExpr): CExpr {
    if (e.k !== 'op') return e
    const args = e.args.map(initPreToFby)
    const last = args[args.length - 1]
    if (e.op === '->' && last?.k === 'op' && last.op === 'pre') return { ...e, op: 'fby', args: [args[0], initPreToFby(last.args[0])] }
    return { ...e, args }
}

export const initOperator: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.initOperator',
    name: 'Init Operator',
    owner: 'structure',
    run(ctx: PassContext) {
        for (const use of operatorUses(ctx.root, '->')) replaceIn(use.holder, use.expr, initPreToFby(use.expr))
        for (let k = 0; ; k++) {
            const use = operatorUses(ctx.root, '->')[0]
            if (!use) break
            const parent = use.parent
            const e = use.expr
            if (!parent) {
                replaceIn(use.holder, e, e.args[e.args.length - 1])
                continue
            }
            const about = use.holder.origin ?? use.holder.about
            if (e.args.length > 2) {
                ctx.report({
                    severity: 'info', code: 'kieler-quirk', span: e.span, related: about ? [about] : undefined,
                    message: 'KIELER ignores the middle values of this -> chain: the first tick gives the first value, every later tick the last',
                    hint: '`a -> b -> c` is `a -> c` in KIELER. The guide shows what KIELER does; for a sequence of values use fby: a fby b fby c.',
                })
            }
            rootHelperClash(parent, `${PREFIX}${k}`, ctx.report, e.span, about)
            const v = createVar(parent, `${PREFIX}${k}`, helperType(e, ctx.report, '->', about), 'init')
            v.display = '->'
            const region = createControlflowRegion(parent, `${PREFIX}${k}`)
            region.final = true
            region.about = about
            const init = createInitialState(region, '__Init_')
            const delay = createState(region, '__Delay_')
            const loop = createState(region, '__Loop_')
            for (const s of [init, delay, loop]) s.about = about
            const first = createImmediateTransitionTo(init, delay)
            first.effects.push({ k: 'assign', ref: ref(v), op: '=', expr: e.args[0], o: { by: about, span: e.span, hidden: true } })
            const later = createTransitionTo(delay, loop)
            later.effects.push({ k: 'assign', ref: ref(v), op: '=', expr: e.args[e.args.length - 1], o: { by: about, span: e.span, hidden: true } })
            createImmediateTransitionTo(loop, delay)
            for (const t of [first, later, ...loop.out]) t.about = about
            replaceIn(use.holder, e, { ...ref(v), span: e.span })
        }
    },
}

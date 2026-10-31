// KIELER's Sequential Followed By processor (sccharts/processors/SequentialFollowedBy.xtend). Owner: the structure
// workstream. structure.md S-28.
//
// `a sfby b` becomes `__iop_<k>` with a final region `__iop_<k>`: `_Init` -immediate/ __iop_k = a-> `_Delay` -delayed/ __iop_<k>t = true;
// __iop_k = b-> `_Loop` -immediate-> `_Delay`, which is `->`. KIELER moves the first operand into the first assignment
// and then takes the "first" operand again for the second, so `a sfby b sfby c` gives a, then b for ever (c never
// appears: a KIELER defect, reproduced). An sfby nested in the second operand starts when its parent's trigger
// `__iop_<k>t` is set.

import type { Pass, PassContext } from './context'
import {
    createControlflowRegion, createImmediateTransitionTo, createInitialState, createState, createTransitionTo, createVar,
    ref, walkExpr, type CExpr, type CVar,
} from '../model'
import { helperType, operatorUses, replaceIn, rootHelperClash } from '../structure/delays'

const PREFIX = '__iop_'

export const sequentialFollowedBy: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.sequentialFollowedBy',
    name: 'Sequential Followed By',
    owner: 'structure',
    run(ctx: PassContext) {
        const triggers = new Map<CExpr, CVar>()
        for (let k = 0; ; k++) {
            const use = operatorUses(ctx.root, 'sfby')[0]
            if (!use) break
            const parent = use.parent
            const e = use.expr
            if (!parent) {
                replaceIn(use.holder, e, e.args[0])
                continue
            }
            const about = use.holder.origin ?? use.holder.about
            const o = { by: about, span: e.span, hidden: true }
            if (e.args.length > 2) {
                ctx.report({
                    severity: 'info', code: 'kieler-quirk', span: e.span, related: about ? [about] : undefined,
                    message: 'In KIELER this `sfby` chain gives its first value, then its second for ever: the later values never appear',
                    hint: 'KIELER\'s Sequential Followed By transformation only uses the first two operands. The guide shows what KIELER does; write the sequence with states, or nest it: a sfby (b sfby c).',
                })
            }
            rootHelperClash(parent, `${PREFIX}${k}t`, ctx.report, e.span, about)
            const trigger = createVar(parent, `${PREFIX}${k}t`, 'bool', 'sfby')
            trigger.init = { k: 'lit', t: 'bool', v: false }
            const second = e.args[1]
            let following: CExpr | undefined
            walkExpr(second, x => { if (!following && x.k === 'op' && x.op === 'sfby') following = x })
            if (following) triggers.set(following, trigger)
            rootHelperClash(parent, `${PREFIX}${k}`, ctx.report, e.span, about)
            const local = createVar(parent, `${PREFIX}${k}`, helperType(e, ctx.report, 'sfby', about), 'sfby')
            local.display = 'sfby'
            const region = createControlflowRegion(parent, `${PREFIX}${k}`)
            region.final = true
            region.about = about
            const init = createInitialState(region, '_Init')
            const delay = createState(region, '_Delay')
            const loop = createState(region, '_Loop')
            for (const s of [init, delay, loop]) s.about = about
            const first = createImmediateTransitionTo(init, delay)
            const later = createTransitionTo(delay, loop)
            const back = createImmediateTransitionTo(loop, delay)
            first.effects.push({ k: 'assign', ref: ref(local), op: '=', expr: e.args[0], o })
            later.effects.push({ k: 'assign', ref: ref(trigger), op: '=', expr: { k: 'lit', t: 'bool', v: true }, o })
            later.effects.push({ k: 'assign', ref: ref(local), op: '=', expr: e.args[1] ?? e.args[0], o })
            for (const t of [first, later, back]) t.about = about
            const mine = triggers.get(e)
            if (mine) first.trigger = ref(mine)
            replaceIn(use.holder, e, { ...ref(local), span: e.span })
        }
    },
}

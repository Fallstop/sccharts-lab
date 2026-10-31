// KIELER's Followed By processor (sccharts/processors/FollowedBy.xtend). Owner: the structure workstream.
// structure.md S-28 .. S-30.
//
// `a fby b` becomes a helper variable `__fbp_<k>` of the state enclosing the action and a region `__fbp_<k>0` there:
// `init` -immediate/ __fbp_k = a-> `delay` -immediate/ __fbp_next0 = b-> `loop` -delayed/ __fbp_k = __fbp_next0->
// `delay`: the value of b from the previous tick. `a fby b fby c` chains one such region per operand but the last. The
// regions are not final: a superstate with an `fby` inside never terminates (S-30). KIELER does not make the names
// `__fbp_next<i>` unique: two of them in the chart's top level make its C code fail (structure/delays.ts).

import type { Pass, PassContext } from './context'
import {
    createControlflowRegion, createImmediateTransitionTo, createInitialState, createState, createTransitionTo, createVar,
    ref, type CExpr, type CState, type CVar,
} from '../model'
import { helperType, operatorUses, replaceIn, rootHelperClash } from '../structure/delays'

const PREFIX = '__fbp_'

export const followedBy: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.followedBy',
    name: 'Followed By',
    owner: 'structure',
    run(ctx: PassContext) {
        const reported = new Set<CState>()
        for (let k = 0; ; k++) {
            const use = operatorUses(ctx.root, 'fby')[0]
            if (!use) break
            const parent = use.parent
            const e = use.expr
            if (!parent) {
                replaceIn(use.holder, e, e.args[0])
                continue
            }
            const about = use.holder.origin ?? use.holder.about
            const type = helperType(e, ctx.report, 'fby', about)
            // S-30: the helper regions have no final state, so the state can never terminate.
            const join = parent.out.find(t => t.preemption === 'termination')
            if (join && !reported.has(parent)) {
                reported.add(parent)
                const name = parent.name
                ctx.report({
                    severity: 'info', code: 'kieler-quirk', span: e.span, related: [about, join.origin].filter((x): x is string => !!x),
                    message: `Because of this fby, \`${name}\` never finishes: its \`join to\` never fires`,
                    hint: `KIELER computes fby in a helper region of \`${name}\` that has no final state, so \`${name}\` cannot terminate. Use \`pre(...)\` or a variable updated on a transition instead, or leave \`${name}\` with a normal transition.`,
                })
            }
            const o = { by: about, span: e.span, hidden: true }
            rootHelperClash(parent, `${PREFIX}${k}`, ctx.report, e.span, about)
            const result = createVar(parent, `${PREFIX}${k}`, type, 'fby')
            result.display = 'fby'
            let local: CVar = result
            const operands: CExpr[] = e.args
            for (let i = 0; i < operands.length - 1; i++) {
                const region = createControlflowRegion(parent, `${PREFIX}${k}${i}`)
                region.about = about
                const init = createInitialState(region, 'init')
                const delay = createState(region, 'delay')
                const loop = createState(region, 'loop')
                for (const s of [init, delay, loop]) s.about = about
                rootHelperClash(parent, `${PREFIX}next${i}`, ctx.report, e.span, about)
                const next = createVar(parent, `${PREFIX}next${i}`, type, 'fby')
                const first = createImmediateTransitionTo(init, delay)
                first.effects.push({ k: 'assign', ref: ref(local), op: '=', expr: operands[i], o })
                const back = createTransitionTo(loop, delay)
                back.effects.push({ k: 'assign', ref: ref(local), op: '=', expr: ref(next), o })
                const step = createImmediateTransitionTo(delay, loop)
                if (i < operands.length - 2) {
                    rootHelperClash(parent, `${PREFIX}tmp${i}`, ctx.report, e.span, about)
                    const tmp = createVar(parent, `${PREFIX}tmp${i}`, type, 'fby')
                    step.effects.push({ k: 'assign', ref: ref(next), op: '=', expr: ref(tmp), o })
                    local = tmp
                } else {
                    step.effects.push({ k: 'assign', ref: ref(next), op: '=', expr: operands[operands.length - 1], o })
                }
                for (const t of [first, back, step]) t.about = about
            }
            replaceIn(use.holder, e, { ...ref(result), span: e.span })
        }
    },
}

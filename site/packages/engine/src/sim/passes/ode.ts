// KIELER's ODE processor (sccharts/processors/Ode.xtend). Owner: the structure workstream.
//
// Every assignment `x = e` of an `ode` action becomes an immediate during action of its state, `x += e * deltaT`
// (one Euler step per tick; the Timed Automata pass declared deltaT). Other effects of the action are dropped,
// and the action's own trigger is ignored, as in KIELER.

import type { Pass, PassContext } from './context'
import { allStates, createImmediateDuringAction, ref, removeAction } from '../model'
import { GCC_FAILED } from '../codegen'

export const ode: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.ode',
    name: 'ODE',
    owner: 'structure',
    run(ctx: PassContext) {
        const deltaT = ctx.root.decls.find(v => v.name.toLowerCase() === 'deltat')
        if (!deltaT) return
        for (const state of allStates(ctx.root)) {
            for (const action of state.actions.filter(a => a.kind === 'ode')) {
                for (const f of action.effects) {
                    if (f.k !== 'assign' || !f.expr) continue
                    // A member (lowered to a variable of its own) is dropped too: C cannot add a number to a struct.
                    let member = f.ref.v.member
                    while (member?.of.member) member = member.of.member
                    if (member) {
                        const path = `${member.of.name}.${f.ref.v.member!.name}`
                        ctx.report({
                            severity: 'error', code: 'ode-member', span: f.o.span, related: action.origin ? [action.origin] : undefined,
                            message: `\`ode ${path}\` does not compile in KIELER: its ODE transformation keeps only \`${member.of.name}\`, and C cannot add a number to a whole ${member.of.declKind ?? 'struct'}`,
                            kieler: `invalid operands to binary +\n${GCC_FAILED}`,
                            hint: `Integrate a float variable instead and copy it into the member: \`ode x = ...\` and \`during do ${path} = x\`.`,
                        })
                        return
                    }
                    const during = createImmediateDuringAction(state)
                    during.about = action.origin ?? action.about
                    during.span = action.span
                    // KIELER rebuilds the assignment from the valued object alone: indices and members are dropped.
                    during.effects.push({ ...f, ref: { ...ref(f.ref.v), span: f.ref.span }, op: '+=', expr: { k: 'op', op: '*', args: [f.expr, ref(deltaT)] } })
                    // KIELER removes the action once its first assignment is translated.
                    removeAction(state, action)
                }
            }
        }
    },
}

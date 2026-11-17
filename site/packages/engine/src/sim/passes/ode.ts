// KIELER's ODE processor (sccharts/processors/Ode.xtend). Owner: the structure workstream.
//
// Every assignment `x = e` of an `ode` action becomes an immediate during action of its state, `x += e * deltaT`
// (one Euler step per tick; the Timed Automata pass declared deltaT). Other effects of the action are dropped,
// and the action's own trigger is ignored, as in KIELER.

import type { Pass, PassContext } from './context'
import { allStates, createImmediateDuringAction, ref, removeAction } from '../model'

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
                    const during = createImmediateDuringAction(state)
                    during.about = action.origin ?? action.about
                    during.span = action.span
                    during.effects.push({ ...f, op: '+=', expr: { k: 'op', op: '*', args: [f.expr, ref(deltaT)] } })
                    // KIELER removes the action once its first assignment is translated.
                    removeAction(state, action)
                }
            }
        }
    },
}

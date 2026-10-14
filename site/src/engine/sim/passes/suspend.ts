// KIELER's Suspend processor (sccharts/processors/Suspend.xtend, transformSuspend): a state S with `suspend if c`
// gets one flag `_enabled` (no initial value: false in KIELER's generated C), every action and transition inside S
// and on S (its own entry, during and exit actions and its outgoing transitions included, other suspends not)
// gets `&& _enabled` in its trigger, then S gets `immediate during do _enabled = true` and, per suspend,
// `[immediate] during do _enabled &= !c` (preemption.md P-37..P-45).
//
// The flag is computed by during actions that run after S's entry actions and is false before S's first tick, so
// S's entry actions are skipped on its first entry (P-42) and its exit actions when an ancestor removes it while
// suspended (P-43); S's own outgoing transitions are frozen while it is suspended (P-38), and its termination
// becomes conditional and so delayed (P-44). quirks.ts explains these where a chart can show them.
//
// A suspend without trigger is rejected: official KIELER fails with an internal error in code generation, the
// SCCharts Lab server reports the suspend (P-45). Count delays on suspends are ignored (P-32).

import type { Pass, PassContext } from './context'
import { and2, containedActions, not } from './contained'
import { allStates, assign, CAction, createAction, createVar, isImmediate, readableName, ref, removeAction, TRUE, type CState, type CVar } from '../model'

export const suspend: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.suspend',
    name: 'Suspend',
    owner: 'preemption',
    run(ctx: PassContext) {
        for (const state of allStates(ctx.root)) transformSuspend(state, ctx)
    },
}

function transformSuspend(state: CState, ctx: PassContext) {
    const suspends = state.actions.filter(a => a.kind === 'suspend' && !a.weak)
    if (!suspends.length) return
    const about = state.origin ?? state.about

    const flag = createVar(state, '_enabled', 'bool', 'enabled')
    flag.display = `\`${readableName(state) ?? state.name}\`'s suspend condition`
    registerSuspend(ctx, state, flag, false)

    // Every contained action and transition (other suspends excluded) only runs while not suspended.
    for (const action of containedActions(state)) {
        if (action instanceof CAction && action.kind === 'suspend') continue
        action.trigger = and2(action.trigger, ref(flag))
    }

    // Created after guarding: the flag's own updates are not guarded.
    const reset = createAction(state, 'during')
    reset.delay = 'immediate'
    reset.about = about
    reset.effects.push(assign(flag, TRUE, { hidden: true, by: about }))

    for (const s of suspends) {
        const during = createAction(state, 'during')
        during.delay = isImmediate(s) ? 'immediate' : 'undefined'
        during.about = s.origin ?? about
        if (s.trigger === undefined) {
            ctx.report({
                severity: 'error', code: 'suspend-without-trigger', span: s.span, related: s.origin ? [s.origin] : about ? [about] : undefined,
                message: `This suspend has no condition, so it is not clear when \`${state.name}\` should freeze`,
                hint: `Write the condition after if, for example \`suspend if Pause\`. KIELER cannot compile a suspend without one.`,
                kieler: 'This suspend has no trigger. KIELER cannot compile a suspend without an if condition.',
            })
        } else {
            during.effects.push(assign(flag, not(s.trigger), { hidden: true, by: s.origin ?? about }, '&='))
        }
        removeAction(state, s)
    }
}

/** What the executor needs to report suspended ticks: the flag of each state with a (weak) suspend. */
export interface SuspendInfo {
    state: string
    flag: CVar
    weak: boolean
}

export function registerSuspend(ctx: PassContext, state: CState, flag: CVar, weak: boolean) {
    const id = state.origin ?? state.about
    if (!id) return
    const root = ctx.root
    const list = (root.ext.suspends as SuspendInfo[] | undefined) ?? []
    list.push({ state: id, flag, weak })
    root.ext.suspends = list
}

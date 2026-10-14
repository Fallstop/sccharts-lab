// KIELER's During Action processor (sccharts/processors/During.xtend): every during action becomes a region of
// its state with a self-loop (delayed: one state; immediate: two states, so the action can also run in the entry
// tick), concurrent with the state's other regions (concurrency.md 1.1; preemption.md P-6..P-9). A state without
// inner behaviour turns an immediate during action into a weak entry action instead.

import type { Pass, PassContext } from './context'
import {
    actionsOf, allStates, controlflowRegions, copyEffect, createAction, createControlflowRegion, createInitialState,
    createState, createTransitionTo, regionsMayTerminate, removeAction, copyExpr, isImmediate, type CState,
} from '../model'

export const during: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.duringAction',
    name: 'During Action',
    owner: 'core',
    run(ctx: PassContext) {
        for (const state of allStates(ctx.root)) transformDuring(state, ctx)
    },
}

function transformDuring(state: CState, ctx: PassContext) {
    const hasOutgoingTerminations = state.out.some(t => t.preemption === 'termination')
    // FinalRegion.COMPILATION_SUPPORTS_FINAL_REGIONS && DURING_USES_FINAL_REGIONS (default true)
    const finalRegions = ctx.config.finalRegions
    const complexDuring = (hasOutgoingTerminations || state.root) && state.regions.length > 0 && regionsMayTerminate(state)
    const hasInnerBehavior = controlflowRegions(state).some(r => !r.final) ||
        !state.out.every(t => isImmediate(t) && t.preemption !== 'termination' && t.trigger === undefined)
    const isNonRootHaltState = !state.root && state.out.length === 0
    const hasStrongAbort = state.out.some(t => t.preemption === 'strong')

    for (const action of actionsOf(state, 'during')) {
        const activeDuringAction = state.root && !hasInnerBehavior
        if (!activeDuringAction && !hasInnerBehavior && !isNonRootHaltState) {
            if (isImmediate(action)) {
                const entry = createAction(state, 'entry')
                entry.preemption = 'weak'
                entry.about = action.origin ?? action.about
                entry.trigger = copyExpr(action.trigger)
                for (const f of action.effects) entry.effects.push(copyEffect(f))
            }
        } else {
            const region = createControlflowRegion(state, '_During')
            region.about = action.origin ?? action.about
            const initial = createInitialState(region, '_I')
            initial.about = region.about
            if (finalRegions && !activeDuringAction && !isNonRootHaltState && !hasStrongAbort) region.final = true
            let duringTransition
            if (isImmediate(action)) {
                const second = createState(region, '_S')
                second.about = region.about
                duringTransition = createTransitionTo(initial, second)
                createTransitionTo(second, initial)
                if (complexDuring && (!finalRegions || activeDuringAction)) second.final = true
            } else {
                duringTransition = createTransitionTo(initial, initial)
            }
            if (complexDuring && (!finalRegions || activeDuringAction)) initial.final = true
            duringTransition.delay = action.delay
            duringTransition.delay = isImmediate(action) ? 'immediate' : 'undefined'
            duringTransition.about = action.origin ?? action.about
            duringTransition.trigger = copyExpr(action.trigger)
            for (const f of action.effects) duringTransition.effects.push(copyEffect(f))
        }
        removeAction(state, action)
    }
}

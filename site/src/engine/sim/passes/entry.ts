// KIELER's Entry Action processor (sccharts/processors/Entry.xtend), run twice: for `weak entry` actions before
// Abort, for (strong) `entry` actions after Initialization. Entry actions become a chain of immediate
// transitions in front of the state's inner behaviour (preemption.md P-1, P-2; concurrency.md H-1).

import type { Pass, PassContext } from './context'
import {
    actionsOf, controlflowRegions, controlflowRegionsContainStates, copyEffect, createControlflowRegion,
    createFinalState, createImmediateTransitionTo, createInitialState, createState, createTransitionTo, addRegion,
    allStates, removeAction, setSource, setTarget, type CAction, type CState,
} from '../model'

export function entryPass(preemption: 'weak' | 'strong'): Pass {
    return {
        id: 'de.cau.cs.kieler.sccharts.processors.entryAction',
        name: `Entry Action (${preemption})`,
        owner: 'core',
        config: { 'de.cau.cs.kieler.sccharts.entry.preemptionType': preemption },
        run(ctx: PassContext) {
            for (const state of allStates(ctx.root)) transformEntry(state, preemption)
        },
    }
}

export function transformEntry(state: CState, preemption: 'weak' | 'strong') {
    const entryActions = actionsOf(state, 'entry').filter(a => a.preemption === preemption)
    if (!entryActions.length) return

    let first: CState
    let last: CState

    if (state.final && !state.initial && state.incoming.length > 0) {
        const connector = createState(state.parent!, '__EA_C')
        connector.connector = true
        connector.about = state.origin ?? state.about
        for (const t of [...state.incoming]) setTarget(t, connector)
        first = connector
        last = state
    } else if (!controlflowRegionsContainStates(state)) {
        state.regions = [] // FIX in KIELER: erase a dummy single region
        const region = createControlflowRegion(state, '__EA_Entry')
        first = createInitialState(region, '__EA_Init')
        last = createState(region, '__EA_Done')
        if (preemption === 'strong') {
            last.final = state.out.some(t => t.preemption !== 'termination') || (state.out.length === 0 && state.final)
            if (state.out.length > 0 || state.final) {
                const exitState = createState(state.parent!, '__EA_Exit')
                exitState.about = state.origin ?? state.about
                exitState.final = state.final
                for (const t of [...state.out]) setSource(t, exitState)
                createTransitionTo(state, exitState).preemption = 'termination'
            }
        }
        state.final = false
    } else if (controlflowRegions(state).length === 1) {
        const region = controlflowRegions(state)[0]
        last = region.states.find(s => s.initial)!
        last.initial = false
        first = createInitialState(region, '__EA_Init')
    } else {
        const region = createControlflowRegion(state, '__EA_Entry')
        last = createState(region, '__EA_Main')
        for (const r of state.regions.filter(r => r !== region)) addRegion(last, r)
        first = createInitialState(region, '__EA_Init')
        const finalState = createFinalState(region, '__EA_Done')
        createTransitionTo(last, finalState).preemption = 'termination'
    }

    tagGenerated(state, first, last)
    const entryRegion = first.parent!
    const lastAction = entryActions[entryActions.length - 1]
    for (const action of entryActions) {
        let connector = last
        if (action !== lastAction) {
            connector = createState(entryRegion, '__EA_C')
            connector.connector = true
            connector.about = state.origin ?? state.about
        }
        const t = createImmediateTransitionTo(first, connector)
        t.about = action.origin ?? action.about
        for (const f of action.effects) t.effects.push(copyEffect(f))
        if (action.trigger) {
            t.trigger = action.trigger
            createImmediateTransitionTo(first, connector).about = action.origin ?? action.about
        }
        first = connector
        removeAction(state, action)
    }
}

/** Generated states implement the state whose actions they run. */
function tagGenerated(state: CState, ...generated: CState[]) {
    for (const s of generated) if (!s.origin && !s.about) s.about = state.origin ?? state.about
}

export type { CAction }

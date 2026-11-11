// KIELER's Exit Action processor (sccharts/processors/Exit.xtend), run twice: for `weak exit` actions before
// Abort, for (strong) `exit` actions after Abort. Exit actions become a chain of transitions between the end of
// the state's inner behaviour and its outgoing transitions (preemption.md P-1, P-12).

import type { Pass, PassContext } from './context'
import {
    actionsOf, allStates, controlflowRegions, controlflowRegionsContainStates, copyEffect, createControlflowRegion,
    createFinalState, createImmediateTransitionTo, createInitialState, createState, createVar, finalStates,
    getOrCreateSimpleFinalState, isImplicitlyImmediate, lit, op, ref, removeAction, setSource, setTarget, addRegion,
    assign, type CState,
} from '../model'

export function exitPass(preemption: 'weak' | 'strong'): Pass {
    return {
        id: 'de.cau.cs.kieler.sccharts.processors.exitAction',
        name: `Exit Action (${preemption})`,
        owner: 'core',
        config: { 'de.cau.cs.kieler.sccharts.exit.preemptionType': preemption },
        run(ctx: PassContext) {
            for (const state of allStates(ctx.root)) transformExit(state, preemption)
        },
    }
}

export function transformExit(state: CState, preemption: 'weak' | 'strong') {
    const exitActions = actionsOf(state, 'exit').filter(a => a.preemption === preemption)
    if (!exitActions.length || state.final) return

    const outgoing = state.out.length
    let first: CState
    let last: CState
    const noRegions = !controlflowRegionsContainStates(state)
    const about = state.origin ?? state.about

    if (noRegions && outgoing === 0) {
        for (const a of exitActions) removeAction(state, a)
        return
    }

    if (noRegions) {
        state.regions = []
        const region = createControlflowRegion(state, '_Exit')
        first = createInitialState(region, '_Init')
        last = createFinalState(region, '_Done')
    } else if (controlflowRegions(state).length === 1 && finalStates(controlflowRegions(state)[0]).length > 0) {
        const region = controlflowRegions(state)[0]
        first = getOrCreateSimpleFinalState(region, '_PriorFinal')
        last = createFinalState(region, '_Done')
        first.final = false
        for (const other of finalStates(region)) {
            if (other !== last) {
                createImmediateTransitionTo(other, first)
                other.final = false
            }
        }
    } else {
        const region = createControlflowRegion(state, '_Entry')
        first = createInitialState(region, '_Main')
        for (const r of state.regions.filter(r => r !== region)) addRegion(first, r)
        last = createFinalState(region, '_Done')
    }
    for (const s of [first, last]) if (!s.origin && !s.about) s.about = about

    if (noRegions && outgoing > 0) {
        const region = first.parent!
        const memory = outgoing > 1 ? createVar(state.parent!.parent, '_exit', 'int', 'exit') : undefined
        if (memory) memory.display = `the transition \`${state.name}\` leaves by`
        const middle = createState(region, '_Memorize')
        middle.connector = true
        middle.about = about
        const exitOption = createState(state.parent!, '_ExitOption')
        exitOption.connector = true
        exitOption.about = about
        let counter = 1
        for (const t of [...state.out]) {
            const exitTransition = createImmediateTransitionTo(exitOption, t.target)
            exitTransition.about = t.origin ?? t.about
            if (memory) exitTransition.trigger = op('==', ref(memory), lit(counter))
            exitTransition.effects.push(...t.effects)
            t.effects = []
            setSource(t, first)
            t.delay = isImplicitlyImmediate(t) ? 'immediate' : 'undefined'
            t.preemption = 'weak'
            setTarget(t, middle)
            if (memory) {
                t.effects.push(assign(memory, lit(counter)))
                counter++
            }
        }
        createImmediateTransitionTo(state, exitOption).preemption = 'termination'
        first = middle
    }

    const exitRegion = first.parent!
    const lastAction = exitActions[exitActions.length - 1]

    if (controlflowRegionsContainStates(first) && exitActions[0]?.trigger) {
        const connector = createState(exitRegion, '_C')
        connector.connector = true
        connector.about = about
        createImmediateTransitionTo(first, connector).preemption = 'termination'
        first = connector
    }

    for (const action of exitActions) {
        let connector = last
        if (action !== lastAction) {
            connector = createState(exitRegion, '_C')
            connector.connector = true
            connector.about = about
        }
        const t = createImmediateTransitionTo(first, connector)
        t.about = action.origin ?? action.about
        if (controlflowRegionsContainStates(first)) t.preemption = 'termination'
        for (const f of action.effects) t.effects.push(copyEffect(f))
        if (action.trigger) {
            t.trigger = action.trigger
            createImmediateTransitionTo(first, connector).about = action.origin ?? action.about
        }
        first = connector
        removeAction(state, action)
    }
}

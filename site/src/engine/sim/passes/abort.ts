// KIELER's Abort processor (sccharts/processors/Abort.xtend, transformAbortNoWTO_NEW): the outgoing transitions
// of a superstate (weak aborts `go to`, strong aborts `abort to`, terminations `join to`) are realised inside it:
// every inner state gets transitions to an `_Aaborted` final state of its region (strong aborts first and
// delayed, weak aborts last and immediate), a `_ACtrl` watcher region handles delayed weak aborts, and the
// superstate is left by a single termination to a connector that chooses among the original transitions.
// Ported line by line, including its optimisations and quirks (concurrency.md K-1, K-3; preemption.md §0).

import type { Pass, PassContext } from './context'
import { ANNOTATION_FINALSTATE, ANNOTATION_TERMINATION, ANNOTATION_TERMINATION_DELAYED, transformTermination } from './termination'
import {
    allContainedStates, assign, canImmediateAborted, canImmediateTerminate, containsInnerActions, controlflowRegions,
    controlflowRegionsContainStates, copyExpr, createControlflowRegion, createEntryAction, createFinalState,
    createInitialState, createState, createTransitionTo, createVar, getOrCreateSimpleFinalState, isImplicitlyImmediate,
    effectExprs, or, ref, removeState, removeTransition, setLowestPriority, setHighestPriority, setSource, walkExpr, TRUE, FALSE,
    type CExpr, type CState, type CTransition, type CVar,
    quoted, readableName,
} from '../model'

export const abort: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.abort',
    name: 'Abort',
    owner: 'core',
    run(ctx: PassContext) {
        for (const state of allContainedStates(ctx.root)) {
            handleTermination(state)
            transformAbort(state, ctx)
        }
    },
}

function handleTermination(state: CState) {
    const singleTermination = state.out.filter(t => t.preemption === 'termination' && isImplicitlyImmediate(t) && t.trigger === undefined).length === 1 &&
        state.out.filter(t => t.preemption === 'termination').length === 1
    const noWeakAborts = !state.out.some(t => t.preemption === 'weak')
    const noMixedStrongAborts = !state.out.some(t => t.preemption === 'strong' && isImplicitlyImmediate(t)) ||
        !state.out.some(t => t.preemption === 'strong' && !isImplicitlyImmediate(t))
    const delayedStrongAbortButImmediateTermination = state.out.some(t => t.preemption === 'strong' && !isImplicitlyImmediate(t)) &&
        canImmediateTerminate(state)
    if (!(singleTermination && noWeakAborts && noMixedStrongAborts) || delayedStrongAbortButImmediateTermination) {
        transformTermination(state)
    }
}

const triggerOrTrue = (t: CTransition): CExpr => (t.trigger === undefined ? TRUE : t.trigger)

function transformAbort(state: CState, ctx: PassContext) {
    const untransformed = state.out.length > 1 ||
        (state.out.length === 1 && !(state.out.filter(t => t.preemption === 'termination' && t.trigger === undefined).length === 1))

    if (!(controlflowRegionsContainStates(state) && untransformed)) {
        // Without abortable inner control flow, strong aborts are weak (entry/exit actions are not aborted).
        for (const t of state.out) if (t.preemption === 'strong') t.preemption = 'weak'
        return
    }

    const untransformedAborts = state.out.some(t => t.preemption !== 'termination')
    const about = state.origin ?? state.about
    const triggerVars = new Map<CTransition, CVar>()
    const outgoing = [...state.out]
    const regions = controlflowRegions(state).filter(r => !r.final || !ctx.config.finalRegions)

    const delayedWeakAborts = outgoing.filter(t => t.preemption === 'weak' && !isImplicitlyImmediate(t))
    let mixedDelayedStrongAborts = outgoing.some(t => t.preemption === 'strong' && !isImplicitlyImmediate(t)) &&
        outgoing.some(t => isImplicitlyImmediate(t))
    // ABRO optimisation: no priority inversion if the state cannot terminate or be aborted immediately.
    if (!(canImmediateTerminate(state) || canImmediateAborted(state))) mixedDelayedStrongAborts = false

    let aFinalStateInEveryRegion = true
    for (const r of regions) if (!r.states.some(s => s.final)) aFinalStateInEveryRegion = false

    const delayedAbortHandlingNeeded = delayedWeakAborts.length > 0 || mixedDelayedStrongAborts
    const termination = outgoing.some(t => t.preemption === 'termination' && t.trigger === undefined)
    const anyFinalStateInEveryRegionButNoTermination = aFinalStateInEveryRegion && !termination && !state.root
    const needCtrlRegion = delayedAbortHandlingNeeded || anyFinalStateInEveryRegionButNoTermination

    if (untransformedAborts || untransformed) {
        let doneState: CState | undefined
        let runState: CState | undefined
        if (needCtrlRegion) {
            const ctrl = createControlflowRegion(state, '_ACtrl')
            ctrl.about = about
            runState = createInitialState(ctrl, '_ARun')
            doneState = createFinalState(ctrl, '_ADone')
            runState.about = about
            doneState.about = about
        }

        const strongAbortTriggers: CExpr[] = []
        const strongAbortImmediateTriggers: CExpr[] = []
        /** Which source transition each trigger list tests (only when it holds one trigger: for the log). */
        const sourceOf = new Map<CExpr[], (string | undefined)[]>()
        const note = (list: CExpr[], t: CTransition) => {
            const l = sourceOf.get(list) ?? []
            l.push(t.origin ?? t.checks)
            sourceOf.set(list, l)
        }
        const single = (list: CExpr[]): string | undefined => {
            const l = sourceOf.get(list)
            return l && l.length === 1 ? l[0] : undefined
        }
        let weakAbortDelayOptimizationPossible = true
        const weakAbortImmediateTriggers: CExpr[] = []
        const terminationTriggers = new Map<CExpr, string[]>()
        for (const t of outgoing) {
            if (t.preemption === 'strong') {
                if (isImplicitlyImmediate(t)) {
                    strongAbortImmediateTriggers.push(copyExpr(triggerOrTrue(t)))
                    note(strongAbortImmediateTriggers, t)
                } else if (mixedDelayedStrongAborts) {
                    const v = triggerVariable(state, t, about)
                    triggerVars.set(t, v)
                    strongAbortTriggers.push(ref(v))
                } else {
                    strongAbortTriggers.push(copyExpr(triggerOrTrue(t)))
                    note(strongAbortTriggers, t)
                }
            } else if (t.preemption === 'weak') {
                let trigger: CExpr
                if (isImplicitlyImmediate(t)) {
                    trigger = copyExpr(triggerOrTrue(t))
                    weakAbortDelayOptimizationPossible = false
                    weakAbortImmediateTriggers.push(trigger)
                    note(weakAbortImmediateTriggers, t)
                } else {
                    const v = triggerVariable(state, t, about)
                    triggerVars.set(t, v)
                    trigger = ref(v)
                    weakAbortImmediateTriggers.push(trigger)
                }
                const termInfo = t.annotations.get(ANNOTATION_TERMINATION)
                if (termInfo) terminationTriggers.set(trigger, termInfo)
            }
        }

        for (const region of regions) {
            const aborted = getOrCreateSimpleFinalState(region, '_Aaborted')
            if (!aborted.origin && !aborted.about) aborted.about = about
            for (const inner of region.states.filter(s => !s.final && !s.connector)) {
                if (inner === aborted) continue
                const innerHasBehaviour = controlflowRegionsContainStates(inner) || containsInnerActions(inner)
                if (strongAbortTriggers.length) {
                    const t = createTransitionTo(inner, aborted, 0)
                    if (innerHasBehaviour) t.preemption = 'strong'
                    setHighestPriority(t)
                    t.trigger = copyExpr(or(strongAbortTriggers))
                    t.delay = 'undefined'
                    t.about = about
                    t.checks = single(strongAbortTriggers)
                }
                if (strongAbortImmediateTriggers.length) {
                    const t = createTransitionTo(inner, aborted, 0)
                    if (innerHasBehaviour) t.preemption = 'strong'
                    setHighestPriority(t)
                    t.trigger = copyExpr(or(strongAbortImmediateTriggers))
                    t.delay = 'immediate'
                    t.about = about
                    t.checks = single(strongAbortImmediateTriggers)
                }
                if (weakAbortImmediateTriggers.length) {
                    let trigger: CExpr | undefined
                    if (inner.annotations.has(ANNOTATION_FINALSTATE)) {
                        const t = createTransitionTo(inner, aborted)
                        t.delay = 'immediate'
                        t.about = about
                    } else {
                        const triggers = weakAbortImmediateTriggers.filter(tr => {
                            const transitionInfo = terminationTriggers.get(tr)
                            const regionInfo = region.annotations.get(ANNOTATION_TERMINATION)
                            if (transitionInfo && regionInfo) {
                                if (regionInfo.length && transitionInfo.includes(regionInfo[0])) return false
                            }
                            return true
                        })
                        if (triggers.length) trigger = copyExpr(or(triggers))
                    }
                    if (trigger !== undefined) {
                        const t = createTransitionTo(inner, aborted)
                        t.trigger = copyExpr(trigger)
                        setLowestPriority(t)
                        t.delay = 'immediate'
                        t.about = about
                        t.checks = single(weakAbortImmediateTriggers)
                        if (canBeDelayed(inner) && weakAbortDelayOptimizationPossible) t.delay = 'undefined'
                    }
                }
            }
            if (aborted.incoming.length === 0) {
                if (aborted.origin) {
                    // concurrency.md K-1: the region's only final state was reused as its _Aaborted state and is gone.
                    ctx.report({
                        severity: 'warning', code: 'kieler-quirk', related: [aborted.origin, ...(state.origin ? [state.origin] : [])],
                        message: `KIELER removes the final state \`${aborted.name}\` when it builds the transitions out of \`${state.name}\`, so \`${state.name}\` can never be left by them`,
                        hint: 'A region that is nothing but an initial final state breaks its parent\'s aborts and triggered joins in KIELER. Give the region a state before the final state, or remove the region.',
                    })
                }
                removeState(aborted)
            }
        }

        for (const t of outgoing) {
            if (needCtrlRegion) {
                const ctrlTransition = createTransitionTo(runState!, doneState!)
                ctrlTransition.about = t.origin ?? t.about
                ctrlTransition.checks = t.trigger ? t.origin ?? t.checks : undefined
                setLowestPriority(ctrlTransition)
                if (isImplicitlyImmediate(t)) {
                    ctrlTransition.delay = 'immediate'
                    if (containsDelayedTerm(t)) ctrlTransition.delay = 'undefined'
                }
                ctrlTransition.trigger = copyExpr(t.trigger)
                const v = triggerVars.get(t)
                if (v) ctrlTransition.effects.push(assign(v, TRUE))
            }
        }
    }

    const connector = createState(state.parent!, '_AC')
    connector.connector = true
    connector.about = about
    createTransitionTo(state, connector).preemption = 'termination'
    const defaultTransition = outgoing[outgoing.length - 1]
    for (const t of outgoing) {
        setSource(t, connector)
        if (t !== defaultTransition) {
            const v = triggerVars.get(t)
            if (v) t.trigger = ref(v)
        } else {
            t.trigger = undefined
        }
        t.preemption = 'weak'
    }

    // Optimisation: a connector with a single outgoing transition is removed.
    if (connector.out.length === 1) {
        const t = connector.out[0]
        t.delay = 'immediate'
        t.preemption = 'termination'
        t.trigger = undefined
        const toDelete = connector.incoming[0]
        removeTransition(toDelete)
        setSource(t, state)
        removeState(connector)
    }
}

function triggerVariable(state: CState, t: CTransition, about: string | undefined): CVar {
    const v = createVar(state.parent!.parent, '_Atrig', 'bool', 'trig')
    // Named for diagnostics (a causality cycle through the remembered trigger).
    v.display = `whether ${quoted(readableName(state)) ?? 'a state'}'s transition to ${quoted(readableName(t.target)) ?? 'another state'} was triggered`
    const entry = createEntryAction(state)
    entry.about = about
    entry.effects.push(assign(v, FALSE))
    return v
}

/** If the source state is initial without incoming transitions, the weak abort may be delayed. */
function canBeDelayed(s: CState): boolean {
    return s.initial && s.incoming.length === 0
}

/** KIELER searches the whole transition (trigger.eContainer) once it has a trigger. */
function containsDelayedTerm(t: CTransition): boolean {
    if (t.trigger === undefined) return false
    let found = false
    const visit = (e: CExpr) => { if (e.k === 'ref' && e.v.tags.has(ANNOTATION_TERMINATION_DELAYED)) found = true }
    walkExpr(t.trigger, visit)
    for (const f of t.effects) for (const e of effectExprs(f)) walkExpr(e, visit)
    return found
}

// KIELER's Termination transformation (sccharts/processors/Termination.xtend), used by Abort and
// ComplexFinalState: a termination (`join to`) becomes a weak abort whose trigger checks one `_Tterm` flag per
// region, set by the transitions into the region's final states (concurrency.md T-1..T-4).

import {
    allStates, and, assign, controlflowRegions, createEntryAction, createState, createTransitionTo, createVar,
    isImmediatelyReachable, isImplicitlyImmediate, readableName, readableRegionName, ref, setTarget, TRUE, FALSE, type CState, type CTransition,
    type CVar, type CRegion,
} from '../model'

export const ANNOTATION_TERMINATION = '_termination'
export const ANNOTATION_TERMINATION_DELAYED = '_termination_delayed'
export const ANNOTATION_FINALSTATE = '_finalstate'

export function transformTermination(state: CState) {
    const terminations = state.out.filter(t => t.preemption === 'termination')
    if (!terminations.length) return
    const termVars: CVar[] = []
    const about = state.origin ?? state.about
    for (const region of controlflowRegions(state)) {
        const term = createVar(state.parent!.parent, '_Tterm', 'bool', 'term')
        term.display = `whether ${readableRegionName(region) ? `region \`${region.name}\` of ` : 'a region of '}${readableName(state) ? `\`${readableName(state)}\`` : 'a superstate'} finished`
        const reset = createEntryAction(state)
        reset.about = about
        reset.effects.push(assign(term, FALSE))
        let delayed = true
        for (const f of region.states.filter(s => s.final)) {
            if (isImmediatelyReachable(f)) delayed = false
            const connectorCase = f.incoming.length > 1
            if (!connectorCase) {
                for (const t of f.incoming) t.effects.push(assign(term, TRUE))
            } else {
                const connector = createState(f.parent!, '_Tc')
                connector.connector = true
                connector.about = f.origin ?? f.about
                for (const t of [...f.incoming]) setTarget(t, connector)
                const ct = createTransitionTo(connector, f)
                ct.delay = 'immediate'
                ct.effects.push(assign(term, TRUE))
            }
            f.annotations.set(ANNOTATION_FINALSTATE, [])
        }
        if (delayed) term.tags.add(ANNOTATION_TERMINATION_DELAYED)
        termVars.push(term)
    }
    for (const t of terminations) {
        if (t.trigger === undefined && t.delay === 'delayed') t.trigger = TRUE
        t.delay = isImplicitlyImmediate(t) ? 'immediate' : 'undefined'
        t.preemption = 'weak'
        addTerminationCheck(t, termVars)
    }
}

export function addTerminationCheck(t: CTransition, termVars: CVar[]) {
    if (!termVars.length) return
    t.annotations.set(ANNOTATION_TERMINATION, termVars.map(v => v.name + '#' + v.uid))
    if (termVars.length > 1) {
        t.trigger = and([t.trigger, ...termVars.map(v => ref(v))])
    } else {
        t.trigger = t.trigger ? and([t.trigger, ref(termVars[0])]) : ref(termVars[0])
    }
}

/** Marks a region whose termination is signalled by `term` (setRegionTerm). */
export function setRegionTerm(region: CRegion, term: CVar) {
    region.annotations.set(ANNOTATION_TERMINATION, [term.name + '#' + term.uid])
}

export { allStates }

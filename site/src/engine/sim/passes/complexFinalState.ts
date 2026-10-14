// KIELER's Complex Final State processor (sccharts/processors/ComplexFinalState.xtend): final states with
// outgoing transitions (or during/exit actions, or inner states) stop being final; a `_CFSterm` flag per region
// records whether the region is in a final state, and the parent's terminations check the flags
// (basics.md B-19; concurrency.md T-2, T-8).

import type { Pass, PassContext } from './context'
import { addTerminationCheck, ANNOTATION_TERMINATION_DELAYED, setRegionTerm } from './termination'
import {
    actionsOf, addRegion, allContainedStates, allStates, assign, controlflowRegions, createControlflowRegion,
    createEntryAction, createFinalState, createImmediateTransitionTo, createInitialState, createVar, finalStates,
    isImmediatelyReachable, isImplicitlyImmediate, regionsMayTerminate, FALSE, TRUE, type CState, type CVar,
    readableName, readableRegionName,
} from '../model'

export const complexFinalState: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.complexFinalState',
    name: 'Complex Final State',
    owner: 'core',
    run(ctx: PassContext) {
        const parents = allStates(ctx.root).filter(s => s.regions.some(r => !r.dataflow && r.states.some(isComplexFinalState)))
        // CREATE_FINAL_REGIONS follows finalRegion.supported, which is false in the netlist chain.
        for (const parent of parents) transform(parent, ctx)
    },
}

export function isComplexFinalState(s: CState): boolean {
    return s.final && (s.out.length > 0 || actionsOf(s, 'during').length > 0 || actionsOf(s, 'exit').length > 0 || allContainedStates(s).length > 0)
}

function transform(parent: CState, ctx: PassContext) {
    const termVars: CVar[] = []
    let state = parent
    const about = parent.origin ?? parent.about

    if (!regionsMayTerminate(state)) {
        if (!ctx.config.finalRegions) {
            for (const r of controlflowRegions(state)) for (const cfs of finalStates(r).filter(isComplexFinalState)) cfs.final = false
        }
        return
    }

    if (parent.root) {
        const r = createControlflowRegion(parent, '_CFSMain')
        const i = createInitialState(r, '_CFSI')
        const f = createFinalState(r, '_CFSF')
        i.about = about
        f.about = about
        for (const main of parent.regions.filter(x => x !== r)) addRegion(i, main)
        createImmediateTransitionTo(i, f).preemption = 'termination'
        state = i
    }

    for (const region of controlflowRegions(state)) {
        const allFinal = region.states.length === region.states.filter(s => s.final).length
        const finals = region.states.filter(s => s.final && (s.incoming.length > 0 || s.initial))
        const complexFinals = finals.filter(isComplexFinalState)
        if (!allFinal) {
            const term = createVar(state.parent!.parent, '_CFSterm', 'bool', 'term')
            term.display = `whether ${readableRegionName(region) ? `region \`${region.name}\` of ` : 'a region of '}${readableName(state) ? `\`${readableName(state)}\`` : 'a superstate'} finished`
            if (!region.states.filter(s => s.final).some(isImmediatelyReachable)) term.tags.add(ANNOTATION_TERMINATION_DELAYED)
            const reset = createEntryAction(state)
            reset.about = about
            reset.effects.push(assign(term, FALSE))
            if (region.states.find(s => s.initial)?.final) term.init = TRUE
            termVars.push(term)
            if (!complexFinals.length) setRegionTerm(region, term)
            for (const f of finals) {
                for (const t of f.incoming.filter(t => !t.source.final)) t.effects.push(assign(term, TRUE))
                for (const t of f.out.filter(t => !t.target.final)) t.effects.push(assign(term, FALSE))
            }
        }
        for (const cfs of complexFinals) cfs.final = false
    }

    for (const t of state.out.filter(t => t.preemption === 'termination')) {
        t.delay = isImplicitlyImmediate(t) ? 'immediate' : 'undefined'
        t.preemption = 'weak'
        addTerminationCheck(t, termVars)
    }
}

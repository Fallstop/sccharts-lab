// KIELER's History processor (sccharts/processors/History.xtend), the first processor of the extended chain: a
// state M that is the target of a `history` (deep) or `shallow history` transition gets one int `_HM` per region
// (declared in the root, initially 0); every state of the region gets `entry do _HM = k` (k = 0 for the original
// initial state, then the others in order), and a new initial state `_HInit` dispatches with
// `immediate if _HM == k go to S_k`. Non-history transitions into M reset the records, shallow ones also reset the
// records of the states nested in M (preemption.md P-47..P-52).
//
// KIELER only looks at the states of the top-level regions, and recurses only into states that are history
// targets themselves (the dispatch of a deep history counts as a history transition into each inner state).
// Every other history transition is silently a normal one (P-51): reproduced, with a kieler-quirk info, and the
// tracker is told (the take mark's `history`).
//
// History is also the first preemption pass, so it runs the static checks for the preemption quirks (quirks.ts)
// on the chart before anything is rewritten.

import type { Pass, PassContext } from './context'
import { takeMarks } from './contained'
import { preemptionQuirks } from './quirks'
import {
    allTransitions, assign, controlflowRegions, controlflowRegionsContainStates, createEntryAction, createImmediateTransitionTo, createInitialState,
    createVar, initialState, lit, op, ref, type CRegion, type CState, type CTransition, type CVar,
} from '../model'

export const history: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.history',
    name: 'History',
    owner: 'preemption',
    run(ctx: PassContext) {
        preemptionQuirks(ctx)
        const written = allTransitions(ctx.root).filter(isHistory)
        const effective = new Map<CTransition, 'shallow' | 'deep'>()
        for (const t of written) effective.set(t, t.history as 'shallow' | 'deep')
        const processed = new Set<CTransition>()
        const root = ctx.root
        for (const region of controlflowRegions(root)) {
            for (const state of [...region.states]) transformHistory(state, root, processed)
        }
        for (const t of written) {
            const kind = effective.get(t)!
            for (const m of takeMarks(t)) m.history = processed.has(t) ? kind : 'reset'
            // History into a state without inner states changes nothing.
            if (processed.has(t) || !controlflowRegionsContainStates(t.target)) continue
            ctx.report({
                severity: 'info', code: 'kieler-quirk', span: t.span, related: [t.origin, t.target.origin].filter((x): x is string => !!x),
                message: `KIELER ignores this ${kind === 'shallow' ? 'shallow history' : 'history'}: \`${t.target.name}\` restarts from its initial state${controlflowRegions(t.target).length > 1 ? 's' : ''}`,
                hint: `KIELER only handles history on transitions into states of the chart's top-level regions, or inside a state that is itself the target of a history transition. Here \`${t.target.name}\` is nested in a state without one, so this transition behaves like a normal transition. Move the mode switch to the top level, or give the enclosing state a history transition too.`,
            })
        }
    },
}

const isHistory = (t: CTransition) => t.history === 'shallow' || t.history === 'deep'

/** History.transformHistory: returns the records of `state` and of the states nested in it. */
function transformHistory(state: CState, root: CState, processed: Set<CTransition>): CVar[] {
    const historyTransitions = state.incoming.filter(isHistory)
    const nonHistoryTransitions = state.incoming.filter(t => !isHistory(t))
    if (!historyTransitions.length) return []
    const about = state.origin ?? state.about

    const regions = controlflowRegions(state)
    const records = new Map<CRegion, CVar>()
    for (const r of regions) {
        const v = createVar(root, '_H' + state.name, 'int', 'history')
        v.display = `the history of \`${state.name}\``
        v.init = lit(0)
        records.set(r, v)
    }
    const tracked = (root.ext.historyRecords as Map<string, HistoryRecord> | undefined) ?? new Map<string, HistoryRecord>()
    root.ext.historyRecords = tracked
    // Entering without history forgets the record.
    for (const t of nonHistoryTransitions) {
        for (const v of records.values()) t.effects.push(assign(v, lit(0), { hidden: true, by: about }))
    }

    const deep = historyTransitions.some(t => t.history === 'deep')
    for (const r of regions) {
        const v = records.get(r)!
        const original = initialState(r)
        if (!original) continue
        original.initial = false
        const states = [original, ...r.states.filter(s => s !== original)]
        if (r.origin) tracked.set(r.origin, { v, states: states.map(s => s.origin) })
        const dispatcher = createInitialState(r, '_HInit')
        dispatcher.about = about
        states.forEach((s, k) => dispatch(dispatcher, s, v, k, deep, about))
    }

    const nested = new Set<CVar>()
    for (const r of regions) {
        for (const sub of [...r.states]) for (const v of transformHistory(sub, root, processed)) nested.add(v)
    }
    for (const v of nested) {
        for (const t of nonHistoryTransitions) t.effects.push(assign(v, lit(0), { hidden: true, by: about }))
        for (const t of historyTransitions.filter(t => t.history !== 'deep')) t.effects.push(assign(v, lit(0), { hidden: true, by: about }))
    }

    for (const t of historyTransitions) {
        processed.add(t)
        t.history = 'reset'
    }
    return [...records.values(), ...nested]
}

/**
 * KIELER's record of a source region (root.ext.historyRecords, by region id): the variable and the source state
 * each of its values resumes. The tracker reads it, so the source-level configuration resumes exactly what KIELER
 * resumes (a deferred entry, for example, does not update the record: Deferred removes the entry action).
 */
export interface HistoryRecord {
    v: CVar
    states: (string | undefined)[]
}

/** History.createDispatchingTransition. */
function dispatch(dispatcher: CState, target: CState, record: CVar, k: number, deep: boolean, about: string | undefined) {
    const t = createImmediateTransitionTo(dispatcher, target)
    t.about = about
    t.trigger = op('==', ref(record), lit(k))
    const entry = createEntryAction(target)
    entry.about = about
    entry.effects.push(assign(record, lit(k), { hidden: true, by: about }))
    if (deep) t.history = 'deep'
}

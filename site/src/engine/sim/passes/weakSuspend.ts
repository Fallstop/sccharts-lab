// KIELER's Weak Suspend processor (sccharts/processors/WeakSuspend.xtend): in a tick in which `weak suspend if c`
// of state S holds, S's inside reacts normally, but every region inside S (at any depth) is put back into the
// state it was in at the end of the last tick without weak suspension, quietly (preemption.md P-46).
//
// S gets a flag `_wsFlag` (initially false; `[immediate] during do _wsFlag = c` per weak suspend). Every region
// inside S gets a bookmark `_<parent>` (initially 0), set by an entry action of each of its states when the flag
// is off; a state `_WS`, reached from every state by a lowest-priority `immediate if _wsFlag`, from which
// `immediate if _<parent> == k` goes back to the bookmarked state as a shallow deferred transition (rewritten
// by Deferred, next); and a new initial state `_Init` that goes straight to `_WS` when the region was weakly
// suspended in this tick already (`_lastWishDone`), else to the original initial state. Exit actions of the
// inner states move onto extra states on their outgoing transitions, so the way back to `_WS` skips them. A state
// that can terminate gets a region `_wsAuxTermination` that is final only while not weakly suspended.
//
// The way back to a bookmark carries a `resume` mark, so the tracker (source-level configuration) rewinds too. A
// weak suspend without trigger is rejected (official KIELER fails in its SCG transformation, P-45).

import type { Pass, PassContext } from './context'
import { addMark, allContainedControlflowRegions, and2, copyAction, not } from './contained'
import { registerSuspend } from './suspend'
import {
    actionsOf, allStates, assign, copyExpr, createAction, createControlflowRegion, createEntryAction, createFinalState,
    createImmediateTransitionTo, createInitialState, createState, createTransitionTo, createVar, isImmediate, lit, op,
    ref, regionsMayTerminate, removeAction, setLowestPriority, setTarget, FALSE, TRUE, type CState,
} from '../model'

export const weakSuspend: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.weakSuspend',
    name: 'Weak Suspend',
    owner: 'preemption',
    run(ctx: PassContext) {
        for (const state of allStates(ctx.root)) transformWeakSuspend(state, ctx)
    },
}

function transformWeakSuspend(state: CState, ctx: PassContext) {
    const weakSuspends = state.actions.filter(a => a.kind === 'suspend' && a.weak)
    if (!weakSuspends.length) return
    const about = state.origin ?? state.about
    const o = { hidden: true, by: about }

    const flag = createVar(state, '_wsFlag', 'bool', 'wsFlag')
    flag.display = `\`${state.name}\` is weakly suspended`
    flag.init = FALSE
    registerSuspend(ctx, state, flag, true)

    for (const ws of weakSuspends) {
        const during = createAction(state, 'during')
        during.delay = isImmediate(ws) ? 'immediate' : 'undefined'
        during.about = ws.origin ?? about
        if (ws.trigger === undefined) {
            ctx.report({
                severity: 'error', code: 'suspend-without-trigger', span: ws.span, related: ws.origin ? [ws.origin] : about ? [about] : undefined,
                message: `This weak suspend has no condition, so it is not clear when \`${state.name}\` should be suspended`,
                hint: 'Write the condition after if, for example `weak suspend if Hold`. KIELER cannot compile a weak suspend without one.',
                kieler: 'This weak suspend has no trigger. KIELER cannot compile a weak suspend without an if condition.',
            })
        } else {
            during.effects.push(assign(flag, copyExpr(ws.trigger), { hidden: true, by: ws.origin ?? about }))
        }
        removeAction(state, ws)
    }

    for (const region of allContainedControlflowRegions(state)) {
        const subStates = [...region.states]
        const wsState = createState(region, '_WS')
        wsState.about = about
        const bookmark = createVar(state, '_' + region.parent.name, 'int', 'bookmark')
        bookmark.display = `the state \`${region.parent.name}\` returns to`
        bookmark.init = lit(0)

        const lastWishDone = createVar(state, '_lastWishDone', 'bool', 'lastWish')
        // Reset in every tick.
        const reset = createAction(state, 'during')
        reset.delay = 'immediate'
        reset.about = about
        reset.effects.push(assign(lastWishDone, FALSE, o))
        // _WS sets it.
        const wsEntry = createEntryAction(wsState)
        wsEntry.about = about
        wsEntry.effects.push(assign(lastWishDone, TRUE, o, '|='))

        // Auxiliary initial state for re-entry.
        const initState = createState(region, '_Init')
        initState.about = about
        initState.initial = true
        const initWS = createImmediateTransitionTo(initState, wsState)
        initWS.about = about
        initWS.trigger = and2(ref(flag), ref(lastWishDone))

        let counter = 0
        for (const sub of subStates) {
            const exits = actionsOf(sub, 'exit')
            if (exits.length) {
                // Exit actions become states on the outgoing transitions, so that going to _WS skips them.
                for (const t of [...sub.out]) {
                    const exitState = createState(sub.parent!, '__exit')
                    exitState.about = sub.origin ?? sub.about
                    for (const a of exits) exitState.actions.push(copyAction(a, ctx))
                    const exitTransition = createTransitionTo(exitState, t.target)
                    exitTransition.about = t.origin ?? t.about
                    exitTransition.history = t.history
                    exitTransition.deferred = t.deferred
                    exitTransition.delay = 'immediate'
                    exitTransition.preemption = t.preemption
                    exitTransition.effects.push(...t.effects)
                    t.effects = []
                    t.history = 'reset'
                    t.deferred = undefined
                    setTarget(t, exitState)
                }
                for (const a of exits) removeAction(sub, a)
            }
            const reEnter = createImmediateTransitionTo(wsState, sub)
            reEnter.about = about
            reEnter.trigger = op('==', ref(bookmark), lit(counter))
            reEnter.deferred = 'shallow'
            if (sub.origin && about) addMark(reEnter, { kind: 'resume', state: sub.origin, suspended: about })

            const entry = createEntryAction(sub)
            entry.about = about
            entry.effects.push(assign(bookmark, lit(counter), o))
            entry.trigger = not(ref(flag))
            counter++

            // Only if not a final state, or a final state directly inside the weakly suspended state.
            if (!sub.final || sub.parent!.parent === state) {
                const toWS = createImmediateTransitionTo(sub, wsState)
                toWS.about = about
                toWS.trigger = ref(flag)
                setLowestPriority(toWS)
            }
            if (sub.initial) {
                sub.initial = false
                createImmediateTransitionTo(initState, sub).about = about
            }
        }
    }

    // A state that can terminate only terminates in a tick without weak suspension.
    const needAuxTermRegion = (state.out.some(t => t.preemption === 'termination') || state.root) && regionsMayTerminate(state)
    if (needAuxTermRegion) {
        const aux = createControlflowRegion(state, '_wsAuxTermination')
        aux.about = about
        const noTerm = createInitialState(aux, '_wsNoTerm')
        const term = createFinalState(aux, '_wsTerm')
        noTerm.about = about
        term.about = about
        const t1 = createImmediateTransitionTo(noTerm, term)
        t1.trigger = not(ref(flag))
        t1.about = about
        const t2 = createTransitionTo(term, noTerm)
        t2.trigger = ref(flag)
        t2.about = about
    }
}

// KIELER's Deferred processor (sccharts/processors/Deferred.xtend): a state S entered by `go to S deferred`
// (shallow) or `deep deferred` must show none of its immediate behaviour in the entry tick (preemption.md
// P-53..P-56). KIELER picks one of three rewritings per target state, statically:
//
// - simple delay (all incoming transitions deferred of one kind, no immediate loop): the transitions go to a new
//   state `_deferred_entry` with a delayed transition into S; S's delayed transitions and during actions become
//   immediate, its entry actions are removed (or, if S is initial, guarded by `_deferred_initial`, true only in
//   tick 1). For a superstate this really enters S one tick late, so its inner timing shifts (P-54 a).
// - simple guard (no deferred transition on an immediate loop): S's immediate transitions, entry actions and
//   immediate during actions get `!_deferred_shallow` (`!_deferred_deep` for the inner initial states of a deep
//   deferred entry), a flag the deferred transitions set and a delayed during action of S clears (P-54 b).
// - complex: S is copied (`_deferred_S`) with delayed outgoing transitions and without entry actions, and the
//   deferred transitions enter the copy (S's variables move to its parent region first). Weak suspend's quiet
//   re-entries (weakSuspend.ts) end up here.
//
// Entry actions tagged DoNotDefer (the count delay's counter reset) are kept. Inner states are rewritten before
// their parents, and states are visited again afterwards for the deferred transitions a rewriting creates.

import type { Pass, PassContext } from './context'
import { addMark, allContainedControlflowRegions, and2, copyState, copyTransitionFields, initialStates, isDoNotDefer, not, takeMarks } from './contained'
import {
    actionsOf, addVar, allContainedStates, allStates, assign, controlflowRegionsContainStates, createAction, createState, createTransitionTo, createVar,
    CTransition, CVar, FALSE, ref, removeAction, removeState, setSource, setTarget, TRUE, type CAction, type CRegion,
    type CState,
} from '../model'

export const deferred: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.deferred',
    name: 'Deferred',
    owner: 'preemption',
    run(ctx: PassContext) {
        if (!allStates(ctx.root).some(s => s.incoming.some(t => t.deferred !== undefined))) return
        transform(ctx.root, ctx)
    },
}

/** A state of the subtree has an incoming deferred transition (else a visit of it changes nothing). */
function subtreeDeferred(state: CState): boolean {
    return allStates(state).some(s => s.incoming.some(t => t.deferred !== undefined))
}

/** Deferred.transform(State): inner states first, then the state, then the inner states again. */
function transform(state: CState, ctx: PassContext) {
    if (!subtreeDeferred(state)) return
    for (const s of allContainedStates(state)) transform(s, ctx)
    if (needTransform(state, ctx)) {
        if (isSimpleDelayTransformable(state)) transformSimpleDelay(state, ctx)
        else if (isSimpleGuardTransformable(state)) transformSimpleGuard(state, ctx)
        else transformComplex(state, ctx)
    } else {
        for (const t of state.incoming) if (t.deferred !== undefined) t.deferred = undefined
    }
    for (const s of allContainedStates(state)) transform(s, ctx)
}

const entryActions = (s: CState, ctx: PassContext): CAction[] => actionsOf(s, 'entry').filter(a => !isDoNotDefer(ctx, a))
const explicitlyImmediate = (x: CTransition | CAction) => x.delay === 'immediate'

/** Deferred.hasInstantaneousBehavior (deep: also the inner initial states', at any depth). */
function hasInstantaneousBehavior(s: CState, deep: boolean, ctx: PassContext): boolean {
    if (s.out.some(explicitlyImmediate)) return true
    if (entryActions(s, ctx).length) return true
    if (actionsOf(s, 'during').some(explicitlyImmediate)) return true
    if (deep) {
        for (const region of allContainedControlflowRegions(s)) {
            for (const inner of region.states.filter(x => x.initial)) if (hasInstantaneousBehavior(inner, deep, ctx)) return true
        }
    }
    return false
}

function needTransform(s: CState, ctx: PassContext): boolean {
    return s.incoming.some(t => t.deferred !== undefined && hasInstantaneousBehavior(s, t.deferred === 'deep', ctx))
}

/** Deferred.findImmediateLoop: can control come back to `t` through explicitly immediate transitions? */
function findImmediateLoop(t: CTransition, canBeDelayed: boolean): boolean {
    const visited: CTransition[] = []
    const next: CTransition[] = [t]
    while (next.length) {
        const n = next.shift()!
        visited.push(n)
        for (const transition of n.target.out) {
            if (canBeDelayed && transition === t) return true
            if (transition.delay === 'immediate') {
                if (transition === t) return true
                if (!visited.includes(transition) && !next.includes(transition)) next.push(transition)
            }
        }
    }
    return false
}

/** The state and, for a deep deferred entry, its inner initial states, recursively (handleBehavior). */
function behaviourStates(state: CState, deep: boolean): CState[] {
    const out = [state]
    if (deep) for (let i = 0; i < out.length; i++) out.push(...initialStates(out[i]))
    return out
}

// ---------------------------------------------------------------------------------------------------
// Simple delay
// ---------------------------------------------------------------------------------------------------

function isSimpleDelayTransformable(state: CState): boolean {
    const onlyDeep = state.incoming.every(t => t.deferred === 'deep')
    const onlyShallow = state.incoming.every(t => t.deferred === 'shallow')
    for (const s of behaviourStates(state, onlyDeep)) {
        for (const t of s.out) if (t.target === s || findImmediateLoop(t, true)) return false
    }
    return onlyDeep || onlyShallow
}

function transformSimpleDelay(state: CState, ctx: PassContext) {
    const deep = state.incoming.every(t => t.deferred === 'deep')
    const handle = behaviourStates(state, deep)
    const about = state.origin ?? state.about
    if (controlflowRegionsContainStates(state) && state.origin) {
        const first = state.incoming.find(t => t.origin)
        ctx.report({
            severity: 'info', code: 'kieler-quirk', span: first?.span, related: [state.origin, ...state.incoming.flatMap(t => (t.origin ? [t.origin] : []))],
            message: `KIELER enters \`${state.name}\` one tick late here: its inner states start in the tick after the deferred transition, so everything inside \`${state.name}\` happens a tick later than after a normal entry`,
            hint: `Because every transition into \`${state.name}\` is ${deep ? 'deep deferred' : 'deferred'}, KIELER replaces the entry by an extra state and a delayed transition. If \`${state.name}\` also had a normal incoming transition, its inner states would start in the deferred tick itself.`,
        })
    }

    const delayedEntry = createState(state.parent!, '_deferred_entry')
    delayedEntry.about = about
    for (const t of [...state.incoming]) {
        setTarget(t, delayedEntry)
        t.deferred = undefined
        // The source-level entry happens now, the entry of the regions in the next tick (enterRegions below).
        for (const m of takeMarks(t)) m.deferEntry = true
    }
    const entryTransition = createTransitionTo(delayedEntry, state)
    entryTransition.about = about
    if (state.origin) addMark(entryTransition, { kind: 'enterRegions', state: state.origin })

    let initialVariable: CVar | undefined
    if (state.initial) {
        // Initial: keep the entry actions for tick 1, tell the initial entry from a deferred one.
        const parent = state.parent!.parent
        initialVariable = createVar(parent, '_deferred_initial', 'bool', 'deferred')
        initialVariable.display = `\`${state.name}\` was entered in the first tick`
        initialVariable.init = TRUE
        const reset = createAction(parent, 'during')
        reset.about = about
        reset.effects.push(assign(initialVariable, FALSE, { hidden: true, by: about }))
        entryTransition.effects.push(assign(initialVariable, FALSE, { hidden: true, by: about }))
    }
    const notInitial = () => not(ref(initialVariable!))
    for (const s of handle) {
        for (const t of s.out) {
            if (t.delay === 'immediate') continue
            t.delay = 'immediate'
            if (state.initial) t.trigger = t.trigger === undefined ? notInitial() : and2(notInitial(), t.trigger)
        }
        for (const a of actionsOf(s, 'during').filter(a => a.delay !== 'immediate')) {
            a.delay = 'immediate'
            if (state.initial) a.trigger = a.trigger === undefined ? notInitial() : and2(notInitial(), a.trigger)
        }
        if (state.initial) {
            for (const a of entryActions(s, ctx)) a.trigger = a.trigger === undefined ? ref(initialVariable!) : and2(ref(initialVariable!), a.trigger)
        } else {
            for (const a of entryActions(s, ctx)) removeAction(s, a)
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// Simple guard
// ---------------------------------------------------------------------------------------------------

function isSimpleGuardTransformable(s: CState): boolean {
    let hasDeepDeferred = false
    for (const t of s.incoming) {
        if (t.deferred === 'deep') hasDeepDeferred = true
        if (t.deferred !== undefined && findImmediateLoop(t, false)) return false
    }
    if (hasDeepDeferred) {
        for (const region of allContainedControlflowRegions(s)) {
            for (const inner of region.states.filter(x => x.initial)) {
                if (inner.out.filter(explicitlyImmediate).some(t => findImmediateLoop(t, false))) return false
            }
        }
    }
    return true
}

function transformSimpleGuard(state: CState, ctx: PassContext) {
    const shallowIn = state.incoming.filter(t => t.deferred === 'shallow')
    const deepIn = state.incoming.filter(t => t.deferred === 'deep')
    const plainIn = state.incoming.filter(t => t.deferred === undefined)
    const about = state.origin ?? state.about

    // Created now, declared only if used (KIELER's createValuedObject without a container).
    const flags = { shallow: makeFlag('_deferred_shallow', state), deep: makeFlag('_deferred_deep', state) }
    const used = new Set<CVar>()
    const guard = (x: CTransition | CAction, v: CVar) => {
        x.trigger = x.trigger === undefined ? not(ref(v)) : and2(not(ref(v)), x.trigger)
        used.add(v)
    }
    for (const s of behaviourStates(state, deepIn.length > 0)) {
        const v = s === state ? flags.shallow : flags.deep
        for (const t of s.out) if (explicitlyImmediate(t)) guard(t, v)
        for (const a of entryActions(s, ctx)) guard(a, v)
        for (const a of actionsOf(s, 'during').filter(explicitlyImmediate)) guard(a, v)
    }

    const declared: CVar[] = []
    for (const v of [flags.shallow, flags.deep]) {
        if (!used.has(v)) continue
        addVar(state.parent!.parent, v)
        v.init = FALSE
        const reset = createAction(state, 'during')
        reset.about = about
        reset.effects.push(assign(v, FALSE, { hidden: true, by: about }))
        declared.push(v)
    }
    const has = (v: CVar) => declared.includes(v)
    for (const t of shallowIn) {
        t.deferred = undefined
        if (has(flags.shallow)) t.effects.push(assign(flags.shallow, TRUE, { hidden: true, by: about }))
    }
    for (const t of deepIn) {
        t.deferred = undefined
        if (has(flags.shallow)) t.effects.push(assign(flags.shallow, TRUE, { hidden: true, by: about }))
        if (has(flags.deep)) t.effects.push(assign(flags.deep, TRUE, { hidden: true, by: about }))
    }
    // The others clear them explicitly (in case the superstate was strongly aborted immediately).
    for (const t of plainIn) {
        if (has(flags.shallow)) t.effects.push(assign(flags.shallow, FALSE, { hidden: true, by: about }))
        if (has(flags.deep)) t.effects.push(assign(flags.deep, FALSE, { hidden: true, by: about }))
    }
}

/** A generated bool that is not declared anywhere yet (declared by addVar once it is used). */
function makeFlag(name: string, state: CState): CVar {
    const v = new CVar(name, 'bool')
    v.generated = true
    v.role = 'deferred'
    v.display = `\`${state.name}\` was entered by a deferred transition`
    return v
}

// ---------------------------------------------------------------------------------------------------
// Complex: a copy of the state
// ---------------------------------------------------------------------------------------------------

function transformComplex(s: CState, ctx: PassContext) {
    const region = s.parent!
    makeVariablesPublic(s, region)
    for (const kind of ['shallow', 'deep'] as const) {
        if (!s.incoming.some(t => t.deferred === kind)) continue
        const copy = copyState(s, ctx)
        copy.name = '_deferred_' + s.name
        copy.parent = region
        region.states.push(copy)
        for (const t of s.out) {
            const c = new CTransition()
            copyTransitionFields(t, c)
            setTarget(c, t.target)
            setSource(c, copy)
            c.delay = 'delayed'
        }
        for (const t of [...s.incoming]) {
            if (t.deferred !== kind) continue
            t.deferred = undefined
            setTarget(t, copy)
        }
        for (const a of entryActions(copy, ctx)) removeAction(copy, a)
        for (const a of actionsOf(copy, 'during')) a.delay = 'delayed'
        if (kind === 'deep') {
            for (const sub of allContainedControlflowRegions(copy)) {
                if (!sub.states.length) continue
                for (const inner of sub.states.filter(x => x.initial)) {
                    if (!hasInstantaneousBehavior(inner, true, ctx)) continue
                    const fresh = createState(sub, '_deferred_' + inner.name)
                    fresh.about = inner.origin ?? inner.about
                    fresh.initial = true
                    inner.initial = false
                    const t = createTransitionTo(fresh, inner)
                    t.about = fresh.about
                    t.delay = 'immediate'
                    t.deferred = 'deep'
                }
            }
        }
        // Clean up (EcoreUtil.remove: the state's transitions stay attached to it, as in EMF).
        if (!s.initial && s.incoming.length === 0) {
            removeState(s)
            return
        }
    }
}

/** Deferred.makeVariablesPublic: the declarations of the state and everything inside move to its parent region. */
function makeVariablesPublic(s: CState, parent: CRegion) {
    const move = (from: CState | CRegion) => {
        while (from.decls.length) addVar(parent, from.decls[0])
    }
    move(s)
    for (const inner of allContainedStates(s)) makeVariablesPublic(inner, parent)
    for (const r of allRegionsInside(s)) if (r.dataflow) move(r)
    for (const r of allContainedControlflowRegions(s)) move(r)
}

function allRegionsInside(s: CState): CRegion[] {
    const out: CRegion[] = []
    const visit = (x: CState) => {
        for (const r of x.regions) {
            out.push(r)
            for (const c of r.states) visit(c)
        }
    }
    visit(s)
    return out
}


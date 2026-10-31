// Helpers shared by the preemption passes (History, Suspend, Count Delay, Weak Suspend, Deferred, Final Region):
// KIELER's iteration orders over the EMF containment tree, its `and`/`not` builders, deep copies of states
// (EcoreUtil.copy), and the bookkeeping the passes leave for the executor (tracker hooks, KIELER's
// `DoNotDefer` annotation).

import {
    CAction, CRegion, CState, CTransition, controlflowRegions, copyEffect, copyExpr, setSource, setTarget,
    type CExpr, type Mark,
} from '../model'
import type { PassContext } from './context'

/**
 * eAllContents order of the transitions inside a state: for every state, the contents of its regions first,
 * then its own outgoing transitions (State's `regions` feature comes before `outgoingTransitions`).
 * `self`: include the state's own outgoing transitions.
 */
export function containedTransitions(state: CState, self = true): CTransition[] {
    const out: CTransition[] = []
    const visit = (s: CState, own: boolean) => {
        for (const r of s.regions) for (const c of r.states) visit(c, true)
        if (own) out.push(...s.out)
    }
    visit(state, self)
    return out
}

/**
 * SCChartsScopeExtensions.getAllContainedActions: every action (local actions and transitions, which are actions
 * too) contained in a state, its own local actions and outgoing transitions included.
 */
export function containedActions(state: CState): (CAction | CTransition)[] {
    const out: (CAction | CTransition)[] = []
    const visitState = (s: CState) => {
        out.push(...s.actions)
        for (const r of s.regions) visitRegion(r)
        out.push(...s.out)
    }
    const visitRegion = (r: CRegion) => {
        out.push(...r.actions)
        for (const c of r.states) visitState(c)
    }
    visitState(state)
    return out
}

/** sccAllControlflowRegions(State): every control-flow region inside a state, at any depth, in pre-order. */
export function allContainedControlflowRegions(state: CState): CRegion[] {
    const out: CRegion[] = []
    const visit = (r: CRegion) => {
        out.push(r)
        for (const s of r.states) for (const c of controlflowRegions(s)) visit(c)
    }
    for (const r of controlflowRegions(state)) visit(r)
    return out
}

/** SCChartsStateExtensions.getInitialStates: the initial state of each control-flow region of a state. */
export function initialStates(state: CState): CState[] {
    const out: CState[] = []
    for (const r of controlflowRegions(state)) {
        const i = r.states.find(s => s.initial)
        if (i) out.push(i)
    }
    return out
}

/** KExpressionsComplexCreateExtensions.and(first, second): `second` alone if there is no first. */
export function and2(first: CExpr | undefined, second: CExpr): CExpr {
    if (first === undefined) return second
    return { k: 'op', op: '&&', args: [first, second] }
}

export function not(e: CExpr): CExpr {
    return { k: 'op', op: '!', args: [e] }
}

// ---------------------------------------------------------------------------------------------------
// DoNotDefer (Deferred.DO_NOT_DEFER): entry actions that Deferred must keep (the count delay's counter reset)
// ---------------------------------------------------------------------------------------------------

function doNotDeferSet(ctx: PassContext): WeakSet<CAction> {
    let set = ctx.shared.doNotDefer as WeakSet<CAction> | undefined
    if (!set) ctx.shared.doNotDefer = set = new WeakSet<CAction>()
    return set
}

export function markDoNotDefer(ctx: PassContext, a: CAction) {
    doNotDeferSet(ctx).add(a)
}

export function isDoNotDefer(ctx: PassContext, a: CAction): boolean {
    return doNotDeferSet(ctx).has(a)
}

// ---------------------------------------------------------------------------------------------------
// Copies (EcoreUtil.copy of a state: its whole containment tree, references inside the copy point to the copies)
// ---------------------------------------------------------------------------------------------------

export function copyAction(a: CAction, ctx?: PassContext): CAction {
    const c = new CAction(a.kind)
    c.delay = a.delay
    c.preemption = a.preemption
    c.weak = a.weak
    c.triggerDelay = a.triggerDelay
    c.trigger = copyExpr(a.trigger)
    c.effects = a.effects.map(copyEffect)
    c.origin = a.origin
    c.about = a.about
    c.span = a.span
    if (ctx && isDoNotDefer(ctx, a)) markDoNotDefer(ctx, c)
    return c
}

export function copyTransitionFields(from: CTransition, to: CTransition) {
    to.delay = from.delay
    to.preemption = from.preemption
    to.trigger = copyExpr(from.trigger)
    to.effects = from.effects.map(copyEffect)
    to.triggerDelay = from.triggerDelay
    to.history = from.history
    to.deferred = from.deferred
    to.origin = from.origin
    to.about = from.about
    to.checks = from.checks
    to.span = from.span
    to.annotations = new Map([...from.annotations].map(([k, v]) => [k, [...v]]))
}

/**
 * Deep copy of a state with its regions, inner states, actions and inner transitions; the state's own outgoing
 * transitions are not copied (KIELER's callers clear them), nor are declarations (the caller moves them out first,
 * Deferred.makeVariablesPublic, so the copy's expressions refer to the same variables, as in KIELER). The copy keeps
 * `origin`: it is the same state of the chart as written.
 */
export function copyState(s: CState, ctx: PassContext): CState {
    const map = new Map<CState, CState>()
    const pending: [CTransition, CState][] = []
    const copyS = (x: CState, own: boolean): CState => {
        const c = new CState(x.name)
        map.set(x, c)
        c.label = x.label
        c.initial = x.initial
        c.final = x.final
        c.connector = x.connector
        c.violation = x.violation
        c.root = x.root
        // EcoreUtil.copy would copy the declarations too; Deferred, the only caller, has moved them out already.
        c.decls = []
        c.actions = x.actions.map(a => copyAction(a, ctx))
        c.origin = x.origin
        c.about = x.about
        c.annotations = new Map([...x.annotations].map(([k, v]) => [k, [...v]]))
        c.ext = { ...x.ext }
        for (const r of x.regions) {
            const cr = new CRegion()
            cr.name = r.name
            cr.label = r.label
            cr.parent = c
            cr.decls = []
            cr.actions = r.actions.map(a => copyAction(a, ctx))
            cr.origin = r.origin
            cr.about = r.about
            cr.dataflow = r.dataflow
            cr.final = r.final
            cr.abort = r.abort
            cr.override = r.override
            cr.annotations = new Map([...r.annotations].map(([k, v]) => [k, [...v]]))
            cr.ext = { ...r.ext }
            c.regions.push(cr)
            for (const inner of r.states) {
                const ci = copyS(inner, true)
                ci.parent = cr
                cr.states.push(ci)
            }
        }
        if (own) for (const t of x.out) pending.push([t, c])
        return c
    }
    const copy = copyS(s, false)
    for (const [t, source] of pending) {
        const c = new CTransition()
        copyTransitionFields(t, c)
        setTarget(c, map.get(t.target) ?? t.target)
        setSource(c, source)
    }
    return copy
}

// ---------------------------------------------------------------------------------------------------
// Tracker hooks: bookkeeping marks for the source-level configuration (tracker.ts)
// ---------------------------------------------------------------------------------------------------

/** Adds a bookkeeping mark (no KIELER effect) as the first effect of a generated transition. */
export function addMark(t: CTransition, m: Mark) {
    t.effects.unshift({ k: 'mark', m, o: { hidden: true } })
}

/** The Taken Transition Signaling marks of a transition (a source transition has one, moved copies too). */
export function takeMarks(t: CTransition): Extract<Mark, { kind: 'take' }>[] {
    const out: Extract<Mark, { kind: 'take' }>[] = []
    for (const f of t.effects) if (f.k === 'mark' && f.m.kind === 'take') out.push(f.m)
    return out
}

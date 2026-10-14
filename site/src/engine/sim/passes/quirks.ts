// Static checks for KIELER's preemption quirks (preemption.md), run on the chart before the preemption passes
// rewrite it (from history.ts, the first of them). Each finding is an info diagnostic with code `kieler-quirk`:
// the guide's simulator reproduces the behaviour (it falls out of KIELER's transformations), and the diagnostic
// tells the reader where a chart can show it and how to avoid it. Only patterns that can actually make a
// difference are reported.

import type { Diagnostic } from '../../types'
import type { PassContext } from './context'
import { containedActions } from './contained'
import {
    actionsOf, allStates, CAction, canImmediateTerminate, controlflowRegionsContainStates, isImplicitlyImmediate, walkExpr, type CEffect,
    type CExpr, type CState, type CTransition, type CVar,
} from '../model'

export function preemptionQuirks(ctx: PassContext) {
    for (const state of allStates(ctx.root)) {
        strongAbortWrittenInside(state, ctx)
        exitRewritesTrigger(state, ctx)
        weakExitOnSuperstate(state, ctx)
        suspendQuirks(state, ctx)
        for (const t of state.out) immediateCountDelay(t, ctx)
    }
}

const name = (v: CVar) => v.display ?? v.name

function reads(e: CExpr | undefined): Set<CVar> {
    const out = new Set<CVar>()
    walkExpr(e, x => { if (x.k === 'ref') out.add(x.v) })
    return out
}

function writesOf(effects: CEffect[]): Set<CVar> {
    const out = new Set<CVar>()
    for (const f of effects) if (f.k === 'assign' || f.k === 'emit') out.add(f.ref.v)
    return out
}

/** Every variable the inside of a state writes (its regions' transitions and actions, its own during actions). */
function insideWrites(state: CState): Set<CVar> {
    const out = new Set<CVar>()
    for (const a of containedActions(state)) {
        if (a instanceof CAction) {
            // The state's own entry and exit actions are not inner behaviour.
            if (state.actions.includes(a) && a.kind !== 'during') continue
        } else if (a.source === state) {
            continue
        }
        for (const v of writesOf(a.effects)) out.add(v)
    }
    return out
}

function report(ctx: PassContext, d: Omit<Diagnostic, 'severity' | 'code'>) {
    ctx.report({ severity: 'info', code: 'kieler-quirk', ...d })
}

const ids = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x)

/** P-20: a strong abort whose trigger the aborted state writes is checked region by region. */
function strongAbortWrittenInside(state: CState, ctx: PassContext) {
    const strong = state.out.filter(t => t.preemption === 'strong')
    if (!strong.length || !controlflowRegionsContainStates(state)) return
    // With one inner region this is the normal timing of a strong abort (it reads the value from before the inside
    // reacted, P-19); the quirk needs several concurrent inner regions (during actions are regions too).
    const threads = state.regions.filter(r => !r.dataflow && r.states.length > 0).length + actionsOf(state, 'during').length
    if (threads < 2) return
    const written = insideWrites(state)
    for (const t of strong) {
        const shared = [...reads(t.trigger)].filter(v => written.has(v))
        if (!shared.length) continue
        const v = name(shared[0])
        report(ctx, {
            span: t.span, related: ids(t.origin, state.origin),
            message: `This strong abort reads \`${v}\`, which the inside of \`${state.name}\` writes: in a tick in which \`${v}\` changes, some inner regions can be aborted while others still react`,
            hint: `KIELER checks a strong abort separately in each inner region, before that region reacts, so a region that writes \`${v}\` has already read the old value. Use a weak abort (\`go to\`) or a termination (\`join to\`) for conditions computed inside \`${state.name}\`.`,
        })
    }
}

/** P-23: exit actions that change what the state's outgoing triggers read can change the transition taken. */
function exitRewritesTrigger(state: CState, ctx: PassContext) {
    if (state.out.length < 2 || state.root) return
    const exits = [state, ...allStates(state, false)].flatMap(s => actionsOf(s, 'exit'))
    if (!exits.length) return
    const written = writesOf(exits.flatMap(a => a.effects))
    for (const t of state.out) {
        const shared = [...reads(t.trigger)].filter(v => written.has(v))
        if (!shared.length) continue
        const v = name(shared[0])
        const superstate = controlflowRegionsContainStates(state) || actionsOf(state, 'during').length > 0
        report(ctx, {
            span: t.span, related: ids(t.origin, state.origin, exits[0].origin),
            message: superstate
                ? `An exit action writes ${v}, which this transition's trigger reads: KIELER may decide which transition leaves ${state.name} only after the exit actions ran`
                : `An exit action writes ${v}, which this transition's trigger reads`,
            hint: superstate
                ? `When a superstate is left, KIELER runs the exit actions first and then picks the transition again: an abort whose trigger the exits made false is skipped, and the last transition is taken without checking its trigger. Let exit actions write only what the outgoing triggers do not read.`
                : `For a simple state KIELER chooses the transition before the exit actions run, so the exit action does not change which transition is taken; it is still clearer to keep them apart.`,
        })
    }
}

/** P-12: `weak exit` on a superstate runs only when it terminates (join to), not on aborts. */
function weakExitOnSuperstate(state: CState, ctx: PassContext) {
    if (!controlflowRegionsContainStates(state)) return
    const weak = actionsOf(state, 'exit').filter(a => a.preemption === 'weak')
    if (!weak.length || !state.out.some(t => t.preemption !== 'termination')) return
    report(ctx, {
        span: weak[0].span, related: ids(weak[0].origin, state.origin),
        message: `This weak exit only runs when \`${state.name}\` finishes through \`join to\`, not when it is left by \`go to\` or \`abort to\``,
        hint: 'On a superstate, KIELER expands weak exit actions before the aborts, so both kinds of abort bypass them. Use a plain exit action to run something however the state is left.',
    })
}

/** P-30: an immediate count delay can complete at once on re-entry (pre(counter) is last visit's count). */
function immediateCountDelay(t: CTransition, ctx: PassContext) {
    if (t.triggerDelay === undefined || t.triggerDelay <= 1 || !isImplicitlyImmediate(t)) return
    const s = t.source
    // Only a state that can be entered again.
    if (!s.incoming.length && !(s.initial && !s.parent?.parent.root)) return
    report(ctx, {
        span: t.span, related: ids(t.origin, s.origin),
        message: `KIELER's immediate count can complete as soon as \`${s.name}\` is entered again, if \`${s.name}\` was left one count short, however long ago`,
        hint: `KIELER implements \`immediate if ${t.triggerDelay} ...\` with a counter that restarts on entry, but compares the counter's previous value, which is still the old visit's in the tick after a re-entry. A delayed count (without immediate) does not have this problem.`,
    })
}

/** P-38, P-42, P-43, P-44: what a `suspend` changes beyond freezing the inside. */
function suspendQuirks(state: CState, ctx: PassContext) {
    const suspends = state.actions.filter(a => a.kind === 'suspend' && !a.weak)
    if (!suspends.length) return
    const s0 = suspends[0]
    const entries = actionsOf(state, 'entry')
    if (entries.length) {
        report(ctx, {
            span: entries[0].span, related: ids(entries[0].origin, s0.origin, state.origin),
            message: state.root
                ? 'Because the chart has a suspend, KIELER never runs its entry actions'
                : `Because \`${state.name}\` has a suspend, KIELER skips its entry actions when \`${state.name}\` is entered for the first time`,
            hint: `KIELER guards every action of a suspendable state with a flag that its during actions compute, and they run after the entry actions; before the first tick the flag is false. Later entries run them only if \`${state.name}\` was not suspended when it was last left. Put the set-up into the transition that enters \`${state.name}\`, or into an inner state.`,
        })
    }
    const exits = actionsOf(state, 'exit')
    if (exits.length && !state.root) {
        report(ctx, {
            span: exits[0].span, related: ids(exits[0].origin, s0.origin, state.origin),
            message: `If an enclosing state is left while \`${state.name}\` is suspended, \`${state.name}\`'s exit actions do not run`,
            hint: 'The suspend flag guards the exit actions as well.',
        })
    }
    const own = state.out.filter(t => t.preemption !== 'termination')
    if (own.length) {
        report(ctx, {
            span: s0.span, related: ids(s0.origin, state.origin, ...own.map(t => t.origin)),
            message: `While \`${state.name}\` is suspended, its own outgoing transitions cannot fire either`,
            hint: `KIELER's suspend freezes everything that belongs to \`${state.name}\`, including the transitions that leave it. To leave a suspended state, put the transition on an enclosing state.`,
        })
    }
    const join = state.out.find(t => t.preemption === 'termination' && t.trigger === undefined && t.delay !== 'delayed')
    if (join && canImmediateTerminate(state)) {
        report(ctx, {
            span: join.span, related: ids(join.origin, s0.origin, state.origin),
            message: `Because \`${state.name}\` has a suspend, this \`join to\` waits one tick longer when the inside finishes in \`${state.name}\`'s first tick`,
            hint: 'The suspend flag becomes part of the termination\'s trigger, and a termination with a trigger is delayed.',
        })
    }
}

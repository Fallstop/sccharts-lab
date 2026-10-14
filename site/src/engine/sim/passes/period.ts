// KIELER's Period processor (sccharts/processors/Period.xtend). Owner: the structure workstream. structure.md S-42.
//
// `period v` on a state S: a clock `c` and a flag `tick` (initially false; true for `immediate period`) are declared
// in S, every action and transition of every state in S, S's own included (S-42a), gets the guard `tick && ...`,
// and S gets a region `Period` with two delayed self-loops on `_s`: `if c >= v do c -= v; tick = true` (soft reset,
// KIELER's default) or `do c = 0; tick = true` (`@HardReset`), and otherwise `do tick = false`. The clock is then
// an ordinary clock for the Timed Automata processor, which advances it by deltaT.

import type { Pass, PassContext } from './context'
import {
    allStates, CVar, createControlflowRegion, createInitialState, createTransitionTo, isRegion, ref, type CAction,
    type CExpr, type CState, type Scope,
} from '../model'
import { up } from '../structure/rewrite'

export const period: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.period',
    name: 'Period',
    owner: 'structure',
    run(ctx: PassContext) {
        for (const state of allStates(ctx.root).filter(s => s.actions.some(a => a.kind === 'period'))) transform(state, ctx)
    },
}

/** Names used around the state (uniqueName when the generated names clash, as KIELER does). */
function clashes(state: CState): boolean {
    for (let s: Scope | undefined = state; s; s = up(s)) {
        if (!isRegion(s) && s !== state && s.actions.some(a => a.kind === 'period')) return true
        if (s.decls.some(v => v.name === 'c' || v.name === 'tick')) return true
    }
    return false
}

function unique(state: CState, base: string, clash: boolean): string {
    if (!clash) return base
    const taken = new Set<string>()
    for (let s: Scope | undefined = state; s; s = up(s)) for (const v of s.decls) taken.add(v.name)
    let i = 1
    while (taken.has(`${base}_${i}`)) i++
    return `${base}_${i}`
}

function transform(state: CState, ctx: PassContext) {
    const periods = state.actions.filter(a => a.kind === 'period')
    // S-42a: the guard also lands on the state's own transitions.
    const strong = state.out.filter(t => t.preemption === 'strong')
    if (strong.length) {
        ctx.report({
            severity: 'info', code: 'kieler-quirk', related: [state.origin ?? state.about, ...strong.map(t => t.origin)].filter((x): x is string => !!x),
            message: `\`${state.name}\` has a period, so KIELER also guards its own outgoing transitions with the period's tick: they can only fire in a tick after the period elapsed`,
            hint: `KIELER adds the period's condition to every transition of every state inside, \`${state.name}\`'s own included. Put the period into an inner state and leave \`${state.name}\` with a normal transition instead.`,
        })
    }
    state.actions = state.actions.filter(a => a.kind !== 'period')
    const clash = clashes(state)
    const several = periods.length > 1
    const about = (p: CAction) => p.origin ?? p.about
    const clocks = periods.map((p, i) => {
        const v = new CVar(unique(state, several ? `c${i}` : 'c', clash), 'clock')
        v.scope = state
        v.display = `the period's clock`
        v.decl = about(p)
        return v
    })
    state.decls.push(...clocks)
    const ticks = periods.map((p, i) => {
        const v = new CVar(unique(state, several ? `tick${i}` : 'tick', clash), 'bool')
        v.scope = state
        v.display = `whether \`${state.name}\`'s period has elapsed`
        v.role = 'tick'
        v.init = { k: 'lit', t: 'bool', v: p.delay === 'immediate' }
        v.decl = about(p)
        return v
    })
    state.decls.push(...ticks)
    // Guard every action and transition of every state inside, the state itself included.
    for (const tick of ticks) {
        const guard = (trigger: CExpr | undefined): CExpr => (trigger ? { k: 'op', op: '&&', args: [ref(tick), trigger] } : ref(tick))
        for (const s of allStates(state)) {
            for (const a of s.actions) a.trigger = guard(a.trigger)
            for (const t of s.out) t.trigger = guard(t.trigger)
        }
    }
    periods.forEach((p, i) => {
        const clock = clocks[i]
        const tick = ticks[i]
        const hard = p.annotations.some(a => a.toLowerCase() === 'hardreset')
        const threshold = p.trigger ?? { k: 'lit', t: 'int', v: 0 }
        const region = createControlflowRegion(state, i > 0 ? `Period${i}` : 'Period')
        region.about = about(p)
        const s = createInitialState(region, '_s')
        s.about = about(p)
        const o = { by: about(p), hidden: true }
        const elapsed = createTransitionTo(s, s)
        elapsed.about = about(p)
        elapsed.trigger = { k: 'op', op: '>=', args: [ref(clock), threshold] }
        elapsed.effects.push(hard
            ? { k: 'assign', ref: ref(clock), op: '=', expr: { k: 'lit', t: 'int', v: 0 }, o }
            : { k: 'assign', ref: ref(clock), op: '-=', expr: threshold, o })
        elapsed.effects.push({ k: 'assign', ref: ref(tick), op: '=', expr: { k: 'lit', t: 'bool', v: true }, o })
        const idle = createTransitionTo(s, s)
        idle.about = about(p)
        idle.effects.push({ k: 'assign', ref: ref(tick), op: '=', expr: { k: 'lit', t: 'bool', v: false }, o })
    })
}

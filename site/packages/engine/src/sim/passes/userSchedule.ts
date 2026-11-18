// KIELER's User Schedule processor (sccharts/processors/UserSchedule.xtend). Owner: the structure workstream.
//
// A schedule written on a state or region (`state S schedule s 1 { ... }`, `state S is C(...) schedule s 1`,
// `region R schedule s 1 { ... }`) is copied onto what runs inside it: the triggers and effects of the state's
// outgoing transitions and, unless the state is simple (no regions, no actions), its actions and its regions; a
// region passes it on to its actions and states the same way. Schedules on effects and triggers are kept where
// they are written (lower.ts), in method bodies and code blocks too; the contracts of class methods are copied onto
// their calls first (contracts.ts, KIELER's transformContracts). The dependency analysis (deps.ts) then orders the
// accesses of one schedule object by priority instead of initialise-update-read (structure.md S-27a).
//
// The Dataflow processor gives the regions of a run of sequential equations one schedule object with increasing
// priorities (S-27); those are copied onto every effect inside the region in the same way. (KIELER also puts them
// on triggers; the regions the simulator schedules have none.)

import type { Pass, PassContext } from './context'
import { allActionSites, allRegions, allScopes, controlflowRegions, CVar, effectExprs, isRegion, mapEffect, mapExpr, walkExpr, type CAction, type CEffect, type CExpr, type CRegion, type CState, type CStmt, type CTransition, type SchedEntry } from '../model'
import type { Schedule } from './dataflow'
import { transformContracts } from './contracts'

export const userSchedule: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.userSchedule',
    name: 'User Schedule',
    owner: 'structure',
    run(ctx: PassContext) {
        dropUnresolved(ctx)
        transformContracts(ctx)
        // The scopes with a schedule, before any is applied (KIELER's eAllContents below the root).
        const scheduled = allScopes(ctx.root).filter(s => s !== ctx.root && (s.ext.userSchedule as SchedEntry[] | undefined)?.length)
        for (const scope of scheduled) {
            if (isRegion(scope)) transformRegion(scope)
            else transformState(scope)
        }
        if (notASchedule(ctx)) return
        for (const region of allRegions(ctx.root)) {
            const schedule = region.ext.schedule as Schedule | undefined
            if (!schedule) continue
            const entry = [{ group: schedule.group, priority: schedule.priority }]
            const visit = (s: CState) => {
                for (const t of s.out) t.effects.forEach(f => addSchedule(f, entry))
                for (const scope of [s, ...s.regions]) for (const a of scope.actions) a.effects.forEach(f => addSchedule(f, entry))
                for (const r of s.regions) r.states.forEach(visit)
            }
            region.states.forEach(visit)
            for (const a of region.actions) a.effects.forEach(f => addSchedule(f, entry))
        }
    },
}

/** Every place of the chart that holds schedule clauses, with a function that replaces them. */
function clauses(ctx: PassContext, fn: (list: SchedEntry[]) => SchedEntry[] | undefined, called?: (v: CVar) => boolean) {
    const expr = <E extends CExpr | undefined>(e: E): E => (e ? (mapExpr(e, x => (x.sched ? { ...x, sched: fn(x.sched) } : undefined)) as E) : e)
    const effect = (f: CEffect): CEffect => {
        const mapped = mapEffect(f, x => (x.sched ? { ...x, sched: fn(x.sched) } : undefined))
        return mapped.o.schedule ? ({ ...mapped, o: { ...mapped.o, schedule: fn(mapped.o.schedule) } } as CEffect) : mapped
    }
    const statements = (list: CStmt[]): CStmt[] => list.map((st): CStmt => {
        switch (st.k) {
            case 'do': return { ...st, f: effect(st.f) }
            case 'if': return { ...st, cond: expr(st.cond), then: statements(st.then), else: st.else ? statements(st.else) : undefined }
            case 'while': return { ...st, cond: expr(st.cond), body: statements(st.body) }
            case 'for': return { ...st, init: statements(st.init), cond: expr(st.cond), update: statements(st.update), body: statements(st.body) }
            default: return st
        }
    })
    for (const scope of allScopes(ctx.root)) {
        if (!called) {
            const own = scope.ext.userSchedule as SchedEntry[] | undefined
            if (own) scope.ext.userSchedule = fn(own)
        }
        const sites: (CTransition | CAction)[] = [...scope.actions, ...(isRegion(scope) ? [] : scope.out)]
        for (const a of sites) {
            a.trigger = expr(a.trigger)
            a.effects = a.effects.map(effect)
        }
        for (const v of scope.decls) {
            if (!v.method || (called && !called(v))) continue
            v.method.body = statements(v.method.body)
            if (v.method.schedule && !called) v.method.schedule = fn(v.method.schedule)
        }
    }
}

/** A clause naming a schedule of a base chart that the Inheritance pass did not find (SchedEntry.ref) orders nothing. */
function dropUnresolved(ctx: PassContext) {
    clauses(ctx, list => {
        const kept = list.filter(e => !e.ref)
        return kept.length === list.length ? list : kept.length ? kept : undefined
    })
}

/**
 * A schedule clause naming a variable that is not a schedule (`int s ... schedule s 0`): KIELER's dependency analysis
 * casts its declaration to a schedule declaration for every access it orders, and throws. In a method body it does
 * when the method is called (KIELER removes the graph of a method nobody calls).
 */
function notASchedule(ctx: PassContext): boolean {
    const found: SchedEntry[] = []
    const check = (list: SchedEntry[]) => {
        for (const e of list) if (e.group instanceof CVar && e.group.declKind !== 'schedule') found.push(e)
        return list
    }
    const calledVars = new Set<CVar>()
    for (const site of allActionSites(ctx.root)) {
        const holder = site.transition ?? site.action!
        for (const e of [holder.trigger, ...holder.effects.flatMap(effectExprs)]) walkExpr(e, x => { if (x.k === 'call' && x.target?.v.method) calledVars.add(x.target.v) })
    }
    clauses(ctx, check, v => calledVars.has(v))
    const first = found[0]
    if (!first) return false
    const v = first.group as CVar
    ctx.report({
        severity: 'error', code: 'kieler-crash', span: first.span, related: v.decl ? [v.decl] : undefined,
        message: `\`${v.name}\` is not a schedule, so KIELER's compiler crashes on \`schedule ${v.name} ${first.priority}\``,
        kieler: 'java.lang.ClassCastException: class de.cau.cs.kieler.kexpressions.impl.VariableDeclarationImpl cannot be cast to class de.cau.cs.kieler.kexpressions.ScheduleDeclaration',
        hint: 'After `schedule` comes the name of a schedule object, declared as `schedule t`.',
    })
    return true
}

function scheduleOf(scope: CState | CRegion): SchedEntry[] {
    return (scope.ext.userSchedule as SchedEntry[] | undefined) ?? []
}

/** transformUserScheduleState */
function transformState(state: CState) {
    const schedule = scheduleOf(state)
    for (const t of state.out) applyToAction(t, schedule)
    if (isSimple(state)) return
    for (const a of state.actions) applyToAction(a, schedule)
    for (const r of controlflowRegions(state)) {
        r.ext.userSchedule = [...scheduleOf(r), ...schedule]
        transformRegion(r)
    }
    delete state.ext.userSchedule
}

/** transformUserScheduleControlflowRegion */
function transformRegion(region: CRegion) {
    const schedule = scheduleOf(region)
    for (const a of region.actions) applyToAction(a, schedule)
    for (const s of region.states) {
        if (isSimple(s)) {
            for (const t of s.out) applyToAction(t, schedule)
        } else {
            s.ext.userSchedule = [...scheduleOf(s), ...schedule]
            transformState(s)
        }
    }
    delete region.ext.userSchedule
}

function isSimple(s: CState): boolean {
    return s.regions.length === 0 && s.actions.length === 0
}

function applyToAction(a: CTransition | CAction, schedule: SchedEntry[]) {
    if (!schedule.length) return
    if (a.trigger) a.trigger = withTriggerSchedule(a.trigger, schedule)
    a.effects.forEach(f => addSchedule(f, schedule))
}

function withTriggerSchedule(e: CExpr, schedule: SchedEntry[]): CExpr {
    return { ...e, sched: [...(e.sched ?? []), ...schedule] }
}

function addSchedule(f: CEffect, schedule: SchedEntry[]) {
    f.o = { ...f.o, schedule: [...(f.o.schedule ?? []), ...schedule] }
}

// KIELER's User Schedule processor (sccharts/processors/UserSchedule.xtend). Owner: the structure workstream.
//
// A schedule written on a state or region (`state S schedule s 1 { ... }`, `state S is C(...) schedule s 1`,
// `region R schedule s 1 { ... }`) is copied onto what runs inside it: the triggers and effects of the state's
// outgoing transitions and, unless the state is simple (no regions, no actions), its actions and its regions; a
// region passes it on to its actions and states the same way. Schedules on effects and triggers are kept where
// they are written (lower.ts). The dependency analysis (deps.ts) then orders the accesses of one schedule object by
// priority instead of initialise-update-read (structure.md S-27a).
//
// The Dataflow processor gives the regions of a run of sequential equations one schedule object with increasing
// priorities (S-27); those are copied onto every effect inside the region in the same way. (KIELER also puts them
// on triggers; the regions the simulator schedules have none.)

import type { Pass, PassContext } from './context'
import { allRegions, allScopes, controlflowRegions, CVar, isRegion, walkExpr, type CAction, type CEffect, type CExpr, type CRegion, type CState, type CTransition, type SchedEntry } from '../model'
import type { Schedule } from './dataflow'

export const userSchedule: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.userSchedule',
    name: 'User Schedule',
    owner: 'structure',
    run(ctx: PassContext) {
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

/**
 * A schedule clause naming a variable that is not a schedule (`int s ... schedule s 0`): KIELER's dependency analysis
 * casts its declaration to a schedule declaration for every access it orders, and throws.
 */
function notASchedule(ctx: PassContext): boolean {
    const found: SchedEntry[] = []
    const check = (list: SchedEntry[] | undefined) => {
        for (const e of list ?? []) if (e.group instanceof CVar && e.group.declKind !== 'schedule') found.push(e)
    }
    for (const scope of allScopes(ctx.root)) {
        const sites: (CTransition | CAction)[] = [...scope.actions, ...(isRegion(scope) ? [] : scope.out)]
        for (const a of sites) {
            walkExpr(a.trigger, x => check(x.sched))
            for (const f of a.effects) if (f.k !== 'mark') check(f.o.schedule)
        }
    }
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

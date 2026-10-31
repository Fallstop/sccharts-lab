// KIELER's User Schedule processor (sccharts/processors/UserSchedule.xtend). Owner: the structure workstream.
//
// The Dataflow processor gives the regions of a run of sequential equations one schedule object with increasing
// priorities (structure.md S-27). UserSchedule copies a region's schedule onto every effect inside it (its states'
// transitions and actions, recursively); the dependency analysis (deps.ts) then orders the accesses of one schedule
// object by priority instead of initialise-update-read. (KIELER also puts it on triggers; the regions the simulator
// schedules have none.) Schedules written by the user (`schedule` declarations) are not supported yet.

import type { Pass, PassContext } from './context'
import { declsOf } from './detect'
import { allContainedStates, allRegions, type CEffect } from '../model'
import type { Schedule } from './dataflow'

export const userSchedule: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.userSchedule',
    name: 'User Schedule',
    owner: 'structure',
    run(ctx: PassContext) {
        const written = declsOf(ctx.root).filter(v => v.declKind === 'schedule')
        if (written.length) {
            ctx.report({
                severity: 'info', code: 'unsupported', span: written[0].span, related: written.flatMap(v => (v.decl ? [v.decl] : [])),
                message: 'The guide\'s simulator cannot run user-defined schedules yet',
                hint: 'This needs KIELER\'s User Schedule transformation for written schedule declarations, which the simulator does not implement yet. The official KIELER tools can run this chart.',
            })
            return
        }
        for (const region of allRegions(ctx.root)) {
            const schedule = region.ext.schedule as Schedule | undefined
            if (!schedule) continue
            const add = (f: CEffect) => {
                f.o = { ...f.o, schedule: [...(f.o.schedule ?? []), { group: schedule.group, priority: schedule.priority }] }
            }
            for (const s of allContainedStates(region)) {
                for (const t of s.out) t.effects.forEach(add)
                for (const scope of [s, ...s.regions]) for (const a of scope.actions) a.effects.forEach(add)
            }
            for (const a of region.actions) a.effects.forEach(add)
        }
    },
}

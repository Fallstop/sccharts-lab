// KIELER's Region Actions processor (sccharts/processors/RegionActionsAndDeclarations.xtend): declarations of a
// region move to its parent state (renamed `_region<i>_<name>_<var>`), so they are initialised when the parent
// is entered (concurrency.md H-4); a region with actions is wrapped in a new state that carries them.

import type { Pass, PassContext } from './context'
import {
    addVar, allRegions, createControlflowRegion, createFinalState, createState, createTransitionTo, addState,
} from '../model'
import { isComplexFinalState } from './complexFinalState'

export const regionActions: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.regionactions',
    name: 'Region Actions',
    owner: 'core',
    run(ctx: PassContext) {
        const regions = allRegions(ctx.root).filter(r => !r.dataflow && (r.actions.length > 0 || r.decls.length > 0))
        for (const region of regions) {
            if (!region.actions.length) {
                const parent = region.parent
                const regionId = `_region${parent.regions.indexOf(region)}_${region.name ?? 'null'}`
                for (const v of [...region.decls]) {
                    // Messages keep the reader's name (`k`, not `_region0_null_k`).
                    v.display ??= v.name
                    v.name = `${regionId}_${v.name}`
                    v.generated = true
                    addVar(parent, v)
                }
            } else {
                const newState = createState(region, `_region_${region.name ?? 'unnamed'}`)
                newState.initial = true
                newState.about = region.origin ?? region.about
                // createState added it to the region; the region's other states move into the new inner region.
                const inner = createControlflowRegion(newState, region.name ?? '')
                inner.label = region.label
                inner.about = region.origin ?? region.about
                for (const s of region.states.filter(s => s !== newState)) addState(inner, s)
                newState.actions.push(...region.actions)
                region.actions = []
                for (const v of [...region.decls]) addVar(newState, v)
                if (inner.states.some(s => s.final)) {
                    for (const s of inner.states.filter(isComplexFinalState)) {
                        ctx.report({
                            severity: 'error', code: 'region-action-final',
                            message: `KIELER cannot compile the final state \`${s.name}\`: it has outgoing transitions, actions or inner states, and its region has actions of its own`,
                            kieler: 'Cannot handle complex final states.',
                            hint: 'KIELER wraps a region with actions in a new state and cannot do that when the region has a complex final state. Move the region\'s actions to the superstate, or make the final state simple (no outgoing transitions, actions or inner states).',
                            related: [s.origin, region.origin].filter((x): x is string => !!x),
                        })
                    }
                    const done = createFinalState(region, '_Done')
                    done.about = newState.about
                    createTransitionTo(newState, done).preemption = 'termination'
                }
            }
        }
    },
}

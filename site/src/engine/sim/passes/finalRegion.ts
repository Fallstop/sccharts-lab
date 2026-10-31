// KIELER's Final Region processor (sccharts/processors/FinalRegion.xtend): the netlist chain does not support final
// regions (de.cau.cs.kieler.sccharts.finalRegion.supported is false), so every state of a `final region` becomes
// final and the region an ordinary one: it never blocks its parent's termination, and when the other regions
// finish, the parent terminates after the final region has reacted once more in that tick (preemption.md P-61).
// It runs after During, which still sees the region as final.

import type { Pass, PassContext } from './context'
import { allContainedControlflowRegions } from './contained'

export const finalRegion: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.finalRegion',
    name: 'Final Region',
    owner: 'preemption',
    run(ctx: PassContext) {
        if (ctx.config.finalRegions) return
        for (const region of allContainedControlflowRegions(ctx.root).filter(r => r.final)) {
            for (const state of region.states) state.final = true
            region.final = false
        }
    },
}

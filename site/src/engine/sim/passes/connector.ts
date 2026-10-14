// KIELER's Connector processor (sccharts/processors/Connector.xtend): a connector state becomes a normal state
// whose outgoing transitions are all immediate (preemption.md P-57).

import type { Pass, PassContext } from './context'
import { allStates } from '../model'

export const connector: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.connector',
    name: 'Connector',
    owner: 'preemption',
    run(ctx: PassContext) {
        for (const s of allStates(ctx.root)) {
            if (!s.connector) continue
            s.connector = false
            for (const t of s.out) t.delay = 'immediate'
        }
    },
}

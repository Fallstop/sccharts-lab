// KIELER's ODE processor (de.cau.cs.kieler.sccharts.processors.ode). Owner: the structure workstream.
// Removes: `ode` actions (structure.md).
//
// Not implemented yet: charts that use it are rejected with an "unsupported" diagnostic. To implement it, add a
// `run(ctx)` that rewrites ctx.root into constructs the later passes understand (see ../README.md).

import type { Pass } from './context'
import { construct } from './detect'
import { allScopes } from '../model'

export const ode: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.ode',
    name: 'ODE',
    owner: 'structure',
    uses: root => allScopes(root).flatMap(s => s.actions).filter(a => a.kind === 'ode').map(a => construct('ode actions', a.span, a.origin)),
}

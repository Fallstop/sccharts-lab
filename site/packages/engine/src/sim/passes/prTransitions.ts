// KIELER's Probabilistic Transitions processor (de.cau.cs.kieler.sccharts.processors.prTransitions). Owner: the structure workstream.
// Removes: Probabilistic transitions `Pr=0.5` (structure.md).
//
// Not implemented yet: charts that use it are rejected with an "unsupported" diagnostic. To implement it, add a
// `run(ctx)` that rewrites ctx.root into constructs the later passes understand (see ../README.md).

import type { Pass } from './context'

export const prTransitions: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.prTransitions',
    name: 'Probabilistic Transitions',
    owner: 'structure',
    uses: () => [],
}

// KIELER's SCL Code Effects processor (sccharts/processors/SclCodeEffect.xtend). Owner: the structure workstream.
// structure.md S-44.
//
// A code effect `do { ... }` becomes a void method `_effect<n>` of the state (an action's own state; for a
// transition, the state containing its source) and a call of it. The simulator does this while lowering (lower.ts,
// codeEffect), where the block's own declarations are at hand; the method is then inlined into the SCG like any short
// method (structure/methods.ts). Nothing is left for this pass.

import type { Pass } from './context'

export const codeEffects: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.codeEffects',
    name: 'Code Effects',
    owner: 'structure',
    run() {},
}

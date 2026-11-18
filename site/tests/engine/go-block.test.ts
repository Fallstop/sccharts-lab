// The GO block (packages/engine/src/sim/goblock.ts; docs-internal/semantics/basics.md B-7, B-34): the first-tick
// assignments KIELER's GOInitOptimizer finds under the first `if (_GO)` of its generated code and moves into reset()
// when they name no input. The values are checked against KIELER by tests/conformance/engine.test.ts (the
// probe-go-block-* recordings); these tests pin down the block's extent, which KIELER's generated C shows (the
// statements of reset() and of the first `if (_GO)` of logic(), read off dumps of that code), and the warning for
// the charts whose values the engine deliberately does not reproduce.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile } from '@sccharts-lab/engine'
import { noKielerNode } from '../../packages/engine/src/sim/scg'

const probe = (name: string) => fs.readFileSync(path.join(__dirname, 'kieler', `probe-go-block-${name}.sctx`), 'utf8')

/** KIELER's statements for the GO block: [left in the first `if (_GO)`, moved into reset()]. */
function extent(source: string): [number, number] {
    const r = compile(source)
    expect(r.ok).toBe(true)
    const sim = r.sim!
    const taken = sim.lowered.takenOrder.length
    let stay = 0
    let moved = 0
    for (const n of sim.goBlock.nodes) {
        if (noKielerNode(n)) continue
        // The reset of the taken-transition counters is one statement per transition.
        const weight = n.effect?.k === 'mark' && n.effect.m.kind === 'ttsReset' ? Math.max(1, taken) : 1
        if (sim.goBlock.moved.has(n)) moved += weight
        else stay += weight
    }
    return [stay, moved]
}

const warnings = (source: string) => compile(source).diagnostics.filter(d => d.code === 'kieler-bug')

describe('the extent of the GO block', () => {
    it('goes on into a state whose way back is dead', () => {
        expect(extent(probe('dead-way-back'))).toEqual([1, 5])
        expect(extent(probe('dead-way-back-dataflow'))).toEqual([1, 5])
        expect(extent(probe('unreachable-way-back'))).toEqual([1, 4])
        expect(extent(probe('dead-way-back-input-trigger'))).toEqual([1, 4])
    })

    it('joins the code of an immediate transition with the entry actions of its target', () => {
        expect(extent(probe('dead-way-back-after-transition'))).toEqual([2, 9])
        expect(extent(probe('dead-way-back-shared-variable'))).toEqual([2, 10])
    })

    it('ends at a state that is entered again', () => {
        expect(extent(probe('live-way-back'))).toEqual([0, 4])
        expect(extent(probe('way-back-needs-input'))).toEqual([0, 4])
        expect(extent(probe('regions-live-ways-back'))).toEqual([0, 6])
    })

    it('takes the first-tick code of regions that are never entered again', () => {
        // Both regions: the halt states' guards between them are gone.
        expect(extent(probe('regions-input'))).toEqual([2, 6])
        // The second region writes what was written before it and is not next to the first conditional.
        expect(extent(probe('regions-initialised-output'))).toEqual([0, 4])
        expect(extent(probe('regions-shared-update'))).toEqual([0, 4])
        // The first region's entry action is, the second region's code is not.
        expect(extent(probe('regions-first-entry'))).toEqual([0, 5])
        // The region whose output a trigger reads is scheduled first.
        expect(extent(probe('region-read-by-trigger'))).toEqual([1, 4])
    })
})

describe('first-tick reordering (B-34)', () => {
    it('warns where KIELER runs a later assignment in reset() before an earlier one that reads an input', () => {
        for (const name of ['dead-way-back', 'dead-way-back-dataflow', 'unreachable-way-back', 'dead-way-back-after-transition', 'dead-way-back-shared-variable']) {
            expect(warnings(probe(name)).length, name).toBe(1)
        }
    })

    it('does not warn where the code is not part of the GO block', () => {
        for (const name of ['live-way-back', 'way-back-needs-input', 'dataflow-once-classic']) expect(warnings(probe(name)), name).toEqual([])
    })
})

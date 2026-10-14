// The landing page's live chart (src/components/landing/HeroChart.astro) runs src/examples/landing/toggle.sctx on
// the guide's engine through the compact SimPanel. These tests hold that run to KIELER's: 12 random input
// sequences recorded with KIELER in toggle-random.oracle.json (regenerate with tests/design/record-toggle-random.mjs),
// fed the way the panel feeds them (inputs persist; a tick sends only what the reader changed).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import { initialInputs } from '../../src/components/sim/inputs'
import { Timeline } from '../../src/components/sim/timeline'

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const source = readFileSync(new URL('../../src/examples/landing/toggle.sctx', import.meta.url), 'utf8')

interface Case {
    inputs: { button?: boolean }[]
    ticks: { light: boolean; taken: number[] }[]
}

describe('the landing chart', () => {
    const compiled = compile(source)

    it('compiles and runs', () => {
        expect(compiled.ok).toBe(true)
    })

    it('matches KIELER on 12 random input sequences, driven like the panel drives it', () => {
        const fixture = read('./toggle-random.oracle.json') as { cases: Case[] }
        expect(fixture.cases.length).toBe(12)
        for (const [c, kase] of fixture.cases.entries()) {
            const sim = createSimulation(compiled)
            const timeline = new Timeline(sim, initialInputs(compiled.interface))
            kase.inputs.forEach((inp, i) => {
                const now = timeline.controls()
                if (inp.button !== undefined) timeline.edit({ levels: { ...now.levels, button: inp.button }, pulses: [] })
                timeline.step()
                const t = sim.history[i]
                expect(t.values.light, `case ${c}, tick ${i + 1}: light`).toBe(kase.ticks[i].light)
                expect(sim.takenCounts(t), `case ${c}, tick ${i + 1}: taken`).toEqual(kase.ticks[i].taken)
            })
        }
    })

    it('never fires in tick 1, even with button held', () => {
        const sim = createSimulation(compiled)
        const t = sim.step({ button: true })
        expect(t.active).toContain('Toggle.Off')
        expect(t.taken).toEqual([])
    })
})

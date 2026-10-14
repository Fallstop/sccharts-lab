import { describe, expect, it } from 'vitest'
import { Timeline } from '../../src/components/sim/timeline'
import { fakeSim } from './fake-sim'

const init = { levels: { A: false, N: 0 }, pulses: [] as string[] }

describe('Timeline: stepping, going back and replaying', () => {
    it('steps with the controls and keeps inputs (they persist)', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.edit({ levels: { A: true, N: 0 }, pulses: [] })
        t.step()
        t.step()
        expect(t.cursor).toBe(2)
        expect(sim.history.map((h) => h.inputs.A)).toEqual([true, true])
        expect(t.controls().levels.A).toBe(true)
    })

    it('a pulse is present for one tick only', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.edit({ levels: init.levels, pulses: ['A'] })
        t.step()
        t.step()
        expect(sim.history.map((h) => h.inputs.A)).toEqual([true, false])
    })

    it('Back keeps the later ticks; Step replays them without running the engine again', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.step(); t.step(); t.step()
        expect(t.back()).toBe(true)
        expect(t.back()).toBe(true)
        expect(t.cursor).toBe(1)
        expect(t.end).toBe(3)
        expect(t.canReplay).toBe(true)
        const calls = sim.calls.length
        expect(t.step()).toBe('replayed')
        expect(sim.calls.length).toBe(calls)
        expect(t.cursor).toBe(2)
    })

    it('after Back the controls show the inputs the next tick ran with', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.step()
        t.edit({ levels: { A: true, N: 7 }, pulses: [] })
        t.step()
        t.goto(1)
        expect(t.controls().levels).toEqual({ A: true, N: 7 })
    })

    it('changing an input after Back branches: the engine rewinds and the later ticks are replaced', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.step(); t.step(); t.step()
        t.goto(1)
        t.edit({ levels: { A: true, N: 0 }, pulses: [] })
        expect(t.canReplay).toBe(false)
        expect(t.step()).toBe('branched')
        expect(sim.calls).toContain('rewind 1')
        expect(t.end).toBe(2)
        expect(t.cursor).toBe(2)
        expect(sim.history[1].inputs.A).toBe(true)
    })

    it('goto clamps, and reset goes back to tick 0 with the initial inputs', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init)
        t.step(); t.step()
        t.goto(99)
        expect(t.cursor).toBe(2)
        t.goto(-4)
        expect(t.cursor).toBe(0)
        t.edit({ levels: { A: true, N: 3 }, pulses: [] })
        t.reset()
        expect(t.cursor).toBe(0)
        expect(t.end).toBe(0)
        expect(t.controls()).toEqual(init)
    })
})

describe('Timeline: inputs as KIELER\'s environment sends them', () => {
    // A chart that writes its input: the pool after each tick says what the input holds.
    const writer = () => {
        const sim = fakeSim()
        const step = sim.step.bind(sim)
        sim.step = (inputs) => {
            const t = step(inputs)
            ;(t as typeof t & { pool: object }).pool = { ...t.inputs, A: true } // the chart sets A
            return t
        }
        return sim
    }

    it('after a tick the controls show the pool, so a value the chart wrote is visible and kept', () => {
        const sim = writer()
        const t = new Timeline(sim, init)
        t.step()
        expect(t.controls().levels.A).toBe(true)
        t.step()
        expect(sim.calls.at(-1)).toBe('step {}')
    })

    it('a Step sends only the inputs the reader changed', () => {
        const sim = writer()
        const t = new Timeline(sim, init)
        t.step()
        t.edit({ levels: { A: false, N: 0 }, pulses: [] })
        t.step()
        expect(sim.calls.at(-1)).toBe('step {"A":false}')
    })

    it('the tour sends exactly what each scenario tick names', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init, { ticks: [{ inputs: { A: false, N: 0 } }, { inputs: { A: false } }, {}] })
        t.step(); t.step(); t.step()
        expect(sim.calls).toEqual(['step {"A":false,"N":0}', 'step {"A":false}', 'step {}'])
    })
})

describe('Timeline: the guided tour', () => {
    const script = { ticks: [{ inputs: { A: false, N: 1 }, note: 'one' }, { inputs: { A: true }, note: 'two' }, { note: 'three' }] }

    it('Next steps with the scripted inputs (each tick changes only what it names)', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init, script)
        expect(t.tour).toBe(true)
        expect(t.controls().levels).toEqual({ A: false, N: 1 })
        t.step(); t.step(); t.step()
        expect(sim.history.map((h) => [h.inputs.A, h.inputs.N])).toEqual([[false, 1], [true, 1], [true, 1]])
        expect(t.note).toBe('three')
        expect(t.tourHasNext).toBe(false)
    })

    it('stepping past the script leaves the tour', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.step(); t.step(); t.step(); t.step()
        expect(t.tour).toBe(false)
        expect(t.cursor).toBe(4)
    })

    it('changing an input takes over; notes stay only for ticks that ran as scripted', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.step()
        t.edit({ levels: { A: false, N: 9 }, pulses: [] })
        expect(t.tour).toBe(false)
        t.step()
        expect(t.note).toBeUndefined()
        t.goto(1)
        expect(t.note).toBe('one')
    })

    it('during the tour the controls show the inputs of the tick shown (the one its note is about)', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.step()
        t.step()
        // Tick 2 ran with A = true: the switches say so, although tick 3 names no input.
        expect(t.controls().levels).toEqual({ A: true, N: 1 })
        t.back()
        expect(t.controls().levels).toEqual({ A: false, N: 1 })
        // Stepping still uses the script: tick 2 replays, then tick 3 runs with what tick 3 names (nothing).
        t.step()
        t.step()
        expect(t.controls().levels).toEqual({ A: true, N: 1 })
        expect(t.note).toBe('three')
    })

    it('Take over at a tour tick keeps the inputs shown (they persist)', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init, script)
        t.step()
        t.step()
        t.takeOver()
        expect(t.controls().levels).toEqual({ A: true, N: 1 })
        t.step()
        expect(sim.calls.at(-1)).toBe('step {}')
        expect(sim.history.at(-1)!.inputs.A).toBe(true)
    })

    it('Take over before tick 1 keeps the inputs of tick 1 that the tour shows', () => {
        const sim = fakeSim()
        const t = new Timeline(sim, init, script)
        const shown = t.controls()
        t.takeOver(true)
        expect(t.tour).toBe(false)
        expect(t.controls()).toEqual(shown)
        t.step()
        expect(sim.history.at(-1)!.inputs.N).toBe(1)
    })

    it('Free play chosen before tick 1 starts from the initial values', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.takeOver()
        expect(t.controls()).toEqual(init)
    })

    it('Take over behind the end keeps replaying the later ticks', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.step(); t.step(); t.step()
        t.goto(1)
        t.takeOver()
        expect(t.canReplay).toBe(true)
        expect(t.edited).toBe(false)
        expect(t.step()).toBe('replayed')
    })

    it('Take over keeps the tick and the controls; Reset keeps free play unless asked to restart the tour', () => {
        const t = new Timeline(fakeSim(), init, script)
        t.step()
        const before = t.controls()
        t.takeOver()
        expect(t.tour).toBe(false)
        expect(t.controls()).toEqual(before)
        t.reset()
        expect(t.tour).toBe(false)
        t.reset(true)
        expect(t.tour).toBe(true)
    })
})

describe('Timeline.replace (an edited chart)', () => {
    it('replays the recorded inputs up to the cursor on the new chart, dropping inputs it no longer has', () => {
        const t = new Timeline(fakeSim(), init)
        t.edit({ levels: { A: true, N: 2 }, pulses: [] })
        t.step(); t.step(); t.step()
        t.back()
        const sim2 = fakeSim()
        const next = t.replace(sim2, { levels: { A: false, M: 5 }, pulses: [] }, true)
        expect(next.cursor).toBe(2)
        // Only what the reader changed is sent again (M was never changed).
        expect(sim2.history.map((h) => h.inputs)).toEqual([{ A: true }, { A: true }])
        expect(next.controls().levels).toEqual({ A: true, M: 5 })
    })

    it('without replay starts at tick 0, keeping the controls', () => {
        const t = new Timeline(fakeSim(), init)
        t.edit({ levels: { A: true, N: 2 }, pulses: [] })
        t.step()
        const next = t.replace(fakeSim(), init, false)
        expect(next.cursor).toBe(0)
        expect(next.controls().levels).toEqual({ A: true, N: 2 })
    })
})

// For-region copies on the diagram: what each state of a for-region did per copy in a tick (copyMarks), and how its
// accessible name says it (copyPhrase), checked on the guide's Seatbelts against the copies the engine reports.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { TickResult } from '../../src/engine/types'
import { copyMarks, copyPhrase, type CopyMarks } from '../../src/components/sim/trace'
import { copyCounters } from '../../src/components/sim/link'

const read = (id: string) => fs.readFileSync(new URL(`../../src/examples/${id}.sctx`, import.meta.url), 'utf8')
const tick = (t: Partial<TickResult> & { tick: number }): TickResult => ({
    inputs: {}, values: {}, present: {}, active: [], entered: [], exited: [], taken: [], actions: [], terminated: false, log: [], printed: [], ...t,
})

describe('for-region copies, per copy', () => {
    const c = compile(read('advanced/for-regions/seatbelts'))
    const sim = createSimulation(c)
    const belts = [[true, false, false, false], undefined, [true, true, false, true], [false, false, false, false], [false, false, true, false]]
    const history = belts.map((b) => sim.step(b ? { buckled: b } : {}))
    const counters = copyCounters(c)
    const marks = (n: number) => copyMarks(history[n - 1], n > 1 ? history[n - 2] : null, counters)
    const open = 'Seatbelts.Checking.Open'
    const fastened = 'Seatbelts.Checking.Fastened'

    it('names the counter of each for-region', () => {
        expect(Object.values(counters)).toEqual(['i'])
    })

    it('says in which copies a state is active, was entered and was left', () => {
        // Tick 1: every copy enters Open.
        expect(marks(1).get(open)).toEqual({ of: 4, counter: 'i', active: [0, 1, 2, 3], entered: [0, 1, 2, 3], left: [] })
        // Tick 2: the copy i = 0 leaves Open for Fastened; the union says "left" for Open although three copies stay.
        expect(history[1].exited).toContain(open)
        expect(marks(2).get(open)).toEqual({ of: 4, counter: 'i', active: [1, 2, 3], entered: [], left: [0] })
        expect(marks(2).get(fastened)).toEqual({ of: 4, counter: 'i', active: [0], entered: [0], left: [] })
        // Tick 3: i = 1 and i = 3 follow.
        expect(marks(3).get(open)?.left).toEqual([1, 3])
        expect(marks(3).get(fastened)?.entered).toEqual([1, 3])
    })

    it('puts it in words', () => {
        expect(copyPhrase(marks(2).get(open)!)).toBe('active in 3 of 4 copies (i = 1, 2 and 3), left in this tick in the copy i = 0')
        expect(copyPhrase(marks(2).get(fastened)!)).toBe('active in 1 of 4 copies (i = 0), entered in this tick in the copy i = 0')
        expect(copyPhrase(marks(3).get(open)!)).toBe('active in 1 of 4 copies (i = 2), left in this tick in the copies i = 1 and 3')
        // Without the counter's name.
        const m: CopyMarks = { of: 3, active: [1, 2], entered: [2], left: [0] }
        expect(copyPhrase(m)).toBe('active in 2 of 3 copies (the copies for 1 and 2), entered in this tick in the copy for 2, left in this tick in the copy for 0')
    })

    it('leaves the copies left unsaid when the tick before is not known', () => {
        const unknown = copyMarks(history[1], undefined, counters).get(open)!
        expect(unknown.left).toBeUndefined()
        expect(copyPhrase(unknown)).toBe('active in 3 of 4 copies (i = 1, 2 and 3)')
        // Before tick 1 nothing was active: tick 1 needs no tick before.
        expect(copyMarks(history[0], undefined, counters).get(open)?.left).toEqual([])
    })

    it('counts a state left and entered again in the same tick, and uses the engine\'s exits when it gives them', () => {
        const copies = (active: string[], entered: string[], exited?: string[]) => [
            { region: 'C:R', value: 1, active, entered, ...(exited ? { exited } : {}) },
            { region: 'C:R', value: 2, active: ['C.A'], entered: [] },
        ]
        const before = tick({ tick: 1, copies: copies(['C.A'], ['C.A']) } as never)
        const selfLoop = tick({ tick: 2, copies: copies(['C.A'], ['C.A']) } as never)
        expect(copyMarks(selfLoop, before).get('C.A')).toMatchObject({ active: [1, 2], entered: [1], left: [1] })
        const reported = tick({ tick: 2, copies: copies(['C.A'], [], ['C.B']) } as never)
        expect(copyMarks(reported, undefined).get('C.B')).toMatchObject({ active: [], entered: [], left: [1] })
    })

    it('says nothing for a region with a single copy, or without copies', () => {
        const single = tick({ tick: 1, copies: [{ region: 'C:R', value: 0, active: ['C.A'], entered: ['C.A'] }] } as never)
        expect(copyMarks(single, null).size).toBe(0)
        expect(copyMarks(tick({ tick: 1 }), null).size).toBe(0)
    })
})

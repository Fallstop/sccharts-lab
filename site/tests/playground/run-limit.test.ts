// A run link carries every tick of a long run (the changes only, compressed): 3000 ticks, as a reader reaches with
// Run until, come back whole; the limit (MAX_RUN_TICKS) is far beyond that, and a steady run of that length is short.
import { describe, expect, test } from 'vitest'
import { encodeRun, makeRun, MAX_RUN_TICKS, runFromHash } from '../../src/components/playground/share'

const steady = (n: number) => Array.from({ length: n }, (_, i) => ({ dim: i % 500 === 0, level: 3 }))

describe('the ticks a run link carries', () => {
    test('a run of 3000 ticks keeps all of them, and the tick shown', () => {
        const run = makeRun(steady(3000), 3000)
        expect(run.ticks.length).toBe(3000)
        const back = runFromHash(`#run=${encodeRun(run)}`)
        expect(back?.ticks.length).toBe(3000)
        expect(back?.at).toBe(3000)
        expect(back?.ticks[2999]).toEqual({ dim: false, level: 3 })
    })
    test(`up to ${MAX_RUN_TICKS} ticks; a steady run that long stays a short link`, () => {
        expect(MAX_RUN_TICKS).toBeGreaterThanOrEqual(20000)
        const hash = `#run=${encodeRun(makeRun(steady(MAX_RUN_TICKS + 5), 1))}`
        expect(runFromHash(hash)?.ticks.length).toBe(MAX_RUN_TICKS)
        expect(hash.length).toBeLessThan(8000)
    })
})

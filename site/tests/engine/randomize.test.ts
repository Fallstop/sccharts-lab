// randomize() (basics.md B-29): KIELER's C code calls srand(time(NULL)). The generator is glibc's, the seed is the
// simulation's to choose (the clock by default), and a tick's result says which seeds it used, so a run can be repeated.
// The recorded KIELER runs are in tests/engine/kieler/random (their seeds: tools/oracle/seeds.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { compile, createSimulation, describeTick, replaySeeds } from '@sccharts-lab/engine'
import { newRandState, rand } from '@sccharts-lab/engine/sim/random'

// From tick 2 on, R draws a number in every tick; `seed` seeds first (the Seed region comes first).
const CHART = `scchart Dice {
  input bool seed
  output float r = 0
  region Seed {
    initial state S
      if seed do randomize() go to S
  }
  region Roll {
    initial state R
      do r = random() go to R
  }
}`

/** The first random() of glibc after srand(seed): rand() / RAND_MAX in single precision. */
const first = (seed: number) => Math.fround(Math.fround(rand(newRandState(seed))) / Math.fround(2147483647))

afterEach(() => vi.useRealTimers())

describe('srand(seed)', () => {
    it("gives glibc's sequences (gcc: srand(seed); rand(); rand(); rand())", () => {
        const expected: [number, number[]][] = [
            [0, [1804289383, 846930886, 1681692777]],
            [1, [1804289383, 846930886, 1681692777]],
            [42, [71876166, 708592740, 1483128881]],
            [2147483647, [1065668062, 2142264300, 1066566375]],
            // A seed of 2^31 or more is a negative int32 in glibc's arithmetic.
            [2147483648, [1336741213, 1210407648, 1447044896]],
            [3000000000, [2058147116, 854483408, 922419988]],
            [4294967295, [254925627, 1205188300, 366127624]],
            [1794958854, [744080796, 1075701475, 1972792085]],
        ]
        for (const [seed, numbers] of expected) {
            const state = newRandState(seed)
            expect([rand(state), rand(state), rand(state)], `seed ${seed}`).toEqual(numbers)
        }
    })
})

describe('randomize()', () => {
    const result = compile(CHART)

    it('seeds with the number given, and the tick says so', () => {
        const sim = createSimulation(result, { seed: 42 })
        expect(sim.step({ seed: false }).seeds).toBeUndefined()
        // Tick 2 draws from the unseeded generator, as a C program that never called srand.
        expect(sim.step({ seed: false }).values.r).toBe(0.8401877284049988)
        // The Seed region runs first: the same tick's random() is the first number after srand(42).
        const t = sim.step({ seed: true })
        expect(t.seeds).toEqual([42])
        expect(t.values.r).toBe(first(42))
        expect(sim.step({ seed: false }).seeds).toBeUndefined()
    })

    it('asks a function for every call, with the tick and the call\'s index', () => {
        const calls: { tick: number; index: number }[] = []
        const twice = compile('scchart T {\n  output float a, b\n  initial state A\n    go to B\n  state B do randomize(); a = random(); randomize(); b = random() go to B\n}')
        const sim = createSimulation(twice, { seed: call => { calls.push(call); return 100 + call.index } })
        sim.step()
        sim.step()
        const t = sim.step()
        expect(calls).toEqual([{ tick: 3, index: 0 }, { tick: 3, index: 1 }])
        expect(t.seeds).toEqual([100, 101])
        expect([t.values.a, t.values.b]).toEqual([first(100), first(101)])
    })

    it('takes the clock in whole seconds by default, as time(NULL)', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(1794958854999))
        const sim = createSimulation(result)
        sim.step({ seed: false })
        const t = sim.step({ seed: true })
        expect(t.seeds).toEqual([1794958854])
        expect(t.values.r).toBe(first(1794958854))
        // Within the same second the next call starts the same sequence again.
        expect(sim.step({ seed: true }).values.r).toBe(first(1794958854))
        vi.setSystemTime(new Date(1794958855000))
        expect(sim.step({ seed: true }).seeds).toEqual([1794958855])
    })

    it('a seed is C\'s unsigned int', () => {
        const sim = createSimulation(result, { seed: 2 ** 32 + 42 })
        sim.step({ seed: false })
        const t = sim.step({ seed: true })
        expect(t.seeds).toEqual([42])
        expect(t.values.r).toBe(first(42))
    })

    it('a tick run again after rewind() has the seeds it had; reset() forgets them', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(1000_000))
        const sim = createSimulation(result)
        sim.step({ seed: false })
        const before = sim.step({ seed: true })
        const next = sim.step({ seed: false })
        vi.setSystemTime(new Date(2000_000))
        sim.rewind(1)
        const again = sim.step({ seed: true })
        expect(again.seeds).toEqual([1000])
        expect(again.values).toEqual(before.values)
        expect(sim.step({ seed: false }).values).toEqual(next.values)
        sim.reset()
        sim.step({ seed: false })
        expect(sim.step({ seed: true }).seeds).toEqual([2000])
    })

    it('replaySeeds repeats a run in another simulation', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(5000_000))
        const inputs = [{ seed: false }, { seed: true }, { seed: false }, { seed: true }, { seed: false }]
        const a = createSimulation(result)
        const run = inputs.map(i => {
            vi.advanceTimersByTime(1000)
            return a.step(i)
        })
        expect(run.map(t => t.seeds)).toEqual([undefined, [5002], undefined, [5004], undefined])
        vi.setSystemTime(new Date(9000_000))
        const b = createSimulation(result, { seed: replaySeeds(run) })
        expect(inputs.map(i => b.step(i).values)).toEqual(run.map(t => t.values))
        // A call the earlier run did not make takes the clock.
        expect(b.step({ seed: true }).seeds).toEqual([9000])
    })

    it('says in the tick\'s log that the random numbers were seeded', () => {
        const sim = createSimulation(result, { seed: 7 })
        sim.step({ seed: false })
        const t = sim.step({ seed: true })
        const note = t.log.find(e => e.kind === 'note')
        expect(note).toMatchObject({ kind: 'note', text: 'randomize() seeded the random numbers from the clock (seed 7): random() starts a new sequence.' })
        expect(describeTick(t, result.program!).join(' ')).toContain('seed 7')
    })
})

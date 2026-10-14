// describeTick's reasons (src/engine/sim/reasons.ts): the values a trigger read when it was checked, not the
// values after the tick, in the log (`check`, `take`, `suspend` events) and in the sentences.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, describeTick } from '../../src/engine/index'
import type { TickResult } from '../../src/engine/types'

const run = (source: string, inputs: Record<string, unknown>[]) => {
    const r = compile(source)
    expect(r.ok).toBe(true)
    const sim = createSimulation(r)
    const ticks = inputs.map(i => sim.step(i as never))
    const text = (i: number) => describeTick(ticks[i], r.program!, ticks[i - 1])
    return { r, ticks, text }
}

const takes = (t: TickResult) => t.log.filter(e => e.kind === 'take')

describe('reasons: what a trigger read when it was checked', () => {
    it('a transition that writes the variable it tests', () => {
        const { ticks, text } = run(`scchart T {
  input bool g
  output int n = 0
  initial state A
  if n == 0 do n = 1 go to B
  state B
  if g && n == 1 do n++ go to C
  state C
  immediate if n == 2 do n = 5 go to D
  state D
}`, [{}, { g: false }, { g: true }])
        expect(text(1)).toContain('A went to B because n == 0 held (n was 0).')
        // An immediate chain: each trigger with the value it saw.
        expect(text(2)).toContain('B went to C because g && n == 1 held (g was true and n was 1).')
        expect(text(2)).toContain('C went to D because n == 2 held (n was 2).')
        expect(takes(ticks[2])).toEqual([
            { kind: 'take', transition: 'T.B->1', reason: 'g was true and n was 1', seen: [{ name: 'g', value: true }, { name: 'n', value: 1 }] },
            { kind: 'take', transition: 'T.C->1', reason: 'n was 2', seen: [{ name: 'n', value: 2 }] },
        ])
        expect(ticks[2].log).toContainEqual({ kind: 'check', transition: 'T.B->1', result: true, reason: 'g was true and n was 1', seen: [{ name: 'g', value: true }, { name: 'n', value: 1 }] })
    })

    it('signals, val and pre', () => {
        const { text } = run(`scchart V {
  input signal int V
  output int x = 0
  initial state A
  if V && val(V) > 2 do x = val(V) go to B
  state B
  if pre(V) do x = 9 go to C
  state C
}`, [{}, { V: 5 }, { V: false }])
        expect(text(1)).toContain('A went to B because V && val(V) > 2 held (V was present and val(V) was 5).')
        expect(text(2)).toContain('B went to C because pre(V) held (pre(V) was present).')
    })

    it('inside a referenced chart: its names, the instance\'s values', () => {
        const { text } = run(`scchart Main {
  input bool tick
  output int count = 0
  initial state R is Counter(tick to step, count to n)
}
scchart Counter {
  input bool step
  output int n
  initial state A
  if step && n < 2 do n++ go to A
}`, [{ tick: false }, { tick: true }, { tick: true }])
        expect(text(1)).toContain('Inside R (a copy of Counter, with step bound to tick and n bound to count): A went to A because step && n < 2 held (step was true and n was 0).')
        expect(text(2).join(' ')).toContain('(step was true and n was 1)')
    })

    it('constants and for-region counters are not listed', () => {
        const { text } = run(`scchart F {
  const int MAX = 2
  input bool key[2]
  output int x = 0
  region R for i : 0 to 1 {
    initial state Off
    if key[i] && x < MAX go to On
    state On
  }
}`, [{ key: [false, false] }, { key: [true, false] }])
        expect(text(1)).toContain('In the copy of the for-region R with i = 0: Off went to On because key[i] && x < MAX held (key[i] was true and x was 0).')
    })

    it('P-23: the last transition taken without checking its trigger', () => {
        const { ticks, text } = run(`scchart P {
  input bool A, X
  output bool y = false
  initial state M {
    exit do y = true
    initial state I
  }
  if A && !y abort to B
  if X abort to C
  state B
  state C
}`, [{ A: false, X: false }, { A: true }])
        expect(takes(ticks[1])).toEqual([{ kind: 'take', transition: 'P.M->2', unchecked: true }])
        const s = text(1).find(x => x.startsWith('M was aborted'))!
        expect(s).toContain('M was aborted and went to C without checking X')
        expect(s).not.toContain('because X held')
        expect(s).toContain('it takes the last one regardless of its trigger')
    })

    it('suspend: the trigger\'s values when the suspension was decided', () => {
        const { ticks, text } = run(`scchart S {
  input bool p
  output int x = 0
  initial state M {
    suspend if p || pre(x) > 2
    initial state I
    if true do x++ go to I
  }
}`, [{}, {}, { p: true }, { p: false }, {}, {}])
        expect(text(2).join(' ')).toContain('M is suspended because p || pre(x) > 2 holds (p was true and pre(x) was 1)')
        expect(ticks[5].log.find(e => e.kind === 'suspend')).toEqual({ kind: 'suspend', state: 'S.M', reason: 'p was false and pre(x) was 3', seen: [{ name: 'p', value: false }, { name: 'pre(x)', value: 3 }] })
    })

    it('a strong abort checked inside the superstate', () => {
        const { text } = run(`scchart A {
  input bool fault, go1
  output int x = 0
  initial state Op {
    initial state S {
      initial state R
      if go1 do x++ go to R
    }
  }
  if fault abort to H
  state H
}`, [{}, { go1: true }, { fault: true }])
        expect(text(2)[0]).toBe('Op was aborted and went to H because fault was true, so the inside of Op did not react in this tick (a strong abort).')
    })
})

describe('natural reasons and the entry tick', () => {
    const turnstile = `scchart Turnstile {
  input bool coin, push
  output signal Beep
  output bool unlocked = false
  initial state Locked
    if coin do unlocked = true; Beep go to Unlocked
  state Unlocked
    if !push go to Unlocked2
    if Beep go to Locked
  state Unlocked2
}`

    it('says what a one-variable trigger was, without "held"', () => {
        const { text } = run(turnstile, [{}, { coin: true }])
        expect(text(1)).toContain('Locked went to Unlocked because coin was true.')
    })

    it('a negated variable and a signal', () => {
        const { text } = run(`scchart N {
  input bool push
  output signal S
  initial state A
    if !push do S go to B
  state B
    if S go to A
    immediate if !S go to C
  state C
}`, [{ push: true }, { push: false }])
        expect(text(1)).toContain('A went to B because push was false.')
    })

    it('a state entered in this tick whose delayed transition would fire: first checked in the next tick', () => {
        const { text } = run(turnstile, [{ coin: true }, { coin: true, push: true }])
        expect(text(0)).toEqual([
            'The chart starts in Locked.',
            'coin is true, but Locked was entered in this tick: its transition is delayed, so it is first checked in tick 2.',
        ])
        // Unlocked is entered in tick 2 with push true, so `!push` does not hold, but Beep was emitted on the way in.
        expect(text(1)).toContain('Beep is present, but Unlocked was entered in this tick: its transitions are delayed, so they are first checked in tick 3.')
    })

    it('several delayed transitions, and a signal', () => {
        const { text } = run(`scchart M {
  input bool a
  output signal S
  initial state P
    if a do S go to Q
  state Q
    if S go to P
    if a go to Q
}`, [{}, { a: true }])
        expect(text(1)).toContain('S is present, but Q was entered in this tick: its transitions are delayed, so they are first checked in tick 3.')
    })
})

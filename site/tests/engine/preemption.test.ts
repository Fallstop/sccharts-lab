// The preemption passes (src/engine/sim/passes: history, suspend, countDelay, weakSuspend, deferred, finalRegion,
// abortRegion) seen through the simulator's API: the source-level configuration (active, entered, exited), the
// log and describeTick, provenance, and the diagnostics. Values per tick are checked against KIELER's recordings
// in tests/conformance/preemption (engine.test.ts); the expectations here follow those recordings.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation, describeTick, type CompileResult } from '../../src/engine/index'
import type { TickResult, Value } from '../../src/engine/types'

function run(source: string, ticks: Record<string, Value>[]): { result: CompileResult; ticks: TickResult[] } {
    const result = compile(source)
    expect(result.ok, result.diagnostics.map(d => `${d.code}: ${d.message}`).join('\n')).toBe(true)
    expect(result.diagnostics.find(d => d.code === 'unsupported')).toBeUndefined()
    const sim = createSimulation(result)
    return { result, ticks: ticks.map(i => sim.step(i)) }
}

const leaf = (t: TickResult) => t.active[t.active.length - 1]
const notes = (t: TickResult) => t.log.flatMap(e => (e.kind === 'note' ? [e.text] : []))
const describe1 = (r: CompileResult, t: TickResult, prev?: TickResult) => describeTick(t, r.program!, prev).join(' ')

describe('count delays (P-28..P-36)', () => {
    const chart = `scchart C {
  input bool A
  output int fired = 0
  initial state S
  if 3 A do fired = 1 go to T
  state T
}`
    it('fires in the third tick with A after the entry tick, and says so', () => {
        const { result, ticks } = run(chart, [{ A: true }, { A: true }, { A: false }, { A: true }, { A: true }])
        expect(ticks.map(t => t.values.fired)).toEqual([0, 0, 0, 0, 1])
        expect(ticks[4].taken).toEqual(['C.S->1'])
        expect(describe1(result, ticks[4])).toContain('because A was true for the 3rd time while S was active')
        expect(describe1(result, ticks[2])).toContain('S waits for A (the 3rd time)')
    })
    it('reports no generated transitions or actions', () => {
        const { ticks } = run(chart, [{ A: true }, { A: true }, { A: true }, { A: true }])
        for (const t of ticks) {
            for (const id of t.taken) expect(id).toMatch(/^C\.S->\d+$/)
            expect(t.actions).toEqual([])
        }
    })
    it('warns about the stale count of an immediate count delay on a state that is entered again (P-30)', () => {
        const r = compile(`scchart C {
  input bool A, B
  output int fired = 0
  initial state S
  immediate if 2 A do fired += 1 go to T
  state T
  if B go to S
}`)
        expect(r.diagnostics.some(d => d.code === 'kieler-quirk' && d.severity === 'info' && /count/.test(d.message))).toBe(true)
    })
})

describe('suspend (P-37..P-45)', () => {
    const chart = `scchart S {
  input bool P
  output int moves = 0
  initial state M {
    suspend if P
    initial state I
    if true do moves += 1 go to I
  }
}`
    it('logs the suspended state and keeps the configuration', () => {
        const { result, ticks } = run(chart, [{ P: false }, { P: false }, { P: true }, { P: false }])
        expect(ticks.map(t => t.values.moves)).toEqual([0, 1, 1, 2])
        // With what the suspend trigger read when the suspension was decided.
        expect(ticks[2].log.find(e => e.kind === 'suspend')).toEqual({ kind: 'suspend', state: 'S.M', reason: 'P was true', seen: [{ name: 'P', value: true }] })
        expect(ticks[2].active).toEqual(['S', 'S.M', 'S.M.I'])
        expect(ticks[1].log.some(e => e.kind === 'suspend')).toBe(false)
        const text = describe1(result, ticks[2], ticks[1])
        expect(text).toContain('M is suspended because P holds (P was true)')
        expect(text).not.toContain('No transition fired')
    })
    it('explains the entry-action quirk (P-42) and the frozen own transitions (P-38)', () => {
        const r = compile(`scchart S {
  input bool P, G
  output int entries = 0
  initial state M {
    suspend if P
    entry do entries += 1
    initial state I
  }
  if G go to N
  state N
  if G go to M
}`)
        const quirks = r.diagnostics.filter(d => d.code === 'kieler-quirk').map(d => d.message)
        expect(quirks.some(m => /entry actions/.test(m))).toBe(true)
        expect(quirks.some(m => /outgoing transitions cannot fire/.test(m))).toBe(true)
    })
    it('rejects a suspend without a condition, with the lab server\'s message', () => {
        const r = compile('scchart S {\n  initial state M {\n    suspend\n    initial state I\n  }\n}')
        expect(r.ok).toBe(false)
        const e = r.diagnostics.find(d => d.severity === 'error')!
        expect(e.code).toBe('suspend-without-trigger')
        expect(e.kieler).toBe('This suspend has no trigger. KIELER cannot compile a suspend without an if condition.')
        expect(e.span?.line).toBe(3)
    })
    it('rejects a weak suspend without a condition', () => {
        const r = compile('scchart S {\n  initial state M {\n    weak suspend\n    initial state I\n  }\n}')
        expect(r.ok).toBe(false)
        expect(r.diagnostics.find(d => d.severity === 'error')?.kieler).toBe('This weak suspend has no trigger. KIELER cannot compile a weak suspend without an if condition.')
    })
})

describe('weak suspend (P-46)', () => {
    const chart = `scchart W {
  input bool S, A
  output int entersJ = 0
  initial state M {
    weak suspend if S
    initial state I
    if A go to J
    state J {
      entry do entersJ += 1
    }
  }
}`
    it('runs the tick, then the configuration goes back to the bookmarked state', () => {
        const { result, ticks } = run(chart, [{ S: false, A: false }, { S: true, A: true }, { S: false, A: false }, { S: false, A: true }])
        expect(ticks.map(t => t.values.entersJ)).toEqual([0, 1, 1, 2])
        expect(ticks[1].taken).toEqual(['W.M.I->1'])
        expect(leaf(ticks[1])).toBe('W.M.I')
        expect(ticks[1].entered).toContain('W.M.J')
        expect(ticks[1].exited).toContain('W.M.J')
        expect(leaf(ticks[2])).toBe('W.M.I')
        expect(leaf(ticks[3])).toBe('W.M.J')
        expect(notes(ticks[1]).some(n => /weakly suspended/.test(n) && /back to I/.test(n))).toBe(true)
        expect(describe1(result, ticks[1], ticks[0])).toContain('goes back to I')
    })
})

describe('history (P-47..P-52)', () => {
    const top = `scchart H {
  input bool A, P, R
  output int where = 0
  initial state M {
    initial state I {
      entry do where = 1
    }
    if A go to J
    state J {
      entry do where = 2
    }
  }
  if P go to Paused
  state Paused
  if R go to M history
}`
    it('resumes M in J and says so', () => {
        const { ticks } = run(top, [{}, { A: true }, { A: false, P: true }, { P: false, R: true }])
        expect(ticks[3].values.where).toBe(2)
        expect(ticks[3].entered).toEqual(['H.M', 'H.M.J'])
        expect(leaf(ticks[3])).toBe('H.M.J')
        expect(notes(ticks[3]).some(n => /M resumes with its history/.test(n) && /in J/.test(n))).toBe(true)
    })
    it('resumes what KIELER recorded: a deferred entry is not recorded', () => {
        const { ticks } = run(`scchart H {
  input bool A, P, R
  output int where = 0
  initial state M {
    initial state I {
      entry do where = 1
    }
    if A go to J deferred
    state J {
      entry do where = 2
    }
  }
  if P go to Paused
  state Paused {
    entry do where = 9
  }
  if R go to M history
}`, [{}, { A: true }, { A: false }, { P: true }, { P: false, R: true }])
        expect(ticks.map(t => t.values.where)).toEqual([1, 1, 1, 9, 1])
        expect(leaf(ticks[2])).toBe('H.M.J')
        expect(leaf(ticks[4])).toBe('H.M.I')
        expect(notes(ticks[4]).some(n => /continues in I, the last state KIELER recorded/.test(n))).toBe(true)
    })
    it('ignores history nested in a state without a history transition, like KIELER (P-51)', () => {
        const nested = `scchart N {
  input bool A, P, R
  output int where = 0
  initial state Top {
    initial state M {
      initial state I {
        entry do where = 1
      }
      if A go to J
      state J {
        entry do where = 2
      }
    }
    if P go to Paused
    state Paused
    if R go to M history
  }
}`
        const { result, ticks } = run(nested, [{}, { A: true }, { A: false, P: true }, { P: false, R: true }])
        expect(ticks[3].values.where).toBe(1)
        expect(leaf(ticks[3])).toBe('N.Top.M.I')
        expect(notes(ticks[3]).some(n => /KIELER ignores this history/.test(n))).toBe(true)
        const quirk = result.diagnostics.find(d => d.code === 'kieler-quirk' && /ignores this history/.test(d.message))
        expect(quirk?.severity).toBe('info')
        expect(quirk?.related).toContain('N.Top.Paused->1')
    })
})

describe('deferred (P-53..P-56)', () => {
    it('enters a superstate one tick late when every transition into it is deferred (P-54 a)', () => {
        const { result, ticks } = run(`scchart D {
  input bool G
  output int outerEntry = 0, innerEntry = 0
  initial state A
  if G go to B deferred
  state B {
    entry do outerEntry = 1
    initial state I {
      entry do innerEntry = 1
    }
    if true go to J
    state J
  }
}`, [{ G: false }, { G: true }, { G: false }, { G: false }])
        expect(ticks.map(t => [t.values.outerEntry, t.values.innerEntry])).toEqual([[0, 0], [0, 0], [0, 1], [0, 1]])
        expect(ticks[1].active).toEqual(['D', 'D.B'])
        expect(ticks[1].entered).toEqual(['D.B'])
        expect(ticks[2].entered).toEqual(['D.B.I'])
        expect(leaf(ticks[3])).toBe('D.B.J')
        expect(result.diagnostics.some(d => d.code === 'kieler-quirk' && /one tick late/.test(d.message))).toBe(true)
    })
    it('skips the entry actions of a simple state entered deferred', () => {
        const { ticks } = run(`scchart D {
  input bool G
  output int entries = 0, chained = 0
  initial state A
  if G go to B deferred
  state B {
    entry do entries += 1
  }
  immediate do chained += 1 go to C
  state C
}`, [{ G: false }, { G: true }, { G: false }])
        expect(ticks.map(t => [t.values.entries, t.values.chained])).toEqual([[0, 0], [0, 0], [0, 1]])
        expect(ticks[1].taken).toEqual(['D.A->1'])
        expect(ticks[2].taken).toEqual(['D.B->1'])
    })
})

describe('final regions (P-61)', () => {
    it('does not wait for a final region', () => {
        const { ticks } = run(`scchart F {
  input bool A
  output int background = 0, done = 0
  initial state M {
    region Main {
      initial state I
      if A go to F
      final state F
    }
    final region Background {
      initial state C
      if true do background += 1 go to C
    }
  }
  join to Done
  state Done {
    entry do done = 1
  }
}`, [{ A: false }, { A: false }, { A: true }])
        expect(ticks.map(t => [t.values.background, t.values.done])).toEqual([[0, 0], [1, 0], [2, 1]])
    })
})

describe('abort regions (P-62)', () => {
    it('are simulated as KIELER\'s netlist does, and KIELER\'s rejections are reproduced', () => {
        const ok = compile(`scchart A {
  input bool G
  initial state M {
    abort region Watch {
      initial state W
      if G go to F
      final state F
    }
    region Main {
      initial state I
      if true go to I
    }
  }
}`)
        expect(ok.ok).toBe(true)
        expect(ok.diagnostics.find(d => d.code === 'unsupported')).toBeUndefined()
        const sim = createSimulation(ok)
        sim.step({ G: false })
        const t2 = sim.step({ G: true })
        // Watch finished: M is done, its other regions stop (and are left, in source terms).
        expect(t2.log.some(e => e.kind === 'note' && e.text.startsWith('The abort region Watch of M finished, so M is done'))).toBe(true)
        expect(t2.active).toEqual(['A', 'A.M'])
        expect(sim.step({ G: false }).taken).toEqual([])
        const last = compile(`scchart A {
  input bool G
  initial state M {
    region Main {
      initial state I
      if true go to I
    }
    abort region Watch {
      initial state W
      if G go to F
      final state F
    }
  }
  if G go to Done
  state Done
}`)
        expect(last.ok).toBe(false)
        expect(last.diagnostics.find(d => d.severity === 'error')?.kieler).toMatch(/^Illegal order of abort and non-abort regions/)
        expect(last.diagnostics.find(d => d.severity === 'error')?.message).toContain('The abort regions of `M`')
        const alone = compile(`scchart A {
  input bool G
  initial state M {
    abort region Watch {
      initial state W
      if G go to F
      final state F
    }
  }
}`)
        expect(alone.diagnostics.find(d => d.severity === 'error')?.kieler).toBe('Found abort regions but there are no regions to abort.')
    })

    it('a state with abort regions that is re-entered in the tick it finishes is not simulated (thread reincarnation)', () => {
        const r = compile(`scchart F {
  input bool A
  output int work = 0
  initial state M {
    region Main {
      initial state I
      if true do work += 1 go to I
    }
    abort region Watch {
      initial state W
      if A go to F
      final state F
    }
  }
  join to M
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'unsupported')
        expect(d?.message).toContain('abort regions in a state that is left and entered again in the same tick (`M`)')
        expect(d?.related).toEqual(['F.M'])
    })
})

describe('aborts in describeTick', () => {
    it('says that a strong abort skips the inside and a weak abort lets it finish', () => {
        const chart = (kind: string) => `scchart X {
  input bool A, S
  output int inner = 0
  initial state M {
    initial state I
    if A do inner += 1 go to J
    state J
  }
  if S ${kind} Done
  state Done
}`
        const strong = run(chart('abort to'), [{}, { A: true, S: true }])
        expect(strong.ticks[1].values.inner).toBe(0)
        expect(describe1(strong.result, strong.ticks[1])).toContain('so the inside of M did not react in this tick (a strong abort)')
        const weak = run(chart('go to'), [{}, { A: true, S: true }])
        expect(weak.ticks[1].values.inner).toBe(1)
        expect(describe1(weak.result, weak.ticks[1])).toContain('after the inside of M finished its reaction for this tick (a weak abort)')
    })
    it('explains when exit actions can change the transition taken (P-23) and region-by-region strong aborts (P-20)', () => {
        const p23 = compile(`scchart X {
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
}`)
        expect(p23.diagnostics.some(d => d.code === 'kieler-quirk' && /exit action writes y/.test(d.message))).toBe(true)
        const p20 = compile(`scchart X {
  output bool flag = false
  output int n = 0
  initial state M {
    region R1 {
      initial state I
      do flag = true go to J
      state J
    }
    region R2 {
      initial state K
      do n += 1 go to K
    }
  }
  if flag abort to Done
  state Done
}`)
        expect(p20.diagnostics.some(d => d.code === 'kieler-quirk' && /strong abort reads `flag`/.test(d.message))).toBe(true)
    })
})

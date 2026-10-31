// The simulator's structure features (docs-internal/semantics/structure.md): references, imports, for-regions,
// dataflow, Timed SCCharts, methods, static/global, host code. The behaviour itself is checked against KIELER by
// tests/conformance/engine.test.ts; these tests pin down the engine's API around it: provenance (TickResult ids of
// generated elements), diagnostics (codes, KIELER's texts) and the plain-English descriptions.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, describeTick } from '../../src/engine/index'

const run = (source: string, inputs: Record<string, unknown>[], files?: Record<string, string>) => {
    const r = compile(source, { files })
    const sim = createSimulation(r)
    return { r, ticks: inputs.map(i => sim.step(i as never)), sim }
}

const beep = `
scchart Beep {
  input bool second
  output bool beep = false
  initial state A
  if second do beep = true go to B
  state B
  if second do beep = false go to A
}`

describe('references (state S is C(...))', () => {
    it('runs a copy of the referenced chart, reporting its states with prefixed ids', () => {
        const { r, ticks } = run(`scchart Main {
  input bool tick
  output bool led
  initial state R is Beep(tick to second, led to beep)
}${beep}`, [{ tick: false }, { tick: true }, { tick: true }])
        expect(r.ok).toBe(true)
        expect(ticks[0].active).toEqual(['Main', 'Main.R', 'Main.R/Beep', 'Main.R/Beep.A'])
        expect(ticks[1].taken).toEqual(['Main.R/Beep.A->1'])
        expect(ticks[1].entered).toEqual(['Main.R/Beep.B'])
        expect(ticks[1].values.led).toBe(true)
        expect(ticks[2].values.led).toBe(false)
        expect(describeTick(ticks[1], r.program!, ticks[0])).toContain('Inside R (a copy of Beep, with second bound to tick): A went to B because second was true.')
    })

    it('does not count the instance\'s transitions for KIELER\'s taken counters (S-15)', () => {
        const { sim, ticks } = run(`scchart Main {
  input bool a
  output bool x = false
  initial state Start
  if a go to R
  state R is Sub(x)
  if x go to Done
  state Done
}
scchart Sub {
  output bool o
  initial state S
  do o = true go to T
  state T
}`, [{ a: false }, { a: true }, {}])
        expect(ticks[2].taken).toEqual(['Main.R/Sub.S->1', 'Main.R->1'])
        expect(sim.takenCounts(ticks[2])).toEqual([0, 1])
    })

    it('binds by the pointer, literals become locals, output initial values are entry actions', () => {
        const { ticks } = run(`scchart Main {
  output int o = 0
  int z = 7
  initial state R is Sum(1 to b, 2, o, z to a)
}
scchart Sum {
  input int a, b, c
  output int d = 5
  initial state S
  do d = a * 100 + b * 10 + c go to S
}`, [{}, {}])
        expect(ticks[0].values.o).toBe(5)
        expect(ticks[1].values.o).toBe(712)
        expect(ticks[0].log).toContainEqual(expect.objectContaining({ kind: 'write', variable: 'o', value: 5, how: 'init' }))
    })

    it('rejects an expression as an argument where KIELER does, with its message', () => {
        const r = compile(`scchart Main {
  input bool a, b
  output bool sp
  initial state R is Beep(a && b to second, sp to beep)
}${beep}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'binding-expression')!
        expect(d.kieler).toBe('A binding for the valued object reference "second" exists, but the type "de.cau.cs.kieler.kexpressions.impl.OperatorExpressionImpl" is not supported.')
        expect(d.span?.line).toBe(4)
    })

    it('rejects a chart that contains itself', () => {
        const r = compile(`scchart Loop {
  output int o
  initial state R is Loop(o)
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'recursive-reference')!
        expect(d.kieler).toBe('Recursive reference: chart Loop uses itself (Loop -> Loop).')
    })

    it('resolves charts of imported files', () => {
        const { r, ticks } = run(`import "beep"
scchart Main {
  input bool second
  output bool speaker
  initial state R is Beep(second, speaker)
}`, [{ second: true }, {}], { 'beep.sctx': beep })
        expect(r.ok).toBe(true)
        expect(ticks[1].values.speaker).toBe(true)
    })

    it('runs ref declarations concurrently with the declaring state (S-18)', () => {
        const { ticks } = run(`scchart Main {
  input bool X, Y
  output bool O
  ref And g(X, Y, O)
  region { initial state Idle }
}
scchart And {
  input bool A, B
  output bool O
  dataflow { O = A && B }
}`, [{ X: true, Y: true }, { Y: false }])
        expect(ticks.map(t => t.values.O)).toEqual([true, false])
    })

    it('inherits declarations and regions (extends, region is super)', () => {
        const { r, ticks } = run(`scchart Hold extends Base {
  input bool hold
  override region Count {
    suspend if hold
    region is super.Count
  }
}
scchart Base {
  output int o = 0
  region Count {
    initial state S
    do o++ go to S
  }
}`, [{ hold: false }, {}, { hold: true }, { hold: false }])
        expect(r.interface.map(v => v.name)).toEqual(['o', 'hold'])
        expect(ticks.map(t => t.values.o)).toEqual([0, 1, 1, 2])
    })
})

describe('for-regions', () => {
    const src = `scchart Wait {
  input int I
  output bool O = false
  initial state Waiting {
    region R for i : 1 to 3 {
      initial state W
      if I == i go to D
      final state D
    }
  }
  join to Done
  state Done { entry do O = true }
}`
    it('tracks every copy, reported by the source ids, and says which copy fired', () => {
        const { r, ticks } = run(src, [{ I: 0 }, { I: 2 }, { I: 1 }, { I: 3 }])
        expect(ticks[1].active).toEqual(['Wait', 'Wait.Waiting', 'Wait.Waiting.W', 'Wait.Waiting.D'])
        expect(describeTick(ticks[1], r.program!, ticks[0])[0]).toBe('In the copy of the for-region R with i = 2: W went to D because I == i held (I was 2).')
        expect(ticks[3].values.O).toBe(true)
        expect(ticks[3].active).toEqual(['Wait', 'Wait.Done'])
    })

    it('rejects nested for-regions and assignments to the counter', () => {
        const nested = compile(`scchart N {
  output int s = 0
  region for i : 1 to 2 {
    initial state A {
      region for j : 1 to 3 {
        initial state W
        immediate do s += j go to D
        final state D
      }
    }
  }
}`)
        expect(nested.ok).toBe(false)
        expect(nested.diagnostics.find(d => d.code === 'kieler-crash')?.kieler).toContain("Can't copy valued object")
        const assigned = compile(`scchart A {
  output int s = 0
  region for i : 1 to 2 {
    initial state W
    immediate do i = 5; s += i go to D
    final state D
  }
}`)
        expect(assigned.diagnostics.filter(d => d.code === 'for-counter-assignment')).toHaveLength(2)
    })
})

describe('dataflow', () => {
    it('evaluates every equation in every tick, sequences in order', () => {
        const { r, ticks } = run(`scchart D {
  input int I
  output int X, Y
  dataflow {
    Y = X * 2
    X = I;
    X = X * 10;
    X = X + 1
  }
}`, [{ I: 2 }, { I: 5 }])
        expect(ticks.map(t => [t.values.X, t.values.Y])).toEqual([[21, 42], [51, 102]])
        const said = describeTick(ticks[1], r.program!, ticks[0]).find(x => x.startsWith('The dataflow equations computed'))
        expect(said).toMatch(/X = 51/)
        expect(said).toMatch(/Y = 102/)
    })

    it('has ->, fby and sfby as in KIELER, with its quirks', () => {
        const { r, ticks } = run(`scchart F {
  input int I
  output int a, b, c, d
  dataflow {
    a = 0 -> I
    b = 0 fby I
    c = 1 sfby 2 sfby 3
    d = pre(I)
  }
}`, [{ I: 7 }, { I: 8 }, { I: 9 }])
        expect(ticks.map(t => [t.values.a, t.values.b, t.values.c, t.values.d])).toEqual([[0, 0, 1, 0], [8, 7, 2, 7], [9, 8, 2, 8]])
        expect(r.diagnostics.find(d => d.code === 'kieler-quirk' && d.message.includes('sfby'))?.severity).toBe('info')
    })

    it('rejects a helper type KIELER cannot serialise', () => {
        const r = compile(`scchart M {
  input int level
  output bool high
  dataflow { high = false -> (level > 3) }
}`)
        expect(r.ok).toBe(false)
        expect(r.diagnostics.find(d => d.code === 'unknown-type')?.kieler).toBe('Cannot serialize simulation interface. Unsupported type: UNKNOWN')
    })

    it('restarts a terminated instance one tick later (S-34)', () => {
        const { ticks } = run(`scchart M {
  output int O
  ref Pulse p
  dataflow { O = p.O }
}
scchart Pulse {
  output int O
  initial state S
  do O = 1 go to M
  state M
  do O = 2 go to F
  final state F
}`, [{}, {}, {}, {}, {}, {}])
        expect(ticks.map(t => t.values.O)).toEqual([0, 1, 2, 2, 1, 2])
    })
})

describe('Timed SCCharts', () => {
    const timer = `scchart Timer {
  output bool done = false
  clock t
  initial state Wait
  if t >= 300 do done = true go to Done
  final state Done
}`
    it('adds deltaT and sleepT to the interface and computes sleepT', () => {
        const { r, ticks } = run(timer, [{ deltaT: 0 }, { deltaT: 100 }, { deltaT: 100 }, { deltaT: 100 }])
        expect(r.interface.filter(v => v.name === 'deltaT' || v.name === 'sleepT').map(v => [v.name, v.input, v.output, v.type])).toEqual([['deltaT', true, false, 'float'], ['sleepT', false, true, 'float']])
        expect(ticks.map(t => t.values.sleepT)).toEqual([300, 200, 100, 1000])
        expect(ticks[3].values.done).toBe(true)
        expect(describeTick(ticks[1], r.program!, ticks[0])[0]).toBe('Time passed: the clock t advanced to 100 (deltaT = 100).')
        // deltaT's generated start value needs no note.
        expect(ticks[0].log.some(e => e.kind === 'note')).toBe(false)
    })

    it('rejects a clock tested by several concurrent regions', () => {
        const r = compile(`scchart Shared {
  output bool a = false, b = false
  clock t
  region { initial state W if t >= 100 do a = true go to D state D }
  region { initial state W if t >= 200 do b = true go to D state D }
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'shared-clock')!
        expect(d.message).toBe('Clock `t` is read by several concurrent regions of `Shared`.')
        expect(d.kieler).toContain('Cannot handle concurrent timed automata using the same clock.')
    })

    it('runs period with soft reset by default and @HardReset', () => {
        const chart = (anno: string) => `scchart P {
  output int n = 0
  initial state S {
    ${anno}
    period 300
    initial state A
    do n++ go to A
  }
}`
        const deltas = [0, 100, 100, 100, 100, 250, 250].map(deltaT => ({ deltaT }))
        expect(run(chart(''), deltas).ticks.map(t => t.values.n)).toEqual([0, 0, 0, 1, 1, 2, 3])
        expect(run(chart('@HardReset'), deltas).ticks.map(t => t.values.n)).toEqual([0, 0, 0, 1, 1, 2, 2])
    })
})

describe('methods and code effects', () => {
    it('runs methods, inlined or not, and code blocks', () => {
        const { r, ticks } = run(`scchart M {
  input int x
  output int y = 0, count = 0, s = 0
  method int sq(int v) {
    return v * v
  }
  method inc() {
    count++
  }
  method int sumTo(int limit) {
    int sum = 0
    for (int i = 0; i < limit; i++) {
      sum += i
    }
    return sum
  }
  initial state S
  immediate do y = sq(x); s = sumTo(x) go to T
  state T
  do { inc(); y = y + 1; } go to T
}`, [{ x: 3 }, { x: 4 }])
        expect(r.ok).toBe(true)
        expect([ticks[0].values.y, ticks[0].values.s]).toEqual([9, 3])
        expect([ticks[1].values.y, ticks[1].values.count]).toEqual([10, 1])
    })

    it('does not run recursive methods', () => {
        const r = compile(`scchart R {
  output int y = 0
  method int f(int n) {
    if (n <= 1) {
      return 1
    }
    return n * f(n - 1)
  }
  initial state S
  do y = f(4) go to S
}`)
        expect(r.ok).toBe(true)
        expect(r.diagnostics.find(d => d.code === 'unsupported')?.message).toContain('recursive methods')
    })
})

describe('static and global', () => {
    it('keeps statics across re-entry under KIELER\'s name', () => {
        const { ticks } = run(`scchart V {
  input bool leave
  output int kept = 0
  initial state A {
    static int visits = 0
    entry do visits++; kept = visits
  }
  if leave go to B
  state B
  go to A
}`, [{ leave: false }, { leave: true }, { leave: false }])
        expect(ticks.map(t => t.pool.V_region0_A___visits)).toEqual([1, 1, 2])
    })

    it('shares a global between instances and rejects a used global of the simulated chart', () => {
        const { ticks } = run(`scchart G {
  output int o = 0
  region { initial state R1 is Inc }
  region { initial state R2 is Inc }
}
scchart Inc {
  global int shared = 0
  initial state S
  do shared += 1 go to S
}`, [{}, {}])
        expect(ticks.map(t => t.pool.shared)).toEqual([0, 2])
        const r = compile(`scchart G2 {
  output int o = 0
  global int g = 0
  initial state S
  do g++; o = g go to S
}`)
        expect(r.ok).toBe(false)
    })
})

describe('host code', () => {
    it('is accepted but cannot run in the browser', () => {
        const r = compile(`scchart H {
  input int a
  output int x = 0
  extern "abs" absf
  initial state S
  do x = absf(a) go to S
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'unsupported')!
        expect(d.message).toBe('This chart uses extern functions, which cannot run in the browser')
        expect(createSimulation(r).step({ a: 1 }).error?.code).toBe('unsupported')
    })
})

describe('classes, structs and enums', () => {
    it('runs class instances and reports them as objects of the data pool', () => {
        const { r, ticks } = run(`scchart C {
  input bool up
  output int O = 0
  class Counter {
    int count = 2
    void add(int k) {
      count = count + k
    }
    int get() {
      return count
    }
  } c1, c2
  struct Point {
    int x
    int y
  } pt
  initial state A
  if up do c1.add(1); pt.x = pt.x + 1 go to A
  if !up do c2.add(3); O = c1.get() + c2.get() go to A
}`, [{ up: true }, { up: true }, { up: false }])
        expect(r.ok).toBe(true)
        expect(r.diagnostics.find(d => d.code === 'unsupported')).toBeUndefined()
        expect(ticks[1].pool).toMatchObject({ c1: { count: 3 }, c2: { count: 2 }, pt: { x: 1, y: 0 } })
        expect(ticks[2].values.O).toBe(8)
        // Members are not part of the chart's interface (as in KIELER's).
        expect(r.interface.map(v => v.name)).toEqual(['up', 'O'])
    })

    it('makes an enum reference an int and its values their positions', () => {
        const { r, ticks } = run(`scchart E {
  enum Bit { ZERO, ONE }
  ref Bit b = Bit.ZERO
  initial state A
  do b = Bit.ONE go to B
  state B
}`, [{}, {}])
        expect(r.interface.find(v => v.name === 'b')).toMatchObject({ type: 'int', initialValue: 0 })
        expect(ticks.map(t => t.pool.b)).toEqual([0, 1])
    })

    it('does not run host classes and host enums (they need C code)', () => {
        const r = compile(`scchart H {
  host enum Bit { ZERO, ONE }
  ref Bit b = Bit.ZERO
  initial state A
}`)
        expect(r.ok).toBe(true)
        expect(r.diagnostics.find(d => d.code === 'unsupported')?.message).toBe('This chart uses the host enum `Bit`, which cannot run in the browser')
    })
})

describe('@ClocksUseSD', () => {
    it('accepts a clock shared by concurrent regions and advances it once per tick', () => {
        const source = (annotation: string) => `${annotation}
scchart S {
  output int a = 0, b = 0
  clock t = 0
  region { initial state W
    if t >= 300 do a++ go to W }
  region { initial state V
    if t >= 500 do b++ go to V }
}`
        expect(compile(source('')).diagnostics.find(d => d.severity === 'error')?.code).toBe('shared-clock')
        const { r, ticks } = run(source('@ClocksUseSD'), [{ deltaT: 0 }, { deltaT: 200 }, { deltaT: 200 }, { deltaT: 200 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.values.t)).toEqual([0, 200, 400, 600])
        expect(ticks.map(t => [t.values.a, t.values.b])).toEqual([[0, 0], [0, 0], [1, 0], [2, 1]])
    })
})

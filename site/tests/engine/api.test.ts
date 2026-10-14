// The Simulation API (docs-internal/ARCHITECTURE.md, src/engine/sim/STATUS.md): stepping, inputs, history,
// rewind and reset, and that every TickResult field is filled in source terms.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation, describeTick, traceableVariables } from '../../src/engine/index'

const toggle = `scchart Toggle {
  input bool button
  output bool light = false

  initial state Off
    if button do light = true go to On

  state On
    if button do light = false go to Off
}`

const abro = `scchart ABRO {
  input bool A, B, R
  output bool O

  initial state ABO {
    entry do O = false

    initial state WaitAB {
      region {
        initial state wA
          if A go to dA
        final state dA
      }
      region {
        initial state wB
          if B go to dB
        final state dB
      }
    }
    do O = true join to done

    state done
  }
  if R abort to ABO
}`

function sim(source: string) {
    const result = compile(source)
    expect(result.ok, result.diagnostics.map(d => d.message).join('\n')).toBe(true)
    return { result, sim: createSimulation(result) }
}

describe('Simulation', () => {
    it('runs tick by tick; delayed transitions wait for tick 2', () => {
        const { sim: s } = sim(toggle)
        const t1 = s.step({ button: true })
        expect(t1.tick).toBe(1)
        expect(t1.values).toEqual({ button: true, light: false })
        expect(t1.taken).toEqual([])
        const t2 = s.step({})
        expect(t2.values.light).toBe(true)
        expect(t2.taken).toEqual(['Toggle.Off->1'])
        expect(s.tick).toBe(2)
        expect(s.history).toHaveLength(2)
    })

    it('keeps inputs until they change (B-9)', () => {
        const { sim: s } = sim(toggle)
        s.step({ button: false })
        const t2 = s.step({ button: true })
        const t3 = s.step()
        expect(t2.inputs.button).toBe(true)
        expect(t3.inputs.button).toBe(true)
        expect(t3.values.light).toBe(false) // On -> Off in tick 3
    })

    it('rewinds to an earlier tick and continues from there', () => {
        const { sim: s } = sim(toggle)
        const inputs = [{ button: false }, { button: true }, { button: false }, { button: true }]
        const results = inputs.map(i => s.step(i))
        s.rewind(2)
        expect(s.tick).toBe(2)
        expect(s.history).toHaveLength(2)
        const again = s.step({ button: false })
        expect(again.values).toEqual(results[2].values)
        expect(again.active).toEqual(results[2].active)
        s.rewind(0)
        expect(s.tick).toBe(0)
        expect(s.step({ button: false }).values).toEqual(results[0].values)
    })

    it('resets to before tick 1', () => {
        const { sim: s } = sim(toggle)
        s.step({ button: true })
        s.step({})
        s.reset()
        expect(s.tick).toBe(0)
        expect(s.history).toEqual([])
        expect(s.step({ button: false }).values.light).toBe(false)
    })

    it('reports active, entered and exited states with their ancestors, in source ids', () => {
        const { sim: s } = sim(abro)
        const t1 = s.step({ A: false, B: false, R: false })
        expect(t1.active).toEqual(['ABRO', 'ABRO.ABO', 'ABRO.ABO.WaitAB', 'ABRO.ABO.WaitAB.wA', 'ABRO.ABO.WaitAB.wB'])
        expect(t1.entered).toEqual(t1.active)
        expect(t1.exited).toEqual([])
        expect(t1.actions).toEqual(['ABRO.ABO!entry0'])
        const t2 = s.step({ A: true, B: true })
        expect(t2.taken).toEqual(expect.arrayContaining(['ABRO.ABO.WaitAB.wA->1', 'ABRO.ABO.WaitAB.wB->1', 'ABRO.ABO.WaitAB->1']))
        expect(t2.taken[t2.taken.length - 1]).toBe('ABRO.ABO.WaitAB->1')
        expect(t2.values.O).toBe(true)
        expect(t2.active).toEqual(['ABRO', 'ABRO.ABO', 'ABRO.ABO.done'])
        expect(t2.exited).toEqual(expect.arrayContaining(['ABRO.ABO.WaitAB', 'ABRO.ABO.WaitAB.dA', 'ABRO.ABO.WaitAB.dB']))
        const t3 = s.step({ A: false, B: false, R: true })
        expect(t3.taken).toEqual(['ABRO.ABO->1'])
        expect(t3.values.O).toBe(false)
        expect(t3.entered).toEqual(['ABRO.ABO', 'ABRO.ABO.WaitAB', 'ABRO.ABO.WaitAB.wA', 'ABRO.ABO.WaitAB.wB'])
    })

    it('logs the micro-steps of a tick in execution order', () => {
        const { sim: s } = sim(abro)
        s.step({ A: false, B: false, R: false })
        const t2 = s.step({ A: true })
        const kinds = t2.log.map(e => e.kind)
        expect(kinds).toContain('check')
        const take = t2.log.findIndex(e => e.kind === 'take')
        const exit = t2.log.findIndex(e => e.kind === 'exit')
        const enter = t2.log.findIndex(e => e.kind === 'enter')
        expect(take).toBeGreaterThanOrEqual(0)
        expect(exit).toBeGreaterThan(take)
        expect(enter).toBeGreaterThan(exit)
        expect(t2.log).toContainEqual({ kind: 'pause', state: 'ABRO.ABO.WaitAB.wB', region: 'ABRO.ABO.WaitAB:1' })
        // The strong abort's trigger is checked (in KIELER's rewritten chart, by the inner states).
        expect(t2.log).toContainEqual({ kind: 'check', transition: 'ABRO.ABO->1', result: false, reason: 'R was false', seen: [{ name: 'R', value: false }] })
    })

    it('signals: present, values and KIELER\'s pool', () => {
        const { sim: s } = sim(`scchart Sig {
  input bool a
  output signal S
  output signal int V combine +
  region {
    initial state X
    if a do S; V(2) go to X
  }
  region {
    initial state Y
    if a do V(3) go to Y
  }
}`)
        s.step({ a: true })
        const t2 = s.step({})
        expect(t2.present).toEqual({ S: true, V: true })
        expect(t2.values.V).toBe(5)
        expect(t2.values.S).toBe(true)
        expect(t2.pool).toMatchObject({ S: true, V: true, V_val: 5, V_curval: 5 })
        const emits = t2.log.filter(e => e.kind === 'emit')
        expect(emits).toContainEqual(expect.objectContaining({ kind: 'emit', signal: 'V', value: 2 }))
        expect(emits).toContainEqual(expect.objectContaining({ kind: 'emit', signal: 'S' }))
        const t3 = s.step({ a: false })
        expect(t3.present).toEqual({ S: false, V: false })
        expect(t3.values.V).toBe(5)
    })

    it('marks termination in its tick and keeps it (sticky)', () => {
        const { sim: s } = sim(`scchart T {
  output int x
  initial state A
  do x = 1 go to B
  final state B
}`)
        const t1 = s.step()
        expect(t1.terminated).toBe(false)
        const t2 = s.step()
        expect(t2.terminatedNow).toBe(true)
        expect(t2.terminated).toBe(true)
        const t3 = s.step()
        expect(t3.terminatedNow).toBe(false)
        expect(t3.terminated).toBe(true)
        expect(t3.values.x).toBe(1)
        expect(t3.taken).toEqual([])
    })

    it('stops with a runtime error on division by zero, keeping the previous values', () => {
        const { sim: s } = sim(`scchart D {
  input int a, b
  output int q
  initial state S
  do q = a / b go to S
}`)
        s.step({ a: 6, b: 3 })
        expect(s.step({}).values.q).toBe(2)
        const t3 = s.step({ b: 0 })
        expect(t3.error?.code).toBe('division-by-zero')
        expect(t3.error?.span?.line).toBe(5)
        expect(t3.values.q).toBe(2)
        expect(t3.error?.tick).toBe(3)
        expect(t3.error?.message).toBe('Division by zero: `b` is 0')
        expect(t3.error?.hint).toContain('Test that `b` is not 0 first, for example with `if b != 0`')
        const t4 = s.step({ b: 1 })
        expect(t4.error?.code).toBe('division-by-zero')
        // As in KIELER, the simulation stays stopped: later ticks repeat the error of the tick in which it stopped,
        // and the values stay those of the last tick that ran (the new input included: it was never read).
        expect(t4.error?.tick).toBe(3)
        expect(t4.error).toBe(t3.error)
        expect(t4.values).toEqual(t3.values)
        expect(s.step({ b: 2 }).error?.tick).toBe(3)
        const program = compile(`scchart D {\n  input int a, b\n  output int q\n  initial state S\n  do q = a / b go to S\n}`).program!
        expect(describeTick(t4, program)).toEqual([
            'The simulation stopped in tick 3: Division by zero: b is 0 (line 5).',
            'KIELER\'s C simulation crashes here: from this tick on it only shows the values of the tick before, and so the guide\'s simulation stops too. Test that b is not 0 first, for example with if b != 0 on the transition or around the division.',
        ])
        expect(describeTick(t4, program, undefined, { markdown: true })[0]).toBe('The simulation stopped in tick 3: Division by zero: `b` is 0 (line 5).')
        // Going back to before the error runs again.
        s.rewind(2)
        expect(s.step({ b: 3 }).error).toBeUndefined()
    })

    it('names the divisor expression of a division by zero as the chart writes it', () => {
        const divide = (expr: string) => {
            const { sim: s } = sim(`scchart D {\n  input int a, b\n  input bool c\n  output int q, k = 0\n  initial state S\n  do k++; q = a / ${expr} go to S\n}`)
            s.step({ a: 6, b: 1, c: true })
            return s.step({ b: 1, c: true }).error
        }
        expect(divide('(b - 1)')?.message).toBe('Division by zero: `b - 1` is 0')
        expect(divide('(b - 1)')?.hint).toContain('`if (b - 1) != 0`')
        expect(divide('(b * (k - 1))')?.message).toBe('Division by zero: `b * (k - 1)` is 0')
        expect(divide('pre(k)')?.message).toBe('Division by zero: `pre(k)` is 0')
    })

    it('stops with a runtime error for an index outside the array', () => {
        const { sim: s } = sim(`scchart I {
  input int i
  output int a[3]
  initial state S
  do a[i] = 1 go to S
}`)
        s.step({ i: 1 })
        expect(s.step({}).values.a).toEqual([0, 1, 0])
        const t = s.step({ i: 3 })
        expect(t.error?.code).toBe('index-out-of-range')
        expect(t.error?.message).toContain('a')
    })

    it('keeps environment values for names that are not inputs (as KIELER\'s server does)', () => {
        const { sim: s } = sim(toggle)
        const t1 = s.step({ button: false, deltaT: 500 })
        expect(t1.pool.deltaT).toBe(500)
        expect(s.step({}).pool.deltaT).toBe(500)
    })

    it('returns a simulation that reports the error for rejected charts', () => {
        const result = compile(`scchart W {
  output int x
  region { initial state A do x = 1 go to A }
  region { initial state B do x = 2 go to B }
}`)
        expect(result.ok).toBe(false)
        const s = createSimulation(result)
        const t = s.step({})
        expect(t.error?.code).toBe('write-conflict')
        expect(t.values).toEqual({})
    })

    it('counts taken transitions in KIELER\'s order', () => {
        const { sim: s } = sim(abro)
        s.step({ A: false, B: false, R: false })
        const t2 = s.step({ A: true, B: true })
        // Order: ABO->1, WaitAB->1, wA->1, wB->1 (pre-order: a state's transitions, then its inner states).
        expect(s.takenCounts(t2)).toEqual([0, 1, 1, 1])
    })

    it('describes a tick in plain English', () => {
        const { result, sim: s } = sim(toggle)
        const t1 = s.step({ button: true })
        expect(describeTick(t1, result.program!)).toEqual([
            'The chart starts in Off.',
            'button is true, but Off was entered in this tick: its transition is delayed, so it is first checked in tick 2.',
        ])
        const t2 = s.step({})
        const text = describeTick(t2, result.program!, t1)
        expect(text[0]).toBe('Off went to On because button was true.')
        expect(text).toContain('light is now true.')
        const t3 = s.step({ button: false })
        expect(describeTick(t3, result.program!, t2)).toEqual(['No transition fired: On waits for button.'])
    })
})

describe('traceableVariables: what a reader may trace', () => {
    const source = `scchart T {
  input bool a
  output int o = 0
  int top = 1
  clock t
  struct Pt { int px = 0 int py = 0 } pt
  initial state S {
    int c = 5
    signal int V combine +
    signal P
    region R {
      bool inR = false
      initial state A
        do c++; pt.px += 1; inR = !inR; V(c); P go to A
    }
  }
  if t > 1000 go to E
  state E
}`

    it('lists the interface, the members of instances and the locals of inner scopes, with scope and declared type', () => {
        const r = compile(source)
        const vars = traceableVariables(r)
        expect(vars.map(v => [v.key, v.group, v.type, v.scope.name, v.inPool])).toEqual([
            ['a', 'input', 'bool', 'T', true],
            ['o', 'output', 'int', 'T', true],
            ['top', 'local', 'int', 'T', true],
            ['t', 'time', 'clock', 'T', true],
            ['deltaT', 'time', 'float', 'T', true],
            ['sleepT', 'time', 'float', 'T', true],
            ['pt.px', 'member', 'int', 'T', false],
            ['pt.py', 'member', 'int', 'T', false],
            ['T.S$c', 'local', 'int', 'S', false],
            ['T.S$V', 'local', 'int', 'S', false],
            ['T.S$P', 'local', 'pure', 'S', false],
            ['T.S:R$inR', 'local', 'bool', 'R', false],
        ])
        expect(vars.find(v => v.key === 't')?.simulationType).toBe('float')
        expect(vars.find(v => v.key === 'deltaT')?.added).toBe(true)
        expect(vars.find(v => v.key === 'T.S$V')).toMatchObject({ name: 'V', signal: true, valued: true })
    })

    it('gives every value that is not a pool name in each tick', () => {
        const sim = createSimulation(compile(source))
        sim.step({ deltaT: 0 })
        const t2 = sim.step({ deltaT: 100 })
        expect(t2.trace).toEqual({ 'pt.px': 1, 'pt.py': 0, 'T.S$c': 6, 'T.S:R$inR': true, 'T.S$V': 6, 'T.S$P': true })
        expect(t2.values.top).toBe(1)
    })
})

describe('what each tick ran with (TickResult.ranWith)', () => {
    it('has every input as the tick read it, before the chart wrote it, by KIELER\'s names', () => {
        const { sim: s } = sim(`scchart Latch {
  input int x = 0
  input signal int V
  input signal P
  output int y = 0
  initial state A
    if x > 2 do x = 0; y++ go to A
}`)
        const t1 = s.step({ x: 1, V: 4 })
        const t2 = s.step({ x: 3 })
        const t3 = s.step({})
        expect(t1.ranWith).toEqual({ x: 1, V: true, V_val: 4, P: false })
        // The chart sets x back to 0 in tick 2: that tick ran with 3, and tick 3 with the 0 it kept.
        expect(t2.ranWith?.x).toBe(3)
        expect(t2.inputs.x).toBe(0)
        expect(t3.ranWith?.x).toBe(0)
    })

    it('replays every example run exactly when sent again tick by tick', async () => {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const root = path.resolve('src/examples')
        const files: string[] = []
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.scenario.json')) files.push(f) } }
        walk(root)
        let runs = 0
        for (const f of files) {
            const chart = f.replace(/\.scenario\.json$/, '.sctx')
            if (!fs.existsSync(chart)) continue
            const scenario = JSON.parse(fs.readFileSync(f, 'utf8')) as { ticks: { inputs?: Record<string, never> }[]; imports?: string[] }
            const imports = Object.fromEntries((scenario.imports ?? []).map(i => [path.basename(i), fs.readFileSync(path.join(path.dirname(chart), i), 'utf8')]))
            const result = compile(fs.readFileSync(chart, 'utf8'), { files: imports })
            if (!result.ok || result.diagnostics.some(d => d.code === 'unsupported')) continue
            const first = createSimulation(result)
            const history = scenario.ticks.map(t => first.step(t.inputs ?? {}))
            const again = createSimulation(result)
            const replayed = history.map(t => again.step(t.ranWith!))
            const shape = (t: (typeof history)[number]) => JSON.stringify([t.pool, t.active, t.taken, t.terminated, t.error?.message ?? null])
            expect(replayed.map(shape), chart).toEqual(history.map(shape))
            runs++
        }
        expect(runs).toBeGreaterThan(200)
    })
})

describe('for-region copies (TickResult.copies, CompileResult.forCopies)', () => {
    const seatbelts = `scchart Belts {
  input bool buckled[3]
  output bool chime = true
  initial state Checking {
    region Seat for i : 0 to 2 {
      initial state Open
        if buckled[i] go to Fastened
      final state Fastened
    }
  }
  join to Ready
  state Ready {
    entry do chime = false
  }
}`

    it('lists each for-region with its counter values, in KIELER\'s order', () => {
        const { result } = sim(seatbelts)
        expect(result.forCopies).toEqual([{ region: 'Belts.Checking:Seat', counter: 'i', values: [0, 1, 2], name: 'Seat' }])
        expect(compile(toggle).forCopies).toBeUndefined()
    })

    it('says per copy which states are active and which were entered', () => {
        const { sim: s } = sim(seatbelts)
        const t1 = s.step({ buckled: [false, true, false] })
        expect(t1.copies?.map(c => [c.value, c.active, c.entered])).toEqual([
            [0, ['Belts.Checking.Open'], ['Belts.Checking.Open']],
            [1, ['Belts.Checking.Open'], ['Belts.Checking.Open']],
            [2, ['Belts.Checking.Open'], ['Belts.Checking.Open']],
        ])
        const t2 = s.step({})
        expect(t2.copies?.map(c => [c.value, c.active, c.entered])).toEqual([
            [0, ['Belts.Checking.Open'], []],
            [1, ['Belts.Checking.Fastened'], ['Belts.Checking.Fastened']],
            [2, ['Belts.Checking.Open'], []],
        ])
        // The copies' states are reported once in active, by the region's source ids.
        expect(t2.active).toEqual(['Belts', 'Belts.Checking', 'Belts.Checking.Open', 'Belts.Checking.Fastened'])
        const t3 = s.step({ buckled: [true, true, true] })
        expect(t3.active).toEqual(['Belts', 'Belts.Ready'])
        expect(t3.copies?.every(c => c.active.length === 0)).toBe(true)
        expect(t3.copies?.map(c => c.entered)).toEqual([['Belts.Checking.Fastened'], [], ['Belts.Checking.Fastened']])
        expect(sim(toggle).sim.step({}).copies).toBeUndefined()
    })
})

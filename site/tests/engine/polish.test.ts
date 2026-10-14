// The final polish of the engine (STATUS.md, "Final polish"): the API around KIELER behaviours that the probes in
// tests/engine/kieler/rare/ check tick by tick against KIELER (backward gotos, conditionals without else, pre with a
// clock, indices outside an array), and the names describeTick, elementName and traceableVariables give.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, describeTick, elementName, traceableVariables } from '../../src/engine/index'
import type { Diagnostic } from '../../src/engine/types'

const diagnostics = (source: string, files?: Record<string, string>) => compile(source, files ? { files } : undefined).diagnostics
const byCode = (list: Diagnostic[], code: string) => list.filter(d => d.code === code)

const run = (source: string, inputs: Record<string, unknown>[], files?: Record<string, string>) => {
    const r = compile(source, files ? { files } : undefined)
    expect(r.ok).toBe(true)
    const sim = createSimulation(r)
    const ticks = inputs.map(i => sim.step(i as never))
    return { r, ticks, text: (i: number, markdown = false) => describeTick(ticks[i], r.program!, ticks[i - 1], { markdown }) }
}

describe('backward goto in a code block KIELER inlines', () => {
    it('is rejected as an instantaneous loop, at the goto', () => {
        const source = `scchart G {
  input bool start
  output int n = 0
  initial state S
    if start do {
      again:
      n++;
      if (n < 3) {
        goto again
      }
    } go to S
}`
        const r = compile(source)
        expect(r.ok).toBe(false)
        const [d] = byCode(r.diagnostics, 'instantaneous-loop')
        expect(d.message).toBe('`goto again` jumps back to `again`, a loop within the tick that KIELER cannot schedule')
        expect(d.kieler).toBe('The SCG is NOT asc-schedulable!')
        expect(d.span?.line).toBe(9)
        expect(d.hint).toContain('`for` or `while` loop')
    })

    it('in a method KIELER keeps as a C function the jump back is dropped: the method ends there', () => {
        const { ticks } = run(`scchart G {
  input bool start
  output int n = 0, m = 0
  method void bump() {
    for (int i = 0; i < 1; i++) {
      m++
    }
    again:
    n++;
    if (n % 3 != 0) {
      goto again
    }
    m += 10
  }
  initial state S
    if start do bump() go to S
}`, [{ start: false }, { start: true }, { start: true }, { start: true }])
        expect(ticks.map(t => [t.values.n, t.values.m])).toEqual([[0, 0], [1, 1], [2, 2], [3, 13]])
    })

    it('a forward goto is inlined, so its updates commute with concurrent ones', () => {
        const { ticks } = run(`scchart G {
  input bool skip
  output int a = 0, b = 0
  region R1:
    initial state S
      if true do {
        if (skip) {
          goto done
        }
        a = 1;
        done:
        b += 1
      } go to S
  region R2:
    initial state T
      if true do b += 1 go to T
}`, [{ skip: false }, { skip: true }])
        expect(ticks[1].values.b).toBe(2)
    })
})

describe('a conditional without an else part', () => {
    it('in a trigger keeps the previous result, with a kieler-quirk info', () => {
        const source = `scchart C {
  input bool c, a
  output int n = 0
  initial state S
    if (c) ? a do n++ go to S
}`
        const [d] = byCode(diagnostics(source), 'kieler-quirk')
        expect(d.severity).toBe('info')
        expect(d.message).toBe('`(c) ? a` has no else part, so when `c` is false KIELER keeps the result this trigger had when it was last computed')
        expect(d.hint).toContain('`(c) ? a : false`')
        const { ticks } = run(source, [{ c: false, a: true }, { c: true, a: true }, { c: false, a: false }, { c: true, a: false }, { c: false, a: true }])
        expect(ticks.map(t => t.values.n)).toEqual([0, 1, 2, 2, 2])
    })

    it('inside an assignment keeps the target, also nested', () => {
        const { ticks } = run(`scchart C {
  input bool c
  output int x = 3, y = 5
  initial state S
    if true do x = 1 + ((c) ? 2); y += (c) ? 1 go to S
}`, [{ c: false }, { c: false }, { c: true }])
        expect(ticks.map(t => [t.values.x, t.values.y])).toEqual([[3, 5], [4, 10], [3, 11]])
    })

    it('in print, a call on its own or an assigned index: gcc rejects it', () => {
        for (const effect of ['print((c) ? 1)', 'x[(c) ? 1] = 5']) {
            const r = compile(`scchart C {\n  input bool c\n  output int x[2]\n  initial state S\n    if true do ${effect} go to S\n}`)
            expect(r.ok, effect).toBe(false)
            const [d] = byCode(r.diagnostics, 'conditional-without-else')
            expect(d.kieler).toContain('‘__CONDSELF__’ undeclared')
            expect(d.span?.line).toBe(5)
        }
    })
})

describe('the trigger of a state that is not active', () => {
    it('is computed in every tick, as KIELER computes every condition: a division by zero there stops the simulation', () => {
        const { sim } = { sim: createSimulation(compile(`scchart T {
  input int n
  input bool start
  output int x = 0
  initial state A
    if start go to B
    do x++ go to A
  state B
    if x + 10 / n > 100 go to A
}`)) }
        const t1 = sim.step({ n: 0, start: false })
        expect(t1.error?.code).toBe('division-by-zero')
        expect(t1.error?.tick).toBe(1)
    })
})

describe('pre(x) next to pre(x, c)', () => {
    it('share one memory: the last pre in the chart decides, with a kieler-quirk info at the other', () => {
        const source = `scchart P {
  input int v
  input bool c
  output int p = 0, q = 0
  initial state S {
    immediate during do p = pre(v, c); q = pre(v)
  }
}`
        const [d] = byCode(diagnostics(source), 'kieler-quirk')
        expect(d.severity).toBe('info')
        expect(d.message).toBe('In KIELER `pre(v, c)` behaves as `pre(v)`: KIELER keeps one memory for the previous value of `v`, made for the last `pre` of `v` in the chart, `pre(v)` (line 6)')
        expect(d.span?.col).toBe(29)
        expect(d.hint).toContain('`pre(vCopy, c)`')
        const { ticks } = run(source, [{ v: 1, c: false }, { v: 2, c: true }, { v: 3, c: false }])
        expect(ticks.map(t => [t.values.p, t.values.q])).toEqual([[0, 0], [1, 1], [2, 2]])
    })
})

describe('indices outside an array', () => {
    const chart = (effect: string) => `scchart O {
  output int a[3] = {0, 0, 0}
  output int z = 0
  initial state Run
    do ${effect} go to Run
}`

    it('go where KIELER\'s C code goes: a[3] is the variable stored after a, with a warning and a note in the log', () => {
        const r = compile(chart('a[3] = 9'))
        const [w] = byCode(r.diagnostics, 'index-out-of-range')
        expect(w.severity).toBe('warning')
        expect(w.message).toBe('`a[3]` is outside `a`, which has 3 elements: KIELER\'s C code writes into `z` instead, which lies at that place in memory')
        const sim = createSimulation(r)
        sim.step({})
        const t2 = sim.step({})
        expect(t2.values.z).toBe(9)
        expect(t2.values.a).toEqual([0, 0, 0])
        const note = t2.log.find(e => e.kind === 'note')
        expect(note).toEqual(expect.objectContaining({
            text: 'a[3] is outside a, which has 3 elements: KIELER\'s C code does not check, and writes 9 into z, which is stored there.',
            markdown: '`a[3]` is outside `a`, which has 3 elements: KIELER\'s C code does not check, and writes `9` into `z`, which is stored there.',
        }))
    })

    it('past the chart\'s own variables: a runtime error, since KIELER would write into its own bookkeeping', () => {
        const r = compile(`scchart O {\n  output int a[3] = {0, 0, 0}\n  initial state Run\n    do a[3] = 9 go to Run\n}`)
        const sim = createSimulation(r)
        sim.step({})
        const t2 = sim.step({})
        expect(t2.error?.code).toBe('index-out-of-range')
        expect(t2.error?.message).toContain('where KIELER counts the transitions taken')
    })
})

describe('describeTick and elementName inside the copies of referenced charts', () => {
    const lampPanel = `scchart LampPanel {
  input bool left, right
  output bool leftLamp = false, rightLamp = false
  region {
    initial state Left is PushSwitch(left to press, leftLamp to lit)
  }
  region {
    initial state Right is PushSwitch(right to press, rightLamp to lit)
  }
}
scchart PushSwitch {
  input bool press
  output bool lit = false
  initial state Off
    if press do lit = true go to On
  state On
    if press do lit = false go to Off
}`

    it('names the copy, the chart and the binding the trigger read', () => {
        const { ticks, text, r } = run(lampPanel, [{ left: false, right: false }, { left: true }, { left: false }])
        expect(text(0)).toEqual(['The chart starts in Off (inside Left) and Off (inside Right).'])
        expect(text(1)[0]).toBe('Inside Left (a copy of PushSwitch, with press bound to left): Off went to On because press was true.')
        expect(text(1, true)[0]).toBe('Inside `Left` (a copy of `PushSwitch`, with `press` bound to `left`): `Off` went to `On` because `press` was `true`.')
        expect(text(2)).toEqual(['No transition fired: On (inside Left) waits for press and Off (inside Right) waits for press.'])
        expect(elementName('LampPanel.Left/PushSwitch.Off->1', r.program!)).toEqual({ name: 'Off → On', within: 'inside Left (a copy of PushSwitch)' })
        expect(elementName('LampPanel.Left/PushSwitch.Off', r.program!, { markdown: true })).toEqual({ name: '`Off`', within: 'inside `Left` (a copy of `PushSwitch`)' })
        expect(elementName('LampPanel.Left/PushSwitch', r.program!)).toEqual({ name: 'PushSwitch', within: 'inside Left' })
        expect(elementName('LampPanel.Left', r.program!)).toEqual({ name: 'Left' })
        expect(ticks[1].log.filter(e => e.kind === 'check').every(e => e.kind === 'check' && !!elementName(e.transition, r.program!))).toBe(true)
    })

    it('also when the referenced chart comes from an imported file', () => {
        const { text } = run(`import "switch"
scchart Hall {
  input bool switchA
  output bool hall = false
  initial state Hall is ImportedSwitch(switchA to press, hall to lit)
}`, [{ switchA: false }, { switchA: true }, { switchA: false }], {
            'switch.sctx': `scchart ImportedSwitch {
  input bool press
  output bool lit = false
  initial state Off
    if press do lit = true go to On
  state On
    if press do lit = false go to Off
}`,
        })
        expect(text(0)).toEqual(['The chart starts in Off (inside Hall).'])
        expect(text(1)[0]).toBe('Inside Hall (a copy of ImportedSwitch, with press bound to switchA): Off went to On because press was true.')
        expect(text(2)).toEqual(['No transition fired: On (inside Hall) waits for press.'])
    })
})

describe('an inlined method', () => {
    it('does not log the body\'s if tests as checks of the transition', () => {
        const { ticks } = run(`scchart Thermometer {
  input int reading
  output int shown = 0
  method int percent(int v) {
    if (v < 0) {
      return 0
    }
    if (v > 100) {
      return 100
    }
    return v
  }
  initial state Display
    do shown = percent(reading) go to Display
}`, [{ reading: 42 }, { reading: 250 }])
        expect(ticks[1].values.shown).toBe(100)
        expect(ticks[1].log.filter(e => e.kind === 'check')).toEqual([])
        expect(ticks[1].log[0]).toEqual({ kind: 'take', transition: 'Thermometer.Display->1' })
    })
})

describe('traceableVariables and for-region copies', () => {
    it('a local of a state in a for-region: one key per copy, each copy\'s value in the trace', () => {
        const r = compile(`scchart F {
  output int sum = 0
  region for i : 1 to 3 {
    initial state W {
      int k = i * 2
      initial state X
        immediate do sum += k go to Y
      final state Y
    }
  }
}`)
        const locals = traceableVariables(r).filter(v => !v.inPool)
        expect(locals.map(v => [v.key, v.name])).toEqual([
            ['F.W$k|F:0=1', 'k (i = 1)'], ['F.W$k|F:0=2', 'k (i = 2)'], ['F.W$k|F:0=3', 'k (i = 3)'],
        ])
        expect(locals[1].copy).toEqual({ region: 'F:0', counter: 'i', value: 2 })
        const t1 = createSimulation(r).step({})
        expect(locals.map(v => t1.trace[v.key])).toEqual([2, 4, 6])
    })

    it('the log has each copy\'s check, also when another copy read the same', () => {
        const { ticks } = run(`scchart S {
  input bool b[4]
  output int n = 0
  region Seat for i : b {
    initial state Open
      if b[i] do n++ go to Done
    final state Done
  }
}`, [{ b: [false, false, false, false] }, { b: [true, false, true, false] }])
        const steps = ticks[1].log.filter(e => e.kind === 'check' || e.kind === 'take').map(e => e.kind === 'check' ? e.result : 'take')
        expect(steps).toEqual([true, 'take', false, true, 'take', false])
    })
})

describe('KIELER defects the polish fuzz campaign found', () => {
    it('an array element with a variable index first in a condition loses the index in KIELER\'s C code', () => {
        const source = `scchart I {
  input int n
  input bool a
  output int y = 0
  output int ov[2] = {0, 0}
  initial state A
    if ov[n] > 0 && a do y++ go to A
}`
        const [d] = byCode(diagnostics(source), 'kieler-quirk')
        expect(d.severity).toBe('warning')
        expect(d.message).toBe("KIELER's compiled code drops the index of `ov[n]` in this condition: it tests the address of the array `ov`, which is never 0, instead of the element")
        expect(d.hint).toContain('`a && ov[n] > 0`')
        // ov is {0, 0}, but the address is not 0: the transition fires whenever a holds.
        const { ticks } = run(source, [{ n: 0, a: false }, { n: 0, a: true }, { n: 1, a: true }])
        expect(ticks.map(t => t.values.y)).toEqual([0, 1, 2])
        // A plain variable first keeps the index.
        const kept = run(source.replace('ov[n] > 0 && a', 'a && ov[n] > 0'), [{ n: 0, a: false }, { n: 0, a: true }])
        expect(kept.ticks[1].values.y).toBe(0)
        expect(byCode(kept.r.diagnostics, 'kieler-quirk')).toEqual([])
    })

    it('where gcc cannot compute with the array\'s address the chart is rejected', () => {
        const r = compile(`scchart I {\n  input int n\n  input bool a\n  output int ov[2]\n  initial state A\n    if ov[n] * 2 > 1 && a go to A\n}`)
        expect(r.ok).toBe(false)
        const [d] = byCode(r.diagnostics, 'c-array-address')
        expect(d.kieler).toContain('invalid operands to binary * (have ‘int *’ and ‘int’)')
    })

    it('two code blocks of one state with a label of the same name crash KIELER', () => {
        const r = compile(`scchart L {
  input bool a, b
  output int x = 0, y = 0
  initial state S
    if a do { if (b) { goto skip } x += 1; skip: y += 1 } go to S
    if b do { if (a) { goto skip } x += 2; skip: y += 2 } go to S
}`)
        expect(r.ok).toBe(false)
        const [d] = byCode(r.diagnostics, 'kieler-crash')
        expect(d.message).toBe("KIELER's compiler crashes on this chart: `goto skip` finds the label `skip` of another code block or method of `S`")
        expect(d.span?.line).toBe(6)
        // In two different states the labels do not meet.
        expect(compile(`scchart L {
  input bool a, b
  output int x = 0, y = 0
  initial state S
    if a do { if (b) { goto skip } x += 1; skip: y += 1 } go to T
  state T
    if b do { if (a) { goto skip } x += 2; skip: y += 2 } go to S
}`).ok).toBe(true)
    })
})

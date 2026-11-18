// Generic parameters together with dataflow instances and written schedules (docs-internal/semantics/structure.md
// S-77, with S-18a, S-27a, S-33a, S-60): the three features share KIELER's Reference processor, and the engine binds
// all of them on one replacement stack (sim/structure/replacements.ts). The behaviour is checked against KIELER by
// tests/conformance/engine.test.ts (tests/engine/kieler/generics/probe-generic-dataflow-*, probe-generic-schedule-*,
// schedules/probe-schedule-inherited-declaration*, -chart-instance-*, structure/probe-reference-empty-instance-*);
// these tests pin down the diagnostics (codes, KIELER's texts) and the values around it.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, SIMULATOR_CODES } from '@sccharts-lab/engine'

const run = (source: string, inputs: Record<string, unknown>[] = [{}, {}, {}]) => {
    const r = compile(source)
    const sim = createSimulation(r)
    return { r, ticks: inputs.map(i => sim.step(i as never)) }
}

const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')

const gain = `
scchart Gain<K is int> {
  input int a
  output int s
  dataflow { s = a * K + 1 }
}`

describe('instances of generic charts in dataflow regions', () => {
    it('keeps an instance as an object in a region that calls a method', () => {
        const { r, ticks } = run(`scchart Main {
  input int x
  output int o
  ref Gain<3> g
  method int twice(int v) { return v * 2 }
  dataflow { g.a = twice(x)  o = g.s }
}${gain}`, [{ x: 1 }, { x: 2 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.pool.g)).toEqual([{ a: 2, s: 7 }, { a: 4, s: 13 }])
        expect(ticks.map(t => t.values.o)).toEqual([7, 13])
    })

    it('wires the elements of an array of instances one by one there, and rejects them without a method call', () => {
        const array = (call: boolean) => `scchart Main {
  input int x
  output int o
  ref Gain<2> gs[2]
  method int twice(int v) { return v * 2 }
  dataflow { gs[0].a = ${call ? 'twice(x)' : 'x'}  gs[1].a = gs[0].s  o = gs[1].s }
}${gain}`
        const { r, ticks } = run(array(true), [{ x: 1 }, { x: 2 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.pool.gs)).toEqual([[{ a: 2, s: 5 }, { a: 5, s: 11 }], [{ a: 4, s: 9 }, { a: 9, s: 19 }]])
        expect(errors(array(false)).map(d => d.code)).toContain('dataflow-instance-array')
    })

    it('hands the generic arguments on to the instance of a classic region', () => {
        const { r, ticks } = run(`scchart Main {
  input int x
  output int o, p
  ref Gain<2> a
  ref Gain<5> b
  dataflow { a.a = x  b.a = x  o = a.s  p = b.s }
}${gain}`, [{ x: 1 }, { x: 2 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => [t.values.o, t.values.p])).toEqual([[3, 6], [5, 11]])
    })

    it('leaks a generic argument by name into an instance inside the instance', () => {
        const leak = (argument: string, wire: string) => `scchart Main {
  input int x, v
  output int o
  ref Mid<${argument}> m
  method int twice(int w) { return w * 2 }
  dataflow { m.x = twice(x)  o = m.r }
}
scchart Mid<N is int> {
  input int x
  output int r
  ref Leaf l
  method int id(int w) { return w }
  dataflow { ${wire}  r = l.s + id(x) }
}
scchart Leaf {
  input int N
  output int s
  dataflow { s = N + 1 }
}`
        // A literal: the port is a plain member that starts with it, and can still be wired.
        const literal = run(leak('4', ''), [{ x: 1, v: 9 }])
        expect(literal.r.ok).toBe(true)
        expect(literal.ticks[0].pool.m).toEqual({ l: { N: 4, s: 5 }, r: 7, x: 2 })
        expect(compile(leak('4', 'l.N = id(x)')).ok).toBe(true)
        // A variable: the port is that variable and no member any more.
        const variable = run(leak('v', ''), [{ x: 1, v: 9 }])
        expect(variable.ticks[0].pool.m).toEqual({ l: { s: 10 }, r: 12, x: 2 })
        const lost = errors(leak('v', 'l.N = id(x)'))
        expect(lost.map(d => d.code)).toEqual(['dataflow-instance-port'])
        expect(lost[0].message).toContain('is itself an instance')
    })

    it('says why an instance has lost a port', () => {
        const redeclared = errors(`scchart Main {
  input int x
  output int o
  ref Cell g
  method int twice(int v) { return v * 2 }
  dataflow { g.a = twice(x)  o = g.s }
}
scchart Cell {
  input int a
  output int s
  initial state A {
    int s = 5
    initial state B do s += a go to B
  }
}`)
        expect(redeclared.map(d => d.code)).toEqual(['dataflow-instance-port'])
        expect(redeclared[0].message).toContain('declares another `s` inside')
        expect(redeclared[0].kieler).toContain('The valued object reference points to a valued object (s) that is not contained in the model!')
    })

    it('treats a port of a generic type as KIELER does', () => {
        const cell = (body: string) => `
scchart Cell<T is primitive> {
  input primitive T a
  output primitive T s
  ${body}
}`
        const main = (call: boolean) => `scchart Main {
  input int x
  output int o
  ref Cell<int> g
  method int twice(int v) { return v * 2 }
  dataflow { g.a = ${call ? 'twice(x)' : 'x'}  o = g.s }
}`
        const { r, ticks } = run(main(true) + cell('initial state A do s = a + 1 go to A'), [{ x: 1 }, { x: 2 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.pool.g)).toEqual([{ a: 2, s: 0 }, { a: 4, s: 5 }])
        const crash = errors(main(false) + cell('initial state A do s = a + 1 go to A'))
        expect(crash.map(d => [d.code, d.kieler?.split(':')[0]])).toEqual([['kieler-crash', 'java.lang.ClassCastException']])
        const target = errors(main(true) + cell('dataflow { s = a + 1 }'))
        expect(target.map(d => d.code)).toEqual(['dataflow-scalar-to-reference'])
    })
})

describe('schedules of charts used as classes', () => {
    const box = `
scchart Box<N is int> {
  schedule s
  int v
  method void set(int a) schedule s 0 { v = a * N }
  method int get() schedule s 1 { return v }
}`

    it('orders the contract methods of a generic chart', () => {
        const { r, ticks } = run(`scchart Main {
  input int x
  output int o
  ref Box<3> b
  region R1 { initial state A do o = b.get() go to A }
  region R2 { initial state C do b.set(x) go to C }
}${box}`, [{ x: 1 }, { x: 2 }, { x: 3 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.values.o)).toEqual([0, 6, 9])
    })

    it('names an instance\'s schedule in a clause', () => {
        const { r, ticks } = run(`scchart Main {
  input int x
  output int o
  int w = 0
  ref Box<3> b
  region R1 { initial state A do o = w schedule b.s 1 go to A }
  region R2 { initial state C do w = x schedule b.s 0 go to C }
}${box.replace(' schedule s 0', '').replace(' schedule s 1', '')}`, [{ x: 1 }, { x: 2 }, { x: 3 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.values.o)).toEqual([0, 2, 3])
    })

    it('rejects the schedule of an array of instances and of a class inside the instance', () => {
        const array = errors(`scchart Main {
  output int o
  ref Box<3> g[2]
  region R1 { initial state A do o = g[0].get() go to A }
  region R2 { initial state C do g[1].set(1) go to C }
}${box}`)
        expect(array.map(d => [d.code, d.kieler])).toEqual([['schedule-class-array', 'Scheduling declarations in nested classes with cardinalities are not yet supported (g)']])
        const nested = errors(`scchart Main {
  output int o
  ref Holder g
  initial state A do o = g.get() go to A
}
scchart Holder {
  class K { schedule s  int v = 0 } k
  method int get() { return k.v }
}`)
        expect(nested.map(d => [d.code, d.kieler])).toEqual([['schedule-nested-class', 'Scheduling declarations in nested classes are not yet supported (s)']])
    })

    it('rejects an inherited schedule declaration, except inside a declared instance', () => {
        const base = `
scchart Sub extends Base<5> {
  input int x
  region R2 { initial state C do w += x schedule s 1 go to C }
}
scchart Base<N is int> {
  output int w
  schedule s
  region R1 { initial state A do w = N schedule s 0 go to A }
}`
        const root = errors(base.trimStart())
        expect(root.map(d => [d.code, d.kieler])).toEqual([['inherited-schedule', 'Cannot serialize simulation interface. Unsupported type: null\nCannot serialize simulation interface. Unsupported type null for variable s']])
        expect(errors(`scchart Main {\n  input int x\n  output int w\n  initial state S is Sub(x, w)\n}${base}`).map(d => d.code)).toEqual(['inherited-schedule'])
        const instance = run(`scchart Main {\n  input int x\n  output int w\n  ref Sub g(x, w)\n}${base}`, [{ x: 1 }, { x: 2 }, { x: 3 }])
        expect(instance.r.ok).toBe(true)
        expect(instance.ticks.map(t => t.values.w)).toEqual([0, 7, 8])
        expect(SIMULATOR_CODES).toContain('inherited-schedule')
    })
})

describe('an instance without fields in the pool', () => {
    const main = (body: string) => `scchart Main {
  output int o
  ref Box b
  initial state A do o = b.read() go to A
}
scchart Box {
  ${body}
}`

    it('is an empty object only while a method that stays a function is called', () => {
        const kept = run(main('method int read() { int r = 0; for (int i = 0; i < 2; i++) { r += 1 } return r }'))
        expect(kept.ticks[0].pool).toEqual({ o: 0, b: {} })
        const inlined = run(main('method int read() { return 2 }'))
        expect(inlined.ticks[0].pool).toEqual({ o: 0 })
        expect(inlined.ticks[1].values.o).toBe(2)
    })
})

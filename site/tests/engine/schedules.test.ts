// Written schedules outside dataflow (docs-internal/semantics/structure.md S-27a): clauses in code blocks and method
// bodies, on calls, the contracts of class methods and the schedules of class instances. The behaviour is checked
// against KIELER by tests/conformance/engine.test.ts (tests/engine/kieler/schedules/); these tests pin down the
// engine's side: nothing here is `unsupported` any more, and what KIELER rejects has a diagnostic of its own.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '@sccharts-lab/engine'

const run = (source: string, ticks = 2) => {
    const r = compile(source)
    const sim = createSimulation(r)
    return { r, ticks: Array.from({ length: ticks }, () => sim.step({})) }
}
const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')
const supported = (source: string) => !compile(source).diagnostics.some(d => d.code === 'unsupported')

const contracts = (set: number, get: number) => `scchart Contracts {
  output int o
  class C {
    schedule s
    int v = 0
    void set(int x) schedule s ${set} { v = x }
    int get() schedule s ${get} { return v }
  } c
  region R1 { initial state A do o = c.get() go to B state B }
  region R2 { initial state C2 do c.set(5) go to D state D }
}`

describe('schedule clauses in bodies and on calls', () => {
    it('orders a scheduled assignment inside a method against a scheduled effect', () => {
        const chart = (inner: number, outer: number) => `scchart Body {
  output int o
  schedule s
  method void setIt() { o = 1 schedule s ${inner} }
  region R1 { initial state A do setIt() go to B state B }
  region R2 { initial state C do o = 2 schedule s ${outer} go to D state D }
}`
        expect(supported(chart(1, 0))).toBe(true)
        expect(run(chart(1, 0)).ticks[1].values.o).toBe(1)
        expect(run(chart(0, 1)).ticks[1].values.o).toBe(2)
    })

    it('passes the clause of a call to the body KIELER copies into place, and not into a C function', () => {
        const chart = (body: string) => `scchart Call {
  output int o
  schedule s
  method void setIt() { ${body} }
  region R1 { initial state A do setIt() schedule s 1 go to B state B }
  region R2 { initial state C do o = 2 schedule s 0 go to D state D }
}`
        expect(run(chart('o = 1')).ticks[1].values.o).toBe(1)
        expect(errors(chart('for (int i = 0; i < 2; i++) { o = 1 }')).map(d => d.code)).toEqual(['write-conflict'])
    })

    it('drops the clause of a call with exactly one argument, as KIELER does', () => {
        const chart = (call: string, method: string) => `scchart OneArgument {
  output int o
  schedule s
  method void f(${method}) { o = a }
  region R1 { initial state A do ${call} schedule s 1 go to B state B }
  region R2 { initial state C do o = 2 schedule s 0 go to D state D }
}`
        expect(errors(chart('f(1)', 'int a')).map(d => d.code)).toEqual(['write-conflict'])
        expect(compile(chart('f(1, 0)', 'int a, int b')).ok).toBe(true)
        // The lost clause's names are never looked up.
        expect(compile('scchart U { output int o method void f(int a) { o = a } initial state A do f(1) schedule nosuch 1 go to B state B }').ok).toBe(true)
    })

    it('refuses a scheduled trigger that calls a short method of the chart', () => {
        const [d] = errors(`scchart Trigger {
  output int o
  int x
  schedule s
  method bool pos() { return x > 0 }
  initial state A if pos() schedule s 1 do o = 1 go to B state B
}`)
        expect(d.code).toBe('schedule-inlined-call')
        expect(d.kieler).toBe('User schedules are not supported in combination with method inlining!')
        expect(d.hint).toBeTruthy()
        expect(d.span).toBeTruthy()
    })
})

describe('contracts and the schedules of instances', () => {
    it('orders the calls of contract methods by their priorities', () => {
        expect(supported(contracts(0, 1))).toBe(true)
        expect(run(contracts(0, 1)).ticks[1].values.o).toBe(5)
        expect(run(contracts(1, 0)).ticks[1].values.o).toBe(0)
    })

    it('gives every instance its own schedule (schedule c.s N)', () => {
        const chart = (other: string) => `scchart Instances {
  output int o
  class C { schedule s  int v = 0 } c, d
  region R1 { initial state A do o = 1 schedule c.s 1 go to B state B }
  region R2 { initial state C2 do o = 2 schedule ${other}.s 0 go to D state D }
}`
        expect(run(chart('c')).ticks[1].values.o).toBe(1)
        expect(errors(chart('d')).map(d => d.code)).toEqual(['write-conflict'])
    })

    it('rejects two concurrent calls at one conflicting priority, through the object', () => {
        const [d] = errors(`scchart SamePriority {
  output int o, p
  class C {
    schedule s
    int v = 0
    int get() schedule s 0 { int r = 0; for (int i = 0; i < 1; i++) { r = v } return r }
  } c
  region R1 { initial state A do o = c.get() go to B state B }
  region R2 { initial state C2 do p = c.get() go to D state D }
}`)
        expect(d.code).toBe('schedule-conflict')
        expect(d.message).toContain('the same priority (0) of the schedule `c.s`')
        expect(d.kieler).toBe('The SCG is NOT asc-schedulable!')
    })

    it('reports what KIELER refuses about contracts and class schedules', () => {
        const crash = errors('scchart M { output int o schedule s method void setIt() schedule s 1 { o = 1 } initial state A do setIt() go to B state B }')
        expect(crash.map(d => d.code)).toEqual(['kieler-crash'])
        expect(crash[0].kieler).toContain('java.lang.NullPointerException')
        // Not called: the schedule on the declaration is never read.
        expect(compile('scchart M { output int o schedule s method void setIt() schedule s 1 { o = 1 } initial state A do o = 2 go to B state B }').ok).toBe(true)

        const never = errors(contracts(0, 1).replace('do c.set(5) ', ''))
        expect(never.map(d => d.code)).toEqual(['contract-never-called'])
        expect(never[0].kieler).toBe('Referring to scheduling directive in classes without reference to instance (c)')

        const nested = errors('scchart N { output int o class Outer { class C { schedule s  int v = 0 } c } a initial state A }')
        expect(nested.map(d => d.code)).toEqual(['schedule-nested-class'])
        expect(nested[0].kieler).toBe('Scheduling declarations in nested classes are not yet supported (s)')

        const array = errors('scchart N { output int o class C { schedule s  int v = 0 } cs[2] initial state A }')
        expect(array.map(d => d.code)).toEqual(['schedule-class-array'])
        expect(array[0].kieler).toBe('Scheduling declarations in nested classes with cardinalities are not yet supported (cs)')

        const inside = errors('scchart N { output int o class C { schedule s  int v = 0  void set(int x) { v = x schedule s 0 } } c initial state A do c.set(1) go to B state B }')
        expect(inside.map(d => d.code)).toEqual(['schedule-without-instance'])
        for (const d of [...crash, ...never, ...nested, ...array, ...inside]) {
            expect(d.hint).toBeTruthy()
            expect(d.span).toBeTruthy()
        }
    })
})

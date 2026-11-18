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

// What an independent review found (each chart is a recorded probe too: probe-schedule-ref-*, -init-arg-*,
// -cfn-cond-call*, -contract-other-*, -not-a-schedule-*, -class-schedule-value*). Most came from checks made while
// lowering, before a chart used through `ref Sub x` is the class of `x`.
describe('charts used as classes, and where KIELER makes its checks', () => {
    const codes = (source: string) => errors(source).map(d => d.code)
    const through = (sub: string, effect = 'o = 1', decl = 'ref Sub x') => `scchart Test { output int o ${decl} initial state A do ${effect} go to B state B }\nscchart Sub { ${sub} }`

    it('refuses the schedule of an array of chart instances instead of failing in the first tick', () => {
        const array = errors(through('schedule s int v', 'o = 1', 'ref Sub x[2]'))
        expect(array.map(d => d.code)).toEqual(['schedule-class-array'])
        expect(array[0].kieler).toBe('Scheduling declarations in nested classes with cardinalities are not yet supported (x)')
        // Without a schedule KIELER runs the array; the engine says it cannot, and every step reports that.
        const plain = compile(through('int v', 'o = 1', 'ref Sub x[2]'))
        expect(plain.ok).toBe(true)
        expect(plain.diagnostics.map(d => d.code)).toContain('unsupported')
        expect(createSimulation(plain).step({}).error?.code).toBe('unsupported')
    })

    it('names the schedule of a chart instance (schedule x.s N)', () => {
        const chart = (a: number, b: number, sub = 'schedule s') => `scchart Test {
  output int o
  ref Sub x
  region R { initial state A do o = 1 schedule x.s ${a} go to B state B }
  region S { initial state C do o = 2 schedule x.s ${b} go to D state D }
}
scchart Sub { ${sub} }`
        expect(run(chart(1, 0)).ticks[1].values.o).toBe(1)
        expect(run(chart(0, 1)).ticks[1].values.o).toBe(2)
        expect(run(chart(1, 0, 'private schedule s')).ticks[1].values.o).toBe(1)
        // A chart with nothing but a schedule leaves no object in KIELER's data pool.
        expect(run(chart(1, 0)).ticks[1].values).toEqual({ o: 1 })
        // After `x.` a schedule clause sees schedules only.
        expect(codes(chart(1, 0, 'int s'))).toEqual(['unknown-variable', 'unknown-variable'])
    })

    it('counts a chart used as a class as a class around what it declares', () => {
        const nested = errors(through('class Inner { schedule s int v } c'))
        expect(nested.map(d => d.code)).toEqual(['schedule-nested-class'])
        expect(nested[0].kieler).toBe('Scheduling declarations in nested classes are not yet supported (s)')
        // Three levels: KIELER does not look that far.
        expect(compile(through('class A1 { class B1 { schedule s int v } b } a')).ok).toBe(true)
        // Referenced by a state, the chart's class is at the first level.
        expect(compile('scchart Test { output int o initial state A is Sub }\nscchart Sub { class Inner { schedule s int v } c }').ok).toBe(true)
    })

    it('refuses the chart\'s own schedule in its methods and accepts it on its transitions', () => {
        const statement = errors(through('schedule s int v method void set() { v = 1 schedule s 0 }', 'x.set()'))
        expect(statement.map(d => d.code)).toEqual(['schedule-without-instance'])
        expect(statement[0].kieler).toBe('Referring to scheduling directive in classes without reference to instance (x)')
        expect(codes(through('schedule s int v method void set() { v = 1 schedule s 0 }'))).toEqual(['schedule-without-instance'])
        expect(codes(through('schedule s int v method void set() schedule s 0 { v = 1 } method void run() { set() }', 'x.run()'))).toEqual(['contract-sibling-call'])
        expect(compile(through('schedule s int v initial state P do v = 1 schedule s 0 go to Q state Q')).ok).toBe(true)
    })

    it('refuses a class\'s schedule read as a value, and a schedule read as a value anywhere', () => {
        const inside = errors('scchart T { output int o class C { schedule s int v void set() { v = s } } c initial state A do c.set() go to B state B }')
        expect(inside.map(d => d.code)).toEqual(['schedule-without-instance'])
        expect(inside[0].kieler).toBe('Referring to scheduling directive in classes without reference to instance (c)')
        const value = errors('scchart T { output int o schedule s initial state A do o = s go to B state B }')
        expect(value.map(d => d.code)).toEqual(['schedule-value'])
        expect(value[0].kieler).toContain('has no member named ‘s’')
        // A method nobody calls gets no C code.
        expect(compile('scchart T { output int o schedule s method void never() { o = s } initial state A do o = 1 go to B state B }').ok).toBe(true)
    })

    it('puts a contract on the outermost call of an initial value', () => {
        const chart = (wrap: string) => `scchart Test {
  output int o
  class C { schedule s int get() schedule s 0 { return 3 } } c
  method int wrap(int x) { ${wrap} }
  initial state A do { int k = wrap(c.get()); o = k } go to B state B
}`
        expect(run(chart('for (int i = 0; i < 1; i++) { x += 1 } return x')).ticks[1].values.o).toBe(4)
        expect(codes(chart('return x'))).toContain('schedule-inlined-call')
    })

    it('refuses a scheduled condition that is a call of a short method, in the bodies KIELER works on', () => {
        const chart = (cond: string, call = 'inner()') => `scchart T {
  output int o
  schedule s
  method bool yes() { return true }
  method void inner() { for (int i = 0; i < 1; i++) { if ${cond} { o = 1 } } }
  method void outer() { for (int i = 0; i < 1; i++) { inner() } }
  initial state A do ${call} go to B state B
}`
        const refused = errors(chart('yes() schedule s 0'))
        expect(refused.map(d => d.code)).toEqual(['schedule-inlined-call'])
        expect(refused[0].kieler).toBe('User schedules are not supported in combination with method inlining!')
        expect(codes(chart('yes() schedule s 0', 'outer()'))).toEqual(['schedule-inlined-call'])
        expect(compile(chart('yes()')).ok).toBe(true)
        expect(compile(chart('yes() && o == 0 schedule s 0')).ok).toBe(true)
        expect(compile(chart('yes() schedule s 0', 'o = 2')).ok).toBe(true)
    })

    it('refuses a contract that is not its own class\'s schedule named alone, once the method is called', () => {
        const chart = (effect: string) => `scchart T { output int o class C { schedule s int v } c method void set() schedule c.s 0 { o = 1 } initial state A do ${effect} go to B state B }`
        const crash = errors(chart('set()'))
        expect(crash.map(d => d.code)).toEqual(['kieler-crash'])
        expect(crash[0].kieler).toContain('PolicyClassDeclarationImpl cannot be cast')
        expect(compile(chart('o = 2')).ok).toBe(true)
        expect(codes('scchart T { output int o class C { schedule s int v } c class D { void set() schedule c.s 0 { o = 1 } } d initial state A do d.set() go to B state B }')).toEqual(['kieler-crash'])
    })

    it('crashes on a clause that names no schedule only where KIELER makes an access with it', () => {
        const chart = (body: string) => `scchart Test { output int o int s method void inner() { o = 1 schedule s 0 } method void outer() { inner() } ${body} }`
        const transitive = errors(chart('initial state A do outer() go to B state B'))
        expect(transitive.map(d => d.code)).toEqual(['kieler-crash'])
        expect(transitive[0].kieler).toContain('VariableDeclarationImpl cannot be cast')
        expect(compile(chart('initial state A do o = 2 go to B state B')).ok).toBe(true)
        expect(compile(chart('initial state A do print("test") schedule s 0 go to B state B')).ok).toBe(true)
        expect(codes(chart('initial state A do print(o) schedule s 0 go to B state B'))).toEqual(['kieler-crash'])
        expect(compile(chart('initial state A do o = 2 go to B state B state X do o = 1 schedule s 0 go to B')).ok).toBe(true)
        // A state's clause reaches the counter of the transition inside it.
        expect(codes(chart('initial state A schedule s 0 { initial state P do print("test") go to Q state Q }'))).toEqual(['kieler-crash'])
    })
})

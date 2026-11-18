// pre(...) in the bodies of methods and code blocks (concurrency.md PRE-6): KIELER's Pre processor walks them as it
// walks triggers and effects. What runs, which pre makes the memory, and what KIELER rejects there. Every case has a
// recorded probe in tests/engine/kieler/pre/; these tests pin the diagnostics' words and places.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '@sccharts-lab/engine'
import type { Diagnostic } from '@sccharts-lab/engine/types'

const errors = (source: string): Diagnostic[] => compile(source).diagnostics.filter(d => d.severity === 'error')

function run(source: string, inputs: Record<string, unknown>[]) {
    const r = compile(source)
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    const sim = createSimulation(r)
    return inputs.map(i => sim.step(i as never))
}

const N = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]
const chart = (declarations: string, transition = 'do x = n; o = last() go to A') => `scchart Main {
  input int n
  input bool c
  output int o
  int x = 2
  ${declarations}
  initial state A
  ${transition}
}`

describe('pre in a method body', () => {
    it('reads the memory of the declaring state: a short method, a C function, a condition', () => {
        const values = (source: string) => run(source, N).map(t => t.values.o)
        expect(values(chart('method int last() { return pre(x) + 1 }'))).toEqual([0, 3, 3, 4])
        expect(values(chart('method int last() { int t = 0; for (int j = 0; j < 2; j++) { t += pre(x) } return t }'))).toEqual([0, 4, 4, 6])
        expect(values(chart('method int last() { if (pre(x) > 1) { return 5 } return 6 }'))).toEqual([0, 5, 5, 5])
        expect(run(chart('method int last() { return pre(x) + 1 }'), N).every(t => !t.error)).toBe(true)
    })

    it('a code block is a method of the state: the same memory', () => {
        expect(run(chart('', 'do x = n; { o = pre(x) + 1 } go to A'), N).map(t => t.values.o)).toEqual([0, 3, 3, 4])
    })

    it('a method nobody calls still makes the memory, which does not keep the chart from terminating', () => {
        const source = (body: string) => `scchart Main {
  input int n
  output int o
  int x = 2
  method int last() { return ${body} }
  initial state A
  do x = n; o = x go to B
  final state B
}`
        expect(run(source('x + 1'), N).map(t => t.terminated)).toEqual([false, true, true, true])
        expect(run(source('pre(x) + 1'), N).map(t => t.terminated)).toEqual([false, true, true, true])
    })

    it('the last pre in KIELER\'s order makes the memory: a code block is a declaration and comes before the effects', () => {
        const C = [{ n: 1, c: true }, { n: 2, c: false }, { n: 3, c: false }, { n: 4, c: true }, { n: 5, c: false }]
        // Written after the clocked effect, the block's pre(x) still comes first: the effect's clock is the memory's.
        const clocked = compile(chart('int y', 'do x = n; y = pre(x, c); { o = pre(x) + 1 } go to A'))
        expect(clocked.ok).toBe(true)
        const sim = createSimulation(clocked)
        expect(C.map(i => sim.step(i).values.o)).toEqual([0, 1, 1, 3, 3])
        expect(clocked.diagnostics.find(d => d.code === 'kieler-quirk')?.message).toContain('In KIELER `pre(x)` behaves as `pre(x, c)`')
        // A method's pre(x, c) and a trigger's pre(x): the trigger comes later, no clock.
        expect(run(chart('method int last() { return pre(x, c) + 1 }', 'if pre(x) > 0 do x = n; o = last() go to A'), C).map(t => t.values.o)).toEqual([0, 3, 3, 4, 5])
    })

    it('pre(val(S)) and val(S) in a body: the Signal pass replaces val there too', () => {
        const ticks = run(`scchart Main {
  input int n
  output int o
  signal int S
  method int last() { return pre(val(S)) + val(S) }
  region {
    initial state A
    do o = last() go to A
  }
  region {
    initial state B
    if n > 1 do S(n) go to B
  }
}`, N)
        expect(ticks.map(t => t.values.o)).toEqual([0, 2, 5, 7])
    })

    it('the memory of a static variable is static: in the data pool, and not started again', () => {
        const ticks = run(`scchart Main {
  input int n
  output int o
  static int s = 5
  method int last() { return pre(s) + 1 }
  initial state A
  do s = n; o = last() go to A
}`, N)
        expect(ticks[1].pool).toMatchObject({ Main____pre_s: 5, Main____reg_s: 2, Main___s: 2, o: 6 })
    })
})

describe('where KIELER cannot replace a pre in a body', () => {
    it('a whole return value, condition or initial value: pre-placement, called or not', () => {
        const [ret] = errors(chart('method int last() { return pre(x) }'))
        expect(ret.code).toBe('pre-placement')
        expect(ret.message).toBe('`pre(x)` cannot be used directly in a return statement')
        expect(ret.kieler).toBe('Pre expressions are only supported in assignments, triggers and other pre expressions')
        expect(ret.hint).toContain('`prev = pre(x)`, and return that variable')
        expect(ret.span?.line).toBe(6)

        const [cond] = errors(chart('bool f\n  method int last() { if (pre(f)) { return 1 } return 2 }', 'do o = x go to A'))
        expect(cond.message).toBe('`pre(f)` cannot be used here')
        expect(cond.hint).toContain('`pre(f) == true`')

        const [init] = errors(chart('', 'do x = n; { int y = pre(x); o = y } go to A'))
        expect(init.message).toBe('`pre(x)` cannot be used in the declaration of `y`')
        expect(init.hint).toContain('`y = pre(x)`')

        expect(errors(chart('method int last() { while (pre(x) > 9) { } return 1 }'))).toEqual([])
        expect(errors(chart('int a[3]\n  method int last() { return a[pre(x)] }'))).toEqual([])
    })

    it('pre of a local variable: KIELER\'s compiler fails', () => {
        const [d] = errors(chart('method int last() { int y = x; return pre(y) + 1 }'))
        expect(d.code).toBe('kieler-crash')
        expect(d.message).toBe('KIELER cannot take `pre` of `y`, a local variable of the method `last`: its compiler fails')
        expect(d.kieler).toBe('java.lang.IllegalArgumentException: Can\'t copy valued object. Valued object is null!')
        const [block] = errors(chart('', 'do x = n; { int y = x; o = pre(y) + 1 } go to A'))
        expect(block.message).toBe('KIELER cannot take `pre` of `y`, a local variable of a code block: its compiler fails')
    })

    it('pre of a parameter: gcc finds no such variable in the chart\'s data', () => {
        const [d] = errors(chart('method int last(int v) { return pre(v) + 1 }', 'do x = n; o = last(x) go to A'))
        expect(d.code).toBe('pre-parameter')
        expect(d.message).toBe('`pre(v)` does not compile in KIELER: `v` is a parameter of the method `last`')
        expect(d.kieler).toContain('‘TickData’ has no member named ‘v’')
    })

    it('a clock that is a parameter or a local counts only for the pre that makes the memory', () => {
        const [d] = errors(chart('method int last(bool q) { return pre(x, q) + 1 }', 'do x = n; o = last(c) go to A'))
        expect(d.code).toBe('pre-parameter')
        expect(d.message).toBe('`pre(x, q)` does not compile in KIELER: its clock `q` is a parameter of the method `last`')
        // A later pre(x) makes the memory: the clock is dropped with its pre.
        expect(errors(chart('int y\n  method int last(bool q) { return pre(x, q) + 1 }', 'do x = n; o = last(c); y = pre(x) go to A'))).toEqual([])
    })

    it('a class\'s own field: rejected by its bare name, accepted through the object', () => {
        const [d] = errors(chart('class K { int v = 3 int f() { return pre(v) + 1 } } k', 'do k.v = n; o = k.f() go to A'))
        expect(d.code).toBe('pre-class-field')
        expect(d.message).toBe('`pre(v)` does not compile in KIELER: `v` is a field of `k`, named from inside its class')
        expect(d.kieler).toContain('‘TickData’ has no member named ‘v’')
        expect(d.hint).toContain('`pre(k.v)`')
        expect(run(chart('class K { int v = 3 int f() { return pre(k.v) + 1 } } k', 'do k.v = n; o = k.f() go to A'), N).map(t => t.values.o)).toEqual([0, 4, 3, 4])
        // The chart's own variable in a class method is the chart's.
        expect(run(chart('class K { int f() { return pre(x) + 1 } } k', 'do x = n; o = k.f() go to A'), N).map(t => t.values.o)).toEqual([0, 3, 3, 4])
    })

    it('a chart used as a class: its own variable is a field in its methods, not in its code blocks', () => {
        const main = 'scchart Main {\n  input int n\n  output int o\n  ref C g\n  initial state A\n  do g.x = n; o = g.y go to A\n}\n'
        const [d] = errors(`${main}scchart C {\n  int x = 2\n  int y\n  method int last() { return pre(x) + 1 }\n}`)
        expect(d.code).toBe('pre-class-field')
        expect(d.message).toBe('`pre(x)` does not compile in KIELER: `x` is a field of `g`, named from inside its class')
        expect(run(`${main}scchart C {\n  int x = 2\n  int y\n  initial state B\n  do { y = pre(x) + 1 } go to B\n}`, N).map(t => t.values.o)).toEqual([0, 3, 3, 4])
    })

    it('val(pre(S)) and a whole array in a called body are C errors, as on a transition', () => {
        const signal = (effect: string) => `scchart Main {
  input int n
  output int o
  signal int S
  method int last() { return val(pre(S)) + 1 }
  initial state A
  do S(n); ${effect} go to A
}`
        expect(errors(signal('o = last()')).map(d => d.code)).toEqual(['val-not-signal'])
        expect(errors(signal('o = n'))).toEqual([])
        const arrays = (effect: string) => chart('int a[3]\n  int b[3]\n  method void cp() { b = pre(a) }', `do a[1] = n; ${effect} go to A`)
        expect(errors(arrays('cp(); o = b[1]')).map(d => d.code)).toEqual(['array-assignment'])
        expect(errors(arrays('o = b[1]'))).toEqual([])
    })
})

describe('a pre of a value in a body', () => {
    it('is no error of the Pre processor, and a C error where it reaches the C code', () => {
        const constant = (method: string, effect: string) => `scchart Main {
  input int n
  output int o
  const int K = 4
  ${method}
  initial state A
  do ${effect} go to A
}`
        // Nobody calls the method: no C code, and `return pre(K)` is not the placement error it is for a variable.
        expect(errors(constant('method int last() { return pre(K) }', 'o = n'))).toEqual([])
        expect(errors(constant('method int last() { int t = 0; for (int j = 0; j < 2; j++) { t += pre(K) } return t }', 'o = n'))).toEqual([])
        // Called: gcc refuses pre(4), in a short method and in a C function.
        expect(errors(constant('method int last() { return pre(K) }', 'o = last()')).map(d => d.code)).toEqual(['generic-pre'])
        expect(errors(constant('method int last() { int t = 0; for (int j = 0; j < 2; j++) { t += pre(K) } return t }', 'o = last()')).map(d => d.code)).toEqual(['generic-pre'])
    })

    it('an input bound to a literal stays a variable: its pre is a memory', () => {
        const ticks = run(`scchart Main {
  input int n
  output int o
  initial state A is C(5, o)
}
scchart C {
  input int i
  output int o
  method int last() { return pre(i) + 1 }
  initial state A
  immediate do o = last() go to B
  state B
  do o = last() + 10 go to B
}`, N)
        expect(ticks.map(t => t.values.o)).toEqual([1, 16, 16, 16])
    })
})

describe('a C function that calls a short method with a local variable', () => {
    it('does not compile in KIELER: the copy\'s variable is never declared', () => {
        const [d] = errors(chart('method int tern() { int t; t = x + 1; return t }', 'do x = n; { o = tern() + 1 } go to A'))
        expect(d.code).toBe('method-inlined-local')
        expect(d.message).toBe('This code block calls `tern`, a short method with a local variable (`t`), which KIELER\'s C code cannot handle: it does not compile')
        expect(d.kieler).toContain('‘TickData’ has no member named ‘_fn<n>_tern_t’')
        // Called in an effect, the copy is in the tick and its variable is declared.
        expect(errors(chart('method int tern() { int t; t = x + 1; return t }', 'do x = n; o = tern() + 1 go to A'))).toEqual([])
        expect(errors(chart('method int tern() { return x + 1 }', 'do x = n; { o = tern() + 1 } go to A'))).toEqual([])
    })
})

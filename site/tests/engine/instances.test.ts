// Chart instances (`ref C g`), their arrays, the data pool and the trace columns (docs-internal/semantics/structure.md
// S-18b, S-60, S-60a, S-65a). The behaviour is checked against KIELER by tests/conformance/engine.test.ts and
// tests/trace/engine-traces.test.ts (tests/engine/kieler/structure/probe-instance-*, probe-class-*,
// probe-input-const-*); these tests pin down the API around it: the pool's shape, the traceable variables, the
// diagnostics' codes and KIELER's texts.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, generateC, SIMULATOR_CODES, traceableVariables } from '@sccharts-lab/engine'
import { traceColumns } from '@sccharts-lab/trace'

const run = (source: string, ticks = 2) => {
    const r = compile(source)
    const sim = createSimulation(r)
    return { r, ticks: Array.from({ length: ticks }, () => sim.step({})) }
}
const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')
const columns = (source: string) => traceColumns(compile(source)).map(c => c.name)

describe('instances declared together and dataflow regions', () => {
    const chart = (decl: string) => `scchart Main {
  int a = 9
  output int o, p
  ${decl}
  dataflow { o = c.get() }
  region R { initial state A immediate do p = d.get() go to B state B }
}
scchart Cell { input int a = 3 method int get() { return a } }`

    it('keeps the ports of every instance of the declaration', () => {
        const { ticks } = run(chart('ref Cell c, d'))
        expect(ticks[0].pool).toEqual({ a: 9, o: 3, p: 3, c: { a: 3 }, d: { a: 3 } })
    })

    it('binds an instance of another declaration by name', () => {
        const { ticks } = run(chart('ref Cell c ref Cell d'))
        expect(ticks[0].pool).toEqual({ a: 9, o: 3, p: 9, c: { a: 3 } })
    })

    it('keeps only the first one\'s ports when one of them has arguments, whichever the region uses', () => {
        expect(run(chart('ref Cell c, d(a)')).ticks[0].pool).toEqual({ a: 9, o: 3, p: 9, c: { a: 3 } })
        expect(run(chart('ref Cell d(a), c')).ticks[0].pool).toEqual({ a: 9, o: 9, p: 3, d: { a: 3 } })
    })
})

describe('initial values of class objects', () => {
    it('reads the element\'s own fields and methods in an array of instances', () => {
        const { ticks } = run(`scchart Main { output int o ref Cell c[2] initial state A do o = c[1].d go to A }
scchart Cell { int a = 4 int b = a + 2 int d = get() + b method int get() { return a * 2 } }`)
        expect(ticks[0].pool.c).toEqual([{ a: 4, b: 6, d: 14 }, { a: 4, b: 6, d: 14 }])
        expect(ticks[1].values.o).toBe(14)
    })

    it('never initialises an array of one object, of a chart or of a class, or anything inside it', () => {
        expect(run(`scchart Main { ref Box g[1] initial state A }
scchart Box { int x = 3 class C { int y = 4 } c region R { initial state B do x += 1 go to B } }`).ticks.map(t => t.pool.g)).toEqual([[{ x: 0, c: { y: 0 } }], [{ x: 1, c: { y: 0 } }]])
        expect(run('scchart Main { class C { int x = 3 } c[1], d[1][1], e[1][2] initial state A }').ticks[0].pool).toEqual({ c: [{ x: 0 }], d: [[{ x: 0 }]], e: [[{ x: 3 }, { x: 3 }]] })
        // A struct is assigned from outside.
        expect(run('scchart Main { struct T { int x = 3 } t[1] initial state A }').ticks[0].pool).toEqual({ t: [{ x: 3 }] })
    })

    it('rejects a class whose _init has nothing to do, where KIELER calls it', () => {
        const empty = errors(`scchart Main { ref Mid m initial state A }
scchart Mid { ref Cell c }
scchart Cell { method int get() { return 3 } }`)
        expect(empty.map(d => d.code)).toEqual(['empty-class-init'])
        expect(empty[0].kieler).toContain('implicit declaration of function ‘Main_Mid1__init’')
        expect(SIMULATOR_CODES.has('empty-class-init')).toBe(true)
        expect(errors('scchart Main { class O { int _h } x initial state A }').map(d => d.code)).toEqual(['empty-class-init'])
        expect(errors('scchart Main { class O { int w class C { class D { int get() { return 3 } } d } c } x initial state A }')[0].kieler).toContain('‘Main_Main_O_C__init’')
        // Not called for an array of one; a value makes the difference.
        expect(errors('scchart Main { class O { int _h } x[1] initial state A }')).toEqual([])
        expect(errors('scchart Main { class O { int _h = 2 } x initial state A }')).toEqual([])
    })
})

describe('a vector spread over an array of instances', () => {
    it('is a field assigned on entry when the class names the constant', () => {
        const { r, ticks } = run(`scchart Main { output int o ref Cell c[2]({3, 8}) initial state A do o = c[1].x + c[1].get() go to A }
scchart Cell { input const int k int x = k + 1 method int get() { return k } region R { initial state B do x += k go to B } }`, 3)
        expect(r.ok).toBe(true)
        // The initial value of x reads k before the entry action sets it.
        expect(ticks.map(t => t.pool.c)).toEqual([[{ k: 3, x: 1 }, { k: 8, x: 1 }], [{ k: 3, x: 4 }, { k: 8, x: 9 }], [{ k: 3, x: 7 }, { k: 8, x: 17 }]])
        expect(ticks.map(t => t.values.o)).toEqual([0, 17, 25])
    })

    it('is each element\'s value in its copy of the regions otherwise, without a field', () => {
        const { ticks } = run(`scchart Main { ref Box g[3]({0 to 3}) initial state A }
scchart Box { input const int i int x = 0 initial state A do x = i + 1 go to A }`)
        expect(ticks.map(t => t.pool.g)).toEqual([[{ x: 0 }, { x: 0 }, { x: 0 }], [{ x: 1 }, { x: 2 }, { x: 3 }]])
    })

    it('reports what KIELER refuses', () => {
        const box = 'scchart Box { input const int i int x = 0 initial state A do x = i go to A }'
        const size = errors(`scchart Main { ref Box g[2]({4, 7, 9}) initial state A }\n${box}`)
        expect(size.map(d => [d.code, d.kieler])).toEqual([['spread-binding', 'Cannot spread vector with different size than target array']])
        const variable = errors(`scchart Main { int y ref Box g[2]({y, 7}) initial state A }\n${box}`)
        expect(variable.map(d => [d.code, d.kieler])).toEqual([['spread-binding', 'Cannot bind non-constant variable to constant input (via spread vector)']])
        // Not an array of instances with one dimension: no spreading, and gcc's error where the constant is read.
        expect(errors(`scchart Main { ref Box g({4, 7}) initial state A }\n${box}`).map(d => d.code)).toEqual(['binding-vector'])
        for (const code of ['spread-binding', 'binding-vector']) expect(SIMULATOR_CODES.has(code)).toBe(true)
    })

    it('copies the constant into a class inside the chart that names it, as KIELER does for a single object', () => {
        const cell = (objects: string) => `scchart Main { ref Cell c[2]({3, 8}) initial state A }
scchart Cell { input const int k int x class In { int get() { return k } } ${objects} region R { initial state B do x = q.get() go to B } }`
        expect(run(cell('q')).ticks.map(t => t.pool.c)).toEqual([
            [{ q: { Cell1_k: 3 }, x: 0 }, { q: { Cell1_k: 8 }, x: 0 }], [{ q: { Cell1_k: 3 }, x: 3 }, { q: { Cell1_k: 8 }, x: 8 }],
        ])
        expect(errors(cell('q, r')).map(d => [d.code, d.kieler])).toEqual([['spread-binding', 'NOT YET SUPPORTED']])
    })

    it('runs a constant input that is bound to a value, and one of the simulated chart', () => {
        expect(run(`scchart Main { output int o ref Cell c(3) initial state A do o = c.get() go to A }
scchart Cell { input const int k method int get() { return k } }`).ticks.map(t => t.pool)).toEqual([{ o: 0 }, { o: 3 }])
        const r = compile('scchart Main { input const int k output int o initial state A do o = k go to A }')
        const sim = createSimulation(r)
        expect([sim.step({ k: 4 }).pool, sim.step({}).pool]).toEqual([{ k: 4, o: 0 }, { k: 4, o: 4 }])
    })
})

describe('which class objects are in the data pool', () => {
    const big = 'method int big() { int r = 0; for (int i = 0; i < 2; i++) { r += 1 } return r }'
    const pool = (source: string) => run(source).ticks[1].pool

    it('has an object at the top only while its class has something left', () => {
        expect(pool(`scchart Main { output int o ref Cell c initial state A do o = c.big() go to A }\nscchart Cell { ${big} }`)).toEqual({ o: 2, c: {} })
        expect(pool(`scchart Main { output int o ref Cell c[2] initial state A do o = c[1].big() go to A }\nscchart Cell { ${big} }`)).toEqual({ o: 2, c: [{}, {}] })
        expect(pool(`scchart Main { output int o ref Cell c[2] initial state A do o = 1 go to A }\nscchart Cell { ${big} }`)).toEqual({ o: 1 })
        expect(pool('scchart Main { output int o ref Cell c[2] initial state A do o = c[1].get() go to A }\nscchart Cell { method int get() { return 3 } }')).toEqual({ o: 3 })
        expect(pool('scchart Main { output int o ref Cell c initial state A do o = 1 go to A }\nscchart Cell { const int K = 4 initial state B }')).toEqual({ o: 1 })
    })

    it('keeps an object inside another one even when it is empty, unless its chart declares nothing', () => {
        const mid = (cell: string, decl = 'ref Cell c') => `scchart Main { output int o ref Mid m initial state A do o = 1 go to A }
scchart Mid { int w = 5 ${decl} }
scchart Cell { ${cell} }`
        expect(pool(mid('method int get() { return 3 }'))).toEqual({ o: 1, m: { w: 5, c: {} } })
        expect(pool(mid('method int get() { return 3 }', 'ref Cell c[2]'))).toEqual({ o: 1, m: { w: 5, c: [{}, {}] } })
        expect(pool(mid('const int K = 4 initial state B'))).toEqual({ o: 1, m: { w: 5, c: {} } })
        expect(pool(mid('initial state B'))).toEqual({ o: 1, m: { w: 5 } })
        expect(pool('scchart Main { output int o class O { int w = 5 class C { } c } x initial state A do o = 1 go to A }')).toEqual({ o: 1, x: { w: 5, c: {} } })
    })

    it('has an empty array for an array without elements, and runs KIELER\'s two copies of its regions', () => {
        const none = compile('scchart Main { output int o ref Cell c[0] }\nscchart Cell { int v }')
        expect(createSimulation(none).step({}).pool).toEqual({ o: 0, c: [] })
        expect(columns('scchart Main { output int o ref Cell c[0] }\nscchart Cell { int v }')).toEqual(['o', 'c', 'Cell1.v'])
        // KIELER's loop from 0 to -1 makes two copies: o grows by 2 a tick.
        expect(run('scchart Main { output int o ref Cell c[0](o) initial state A }\nscchart Cell { output int q initial state B do q += 1 go to B }', 3).ticks.map(t => t.values.o)).toEqual([0, 2, 4])
        // The copies of a region that names a field would write behind the array.
        const outside = compile('scchart Main { output int o ref Cell c[0] initial state A }\nscchart Cell { int v region R { initial state B do v += 1 go to B } }')
        expect(outside.ok).toBe(true)
        expect(outside.diagnostics.map(d => d.code)).toContain('unsupported')
    })

    it('gives the C generator the same objects', () => {
        const c = generateC(compile(`scchart Main { output int o ref Mid m initial state A do o = 1 go to A }
scchart Mid { int w = 5 ref Cell c[2] }
scchart Cell { method int get() { return 3 } }`))
        expect(c.ok).toBe(true)
        expect(c.poolObjects).toEqual([{ path: [{ key: 'm', dims: [] }] }, { path: [{ key: 'm', dims: [] }, { key: 'c', dims: [2] }] }])
    })
})

describe('the objects of a chart instance from outside', () => {
    it('reaches a class or struct object of the chart through the instance', () => {
        const { r, ticks } = run(`scchart Main { output int o ref Cell c[2] initial state A do o = c[1].q.w + c[1].q.get() + c[0].t.x; c[0].q.w = 9 go to A }
scchart Cell { class In { int w = 4 int get() { return w + 1 } } q struct T { int x = 6 } t }`)
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        expect(ticks[1].values.o).toBe(15)
        expect(ticks[1].pool.c).toEqual([{ q: { w: 9 }, t: { x: 6 } }, { q: { w: 4 }, t: { x: 6 } }])
    })

    it('does not show a private class, and nothing but the ports in a dataflow region', () => {
        expect(errors('scchart Main { output int o ref Cell c initial state A do o = c.q.w go to A }\nscchart Cell { private class In { int w = 4 } q }').map(d => d.code)).toContain('unknown-variable')
        expect(errors('scchart Main { output int o ref Cell c dataflow { o = c.q.w + c.q.get() } }\nscchart Cell { class In { int w = 4 int get() { return 1 } } q }').map(d => d.code)).toContain('unknown-variable')
    })

    it('rejects a member of an array of objects that is named without the array\'s index', () => {
        const codes = (source: string) => errors(source).map(d => d.code)
        expect(codes('scchart Main { output int o ref Cell c[2] initial state A do o = c.v go to A }\nscchart Cell { int v = 3 }')).toEqual(['object-array-index'])
        expect(codes('scchart Main { output int o ref Cell c[2] initial state A do o = c.get() go to A }\nscchart Cell { int v = 3 method int get() { return v } }')).toEqual(['object-array-index'])
        expect(codes('scchart Main { output int o class In { int w = 4 int get() { return w } } q[2] initial state A do o = q.get() go to A }')).toEqual(['object-array-index'])
        expect(codes('scchart Main { output int o ref Cell c[2] initial state A do o = c[1].q.w go to A }\nscchart Cell { int z class In { int w = 4 } q[2] }')).toEqual(['object-array-index'])
        expect(codes('scchart Main { output int o ref Cell c[2] initial state A do o = c[1].q[0].w go to A }\nscchart Cell { int z class In { int w = 4 } q[2] }')).toEqual([])
        expect(SIMULATOR_CODES.has('object-array-index')).toBe(true)
    })

    it('leaves a variable of a host type out of the pool and the trace columns', () => {
        const source = 'scchart Main { output int o host "int" h ref Cell c initial state A do o = 1 go to A }\nscchart Cell { host "int" g int w }'
        expect(run(source).ticks[0].pool).toEqual({ o: 0, c: { w: 0 } })
        expect(columns(source)).toEqual(['o', 'c', 'Cell1.w'])
    })
})

describe('the classes KIELER makes of chart instances', () => {
    const cell = 'scchart Cell { int v = 3 method int get() { return v } }'

    it('names them past every name of the file', () => {
        expect(columns(`scchart Main { output int o class Cell1 { int a = 2 } local ref Cell c dataflow { o = c.get() + local.a } }\n${cell}`)).toEqual(['o', 'c', 'local', 'Cell1.a', 'Cell2.v'])
        expect(columns(`scchart Main { output int o int Cell1 = 7 ref Cell c dataflow { o = c.get() + Cell1 } }\n${cell}`)).toContain('Cell2.v')
        expect(columns(`scchart Main { output int o ref Cell c region R { initial state Cell1 do o = c.get() go to Cell2 state Cell2 } }\n${cell}`)).toContain('Cell3.v')
        expect(columns(`scchart Main { output int o ref Cell c dataflow { o = c.get() } }\n${cell}\nscchart Other { class Cell1 { int a } z }`)).toContain('Cell2.v')
    })

    it('makes one class of instances declared together, also when it moves to the root', () => {
        expect(columns(`scchart Main { output int o, p initial state S { ref Cell c, d dataflow { o = c.get() p = d.get() } } }\n${cell}`)).toEqual(['o', 'p', 'Cell11.v'])
        expect(columns(`scchart Main { output int o, p initial state S { ref Cell c ref Cell d dataflow { o = c.get() p = d.get() } } }\n${cell}`)).toEqual(['o', 'p', 'Cell11.v', 'Cell21.v'])
        expect(columns(`scchart Main { output int o, p ref Cell c ref Cell d dataflow { o = c.get() p = d.get() } }\n${cell}`)).toEqual(['o', 'p', 'c', 'd', 'Cell1.v', 'Cell2.v'])
    })

    it('lists an instance inside an instance as a member of the outer class, with or without fields', () => {
        expect(columns(`scchart Main { output int o ref Mid m initial state A do o = 1 go to A }
scchart Mid { int w = 5 ref Cell c }
scchart Cell { method int get() { return 3 } }`)).toEqual(['o', 'm', 'Mid1.c', 'Mid1.w'])
    })
})

describe('fields whose names start with an underscore', () => {
    it('are traceable like any other field of a chart instance', () => {
        const r = compile(`scchart Main { output int o ref Cell c dataflow { o = c.get() } }
scchart Cell { int _a = 3 method int get() { return _a } }`)
        expect(traceableVariables(r).map(v => v.key)).toEqual(['o', 'c._a'])
        expect(traceableVariables(r).find(v => v.key === 'c._a')?.member).toEqual({ instance: 'c', member: '_a' })
        const tick = createSimulation(r).step({})
        expect(tick.trace).toEqual({ 'c._a': 3 })
        expect(tick.pool).toEqual({ o: 3, c: { _a: 3 } })
        expect(traceColumns(r).map(c => c.name)).toEqual(['o', 'c', 'Cell1._a'])
    })

    it('are traceable in an array of instances and inside another instance', () => {
        const r = compile(`scchart Main { output int o ref Mid m[2] initial state A do o = m[1].get() go to A }
scchart Mid { ref Cell c method int get() { return c._a } int w }
scchart Cell { int _a = 3 }`)
        expect(traceableVariables(r).map(v => [v.key, v.dims])).toEqual([['o', []], ['m.w', [2]], ['m.c._a', [2]]])
        expect(createSimulation(r).step({}).trace).toEqual({ 'm.c._a': [3, 3], 'm.w': [0, 0] })
    })
})

describe('what the replacement of a bound name does not reach', () => {
    it('leaves a bound input in the initial value of a method\'s local variable', () => {
        const local = errors(`scchart Main { input int i output int o ref Cell c(i) initial state A do o = c.big() go to A }
scchart Cell { input int q method int big() { int r = q; return r + 1 } }`)
        expect(local.map(d => d.code)).toEqual(['unbound-reference'])
        // Assigned in a statement, it is replaced.
        expect(errors(`scchart Main { input int i output int o ref Cell c(i) initial state A do o = c.big() go to A }
scchart Cell { input int q method int big() { int r = 0; r = q; return r + 1 } }`)).toEqual([])
    })
})

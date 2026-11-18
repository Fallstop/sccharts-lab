// What two reviews of the dataflow and generics work found (packages/engine/src/sim/STATUS.md, "Review fixes"). The
// behaviour is checked against KIELER by tests/conformance/engine.test.ts (the probes in tests/engine/kieler/dataflow,
// structure, generics, parity and codegen); these tests pin down the diagnostics around it: codes, KIELER's texts,
// and the values of a few runs.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, SIMULATOR_CODES } from '@sccharts-lab/engine'

const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')
const codes = (source: string) => errors(source).map(d => d.code)
const run = (source: string, inputs: Record<string, unknown>[] = [{}, {}]) => {
    const r = compile(source)
    expect(errors(source)).toEqual([])
    const sim = createSimulation(r)
    return inputs.map(i => sim.step(i as never))
}

describe('indices of instance members in dataflow regions', () => {
    it('drops the index of a port in the classic translation: an array port is one variable', () => {
        const ticks = run(`scchart Main {
  output int o
  ref Cell c
  ref Index ix
  dataflow { c.a[ix.n] = 7 o = c.a[1] }
}
scchart Cell { input int a[2] }
scchart Index { output int n = 1 }`)
        expect(ticks.map(t => t.values.o)).toEqual([7, 7])
        // The index is never evaluated: no division by zero, no index outside the array.
        const never = run(`scchart Main {
  input int i
  output int o
  ref Cell c
  dataflow { c.a[5] = 7 o = c.a[i / 0] }
}
scchart Cell { input int a[2] }`)
        expect(never.map(t => [t.error, t.values.o])).toEqual([[undefined, 7], [undefined, 7]])
    })

    it('rejects a chart that indexes its own array port there', () => {
        const d = errors(`scchart Main {
  output int o
  ref Cell c
  dataflow { c.a[1] = 7 o = c.s }
}
scchart Cell { input int a[2] output int s initial state A do s = a[1] go to A }`)
        expect(d.map(x => x.code)).toEqual(['dataflow-array-port'])
        expect(d[0].kieler).toContain('subscripted value is neither array nor pointer nor vector')
    })

    it('takes a call in a member\'s index for a call of the region: the instance is an object', () => {
        const ticks = run(`scchart Main {
  output int o
  ref Cell c
  method int ix() { return 1 }
  dataflow { c.a[ix()] = 7 o = c.a[1] }
}
scchart Cell { input int a[2] }`)
        expect(ticks.map(t => t.pool.c)).toEqual([{ a: [0, 7] }, { a: [0, 7] }])
    })
})

describe('dataflow for-regions', () => {
    it('run once per tick when the counter is not used', () => {
        const ticks = run('scchart Main {\n  output int o\n  method void add() { o += 1 }\n  dataflow for i : 0 to 1 { add() }\n}')
        expect(ticks.map(t => t.values.o)).toEqual([1, 2])
        // The range is not looked at.
        expect(codes('scchart Main {\n  const int N = 2\n  output int o\n  dataflow for i : 0 to N { o += 1 }\n}')).toEqual([])
    })

    it('are rejected where the counter is still named, with one of KIELER\'s messages per use', () => {
        const d = errors('scchart Main {\n  output int o\n  method int one() { return 1 }\n  dataflow for i : 0 to 1 { o = one() + i + i }\n}')
        expect(d.map(x => x.code)).toEqual(['dataflow-for'])
        expect(d[0].kieler!.split('\n')).toEqual([
            'The valued object reference points to a valued object (i) that is not contained in the model!',
            'The valued object reference points to a valued object (i) that is not contained in the model!',
            'References objects are not contained in the resource!',
        ])
    })
})

describe('a vector after a call equation', () => {
    it('drops the call', () => {
        const ticks = run('scchart Main {\n  output int o\n  method void add() { o += 1 }\n  dataflow { add() = {true} }\n}')
        expect(ticks.map(t => t.values.o)).toEqual([0, 0])
    })

    it('sets the inputs of the instance the method belongs to', () => {
        const ticks = run(`scchart Main {
  output int o
  ref Two t
  dataflow { t.poke() = {3, 4} o = t.s }
}
scchart Two { input int p, q output int s method void poke() { s += 100 } initial state A do s = p * 10 + q go to A }`)
        expect(ticks.map(t => t.pool.t)).toEqual([{ p: 3, q: 4, s: 0 }, { p: 3, q: 4, s: 34 }])
    })
})

describe('a method call in the index of an assigned member', () => {
    const chart = (index: string) => `scchart Main {
  output int o
  int arr[2] = {0, 1}
  class K { int a[2] } k
  method int ix() { return 1 }
  initial state A do k.a[${index}] = 7; o = k.a[1] go to A
}`
    it('is found as the whole index only', () => {
        expect(codes(chart('ix()'))).toEqual([])
        for (const index of ['ix() + 0', 'arr[ix()]']) {
            const d = errors(chart(index))
            expect(d.map(x => x.code), index).toEqual(['method-in-member-index'])
            expect(d[0].kieler).toContain('implicit declaration of function ‘ix’')
        }
    })
})

describe('reads in the index of an assigned member', () => {
    const chart = (reader: string, writer: string) => `scchart Main {
  output int o
  int x = 0
  int arr[2] = {0, 1}
  class K { int a[2] int w = 0 } k
  region { initial state A do ${reader} go to A }
  region { initial state B do ${writer} go to B }
}`
    const a = (reader: string, writer: string) => run(chart(reader, writer), [{}, {}, {}]).map(t => (t.pool.k as { a: number[] }).a)

    it('are ordered after a concurrent write only for a plain variable written as the whole index', () => {
        expect(a('k.a[x] += 1', 'x = 1')).toEqual([[0, 0], [0, 1], [0, 2]])
        // Not seen by KIELER's dependency analysis: the reading region is written first and uses the old value.
        expect(a('k.a[x + 0] += 1', 'x = 1')).toEqual([[0, 0], [1, 0], [1, 1]])
        expect(a('k.a[k.w] += 1', 'k.w = 1')).toEqual([[0, 0], [1, 0], [1, 1]])
        expect(a('k.a[arr[x]] += 1', 'x = 1')).toEqual([[0, 0], [1, 0], [1, 1]])
    })

    it('are a cycle with a concurrent write only where KIELER sees them', () => {
        expect(codes(chart('k.a[x] = 1', 'x = k.a[0]'))).toEqual(['causality-cycle'])
        expect(codes(chart('k.a[x + 0] = 1', 'x = k.a[0]'))).toEqual([])
    })

    it('are rewritten at every level: an instance\'s own output in the index of its assigned port', () => {
        const ticks = run(`scchart Main {
  input int n
  output int o
  ref Cell cell
  method int twice(int j) { return j * 2 }
  dataflow { cell.v[cell.w % 2] = twice(n) o = cell.v[1] }
}
scchart Cell { input int v[2] output int w = 0 initial state CA do w += 1 go to CA }`, [{ n: 1 }, { n: 2 }, { n: 3 }])
        expect(ticks.map(t => t.pool.cell)).toEqual([{ v: [2, 0], w: 0 }, { v: [4, 0], w: 1 }, { v: [4, 6], w: 2 }])
    })
})

describe('method bodies in the replacement walk', () => {
    const generic = (method: string) => `scchart Main { output int p initial state S is G<5>(p) }
scchart G<N is int> {
  output int o
  ${method}
  initial state A do o = get() go to A
}`
    it('hides a bound name inside the block that declares it only', () => {
        expect(run(generic('method int get() { for (int N = 0; N < 1; N++) { } return N }')).map(t => t.values.p)).toEqual([0, 5])
        expect(run(generic('method int get() { int r = 0 { int N = 7 r = N } return r * 100 + N }')).map(t => t.values.p)).toEqual([0, 705])
    })

    it('does not visit the initial value of a declaration in the body, except a for loop\'s own', () => {
        expect(codes(generic('method int get() { int x = N return x }'))).toEqual(['unbound-reference'])
        expect(run(generic('method int get() { int r = 0 for (int i = N; i < N + 2; i++) { r += 1 } return r * 10 + N }')).map(t => t.values.p)).toEqual([0, 25])
    })

    it('reports KIELER\'s crash on an if condition that names a local of its branch', () => {
        const d = errors(generic('method int get() { int r = 0 if (N > 4) { int N = 1 r = N } else { r = N + 100 } return r }'))
        expect(d.map(x => x.code)).toEqual(['kieler-crash'])
        expect(d[0].kieler).toContain('ConditionalImpl cannot be cast to class de.cau.cs.kieler.sccharts.Scope')
    })

    it('names the class of the value an assigned parameter stands for', () => {
        const assigned = (type: string, value: string, other: string) => errors(`scchart Main { initial state S is G<${value}> }\nscchart G<N is ${type}> { initial state A do N = ${other} go to A }`)[0].kieler
        expect(assigned('bool', 'true', 'false')).toContain('BoolValueImpl cannot be cast')
        expect(assigned('int', '3', '4')).toContain('IntValueImpl cannot be cast')
        expect(assigned('float', '1.5', '2.5')).toContain('FloatValueImpl cannot be cast')
        const base = errors('scchart Main extends G<true> { }\nscchart G<N is bool> { initial state A do N = true go to A }')[0].kieler
        expect(base).toContain('BoolValueImpl cannot be cast')
    })
})

describe('bindings on extends', () => {
    const base = 'scchart Base { input int x int y = 0 initial state A do y = x go to A }'
    it('reports KIELER\'s crash on an argument too many', () => {
        const literal = errors(`scchart Main extends Base(2, 4) { }\n${base}`)
        expect(literal.map(d => d.code)).toEqual(['kieler-crash'])
        expect(literal[0].kieler).toContain('Binding.getTargetValuedObject()" is null')
        const variable = errors(`scchart Main extends Base(a, b) { int a = 2 int b = 4 }\n${base}`)
        expect(variable[0].kieler).toContain('because "valuedObject" is null')
        // (An inner state's parameter list is checked by the validation first.)
        expect(codes(`scchart Main { initial state S extends Base(2, 4) { } }\n${base}`)).toEqual(['binding-error'])
    })

    it('rejects the whole array a two-level binding leaves in place of an element', () => {
        const d = errors(`scchart Main extends Mid(a,p) { int a[2] = {4,7} output int p }
scchart Mid extends Base(b[1],q) { input int b[2] output int q }
scchart Base { input int x output int y initial state A do y = x go to A }`)
        expect(d.map(x => x.code)).toEqual(['array-as-value'])
        expect(d[0].kieler).toContain('assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast')
    })

    it('ends a cycle of base charts with bindings in a diagnostic', () => {
        const d = errors('scchart Main { initial state S is B(1) }\nscchart B extends C(1) { input int b }\nscchart C extends B(1) { input int c }')
        expect(d.length).toBeGreaterThan(0)
        expect(d.every(x => x.code === 'inheritance-cycle')).toBe(true)
    })
})

describe('the new codes', () => {
    it('are simulator codes', () => {
        for (const code of ['dataflow-array-port', 'method-in-member-index', 'array-as-value']) expect(SIMULATOR_CODES.has(code), code).toBe(true)
    })
})

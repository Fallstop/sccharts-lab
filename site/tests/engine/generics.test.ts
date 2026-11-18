// Generic parameters (docs-internal/semantics/structure.md S-73 .. S-76) and the rest of KIELER's Inheritance
// processor (S-17, S-66): bindings on `extends`, inner states that extend a chart, `region Q is R`. The behaviour
// itself is checked against KIELER by tests/conformance/engine.test.ts (tests/engine/kieler/generics and parity);
// these tests pin down the engine's API around it: the parsed structures, name resolution, the diagnostics
// (codes, KIELER's texts) and the values of a run.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, parse, SIMULATOR_CODES } from '@sccharts-lab/engine'

const run = (source: string, inputs: Record<string, unknown>[] = [{}, {}, {}], files?: Record<string, string>) => {
    const r = compile(source, { files })
    const sim = createSimulation(r)
    return { r, ticks: inputs.map(i => sim.step(i as never)), sim }
}

const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')

const counter = `
scchart Counter<N is int> {
  output int o = 0
  initial state A do o += N go to A
}`

describe('generic parameters in the parsed model', () => {
    it('keeps the declarations as written and as structures', () => {
        const chart = parse('scchart C<N is int, T is primitive, W is Worker, V is ref Worker, X> {\n  initial state S\n}').program!.charts[0]
        expect(chart.genericParameters).toEqual(['N is int', 'T is primitive', 'W is Worker', 'V is ref Worker', 'X'])
        expect(chart.genericParameterDeclarations!.map(g => [g.valuedObject.name, g.valueType, g.typeName, g.reference])).toEqual([
            ['N', 'int', undefined, undefined], ['T', 'primitive', undefined, undefined], ['W', undefined, 'Worker', undefined],
            ['V', undefined, 'Worker', true], ['X', undefined, undefined, undefined],
        ])
        expect(chart.genericParameterDeclarations!.map(g => g.valuedObject.id)).toEqual(['C$N', 'C$T', 'C$W', 'C$V', 'C$X'])
    })

    it('keeps the arguments as written and as structures', () => {
        const chart = parse(`scchart Main extends Base<3> {
  int a[2]
  ref Counter<2> g
  ref Counter h<x>, k<a[1]>
  int x
  initial state S is Holder<4, int, true, 1.5, Box<2> >(p)
}`).program!.charts[0]
        expect(chart.baseStates![0].genericParameters).toEqual(['3'])
        expect(chart.baseStates![0].genericArguments![0].expression).toMatchObject({ kind: 'int', value: 3 })
        expect(chart.declarations[1].genericArguments!.map(a => a.text)).toEqual(['2'])
        expect(chart.declarations[2].valuedObjects.map(vo => vo.genericParameters)).toEqual([['x'], ['a[1]']])
        // A bare name is a chart, a type parameter or a variable: name resolution keeps the one it is.
        expect(chart.declarations[2].valuedObjects[0].genericArguments![0]).toMatchObject({ text: 'x', expression: { kind: 'ref', name: 'x', decl: 'Main$x' } })
        expect(chart.declarations[2].valuedObjects[0].genericArguments![0].typeName).toBeUndefined()
        expect(chart.declarations[2].valuedObjects[1].genericArguments![0].expression).toMatchObject({ kind: 'ref', name: 'a', indices: [{ kind: 'int', value: 1 }] })
        const call = chart.regions[0].states[0].reference!
        expect(call.genericParameters).toEqual(['4', 'int', 'true', '1.5', 'Box<2>'])
        expect(call.genericArguments!.map(a => a.valueType ?? a.expression?.kind ?? `type ${a.typeName}`)).toEqual(['int', 'int', 'bool', 'float', 'type Box'])
        expect(call.genericArguments![4].typeArguments![0].expression).toMatchObject({ kind: 'int', value: 2 })
    })
})

describe('name resolution of generic parameters', () => {
    it('resolves a value parameter in the chart and a bare argument to a chart, a type parameter or a variable', () => {
        const r = compile(`scchart Main {
  input int i
  output int p
  region { initial state S is Counter<i>(p) }
  region { initial state T is Holder<Fast>(p) }
}
scchart Holder<W is Worker> {
  output int q
  initial state S is W(q)
}
scchart Worker {
  output int o = 0
  initial state A do o += 1 go to A
}
scchart Fast extends Worker {
  region R2 { initial state B do o += 10 go to B }
}${counter}`)
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        const [main, holder] = r.program!.charts
        const variable = main.regions[0].states[0].reference!.genericArguments![0]
        expect(variable.typeName).toBeUndefined()
        expect(variable.expression).toMatchObject({ kind: 'ref', decl: 'Main$i' })
        const chart = main.regions[1].states[0].reference!.genericArguments![0]
        expect(chart).toMatchObject({ typeName: 'Fast' })
        expect(chart.expression).toBeUndefined()
        expect(holder.regions[0].states[0].reference!.targetParameter).toBe('Holder$W')
        expect(r.index!.vos.get('Counter$N')!.generic!.valueType).toBe('int')
    })

    it('gives KIELER\'s linking errors', () => {
        expect(errors('scchart Main {\n  output int p\n  initial state S is Counter<3>(p)\n}\nscchart Counter<N is int> {\n  output int o\n  primitive N x\n  initial state A\n}').map(d => [d.code, d.kieler]))
            .toEqual([['unknown-generic-type', "Couldn't resolve reference to EObject 'N'."]])
        expect(errors('scchart Main {\n  initial state S\n}\nscchart H<E is Color> {\n  enum Color { RED }\n  initial state A\n}').map(d => d.kieler))
            .toEqual(["Couldn't resolve reference to NamedObject 'Color'."])
        // The extending chart cannot name the base chart's parameter.
        expect(errors(`scchart Main extends Counter<3> {\n  output int p\n  region R2 { initial state B do p += N go to B }\n}${counter}`).map(d => d.kieler))
            .toEqual(["Couldn't resolve reference to ValuedObject 'N'."])
    })
})

describe('validation of generic arguments', () => {
    const main = (call: string, decls = '') => `scchart Main {\n  output int p\n${decls}  initial state S is ${call}\n}${counter}`
    const kieler = (source: string) => errors(source).map(d => [d.code, d.kieler])

    it('reports KIELER\'s binding messages', () => {
        expect(kieler(main('Counter(p)'))).toEqual([['binding-error', 'The referencing binding is erroneous!\nThere is no parameter given for generic parameter declaration of N.']])
        expect(kieler(main('Counter<1, 2>(p)'))).toEqual([['binding-error', 'The referencing binding is erroneous!\nThere is no declaration for the given generic parameter (position: 1).']])
        expect(kieler(main('Counter<true>(p)'))).toEqual([['binding-error', 'The referencing binding is erroneous!\nType mismatch! Generic parameter N of type int cannot take literal of type bool.']])
        expect(kieler(main('Counter<int>(p)'))).toEqual([['binding-error', 'The referencing binding is erroneous!\nExpressions as generic parameters are currently not allowed (ValueTypeReferenceImpl).']])
        expect(kieler(main('Counter<k>(p)', '  bool k\n'))).toEqual([['binding-error', 'The referencing binding is erroneous!\nType mismatch! Generic parameter N of type int cannot take valued object declared with type bool.']])
    })

    it('refuses a string literal, with a hint', () => {
        const [d] = errors('scchart Main {\n  output string p\n  initial state S is G<"hi">(p)\n}\nscchart G<V is string> {\n  output string o\n  initial state A do o = V go to A\n}')
        expect(d.kieler).toBe('The referencing binding is erroneous!\nType mismatch! Generic parameter V of type string cannot take literal of type UNKNOWN.')
        expect(d.hint).toContain('string variable')
    })

    it('checks ref declarations, and arguments in two places', () => {
        expect(kieler(`scchart Main {\n  output int p\n  ref Counter g(p)\n}${counter}`)[0][1]).toBe('The referencing binding is erroneous!\nThere is no parameter given for generic parameter declaration of N.')
        expect(kieler(`scchart Main {\n  output int p, q\n  ref Counter<2> g<7>(p), h(q)\n}${counter}`)).toEqual([['generic-arguments-twice', 'Cannot mix generic parameters in variables and declaration']])
    })

    it('does not bind an interface of a generic type to a variable', () => {
        const generic = '\nscchart G<T is primitive> {\n  input primitive T x\n  output int y\n  initial state A do y += x go to A\n}'
        expect(kieler(`scchart Main {\n  input int i\n  output int p\n  initial state S is G<int>(i, p)\n}${generic}`))
            .toEqual([['binding-error', 'The referencing binding is erroneous!\nCannot substitute reference of type T by valued object of type int']])
        expect(kieler(`scchart Main {\n  output int p\n  initial state S is G<int>(true, p)\n}${generic}`))
            .toEqual([['binding-error', 'The referencing binding is erroneous!\nType of literal value bool does not match generic type argument int for T']])
        expect(run(`scchart Main {\n  output int p\n  initial state S is G<int>(5, p)\n}${generic}`).ticks.map(t => t.values.p)).toEqual([0, 5, 10])
    })
})

describe('generic charts in the simulation', () => {
    it('puts a literal or a variable in the place of a value parameter', () => {
        const literal = run(`scchart Main {\n  output int p\n  initial state S is Counter<4>(p)\n}${counter}`)
        expect(literal.r.ok).toBe(true)
        expect(literal.ticks.map(t => t.values.p)).toEqual([0, 4, 8])
        expect(literal.ticks[1].taken).toEqual(['Main.S/Counter.A->1'])
        const variable = run(`scchart Main {\n  input int i\n  output int p\n  initial state S is Counter<i>(p)\n}${counter}`, [{ i: 1 }, { i: 2 }, { i: 3 }])
        expect(variable.ticks.map(t => t.values.p)).toEqual([0, 2, 5])
    })

    it('gives every instance its own argument', () => {
        const { r, ticks } = run(`scchart Main {\n  output int p, q\n  ref Counter g<2>(p), h<5>(q)\n}${counter}`)
        expect(r.ok).toBe(true)
        expect(ticks.map(t => [t.values.p, t.values.q])).toEqual([[0, 0], [2, 5], [4, 10]])
    })

    it('makes a declaration of a primitive type parameter a variable of the type', () => {
        const { ticks } = run(`scchart Main {
  output float p
  initial state S is G<float>(p)
}
scchart G<T is primitive> {
  output float o = 0
  primitive T x = 2
  initial state A do x += 1; o += x / 4 go to A
}`)
        expect(ticks.map(t => t.values.p)).toEqual([0, 0.75, 1.75])
    })

    it('instantiates the chart given for a chart type parameter, and calls an instance parameter', () => {
        const worker = `
scchart Worker {
  int n = 0
  method void inc() { n += 1 }
}
scchart Fast extends Worker {
  override method void inc() { n += 10 }
}`
        const type = run(`scchart Main {
  output int p
  initial state S is Holder<Fast>(p)
}
scchart Holder<W is Worker> {
  output int q
  ref W w
  initial state A do w.inc(); q = w.n go to A
}${worker}`)
        expect(type.ticks.map(t => t.values.p)).toEqual([0, 10, 20])
        const instance = run(`scchart Main {
  output int p
  ref Fast w
  initial state S is Holder<w>(p)
}
scchart Holder<V is ref Worker> {
  output int q
  initial state A do V.inc(); q = V.n go to A
}${worker}`)
        // The instance is the referencing chart's object in the pool; the call reaches the subtype's override.
        expect(instance.ticks.map(t => t.pool)).toMatchObject([{ p: 0, w: { n: 0 } }, { p: 10, w: { n: 10 } }, { p: 20, w: { n: 20 } }])
    })

    it('binds generic arguments and the interface on extends', () => {
        const value = run(`scchart Main extends Counter<3> {\n}${counter}`)
        expect(value.ticks.map(t => t.values)).toEqual([{ o: 0 }, { o: 3 }, { o: 6 }])
        const bound = run(`scchart Main extends Base(i, p) {
  input int i
  output int p
}
scchart Base {
  input int x
  output int o = 0
  initial state A do o += x go to A
}`, [{ i: 1 }, { i: 2 }, { i: 3 }])
        expect(bound.r.ok).toBe(true)
        // The base chart's x and o are the chart's i and p: they are gone from the pool.
        expect(bound.ticks.map(t => t.values)).toEqual([{ i: 1, p: 0 }, { i: 2, p: 2 }, { i: 3, p: 5 }])
    })

    it('runs an inner state that extends a chart, and a copy of an inherited region', () => {
        const base = `
scchart Base<N is int> {
  output int o
  region R {
    initial state S
    do o += N go to S
  }
}`
        const inner = run(`scchart Main {\n  output int p\n  initial state T extends Base<3>(p) {\n  }\n}${base}`)
        expect(inner.r.diagnostics.filter(d => d.code === 'unsupported')).toEqual([])
        expect(inner.ticks.map(t => t.values)).toEqual([{ p: 0 }, { p: 3 }, { p: 6 }])
        expect(inner.ticks[1].taken).toEqual(['Main.T/Base.S->1'])
        const copy = run(`scchart Main extends Plain {\n  region Q is R\n}\nscchart Plain {\n  output int o\n  region R {\n    initial state S\n    do o += 1 go to S\n  }\n}`)
        expect(copy.r.diagnostics.filter(d => d.code === 'unsupported')).toEqual([])
        expect(copy.ticks.map(t => t.values.o)).toEqual([0, 2, 4])
    })

    it('takes a nested chart\'s local of the parameter\'s name for the parameter, as KIELER does', () => {
        const { ticks } = run(`scchart Main {
  output int p
  initial state S is Outer<3>(p)
}
scchart Outer<N is int> {
  output int o
  initial state T is Inner(o)
}
scchart Inner {
  output int o = 0
  int N = 100
  initial state A do o += N go to A
}`)
        expect(ticks.map(t => t.values.p)).toEqual([0, 3, 6])
    })

    it('runs an array of chart instances as KIELER\'s array of class objects', () => {
        const { r, ticks } = run(`scchart Main {
  input int i
  output int p
  ref Cell<3> g[2]
  initial state A do g[i].inc(); p = g[0].n + 10 * g[1].n go to A
}
scchart Cell<N is int> {
  int n = 0
  method void inc() { n += N }
  region R { initial state S do n += 1 go to S }
}`, [{ i: 0 }, { i: 1 }, { i: 1 }])
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.pool.g)).toEqual([[{ n: 0 }, { n: 0 }], [{ n: 1 }, { n: 4 }], [{ n: 2 }, { n: 8 }]])
        expect(ticks.map(t => t.values.p)).toEqual([0, 41, 82])
        // An element wired in a dataflow region is gcc's error in KIELER.
        const dataflow = errors('scchart Main {\n  output int p\n  ref W g[2]\n  dataflow { p = g[0].o + g[1].o }\n}\nscchart W {\n  output int o = 0\n  initial state A do o += 2 go to A\n}')
        expect(dataflow.map(d => [d.code, d.kieler?.split('\n')[0]])).toEqual([['dataflow-instance-array', 'subscripted value is neither array nor pointer nor vector']])
    })

    it('resolves a generic chart of an imported file', () => {
        const { r, ticks } = run('import "counter"\nscchart Main {\n  output int p\n  initial state S is Counter<4>(p)\n}', [{}, {}, {}], { 'counter.sctx': counter })
        expect(r.ok).toBe(true)
        expect(ticks.map(t => t.values.p)).toEqual([0, 4, 8])
    })
})

describe('what KIELER rejects when it compiles a generic chart', () => {
    const codes = (source: string) => errors(source).map(d => d.code)
    const first = (source: string) => errors(source)[0]

    it('a generic chart first in the file', () => {
        const d = first(counter)
        expect([d.code, d.kieler]).toEqual(['unbound-generic', 'A root SCChart cannot have unbound generic parameters.'])
    })

    it('a parameter where KIELER does not put the argument in', () => {
        const forRange = first(`scchart Main {\n  output int p\n  initial state S is G<3>(p)\n}\nscchart G<N is int> {\n  output int o = 0\n  region R for i : 0 to N {\n    initial state A do o += i go to A\n  }\n}`)
        expect(forRange.code).toBe('unbound-reference')
        expect(forRange.kieler).toBe('The valued object reference points to a valued object (N) that is not contained in the model!\nReferences objects are not contained in the resource!')
        expect(codes(`scchart Main {\n  output int p\n  initial state S is Outer<3>(p)\n}\nscchart Outer<N is int> {\n  output int o\n  initial state T is Counter<N>(o)\n}${counter}`)).toEqual(['unbound-reference'])
        // Through extends every use is replaced.
        expect(run(`scchart Main extends G<3> {\n}\nscchart G<N is int> {\n  output int o = 0\n  region R for i : 0 to N {\n    initial state A do o += i go to A\n  }\n}`).ticks.map(t => t.values.o)).toEqual([0, 6, 12])
    })

    it('an input of a referenced chart in print', () => {
        const d = first('scchart Main {\n  output int p\n  int a = 3\n  initial state S is Sub(a, p)\n}\nscchart Sub {\n  input int x\n  output int o = 0\n  initial state A do o += x; print("v", x) go to A\n}')
        expect(d.code).toBe('unbound-reference')
        expect(d.kieler).toContain('(x) that is not contained in the model!')
    })

    it('a written parameter that stands for a literal, and pre of one', () => {
        const written = first(`scchart Main {\n  output int p\n  initial state S is G<4>(p)\n}\nscchart G<N is int> {\n  output int o = 0\n  initial state A do o += N; N += 1 go to A\n}`)
        expect(written.code).toBe('kieler-crash')
        expect(written.kieler).toContain('java.lang.ClassCastException')
        expect(codes(`scchart Main {\n  output int p\n  initial state S is G<4>(p)\n}\nscchart G<N is int> {\n  output int o = 0\n  initial state A do o += pre(N) go to A\n}`)).toEqual(['generic-pre'])
    })

    it('a written parameter or input that stands for a constant', () => {
        const generic = first('scchart Main {\n  const int K = 4\n  output int p\n  initial state S is G<K>(p)\n}\nscchart G<N is int> {\n  output int o = 0\n  initial state A do o += N; N += 1 go to A\n}')
        expect(generic.code).toBe('bound-const-written')
        expect(generic.kieler).toContain('Cannot replace left hand side of assignment by a value.')
        const input = 'scchart Sub {\n  input int x\n  output int o = 0\n  initial state A do o += x; x += 1 go to A\n}'
        expect(codes(`scchart Main {\n  const int K = 4\n  output int p\n  initial state S is Sub(K, p)\n}\n${input}`)).toEqual(['bound-const-written'])
        // A literal makes the input a local that starts with it.
        expect(run(`scchart Main {\n  output int p\n  initial state S is Sub(4, p)\n}\n${input}`).ticks.map(t => t.values.p)).toEqual([0, 4, 9])
    })

    it('pre of a parameter that stands for a value, only where code is made for it', () => {
        const generic = '\nscchart G<B is bool> {\n  output int o\n  initial state X if pre(B) do o += 100 go to X\n}'
        expect(first(`scchart Main {\n  output int p\n  initial state U is G<false>(p)\n}${generic}`).kieler).toBe('The compiler failed during compilation setup.')
        expect(compile(`scchart Main {\n  output int p\n  initial state A do p += 1 go to A\n  state U is G<false>(p)\n}${generic}`).ok).toBe(true)
    })

    it('a chart type parameter handed on, and pure for a primitive type', () => {
        expect(codes(`scchart Main {
  output int p
  initial state S is Outer<Worker>(p)
}
scchart Outer<W is Worker> {
  output int o
  initial state T is Inner<W>(o)
}
scchart Inner<V is Worker> {
  output int o
  initial state U is V(o)
}
scchart Worker {
  output int o = 0
  initial state A do o += 1 go to A
}`)).toEqual(['generic-type-unbound'])
        expect(first('scchart Main {\n  output int p\n  initial state S is G<pure>(p)\n}\nscchart G<T is primitive> {\n  output int o = 0\n  primitive T x\n  initial state A do o += 1 go to A\n}').kieler)
            .toContain('Cannot serialize simulation interface. Unsupported type: pure')
    })

    it('wrong generic arguments on extends, only when the chart is compiled', () => {
        const d = first(`scchart Main extends Counter<true> {\n}${counter}`)
        expect(d.code).toBe('generic-argument')
        expect(d.kieler).toBe('Errornous generic parameter. Paramter N of Counter was not set correcly. Type mismatch! Generic parameter N of type int cannot take literal of type bool.')
        expect(compile(`scchart Main {\n  output int o = 0\n  initial state A do o += 1 go to A\n}\nscchart Unused extends Counter<true> {\n}${counter}`).ok).toBe(true)
    })

    it('a parameter list on extends that leaves an input or output open', () => {
        const d = first('scchart Main extends Base(i) {\n  input int i\n}\nscchart Base {\n  input int x\n  output int o = 0\n  initial state A do o += x go to A\n}')
        expect(d.code).toBe('kieler-crash')
        expect(d.kieler).toContain('java.lang.NullPointerException')
        expect(d.hint).toContain('`x`, `o`')
    })

    it('state(S) in a chart copied for a referencing state, and in a base chart', () => {
        const chart = `
scchart G {
  output int o = 0
  method bool inB() { return state(R.B) }
  region R {
    initial state A do o += 1 go to B
    state B do o += 100 go to A
  }
  region Watch { initial state W if inB() do o += 1000 go to W }
}`
        expect(codes(`scchart Main {\n  output int p\n  initial state S is G(p)\n}${chart}`)).toEqual(['state-access-copy'])
        expect(codes(`scchart Main extends G {\n}${chart}`)).toEqual(['state-access-copy'])
        expect(compile(`scchart Main {\n  output int p\n  ref G g(p)\n}${chart}`).ok).toBe(true)
    })

    it('a base chart with a variable reached along two paths', () => {
        const list = errors('scchart Main extends L, R {\n}\nscchart L extends B { }\nscchart R extends B { }\nscchart B {\n  output int k = 0\n  region X { initial state A do k += 1 go to A }\n}')
        expect(list.map(d => d.code)).toEqual(['inheritance-clash', 'inheritance-clash'])
        expect(list[0].kieler).toBe('There is a name clash between declared valued object in inheritance hierarchy. Valued object with name k is declared multiple times (B, B).')
    })

    it('lists its compile-stage codes in SIMULATOR_CODES', () => {
        for (const code of ['unbound-generic', 'unbound-reference', 'generic-type-unbound', 'generic-argument', 'generic-arguments-conflict', 'generic-method-type', 'generic-pre', 'generic-pure-type', 'state-access-copy', 'bound-const-written', 'dataflow-instance-array']) {
            expect(SIMULATOR_CODES.has(code), code).toBe(true)
        }
    })
})

// Element ids and name resolution (KIELER's scoping), checked against what the official tools accept and reject
// (tests/corpus/probes/scope-*.sctx and trans-target-*.sctx record KIELER's verdicts for the same cases).
import { describe, expect, it } from 'vitest'
import { compile, parse } from '../index'
import type { Effect, Expression, Program, Reference, State } from '../types'

function program(source: string): Program {
    const r = parse(source)
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    return r.program!
}

function allStates(p: Program): State[] {
    const out: State[] = []
    const walk = (s: State) => { out.push(s); for (const r of s.regions) r.states.forEach(walk) }
    p.charts.forEach(walk)
    return out
}

const errorCodes = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error').map(d => d.code)

describe('element ids', () => {
    const p = program(`scchart ABRO {
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
      region HandleB {
        initial state wB
        if B go to dB
        final state dB
      }
    }
    do O = true join to done
    state done
  }
  if R abort to ABO
}`)
    const c = p.charts[0]
    const abo = c.regions[0].states[0]
    const waitAB = abo.regions[0].states[0]

    it('follows the convention of types.ts', () => {
        expect(c.id).toBe('ABRO')
        expect(c.regions[0].id).toBe('ABRO:0')
        expect(abo.id).toBe('ABRO.ABO')
        expect(abo.regions[0].id).toBe('ABRO.ABO:0')
        expect(waitAB.id).toBe('ABRO.ABO.WaitAB')
        expect(waitAB.regions.map(r => r.id)).toEqual(['ABRO.ABO.WaitAB:0', 'ABRO.ABO.WaitAB:HandleB'])
        expect(waitAB.regions[0].states.map(s => s.id)).toEqual(['ABRO.ABO.WaitAB.wA', 'ABRO.ABO.WaitAB.dA'])
        expect(abo.transitions.map(t => t.id)).toEqual(['ABRO.ABO->1'])
        expect(waitAB.transitions.map(t => [t.id, t.source, t.target])).toEqual([['ABRO.ABO.WaitAB->1', 'ABRO.ABO.WaitAB', 'ABRO.ABO.done']])
        expect(abo.actions.map(a => a.id)).toEqual(['ABRO.ABO!entry0'])
        expect(c.declarations.flatMap(d => d.valuedObjects.map(v => v.id))).toEqual(['ABRO$A', 'ABRO$B', 'ABRO$R', 'ABRO$O'])
    })

    it('qualifies a state name used in two regions of the same parent by its region', () => {
        const q = program('scchart Q {\n  region R1:\n  initial state A\n  region R2:\n  initial state A\n  state B\n}')
        expect(allStates(q).map(s => s.id)).toEqual(['Q', 'Q:R1.A', 'Q:R2.A', 'Q.B'])
    })

    it('makes duplicates unique and stays stable when unrelated text changes', () => {
        const d = program('scchart D {\n  initial state A\n  state A\n}')
        expect(allStates(d).map(s => s.id)).toEqual(['D', 'D.A', 'D.A#2'])
        const before = allStates(program('scchart S {\n  initial state A\n  go to B\n  state B\n}')).map(s => s.id)
        const after = allStates(program('scchart S {\n  // a comment\n  initial state A \n  go to B\n\n  state B\n}')).map(s => s.id)
        expect(after).toEqual(before)
    })

    it('numbers actions per kind and transitions by priority', () => {
        const s = program('scchart N {\n  output int o\n  initial state A {\n    entry do o = 1\n    during do o++\n    entry do o = 2\n  }\n  if o > 1 go to A\n  go to A\n}').charts[0].regions[0].states[0]
        expect(s.actions.map(a => a.id)).toEqual(['N.A!entry0', 'N.A!during0', 'N.A!entry1'])
        expect(s.transitions.map(t => [t.id, t.priority])).toEqual([['N.A->1', 1], ['N.A->2', 2]])
    })
})

describe('transition targets (same region only)', () => {
    it('resolves siblings and self loops', () => {
        const p = program('scchart T {\n  initial state A\n  go to B\n  state B\n  go to B\n}')
        expect(p.charts[0].regions[0].states.flatMap(s => s.transitions.map(t => t.target))).toEqual(['T.B', 'T.B'])
    })

    it('rejects targets in other regions, in superstates and unknown ones, with KIELER’s linking message', () => {
        for (const source of [
            'scchart T {\n  region R1:\n  initial state A\n  go to B\n  region R2:\n  initial state B\n}',
            'scchart T {\n  initial state P {\n    initial state I\n    go to Q\n  }\n  state Q\n}',
            'scchart T {\n  initial state A\n  go to Nowhere\n}',
        ]) {
            const d = compile(source).diagnostics.find(x => x.code === 'unknown-state')!
            expect(d.severity).toBe('error')
            expect(d.kieler).toMatch(/^Couldn't resolve reference to State '\w+'\.$/)
        }
    })

    it('explains that the state is in another region', () => {
        const d = compile('scchart T {\n  region R1:\n  initial state A\n  go to B\n  region R2:\n  initial state B\n}').diagnostics.find(x => x.code === 'unknown-state')!
        expect(d.hint).toMatch(/another region/)
    })

    it('uses the first state when two have the same name', () => {
        const p = program('scchart T {\n  initial state A\n  go to B\n  state B\n  state B\n}')
        expect(p.charts[0].regions[0].states[0].transitions[0].target).toBe('T.B')
    })
})

describe('variable references', () => {
    const declOf = (e: Expression | Effect): string | undefined => {
        if (e.kind === 'ref') return e.decl
        if (e.kind === 'assign' || e.kind === 'postfix' || e.kind === 'emit') return e.target.decl
        if (e.kind === 'op') return declOf(e.args[0])
        return undefined
    }

    it('resolves through states, regions and the chart, innermost first', () => {
        const p = program('scchart V {\n  input int A\n  region R:\n  int A\n  initial state S {\n    bool A\n    initial state I\n    if A go to I\n  }\n  if A > 1 go to S\n}')
        const s = p.charts[0].regions[0].states[0]
        expect(declOf(s.regions[0].states[0].transitions[0].trigger!)).toBe('V.S$A')
        // A transition is contained in its source state, so it also sees the state's own declarations.
        expect(declOf(s.transitions[0].trigger!)).toBe('V.S$A')
        const q = program('scchart W {\n  input int A\n  region R:\n  int A\n  initial state S\n  if A > 1 go to S\n}')
        expect(declOf(q.charts[0].regions[0].states[0].transitions[0].trigger!)).toBe('W:R$A')
    })

    it('ignores declaration order and sees for-loop counters', () => {
        const p = program('scchart O {\n  output int o\n  int a[N]\n  const int N = 2\n  region R for i : 0 to 1 {\n    initial state S\n    do o = i go to S\n  }\n}')
        const c = p.charts[0]
        expect((c.declarations[1].valuedObjects[0].cardinalities[0] as Reference).decl).toBe('O$N')
        const e = c.regions[0].states[0].transitions[0].effects[0]
        expect(e.kind === 'assign' && (e.expression as Reference).decl).toBe('O:R$i')
    })

    it('resolves members of classes, structs, enums and referenced charts', () => {
        const p = program('scchart M {\n  output int o\n  class C {\n    int v\n    int get() { return v }\n  } c\n  struct P { int x } p\n  enum E { ONE, TWO }\n  ref E e = E.ONE\n  initial state S\n  do o = c.get(); p.x = 1; e = E.TWO go to S\n}')
        const [call, assign, en] = p.charts[0].regions[0].states[0].transitions[0].effects
        expect(call.kind === 'assign' && call.expression.kind === 'call' && [call.expression.target!.decl, call.expression.target!.sub!.decl]).toEqual(['M$c', 'M$C.get'])
        expect(assign.kind === 'assign' && [assign.target.decl, assign.target.sub!.decl]).toEqual(['M$p', 'M$P.x'])
        expect(en.kind === 'assign' && (en.expression as Reference).sub!.decl).toBe('M$E.TWO')
    })

    it('turns a valued emission of a method or reference into a call, as KIELER does', () => {
        const p = program('scchart K {\n  extern "rand" rnd\n  signal int V\n  method void m(int a) { }\n  initial state S\n  do rnd(0); m(1); V(2) go to S\n}')
        expect(p.charts[0].regions[0].states[0].transitions[0].effects.map(e => e.kind)).toEqual(['call', 'call', 'emit'])
    })

    it('reports unknown names with suggestions', () => {
        const r = compile('scchart U {\n  input bool Button\n  initial state S\n  if button go to S\n}')
        const d = r.diagnostics.find(x => x.code === 'unknown-variable')!
        expect(d.kieler).toBe("Couldn't resolve reference to ValuedObject 'button'.")
        expect(d.message).toMatch(/did you mean `Button`/)
        expect(r.ok).toBe(false)
    })

    it('says where a name is declared when it is out of scope', () => {
        const d = compile('scchart U {\n  initial state S {\n    int inner\n    initial state I\n  }\n  state T\n  if inner > 0 go to T\n}').diagnostics.find(x => x.code === 'unknown-variable')!
        expect(d.hint).toMatch(/inside state `S`/)
    })

    it('only lets calls see methods and extern functions', () => {
        expect(errorCodes('scchart C {\n  input int x\n  output int o\n  initial state S\n  do o = x(3) go to S\n}')).toEqual(['not-callable'])
        expect(errorCodes('scchart C {\n  input signal int V\n  initial state S\n  if V(3) go to S\n}')).toEqual(['not-callable'])
    })

    it('picks the overload with the right number of parameters', () => {
        const r = compile('scchart O {\n  output int o\n  method int f() { return 1 }\n  method int f(int a) { return a }\n  initial state S\n  do o = f(2) go to S\n}')
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    })
})

describe('references to other charts', () => {
    it('binds explicitly, by order and by name', () => {
        const r = compile('scchart Main {\n  input bool a\n  output bool x\n  initial state R is Sub(a to i, x to o)\n  state Q is Sub(a, x)\n  state P is Sub2\n}\nscchart Sub {\n  input bool i\n  output bool o\n  initial state S\n}\nscchart Sub2 {\n  input bool a\n  output bool x\n  initial state S\n}')
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        expect(r.diagnostics.map(d => d.code)).toContain('implicit-binding')
        const st = r.program!.charts[0].regions[0].states[0]
        expect(st.reference!.parameters.map(p => p.bindingDecl)).toEqual(['Sub$i', 'Sub$o'])
    })

    it('finds charts in other files', () => {
        const r = compile('import "Beep"\nscchart Main {\n  input bool s\n  output bool b\n  initial state R is Beep(s to second, b to beep)\n}', { files: { 'Beep.sctx': 'scchart Beep {\n  input bool second\n  output bool beep\n  initial state A\n}' } })
        expect(r.diagnostics).toEqual([])
    })

    it('reports unknown charts and wrong bindings', () => {
        expect(errorCodes('scchart Main {\n  initial state R is Nope\n}')).toEqual(['unknown-chart'])
        expect(errorCodes('scchart Main {\n  input bool a\n  initial state R is Sub(a to nope)\n}\nscchart Sub {\n  input bool i\n  initial state S\n}')).toEqual(['unknown-binding'])
        expect(errorCodes('scchart Main {\n  input bool a\n  initial state R is Sub(a, a)\n}\nscchart Sub {\n  input bool i\n  initial state S\n}')).toEqual(['binding-error'])
    })
})

// Arrays used as values (packages/engine/src/sim/pointers.ts, basics.md B-28a) and sums and differences as KIELER
// writes them (sim/written.ts, B-21a). The behaviour is checked against KIELER by tests/conformance/engine.test.ts
// (the probes in tests/engine/kieler/pointers and tests/engine/kieler/written); these tests pin down the rules of the
// typing, the diagnostics (codes, gcc's texts) and the values of a few runs.

import { describe, expect, it } from 'vitest'
import { compile, createSimulation, SIMULATOR_CODES } from '@sccharts-lab/engine'
import {
    assignRule, binaryRule, CHAR, conditionalRule, decayed, DOUBLE, FLOAT, INT, LONG, pointerDifference, ptr, tyName, unaryRule,
} from '../../packages/engine/src/sim/pointers'
import { additiveChain } from '../../packages/engine/src/sim/written'
import type { CExpr } from '../../packages/engine/src/sim/model'

const DECLS = 'input bool b input int i int a[2] = {4,7} int c[2] = {4,7} int m[2][2] = {{4,7},{8,1}} float fa[2] bool ba[2] output int x output float f output bool y'
const chart = (effect: string, extra = '') => `scchart Main { ${DECLS} ${extra} initial state A do ${effect} go to A }`
const errors = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'error')
const gcc = (source: string) => errors(source).map(d => [d.code, d.kieler?.split('\n')[0]])
const warnings = (source: string) => compile(source).diagnostics.filter(d => d.severity === 'warning').map(d => d.code)
const run = (source: string, inputs: Record<string, unknown>[] = [{}, {}], options = {}) => {
    const r = compile(source)
    expect(errors(source)).toEqual([])
    const sim = createSimulation(r, options)
    return inputs.map(given => sim.step(given as never))
}
const x = (effect: string, extra = '', inputs: Record<string, unknown>[] = [{ i: 1 }, { i: 1 }]) => run(chart(effect, extra), inputs)[1].values.x

describe('C types of arrays', () => {
    it('names them as gcc does', () => {
        const intPtr = decayed(INT, [2])
        const row = decayed(INT, [2, 2])
        expect(tyName(intPtr)).toBe('int *')
        expect(tyName(row)).toBe('int (*)[2]')
        expect(tyName(decayed(INT, [2, 2, 3]))).toBe('int (*)[2][3]')
        expect(tyName(decayed(ptr(CHAR), [2]))).toBe('char **')
        expect(tyName(decayed(DOUBLE, [2]))).toBe('double *')
        expect(tyName(LONG)).toBe('long int')
    })

    it('has gcc\'s rule for every operator', () => {
        const p = { t: decayed(INT, [2]) }
        const row = { t: decayed(INT, [2, 2]) }
        const n = { t: INT }
        const error = (r: object) => ('error' in r ? r.error : undefined)
        const type = (r: object) => ('t' in r ? tyName((r as { t: { t: never } }).t.t) : undefined)
        expect(type(binaryRule('-', p, p))).toBe('long int')
        expect(type(binaryRule('+', p, n))).toBe('int *')
        expect(type(binaryRule('+', n, p))).toBe('int *')
        expect(type(binaryRule('==', p, row))).toBe('int')
        expect(type(binaryRule('<', p, n))).toBe('int')
        expect(error(binaryRule('+', p, p))).toBe('invalid operands to binary + (have ‘int *’ and ‘int *’)')
        expect(error(binaryRule('-', n, p))).toBe('invalid operands to binary - (have ‘int’ and ‘int *’)')
        expect(error(binaryRule('-', row, p))).toBe('invalid operands to binary - (have ‘int (*)[2]’ and ‘int *’)')
        expect(error(binaryRule('*', p, n))).toBe('invalid operands to binary * (have ‘int *’ and ‘int’)')
        // A char operand is promoted, a C float (random()) is not.
        expect(error(binaryRule('|', { t: CHAR }, p))).toBe('invalid operands to binary | (have ‘int’ and ‘int *’)')
        expect(error(binaryRule('<', p, { t: FLOAT }))).toBe('invalid operands to binary < (have ‘int *’ and ‘float’)')
        expect(error(binaryRule('==', p, { t: DOUBLE }))).toBe('invalid operands to binary == (have ‘int *’ and ‘double’)')
        expect(error(unaryRule('neg', p))).toBe('wrong type argument to unary minus')
        expect(error(unaryRule('~', p))).toBe('wrong type argument to bit-complement')
        expect(type(unaryRule('!', p))).toBe('int')
        expect(type(conditionalRule(p, { t: INT, zero: true }))).toBe('int *')
        expect(error(conditionalRule(p, n))).toBe('pointer/integer type mismatch in conditional expression [-Wint-conversion]')
        expect(error(conditionalRule(p, row))).toBe('pointer type mismatch in conditional expression [-Wincompatible-pointer-types]')
    })

    it('has gcc\'s texts for a value put where it does not fit', () => {
        const p = { t: decayed(INT, [2]) }
        expect(assignRule(INT, p)).toBe('assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast [-Wint-conversion]')
        expect(assignRule(CHAR, { t: decayed(DOUBLE, [2]) })).toBe('assignment to ‘char’ from ‘double *’ makes integer from pointer without a cast [-Wint-conversion]')
        expect(assignRule(DOUBLE, p)).toBe('incompatible types when assigning to type ‘double’ from type ‘int *’')
        expect(assignRule(INT, p, { how: 'argument', n: 2, fn: 'Main_g' })).toBe('passing argument 2 of ‘Main_g’ makes integer from pointer without a cast [-Wint-conversion]')
        expect(assignRule(DOUBLE, p, { how: 'argument', n: 2, fn: 'Main_g' })).toBe('incompatible type for argument 2 of ‘Main_g’')
        expect(assignRule(INT, p, { how: 'return' })).toBe('returning ‘int *’ from a function with return type ‘int’ makes integer from pointer without a cast [-Wint-conversion]')
        expect(assignRule(DOUBLE, p, { how: 'return' })).toBe('incompatible types when returning type ‘int *’ but ‘double’ was expected')
        expect(assignRule(ptr(CHAR), { t: INT })).toBe('assignment to ‘char *’ from ‘int’ makes pointer from integer without a cast [-Wint-conversion]')
        expect(assignRule(ptr(CHAR), { t: INT, zero: true })).toBeUndefined()
        expect(assignRule(ptr(CHAR), p)).toBe('assignment to ‘char *’ from incompatible pointer type ‘int *’ [-Wincompatible-pointer-types]')
        expect(assignRule(INT, { t: LONG })).toBeUndefined()
    })

    it('divides a difference that is not whole elements as gcc does', () => {
        // Folded when gcc compiles the code: towards zero.
        expect(pointerDifference(28, 0, 12, true)).toBe(2n)
        expect(pointerDifference(0, 20, 8, true)).toBe(-2n)
        // Computed when the code runs: a shift by the size's power of two, then the inverse of the odd rest.
        expect(BigInt.asIntN(32, pointerDifference(28, 0, 12, false))).toBe(-1431655763n)
        expect(pointerDifference(0, 20, 8, false)).toBe(-3n)
        expect(pointerDifference(24, 0, 12, false)).toBe(2n)
    })
})

describe('an array where gcc refuses it', () => {
    it('is rejected with gcc\'s own message', () => {
        expect(gcc(chart('x = a'))).toEqual([['array-as-value', 'assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('y = ba'))).toEqual([['array-as-value', 'assignment to ‘char’ from ‘char *’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('f = a'))).toEqual([['array-as-value', 'incompatible types when assigning to type ‘double’ from type ‘int *’']])
        expect(gcc(chart('x = a + a'))).toEqual([['array-operands', 'invalid operands to binary + (have ‘int *’ and ‘int *’)']])
        expect(gcc(chart('x = a * 2'))).toEqual([['array-operands', 'invalid operands to binary * (have ‘int *’ and ‘int’)']])
        expect(gcc(chart('x = -a'))).toEqual([['array-operands', 'wrong type argument to unary minus']])
        expect(gcc(chart('x = m - m[0]'))).toEqual([['array-operands', 'invalid operands to binary - (have ‘int (*)[2]’ and ‘int *’)']])
        expect(gcc(chart('x = c[a]'))).toEqual([['array-index', 'array subscript is not an integer']])
        // (gcc goes on with the pointer's type, so the assignment fails too.)
        expect(gcc(chart('x = b ? a : i'))).toEqual([['conditional-mismatch', 'pointer/integer type mismatch in conditional expression [-Wint-conversion]'],
            ['array-as-value', 'assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('x = b ? a : a'))).toEqual([['array-as-value', 'assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('a++'))).toEqual([['array-assignment', 'lvalue required as increment operand']])
        expect(gcc(chart('a = c'))).toEqual([['array-assignment', 'assignment to expression with array type']])
    })

    it('judges a compound assignment by its operator', () => {
        expect(gcc(chart('x += a'))[0][1]).toBe('assignment to ‘int’ from ‘int *’ makes integer from pointer without a cast [-Wint-conversion]')
        expect(gcc(chart('x -= a'))[0][1]).toBe('invalid operands to binary - (have ‘int’ and ‘int *’)')
        expect(gcc(chart('x *= a'))[0][1]).toBe('invalid operands to binary * (have ‘int’ and ‘int *’)')
        expect(gcc(chart('f += a'))[0][1]).toBe('invalid operands to binary + (have ‘double’ and ‘int *’)')
        expect(gcc(chart('x min= a'))[0][1]).toBe('pointer/integer type mismatch in conditional expression [-Wint-conversion]')
    })

    it('says an array, not a string, where an array is the whole condition', () => {
        const d = errors(`scchart Main { ${DECLS} initial state A if a do x = 1 go to A }`)
        expect(d.map(e => e.code)).toEqual(['array-as-value'])
        expect(d[0].message).toBe('`a` is an array: it cannot be a condition on its own')
        expect(d[0].kieler).toContain('assignment to ‘char’ from ‘int *’')
        // An input the chart never writes is tested where it stands (KIELER's copy propagation): accepted.
        expect(errors('scchart Main { input int ia[2] output int x initial state A if ia do x = 1 go to A }')).toEqual([])
        expect(gcc('scchart Main { input int ia[2] output int x initial state A if ia do x = 1; ia[0] = 3 go to A }')[0][0]).toBe('array-as-value')
    })

    it('judges a method on the code KIELER writes', () => {
        // A short method is copied into place: its array parameter is the argument.
        expect(x('x = first(a)', 'method int first(int p[2]) { return p[0] }')).toBe(4)
        expect(x('x = first(m[1])', 'method int first(int p[2]) { return p[0] }')).toBe(8)
        expect(gcc(chart('x = first(m)', 'method int first(int p[2]) { return p[0] }'))[0][1]).toContain('assignment to ‘int’ from ‘int *’')
        expect(gcc(chart('x = first(i)', 'method int first(int p[2]) { return p[0] }'))).toEqual([['method-array-parameter', 'subscripted value is neither array nor pointer nor vector']])
        expect(gcc(chart('x = id(a)', 'method int id(int n) { return n }'))[0][0]).toBe('array-as-value')
        expect(gcc(chart('x = get()', 'method int get() { int t = a return t }'))[0][0]).toBe('array-as-value')
        // A method with a loop stays a C function: its parameters are single values, its result too.
        const loop = 'int r = 0 for (int j = 0; j < 2; j++) { r += 1 }'
        expect(gcc(chart('x = g(a)', `method int g(int n) { ${loop} return r }`))).toEqual([['array-as-value', 'passing argument 2 of ‘Main_g’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('x = g()', `method int g() { ${loop} return a }`))).toEqual([['array-as-value', 'returning ‘int *’ from a function with return type ‘int’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(gcc(chart('f = g()', `method float g() { ${loop} return a }`))[0][1]).toBe('incompatible types when returning type ‘int *’ but ‘double’ was expected')
        expect(gcc(chart('x = g(a)', 'method int g(int p[2]) { int r = 0 for (int j = 0; j < 2; j++) { r += p[j] } return r }')).map(e => e[0])).toEqual(['method-array-parameter', 'array-as-value'])
        // Its conditions are plain C conditions: a pointer is true there.
        expect(x('x = g()', 'method int g() { int r = 0 for (int j = 0; j < 2; j++) { if (a) { r += 1 } } return r }')).toBe(2)
    })

    it('leaves code alone that KIELER has no C for', () => {
        expect(errors(`scchart Main { ${DECLS} initial state A do x = 1 go to A state B do x = a go to A }`)).toEqual([])
        expect(errors(chart('x = 1', 'method int never() { return a }'))).toEqual([])
    })

    it('rejects a whole constant array and reads null as the header has it', () => {
        expect(gcc('scchart Main { const int k[2] = {1,2} output int x initial state A do x = k go to A }')).toEqual([['const-array-value', 'expected expression before ‘{’ token']])
        expect(errors('scchart Main { output int x initial state A do x = null go to A }')).toEqual([])
        expect(gcc('scchart Main { output int x initial state A do x = null; print("hi") go to A }')).toEqual([['array-as-value', 'assignment to ‘int’ from ‘void *’ makes integer from pointer without a cast [-Wint-conversion]']])
    })

    it('rejects a string where a number is needed and the other way round', () => {
        const s = (effect: string) => gcc(`scchart Main { string s = "hi" int a[2] output int x output float f initial state A do ${effect} go to A }`)
        expect(s('x = s')).toEqual([['string-as-value', 'assignment to ‘int’ from ‘char *’ makes integer from pointer without a cast [-Wint-conversion]']])
        expect(s('f = s')).toEqual([['string-as-value', 'incompatible types when assigning to type ‘double’ from type ‘char *’']])
        expect(s('s = 5')).toEqual([['string-assignment', 'assignment to ‘char *’ from ‘int’ makes pointer from integer without a cast [-Wint-conversion]']])
        expect(s('s = a')).toEqual([['string-assignment', 'assignment to ‘char *’ from incompatible pointer type ‘int *’ [-Wincompatible-pointer-types]']])
        expect(s('s = 0')).toEqual([])
    })

    it('registers its codes', () => {
        for (const code of ['array-as-value', 'array-assignment', 'array-operands', 'array-index', 'conditional-mismatch', 'const-array-value', 'string-as-value', 'string-assignment',
            'c-address-value', 'array-address', 'c-decrement', 'method-array-parameter']) expect(SIMULATOR_CODES.has(code)).toBe(true)
    })
})

describe('an array where gcc compiles it', () => {
    it('is true, and compares by its address', () => {
        expect(x('x = a ? 1 : 2')).toBe(1)
        expect(x('x = !a')).toBe(0)
        expect(x('x = a == a')).toBe(1)
        expect(x('x = a == c')).toBe(0)
        expect(x('x = a != c')).toBe(1)
        expect(x('x = a < c')).toBe(1)
        expect(x('x = m[0] == m[1]')).toBe(0)
        expect(x('x = m[i] == m[1]')).toBe(1)
        expect(x('x = m == m[0]')).toBe(1)
        expect(x('x = a == 0')).toBe(0)
        expect(x('x = a != 0')).toBe(1)
        // An integer is compared as an address: a negative one is a very high one.
        expect(x('x = a > 5')).toBe(1)
        expect(x('x = a < -1')).toBe(1)
        expect(x('x = (a + 2) == c')).toBe(1)
    })

    it('counts elements in a difference, by KIELER\'s struct', () => {
        expect(x('x = a - a')).toBe(0)
        expect(x('x = (a + 1) - a')).toBe(1)
        expect(x('x = c - a')).toBe(2)
        expect(x('x = a - c')).toBe(-2)
        expect(x('x = m[1] - m[0]')).toBe(2)
        expect(x('x = m[i] - m[0]')).toBe(2)
        expect(x('x = (m + 1) - m')).toBe(1)
        expect(x('x = (fa + 1) - fa')).toBe(1)
        // A member of a class, of a chart instance (which lies where it is declared), a local of a state (after the
        // taken counters), the frame of a copied method.
        expect(run('scchart Main { int a[2] class K { int p int a[2] int q[2] } k output int x initial state A do x = k.a - a go to A }')[1].values.x).toBe(3)
        expect(run('scchart Main { int a[2] ref C c output int x initial state A do x = c.v - a go to A } scchart C { int v[2] int u int w[2] }')[1].values.x).toBe(2)
        expect(run('scchart Main { int a[2] output int x initial state A { int l[2] initial state I do x = l - a go to I } }')[1].values.x).toBe(4)
        expect(x('x = g()', 'method int g() { int t[2] int u[2] return u - t }')).toBe(2)
    })

    it('computes a difference in long arithmetic', () => {
        expect(x('x = (c - a) * 2000000000 * 2 / 1000')).toBe(8000000)
        expect(x('x = ((c - a) << 31) / 4')).toBe(1073741824)
        expect(x('x = ~(c - a)')).toBe(-3)
        expect(run(chart('y = (c - a) * 128'), [{}, {}])[1].values.y).toBe(false)
        expect(run(chart('f = (c - a) / 4.0'), [{}, {}])[1].values.f).toBe(0.5)
        expect(x('x = 3; x *= c - a')).toBe(6)
        expect(x('x max= c - a')).toBe(2)
    })

    it('divides a difference between two matrices as gcc does', () => {
        const two = (effect: string) => run(`scchart Main { input int i int m[2][3] int k int n[2][3] output int x output int z initial state A do ${effect} go to A }`, [{ i: 0 }, { i: 0 }])[1].values
        expect(two('x = n - m; z = m - n')).toMatchObject({ x: 2, z: -2 })
        expect(two('x = (n + i) - m; z = m - (n + i)')).toMatchObject({ x: -1431655763, z: 1431655763 })
        expect(two('x = (n + 0) - m; z = (n + 1) - m')).toMatchObject({ x: 2, z: -1431655762 })
    })

    it('warns that it works with an address', () => {
        expect(warnings(chart('x = a == c'))).toEqual(['array-address'])
        expect(warnings(`scchart Main { ${DECLS} initial state A if a && b do x = 1 go to A }`)).toEqual(['array-address'])
        expect(warnings(chart('x = a[0] == c[0]'))).toEqual([])
    })

    it('shows the struct\'s address where a float array is cast to an int', () => {
        const source = chart('x = fa')
        expect(warnings(source)).toEqual(['c-address-value'])
        const at = (address?: number) => run(source, [{}, {}], { address })[1].values.x
        // (fa lies 40 bytes into the struct.)
        expect(at(0x555500000000)).toBe(40)
        expect(at(0x5555c9eb7100)).toBe(-907316952)
        expect(at()).toBe(0x5555f128)
        expect(run(chart('x = fa + 1'), [{}, {}], { address: 0x555500000000 })[1].values.x).toBe(48)
        expect(run(chart('x += fa'), [{}, {}, {}], { address: 0x555500000000 })[2].values.x).toBe(80)
    })

    it('cannot tell where a C function\'s local array lies', () => {
        const d = compile(chart('x = g()', 'method int g() { int t[2] int u[2] int r = 0 for (int j = 0; j < 2; j++) { r = u - t } return r }')).diagnostics
        expect(d.map(e => [e.severity, e.code])).toEqual([['info', 'unsupported'], ['warning', 'array-address']])
        // Against the chart's variables the order is known (the stack lies above them), and inside one array too.
        expect(x('x = g()', 'method int g() { int t[2] int r = 0 for (int j = 0; j < 2; j++) { r += (t > a) + ((t + 1) - t) } return r }')).toBe(4)
    })
})

describe('a sum or difference as KIELER writes it', () => {
    const ref = (name: string): CExpr => ({ k: 'ref', v: { name, dims: [] } as never, idx: [] })
    const lit = (v: number): CExpr => ({ k: 'lit', t: 'int', v })
    const op = (o: string, ...args: CExpr[]): CExpr => ({ k: 'op', op: o as never, args })
    const text = (e: CExpr) => additiveChain(e as never).terms.map((t, i) => `${i ? (t.minus ? ' - ' : ' + ') : ''}${'-'.repeat(t.signs)}${t.atom.k === 'lit' ? t.atom.v : t.atom.k === 'ref' ? t.atom.v.name : '(…)'}`).join('')

    it('leaves out the parentheses KIELER leaves out', () => {
        expect(text(op('-', lit(10), op('-', ref('i'), lit(2))))).toBe('10 - i - 2')
        expect(text(op('neg', op('-', ref('i'), lit(2))))).toBe('-i - 2')
        expect(text(op('-', lit(20), op('-', op('+', ref('i'), lit(2)), lit(1))))).toBe('20 - i + 2 - 1')
        expect(text(op('-', lit(10), op('+', ref('i'), lit(2))))).toBe('10 - (…)')
        expect(text(op('+', lit(10), op('-', ref('i'), lit(2))))).toBe('10 + (…)')
        expect(text(op('+', lit(10), op('+', ref('i'), lit(2))))).toBe('10 + i + 2')
        expect(text(op('neg', op('neg', ref('i'))))).toBe('--i')
        expect(text(op('-', lit(5), op('neg', op('neg', ref('i')))))).toBe('5 - --i')
        expect(text(op('neg', lit(-5)))).toBe('--5')
    })

    it('computes what C reads', () => {
        expect(x('x = 10 - (i - 2)')).toBe(7)
        expect(x('x = -(i - 2)')).toBe(-3)
        expect(x('x = 20 - (i + 2 - 1)')).toBe(20)
        expect(x('x = 10 - (i + 2)')).toBe(7)
        expect(x('x = -(i - 2) * 3')).toBe(-9)
        expect(x('x = 30; x -= 5 - (i - 2)')).toBe(28)
        expect(run('scchart Main { const int K = 4 output int x initial state A do x = 10 - (K - 2) go to A }')[1].values.x).toBe(4)
        expect(run('scchart Main { output int x = 10 - (4 - 2) initial state A }')[0].values.x).toBe(4)
        expect(warnings(chart('x = 10 - (i - 2)'))).toEqual(['kieler-quirk'])
        expect(warnings(chart('x = 10 - (i + 2)'))).toEqual([])
    })

    it('counts a variable down where two minus signs meet', () => {
        const ticks = run(chart('x = - -i'), [{ i: 1 }, { i: 1 }, { i: 5 }])
        expect(ticks.map(t => [t.values.i, t.values.x])).toEqual([[1, 0], [0, 0], [4, 4]])
        expect(warnings(chart('x = - -i'))).toEqual(['kieler-quirk'])
        expect(gcc(chart('x = - -5'))).toEqual([['c-decrement', 'lvalue required as decrement operand']])
        expect(gcc(chart('x = - -(i + 1)'))).toEqual([['c-decrement', 'lvalue required as decrement operand']])
        expect(gcc(chart('x = - - -i'))).toEqual([['c-decrement', 'lvalue required as decrement operand']])
        expect(gcc(chart('x = - -a'))[0][1]).toBe('lvalue required as decrement operand')
    })

    it('makes a negated difference of two arrays what gcc rejects', () => {
        expect(gcc(chart('x = -(c - a)'))).toEqual([['array-operands', 'wrong type argument to unary minus']])
        expect(gcc(chart('x = 0 - (c - a)'))).toEqual([['array-operands', 'invalid operands to binary - (have ‘int’ and ‘int *’)']])
        expect(x('x = 0 - (a == c)')).toBe(0)
    })
})

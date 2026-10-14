// The C semantics of KIELER's netlist simulation (docs-internal/semantics/basics.md B-20..B-30), checked on small
// charts. The oracle recordings in tests/conformance cover the same rules against KIELER itself.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { Value } from '../../src/engine/types'
import { newRandState, rand, random } from '../../src/engine/sim/random'
import { doubleToInt, toChar } from '../../src/engine/sim/values'

/** Runs `effects` once in tick 2 (a delayed self-loop) and returns the outputs. */
function after(decls: string, effects: string, inputs: Record<string, Value> = {}): Record<string, Value> {
    const source = `scchart E {\n${decls}\n  initial state S\n  do ${effects} go to T\n  state T\n}`
    const r = compile(source)
    expect(r.ok, r.diagnostics.map(d => d.message).join('\n')).toBe(true)
    const s = createSimulation(r)
    s.step(inputs)
    const t = s.step({})
    expect(t.error, t.error?.message).toBeUndefined()
    return t.values
}

describe('int arithmetic (B-20)', () => {
    it('wraps at 32 bits', () => {
        const v = after('  input int I\n  output int sum, product, negated', 'sum = I + 1; product = I * 2; negated = -(I + 1)', { I: 2147483647 })
        expect(v).toMatchObject({ sum: -2147483648, product: -2, negated: -2147483648 })
    })
    it('divides truncating towards zero, % takes the sign of the dividend', () => {
        const v = after('  input int A, B\n  output int q, r', 'q = A / B; r = A % B', { A: -7, B: 2 })
        expect(v).toMatchObject({ q: -3, r: -1 })
        expect(after('  input int A, B\n  output int q, r', 'q = A / B; r = A % B', { A: 7, B: -2 })).toMatchObject({ q: -3, r: 1 })
    })
    it('shifts arithmetically and supports bitwise operators', () => {
        const v = after('  input int A\n  output int shl, shr, and, not', 'shl = A << 2; shr = A >> 1; and = A & 6; not = ~A', { A: -12 })
        expect(v).toMatchObject({ shl: -48, shr: -6, and: 4, not: 11 })
    })
    it('evaluates n-ary sums left to right', () => {
        expect(after('  input int A[3]\n  output int s', 's = A[0] * 100 + A[1] * 10 + A[2]', { A: [1, 2, 3] })).toMatchObject({ s: 123 })
    })
})

describe('floats (B-21)', () => {
    it('rounds float literals to single precision, keeps double arithmetic', () => {
        const v = after('  input float F\n  output float a, d, c', 'a = 0.1; d = F + 0.2; c = 1.0 / 3', { F: 0.1 })
        expect(v.a).toBe(0.10000000149011612)
        expect(v.d).toBe(0.1 + 0.20000000298023224)
        expect(v.c).toBe(1 / 3)
    })
    it('truncates a float stored in an int; casts the right-hand side of a compound int assignment first (B-27)', () => {
        const v = after('  output int i, j, x = 7, y = 7\n  output float f = 1.5', 'i = 7.9; j = -7.9; x *= 1.5; y = y * 1.5; f++')
        expect(v).toMatchObject({ i: 7, j: -7, x: 7, y: 10, f: 2.5 })
    })
})

describe('bool is a C char (B-23)', () => {
    it('keeps the char value, shows != 0', () => {
        const v = after('  output bool b, big, wrapped\n  output int x, twice', 'b = 5; x = b; twice = b + b; big = 300; wrapped = 256')
        expect(v).toMatchObject({ b: true, x: 5, twice: 10, big: true, wrapped: false })
    })
    it('logical operators and comparisons give 0 and 1', () => {
        expect(after('  input int A\n  output int t, n', 't = (A > 1) + (A > 0); n = (!A) + 1', { A: 3 })).toMatchObject({ t: 2, n: 1 })
    })
})

describe('strings compare pointers (B-26)', () => {
    it('a literal equals an identical literal and a variable assigned from it, an input never', () => {
        const v = after('  input string S\n  string t = "hi"\n  output bool a, b, c, d', 'a = t == "hi"; b = "x" == "x"; c = S == "hi"; d = S == "x"', { S: 'hi' })
        expect(v).toMatchObject({ a: true, b: true, c: false, d: false })
    })
})

describe('assignment operators (B-27)', () => {
    it('min= and max=', () => {
        expect(after('  output int lo = 10, hi = 10', 'lo min= 4; hi max= 21')).toMatchObject({ lo: 4, hi: 21 })
    })
    it('vector assignment runs element by element in index order (B-28)', () => {
        expect(after('  output int arr[3] = {1, 2, 3}', 'arr = {arr[1], arr[2], arr[0]}')).toMatchObject({ arr: [2, 3, 2] })
    })
})

describe('random() (B-29)', () => {
    it('follows glibc\'s unseeded sequence', () => {
        const s = newRandState()
        expect([rand(s), rand(s), rand(s), rand(s), rand(s), rand(s)]).toEqual([1804289383, 846930886, 1681692777, 1714636915, 1957747793, 424238335])
        const t = newRandState()
        expect(random(t)).toBe(0.8401877284049988)
        expect(Math.fround(random(t) * 100)).toBeCloseTo(39.438, 2)
    })
    it('in a chart: single-precision product truncated into an int', () => {
        const r = compile('scchart R {\n  output float r\n  output int p\n  initial state S\n  do r = random(); p = random() * 100 go to S\n}')
        const s = createSimulation(r)
        s.step({})
        expect(s.step({}).values).toMatchObject({ r: 0.8401877284049988, p: 39 })
        expect(s.step({}).values).toMatchObject({ r: 0.7830992341041565, p: 79 })
    })
})

describe('print (B-30)', () => {
    it('formats each argument by type, joined by spaces', () => {
        const r = compile('scchart P {\n  output int x = 3\n  output bool b = true\n  output float f = 1.5\n  initial state S\n  do print("vals", x, b, f) go to T\n  state T\n}')
        const s = createSimulation(r)
        s.step({})
        const t = s.step({})
        expect(t.printed).toEqual(['vals 3 1 1.500000'])
        expect(t.log).toContainEqual(expect.objectContaining({ kind: 'print', text: 'vals 3 1 1.500000' }))
    })
})

describe('C conversions', () => {
    it('double to int as cvttsd2si', () => {
        expect(doubleToInt(7.9)).toBe(7)
        expect(doubleToInt(-7.9)).toBe(-7)
        expect(doubleToInt(3e9)).toBe(-2147483648)
        expect(doubleToInt(NaN)).toBe(-2147483648)
    })
    it('char conversion', () => {
        expect(toChar(300)).toBe(44)
        expect(toChar(256)).toBe(0)
        expect(toChar(-1)).toBe(-1)
        expect(toChar(0.5, true)).toBe(0)
    })
})

describe('first tick', () => {
    it('applies an input\'s initial value before the first inputs (B-7)', () => {
        const r = compile('scchart I {\n  input int I = 42, J = 1\n  output int x, y\n  initial state S\n  do x = I; y = J go to S\n}')
        const s = createSimulation(r)
        expect(s.step({ J: 3 }).values).toMatchObject({ I: 42, J: 3 })
        expect(s.step({}).values).toMatchObject({ x: 42, y: 3 })
    })
    it('re-initialises locals on every entry (B-6)', () => {
        const r = compile('scchart L {\n  output int x\n  initial state S {\n    int c = 10\n    entry do c++\n  }\n  do x = c go to S\n}')
        const s = createSimulation(r)
        s.step({})
        expect(s.step({}).values.x).toBe(11)
        expect(s.step({}).values.x).toBe(11)
    })
})

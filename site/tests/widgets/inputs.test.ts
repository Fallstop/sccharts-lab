import { describe, expect, it } from 'vitest'
import { afterTick, applyScenarioInputs, controlsFor, effectiveInputs, formatValue, initialInputs, parseArray, parseNumber, sameInputs } from '../../src/components/sim/inputs'
import { v } from './fake-sim'

const iface = [
    v('A', 'bool'),
    v('S', 'pure', { signal: true }),
    v('V', 'int', { signal: true, valued: true, initialValue: 3 }),
    v('N', 'int', { initialValue: 42 }),
    v('F', 'float'),
    v('T', 'string'),
    v('arr', 'int', { dims: [3], initialValue: [1, 2] }),
    v('K', 'int', { const: true }),
    v('O', 'bool', { input: false, output: true }),
]

describe('input controls', () => {
    it('makes one control per input, in declaration order, skipping constants and outputs', () => {
        expect(controlsFor(iface).map((c) => `${c.name}:${c.kind}${c.valued ? '+value' : ''}`)).toEqual([
            'A:bool', 'S:bool', 'V:bool+value', 'N:number', 'F:number', 'T:string', 'arr:array',
        ])
        expect(controlsFor(iface).find((c) => c.name === 'V')!.valueKey).toBe('V_val')
    })

    it('starts from the declared initial values, else false, 0 and an unset string', () => {
        expect(initialInputs(iface).levels).toEqual({ A: false, S: false, V: false, V_val: 3, N: 42, F: 0, T: null, arr: [1, 2, 0] })
    })

    it('sends levels, with armed pulses present, and leaves unset strings out', () => {
        const s = { levels: { A: false, S: false, T: null }, pulses: ['S'] }
        expect(effectiveInputs(s)).toEqual({ A: false, S: true })
        // After the tick the pulse is released and the level stays.
        expect(effectiveInputs(afterTick(s))).toEqual({ A: false, S: false })
    })

    it('applies a scenario tick: only the inputs it names change', () => {
        const s = applyScenarioInputs({ levels: { A: true, N: 1 }, pulses: ['A'] }, { N: 5 })
        expect(s).toEqual({ levels: { A: true, N: 5 }, pulses: [] })
    })

    it('compares inputs by value', () => {
        expect(sameInputs({ a: [1, 2], b: true }, { b: true, a: [1, 2] })).toBe(true)
        expect(sameInputs({ a: 1 }, { a: 1, b: false })).toBe(false)
        expect(sameInputs({ a: null }, {})).toBe(true)
    })
})

describe('parsing fields', () => {
    it('reads numbers; ints truncate towards zero and saturate like cJSON', () => {
        expect(parseNumber('12', true)).toBe(12)
        expect(parseNumber('-3.9', true)).toBe(-3)
        expect(parseNumber('2.5', false)).toBe(2.5)
        expect(parseNumber('1e3', true)).toBe(1000)
        expect(parseNumber('9999999999', true)).toBe(2147483647)
        expect(parseNumber('-9999999999', true)).toBe(-2147483648)
        expect(parseNumber('', true)).toBeUndefined()
        expect(parseNumber('abc', false)).toBeUndefined()
        expect(parseNumber('1,5', false)).toBeUndefined()
    })

    it('reads arrays element-wise; a shorter list sets the leading elements', () => {
        const c = controlsFor(iface).find((x) => x.name === 'arr')!
        expect(parseArray('7', c, [1, 2, 3])).toEqual([7, 2, 3])
        expect(parseArray('[4, 5, 6]', c, [1, 2, 3])).toEqual([4, 5, 6])
        expect(parseArray('4, x', c, [1, 2, 3])).toBeUndefined()
    })

    it('formats values as the trace shows them', () => {
        expect(formatValue(true)).toBe('true')
        expect(formatValue(0.1 + 0.2)).toBe('0.3')
        expect(formatValue([1, 2])).toBe('{1, 2}')
        expect(formatValue('hi')).toBe('"hi"')
        expect(formatValue(null)).toBe('')
    })
})

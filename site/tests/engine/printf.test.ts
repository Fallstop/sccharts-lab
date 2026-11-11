// print() of a float as C's %f prints it (glibc): what KIELER's simulation shows, and what the generated C prints
// (probe tests/engine/kieler/codegen/probe-print-float-special; tools/cgen compares the printed text with gcc's).
import { describe, expect, test } from 'vitest'
import { printfValue } from '@sccharts-lab/engine/sim/values'

describe('print of a float (%f)', () => {
    test('infinities, NaN, negative zero and large values are written as C writes them', () => {
        expect(printfValue(Infinity, 'float')).toBe('inf')
        expect(printfValue(-Infinity, 'float')).toBe('-inf')
        expect(printfValue(NaN, 'float')).toBe('-nan')
        expect(printfValue(-0, 'float')).toBe('-0.000000')
        expect(printfValue(1e21, 'float')).toBe('1000000000000000000000.000000')
        expect(printfValue(-2.5e22, 'float')).toBe('-24999999999999997902848.000000')
        expect(printfValue(1.5, 'float')).toBe('1.500000')
        expect(printfValue(-1e-9, 'float')).toBe('-0.000000')
    })
})

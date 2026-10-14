import { describe, expect, it } from 'vitest'
import { compile, extractInterface, parse } from './index'

const abro = `scchart ABRO {
  input bool A, B, R
  output bool O = false
  const int N = 2
  int count[N] = {0, -1}
  signal S
  signal int V = 3 combine +
  input signal float F
  clock t
  initial state ABO {
    initial state WaitAB {
      region {
        initial state wA
        if A go to dA
        final state dA
      }
      region {
        initial state wB
        if B go to dB
        final state dB
      }
    }
    do O = true join to done
    state done
  }
  if R abort to ABO
}
`

describe('compile', () => {
    it('accepts a valid chart and simulates the first scchart by default, as KIELER does', () => {
        const r = compile(`${abro}\nscchart Second {\n  initial state S\n}\n`)
        expect(r.ok).toBe(true)
        expect(r.chart?.name).toBe('ABRO')
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        expect(r.index?.states.get('ABRO.ABO')?.name).toBe('ABO')
    })

    it('selects a chart by name', () => {
        const r = compile(`scchart First {\n  initial state S\n}\n${abro}`, { chart: 'First' })
        expect(r.chart?.name).toBe('First')
        const missing = compile(abro, { chart: 'Nope' })
        expect(missing.ok).toBe(false)
        expect(missing.diagnostics.map(d => d.code)).toContain('unknown-chart')
    })

    it('rejects a file without charts like KIELER', () => {
        const r = compile('// nothing\n')
        expect(r.ok).toBe(false)
        expect(r.diagnostics[0].kieler).toBe('There is no SCChart to compile. Add a scchart declaration first.')
    })

    it('extracts the interface of the simulated chart', () => {
        const r = compile(abro)
        expect(r.interface.map(v => [v.name, v.id, v.type, v.signal, v.valued, v.input, v.output, v.const, v.dims, v.initialValue, v.combine])).toEqual([
            ['A', 'ABRO$A', 'bool', false, false, true, false, false, [], undefined, undefined],
            ['B', 'ABRO$B', 'bool', false, false, true, false, false, [], undefined, undefined],
            ['R', 'ABRO$R', 'bool', false, false, true, false, false, [], undefined, undefined],
            ['O', 'ABRO$O', 'bool', false, false, false, true, false, [], false, undefined],
            ['N', 'ABRO$N', 'int', false, false, false, false, true, [], 2, undefined],
            ['count', 'ABRO$count', 'int', false, false, false, false, false, [2], [0, -1], undefined],
            ['S', 'ABRO$S', 'pure', true, false, false, false, false, [], undefined, undefined],
            ['V', 'ABRO$V', 'int', true, true, false, false, false, [], 3, '+'],
            ['F', 'ABRO$F', 'float', true, true, true, false, false, [], undefined, undefined],
            // KIELER's simulation type of a clock (float; int with @IntegerClockType), as in its interface and data pool.
            ['t', 'ABRO$t', 'float', false, false, false, false, false, [], undefined, undefined],
            // A chart with a clock gets KIELER's deltaT input and sleepT output (structure.md S-35).
            ['deltaT', 'ABRO$deltaT', 'float', false, false, true, false, false, [], 0, undefined],
            ['sleepT', 'ABRO$sleepT', 'float', false, false, false, true, false, [], 0, undefined],
        ])
        // extractInterface gives the declared types (a clock is a clock).
        expect(extractInterface(r.chart!, r.index)).toEqual(r.interface.slice(0, -2).map(v => (v.name === 't' ? { ...v, type: 'clock' } : v)))
    })

    it('keeps the program and the chart when the chart is rejected', () => {
        const r = compile('scchart X {\n  initial state S\n  go to Nowhere\n}')
        expect(r.ok).toBe(false)
        expect(r.program?.charts).toHaveLength(1)
        expect(r.chart?.name).toBe('X')
    })

    it('never throws', () => {
        for (const input of ['', '{', 'scchart', 'scchart A {', '\u0000', 'scchart A { initial state S go to', 'scchart A { region R for i : }']) {
            expect(() => compile(input)).not.toThrow()
            expect(() => parse(input)).not.toThrow()
            expect(parse(input).program).toBeDefined()
        }
    })
})

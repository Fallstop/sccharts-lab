// What the embed reports and takes (src/components/embed/bridge.ts): a compile, a tick, and inputs from the page
// checked against the chart's.
import { describe, expect, test } from 'vitest'
import { compile, createSimulation } from '@sccharts-lab/engine'
import { coerceInputs, compiledInfo, tickInfo } from '../../src/components/embed/bridge'

const ABRO = `scchart ABRO {
  input signal A, B, R
  output signal O
  initial state ABO {
    initial state WaitAB {
      region HandleA:
        initial state WaitA
          if A go to DoneA
        final state DoneA
      region HandleB:
        initial state WaitB
          if B go to DoneB
        final state DoneB
    }
    do O join to Done
    state Done
  }
  if R abort to ABO
}
`

const KINDS = `scchart Kinds {
  input bool b
  input int n
  input float f
  input string s
  input signal int V
  input int arr[3]
  output int out
  initial state S
}
`

describe('a compile', () => {
    test('the chart, its interface and no problems', () => {
        const r = compile(ABRO)
        const info = compiledInfo('abro.sctx', r, r.diagnostics)
        expect(info).toMatchObject({ ok: true, file: 'abro.sctx', chart: 'ABRO', charts: ['ABRO'], diagnostics: [] })
        expect(info.inputs.map(v => v.name)).toEqual(['A', 'B', 'R'])
        expect(info.outputs).toEqual([{ name: 'O', type: 'pure', signal: true, valued: false, dims: [] }])
        // It survives postMessage's structured clone as it is.
        expect(structuredClone(info)).toEqual(info)
    })

    test('a problem with its place', () => {
        const r = compile('scchart Bad {\n  initial state S\n    if x go to S\n}\n')
        const info = compiledInfo('bad.sctx', r, r.diagnostics)
        expect(info.ok).toBe(false)
        expect(info.diagnostics[0]).toMatchObject({ severity: 'error', line: 3 })
        expect(info.diagnostics[0].message).toMatch(/x/)
    })
})

describe('a tick', () => {
    test('tick 0, then ABRO emitting O once A and B have come', () => {
        expect(tickInfo(undefined)).toEqual({ tick: 0, ticks: 0, tour: false, values: {}, present: {}, active: [], entered: [], taken: [], printed: [], terminated: false })
        const sim = createSimulation(compile(ABRO))
        sim.step({})
        sim.step({ A: true })
        const t3 = sim.step({ A: false, B: true })
        const info = tickInfo({ cursor: 3, tick: t3, history: sim.history, tour: false, lines: { active: [], taken: [], error: [] } })
        expect(info).toMatchObject({ tick: 3, ticks: 3, tour: false, terminated: false })
        expect(info.values).toEqual({ A: false, B: true, R: false, O: true })
        expect(info.present.O).toBe(true)
        expect(info.active).toContain('ABRO.ABO.Done')
        expect(info.taken).toContain('ABRO.ABO.WaitAB.WaitB->1')
        expect(structuredClone(info)).toEqual(info)
    })
})

describe('inputs from the page', () => {
    const iface = compile(KINDS).interface

    test('each kind of input takes its kind of value', () => {
        expect(coerceInputs(iface, { b: true, n: 3, f: 1.5, s: 'hi', V: true, V_val: 7, arr: [1, 2, 3] })).toEqual({ values: { b: true, n: 3, f: 1.5, s: 'hi', V: true, V_val: 7, arr: [1, 2, 3] } })
        expect(coerceInputs(iface, { s: null })).toEqual({ values: { s: null } })
    })

    test('an int is cut to a whole 32-bit number, as KIELER reads it', () => {
        expect(coerceInputs(iface, { n: 2.9, V_val: -3.7 })).toEqual({ values: { n: 2, V_val: -3 } })
        expect(coerceInputs(iface, { n: 1e12 })).toEqual({ values: { n: 2 ** 31 - 1 } })
    })

    test('a wrong type or a name that is not an input is refused, with the inputs it has', () => {
        expect(coerceInputs(iface, { b: 1 })).toEqual({ error: '`b` takes true or false.' })
        expect(coerceInputs(iface, { n: '3' })).toEqual({ error: '`n` takes a number.' })
        expect(coerceInputs(iface, { s: 3 })).toEqual({ error: '`s` takes a string.' })
        expect(coerceInputs(iface, { arr: 3 })).toEqual({ error: '`arr` takes an array.' })
        const unknown = coerceInputs(iface, { out: 1 })
        expect('error' in unknown && unknown.error).toMatch(/`out` is not an input of this chart \(its inputs: b, n, f, s, V, V_val, arr\)/)
        expect(coerceInputs(compile('scchart N {\n  initial state S\n}\n').interface, { x: true })).toEqual({ error: '`x` is not an input of this chart, which has no inputs.' })
    })
})

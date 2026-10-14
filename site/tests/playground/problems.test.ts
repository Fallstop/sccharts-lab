// The simulation's Variables picker (variables.ts) and KIELER's words in the problems list (recorded.ts).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { compile } from '../../src/engine/index'
import { defaultShow, isDefault, loadChoice, resolveShow, saveChoice, variableChoices } from '../../src/components/playground/variables'
import { spanAt, withRecording } from '../../src/components/playground/recorded'
import { errorLink } from '../../src/components/frame/error-links'

const timed = `scchart Timer {
  input bool start
  input output int limit = 3
  output signal int tick
  output bool done = false
  int count = 0
  const int MAX = 9
  clock t
  struct { int x } pt

  initial state Idle
    if start go to Run
  state Run {
    int laps = 0
    initial state Go
  }
    if t >= 300 do done = true go to Idle
}
`
const all = () => true

describe('the variables a reader can trace', () => {
    afterEach(() => vi.unstubAllGlobals())

    test('grouped as inputs, outputs, locals (with their scope), members and time; constants are not variables', () => {
        const { choices } = variableChoices(compile(timed), all)
        expect(choices.map(c => [c.label, c.group, c.detail, c.byDefault])).toEqual([
            ['start', 'input', 'input bool', true],
            ['limit', 'input', 'input output int', true],
            ['tick', 'output', 'output signal int', true],
            ['done', 'output', 'output bool', true],
            ['count', 'local', 'local int', true],
            ['laps', 'local', 'local int, in state Run', false],
            ['pt.x', 'member', 'member of pt: int', false],
            ['t', 'time', 'clock', true],
            ['deltaT', 'time', 'added by KIELER: input float', true],
            ['sleepT', 'time', 'added by KIELER: output float', true],
        ])
        expect(choices.find(c => c.label === 'laps')?.scope).toBe('in state Run')
    })

    test('only what the panel can draw a lane for is offered; the rest is counted', () => {
        const compiled = compile(timed)
        const { choices, untraceable } = variableChoices(compiled)
        expect(choices.length + untraceable).toBe(variableChoices(compiled, all).choices.length)
        // Everything in KIELER's data pool can be traced, and so can the locals of inner states and the members
        // (SimPanel's lanes from SimTickResult.trace).
        expect(choices.filter(c => c.byDefault).map(c => c.name)).toEqual(['start', 'limit', 'tick', 'done', 'count', 't', 'deltaT', 'sleepT'])
        expect(choices.filter(c => !c.byDefault).map(c => c.label)).toEqual(['laps', 'pt.x'])
        expect(untraceable).toBe(0)
    })

    test('the default is KIELER\'s data pool: inputs, outputs and the top-level locals', () => {
        const { choices } = variableChoices(compile(timed), all)
        expect(defaultShow(choices)).toEqual(['start', 'limit', 'tick', 'done', 'count', 't', 'deltaT', 'sleepT'])
        expect(resolveShow(choices, undefined)).toEqual(defaultShow(choices))
    })

    test('a saved choice applies to the variables it knew; a variable added since gets its default', () => {
        const { choices } = variableChoices(compile(timed), all)
        const known = choices.map(c => c.name).filter(n => n !== 'count')
        expect(resolveShow(choices, { known, show: ['start', 'done'] })).toEqual(['start', 'done', 'count'])
    })

    test('remembered per chart in local storage; the default is not stored; blocked storage is harmless', () => {
        const map = new Map<string, string>()
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => void map.set(k, v),
            removeItem: (k: string) => void map.delete(k),
        })
        const { choices } = variableChoices(compile(timed), all)
        saveChoice('Timer', choices, ['done'])
        expect(loadChoice('Timer')).toEqual({ known: choices.map(c => c.name), show: ['done'] })
        expect(loadChoice('Other')).toBeUndefined()
        saveChoice('Timer', choices, defaultShow(choices))
        expect(loadChoice('Timer')).toBeUndefined()
        expect(isDefault(choices, [...defaultShow(choices)].reverse())).toBe(true)
        map.set('sccharts-guide:playground:variables:Bad', '{not json')
        expect(loadChoice('Bad')).toBeUndefined()
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError') },
            setItem: () => { throw new Error('SecurityError') },
            removeItem: () => { throw new Error('SecurityError') },
        })
        expect(loadChoice('Timer')).toBeUndefined()
        expect(() => saveChoice('Timer', choices, ['done'])).not.toThrow()
    })
})

const ex = (id: string) => path.resolve('src/examples', id)
const example = (id: string) => ({ source: fs.readFileSync(`${ex(id)}.sctx`, 'utf8'), rec: JSON.parse(fs.readFileSync(`${ex(id)}.oracle.json`, 'utf8')) })

describe("KIELER's words for an example as recorded", () => {
    test('a syntax error: each problem with KIELER\'s message, then what only KIELER reports, without its noise', () => {
        const { source, rec } = example('learn/first-chart/err-goto')
        const problems = withRecording(compile(source).diagnostics, rec, source)
        expect(problems.map(p => [p.severity, p.span?.line, p.kielerOnly ?? false, p.kielerOnly ? p.message : p.kieler])).toEqual([
            ['error', 6, false, "no viable alternative at input 'goto'"],
            ['error', 8, true, "mismatched input 'state' expecting 'to'"],
            ['warning', 8, true, 'The state is not reachable.'],
        ])
        expect(problems.some(p => /required feature/.test(p.message))).toBe(false)
        expect(problems[0].recorded).toBe(true)
        // They link to the error reference by KIELER's words.
        expect(errorLink(problems[0])).toBe('/reference/errors/#no-viable-alternative-at-input-x')
        expect(errorLink({ message: problems[2].message })).toBe('/reference/errors/#the-state-is-not-reachable')
    })

    test('a message KIELER words a little differently (the states of a loop in another order) is paired by its line', () => {
        const { source, rec } = example('advanced/connectors/loop')
        const engine = compile(source).diagnostics
        const problems = withRecording(engine, rec, source)
        expect(problems.filter(p => p.kielerOnly)).toEqual([])
        const loops = problems.filter(p => p.code === 'immediate-loop')
        expect(loops.length).toBeGreaterThan(0)
        for (const p of loops) expect(p.kieler).toMatch(/Involved states: \[Check, Add\]/)
    })

    test('without a recording, the engine\'s diagnostics as they are', () => {
        const d = compile('scchart A {\n  initial state S\n  if x go to S\n}\n').diagnostics
        expect(withRecording(d, undefined, '')).toBe(d)
    })

    test('KIELER\'s line and column as a span of the word there', () => {
        const src = 'scchart A {\n  initial state S\n    if b goto T\n}\n'
        const s = spanAt(src, 3, 10)!
        expect(src.slice(s.start, s.end)).toBe('goto')
        expect([s.line, s.col]).toEqual([3, 10])
        expect(spanAt(src, 9)).toBeUndefined()
    })
})

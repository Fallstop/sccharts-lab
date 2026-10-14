// Line maps, timing-diagram lanes and "What happened", on real charts compiled by the guide's engine.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { TickResult } from '../../src/engine/types'
import { describeTick, explainTick } from '../../src/components/sim/describe'
import { elementsOf, errorClasses, lineMap, stateName, tickLines, transitionName } from '../../src/components/sim/lines'
import { lanesFor, regionLanes, traceSvg, traceWindow } from '../../src/components/sim/trace'

const read = (id: string) => fs.readFileSync(new URL(`../../src/examples/${id}.sctx`, import.meta.url), 'utf8')
const toggle = read('landing/toggle')
const abro = read('design/widgets-test/abro')

const tick = (t: Partial<TickResult> & { tick: number }): TickResult => ({
    inputs: {}, values: {}, present: {}, active: [], entered: [], exited: [], taken: [], actions: [], terminated: false, log: [], printed: [], ...t,
})

describe('lineMap', () => {
    const c = compile(toggle)
    const map = lineMap(c.chart!, toggle)

    it('knows the lines of states, transitions and declarations', () => {
        expect(map.heads['Toggle.Off']).toBe(5)
        expect(map.spans['Toggle.Off->1']).toEqual([6, 6])
        expect(map.spans['Toggle$light']).toEqual([3, 3])
        expect(map.spans['Toggle.On']).toEqual([8, 8])
    })

    it('gives every code line its innermost element', () => {
        expect(map.owners[2]).toBe('Toggle$button')
        expect(map.owners[5]).toBe('Toggle.Off')
        expect(map.owners[6]).toBe('Toggle.Off->1')
        expect(map.owners[4]).toBe('')
        expect(map.owners[10]).toBe('Toggle')
    })

    it('marks the head line of each active state and every line of a fired transition', () => {
        expect(tickLines(map, { active: ['Toggle', 'Toggle.On'], taken: ['Toggle.Off->1'] }, 'Toggle')).toEqual({ active: [8], taken: [6] })
    })

    it('marks the element on a diagnostic\'s line when the diagnostic names none', () => {
        const d = [{ severity: 'error' as const, message: 'x', span: { start: 0, end: 1, line: 6, col: 5, endLine: 6, endCol: 6 } }]
        expect(errorClasses(d, map, 'Toggle')).toEqual({ 'Toggle.Off->1': ['is-error'] })
        expect(errorClasses([{ ...d[0], related: ['Toggle.On'] }], map, 'Toggle')).toEqual({ 'Toggle.On': ['is-error'] })
    })

    it('gives diagram elements accessible names: kind, name, and a transition\'s source text', () => {
        expect(map.names?.['Toggle.Off']).toBe('initial state Off')
        expect(map.names?.['Toggle.On']).toBe('state On')
        expect(map.names?.['Toggle.Off->1']).toBe('transition Off to On: if button do light = true go to On')
        expect(map.names?.['Toggle']).toBeUndefined()
        const a = compile(abro).chart!
        const names = lineMap(a, abro).names!
        expect(names['ABRO.ABO']).toBe('initial superstate ABO')
        expect(names['ABRO.ABO.WaitAB.DoneA']).toBe('final state DoneA')
        expect(names['ABRO.ABO.WaitAB:HandleA']).toBe('region HandleA')
        expect(names['ABRO.ABO->1']).toBe('transition ABO to ABO: if R abort to ABO')
    })

    it('names states and transitions without the chart', () => {
        const info = elementsOf(compile(abro).chart!)
        expect(stateName('ABRO.ABO.WaitAB.WaitA', 'ABRO')).toBe('ABO.WaitAB.WaitA')
        expect(transitionName(info, 'ABRO.ABO.WaitAB.WaitA->1')).toBe('ABO.WaitAB.WaitA → ABO.WaitAB.DoneA')
    })
})

describe('timing-diagram lanes', () => {
    it('puts inputs first, then outputs, then one lane per region', () => {
        const c = compile(abro)
        expect(lanesFor(c.interface, c.chart).map((l) => `${l.name}:${l.role}`)).toEqual([
            'A:input', 'B:input', 'R:input', 'O:output', 'state:state', 'ABO:state', 'HandleA:state', 'HandleB:state',
        ])
    })

    it('shows a region\'s active state, and no value while the region is not active', () => {
        const c = compile(abro)
        const lane = regionLanes(c.chart!).find((l) => l.name === 'HandleA')!
        expect(lane.sample(tick({ tick: 2, active: ['ABRO', 'ABRO.ABO', 'ABRO.ABO.WaitAB', 'ABRO.ABO.WaitAB.DoneA'] }))).toBe('DoneA')
        expect(lane.sample(tick({ tick: 3, active: ['ABRO', 'ABRO.ABO', 'ABRO.ABO.Done'] }))).toBeNull()
    })

    it('draws pure signals as levels and valued signals with presence and value', () => {
        const c = compile('scchart S { input signal A output signal int V initial state I }')
        const [a, vv] = lanesFor(c.interface, c.chart, undefined, false)
        expect(a.kind).toBe('bool')
        expect(a.sample(tick({ tick: 1, present: { A: true } }))).toBe(true)
        expect(vv.kind).toBe('signal')
        expect(vv.sample(tick({ tick: 1, present: { V: false }, values: { V: 4 } }))).toEqual({ present: false, value: 4 })
    })

    it('draws a window of at most `window` ticks that contains the cursor', () => {
        expect(traceWindow(50, 50, 120)).toEqual([0, 50])
        expect(traceWindow(500, 500, 120)).toEqual([380, 120])
        expect(traceWindow(500, 10, 120)).toEqual([0, 120])
    })

    it('renders clickable columns, dims the ticks after the one shown and marks termination', () => {
        const c = compile(toggle)
        const lanes = lanesFor(c.interface, c.chart)
        const history = [1, 2, 3].map((n) => tick({ tick: n, active: ['Toggle', 'Toggle.Off'], terminated: n === 3, terminatedNow: n === 3 }))
        const svg = traceSvg(lanes, { history, cursor: 2, width: 600 })
        expect((svg.match(/class="wv-hit"/g) ?? []).length).toBe(3)
        expect(svg).toContain('class="wv-future"')
        expect(svg).toContain('class="wv-term"')
        expect(svg).toMatch(/class="wv-tick is-cursor"[^>]*>2</)
    })

    it('adds the values as a table for screen readers and hides the drawing from them', () => {
        const c = compile(toggle)
        const lanes = lanesFor(c.interface, c.chart)
        const history = [1, 2, 3].map((n) => tick({ tick: n, values: { button: n === 2, light: n >= 2 }, active: ['Toggle', n >= 2 ? 'Toggle.On' : 'Toggle.Off'], terminated: n === 3, terminatedNow: n === 3 }))
        const html = traceSvg(lanes, { history, cursor: 2, width: 600 }, 'Timing diagram of Toggle')
        expect(html).toContain('<div class="sc-visually-hidden wv-table-wrap"><table class="wv-table"><caption>Timing diagram of Toggle</caption>')
        expect(html).toContain('<th scope="col">input bool button</th><th scope="col">output bool light</th><th scope="col">Active state of the chart</th>')
        expect(html).toContain('<tr aria-current="true"><th scope="row">Tick 2, shown</th><td>true</td><td>true</td><td>On</td></tr>')
        expect(html).toContain('<th scope="row">Tick 3, after the tick shown, the chart terminated</th>')
        expect(html).not.toMatch(/<svg class="sc-wave sc-wave__lanes"[^>]*role="img"/)
        expect(html).toMatch(/<svg class="sc-wave sc-wave__lanes"[^>]*aria-hidden="true"/)
    })
})

describe('describeTick (the engine\'s sentences, marked up)', () => {
    const c = compile(toggle)
    const ctx = { info: elementsOf(c.chart!), source: toggle, iface: c.interface, program: c.program }

    it('marks states, identifiers, triggers and values as code, and finds the elements', () => {
        const sim = createSimulation(c)
        const t1 = sim.step({ button: false })
        const t2 = sim.step({ button: true })
        expect(describeTick(t1, undefined, ctx).items[0]).toEqual({ kind: 'enter', text: 'The chart starts in `Off`.', ids: ['Toggle.Off'] })
        const s = describeTick(t2, t1, ctx)
        expect(s.items[0].kind).toBe('take')
        // A trigger that is one variable is said plainly (src/engine/sim/describe.ts).
        expect(s.items[0].text).toBe('`Off` went to `On` because `button` was `true`.')
        expect(s.items[0].ids.sort()).toEqual(['Toggle$button', 'Toggle.Off', 'Toggle.Off->1', 'Toggle.On'])
        expect(s.summary).toMatch(/^Tick 2\. Off went to On because button was true/)
    })

    it('reads a terminating tick', () => {
        const src = read('design/widgets-test/countdown')
        const cc = compile(src)
        const sim = createSimulation(cc)
        for (const i of [{ start: false }, { start: true }, {}, {}] as Record<string, boolean>[]) sim.step(i)
        const t5 = sim.step({})
        const s = describeTick(t5, sim.history[3], { info: elementsOf(cc.chart!), source: src, iface: cc.interface, program: cc.program })
        expect(s.items.map((i) => i.kind)).toContain('term')
        expect(s.items[0].text).not.toMatch(/n was 0/)
    })

    it('takes the code spans from the engine, so a name that is also a word stays a word', () => {
        // `now` is a variable of the chart: "is now 6" must not become "is `now` 6".
        const src = read('reference/operators/previous')
        const cc = compile(src)
        const sim = createSimulation(cc)
        const t1 = sim.step({ I: 5 })
        const t2 = sim.step({ I: 6 })
        const s = describeTick(t2, t1, { info: elementsOf(cc.chart!), source: src, iface: cc.interface, program: cc.program })
        expect(s.items.map((i) => i.text)).toContain('`now` is now `6` and `before` is now `5`.')
        expect(s.items.find((i) => i.kind === 'value')?.ids).toContain('Previous$now')
    })

    it('names the elements of a reference copy by the reference in "Explain this tick"', () => {
        const src = read('advanced/references/lamp-panel')
        const cc = compile(src)
        const sim = createSimulation(cc)
        sim.step({ left: false, right: false })
        const t2 = sim.step({ left: true, right: false })
        const lines = explainTick(t2, { info: elementsOf(cc.chart!), source: src, iface: cc.interface, program: cc.program }).map((l) => l.text)
        expect(lines).toContain('Take `Off` → `On` inside `Left` (a copy of `PushSwitch`)')
        expect(lines.join('\n')).not.toMatch(/PushSwitch\.Off|->\d/)
    })

    it('explains the log in order', () => {
        const lines = explainTick(tick({
            tick: 2,
            log: [
                { kind: 'check', transition: 'Toggle.Off->1', result: true },
                { kind: 'exit', state: 'Toggle.Off' },
                { kind: 'take', transition: 'Toggle.Off->1' },
                { kind: 'write', variable: 'light', value: true, by: 'Toggle.Off->1', how: 'update' },
                { kind: 'enter', state: 'Toggle.On' },
                { kind: 'pause', state: 'Toggle.On', region: 'Toggle:0' },
            ],
        }), ctx)
        expect(lines.map((l) => l.text)).toEqual([
            'Check the trigger `button` of `Off` → `On`: true',
            'Leave `Off`',
            'Take `Off` → `On`',
            '`light = true` (by `Off` → `On`)',
            'Enter `On`',
            '`On` waits for the next tick',
        ])
        expect(lines[0].ids).toEqual(['Toggle.Off->1'])
    })
})

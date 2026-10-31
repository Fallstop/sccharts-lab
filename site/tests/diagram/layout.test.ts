// Layout and rendering: determinism, the DOM contract (data-id and classes), every construct, geometry
// sanity (no overlapping labels, edges clear of other labels) and speed.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { layoutChart, renderSvg } from '../../src/diagram'
import type { Box, RegionLayout, StateLayout } from '../../src/diagram'
import { flatten } from '../../src/diagram/geometry'
import type { State } from '../../src/engine/types'
import { chartOf } from './support'

const here = path.dirname(new URL(import.meta.url).pathname)
const chartFiles = fs.readdirSync(path.join(here, 'charts')).filter(f => f.endsWith('.sctx')).sort()
const read = (f: string) => fs.readFileSync(path.join(here, 'charts', f), 'utf8')

function allStates(s: StateLayout, out: StateLayout[] = []): StateLayout[] {
    out.push(s)
    for (const r of s.regions) for (const c of r.states) allStates(c, out)
    return out
}
function allRegions(s: StateLayout, out: RegionLayout[] = []): RegionLayout[] {
    for (const r of s.regions) {
        out.push(r)
        for (const c of r.states) allRegions(c, out)
    }
    return out
}
function astIds(chart: State): { states: string[]; regions: string[]; transitions: string[]; actions: string[] } {
    const ids = { states: [] as string[], regions: [] as string[], transitions: [] as string[], actions: [] as string[] }
    const walk = (s: State) => {
        ids.states.push(s.id)
        ids.actions.push(...s.actions.map(a => a.id))
        ids.transitions.push(...s.transitions.map(t => t.id))
        for (const r of s.regions) {
            ids.regions.push(r.id)
            r.states.forEach(walk)
        }
    }
    walk(chart)
    return ids
}

const overlap = (a: Box, b: Box, slack = 0) =>
    a.x + slack < b.x + b.width && b.x + slack < a.x + a.width && a.y + slack < b.y + b.height && b.y + slack < a.y + a.height

/** Tags must nest properly (a cheap well-formedness check of the generated markup). */
function wellFormed(svg: string): boolean {
    const stack: string[] = []
    for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
        if (m[3]) continue
        if (m[1]) { if (stack.pop() !== m[2]) return false } else stack.push(m[2])
    }
    return stack.length === 0
}

describe('every test chart lays out and renders', () => {
    for (const file of chartFiles) {
        describe(file, async () => {
            const { chart } = await chartOf(read(file))
            const layout = await layoutChart(chart)
            const svg = renderSvg(layout)

            it('is deterministic', async () => {
                const again = await layoutChart((await chartOf(read(file))).chart)
                expect(again).toEqual(layout)
                expect(renderSvg(again)).toBe(svg)
            })
            it('puts every element id on the SVG', () => {
                const ids = astIds(chart)
                const dataIds = new Set([...svg.matchAll(/data-id="([^"]*)"/g)].map(m => m[1].replace(/&gt;/g, '>').replace(/&amp;/g, '&')))
                for (const id of [...ids.states, ...ids.transitions, ...ids.actions]) expect(dataIds.has(id), id).toBe(true)
                for (const id of ids.regions) {
                    const region = chart && allRegions(layout.root).find(r => r.id === id)
                    if (region) expect(dataIds.has(id), id).toBe(true)
                }
            })
            it('is well-formed markup with real text', () => {
                expect(wellFormed(svg)).toBe(true)
                expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
                expect(svg).toContain('<text ')
                expect(svg).toContain(`viewBox="-6 -6 `)
            })
            it('keeps labels apart and edges clear of other labels', () => {
                for (const region of allRegions(layout.root)) {
                    const labels = region.transitions.filter(t => t.label)
                    for (const t of labels) {
                        for (const u of labels) if (t !== u) expect(overlap(t.label!, u.label!, 1), `${t.id} / ${u.id}`).toBe(false)
                        for (const s of region.states) expect(overlap(t.label!, s, 1), `${t.id} over ${s.id}`).toBe(false)
                    }
                    for (const t of region.transitions) {
                        for (const u of labels) {
                            if (u === t) continue
                            const box = u.label!
                            const inside = flatten(t.points).filter(p => p.x > box.x + 2 && p.x < box.x + box.width - 2 && p.y > box.y + 2 && p.y < box.y + box.height - 2)
                            expect(inside.length, `${t.id} through the label of ${u.id}`).toBe(0)
                        }
                    }
                }
            })
            it('spreads the self-loops of a state over its sides, each label next to its own loop', () => {
                // Distance from a label box to the nearest point of a loop.
                const gap = (box: Box, points: { x: number; y: number }[]) => Math.min(...flatten(points).map(p =>
                    Math.hypot(Math.max(box.x - p.x, 0, p.x - box.x - box.width), Math.max(box.y - p.y, 0, p.y - box.y - box.height))))
                // The side of the state a loop is on (from the middle of its points).
                const side = (s: Box, points: { x: number; y: number }[]) => {
                    const ps = flatten(points)
                    const dx = (ps.reduce((n, p) => n + p.x, 0) / ps.length - (s.x + s.width / 2)) / s.width
                    const dy = (ps.reduce((n, p) => n + p.y, 0) / ps.length - (s.y + s.height / 2)) / s.height
                    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north'
                }
                for (const region of allRegions(layout.root)) {
                    for (const s of region.states) {
                        const loops = region.transitions.filter(t => t.source === s.id && t.target === s.id)
                        if (loops.length < 2) continue
                        // No side has more than half of them (KIELER and ELK's default stack them all on one side).
                        const count = new Map<string, number>()
                        for (const t of loops) count.set(side(s, t.points), (count.get(side(s, t.points)) ?? 0) + 1)
                        expect(Math.max(...count.values()), `${s.id}: ${JSON.stringify(Object.fromEntries(count))}`).toBeLessThanOrEqual(Math.ceil(loops.length / 2))
                        for (const t of loops) {
                            if (!t.label) continue
                            const own = gap(t.label, t.points)
                            expect(own, `${t.id}: label ${own.toFixed(1)} away from its loop`).toBeLessThan(12)
                            for (const u of loops) if (u !== t) expect(gap(t.label, u.points), `${t.id}: label nearer to ${u.id}`).toBeGreaterThan(own)
                        }
                    }
                }
            })
            it('nests states inside their regions and regions inside their states', () => {
                const contains = (outer: Box, inner: Box) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
                    inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5
                for (const s of allStates(layout.root)) for (const r of s.regions) {
                    expect(contains(s, r), `${r.id} in ${s.id}`).toBe(true)
                    for (const c of r.states) expect(contains(r, c), `${c.id} in ${r.id}`).toBe(true)
                }
            })
        })
    }
})

describe('the DOM contract', () => {
    it('uses the stable classes', async () => {
        const { chart } = await chartOf(read('probe-labels.sctx'))
        const svg = renderSvg(await layoutChart(chart))
        for (const c of ['sc-root', 'sc-state', 'sc-superstate', 'sc-initial', 'sc-final', 'sc-connector', 'sc-region', 'sc-transition', 'sc-immediate', 'sc-strong', 'sc-label', 'sc-history', 'sc-deferred']) {
            expect(svg, c).toMatch(new RegExp(`class="[^"]*\\b${c}\\b`))
        }
        const abro = renderSvg(await layoutChart((await chartOf(read('abro.sctx'))).chart))
        expect(abro).toMatch(/class="[^"]*\bsc-termination\b/)
    })
    it('applies initial highlight classes', async () => {
        const { chart } = await chartOf(read('abro.sctx'))
        const svg = renderSvg(await layoutChart(chart), { classes: { 'ABRO.ABO.WaitAB.WaitA': ['is-active'], 'ABRO.ABO.WaitAB.WaitA->1': ['is-taken'] } })
        expect(svg).toMatch(/class="sc-state sc-simple sc-initial is-active" data-id="ABRO.ABO.WaitAB.WaitA"/)
        expect(svg).toMatch(/class="sc-transition is-taken" data-id="ABRO.ABO.WaitAB.WaitA-&gt;1"/)
    })
    it('sizes itself responsively', async () => {
        const layout = await layoutChart((await chartOf(read('abro.sctx'))).chart)
        const natural = renderSvg(layout)
        expect(natural).toMatch(/width="100%"/)
        expect(natural).toMatch(new RegExp(`max-width:${Math.round((layout.width + 12) * 1.25 * 100) / 100}px`))
        expect(renderSvg(layout, { fit: 'width' })).not.toMatch(/max-width/)
        expect(renderSvg(layout, { fit: 'none', scale: 1 })).toMatch(new RegExp(`width="${layout.width + 12}"`))
        expect(renderSvg(layout, { minScale: 0.5 })).toMatch(/min-width:/)
    })
    it('describes the chart for screen readers', async () => {
        const svg = renderSvg(await layoutChart((await chartOf(read('abro.sctx'))).chart))
        expect(svg).toMatch(/role="img"/)
        expect(svg).toMatch(/<title id="[^"]+">SCChart ABRO<\/title>/)
        expect(svg).toMatch(/<desc id="[^"]+">States: ABO \(initial, superstate\), WaitAB/)
    })
})

describe('constructs', () => {
    const layoutOf = async (source: string, options = {}) => layoutChart((await chartOf(source)).chart, options)

    it('simple, initial, final and connector states', async () => {
        const layout = await layoutOf(`scchart S {
  input bool a
  initial state A
  if a go to C
  connector state C
  immediate go to F
  final state F
  initial final state G
}`)
        const [, A, C, F, G] = allStates(layout.root)
        expect(A).toMatchObject({ shape: 'simple', initial: true, lineWidth: 3, radius: 17, height: 34 })
        expect(C).toMatchObject({ shape: 'connector', width: 10, height: 10 })
        expect(F).toMatchObject({ shape: 'simple', final: true, finalInset: 3, radius: 20, height: 40 })
        expect(G).toMatchObject({ final: true, initial: true, finalInset: 4, lineWidth: 3 })
        const t = layout.root.regions[0].transitions
        expect(t.find(x => x.source === C.id)?.immediate).toBe(true)
    })
    it('superstates with declarations, actions and regions', async () => {
        const layout = await layoutOf(read('actions.sctx'))
        const B = allStates(layout.root).find(s => s.name === 'B')!
        expect(B.shape).toBe('superstate')
        expect(B.lines.map(l => l.role)).toEqual(['title', 'action', 'action', 'action', 'action', 'action'])
        expect(B.lines[1].ids).toEqual(['Actions.B!entry0'])
        expect(layout.root.lines.filter(l => l.role === 'declaration').map(l => l.ids)).toEqual([['Actions$trigger'], ['Actions$effect']])
    })
    it('alternates the direction with depth (HV) and honours VH and annotations', async () => {
        const nested = read('probe-nesting.sctx')
        const hv = await layoutOf(nested)
        expect(allRegions(hv.root).map(r => r.direction)).toEqual(['RIGHT', 'DOWN', 'DOWN', 'RIGHT'])
        const vh = await layoutOf(nested, { direction: 'VH' })
        expect(allRegions(vh.root).map(r => r.direction)).toEqual(['DOWN', 'RIGHT', 'RIGHT', 'DOWN'])
        const down = await layoutOf(nested, { direction: 'down' })
        expect(allRegions(down.root).every(r => r.direction === 'DOWN')).toBe(true)
        const annotated = await layoutOf(`scchart T {
  @layout[elk.direction] UP
  region "up":
  initial state A
  go to B
  final state B
}`)
        expect(annotated.root.regions[0].direction).toBe('UP')
        const vhAnnotation = await layoutOf(`@VHLayout
scchart T {
  initial state A
  go to B
  final state B
}`)
        expect(vhAnnotation.root.regions[0].direction).toBe('DOWN')
    })
    it('history, deferred, strong abort and termination transitions', async () => {
        const layout = await layoutOf(read('complex-transitions.sctx'))
        const t = allRegions(layout.root).flatMap(r => r.transitions)
        expect(t.map(x => [x.history, x.deferred].filter(Boolean).join(','))).toContain('shallow')
        expect(t.some(x => x.history === 'deep')).toBe(true)
        expect(t.some(x => x.deferred === 'shallow')).toBe(true)
        const aborts = await layoutOf(read('aborts.sctx'))
        const at = allRegions(aborts.root).flatMap(r => r.transitions)
        expect(at.filter(x => x.preemption === 'strong')).toHaveLength(2)
        expect(at.filter(x => x.preemption === 'termination')).toHaveLength(1)
        // Spline routing: start, then three points per cubic segment.
        for (const x of at) expect((x.points.length - 1) % 3, x.id).toBe(0)
    })
    it('on-edge labels with KIELER\'s semantic line breaks and soft wrapping', async () => {
        const layout = await layoutOf(read('transitions.sctx'))
        const labels = layout.root.regions[0].transitions.map(t => t.label!.lines.map(l => l.runs.map(r => r.text).join('')))
        expect(labels).toEqual([['A', '/ X++'], ['A && B', '/ X++;', 'Y = X * 2']])
        const long = await layoutOf(`scchart L {
  input int a, b, c, d
  output int o
  initial state A
  if a > 1 && b > 2 && c > 3 && d > 4 && a + b + c + d > 100 && a * b * c * d < 1000 do o = a + b + c + d + a * b * c * d go to B
  state B
}`)
        const lines = long.root.regions[0].transitions[0].label!.lines
        expect(lines.length).toBeGreaterThan(2)
        for (const l of lines) expect(l.width).toBeLessThanOrEqual(200 * 1.3)
        const unwrapped = await layoutOf(`scchart L {
  input int a, b, c, d
  initial state A
  if a > 1 && b > 2 && c > 3 && d > 4 && a + b + c + d > 100 && a * b * c * d < 1000 go to B
  state B
}`, { labelWidth: 0 })
        expect(unwrapped.root.regions[0].transitions[0].label!.lines).toHaveLength(1)
    })
    it('label direction follows the edge', async () => {
        const layout = await layoutOf(read('probe-nesting.sctx'))
        const regions = allRegions(layout.root)
        expect(regions[0].transitions.find(t => t.label)?.label?.direction).toBe('right')
        expect(regions[1].transitions[0].label?.direction).toBe('down')
    })
    it('dataflow regions as a circuit or as equations', async () => {
        const source = read('probe-reference-dataflow.sctx')
        const circuit = await layoutOf(source)
        const df = circuit.root.regions.find(r => r.dataflow)!
        expect(df.circuit!.nodes.map(n => `${n.kind}:${n.text}`)).toEqual(['output:b', 'operator:&&', 'input:a', 'operator:!', 'operator:pre'])
        expect(df.circuit!.wires).toHaveLength(5)
        const list = await layoutOf(source, { dataflowCircuit: false })
        expect(list.root.regions.find(r => r.dataflow)!.lines.map(l => l.runs[0].text)).toEqual(['b = a && !pre(a)'])
    })
    it('reference states, collapsed and hidden elements', async () => {
        const ref = await layoutOf(read('probe-reference-dataflow.sctx'))
        const R = allStates(ref.root).find(s => s.name === 'R')!
        expect(R).toMatchObject({ reference: true, shape: 'superstate' })
        expect(R.lines[0].runs.map(r => [r.text, r.format])).toEqual([['R', 'text'], ['@', 'keyword'], ['Inner (a, b)', 'text']])
        expect(R.regions[0].collapsed).toBe(true)
        const collapsed = await layoutOf(`scchart T {
  @collapse
  region R:
  initial state A
  go to B
  final state B
}`)
        expect(collapsed.root.regions[0]).toMatchObject({ collapsed: true, states: [] })
        const viaOption = await layoutOf(read('abro.sctx'), { collapsed: ['ABRO.ABO.WaitAB:HandleA'] })
        expect(allRegions(viaOption.root).find(r => r.name === 'HandleA')?.collapsed).toBe(true)
        const hidden = await layoutOf(`scchart T {
  initial state A
  go to B
  @hide
  final state B
}`)
        expect(hidden.root.regions[0].states.map(s => s.name)).toEqual(['A'])
        expect(hidden.root.regions[0].transitions).toEqual([])
    })
    it('expands reference states on request', async () => {
        const source = read('../kieler/states.sctx')
        const { chart, program } = await chartOf(source)
        const collapsed = await layoutChart(chart, { program })
        const ref = (l: typeof collapsed) => allStates(l.root).find(s => s.name === 'Ref')!
        expect(ref(collapsed).regions[0].collapsed).toBe(true)
        const expanded = await layoutChart(chart, { program, references: 'expanded' })
        const inner = ref(expanded).regions[0]
        expect(inner.collapsed).toBe(false)
        expect(inner.states.map(s => s.id)).toEqual(['States.Ref/Other'])
        expect(allStates(inner.states[0]).map(s => s.id)).toEqual(['States.Ref/Other', 'States.Ref/Other.S', 'States.Ref/Other.T'])
        expect(inner.states[0].regions[0].transitions.map(t => [t.id, t.source, t.target])).toEqual([['States.Ref/Other.S->1', 'States.Ref/Other.S', 'States.Ref/Other.T']])
        const byId = await layoutChart(chart, { program, references: ['States.Ref'] })
        expect(ref(byId).regions[0].collapsed).toBe(false)
        // A chart that references itself is expanded only once.
        const selfRef = await chartOf(`scchart Loop {
  initial state L is Loop()
}`)
        const loop = await layoutChart(selfRef.chart, { program: selfRef.program, references: 'expanded' })
        expect(allStates(loop.root).length).toBeLessThan(10)
    })
    it('doc comments as KIELER draws them by default ("Comment Nodes" is on)', async () => {
        const source = `/** The chart. */
scchart T {
  input bool b
  /** The region's comment has no edge. */
  region R:
  /** Waits for the button. */
  /** Second comment. */
  initial state A
  /** Pressed.
   * Really. */
  if b go to B
  /** Done. */
  final state B
}`
        const on = await layoutOf(source)
        const region = on.root.regions[0]
        expect(region.comments.map(c => [c.id, c.lines.map(l => l.runs.map(r => r.text).join(''))])).toEqual([
            ['T:R#doc', ['The region\'s comment has no edge.']], ['T.A#doc', ['Waits for the button.']], ['T.A#doc1', ['Second comment.']], ['T.B#doc', ['Done.']],
        ])
        // State comments are joined to their state; ELK puts them above or below it (the region runs left to right).
        const a = region.states.find(s => s.id === 'T.A')!
        for (const c of region.comments.slice(1, 3)) {
            expect(c.points?.length).toBeGreaterThanOrEqual(2)
            expect(c.y + c.height <= a.y || c.y >= a.y + a.height, c.id).toBe(true)
        }
        expect(region.comments[0].points).toBeUndefined()
        // The chart's comment above the root, centred, 10 apart, joined by an edge.
        const [rc] = on.root.comments
        expect(rc.id).toBe('T#doc')
        expect(rc.y + rc.height + 10).toBeCloseTo(on.root.y, 1)
        expect(rc.x + rc.width / 2).toBeCloseTo(on.root.x + on.root.width / 2, 0)
        expect(on.height).toBeCloseTo(on.root.y + on.root.height, 1)
        // A transition's comments are extra labels in front of the main one, styled like it.
        const t = region.transitions[0]
        expect(t.comments?.map(c => c.lines.map(l => l.runs.map(r => r.text).join('')))).toEqual([['Pressed.', 'Really.']])
        expect(t.comments![0].y + t.comments![0].height).toBeLessThanOrEqual(t.label!.y + 0.5)
        const svg = renderSvg(on)
        expect(svg).toContain('class="sc-label sc-label-comment"')
        expect(svg).toContain('data-id="T#doc"')
        // KIELER's option, off.
        const off = await layoutOf(`@diagram[commentNodes] false\n${source}`)
        expect(off.root.comments).toEqual([])
        expect(off.root.regions[0].comments).toEqual([])
        expect(off.root.regions[0].transitions[0].comments).toBeUndefined()
        expect((await layoutOf(source, { comments: false })).root.regions[0].comments).toEqual([])
    })
    it('honours @diagram synthesis options on the chart', async () => {
        const layout = await layoutOf(`@diagram[initiallyCollapseRegions] true
@diagram[direction] Down
@diagram[shadows] off
scchart T {
  input bool a
  initial state A {
    initial state X
    if a go to Y
    final state Y
  }
  go to B
  state B
}`)
        expect(layout.root.regions[0].direction).toBe('DOWN')
        expect(allRegions(layout.root).map(r => [r.id, r.collapsed])).toEqual([['T:0', true]])
        expect(layout.shadows).toBe(false)
        expect(renderSvg(layout)).not.toContain('sc-shadow')
        const noDecls = await layoutOf(`@diagram[decl] false
scchart T {
  input bool a
  initial state A
}`)
        expect(noDecls.root.lines.map(l => l.role)).toEqual(['title'])
    })
    it('an empty chart', async () => {
        const layout = await layoutOf('scchart Empty {\n}')
        expect(layout.root).toMatchObject({ shape: 'root', regions: [] })
        expect(layout.width).toBeGreaterThan(30)
        expect(renderSvg(layout)).toContain('Empty')
    })
})

function bigChart(n: number): string {
    const lines = ['scchart Big {', '  input bool a, b, c', '  output int x = 0']
    for (let i = 0; i < n; i++) {
        lines.push(`  ${i === 0 ? 'initial ' : ''}state S${i}${i % 6 === 3 ? ` {\n    entry do x = ${i}\n    initial state I${i}\n    if a go to J${i}\n    final state J${i}\n  }\n  join to S${i + 1}` : ''}`)
        if (i % 6 !== 3) {
            lines.push(`  if a && x < ${i} do x++ go to S${(i + 1) % n}`)
            if (i % 4 === 0) lines.push(`  if b go to S${(i + 7) % n}`)
            if (i % 5 === 1) lines.push(`  immediate if c do x = 0 abort to S${(i + 3) % n}`)
        }
    }
    lines.push('}')
    return lines.join('\n')
}

describe('speed', () => {
    it('lays out and renders a 30-state chart well under 300 ms', async () => {
        const { chart } = await chartOf(bigChart(30))
        await layoutChart(chart) // warm up the JIT and ELK
        // The fastest of seven runs, so that a busy machine (other test workers, oracles) does not fail the test.
        const times: number[] = []
        for (let i = 0; i < 7; i++) {
            const t0 = performance.now()
            renderSvg(await layoutChart(chart))
            times.push(performance.now() - t0)
        }
        times.sort((p, q) => p - q)
        // About 130 ms on an idle laptop (almost all of it in ELK); the budget is 300 ms.
        expect(times[0]).toBeLessThan(300)
    })
})

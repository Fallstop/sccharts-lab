// Comparison of the guide's diagram with a recording of KIELER's own diagram (tools/diagram-kieler-labels.mjs):
// texts, line styles, decorators, region directions and the arrangement of states.

import { describe, expect, it } from 'vitest'
import { layoutChart } from '../../src/diagram'
import type { DiagramLayout, RegionLayout, StateLayout, TextLine, TransitionLayout } from '../../src/diagram'
import { transitionLabel, transitionLabelLines } from '../../src/engine/format'
import type { State, Transition } from '../../src/engine/types'
import { chartOf } from './support'

export interface KielerLabels {
    /** sha256 (16 hex digits) of the chart source the recording was made from. */
    sourceHash?: string
    states: { path: (string | number)[]; rows: string[][]; box?: [number, number, number, number] }[]
    regions: { path: (string | number)[]; label: string[]; rows?: string[][]; dataflow?: boolean; direction?: string; box?: [number, number, number, number] }[]
    comments?: { path: (string | number)[]; text: string }[]
    edges: {
        source: (string | number)[]; target: (string | number)[]; text: string; lines: string[]; dashed: boolean; decorators: string[]
        /** The transition's doc comments (extra labels); recorded since the recorder knows them. */
        comments?: { text: string; lines: string[] }[]
    }[]
}

const runs = (line: TextLine) => line.runs.map(r => r.text.trim()).filter(Boolean)
const clean = (texts: string[]) => texts.map(t => t.trim()).filter(Boolean)
const key = (p: (string | number)[]) => JSON.stringify(p)

function index(layout: DiagramLayout) {
    const states = new Map<string, StateLayout>()
    const regions = new Map<string, RegionLayout>()
    const pathOf = new Map<string, (string | number)[]>()
    const transitions: TransitionLayout[] = []
    const walk = (s: StateLayout, p: (string | number)[]) => {
        states.set(key(p), s)
        pathOf.set(s.id, p)
        s.regions.forEach((r, i) => {
            const rp = [...p, r.name ?? i]
            regions.set(key(rp), r)
            // KIELER names the implicit state of `region R { region A: ... }` "_implicit" (shown without title).
            for (const c of r.states) walk(c, [...rp, c.name || '_implicit'])
            transitions.push(...r.transitions)
        })
    }
    walk(layout.root, [layout.root.name])
    return { states, regions, pathOf, transitions }
}

function astTransitions(chart: State): Map<string, { t: Transition; outgoing: number }> {
    const map = new Map<string, { t: Transition; outgoing: number }>()
    const walk = (s: State) => {
        for (const t of s.transitions) map.set(t.id, { t, outgoing: s.transitions.length })
        for (const r of s.regions) r.states.forEach(walk)
    }
    walk(chart)
    return map
}

/** KIELER's lines are ours, some of them soft-wrapped further (by KIELER's font widths). */
function refines(kieler: string[], ours: string[]): boolean {
    let i = 0
    for (const line of ours) {
        const want = line.trim().replace(/\s+/g, ' ')
        let got = ''
        while (i < kieler.length && got.length < want.length) got = (got ? got + ' ' : '') + kieler[i++].trim()
        if (got.replace(/\s+/g, ' ') !== want) return false
    }
    return i === kieler.length
}

/** Registers the comparison tests for one chart. */
export function compareWithKieler(title: string, source: string, reference: KielerLabels) {
    describe(title, async () => {
        const parsed = await chartOf(source).catch(() => undefined)
        if (!parsed) {
            it('has no chart, and KIELER shows none either', () => expect(reference.states.length).toBe(0))
            return
        }
        const { chart, program } = parsed
        const layout = await layoutChart(chart, { program })
        const { states, regions, pathOf, transitions } = index(layout)
        const ast = astTransitions(chart)
        // KIELER's dataflow synthesis (actors and wires) is not mirrored one to one; its regions are skipped.
        const dataflowRegions = reference.regions.filter(r => r.dataflow).map(r => key(r.path).slice(0, -1))

        it('state names, titles, declarations and actions', () => {
            for (const s of reference.states) {
                const ours = states.get(key(s.path))
                if (!ours) {
                    // KIELER's dataflow actors are nodes too; they are not states.
                    if (dataflowRegions.some(prefix => key(s.path).startsWith(prefix))) continue
                    if (String(s.path.at(-1)) === 'ref') continue
                    throw new Error(`missing state ${key(s.path)}`)
                }
                expect(ours.lines.map(runs), key(s.path)).toEqual(s.rows.map(clean).filter(r => r.length))
            }
        })
        it('region labels', () => {
            for (const r of reference.regions) {
                if (r.dataflow) continue
                const ours = regions.get(key(r.path))
                if (!ours) {
                    // The body of a reference state (KIELER's collapsed reference region) has no label either.
                    expect(clean(r.label)).toEqual([])
                    continue
                }
                expect(ours.label ? runs(ours.label) : [], key(r.path)).toEqual(clean(r.label))
                // Region-level declarations and actions.
                if (r.rows) expect(ours.lines.filter(l => l.role !== 'equation').map(runs), `${key(r.path)} rows`).toEqual(r.rows.map(clean).filter(x => x.length))
            }
        })
        it('region directions and the arrangement of states', () => {
            for (const r of reference.regions) {
                if (r.dataflow) continue
                const ours = regions.get(key(r.path))
                if (!ours) continue
                if (r.direction && r.direction !== 'UNDEFINED') expect(ours.direction, key(r.path)).toBe(r.direction)
                // States that KIELER puts clearly apart along an axis keep that order here.
                const inRegion = reference.states.filter(s => s.box && s.path.length === r.path.length + 1 && key(s.path.slice(0, -1)) === key(r.path))
                for (const a of inRegion) for (const b of inRegion) {
                    const sa = states.get(key(a.path)), sb = states.get(key(b.path))
                    if (!sa || !sb || a === b) continue
                    const [ax, ay, aw, ah] = a.box!, [bx, by, bw, bh] = b.box!
                    if (ax + aw + 10 < bx) expect(sa.x + sa.width, `${key(a.path)} left of ${key(b.path)}`).toBeLessThan(sb.x)
                    if (ay + ah + 10 < by) expect(sa.y + sa.height, `${key(a.path)} above ${key(b.path)}`).toBeLessThan(sb.y)
                }
            }
        })
        it('comment boxes (KIELER\'s "Comment Nodes" is on by default)', () => {
            const text = (lines: TextLine[]) => lines.map(l => l.runs.map(r => r.text).join('')).join('\n')
            const theirs = new Map<string, string[]>()
            for (const c of reference.comments ?? []) {
                const parent = key(c.path.slice(0, -1))
                theirs.set(parent, [...(theirs.get(parent) ?? []), c.text])
            }
            const ours = new Map<string, string[]>()
            if (layout.root.comments.length) ours.set(key([]), layout.root.comments.map(c => text(c.lines)))
            for (const [k, r] of regions) if (r.comments.length) ours.set(k, r.comments.map(c => text(c.lines)))
            // KIELER's dataflow regions are not mirrored (no comment boxes there).
            for (const k of [...theirs.keys()]) if (reference.regions.find(r => key(r.path) === k)?.dataflow) theirs.delete(k)
            const sorted = (m: Map<string, string[]>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]).sort())
            expect(sorted(ours)).toEqual(sorted(theirs))
        })
        it('the order of regions in their states', () => {
            // Rectpacking fills rows in model order; with other text widths the rows break elsewhere, but the
            // reading order (top to bottom, left to right) of a state's regions and method boxes stays KIELER's.
            const byParent = new Map<string, typeof reference.regions>()
            for (const r of reference.regions) {
                if (!r.box || !regions.get(key(r.path))) continue
                const parent = key(r.path.slice(0, -1))
                byParent.set(parent, [...(byParent.get(parent) ?? []), r])
            }
            const reading = <T,>(items: T[], box: (t: T) => { x: number; y: number }) =>
                [...items].sort((a, b) => Math.round(box(a).y) - Math.round(box(b).y) || box(a).x - box(b).x)
            for (const list of byParent.values()) {
                const theirs = reading(list, r => ({ x: r.box![0], y: r.box![1] })).map(r => key(r.path))
                const ours = reading(list, r => regions.get(key(r.path))!).map(r => key(r.path))
                expect(ours).toEqual(theirs)
            }
        })
        it('transition labels, line styles and decorators', () => {
            const seen = new Map<string, number>()
            for (const e of reference.edges) {
                const pair = key(e.source) + key(e.target)
                const n = seen.get(pair) ?? 0
                seen.set(pair, n + 1)
                const candidates = transitions.filter(t => key(pathOf.get(t.source) ?? []) === key(e.source) && key(pathOf.get(t.target) ?? []) === key(e.target))
                const t = candidates[n]
                expect(t, `transition ${pair} #${n}`).toBeDefined()
                const { t: astT, outgoing } = ast.get(t.id)!
                expect(transitionLabel(astT, outgoing), t.id).toBe(e.text)
                if (e.lines.length) expect(refines(e.lines, transitionLabelLines(astT, outgoing)), `${t.id} lines ${JSON.stringify(e.lines)}`).toBe(true)
                expect(t.immediate, `${t.id} dashed`).toBe(e.dashed)
                const deco: string[] = ['arrow']
                if (t.preemption === 'strong') deco.push('red-circle')
                if (t.preemption === 'termination') deco.push('termination')
                if (t.history) deco.push(`history-${t.history}`)
                if (t.deferred) deco.push(t.deferred === 'deep' ? 'red-circle-deep' : 'red-circle')
                expect(deco.sort(), `${t.id} decorators`).toEqual([...e.decorators].sort())
                // Doc comments as extra labels (recordings made before the recorder knew them have none).
                if (e.comments || t.comments) {
                    // Their text is the doc comment's; their lines are it, soft-wrapped (by KIELER's font widths there).
                    const texts = astT.annotations.filter(a => a.name === 'comment').map(a => a.values[0])
                    expect(t.comments?.length ?? 0, `${t.id} comment labels`).toBe(e.comments?.length ?? 0)
                    e.comments?.forEach((c, i) => {
                        expect(c.text, `${t.id} comment ${i}`).toBe(texts[i])
                        expect(refines(c.lines, texts[i].split('\n')), `${t.id} comment ${i} lines ${JSON.stringify(c.lines)}`).toBe(true)
                    })
                }
            }
            expect(reference.edges.length).toBe(transitions.length)
        })
    })
}

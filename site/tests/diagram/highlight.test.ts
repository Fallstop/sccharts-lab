import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyClasses, elementsAt, layoutChart, mergeClasses, renderSvg, spanOf, tickClasses } from '../../src/diagram'
import { chartOf } from './support'

const here = path.dirname(new URL(import.meta.url).pathname)
const abro = fs.readFileSync(path.join(here, 'charts/abro.sctx'), 'utf8')

/** A tiny stand-in for the DOM: elements parsed from the SVG's data-id attributes. */
function fakeDom(svg: string) {
    const elements = [...svg.matchAll(/<\w+ class="([^"]*)"[^>]*?data-id="([^"]*)"(?: data-ids="([^"]*)")?/g)].map(m => {
        const classes = new Set(m[1].split(' '))
        const attrs: Record<string, string> = { 'data-id': m[2].replace(/&gt;/g, '>') }
        if (m[3]) attrs['data-ids'] = m[3]
        return {
            classes,
            getAttribute: (n: string) => attrs[n] ?? null,
            classList: { add: (...c: string[]) => c.forEach(x => classes.add(x)), remove: (...c: string[]) => c.forEach(x => classes.delete(x)) },
        }
    })
    return { elements, querySelectorAll: () => elements }
}

describe('highlighting', () => {
    it('turns a tick into classes', () => {
        const map = tickClasses({ active: ['A', 'A.B'], entered: ['A.B'], exited: ['A.C'], taken: ['A.C->1', 'A.C->1'] })
        expect(map).toEqual({ A: ['is-active'], 'A.B': ['is-active', 'is-entered'], 'A.C': ['is-exited'], 'A.C->1': ['is-taken'] })
        expect(mergeClasses(map, { A: ['is-focus'] }).A).toEqual(['is-active', 'is-focus'])
    })
    it('applies classes to a rendered diagram and clears old ones', async () => {
        const { chart } = await chartOf(abro)
        const layout = await layoutChart(chart)
        const dom = fakeDom(renderSvg(layout))
        const waitA = dom.elements.find(e => e.getAttribute('data-id') === 'ABRO.ABO.WaitAB.WaitA')!
        applyClasses(dom, { 'ABRO.ABO.WaitAB.WaitA': ['is-active'], 'ABRO$A': ['is-focus'] })
        expect(waitA.classes.has('is-active')).toBe(true)
        const decl = dom.elements.find(e => e.getAttribute('data-ids')?.includes('ABRO$B'))!
        expect(decl.classes.has('is-focus')).toBe(true)
        applyClasses(dom, {})
        expect(waitA.classes.has('is-active')).toBe(false)
        expect(waitA.classes.has('sc-state')).toBe(true)
    })
    it('links source offsets and diagram elements', async () => {
        const { chart } = await chartOf(abro)
        const layout = await layoutChart(chart)
        const offset = abro.indexOf('WaitB\n')
        expect(elementsAt(layout, offset)[0]).toBe('ABRO.ABO.WaitAB.WaitB')
        const span = spanOf(layout, 'ABRO.ABO.WaitAB.WaitB')
        expect(span && abro.slice(span.start, span.end)).toMatch(/state WaitB/)
        const t = abro.indexOf('if R go to ABO')
        expect(elementsAt(layout, t + 3)).toContain('ABRO.ABO->1')
    })
})

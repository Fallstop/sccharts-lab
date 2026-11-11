// The code the playground's Embed dialog hands out (src/components/embed/snippet.ts).
import { describe, expect, test } from 'vitest'
import { elementSnippet, iframeSnippet, iframeSrc, type EmbedChoice } from '../../src/components/embed/snippet'
import { parseEmbedQuery } from '@sccharts-lab/embed/options'
import { projectFromHash, sourceFromHash } from '../../src/components/playground/share'

const base = 'https://sccharts.jmw.nz/'
const example: EmbedChoice = { base, target: { view: 'sim', height: 'auto' }, chart: { example: 'learn/concurrency/abro' }, title: 'ABRO in SCCharts Lab' }
const code = 'scchart Less {\n  input int n\n  output bool small = false\n  initial state S\n    if n < 3 && n > -1 do small = true go to S\n}\n'
const own: EmbedChoice = { base, target: { view: 'full', height: 'auto' }, chart: { name: 'Less', files: { 'less.sctx': code }, active: 'less.sctx' }, title: 'Less in SCCharts Lab' }

describe('the iframe', () => {
    test('an example by its id; the frame fills the height it is given', () => {
        expect(iframeSrc(example)).toBe('https://sccharts.jmw.nz/embed/?example=learn/concurrency/abro')
        expect(iframeSnippet(example, 553)).toBe(
            '<iframe src="https://sccharts.jmw.nz/embed/?example=learn/concurrency/abro" title="ABRO in SCCharts Lab" width="100%" height="560" style="border: 0" loading="lazy"></iframe>',
        )
        expect(iframeSnippet({ ...example, target: { ...example.target, height: 400 } })).toContain('height="400"')
    })

    test('a chart of its own travels in the hash, as playground links carry it', () => {
        const src = iframeSrc(own)
        expect(src.startsWith('https://sccharts.jmw.nz/embed/?view=full#code=')).toBe(true)
        expect(sourceFromHash(new URL(src).hash)).toBe(code)
        expect(parseEmbedQuery(new URL(src).search).view).toBe('full')
    })

    test('a project of several files, and a run', () => {
        const project: EmbedChoice = { ...own, chart: { name: 'P', files: { 'main.sctx': 'import "b"\nscchart M {}', 'b.sctx': 'scchart B {}' }, active: 'main.sctx' }, run: 'RUNCODE' }
        const url = new URL(iframeSrc(project))
        expect(projectFromHash(url.hash)).toEqual({ name: 'P', files: { 'main.sctx': 'import "b"\nscchart M {}', 'b.sctx': 'scchart B {}' }, active: 'main.sctx' })
        expect(url.hash.endsWith('&run=RUNCODE')).toBe(true)
        expect(iframeSrc({ ...example, run: 'RUNCODE' })).toBe('https://sccharts.jmw.nz/embed/?example=learn/concurrency/abro#run=RUNCODE')
    })

    test('attributes are escaped', () => {
        expect(iframeSnippet({ ...example, title: 'A "quoted" <title> & more' })).toContain('title="A &quot;quoted&quot; &lt;title> &amp; more"')
    })
})

describe('the web component', () => {
    test('an example: the loader and one element; the defaults are left out', () => {
        expect(elementSnippet(example)).toBe('<script src="https://sccharts.jmw.nz/embed.js" async></script>\n<sccharts-lab-chart example="learn/concurrency/abro"></sccharts-lab-chart>')
        expect(elementSnippet({ ...example, target: { view: 'diagram', height: 360, tour: true, tick: 2, controls: false, chart: 'ABRO' }, run: 'R1' })).toBe(
            '<script src="https://sccharts.jmw.nz/embed.js" async></script>\n<sccharts-lab-chart example="learn/concurrency/abro" view="diagram" height="360" tour tick="2" controls="false" chart="ABRO" run="R1"></sccharts-lab-chart>',
        )
    })

    test('a chart of its own in a <pre>, escaped, so that it reads as code without JavaScript', () => {
        const s = elementSnippet(own)
        expect(s).toContain('<sccharts-lab-chart view="full">\n<pre>\nscchart Less {')
        expect(s).toContain('if n &lt; 3 &amp;&amp; n &gt; -1 do')
        expect(s).not.toContain('n < 3')
        expect(s.endsWith('}\n</pre>\n</sccharts-lab-chart>')).toBe(true)
    })

    test('several files: the active one first, each named', () => {
        const s = elementSnippet({ ...own, chart: { name: 'P', files: { 'b.sctx': 'scchart B {}', 'main.sctx': 'import "b"\nscchart M {}' }, active: 'main.sctx' } })
        expect(s.indexOf('data-file="main.sctx"')).toBeLessThan(s.indexOf('data-file="b.sctx"'))
    })
})

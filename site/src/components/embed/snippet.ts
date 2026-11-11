// The code the Embed dialog hands out: an iframe (works anywhere HTML does, a course page's editor too) and the
// <sccharts-lab-chart> web component (sizes itself; its chart inline as a <pre>, which reads as code without
// JavaScript). Pure.

import { embedUrl, estimateHeight, type EmbedTarget } from '@sccharts-lab/embed/options'
import { hashForProject } from '../playground/share'

export interface EmbedChoice {
    /** The site the embed comes from (`https://sccharts.jmw.nz/`). */
    base: string
    /** The view, the height (`auto` or pixels), the tour, the tick. */
    target: EmbedTarget
    /** The chart: a guide example as it is, or files (the editor's text). */
    chart: { example: string } | { name: string; files: Record<string, string>; active: string }
    /** A run to replay (the playground's `run=` encoding). */
    run?: string
    /** What the frame is called (its title, for screen readers). */
    title: string
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The embed's address for the iframe. */
export function iframeSrc(c: EmbedChoice): string {
    const target = { ...c.target, height: undefined }
    if ('example' in c.chart) return embedUrl(c.base, { ...target, example: c.chart.example }, c.run ? `run=${c.run}` : undefined)
    const hash = hashForProject({ name: c.chart.name, files: c.chart.files, active: c.chart.active }).slice(1)
    return embedUrl(c.base, target, c.run ? `${hash}&run=${c.run}` : hash)
}

/** `<iframe>`: an iframe keeps the height it is given (`auto`: the height the preview needed, `measured`). */
export function iframeSnippet(c: EmbedChoice, measured?: number): string {
    const h = typeof c.target.height === 'number' ? c.target.height : Math.ceil((measured ?? estimateHeight(c.target.view ?? 'sim')) / 10) * 10
    return `<iframe src="${attr(iframeSrc(c))}" title="${attr(c.title)}" width="100%" height="${h}" style="border: 0" loading="lazy"></iframe>`
}

/** `<sccharts-lab-chart>` and its loader. */
export function elementSnippet(c: EmbedChoice): string {
    const t = c.target
    const attrs: string[] = []
    if ('example' in c.chart) attrs.push(`example="${attr(c.chart.example)}"`)
    if (t.view && t.view !== 'sim') attrs.push(`view="${t.view}"`)
    if (typeof t.height === 'number') attrs.push(`height="${t.height}"`)
    if (t.tour) attrs.push('tour')
    if (t.tick) attrs.push(`tick="${t.tick}"`)
    if (t.controls === false) attrs.push('controls="false"')
    if (t.chart) attrs.push(`chart="${attr(t.chart)}"`)
    if (c.run) attrs.push(`run="${attr(c.run)}"`)
    const open = `<sccharts-lab-chart${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
    const base = c.base.endsWith('/') ? c.base : `${c.base}/`
    const script = `<script src="${attr(base)}embed.js" async></script>`
    if ('example' in c.chart) return `${script}\n${open}</sccharts-lab-chart>`
    const { files, active } = c.chart
    const paths = [active, ...Object.keys(files).filter(p => p !== active)]
    const blocks = paths.map(p => {
        const body = files[p].replace(/\s+$/, '')
        return `<pre${paths.length > 1 ? ` data-file="${attr(p)}"` : ''}>\n${text(body)}\n</pre>`
    })
    return `${script}\n${open}\n${blocks.join('\n')}\n</sccharts-lab-chart>`
}

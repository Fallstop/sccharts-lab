// "Download the diagram": the rendered chart as a standalone SVG file, in KIELER's light colours (for a report or a
// slide), with the diagram's stylesheet inside so it looks the same in any viewer. Highlights from the simulation and
// the editor are left out.

import diagramCss from '../../diagram/diagram.css?raw'
import { HIGHLIGHT_CLASSES } from '../../diagram/highlight'
import sansUrl from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2?url'
import monoUrl from '@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2?url'

/** The diagram's fonts as data URLs: the layout measured its text in them, so a file without them would not fit. */
async function fontFaces(): Promise<string> {
    const embed = async (family: string, url: string) => {
        try {
            const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            return `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2')}`
        } catch {
            return ''
        }
    }
    return (await Promise.all([embed('Atkinson Hyperlegible Next Variable', sansUrl), embed('Atkinson Hyperlegible Mono Variable', monoUrl)])).join('')
}

const VARS = [...new Set(diagramCss.match(/--sc-[a-z0-9-]+/g) ?? [])]

/** The --sc-* values of the light theme (read with the light theme switched on for an instant, without a repaint). */
function lightValues(): string {
    const root = document.documentElement
    const before = root.getAttribute('data-theme')
    root.setAttribute('data-theme', 'light')
    const cs = getComputedStyle(root)
    const out = VARS.map(v => [v, cs.getPropertyValue(v).trim()] as const).filter(([, value]) => value)
    if (before === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', before)
    return out.map(([k, v]) => `${k}:${v}`).join(';')
}

export async function standaloneSvg(svg: SVGSVGElement): Promise<string> {
    const fonts = await fontFaces()
    const clone = svg.cloneNode(true) as SVGSVGElement
    const w = svg.getAttribute('data-natural-width')
    const h = svg.getAttribute('data-natural-height')
    clone.removeAttribute('style')
    clone.classList.remove('sc-pg-svg')
    if (w) clone.setAttribute('width', w)
    if (h) clone.setAttribute('height', h)
    for (const el of clone.querySelectorAll('[class]')) el.classList.remove(...HIGHLIGHT_CLASSES)
    // The marks drawn over the highlights: pulses, for-region copy badges and error markers (link.ts).
    clone.querySelectorAll('.sc-edge-pulse, .sc-copy-badge, .sc-error-marker').forEach(el => el.remove())
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    // No motion in a file; a white sheet behind the chart.
    style.textContent = `${fonts}.sc-diagram{${lightValues()};background:#fff}${diagramCss}\n.sc-diagram *{animation:none!important;transition:none!important}`
    clone.insertBefore(style, clone.firstChild)
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`
}

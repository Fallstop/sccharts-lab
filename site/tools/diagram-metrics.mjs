#!/usr/bin/env node
// Measures the diagram fonts in chromium and writes src/diagram/font-metrics.ts: the advance width of every
// character the diagrams are likely to show, for the regular and bold weights of the sans font and for the
// mono font, plus the vertical metrics. The diagram layout measures text with this table, so build-time
// (Node) and in-browser layouts are identical. The renderer switches kerning and ligatures off, which makes
// a string's rendered width exactly the sum of its characters' advances.
//
//   node tools/diagram-metrics.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from './chromium.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'src/diagram/font-metrics.ts')

const SANS = {
    family: 'Atkinson Hyperlegible Next Variable',
    files: [
        'node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2',
        'node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
    ],
}
const MONO = {
    family: 'Atkinson Hyperlegible Mono Variable',
    files: [
        'node_modules/@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2',
        'node_modules/@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-ext-wght-normal.woff2',
    ],
}

// Printable ASCII, Latin-1, Latin Extended-A, Greek, and the symbols KIELER's symbol tables and typical
// charts use (subscripts, arrows, comparison and logic signs, typographic punctuation).
const ranges = [[0x20, 0x7e], [0xa0, 0xff], [0x100, 0x17f], [0x391, 0x3a9], [0x3b1, 0x3c9], [0x2080, 0x2089], [0x2090, 0x209c],
    [0x2010, 0x2027], [0x2190, 0x2195], [0x2200, 0x22ff]]
const extra = [0x370, 0x371, 0x37f, 0x1d62, 0x2c7c, 0x2212, 0x25cf, 0x25cb, 0x2713, 0x2717]
const codepoints = []
for (const [a, b] of ranges) for (let c = a; c <= b; c++) codepoints.push(c)
codepoints.push(...extra)

function fontFace(font) {
    return font.files.map(file => {
        const data = fs.readFileSync(path.join(root, file)).toString('base64')
        return `@font-face { font-family: '${font.family}'; font-weight: 200 800; src: url(data:font/woff2;base64,${data}) format('woff2'); }`
    }).join('\n')
}

const browser = await launchChromium()
try {
    const page = await browser.newPage()
    await page.setContent(`<!doctype html><style>${fontFace(SANS)}\n${fontFace(MONO)}</style>
        <p style="font-family:'${SANS.family}'">a<b>b</b></p><p style="font-family:'${MONO.family}'">m<b>m</b></p>`)
    const result = await page.evaluate(async ({ sans, mono, codepoints }) => {
        for (const weight of [400, 700]) {
            await document.fonts.load(`${weight} 20px '${sans}'`)
            await document.fonts.load(`${weight} 20px '${mono}'`)
        }
        const ctx = document.createElement('canvas').getContext('2d')
        const SIZE = 1000
        function widths(family, weight) {
            ctx.font = `${weight} ${SIZE}px '${family}'`
            const map = {}
            for (const cp of codepoints) {
                const ch = String.fromCodePoint(cp)
                if (!document.fonts.check(`${weight} 20px '${family}'`, ch)) continue
                map[cp] = Math.round(ctx.measureText(ch).width * 1000 / SIZE)
            }
            return map
        }
        function vertical(family) {
            ctx.font = `400 ${SIZE}px '${family}'`
            const m = ctx.measureText('Hxg')
            const h = ctx.measureText('H')
            const x = ctx.measureText('x')
            return {
                ascent: m.fontBoundingBoxAscent / SIZE,
                descent: m.fontBoundingBoxDescent / SIZE,
                capHeight: h.actualBoundingBoxAscent / SIZE,
                xHeight: x.actualBoundingBoxAscent / SIZE,
            }
        }
        // Detect characters the font lacks (canvas would silently measure a fallback font): compare with
        // two different fallback families.
        function covered(family) {
            const set = new Set()
            for (const cp of codepoints) {
                const ch = String.fromCodePoint(cp)
                ctx.font = `400 100px '${family}', monospace`
                const a = ctx.measureText(ch).width
                ctx.font = `400 100px '${family}', serif`
                const b = ctx.measureText(ch).width
                if (a === b) set.add(cp)
            }
            return set
        }
        const sansCovered = covered(sans)
        const monoCovered = covered(mono)
        const filter = (map, set) => Object.fromEntries(Object.entries(map).filter(([cp]) => set.has(Number(cp))))
        return {
            sans: { regular: filter(widths(sans, 400), sansCovered), bold: filter(widths(sans, 700), sansCovered), ...vertical(sans) },
            mono: { regular: filter(widths(mono, 400), monoCovered), bold: filter(widths(mono, 700), monoCovered), ...vertical(mono) },
        }
    }, { sans: SANS.family, mono: MONO.family, codepoints })

    // Encode a width table as one string: runs of consecutive code points, "start:w,w,w;start:w,...".
    function encode(map) {
        const cps = Object.keys(map).map(Number).sort((a, b) => a - b)
        const runs = []
        let run = null
        for (const cp of cps) {
            if (run && cp === run.start + run.widths.length) run.widths.push(map[cp])
            else runs.push(run = { start: cp, widths: [map[cp]] })
        }
        return runs.map(r => `${r.start.toString(16)}:${r.widths.join(',')}`).join(';')
    }
    const r4 = n => Math.round(n * 10000) / 10000
    const fontEntry = (name, family, m) => `    ${name}: {
        family: ${JSON.stringify(family)},
        ascent: ${r4(m.ascent)},
        descent: ${r4(m.descent)},
        capHeight: ${r4(m.capHeight)},
        xHeight: ${r4(m.xHeight)},
        regular: ${JSON.stringify(encode(m.regular))},
        bold: ${JSON.stringify(encode(m.bold))},
    },`
    const ts = `// Generated by tools/diagram-metrics.mjs from the fonts in node_modules. Do not edit by hand.
// Advance widths in 1/1000 em, as runs "startCodePointHex:w,w,...;...". Vertical metrics in em.

export interface EncodedFontMetrics {
    family: string
    ascent: number
    descent: number
    capHeight: number
    xHeight: number
    regular: string
    bold: string
}

export const FONT_METRICS: { sans: EncodedFontMetrics; mono: EncodedFontMetrics } = {
${fontEntry('sans', SANS.family, result.sans)}
${fontEntry('mono', MONO.family, result.mono)}
}
`
    fs.writeFileSync(out, ts)
    console.log(`wrote ${path.relative(root, out)}: sans ${Object.keys(result.sans.regular).length} glyphs, mono ${Object.keys(result.mono.regular).length} glyphs`)
    console.log('sans vertical', r4(result.sans.ascent), r4(result.sans.descent), 'cap', r4(result.sans.capHeight), 'x', r4(result.sans.xHeight))
} finally {
    await browser.close()
}

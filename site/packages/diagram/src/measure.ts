// Deterministic text measurement for the diagram layout.
//
// Widths come from a table of advance widths generated from the site's diagram fonts
// (tools/diagram-metrics.mjs → font-metrics.ts). The renderer switches kerning and ligatures off, so a string
// renders exactly as wide as the sum of its characters' advances, in Node and in every browser that has the
// font. A browser can inject its own measurer (e.g. canvas) instead, at the price of layouts that differ from
// the pre-rendered ones.

import { FONT_METRICS, type EncodedFontMetrics } from './font-metrics'

export interface TextStyle {
    /** Font size in diagram units (px at scale 1). */
    size: number
    bold?: boolean
    mono?: boolean
}

/** Returns the advance width of `text` in diagram units. */
export type TextMeasurer = (text: string, style: TextStyle) => number

interface DecodedFont {
    family: string
    ascent: number
    descent: number
    capHeight: number
    regular: Map<number, number>
    bold: Map<number, number>
    fallbackRegular: number
    fallbackBold: number
}

function decodeWidths(encoded: string): Map<number, number> {
    const map = new Map<number, number>()
    for (const run of encoded.split(';')) {
        if (!run) continue
        const [startHex, list] = run.split(':')
        const start = parseInt(startHex, 16)
        list.split(',').forEach((w, i) => map.set(start + i, Number(w)))
    }
    return map
}

function average(map: Map<number, number>, from: number, to: number): number {
    let sum = 0
    let n = 0
    for (let c = from; c <= to; c++) {
        const w = map.get(c)
        if (w !== undefined) { sum += w; n++ }
    }
    return n ? sum / n : 550
}

function decode(m: EncodedFontMetrics): DecodedFont {
    const regular = decodeWidths(m.regular)
    const bold = decodeWidths(m.bold)
    return {
        family: m.family, ascent: m.ascent, descent: m.descent, capHeight: m.capHeight,
        regular, bold,
        fallbackRegular: average(regular, 0x61, 0x7a),
        fallbackBold: average(bold, 0x61, 0x7a),
    }
}

let sans: DecodedFont | undefined
let mono: DecodedFont | undefined
function font(isMono: boolean | undefined): DecodedFont {
    if (isMono) return (mono ??= decode(FONT_METRICS.mono))
    return (sans ??= decode(FONT_METRICS.sans))
}

/** The default measurer: the generated width table (no kerning). */
export const measureWithTable: TextMeasurer = (text, style) => {
    const f = font(style.mono)
    const table = style.bold ? f.bold : f.regular
    const fallback = style.bold ? f.fallbackBold : f.fallbackRegular
    let total = 0
    for (const ch of text) {
        const cp = ch.codePointAt(0)!
        total += table.get(cp) ?? (cp < 0x20 ? 0 : fallback)
    }
    return (total * style.size) / 1000
}

/** The font families the metrics were generated for (the renderer's fallback font stacks start with them). */
export const SANS_FAMILY = FONT_METRICS.sans.family
export const MONO_FAMILY = FONT_METRICS.mono.family

/** Line metrics used by the layout. `lineHeight` is the height of one line; `baseline` the distance from the
 *  line's top to its baseline (the font's ascent and descent centred in the line). */
export interface LineMetrics {
    lineHeight: number
    baseline: number
}

/** Line height relative to the font size. KIELER's AWT fonts give about 1.69; Atkinson Hyperlegible's
 *  natural line box is 1.3. */
export const LINE_HEIGHT = 1.42

export function lineMetrics(style: TextStyle): LineMetrics {
    const f = font(style.mono)
    const lineHeight = style.size * LINE_HEIGHT
    const content = (f.ascent + f.descent) * style.size
    return { lineHeight, baseline: (lineHeight - content) / 2 + f.ascent * style.size }
}

// Public API of the diagram renderer. See README.md for the DOM and class contract.
export { renderSvg } from './render'
export { measureWithTable, lineMetrics, SANS_FAMILY, MONO_FAMILY } from './measure'
export { HIGHLIGHT_CLASSES, applyClasses, elementsAt, mergeClasses, spanOf, tickClasses } from './highlight'
export type { ClassMap, HighlightClass } from './highlight'
export type { TextMeasurer, TextStyle } from './measure'
export type * from './types'

import type { State } from '@sccharts-lab/engine/types'
import { layoutChart as layoutWithElk } from './layout'
import { renderSvg } from './render'
import type { DiagramLayout, ElkLike, LayoutOptions, RenderOptions } from './types'

let bundledElk: Promise<ElkLike> | undefined

/** elkjs's bundled build (in a fake worker on the calling thread, in Node and in a browser), loaded on first use.
 *  Browser code that lays out in a Web Worker passes its own instance (elk-api, see README); importing
 *  layoutChart from ./layout instead keeps this 1.4 MB file out of a bundle altogether. */
function defaultElk(): Promise<ElkLike> {
    bundledElk ??= import('elkjs/lib/elk.bundled.js').then(m => {
        // CommonJS interop differs between Node, Vite and bundlers; the class is also its own `default`.
        const mod = m as unknown as { default?: { default?: unknown } }
        const ELK = (mod.default?.default ?? mod.default ?? mod) as new () => ElkLike
        return new ELK()
    })
    return bundledElk
}

/**
 * Lays out a chart (a root `State` from the engine's `parse` or `compile`) in KIELER's notation. Without
 * `options.elk`, with elkjs's bundled build, loaded on first use. The layout is plain JSON: `renderSvg` draws it.
 */
export async function layoutChart(chart: State, options: LayoutOptions = {}): Promise<DiagramLayout> {
    return layoutWithElk(chart, options.elk ? options : { ...options, elk: await defaultElk() })
}

/** `layoutChart`, then `renderSvg`: the chart's diagram as SVG markup. */
export async function chartToSvg(chart: State, options: LayoutOptions & RenderOptions = {}): Promise<string> {
    return renderSvg(await layoutChart(chart, options), options)
}

export { workerElk } from './elk-worker'

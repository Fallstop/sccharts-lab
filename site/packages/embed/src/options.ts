// The options of an embedded chart: the query of /embed/ (`?example=learn/abro&view=sim&height=auto`) and the
// attributes of <sccharts-lab-chart>, which become that query. Pure and dependency-free.
//
// The chart itself comes as in the playground: `?example=<id>`, `#code=<lz-string>` (one file), `#project=` (several),
// `#run=` (a run to replay) and `&chart=` in the hash; or, with `source=parent`, from the page (postMessage).

export type EmbedView = 'diagram' | 'sim' | 'editor' | 'full'
export const VIEWS: readonly EmbedView[] = ['diagram', 'sim', 'editor', 'full']
export const DEFAULT_VIEW: EmbedView = 'sim'

/** What each view shows. */
export const VIEW_PARTS: Record<EmbedView, { editor: boolean; sim: boolean }> = {
    diagram: { editor: false, sim: false },
    sim: { editor: false, sim: true },
    editor: { editor: true, sim: false },
    full: { editor: true, sim: true },
}

/** `fill`: the embed fills its frame (the iframe's height decides); `auto`: it takes the height its content needs and
 *  reports it (`resize`); a number: it is that many pixels tall. */
export type EmbedHeight = 'fill' | 'auto' | number
export const MIN_HEIGHT = 120
export const MAX_HEIGHT = 4000
export const MAX_TICK = 1000

export interface EmbedOptions {
    view: EmbedView
    height: EmbedHeight
    /** Start at this tick: of the shared run, of the guided tour, or stepped with the inputs as they are. */
    tick?: number
    /** Start in the example's guided tour (its scripted inputs, with notes). */
    tour: boolean
    /** The simulation's controls and the diagram's tools are shown (off: the page drives it with postMessage). */
    controls: boolean
    /** The chart of the file to show and simulate, when not its first. */
    chart?: string
    /** The chart comes from the page (postMessage `setSource` or `setFiles`), not from the address. */
    source?: 'parent'
}

export interface EmbedTarget extends Partial<EmbedOptions> {
    /** A guide example (`learn/abro/abro`, `showcase/abro`). */
    example?: string
}

export const DEFAULTS: EmbedOptions = { view: DEFAULT_VIEW, height: 'fill', tour: false, controls: true }

const IDENT = /^[A-Za-z_]\w{0,199}$/
const EXAMPLE = /^[\w-]+(\/[\w.-]+)*$/

const TRUE = new Set(['', '1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off', 'none'])

/** A flag: present and empty, or 1/true/yes/on; absent or anything else is `fallback`. */
export function parseFlag(value: string | null | undefined, fallback: boolean): boolean {
    if (value === null || value === undefined) return fallback
    const v = value.trim().toLowerCase()
    return TRUE.has(v) ? true : FALSE.has(v) ? false : fallback
}

export function parseView(value: string | null | undefined): EmbedView {
    const v = value?.trim().toLowerCase()
    return VIEWS.includes(v as EmbedView) ? (v as EmbedView) : DEFAULT_VIEW
}

/** `auto`, `fill`, or a number of pixels (`480`, `480px`) between MIN_HEIGHT and MAX_HEIGHT; else `fallback`. */
export function parseHeight(value: string | null | undefined, fallback: EmbedHeight = 'fill'): EmbedHeight {
    const v = value?.trim().toLowerCase()
    if (!v) return fallback
    if (v === 'auto' || v === 'fill') return v
    const m = /^(\d{2,4})(px)?$/.exec(v)
    if (!m) return fallback
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(m[1])))
}

/** A tick from 0 to MAX_TICK, or undefined. */
export function parseTick(value: string | null | undefined): number | undefined {
    const v = value?.trim()
    if (!v || !/^\d{1,6}$/.test(v)) return undefined
    return Math.min(MAX_TICK, Number(v))
}

export function parseChartName(value: string | null | undefined): string | undefined {
    const v = value?.trim()
    return v && IDENT.test(v) ? v : undefined
}

/** A guide example's id as links write it (`learn/abro/abro`), or undefined. */
export function parseExample(value: string | null | undefined): string | undefined {
    const v = value?.trim().replace(/^\/+/, '').replace(/\.sctx$/, '')
    return v && v.length <= 200 && EXAMPLE.test(v) && !v.split('/').includes('..') ? v : undefined
}

/** The options in an embed address's query (`location.search`); anything unknown or malformed is left at its default. */
export function parseEmbedQuery(search: string | URLSearchParams): EmbedOptions & { example?: string } {
    const q = typeof search === 'string' ? new URLSearchParams(search) : search
    const tick = parseTick(q.get('tick'))
    const chart = parseChartName(q.get('chart'))
    const example = parseExample(q.get('example'))
    return {
        view: parseView(q.get('view')),
        height: parseHeight(q.get('height')),
        tour: parseFlag(q.get('tour'), false),
        controls: parseFlag(q.get('controls'), true),
        ...(tick !== undefined ? { tick } : {}),
        ...(chart ? { chart } : {}),
        ...(q.get('source') === 'parent' ? { source: 'parent' as const } : {}),
        ...(example ? { example } : {}),
    }
}

/** The query for these options: only what differs from the defaults, in a fixed order. */
export function embedQuery(t: EmbedTarget): string {
    const parts: string[] = []
    const example = parseExample(t.example)
    if (example) parts.push(`example=${encodeURIComponent(example).replace(/%2F/g, '/')}`)
    if (t.source === 'parent') parts.push('source=parent')
    if (t.view && t.view !== DEFAULT_VIEW) parts.push(`view=${t.view}`)
    if (t.height !== undefined && t.height !== 'fill') parts.push(`height=${t.height}`)
    if (t.tour) parts.push('tour')
    if (t.tick !== undefined && t.tick > 0) parts.push(`tick=${Math.min(MAX_TICK, Math.floor(t.tick))}`)
    if (t.controls === false) parts.push('controls=0')
    if (t.chart && IDENT.test(t.chart)) parts.push(`chart=${t.chart}`)
    return parts.length ? `?${parts.join('&')}` : ''
}

/** The site an embed comes from (where /embed/ and /embed.js are). */
export const DEFAULT_BASE = 'https://sccharts.jmw.nz/'

/** The address of an embed: `<base>embed/?<options>#<hash>` (`hash`: a playground hash, `code=...`, without `#`). */
export function embedUrl(base: string, t: EmbedTarget, hash?: string): string {
    const root = base.endsWith('/') ? base : `${base}/`
    const h = hash?.replace(/^#/, '')
    return `${root}embed/${embedQuery(t)}${h ? `#${h}` : ''}`
}

/** The options of a <sccharts-lab-chart> from its attributes (`get`: the attribute's value, null when absent). Its
 *  height is `auto` unless given: the element resizes its frame to the content. */
export function targetFromAttributes(get: (name: string) => string | null): EmbedTarget {
    const tick = parseTick(get('tick'))
    const chart = parseChartName(get('chart'))
    const example = parseExample(get('example'))
    return {
        view: parseView(get('view')),
        height: parseHeight(get('height'), 'auto'),
        tour: parseFlag(get('tour'), false),
        controls: parseFlag(get('controls'), true),
        ...(tick !== undefined ? { tick } : {}),
        ...(chart ? { chart } : {}),
        ...(example ? { example } : {}),
    }
}

/** A first guess at an auto-sized embed's height, so the page moves little once it reports its own. */
export function estimateHeight(view: EmbedView, width = 640): number {
    const narrow = width < 640
    switch (view) {
        case 'diagram':
            return 340
        case 'sim':
            return narrow ? 620 : 560
        case 'editor':
            return narrow ? 640 : 380
        case 'full':
            return narrow ? 960 : 720
    }
}

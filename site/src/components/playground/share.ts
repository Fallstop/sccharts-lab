// Sharing a chart: its source travels in the URL hash, compressed with lz-string (`#code=<compressed>`), so a link
// needs no server; a run of it travels next to it (`&run=<compressed>`, the inputs of every tick). Also the
// scratch buffer's local autosave, which is a convenience only: every storage access is wrapped, so the
// playground works the same with storage blocked.

import LZString from 'lz-string'
import type { Value } from '../../engine/types'

const PREFIX = 'code='

/** The source, compressed for a URL (only characters that need no escaping in a fragment). */
export function encodeSource(source: string): string {
    return LZString.compressToEncodedURIComponent(source)
}

/** The source from `encodeSource`'s output, or null when it is not a valid encoding. */
export function decodeSource(encoded: string): string | null {
    if (!encoded) return null
    try {
        // Some mail and chat clients turn `+` into a space.
        const out = LZString.decompressFromEncodedURIComponent(encoded.replace(/ /g, '+'))
        return typeof out === 'string' && out.length > 0 ? out : null
    } catch {
        return null
    }
}

/** The source stored in a location hash (`#code=...`), or null. */
export function sourceFromHash(hash: string): string | null {
    const h = hash.replace(/^#/, '')
    for (const part of h.split('&')) {
        if (part.startsWith(PREFIX)) return decodeSource(part.slice(PREFIX.length))
    }
    return null
}

/** The hash that carries a source: `#code=...`. */
export function hashForSource(source: string): string {
    return `#${PREFIX}${encodeSource(source)}`
}

/** A link to the playground that opens `source` (any query, e.g. ?example=, is dropped: the hash wins). */
export function shareUrl(playground: string | URL, source: string): string {
    const url = new URL(playground.toString())
    url.search = ''
    url.hash = hashForSource(source)
    return url.toString()
}

// ----- A run: the inputs of every tick (`&run=<compressed>`) -----------------------------------------------------
//
// "Copy link to this run" puts the inputs each tick ran with next to the chart, so whoever opens the link sees the
// same run (as a tour through it: SimPanel's scenario). A tick's inputs are complete (every input, with KIELER's
// pool names: `V` and `V_val` for a valued signal; run-tour.ts finds them); the link stores, for each tick, only
// the ones that changed since the tick before, and decoding carries the others forward. Sending every input in
// every tick reproduces the run: an input the environment does not send keeps its value, here it is sent the
// value it had.

const RUN = 'run='
/** More ticks than anyone steps through by hand; a longer run is cut (the link would be too long anyway). */
export const MAX_RUN_TICKS = 2000

export interface SharedRun {
    /** The inputs of every tick (index 0 is tick 1), each complete. */
    ticks: Record<string, Value>[]
    /** The tick that was shown, 1 to ticks.length. */
    at: number
}

const isValue = (v: unknown): v is Value =>
    v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every(isValue))
const same = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** A run from the inputs of its ticks (a string never set, `null`, is left out) and the tick shown. */
export function makeRun(rows: Record<string, Value>[], cursor: number): SharedRun {
    const ticks = rows.slice(0, MAX_RUN_TICKS).map(row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)))
    return { ticks, at: Math.max(1, Math.min(ticks.length, Math.round(cursor) || 1)) }
}

/** The run, compressed for a URL: `{ v: 1, at, t: [changes of tick 1, changes of tick 2, ...] }`. */
export function encodeRun(run: SharedRun): string {
    let previous: Record<string, Value> = {}
    const t = run.ticks.map(row => {
        const changed: Record<string, Value> = {}
        for (const [k, v] of Object.entries(row)) if (!(k in previous) || !same(previous[k], v)) changed[k] = v
        previous = { ...previous, ...row }
        return changed
    })
    return LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, at: run.at, t }))
}

/** The run from `encodeRun`'s output, or null when it is not one. */
export function decodeRun(encoded: string): SharedRun | null {
    if (!encoded) return null
    try {
        const text = LZString.decompressFromEncodedURIComponent(encoded.replace(/ /g, '+'))
        if (!text) return null
        const data = JSON.parse(text) as { v?: unknown; at?: unknown; t?: unknown }
        if (data?.v !== 1 || !Array.isArray(data.t) || !data.t.length) return null
        const ticks: Record<string, Value>[] = []
        let row: Record<string, Value> = {}
        for (const changes of data.t.slice(0, MAX_RUN_TICKS)) {
            if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null
            for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
                if (!isValue(v)) return null
                row = { ...row, [k]: v }
            }
            ticks.push(row)
        }
        const at = typeof data.at === 'number' && Number.isFinite(data.at) ? Math.round(data.at) : ticks.length
        return { ticks, at: Math.max(1, Math.min(ticks.length, at)) }
    } catch {
        return null
    }
}

/** The run stored in a location hash (`#code=...&run=...`, or `#run=...` after `?example=`), or null. */
export function runFromHash(hash: string): SharedRun | null {
    for (const part of hash.replace(/^#/, '').split('&')) if (part.startsWith(RUN)) return decodeRun(part.slice(RUN.length))
    return null
}

/** The chart of the file a run belongs to (`&chart=<name>`), when it is not the file's first. */
export function chartFromHash(hash: string): string | undefined {
    for (const part of hash.replace(/^#/, '').split('&')) {
        if (!part.startsWith('chart=')) continue
        try {
            const name = decodeURIComponent(part.slice('chart='.length))
            return /^[A-Za-z_]\w*$/.test(name) ? name : undefined
        } catch {
            return undefined
        }
    }
    return undefined
}

/** The hash has a `run=` part (decodable or not). */
export const hasRun = (hash: string): boolean => hash.replace(/^#/, '').split('&').some(p => p.startsWith(RUN))

/**
 * A link to the playground that replays `run`: on a guide example as it is (`?example=<id>#run=...`, which keeps
 * its title and the files it imports), else with the source in the hash (`#code=...&run=...`). `name`: the chart
 * of the file that ran, when it is not the first (`&chart=<name>`).
 */
export function runUrl(playground: string | URL, run: SharedRun, chart: ({ example: string } | { source: string }) & { name?: string }): string {
    const url = new URL(playground.toString())
    url.search = 'example' in chart ? `?example=${encodeURIComponent(chart.example).replace(/%2F/g, '/')}` : ''
    const which = chart.name ? `&chart=${encodeURIComponent(chart.name)}` : ''
    url.hash = 'example' in chart ? `#${RUN}${encodeRun(run)}${which}` : `${hashForSource(chart.source)}&${RUN}${encodeRun(run)}${which}`
    return url.toString()
}

/** A file name for a download: the chart's name, else `chart`, with `.sctx`. */
export function fileNameFor(chartName: string | undefined): string {
    const base = (chartName ?? '').replace(/[^\w.-]+/g, '') || 'chart'
    return `${base}.sctx`
}

// ----- Local storage (never required) ----------------------------------------------------------------------------

export const SCRATCH_KEY = 'sccharts-guide:playground:scratch'

export function storageGet(key: string): string | null {
    try {
        return globalThis.localStorage?.getItem(key) ?? null
    } catch {
        return null
    }
}

export function storageSet(key: string, value: string | null): boolean {
    try {
        const ls = globalThis.localStorage
        if (!ls) return false
        if (value === null) ls.removeItem(key)
        else ls.setItem(key, value)
        return true
    } catch {
        return false
    }
}

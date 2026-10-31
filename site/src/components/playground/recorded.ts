// KIELER's own words in the problems list. For the reader's own charts they come with the engine's diagnostics
// (`Diagnostic.kieler`). For a guide example opened as it is, KIELER's recording of it (`<example>.oracle.json`)
// says exactly what KIELER reported: each of the engine's problems is paired with KIELER's message for it (the
// same text, else the same line and severity), and what only KIELER reports is listed too, in KIELER's words,
// as the widgets do (src/components/frame/prepare.ts, explain()). Pure.

import type { Diagnostic, Severity, Span } from '../../engine/types'
import type { OracleRecording } from '../frame/examples'

/** A problem of the problems list: the engine's diagnostic, or one only KIELER's recording has (`kielerOnly`:
 *  `message` is KIELER's wording). `recorded`: its `kieler` is what KIELER's recording of this chart says. */
export interface Problem extends Diagnostic {
    kielerOnly?: boolean
    recorded?: boolean
}

type Recorded = NonNullable<OracleRecording['diagnostics']>[number]

/** KIELER's internal noise, never shown (as in prepare.ts): EMF's "required feature" errors after a syntax error
 *  (they name temporary files) and the variable store's bookkeeping. */
const NOISE = [/^\d+:\d+ The required feature '/, /^The required feature '/, /is contained in the model but not in VariableStore/]
const noise = (m: string) => NOISE.some(r => r.test(m))

/** LSP severities, as the recording has them (1 = error, 2 = warning, 3 = information). */
const SEVERITY: Record<number, Severity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' }
const lsp = (s: Severity) => (s === 'error' ? 1 : s === 'warning' ? 2 : 3)
const firstLine = (m: string) => m.split('\n')[0].trim()

/** Offsets of a 1-based line and column in `source` (a span of the word there, at least one character). */
export function spanAt(source: string, line: number, column = 1): Span | undefined {
    if (!(line >= 1)) return undefined
    let start = 0
    for (let n = 1; n < line; n++) {
        const next = source.indexOf('\n', start)
        if (next < 0) return undefined
        start = next + 1
    }
    const lineEnd = source.indexOf('\n', start) < 0 ? source.length : source.indexOf('\n', start)
    const at = Math.min(lineEnd, start + Math.max(0, column - 1))
    const word = /^[\w$]+/.exec(source.slice(at, lineEnd))?.[0].length ?? 0
    const end = Math.min(lineEnd, at + Math.max(1, word)) || at
    return { start: at, end: Math.max(end, at), line, col: at - start + 1, endLine: line, endCol: Math.max(end, at) - start + 1 }
}

/**
 * The engine's diagnostics with KIELER's recorded words, then what only KIELER reports. `source` is the recorded
 * chart's text (the spans of KIELER's own messages are found in it).
 */
export function withRecording(diagnostics: Diagnostic[], rec: OracleRecording | undefined, source: string): Problem[] {
    if (!rec) return diagnostics
    const left: Recorded[] = (rec.diagnostics ?? []).filter(r => !noise(r.message))
    const take = (i: number) => left.splice(i, 1)[0]
    const out: Problem[] = diagnostics.map(d => {
        if (d.severity === 'info' && !d.kieler) return d
        let at = left.findIndex(r => r.message === d.kieler || r.message === d.message)
        // No wording of KIELER's: KIELER's message on the same line with the same severity (a syntax error).
        if (at < 0 && d.kieler === undefined) at = left.findIndex(r => r.line !== undefined && r.line === d.span?.line && r.severity === lsp(d.severity))
        // The same message apart from details after its first line (the order of the states in a loop).
        if (at < 0 && d.kieler !== undefined) at = left.findIndex(r => r.line === d.span?.line && r.severity === lsp(d.severity) && firstLine(r.message) === firstLine(d.kieler!))
        if (at < 0) return d
        const r = take(at)
        return r.message === d.message ? { ...d, kieler: undefined, recorded: true } : { ...d, kieler: r.message, recorded: true }
    })
    for (const r of left) {
        out.push({ severity: SEVERITY[r.severity] ?? 'info', message: r.message, span: r.line ? spanAt(source, r.line, r.column) : undefined, kielerOnly: true })
    }
    // The compiler's warnings of an accepted chart ("Potential instantaneous loop."), unless the guide already explains them.
    const explainsLoops = diagnostics.some(d => d.code === 'kieler-loop-warning' || d.code === 'immediate-loop' || d.code === 'instantaneous-loop')
    for (const m of rec.ok ? [...new Set(rec.warnings ?? [])] : []) {
        if (noise(m) || (explainsLoops && /^Potential instantaneous loop/.test(m))) continue
        if (out.some(p => p.kieler === m || p.message === m)) continue
        out.push({ severity: 'warning', message: m, kielerOnly: true })
    }
    // KIELER rejects a chart the engine accepts (gcc fails on its host code, say): KIELER's compiler errors.
    if (!rec.ok && !out.some(p => p.severity === 'error')) {
        const syntax = new Set((rec.diagnostics ?? []).map(r => r.message))
        for (const m of [...new Set(rec.errors ?? [])]) {
            if (noise(m) || syntax.has(m.replace(/^\d+:\d+ /, ''))) continue
            const lc = /^(\d+):(\d+) ([\s\S]*)$/.exec(m)
            out.push(lc ? { severity: 'error', message: lc[3], span: spanAt(source, Number(lc[1]), Number(lc[2])), kielerOnly: true } : { severity: 'error', message: m, kielerOnly: true })
        }
        if (!out.some(p => p.severity === 'error')) out.push({ severity: 'error', message: 'KIELER rejects this chart.', kielerOnly: true })
    }
    // In the order of the source, as the engine sorts its own (problems without a place last).
    return out
        .map((p, i) => ({ p, i }))
        .sort((a, b) => (a.p.span?.start ?? Infinity) - (b.p.span?.start ?? Infinity) || a.i - b.i)
        .map(x => x.p)
}

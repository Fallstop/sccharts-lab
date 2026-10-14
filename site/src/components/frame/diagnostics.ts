// The wording of a widget's collapsed warnings box (Diagnostics.astro): its summary line and its items. Pure.

import type { ShownDiagnostic } from './prepare'

/** A warning or note as listed, with the chart it is about when the box covers two (Compare). */
export type ListedDiagnostic = ShownDiagnostic & { chart?: string }

/** Warnings that only the guide gives (KIELER says nothing): how KIELER groups a conditional, a line a comment
 *  swallows. */
const GUIDE_LINTS: ReadonlySet<string> = new Set(['ternary-grouping', 'swallowed-line'])

/**
 * A warning is something KIELER (or the C compiler, through SCCharts Lab) warns about; a note is the guide's own
 * explanation, as reference/about promises. So KIELER's loop warning (an info in the engine, with KIELER's words)
 * counts as a warning, and the guide's lints and its explanations of a KIELER quirk or bug (KIELER says nothing) as
 * notes, whatever their severities.
 */
export function diagnosticKind(d: ShownDiagnostic): 'Warning' | 'Note' {
    if (d.code === 'kieler-loop-warning' && d.kieler) return 'Warning'
    if ((d.code === 'kieler-quirk' || d.code === 'kieler-bug') && !d.kieler) return 'Note'
    if (d.code && GUIDE_LINTS.has(d.code)) return 'Note'
    return d.severity === 'info' ? 'Note' : 'Warning'
}

const firstLine = (m: string) => m.split('\n')[0]
const counted = (n: number, word: string) => `${n} ${word.toLowerCase()}${n > 1 ? 's' : ''}`
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)
const code = (name: string) => `\`${name}\``

/** Every warning says the same thing (the same kind and first line): the summary says it, the items need not. */
export function allSame(warnings: ListedDiagnostic[]): boolean {
    return warnings.length > 0 && new Set(warnings.map((d) => `${diagnosticKind(d)}\u0000${firstLine(d.message)}`)).size === 1
}

/**
 * The summary of a warnings box, as inline Markdown (code spans only): "Warning: <message>", "2 warnings:
 * <message>" when they all say the same, "2 warnings and 1 note" otherwise; after a rejected chart's errors "Also a
 * warning: …", "Also 2 warnings and 1 note". Then the chart's name in parentheses (`name`), or the names of the charts
 * the warnings come from; a warning that each chart of a Compare gets once is not counted ("Warning: … (`A` and `B`)").
 */
export function warningSummary(warnings: ListedDiagnostic[], options: { rejected?: boolean; name?: string } = {}): string {
    if (!warnings.length) return ''
    const charts = [...new Set(warnings.flatMap((d) => (d.chart ? [d.chart] : [])))]
    let summary: string
    if (allSame(warnings)) {
        const k = diagnosticKind(warnings[0])
        const label = warnings.length === 1 || warnings.length === charts.length ? k : counted(warnings.length, k)
        summary = `${label}: ${firstLine(warnings[0].message)}`
    } else {
        const nWarn = warnings.filter((d) => diagnosticKind(d) === 'Warning').length
        const nNote = warnings.length - nWarn
        summary = [nWarn && counted(nWarn, 'warning'), nNote && counted(nNote, 'note')].filter(Boolean).join(' and ')
    }
    if (options.rejected) summary = /^(Warning|Note):/.test(summary) ? `Also a ${lower(summary)}` : `Also ${lower(summary)}`
    const whose = charts.length ? ` (${charts.map(code).join(' and ')})` : options.name ? ` (${code(options.name)})` : ''
    return summary + whose
}

/** The items of a warnings box: those that say exactly the same at the same place (both charts of a Compare) are
 *  one item, naming the charts. */
export function groupWarnings(warnings: ListedDiagnostic[]): { d: ListedDiagnostic; charts: string[] }[] {
    const groups = new Map<string, { d: ListedDiagnostic; charts: string[] }>()
    for (const d of warnings) {
        const key = [diagnosticKind(d), d.message, d.kieler, d.hint, d.line, d.col, d.kielerOnly].join('\u0000')
        const g = groups.get(key)
        if (!g) groups.set(key, { d, charts: d.chart ? [d.chart] : [] })
        else if (d.chart && !g.charts.includes(d.chart)) g.charts.push(d.chart)
    }
    return [...groups.values()]
}

/** "Warning in `A` and `B`, line 5, column 17": an item's head (inline Markdown). */
export function itemHead(d: ShownDiagnostic, charts: string[] = []): string {
    const where = d.line ? `, line ${d.line}${d.col ? `, column ${d.col}` : ''}` : ''
    return `${diagnosticKind(d)}${charts.length ? ` in ${charts.map(code).join(' and ')}` : ''}${where}`
}

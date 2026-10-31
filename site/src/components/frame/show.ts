// Build-time checks of `show` (<Sim>, <Compare>): every name must be one the timing diagram can trace, so a typo
// fails the build instead of leaving a lane out.

import { traceableVariables, type CompileResult } from '~engine/index'
import { qualifiedName, resolveShow } from '../sim/trace'

/**
 * What is wrong with `show` for these charts (one for <Sim>, two for <Compare>: a name counts when either chart
 * can trace it), as a sentence for a build error; undefined when every name resolves (`resolveShow`).
 */
export function showProblems(show: string[], charts: Pick<CompileResult, 'interface' | 'chart' | 'index'>[]): string | undefined {
    const results = charts.map((c) => ({ c, traceable: traceableVariables(c) }))
    const resolved = (n: string) => results.some(({ c, traceable }) => resolveShow([n], c.interface, c.chart, traceable).targets.length > 0)
    const names = charts.map((c) => c.chart?.name ?? 'the chart')
    const who = names.length > 1 ? `neither ${names.join(' nor ')} has a` : `${names[0]} has no`
    for (const n of show) {
        if (resolved(n)) continue
        const candidates = results.flatMap(({ c, traceable }) => resolveShow([n], c.interface, c.chart, traceable).ambiguous.flatMap((a) => a.candidates))
        if (candidates.length) return `show names ${n}, which several inner locals are called: name one of ${[...new Set(candidates)].join(', ')}.`
        const known = [...new Set(results.flatMap(({ c, traceable }) => [...c.interface.filter((v) => !v.const).map((v) => v.name), ...traceable.filter((v) => !v.inPool).map((v) => qualifiedName(v, c.chart))]))]
        return `show names ${n}, but ${who} variable of that name (top-level, added by the compiler, an inner local as State.name, or a member as instance.member). Known: ${known.join(', ')}.`
    }
    return undefined
}

// Instances of referenced charts (structure.md S-4): KIELER's Reference processor copies the referenced chart into
// the referencing state. The simulator lowers a fresh copy of the chart's AST for every instance, with every element
// id prefixed by `<referencing state id>/` (the ids the diagram gives a reference drawn expanded, diagram/layout.ts),
// so the instance's states, transitions and actions report ids of their own and its variables are its own.
//
// Taken Transition Signaling only numbers the simulated chart's own transitions (S-15): an instance's transitions
// carry `take` marks with index -1 (no KIELER effect; they drive the source-level configuration only), and the
// instance gets no counter reset.

import type { Span, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import { lowerChart, type LowerResult } from '../lower'
import { allScopes, allTransitions, type CState } from '../model'

/** Separates a reference state's id from the ids of the chart drawn (and simulated) inside it. */
export const REFERENCE_SEPARATOR = '/'

/**
 * A deep copy of a chart whose ids are prefixed (states, regions, transitions, actions, declarations, references
 * to declarations). `span`, when given, replaces every span (a chart from another file has no place in this one).
 */
export function prefixedChart(chart: State, prefix: string, span?: Span): State {
    const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit)
        if (!value || typeof value !== 'object') return value
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'span' || k === 'nameSpan' || k === 'targetSpan' || k === 'bindingSpan' || k === 'referenceSpan') out[k] = span ?? v
            else out[k] = visit(v)
        }
        if (typeof obj.id === 'string' && obj.id) out.id = prefix + obj.id
        if (obj.kind === 'transition') {
            if (typeof obj.source === 'string') out.source = prefix + obj.source
            if (typeof obj.target === 'string') out.target = prefix + obj.target
        }
        if (obj.kind === 'ref' && typeof obj.decl === 'string') out.decl = prefix + obj.decl
        if (obj.kind === 'special' && typeof obj.state === 'string') out.state = prefix + obj.state
        if (typeof obj.bindingDecl === 'string') out.bindingDecl = prefix + obj.bindingDecl
        return out
    }
    return { ...(visit(chart) as State), isRoot: false }
}

/** The chart, lowered as the body of one instance: a state (not a root) with the chart's declarations, actions, regions. */
export function lowerInstance(chart: State, index: ModelIndex | undefined, prefix: string, span?: Span): LowerResult {
    const copy = prefixedChart(chart, prefix, span)
    const lowered = lowerChart({ ...copy, isRoot: true }, index)
    const root: CState = lowered.root
    root.root = false
    // No Taken Transition Signaling for instances: the marks stay as tracker hooks only, the reset goes.
    for (const t of allTransitions(root)) {
        for (const f of t.effects) if (f.k === 'mark' && f.m.kind === 'take') f.m.index = -1
    }
    root.actions = root.actions.filter(a => !a.effects.some(f => f.k === 'mark' && f.m.kind === 'ttsReset'))
    lowered.takenOrder = []
    return lowered
}

/** Every scope of a lowered instance (for walking its declarations). */
export function instanceScopes(root: CState) {
    return allScopes(root)
}

// Model elements and their source lines, from the AST spans: which lines a diagram element was written on
// (diagram -> code), which element a source line belongs to (code -> diagram), and short display names for
// states and transitions ("Off", "Off → On"). Pure; used at build time (Chart) and in the browser (Sim).

import type { Diagnostic, Program, Region, Span, State, TickResult, Transition } from '~engine/types'

/** Lines are 1-based and inclusive. */
export interface LineMap {
    /** Element id -> [first line, last line]. States, regions, transitions, actions, declarations. */
    spans: Record<string, [number, number]>
    /** State id -> the line with its name (what the Code view marks while the state is active). */
    heads: Record<string, number>
    /** Line -> the innermost element written on it ('' for blank and comment lines). Index 0 is unused. */
    owners: string[]
    /** Element id -> accessible name of its diagram element (states, explicit regions, transitions):
     *  "initial state Off", "transition Off to On: if button go to On". Optional (older serialised maps). */
    names?: Record<string, string>
}

export interface ElementInfo {
    states: Map<string, State>
    regions: Map<string, Region>
    transitions: Map<string, Transition>
    /** Parent region of every non-root state. */
    parentRegion: Map<string, Region>
    root: State
}

export function elementsOf(chart: State): ElementInfo {
    const info: ElementInfo = { states: new Map(), regions: new Map(), transitions: new Map(), parentRegion: new Map(), root: chart }
    const visit = (s: State) => {
        info.states.set(s.id, s)
        for (const t of s.transitions) info.transitions.set(t.id, t)
        for (const r of s.regions) {
            info.regions.set(r.id, r)
            for (const c of r.states) {
                info.parentRegion.set(c.id, r)
                visit(c)
            }
        }
    }
    visit(chart)
    return info
}

function lineStarts(source: string): number[] {
    const starts = [0]
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1)
    return starts
}

/** The source lines of the chart's elements. `program` gives access to nothing more than `chart`; it is
 *  accepted so callers can pass what compile() returned. */
export function lineMap(chart: State, source: string, _program?: Program): LineMap {
    const spans: Record<string, [number, number]> = {}
    const heads: Record<string, number> = {}
    const names: Record<string, string> = {}
    const found: { id: string; span: Span }[] = []
    const states = elementsOf(chart).states
    const display = (id: string) => {
        const st = states.get(id)
        return st ? (st.label ?? st.name) : stateName(id, chart.id)
    }
    const add = (id: string, span: Span | undefined) => {
        if (!span) return
        spans[id] = [span.line, Math.max(span.line, endLineOf(span, source))]
        found.push({ id, span })
    }
    const visitState = (s: State) => {
        add(s.id, s.span)
        heads[s.id] = s.nameSpan?.line ?? s.span.line
        for (const d of s.declarations) for (const vo of d.valuedObjects) add(vo.id, d.span)
        for (const a of s.actions) add(a.id, a.span)
        if (!s.isRoot) names[s.id] = stateKind(s) + ' ' + (s.label ?? s.name)
        for (const t of s.transitions) {
            add(t.id, t.span)
            const to = t.target ? display(t.target) : t.targetName
            const text = sourceText(source, t.span)
            names[t.id] = `transition ${display(t.source)} to ${to}${text ? `: ${text}` : ''}`
        }
        for (const [i, r] of s.regions.entries()) {
            if (!r.implicit) add(r.id, r.span)
            const noun = r.regionType === 'dataflow' ? 'dataflow region' : 'region'
            const own = r.label ?? r.name
            if (!r.implicit || r.regionType === 'dataflow') names[r.id] = own ? `${noun} ${own}` : `${noun} ${i + 1} of ${s.label ?? s.name}`
            for (const d of r.declarations) for (const vo of d.valuedObjects) add(vo.id, d.span)
            for (const a of r.actions) add(a.id, a.span)
            for (const c of r.states) visitState(c)
        }
    }
    visitState(chart)

    const starts = lineStarts(source)
    const owners: string[] = ['']
    for (let line = 1; line <= starts.length; line++) {
        const from = starts[line - 1]
        const to = line < starts.length ? starts[line] - 1 : source.length
        const text = source.slice(from, to)
        const indent = text.search(/\S/)
        if (indent < 0 || /^\s*(\/\/|\/\*|\*)/.test(text)) {
            owners.push('')
            continue
        }
        const offset = from + indent
        let best: { id: string; size: number } | undefined
        for (const f of found) {
            if (f.span.start <= offset && offset < f.span.end) {
                const size = f.span.end - f.span.start
                if (!best || size < best.size) best = { id: f.id, size }
            }
        }
        owners.push(best?.id ?? '')
    }
    return { spans, heads, owners, names }
}

/** "initial state", "final superstate", "connector", "reference state": what a screen reader says first. */
function stateKind(s: State): string {
    if (s.connector) return 'connector'
    const noun = s.reference ? 'reference state' : s.regions.some((r) => r.states.length || r.regionType === 'dataflow') ? 'superstate' : 'state'
    return [s.initial && 'initial', s.final && 'final', s.violation && 'violation', noun].filter(Boolean).join(' ')
}

/** The last line a span really covers (a span that ends right after a newline ends on the line before). */
function endLineOf(span: Span, source: string): number {
    let end = span.end
    while (end > span.start && /\s/.test(source[end - 1] ?? '')) end--
    let line = span.line
    for (let i = span.start; i < end; i++) if (source.charCodeAt(i) === 10) line++
    return line
}

/** A state's name as the guide shows it: the path below the root (`Off`, `WaitAB.WaitA`). */
export function stateName(id: string, root: string): string {
    let rest = id.startsWith(root) ? id.slice(root.length) : id
    rest = rest.replace(/^[.:]/, '')
    return rest || root
}

/** `Off → On` for a transition id. */
export function transitionName(info: ElementInfo, id: string): string {
    const t = info.transitions.get(id)
    if (!t) return id
    const src = stateName(t.source, info.root.id)
    const dst = t.target ? stateName(t.target, info.root.id) : t.targetName
    return `${src} → ${dst}`
}

/** The source text of an element, on one line (`if button do light = true go to On`). */
export function sourceText(source: string, span: Span | undefined): string {
    if (!span) return ''
    return source.slice(span.start, span.end).replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Lines to mark in the Code view for a tick: the head line of every active state (not the root), every line
 *  of every transition that fired. */
export function tickLines(map: LineMap, tick: Pick<TickResult, 'active' | 'taken'> | undefined, root: string): { active: number[]; taken: number[] } {
    const active = new Set<number>()
    const taken = new Set<number>()
    if (tick) {
        for (const id of tick.active) if (id !== root && map.heads[id]) active.add(map.heads[id])
        for (const id of tick.taken) {
            const s = map.spans[id]
            if (s) for (let l = s[0]; l <= s[1]; l++) taken.add(l)
        }
    }
    return { active: [...active].sort((a, b) => a - b), taken: [...taken].sort((a, b) => a - b) }
}

/** Lines of the diagnostics that are errors. */
export function errorLines(diagnostics: Diagnostic[]): number[] {
    const out = new Set<number>()
    for (const d of diagnostics) {
        if (d.severity !== 'error' || !d.span) continue
        for (let l = d.span.line; l <= Math.max(d.span.line, d.span.endLine); l++) out.add(l)
    }
    return [...out].sort((a, b) => a - b)
}

/** Diagram classes for the elements named by error diagnostics. A diagnostic without `related` ids marks the
 *  element written on its line (when `map` is given), unless that is the chart itself. */
export function errorClasses(diagnostics: Diagnostic[], map?: LineMap, root?: string): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const d of diagnostics) {
        if (d.severity !== 'error') continue
        let ids = d.related?.length ? d.related : map && d.span ? [map.owners[d.span.line]].filter((id) => id && id !== root) : []
        // A transition whose target does not resolve is not drawn (KIELER leaves it out of the diagram): the
        // state it leaves carries the mark instead.
        if (d.code === 'unknown-state') ids = ids.map((id) => (/->\d+$/.test(id) ? id.slice(0, id.lastIndexOf('->')) : id)).filter((id) => id && id !== root)
        for (const id of ids) out[id] = ['is-error']
    }
    return out
}

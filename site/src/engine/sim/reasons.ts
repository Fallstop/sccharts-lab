// What a trigger read when it was checked, for describeTick's "because n == 1 held (n was 0)" and the log's
// `check` events. The values are read by the executor at the moment the condition node runs (not after the tick),
// so a transition that writes the variable it tests is explained with the value that made it fire.
//
// A probe is a variable reference of the source trigger as the core chart reads it: the passes keep every source
// reference's span (Signal: `S` stays the presence flag, `val(S)` becomes `S_val` with the span of `val(S)`; Pre:
// `pre(x)` becomes `_pre_x` with the span of `pre(x)`; References: an instance's bound variable is the referencing
// chart's, with the span of the name in the referenced chart). So the source trigger's references are matched
// with the core condition's references by span, and each is shown under its name as written: inside a referenced
// chart, the referenced chart's names with the instance's values. References the core condition no longer reads
// (constants and for-region counters, which are folded into literals) are not shown.

import type { Expression, LocalAction, Program, State, TraceSeen, Transition, Value } from '../types'
import type { ModelIndex } from '../parser/resolve'
import { formatExpressionPlain } from '../format'
import type { Fn, Runtime } from './eval'
import { walkExpr, type CExpr, type CRef } from './model'
import { REFERENCE_SEPARATOR } from './structure/instance'

export interface Probe {
    name: string
    signal: boolean
    fn: Fn
    /** Converts the run-time value for the log. */
    value: (v: ReturnType<Fn>) => Value
}

interface SourceElements {
    transitions: Map<string, Transition>
    actions: Map<string, LocalAction>
}

const elementsCache = new WeakMap<object, SourceElements>()

/** Every source transition and action of the programs the chart was compiled from, by id. */
export function sourceElements(chart: State, index: ModelIndex | undefined): SourceElements {
    const key: object = index ?? chart
    const cached = elementsCache.get(key)
    if (cached) return cached
    const transitions = new Map<string, Transition>()
    const actions = new Map<string, LocalAction>()
    const visit = (s: State) => {
        for (const t of s.transitions) transitions.set(t.id, t)
        for (const a of s.actions) actions.set(a.id, a)
        for (const r of s.regions) {
            for (const a of r.actions) actions.set(a.id, a)
            r.states.forEach(visit)
        }
    }
    const programs: Program[] = index?.programs ?? []
    for (const p of programs) p.charts.forEach(visit)
    visit(chart)
    const out = { transitions, actions }
    elementsCache.set(key, out)
    return out
}

/** The source element an executor id stands for: an instance's `<prefix>/<id>` is the referenced chart's `<id>`. */
export function lookupSource<T>(map: Map<string, T>, id: string): T | undefined {
    const direct = map.get(id)
    if (direct) return direct
    const i = id.lastIndexOf(REFERENCE_SEPARATOR)
    return i < 0 ? undefined : map.get(id.slice(i + 1))
}

interface Item {
    name: string
    start: number
    end: number
}

/** The references of a source trigger in reading order: `x`, `a[i]` (and `i`), `pre(x)`, `val(S)`. */
function sourceItems(e: Expression): Item[] {
    const out: Item[] = []
    const visit = (x: Expression) => {
        switch (x.kind) {
            case 'ref':
                out.push({ name: formatExpressionPlain(x), start: x.span.start, end: x.span.end })
                x.indices.forEach(visit)
                break
            case 'op':
                if ((x.op === 'pre' || x.op === 'val') && x.args.length === 1 && x.args[0].kind === 'ref') {
                    out.push({ name: formatExpressionPlain(x), start: x.span.start, end: x.span.end })
                    x.args[0].indices.forEach(visit)
                } else {
                    x.args.forEach(visit)
                }
                break
            case 'call':
                x.args.forEach(visit)
                break
            default:
                break
        }
    }
    visit(e)
    return out
}

/**
 * Probes for a core condition that implements (part of) a source trigger. `compileRef` compiles a core reference
 * into a reader; references of the source trigger the condition does not read are left out.
 */
export function triggerProbes(core: CExpr | undefined, trigger: Expression | undefined, compileRef: (r: CRef) => Probe['fn'] | undefined, valueOf: (r: CRef) => Probe['value']): Probe[] {
    if (!core || !trigger) return []
    const leaves = new Map<string, CRef[]>()
    walkExpr(core, e => {
        if (e.k !== 'ref' || !e.span) return
        const key = `${e.span.start}:${e.span.end}`
        const list = leaves.get(key)
        if (list) list.push(e)
        else leaves.set(key, [e])
    })
    if (!leaves.size) return []
    const items = sourceItems(trigger)
    // A chart from another file has the reference's span everywhere (structure/instance.ts): no way to tell its
    // references apart, so nothing is shown.
    const spans = new Set(items.map(i => `${i.start}:${i.end}`))
    if (spans.size < items.length && new Set(items.map(i => i.name)).size > spans.size) return []
    const out: Probe[] = []
    const names = new Set<string>()
    const add = (name: string, r: CRef) => {
        const fn = compileRef(r)
        if (!fn) return
        names.add(name)
        const v = r.v
        const signal = v.role === 'presence' || (v.role === 'pre' && v.of?.role === 'presence')
        out.push({ name, signal, fn, value: valueOf(r) })
    }
    for (const item of items) {
        if (names.has(item.name)) continue
        const found = leaves.get(`${item.start}:${item.end}`)
        if (!found?.length) continue
        const r = found[0]
        if (found.some(x => x.v !== r.v)) continue
        add(item.name, r)
    }
    // A chart from another file: every reference of the condition has the reference state's span. When the condition
    // reads as many references as the trigger, in the same order, they are the trigger's.
    if (!out.length && leaves.size === 1) {
        const refs = [...leaves.values()][0]
        if (refs.length === items.length && !spans.has([...leaves.keys()][0])) {
            items.forEach((item, i) => { if (!names.has(item.name)) add(item.name, refs[i]) })
        }
    }
    return out
}

/** Reads the probes now (a probe that cannot be evaluated, e.g. an index out of range, is left out). */
export function readProbes(probes: Probe[], rt: Runtime): TraceSeen[] {
    const out: TraceSeen[] = []
    for (const p of probes) {
        try {
            const value = p.value(p.fn(rt))
            out.push(p.signal ? { name: p.name, value, signal: true } : { name: p.name, value })
        } catch {
            // The condition itself reports the runtime error.
        }
    }
    return out
}

function show(v: Value): string {
    if (v === null) return 'null'
    if (Array.isArray(v)) return `{${v.map(show).join(', ')}}`
    if (typeof v === 'string') return JSON.stringify(v)
    return String(v)
}

/** "n was 0 and S was present". */
export function seenText(seen: TraceSeen[]): string {
    const parts = seen.map(s => (s.signal ? `${s.name} was ${s.value ? 'present' : 'absent'}` : `${s.name} was ${show(s.value)}`))
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

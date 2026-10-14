// The tracker's view of a chart with references and for-regions (structure.md S-4, S-21): the source-level
// configuration (tracker.ts) follows an AST in which every reference state contains the referenced chart (in a
// region `<state>:ref`, ids prefixed `<state>/`, as the diagram draws an expanded reference) and every for-region
// is there once per copy. Copies' elements get internal ids with the copy key (`|<region>=<value>`, as the For pass
// gives their take marks); the tracker reports them by their source id, so a copy's state is shown in the one region
// the diagram draws.

import type { ForCopyState, Region, State, TraceEvent, Transition } from '../../types'
import type { CompiledChart } from '../compile'
import type { InstanceRecord } from '../passes/reference'
import { FOR_COPY_NOTE, type ForCopies } from '../passes/forRegion'
import { prefixedChart, REFERENCE_SEPARATOR } from './instance'

export interface TrackView {
    root: State
    /** Internal id -> the id reported (and drawn). */
    report?: (id: string) => string
}

export function trackView(compiled: CompiledChart, chart: State): TrackView {
    const records = (compiled.shared.instances as InstanceRecord[] | undefined) ?? []
    const copies = (compiled.shared.forCopies as ForCopies[] | undefined) ?? []
    if (!records.length && !copies.length) return { root: chart }
    const references = new Map<string, InstanceRecord>()
    const declarations = new Map<string, InstanceRecord[]>()
    for (const r of records) {
        if (r.declaration) {
            const list = declarations.get(r.state) ?? []
            list.push(r)
            declarations.set(r.state, list)
        } else {
            references.set(r.state, r)
        }
    }
    const forValues = new Map(copies.map(c => [c.region, c.values]))

    const state = (s: State, key: string, depth: number): State => {
        const regions: Region[] = []
        for (const r of s.regions) {
            if (r.regionType === 'dataflow') continue
            const values = forValues.get(r.id)
            if (values) for (const v of values) regions.push(region(r, `${key}|${r.id}=${v}`, depth))
            else regions.push(region(r, key, depth))
        }
        const inst = references.get(s.id)
        if (inst && depth < 16) {
            const inner = prefixedChart(inst.chart, inst.prefix)
            const body = state({ ...inner, initial: true, final: false }, key, depth + 1)
            regions.push({
                kind: 'region', id: `${s.id}:ref${key}`, regionType: 'controlflow', implicit: true, annotations: [], declarations: [],
                actions: [], states: [body], equations: [], span: s.span,
            })
        }
        for (const d of declarations.get(s.id) ?? []) {
            if (depth >= 16) break
            const inner = prefixedChart(d.chart, d.prefix)
            for (const r of inner.regions) if (r.regionType !== 'dataflow') regions.push(region(r, key, depth + 1))
        }
        const transitions: Transition[] = s.transitions.map(t => ({
            ...t, id: t.id + key, source: t.source + key, target: t.target === undefined ? undefined : t.target + key,
        }))
        return { ...s, id: s.id + key, regions, transitions }
    }
    const region = (r: Region, key: string, depth: number): Region => ({ ...r, id: r.id + key, states: r.states.map(c => state(c, key, depth)) })

    const root = state(chart, '', 0)
    return copies.length ? { root, report: id => { const i = id.indexOf('|'); return i < 0 ? id : id.slice(0, i) } } : { root }
}

/**
 * Every for-region copy with the states active in it and the states entered in it in this tick (TickResult.copies),
 * by their source ids, in KIELER's order of the copies (S-22). `active` and `entered` are the tracker's internal ids:
 * a state inside a copy carries the copy's key `|<region>=<value>` (several when a copy contains a reference whose
 * chart has a for-region of its own; the state then counts for each of them).
 */
export function copyStates(compiled: CompiledChart, active: string[], entered: string[]): ForCopyState[] | undefined {
    const copies = (compiled.shared.forCopies as ForCopies[] | undefined) ?? []
    if (!copies.length) return undefined
    const out: ForCopyState[] = []
    const byKey = new Map<string, ForCopyState>()
    for (const c of copies) {
        for (const value of c.values) {
            const state: ForCopyState = { region: c.region, value, active: [], entered: [] }
            out.push(state)
            byKey.set(`${c.region}=${value}`, state)
        }
    }
    const add = (ids: string[], field: 'active' | 'entered') => {
        for (const id of ids) {
            const parts = id.split('|')
            if (parts.length < 2) continue
            for (const part of parts.slice(1)) {
                const list = byKey.get(part)?.[field]
                if (list && !list.includes(parts[0])) list.push(parts[0])
            }
        }
    }
    add(active, 'active')
    add(entered, 'entered')
    return out
}

/**
 * A transition of a for-region copy fired: a note saying which copy (describe.ts folds it into the sentence about the
 * transition). The key is `<transition>|<region>=<value>`.
 */
export function copyNotes(transition: string, key: string, compiled: CompiledChart): TraceEvent[] {
    const copies = (compiled.shared.forCopies as ForCopies[] | undefined) ?? []
    const out: TraceEvent[] = []
    for (const part of key.split('|').slice(1)) {
        const eq = part.lastIndexOf('=')
        const region = part.slice(0, eq)
        const value = part.slice(eq + 1)
        const c = copies.find(x => x.region === region)
        if (!c) continue
        out.push({
            kind: 'note', related: [FOR_COPY_NOTE, transition, region, value],
            text: `This was the copy of the for-region${c.name ? ` ${c.name}` : ''} with ${c.counter} = ${value}.`,
            markdown: `This was the copy of the for-region${c.name ? ` \`${c.name}\`` : ''} with \`${c.counter} = ${value}\`.`,
        })
    }
    return out
}

export { REFERENCE_SEPARATOR }

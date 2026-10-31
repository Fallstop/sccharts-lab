// Highlighting a rendered diagram: from a simulation tick to classes, and toggling them on the SVG without
// re-rendering. The DOM helpers only use standard DOM APIs (no framework).

import type { Span, TickResult } from '../engine/types'
import type { DiagramLayout, RegionLayout, StateLayout } from './types'

/** The classes this module manages; `applyClasses` removes them before adding the new ones. */
export const HIGHLIGHT_CLASSES = ['is-active', 'is-entered', 'is-exited', 'is-taken', 'is-focus', 'is-error', 'is-dimmed'] as const
export type HighlightClass = (typeof HIGHLIGHT_CLASSES)[number]

export type ClassMap = Record<string, string[]>

function add(map: ClassMap, id: string, cls: string) {
    const list = (map[id] ??= [])
    if (!list.includes(cls)) list.push(cls)
}

/** Classes for the state of a simulation after a tick: active states, states entered and exited during the
 *  tick, transitions taken. */
export function tickClasses(tick: Pick<TickResult, 'active' | 'entered' | 'exited' | 'taken'>): ClassMap {
    const map: ClassMap = {}
    for (const id of tick.active) add(map, id, 'is-active')
    for (const id of tick.entered) add(map, id, 'is-entered')
    for (const id of tick.exited) add(map, id, 'is-exited')
    for (const id of tick.taken) add(map, id, 'is-taken')
    return map
}

/** Merges class maps (later maps add to earlier ones). */
export function mergeClasses(...maps: (ClassMap | undefined)[]): ClassMap {
    const out: ClassMap = {}
    for (const m of maps) if (m) for (const [id, list] of Object.entries(m)) for (const c of list) add(out, id, c)
    return out
}

/** Minimal DOM surface used here, so this file needs no DOM type library. */
interface ElementLike {
    getAttribute(name: string): string | null
    classList: { add(...c: string[]): void; remove(...c: string[]): void }
}
interface RootLike {
    querySelectorAll(selector: string): ArrayLike<ElementLike> & Iterable<ElementLike>
}

/**
 * Sets the highlight classes on the elements of a rendered diagram (`root` is the <svg> or any ancestor):
 * every element with a data-id loses the managed classes and gains those listed for its id. Declaration lines
 * that show several valued objects match any of their ids (data-ids).
 */
export function applyClasses(root: RootLike, classes: ClassMap, managed: readonly string[] = HIGHLIGHT_CLASSES): void {
    for (const el of root.querySelectorAll('[data-id]')) {
        el.classList.remove(...managed)
        const ids = el.getAttribute('data-ids')?.split(' ') ?? [el.getAttribute('data-id')!]
        for (const id of ids) {
            const list = classes[id]
            if (list?.length) el.classList.add(...list)
        }
    }
}

function walk(layout: DiagramLayout, visit: (id: string, span: Span | undefined, depth: number) => void) {
    const state = (s: StateLayout, depth: number) => {
        visit(s.id, s.span, depth)
        for (const r of s.regions) region(r, depth + 1)
    }
    const region = (r: RegionLayout, depth: number) => {
        visit(r.id, r.span, depth)
        for (const s of r.states) state(s, depth + 1)
        for (const t of r.transitions) visit(t.id, t.span, depth + 1)
    }
    state(layout.root, 0)
}

/** Ids of the diagram elements whose source span contains `offset` (a UTF-16 offset into the source), the
 *  innermost first: for linking the editor's cursor to the diagram (`is-focus`). */
export function elementsAt(layout: DiagramLayout, offset: number): string[] {
    const hits: { id: string; depth: number; size: number }[] = []
    walk(layout, (id, span, depth) => {
        if (span && span.start <= offset && offset <= span.end) hits.push({ id, depth, size: span.end - span.start })
    })
    return hits.sort((a, b) => a.size - b.size || b.depth - a.depth).map(h => h.id)
}

/** The source span of a diagram element (state, region or transition), for jumping from the diagram to the
 *  source. */
export function spanOf(layout: DiagramLayout, id: string): Span | undefined {
    let found: Span | undefined
    walk(layout, (eid, span) => { if (eid === id) found = span })
    return found
}

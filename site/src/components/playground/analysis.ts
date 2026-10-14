// Questions the editor asks about the last compiled model: what is declared where the cursor is (completion),
// which states a transition being typed can go to, and what the name under the mouse refers to (hover). Pure
// functions over the engine's AST and model index; offsets are offsets into the compiled source.

import type { CompileResult, VOEntry } from '../../engine/index'
import type { Declaration, Program, Region, Span, State, Transition, ValuedObject } from '../../engine/types'

const inside = (span: Span | undefined, offset: number) => !!span && span.start <= offset && offset <= span.end

/**
 * The states and regions that contain `offset`, outermost first (starting with a chart). A state's span ends at its
 * closing brace, but the transitions written after it are still its own, so each state and region reaches up to the
 * start of the next one.
 */
export function scopeChain(program: Program, offset: number): (State | Region)[] {
    const chain: (State | Region)[] = []
    const chart = program.charts.find(c => inside(c.span, offset))
    if (!chart) return chain
    let state: State | undefined = chart
    let stateEnd = chart.span.end
    while (state) {
        chain.push(state)
        const regions: Region[] = state.regions
        const innerEnd = Math.min(state.span.end, stateEnd)
        const ri = regions.findIndex((r, i) => r.span.start <= offset && offset <= (i + 1 < regions.length ? regions[i + 1].span.start : innerEnd))
        if (ri < 0) break
        const region = regions[ri]
        const regionEnd = ri + 1 < regions.length ? regions[ri + 1].span.start : innerEnd
        chain.push(region)
        const states = region.states
        const si = states.findIndex((s, i) => s.span.start <= offset && offset <= (i + 1 < states.length ? states[i + 1].span.start : regionEnd))
        if (si < 0) break
        state = states[si]
        stateEnd = si + 1 < states.length ? states[si + 1].span.start : regionEnd
    }
    return chain
}

export interface ScopedName {
    vo: ValuedObject
    decl: Declaration
    owner: State | Region
}

/** Variables and signals visible at `offset`, innermost scope first (an inner declaration hides an outer one). */
export function namesInScope(program: Program, offset: number): ScopedName[] {
    const seen = new Set<string>()
    const out: ScopedName[] = []
    for (const owner of scopeChain(program, offset).reverse()) {
        for (const decl of owner.declarations) {
            if (decl.declKind !== 'variable' && decl.declKind !== 'reference') continue
            for (const vo of decl.valuedObjects) {
                if (seen.has(vo.name)) continue
                seen.add(vo.name)
                out.push({ vo, decl, owner })
            }
        }
    }
    return out
}

/** The region whose states a transition written at `offset` can target: the region holding the innermost state
 *  that contains `offset` (a transition belongs to the state it is written under). */
export function targetRegionAt(program: Program, offset: number): Region | undefined {
    const chain = scopeChain(program, offset)
    for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i]
        if (node.kind === 'region') return node
    }
    return undefined
}

/** The transition written under a state whose source text contains `offset` (for target completion), if any. */
export function transitionAt(program: Program, offset: number): Transition | undefined {
    let found: Transition | undefined
    const visit = (s: State) => {
        for (const t of s.transitions) if (inside(t.span, offset)) found = t
        for (const r of s.regions) r.states.forEach(visit)
    }
    program.charts.forEach(visit)
    return found
}

// ----- What is under the mouse ------------------------------------------------------------------------------------

export type Hit =
    | { kind: 'variable'; entry: VOEntry; span: Span; isDeclaration: boolean }
    | { kind: 'state'; state: State; span: Span; isDeclaration: boolean }
    | { kind: 'chart'; state: State; span: Span }

function smallest<T extends { span: Span }>(hits: T[]): T | undefined {
    return hits.sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))[0]
}

/** The reference, declaration, state name or transition target at `offset`. */
export function hitAt(result: CompileResult, offset: number): Hit | undefined {
    const program = result.program
    const index = result.index
    if (!program || !index) return undefined
    const hits: Hit[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown, depth: number) => {
        if (!node || typeof node !== 'object' || depth > 200 || seen.has(node)) return
        seen.add(node)
        if (Array.isArray(node)) {
            for (const n of node) walk(n, depth + 1)
            return
        }
        const o = node as Record<string, unknown>
        const span = o.span as Span | undefined
        // Prune subtrees that cannot contain the offset. Not at states and regions: a state's span ends at its
        // closing brace, and the transitions written after it belong to it.
        if (span && typeof span.start === 'number' && !inside(span, offset) && o.kind !== 'program' && o.kind !== 'state' && o.kind !== 'region') return
        if (o.kind === 'ref' && typeof o.decl === 'string' && span) {
            const entry = index.vos.get(o.decl)
            // `a.b`: only the head name's own span (the sub-reference is visited below).
            const sub = o.sub as { span: Span } | undefined
            const head = sub ? { ...span, end: Math.min(span.end, sub.span.start - 1) } : span
            if (entry && inside(head, offset)) hits.push({ kind: 'variable', entry, span: head, isDeclaration: false })
        }
        if (o.kind === 'valuedObject' && typeof o.id === 'string' && inside(o.nameSpan as Span, offset)) {
            const entry = index.vos.get(o.id)
            if (entry) hits.push({ kind: 'variable', entry, span: o.nameSpan as Span, isDeclaration: true })
        }
        if (o.kind === 'state' && inside(o.nameSpan as Span, offset)) {
            const st = o as unknown as State
            hits.push(st.isRoot ? { kind: 'chart', state: st, span: st.nameSpan } : { kind: 'state', state: st, span: st.nameSpan, isDeclaration: true })
        }
        if (o.kind === 'transition' && inside(o.targetSpan as Span, offset) && typeof o.target === 'string') {
            const target = index.states.get(o.target)
            if (target) hits.push({ kind: 'state', state: target, span: o.targetSpan as Span, isDeclaration: false })
        }
        for (const [k, v] of Object.entries(o)) {
            if (k === 'span' || k === 'nameSpan' || k === 'targetSpan') continue
            if (v && typeof v === 'object') walk(v, depth + 1)
        }
    }
    walk(program, 0)
    return smallest(hits)
}

/** Name of a state or region for messages: `state WaitA`, `region HandleA`, `the chart ABRO`. */
export function ownerName(owner: State | Region | undefined): string {
    if (!owner) return 'a code block'
    if (owner.kind === 'region') return owner.name ? `region ${owner.name}` : 'an unnamed region'
    if (owner.isRoot) return `the chart ${owner.name}`
    return `state ${owner.name}`
}

/** The parent state of a region, or the region of a state, from the model index. */
export function parentOf(result: CompileResult, node: State | Region): State | Region | undefined {
    const index = result.index
    if (!index) return undefined
    return node.kind === 'region' ? index.parentState.get(node) : index.parentRegion.get(node)
}

// Test support for the diagram: parse SCTX into charts with element ids.
//
// Uses the engine's parse() when src/engine/index.ts provides it; otherwise the bare parser plus a minimal
// id assignment and name resolution following the id convention in src/engine/types.ts (only where the
// parser left ids empty), so the diagram can be tested before the resolver lands.

import type { Declaration, Effect, Expression, Program, Reference, Region, State } from '../../src/engine/types'

type ParseFn = (source: string) => { program?: Program; diagnostics: { severity: string; message: string }[] }

let parseImpl: ParseFn | undefined

async function getParse(): Promise<ParseFn> {
    if (parseImpl) return parseImpl
    try {
        const engine = (await import('../../src/engine/index')) as { parse?: ParseFn }
        if (typeof engine.parse === 'function') return (parseImpl = engine.parse)
    } catch {
        // index.ts not there yet
    }
    const parser = (await import('../../src/engine/parser/parser')) as { parseProgram: ParseFn }
    return (parseImpl = parser.parseProgram)
}

export async function parseSctx(source: string): Promise<Program> {
    const parse = await getParse()
    const result = parse(source)
    if (!result.program) throw new Error(`parse failed: ${result.diagnostics.map(d => d.message).join('; ')}`)
    for (const chart of result.program.charts) assignIds(chart)
    return result.program
}

/** The chart KIELER's diagram shows by default: the first in the file (or the named one). */
export async function chartOf(source: string, name?: string): Promise<{ program: Program; chart: State }> {
    const program = await parseSctx(source)
    const chart = name ? program.charts.find(c => c.name === name) : program.charts[0]
    if (!chart) throw new Error(`no chart ${name ?? ''}`)
    return { program, chart }
}

// ----- Minimal resolver (ids and references) ------------------------------------------------------------

type Scope = { id: string; decls: Map<string, string>; parent?: Scope }

function declare(scope: Scope, decls: Declaration[]) {
    for (const d of decls) for (const vo of d.valuedObjects) {
        if (!vo.id) vo.id = `${scope.id}$${vo.name}`
        scope.decls.set(vo.name, vo.id)
    }
}

function lookup(scope: Scope | undefined, name: string): string | undefined {
    for (let s = scope; s; s = s.parent) {
        const id = s.decls.get(name)
        if (id) return id
    }
    return undefined
}

function resolveRef(ref: Reference, scope: Scope) {
    if (!ref.decl) ref.decl = lookup(scope, ref.name)
    for (const i of ref.indices) resolveExpr(i, scope)
}

function resolveExpr(e: Expression | undefined, scope: Scope) {
    if (!e) return
    switch (e.kind) {
        case 'ref': resolveRef(e, scope); break
        case 'op': e.args.forEach(a => resolveExpr(a, scope)); break
        case 'call': e.args.forEach(a => resolveExpr(a, scope)); break
        case 'vector': e.values.forEach(v => resolveExpr(v, scope)); break
    }
}

function resolveEffect(e: Effect, scope: Scope) {
    switch (e.kind) {
        case 'assign': resolveRef(e.target, scope); resolveExpr(e.expression, scope); break
        case 'postfix': resolveRef(e.target, scope); break
        case 'emit': resolveRef(e.target, scope); resolveExpr(e.value, scope); break
        case 'call': case 'print': case 'randomize': e.args.forEach(a => resolveExpr(a, scope)); break
    }
}

function visitState(state: State, id: string, parent: Scope | undefined) {
    if (!state.id) state.id = id
    const scope: Scope = { id: state.id, decls: new Map(), parent }
    declare(scope, state.declarations)
    const counts: Record<string, number> = {}
    for (const a of state.actions) {
        if (!a.id) a.id = `${state.id}!${a.kind}${counts[a.kind] = (counts[a.kind] ?? -1) + 1}`
        resolveExpr(a.trigger, scope)
        a.effects.forEach(e => resolveEffect(e, scope))
    }
    state.regions.forEach((region, index) => visitRegion(region, `${state.id}:${region.name ?? index}`, scope, state))
}

function visitRegion(region: Region, id: string, parent: Scope, owner: State) {
    if (!region.id) region.id = id
    const scope: Scope = { id: region.id, decls: new Map(), parent }
    declare(scope, region.declarations)
    // State ids: <parentStateId>.<name>, unless two regions of the parent share a state name.
    const clash = owner.regions.some(r => r !== region && r.states.some(s => region.states.some(t => t.name === s.name)))
    for (const s of region.states) visitState(s, clash ? `${region.id}.${s.name}` : `${owner.id}.${s.name}`, scope)
    const byName = new Map(region.states.map(s => [s.name, s.id]))
    for (const s of region.states) {
        const stateScope: Scope = { id: s.id, decls: new Map(), parent: scope }
        declare(stateScope, s.declarations)
        s.transitions.forEach((t, i) => {
            if (!t.source) t.source = s.id
            if (!t.priority) t.priority = i + 1
            if (!t.id) t.id = `${s.id}->${t.priority}`
            if (!t.target) t.target = byName.get(t.targetName)
            resolveExpr(t.trigger, scope)
            t.effects.forEach(e => resolveEffect(e, scope))
        })
    }
    for (const eq of region.equations) {
        resolveRef(eq.target, scope)
        resolveExpr(eq.expression, scope)
    }
}

export function assignIds(chart: State) {
    visitState(chart, chart.name, undefined)
}

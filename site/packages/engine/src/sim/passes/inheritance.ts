// KIELER's Inheritance processor (sccharts/processors/Inheritance.xtend), called by the Reference processor before
// a chart's references are expanded. structure.md S-17.
//
// `scchart A extends B`: A receives B's declarations (in front of its own; private ones renamed `B_x`), B's actions
// (in front of its own) and B's regions (in front of its own), except the regions A overrides (`override region R`
// hides B's R; an override region of a base hides the regions of its own bases). Inside an override region,
// `region is super.R` is replaced by a copy of the base's R. Every base is a fresh copy of its chart (lowered like an
// instance, structure/instance.ts); A's references to inherited variables are redirected to those copies.
//
// Not supported (an `unsupported` info): bindings or generic parameters on `extends`, and conflicting overrides of
// inherited methods.

import type { Diagnostic, ScopeCall, Span, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { PassContext } from './context'
import {
    allContainedStates, allRegions, allScopes, mapExpr, walkExpr, type CExpr, type CRef, type CRegion, type CState, type CStmt, type CVar,
} from '../model'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { inheritedDeclarations } from '../lower'
import { rewriteScope } from '../structure/rewrite'

interface Base {
    chart: State
    prefix: string
    root: CState
    /** What lowering the base's copy found (lower.ts inheritedIndex): reported for the parts the chart keeps. */
    reports?: Diagnostic[]
}

/** KIELER's getAllInheritedStates: every base, transitively, each once. */
export function allInherited(chart: State, find: (name: string) => State | undefined): State[] {
    const direct = (s: State) => (s.baseStates ?? []).map(b => find(b.target)).filter((x): x is State => !!x && x !== chart)
    const out: State[] = []
    const work = [...direct(chart)].reverse()
    while (work.length) {
        const s = work.pop()!
        if (out.includes(s)) continue
        out.push(s)
        for (const b of [...direct(s)].reverse()) if (!out.includes(b) && !work.includes(b)) work.push(b)
    }
    return out
}

/** KIELER's getAllVisibleInheritedRegions: base regions (depth first) not hidden by an override region above them. */
export function visibleRegions(chart: State, find: (name: string) => State | undefined): { base: State; region: string }[] {
    const out: { base: State; region: string }[] = []
    const visit = (s: State, hidden: Set<string>, path: State[]) => {
        if (s !== chart) {
            for (const r of s.regions) if (!r.name || !hidden.has(r.name)) out.push({ base: s, region: r.id })
        }
        const next = new Set(hidden)
        for (const r of s.regions) if (r.name && r.override) next.add(r.name)
        for (const b of s.baseStates ?? []) {
            const target = find(b.target)
            if (target && !path.includes(target)) visit(target, next, [...path, target])
        }
    }
    visit(chart, new Set(), [chart])
    return out.filter((x, i) => out.findIndex(y => y.region === x.region) === i)
}

/**
 * Applies inheritance to a state whose source chart extends others. `chart` is the state's source (AST) chart,
 * `prefix` the prefix of its ids (for an instance's copy of a chart). Returns false if it cannot.
 */
export function inherit(ctx: PassContext, state: CState, chart: State, find: (name: string) => State | undefined): boolean {
    const index = ctx.shared.index as ModelIndex | undefined
    const calls = (state.ext.baseStates as ScopeCall[] | undefined) ?? []
    delete state.ext.baseStates
    if (calls.some(c => c.parameters.length || c.genericParameters?.length)) {
        ctx.report({
            severity: 'info', code: 'unsupported', related: state.origin ? [state.origin] : undefined,
            message: 'The guide\'s simulator cannot run inheritance with bindings or generic parameters (extends Base(...)) yet',
            hint: 'This needs more of KIELER\'s Inheritance transformation than the simulator implements. The official KIELER tools can run this chart.',
        })
        return false
    }
    /** The members of the bases' class and struct instances (two instances of one type share the members' ids). */
    const instances = new Map<CVar, Map<string, CVar>>()
    // Inside the copies of the bases, the bases' declarations are the inherited ones too (lower.ts inheritedIndex).
    const replaced = inheritedDeclarations(chart, index)
    const bases: Base[] = allInherited(chart, find).map(b => {
        const prefix = `${state.origin ?? state.about ?? state.name}${REFERENCE_SEPARATOR}`
        const lowered = lowerInstance(b, index, prefix, undefined, replaced)
        for (const [inst, members] of lowered.instances) instances.set(inst, members)
        return { chart: b, prefix, root: lowered.root, reports: lowered.reports }
    })
    if (!bases.length) return true
    // Variables of the bases by their source id (the inheriting chart's references carry those ids).
    const byDecl = new Map<string, CVar>()
    const own = new Set(state.decls.map(v => v.name))
    const inherited: CVar[] = []
    /** Inherited methods an own method overrides (base method -> override). */
    const overridden = new Map<CVar, CVar>()
    for (const b of bases) {
        for (const v of b.root.decls) {
            const source = v.decl?.startsWith(b.prefix) ? v.decl.slice(b.prefix.length) : v.decl
            if (source) byDecl.set(source, v)
            if (own.has(v.name)) {
                // An overriding method replaces the inherited one; anything else is a conflict.
                const overrider = v.method ? state.decls.find(x => x.name === v.name && x.method) : undefined
                if (overrider) {
                    overridden.set(v, overrider)
                    continue
                }
                ctx.report({
                    severity: 'error', code: 'inheritance-conflict', span: v.span, related: v.decl ? [v.decl] : undefined,
                    message: `\`${v.name}\` is declared again along the inheritance hierarchy`,
                    kieler: `Variable ${v.name} is declared again along the inheritance hierarchy.`,
                    hint: 'Rename one of them, or use the inherited variable.',
                })
                continue
            }
            own.add(v.name)
            v.scope = state
            // KIELER renames the private and protected declarations of a base `<Base>_<name>` (Inheritance.xtend;
            // conformance structure/134: "St134Base_secret" in the pool).
            const access = source ? index?.vos.get(source)?.decl?.access : undefined
            if ((access === 'private' || access === 'protected') && !v.method) v.name = `${b.chart.name}_${v.name}`
            // The simulated chart's own variables now (exec.ts traces the members of its instances).
            if (state.root) v.tags.add('#inherited')
            inherited.push(v)
        }
    }
    state.decls.unshift(...inherited)
    state.actions.unshift(...bases.flatMap(b => b.root.actions))
    // Regions: the visible inherited ones in front of the state's own.
    const regionsById = new Map<string, CRegion>()
    for (const b of bases) for (const r of b.root.regions) if (r.origin) regionsById.set(r.origin.slice(b.prefix.length), r)
    const visible = visibleRegions(chart, find).map(x => regionsById.get(x.region)).filter((r): r is CRegion => !!r)
    for (const r of visible) r.parent = state
    state.regions.unshift(...visible)
    for (const r of state.regions) r.override = false
    // The inheriting chart's references to inherited variables.
    const inheritedVar = (v: CVar): CVar | undefined =>
        (v.declKind === 'unresolved' && v.decl ? byDecl.get(v.decl) ?? byDecl.get(v.decl.split(REFERENCE_SEPARATOR).pop()!) : undefined)
    const redirect = (r: CRef): CRef | undefined => {
        const target = inheritedVar(r.v)
        if (!target) return undefined
        // A member of an inherited instance (`c.x`, `l.a.x`, `cs[1].v`, `c.inc()`): the member's variable, with
        // the indices of the instances on the way in front of its own (as lower.ts ref() does for the chart's own).
        let out: CRef = { ...r, v: target }
        while (out.sub) {
            const source = out.sub.v.declKind === 'unresolved' ? out.sub.v.decl?.split(REFERENCE_SEPARATOR).pop() : undefined
            const member = source ? [...(instances.get(out.v) ?? [])].find(([id]) => id.split(REFERENCE_SEPARATOR).pop() === source)?.[1] : undefined
            if (!member) break
            out = { ...out.sub, v: member, idx: [...out.idx, ...out.sub.idx], span: r.span }
        }
        // The indices on the way name inherited variables too (`c.arr[i % 2]`, `cs[i % 2].inc()`).
        return { ...out, idx: out.idx.map(deep) }
    }
    const deep = (e: CExpr): CExpr => mapExpr(e, x => (x.k === 'ref' ? redirect(x) : retarget(x, redirect)))
    rewriteScope(state, { read: redirect, target: redirect, node: e => retarget(e, redirect) })
    // An override replaces the base method everywhere, also in the base's own bodies (structure.md S-66), unless it
    // calls `super`: then KIELER keeps the base method and the base's references keep calling it (KIELER's defect,
    // conformance structure/138).
    for (const [base, overrider] of overridden) {
        if (callsVar(overrider.method?.body ?? [], base)) continue
        const swap = (r: CRef): CRef | undefined => (r.v === base ? { ...r, v: overrider } : undefined)
        rewriteScope(state, {
            read: swap, target: swap,
            node: e => (e.k === 'call' && e.target?.v === base ? { ...e, target: { ...e.target, v: overrider } } : undefined),
        })
    }
    // What lowering the bases found, for the parts that stay: KIELER drops an overridden region or method with what
    // is written in it. An override that calls `super` keeps the base's method; `region is super.R` copies the
    // base's region another way, which redirects every name (probes probe-inherited-index-override-*).
    const visibleIds = new Set(visibleRegions(chart, find).map(x => x.region))
    for (const b of bases) {
        const dropped: (Span | undefined)[] = b.chart.regions.filter(r => !visibleIds.has(r.id)).map(r => r.span)
        for (const [base, overrider] of overridden) {
            if (callsVar(overrider.method?.body ?? [], base)) continue
            dropped.push(b.chart.declarations.find(d => d.valuedObjects.some(vo => b.prefix + vo.id === base.decl))?.span)
        }
        for (const d of b.reports ?? []) {
            if (!dropped.some(span => span && d.span && d.span.start >= span.start && d.span.end <= span.end)) ctx.report(d)
        }
    }
    // `region is super.R`: a copy of the base's R in its place.
    for (const region of allRegions(state)) {
        const call = region.ext.reference as ScopeCall | undefined
        if (!call?.super) continue
        delete region.ext.reference
        const base = bases.find(b => b.chart.regions.some(r => r.name === call.target))
        const source = base?.chart.regions.find(r => r.name === call.target)
        if (!base || !source) continue
        const copy = lowerInstance(base.chart, index, `${base.prefix}super${REFERENCE_SEPARATOR}`).root
        const prefix = `${base.prefix}super${REFERENCE_SEPARATOR}`
        const r = copy.regions.find(x => x.origin === prefix + source.id)
        if (!r) continue
        // Its variables are the inherited ones.
        // A member's counterpart is found through its instance's: two instances of one type share the members' ids.
        const counterpart = (v: CVar): CVar | undefined => {
            const id = v.decl?.startsWith(prefix) ? v.decl.slice(prefix.length) : undefined
            if (!id) return undefined
            const of = v.member ? counterpart(v.member.of) : undefined
            const member = of ? [...(instances.get(of) ?? [])].find(([key]) => key.split(REFERENCE_SEPARATOR).pop() === id.split(REFERENCE_SEPARATOR).pop())?.[1] : undefined
            return member ?? byDecl.get(id)
        }
        const mapped = (ref: CRef): CRef | undefined => {
            const target = counterpart(ref.v)
            // The copy's own declarations, and what it names from its own bases (unresolved in the copy alone).
            return target && (copy.decls.includes(ref.v) || ref.v.declKind === 'unresolved') ? { ...ref, v: target } : undefined
        }
        rewriteScope(r, { read: mapped, target: mapped, node: e => retarget(e, mapped) })
        const parent = region.parent
        parent.regions.splice(parent.regions.indexOf(region), 1)
        r.name = region.name
        r.label = region.label
        r.parent = parent
        parent.regions.push(r)
    }
    void allContainedStates
    void allScopes
    return true
}

/** A statement list calls (or references) the variable, at any depth. */
function callsVar(list: CStmt[], v: CVar): boolean {
    let found = false
    const expr = (e: CExpr | undefined) => walkExpr(e, x => { if ((x.k === 'call' && x.target?.v === v) || (x.k === 'ref' && x.v === v)) found = true })
    const visit = (stmts: CStmt[]) => {
        for (const s of stmts) {
            switch (s.k) {
                case 'do':
                    if (s.f.k === 'call') expr(s.f.call)
                    else if (s.f.k === 'assign') expr(s.f.expr)
                    else if (s.f.k === 'print') s.f.args.forEach(expr)
                    else if (s.f.k === 'emit') expr(s.f.value)
                    break
                case 'if': expr(s.cond); visit(s.then); if (s.else) visit(s.else); break
                case 'while': expr(s.cond); visit(s.body); break
                case 'for': visit(s.init); expr(s.cond); visit(s.update); visit(s.body); break
                case 'return': expr(s.expr); break
                case 'expr': expr(s.e); break
                default: break
            }
        }
    }
    visit(list)
    return found
}

/** A call whose method reference the mapping redirects (calls are not reads: rewrite.ts leaves their targets alone). */
function retarget(e: CExpr, map: (r: CRef) => CRef | undefined): CExpr | undefined {
    if (e.k !== 'call' || !e.target) return undefined
    const t = map(e.target)
    if (!t) return undefined
    // A method of an element of an array of instances takes the element's indices first (lower.ts call()).
    if (t.v.declKind === 'method' && t.v.member && t.idx.length) return { ...e, args: [...t.idx, ...e.args], target: { ...t, idx: [] } }
    return { ...e, target: t }
}

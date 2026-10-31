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

import type { ScopeCall, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { PassContext } from './context'
import {
    allContainedStates, allRegions, allScopes, walkExpr, type CExpr, type CRef, type CRegion, type CState, type CStmt, type CVar,
} from '../model'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { rewriteScope } from '../structure/rewrite'

interface Base {
    chart: State
    prefix: string
    root: CState
}

/** KIELER's getAllInheritedStates: every base, transitively, each once. */
function allInherited(chart: State, find: (name: string) => State | undefined): State[] {
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
function visibleRegions(chart: State, find: (name: string) => State | undefined): { base: State; region: string }[] {
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
    const bases: Base[] = allInherited(chart, find).map(b => {
        const prefix = `${state.origin ?? state.about ?? state.name}${REFERENCE_SEPARATOR}`
        return { chart: b, prefix, root: lowerInstance(b, index, prefix).root }
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
    const redirect = (r: CRef): CRef | undefined => {
        if (r.v.declKind !== 'unresolved' || !r.v.decl) return undefined
        const target = byDecl.get(r.v.decl) ?? byDecl.get(r.v.decl.split(REFERENCE_SEPARATOR).pop()!)
        return target ? { ...r, v: target } : undefined
    }
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
        const mapped = (ref: CRef): CRef | undefined => {
            const id = ref.v.decl?.startsWith(prefix) ? ref.v.decl.slice(prefix.length) : undefined
            const target = id ? byDecl.get(id) : undefined
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
    return t ? { ...e, target: t } : undefined
}

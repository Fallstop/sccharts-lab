// KIELER's Inheritance processor (sccharts/processors/Inheritance.xtend), called by the Reference processor before
// a chart's references are expanded. structure.md S-17.
//
// `scchart A extends B`: A receives B's declarations (in front of its own; private ones renamed `B_x`), B's actions
// (in front of its own) and B's regions (in front of its own), except the regions A overrides (`override region R`
// hides B's R; an override region of a base hides the regions of its own bases). Inside an override region,
// `region is super.R` is replaced by a copy of the base's R. Every base is a fresh copy of its chart (lowered like an
// instance, structure/instance.ts); A's references to inherited variables are redirected to those copies.
//
// An inner state can extend a chart too (`state T extends B(o) { ... }`): it receives B's content in the same way,
// as declarations, actions and regions of the state.
//
// Bindings (`extends B(i, p)`) and generic arguments (`extends B<3>`) are substitutions made here, after the merge
// (Inheritance.xtend 278-447): the bound inputs and outputs of the bases and their generic parameters are replaced
// everywhere in the state, and the bound declarations go. A parameter list must bind every input and output of the
// base: KIELER's compiler crashes on one it leaves open. Names bound further out (the chart is an instance, or the
// state lies in one) replace the declarations of the same name, own and inherited.

import type { Diagnostic, ScopeCall, Span, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import { genericBindings, interfaceOf, visibleInheritedRegions } from '../../parser/generics'
import type { PassContext } from './context'
import {
    allContainedStates, allRegions, allScopes, copyExpr, mapExpr, walkExpr, type CArg, type CExpr, type CGenericArg, type CRef, type CRegion,
    type CState, type CStmt, type CVar,
} from '../model'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { inheritedDeclarations } from '../lower'
import { rewriteScope } from '../structure/rewrite'
import { expressionClass, isValue, type Replacements } from '../structure/replacements'
import { plainVariable } from './reference'

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
    return visibleInheritedRegions(chart, find).map(x => ({ base: x.base, region: x.region.id }))
}

/**
 * Applies inheritance to a state whose source chart extends others. `chart` is the state's source (AST) chart,
 * `prefix` the prefix of its ids (for an instance's copy of a chart). Returns false if it cannot.
 */
export function inherit(ctx: PassContext, state: CState, chart: State, find: (name: string) => State | undefined, upstream?: Replacements): boolean {
    const index = ctx.shared.index as ModelIndex | undefined
    const calls = (state.ext.baseStates as ScopeCall[] | undefined) ?? []
    const ownArgs = (state.ext.baseArgs as BaseArgs[] | undefined) ?? []
    delete state.ext.baseStates
    delete state.ext.baseArgs
    // What `region Q is R` inside the state can name (the visible inherited regions).
    state.ext.inheritedRegions = visibleRegions(chart, find).map(x => ({ chart: x.base, region: x.region, name: x.base.regions.find(r => r.id === x.region)?.name }))
    /** The members of the bases' class and struct instances (two instances of one type share the members' ids). */
    const instances = new Map<CVar, Map<string, CVar>>()
    // Inside the copies of the bases, the bases' declarations are the inherited ones too (lower.ts inheritedIndex).
    const replaced = inheritedDeclarations(chart, index)
    const bases: Base[] = allInherited(chart, find).map(b => {
        const prefix = `${state.origin ?? state.about ?? state.name}${REFERENCE_SEPARATOR}`
        const lowered = lowerInstance(b, index, prefix, undefined, replaced)
        for (const [inst, members] of lowered.instances) instances.set(inst, members)
        if (lowered.stateFlags.length) {
            // KIELER makes the flag of `state(S)` where S is written, in the base chart, which is not compiled.
            const flag = lowered.stateFlags[0]
            ctx.report({
                severity: 'error', code: 'state-access', span: flag.span, related: state.origin ? [state.origin] : undefined,
                message: `The base chart \`${b.name}\` uses \`${flag.display ?? 'state(...)'}\` in a method, which does not work in a chart that inherits it`,
                kieler: `The valued object reference points to a valued object (${flag.name}) that is not contained in the model!\nReferences objects are not contained in the resource!`,
                hint: 'KIELER puts the flag behind `state(...)` into the base chart, and only the inheriting chart is compiled. Let the base chart set a variable in the state\'s entry and exit actions instead.',
            })
        }
        return { chart: b, prefix, root: lowered.root, reports: lowered.reports }
    })
    if (!bases.length) return true
    // Variables of the bases by their source id (the inheriting chart's references carry those ids).
    const byDecl = new Map<string, CVar>()
    const own = new Set(state.decls.map(v => v.name))
    /** KIELER's voNames: every declaration of the state by name, its own and the copies of the bases'. */
    const voNames = new Map<string, CVar[]>()
    const named = (v: CVar) => voNames.set(v.name, [...(voNames.get(v.name) ?? []), v])
    state.decls.forEach(named)
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
            if (!v.member) named(v)
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
    // Bindings last: the copies of `region is super.R` take them too (KIELER keeps them for those regions).
    bindInherited({
        ctx, state, chart, index, bases, calls, ownArgs, upstream, voNames, inherited, byDecl,
        redirect: e => mapExpr(e, x => (x.k === 'ref' ? redirect(x) : retarget(x, redirect))),
    })
    void allContainedStates
    return true
}

/** `extends Base<...>(...)`: the arguments, lowered in the extending state (lower.ts contents). */
interface BaseArgs {
    args: CArg[]
    generics: CGenericArg[]
}

interface Binding {
    ctx: PassContext
    state: CState
    chart: State
    index: ModelIndex | undefined
    bases: Base[]
    calls: ScopeCall[]
    ownArgs: BaseArgs[]
    upstream: Replacements | undefined
    voNames: Map<string, CVar[]>
    inherited: CVar[]
    byDecl: Map<string, CVar>
    /** Redirects the names an argument takes from a base chart to the state's copies of them. */
    redirect(e: CExpr): CExpr
}

/**
 * Inheritance.xtend 278-447: what `extends Base<...>(...)` binds, and what is bound further out, is put in place
 * everywhere in the state; the bound declarations go.
 */
function bindInherited(b: Binding) {
    const { ctx, state, index, bases, upstream } = b
    const related = state.origin ? [state.origin] : undefined
    const bindings = new Map<CVar, CExpr>()
    const types = new Map<CVar, CGenericArg>()
    /** Generic parameters given a name instead of a literal (as written). */
    const named = new Map<CVar, string>()
    // Bound upstream: the names on the replacement stack that the state declares (itself or by inheritance).
    if (upstream) {
        for (const name of upstream.names()) {
            const value = upstream.peek(name)
            if (value) for (const v of b.voNames.get(name) ?? []) bindings.set(v, value)
        }
        // The state's own value parameters. (Its type parameters never are: KIELER looks the name up with an object.)
        for (const g of (state.ext.generics as CVar[] | undefined) ?? []) {
            if (g.generic?.kind !== 'value' && g.generic?.kind !== 'reference') continue
            const value = upstream.peek(g.name)
            if (value) bindings.set(g, value)
        }
    }
    // Bound in the hierarchy: the state's own base references, then those of the bases, level by level.
    const references: { call: ScopeCall; args: BaseArgs; target: Base; holder: string }[] = []
    const seen = new Set<string>()
    const add = (calls: ScopeCall[], args: BaseArgs[], holder: string) => {
        const added: typeof references = []
        calls.forEach((call, i) => {
            const target = bases.find(x => x.chart.name === call.target)
            const key = `${holder}#${i}`
            if (!target || seen.has(key) || !args[i]) return
            seen.add(key)
            const entry = { call, args: args[i], target, holder }
            references.push(entry)
            added.push(entry)
        })
        return added
    }
    const work = add(b.calls, b.ownArgs, '')
    while (work.length) {
        const next = work.shift()!.target
        work.push(...add((next.root.ext.baseStates as ScopeCall[] | undefined) ?? [], (next.root.ext.baseArgs as BaseArgs[] | undefined) ?? [], next.chart.name))
    }
    let crashed = false
    for (const { call, args, target } of references) {
        // Inputs and outputs of the base.
        if (args.args.length && !crashed) {
            const formals = index ? interfaceOf(target.chart, index) : []
            const vars = formals.map(vo => b.byDecl.get(vo.id))
            const bound = new Set<number>()
            let ptr = 0
            for (const a of args.args) {
                if (a.binding !== undefined) {
                    const i = formals.findIndex(vo => vo.name === a.binding)
                    if (i < 0) continue
                    ptr = i
                }
                if (ptr >= formals.length) continue
                const v = vars[ptr]
                bound.add(ptr)
                ptr++
                // A binding made higher up wins (KIELER warns).
                if (!v || bindings.has(v)) continue
                let replacement = b.redirect(copyExpr(a.expr))
                if (replacement.k === 'ref' && bindings.has(replacement.v)) replacement = bindings.get(replacement.v)!
                bindings.set(v, replacement)
            }
            const open = formals.find((_, i) => !bound.has(i))
            if (open) {
                // An input or output the parameter list leaves open has no source, and KIELER copies it regardless.
                crashed = true
                ctx.report({
                    severity: 'error', code: 'kieler-crash', span: call.span, related,
                    message: `\`extends ${target.chart.name}(...)\` leaves \`${open.name}\` of \`${target.chart.name}\` unbound: KIELER's compiler crashes on that`,
                    kieler: 'java.lang.NullPointerException: Cannot invoke "org.eclipse.emf.ecore.EObject.eAllContents()" because "object" is null\n\tde.cau.cs.kieler.sccharts.processors.Inheritance.replaceVOR',
                    hint: `A parameter list after \`extends\` must bind every input and output of the base chart (\`${formals.map(f => f.name).join('\`, \`')}\`). Without a parameter list the chart simply inherits them.`,
                })
            }
        }
        // Generic parameters of the base.
        if (args.generics.length) {
            const generics = (target.root.ext.generics as CVar[] | undefined) ?? []
            const checks = index ? genericBindings(target.chart.genericParameterDeclarations ?? [], call.genericArguments ?? [], index) : []
            for (let i = 0; i < Math.max(generics.length, args.generics.length); i++) {
                const g = generics[i]
                const errors = checks[i]?.errors ?? []
                if (errors.length) {
                    ctx.report({
                        severity: 'error', code: 'generic-argument', span: call.genericArguments?.[i]?.span ?? call.span, related,
                        message: `The generic arguments of \`extends ${target.chart.name}\` do not fit: ${errors[0]}`,
                        kieler: `Errornous generic parameter. Paramter ${g?.name ?? 'null'} of ${target.chart.name} was not set correcly. ${errors.join('\n')}`,
                        hint: `\`${target.chart.name}\` declares ${generics.length ? `the generic parameters \`${generics.map(x => x.name).join('\`, \`')}\`` : 'no generic parameters'}: give one fitting argument for each.`,
                    })
                    continue
                }
                const arg = args.generics[i]
                if (!g || !arg) continue
                if (g.generic?.kind === 'type' || g.generic?.kind === 'primitive') {
                    let replacement = arg
                    while (replacement.k === 'expr' && replacement.expr.k === 'ref' && types.has(replacement.expr.v)) replacement = types.get(replacement.expr.v)!
                    if (types.has(g)) conflict(ctx, 'Type paramter', g, target, call, related)
                    else types.set(g, replacement)
                } else {
                    let replacement: CExpr = arg.k === 'expr' ? b.redirect(copyExpr(arg.expr)) : { k: 'unsupported', what: arg.text, span: arg.span }
                    while (replacement.k === 'ref' && (bindings.has(replacement.v) || upstream?.has(replacement.v.name))) {
                        const next: CExpr | undefined = bindings.get(replacement.v) ?? upstream?.peek(replacement.v.name)
                        if (!next || next === replacement) break
                        replacement = next
                    }
                    if (bindings.has(g)) conflict(ctx, 'Binding Paramter', g, target, call, related)
                    else {
                        bindings.set(g, replacement)
                        if (arg.named) named.set(g, arg.text)
                    }
                }
            }
        }
    }
    // A for-region range must be an int literal when KIELER's For processor runs: a generic parameter given a
    // literal is one by then, one given a name (a variable, also a constant) is still the name.
    for (const region of allRegions(state)) {
        for (const bound of [region.ext.forFrom, region.ext.forTo] as (CExpr | undefined)[]) {
            const name = bound?.k === 'ref' ? named.get(bound.v) : undefined
            if (name === undefined) continue
            ctx.report({
                severity: 'error', code: 'for-range', span: bound?.span, related: region.origin ? [region.origin] : undefined,
                message: `The end of a for range must be a number: the generic parameter stands for \`${name}\` here`,
                kieler: `The for-region range ends at ${name}, which is not an integer literal.`,
                hint: 'Give the generic parameter a number written out (`extends Base<3>`): KIELER copies the region before it knows the value of a constant or variable.',
            })
        }
    }
    // Replace the bound names: every reference in the state (its members excepted), whatever scope it is written in.
    const reported = new Set<CVar>()
    const replaced = (r: CRef, target: boolean): CExpr | undefined => {
        let value = bindings.get(r.v)
        if (!value && upstream?.has(r.v.name) && !r.v.member) {
            const outer = upstream.peek(r.v.name)
            // (Its own name on the stack: an enclosing scope's declaration, pushed as itself.)
            if (outer && !(outer.k === 'ref' && outer.v === r.v)) value = b.redirect(outer)
        }
        if (!value) return undefined
        if (value.k === 'ref') {
            const sub = value.sub ? chain(copyExpr(value.sub) as CRef, r.sub) : r.sub
            return { ...r, v: value.v, idx: [...value.idx.map(i => copyExpr(i)), ...r.idx], ...(sub ? { sub } : {}) }
        }
        if (isValue(value)) {
            if (target && !reported.has(r.v)) {
                reported.add(r.v)
                ctx.report({
                    severity: 'error', code: 'kieler-crash', span: r.span, related,
                    message: `\`${r.v.name}\` stands for a value here and cannot be assigned: KIELER's compiler crashes on this assignment`,
                    kieler: 'java.lang.ClassCastException: class de.cau.cs.kieler.kexpressions.impl.IntValueImpl cannot be cast to class de.cau.cs.kieler.kexpressions.ValuedObjectReference',
                    hint: 'A name bound to a value through `extends` is that value wherever the chart names it. Bind a variable instead if the chart writes it.',
                })
            }
            return target ? undefined : { ...copyExpr(value), span: r.span }
        }
        if (!reported.has(r.v)) {
            reported.add(r.v)
            ctx.report({
                severity: 'error', code: 'binding-expression', span: value.span ?? r.span, related,
                message: `\`${r.v.name}\` is bound to an expression: only variables, array cells and values can be passed`,
                kieler: `A binding for the valued object reference "${r.v.name}" exists, but the type "${expressionClass(value)}" is not supported.`,
                hint: `Compute the value into a variable of this chart first and pass that variable as \`${r.v.name}\`.`,
            })
        }
        return undefined
    }
    if (bindings.size || (upstream && !upstream.empty)) {
        const read = (r: CRef) => replaced(r, false)
        const target = (r: CRef) => {
            const out = replaced(r, true)
            return out?.k === 'ref' ? out : undefined
        }
        rewriteScope(state, {
            read, target,
            node: e => {
                if (e.k !== 'call' || !e.target) return undefined
                const t = target(e.target)
                return t ? { ...e, target: t } : undefined
            },
        })
        // The generic arguments written in the state too (KIELER replaces every reference it contains).
        const deep = (e: CExpr): CExpr => mapExpr(e, x => (x.k === 'ref' ? read(x) : undefined))
        const generic = (g: CGenericArg): CGenericArg => (g.k === 'expr' ? { ...g, expr: deep(g.expr) } : g.k === 'chart' ? { ...g, args: g.args.map(generic) } : g)
        for (const scope of allScopes(state)) {
            for (const v of scope.decls) if (v.instance?.generics) v.instance = { ...v.instance, generics: v.instance.generics.map(generic) }
            if ('out' in scope) {
                const list = scope.ext.genericArgs as CGenericArg[] | undefined
                if (list) scope.ext.genericArgs = list.map(generic)
                const inner = scope.ext.baseArgs as BaseArgs[] | undefined
                if (inner && scope !== state) scope.ext.baseArgs = inner.map(x => ({ args: x.args.map(a => ({ ...a, expr: deep(a.expr) })), generics: x.generics.map(generic) }))
            }
        }
    }
    // The bound declarations go (a generic parameter is no declaration).
    const removed = (ctx.shared.removedVars ??= new Set<CVar>()) as Set<CVar>
    for (const v of bindings.keys()) {
        if (v.declKind === 'generic') continue
        const i = state.decls.indexOf(v)
        if (i >= 0) state.decls.splice(i, 1)
        removed.add(v)
    }
    // The types the base references give: for the inherited declarations and methods only.
    const typeOf = (id: string | undefined): CGenericArg | undefined => {
        if (!id) return undefined
        for (const base of bases) for (const g of (base.root.ext.generics as CVar[] | undefined) ?? []) if (g.decl === id) return types.get(g)
        return undefined
    }
    for (const v of b.inherited) {
        const type = typeOf(v.instance?.typeParam ?? v.typeParam)
        if (v.declKind === 'reference' && v.instance?.typeParam) {
            if (type?.k === 'chart') {
                const { typeParam: _, ...rest } = v.instance
                v.instance = { ...rest, target: type.name }
                if (type.args.length) {
                    if (!v.instance.generics?.length) v.instance = { ...v.instance, generics: type.args, declGenerics: true }
                    else {
                        ctx.report({
                            severity: 'error', code: 'generic-arguments-twice', span: v.span, related,
                            message: `\`${type.name}\` already comes with generic arguments (\`${type.text}\`), and the declaration of \`${v.name}\` gives it some more`,
                            kieler: `Conflicting generic parameters passed to reference declaration of ${v.name} via generic type and in declaration.`,
                            hint: 'Give the generic arguments in one place: where the chart is passed as a type, or in the declaration.',
                        })
                    }
                }
            } else if (type?.k === 'type') plainVariable(v, type.type, d => ctx.report(d))
        } else if (v.typeParam && type?.k === 'type') plainVariable(v, type.type, d => ctx.report(d))
        const m = v.method
        if (!m) continue
        for (const p of m.params) {
            const t = typeOf(p.typeParam)
            if (t?.k === 'type') plainVariable(p, t.type, d => ctx.report(d))
        }
        const t = typeOf(m.returnParam)
        if (t?.k === 'type') {
            m.returnType = t.type
            delete m.returnParam
        }
    }
}

function conflict(ctx: PassContext, what: string, g: CVar, target: Base, call: ScopeCall, related: string[] | undefined) {
    ctx.report({
        severity: 'error', code: 'generic-argument', span: call.span, related,
        message: `\`${target.chart.name}\` is inherited more than once, and its generic parameter \`${g.name}\` is given an argument each time`,
        kieler: `Conflicting generic parameters. ${what} ${g.name} of ${target.chart.name} was already set`,
        hint: `KIELER accepts one \`extends ${target.chart.name}<...>\` in the whole hierarchy of a chart, even when the arguments are the same.`,
    })
}

function chain(first: CRef, rest: CRef | undefined): CRef {
    if (!first.sub) return rest ? { ...first, sub: rest } : first
    return { ...first, sub: chain(first.sub, rest) }
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

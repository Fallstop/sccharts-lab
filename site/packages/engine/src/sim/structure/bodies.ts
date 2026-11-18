// The bodies of methods and code blocks as KIELER's SCCharts processors see them. A method is a declaration of its
// scope (MethodImplementationDeclaration: parameters, the body's declarations, its statements), and a code block
// `do { ... }` is one too by then: SCL Code Effects, early in the chain, makes it the method `_effect<n>` of the state
// (lower.ts codeEffect). Processors that walk the whole model (Signal's `val`, Pre) therefore meet a body at its
// declaration, before the actions and regions of its scope.

import { allScopes, isRegion, type CEffect, type CExpr, type CState, type CStmt, type CVar, type Scope } from '../model'
import { rewriteStatements } from './rewrite'

/**
 * A declaration KIELER has at another place than the working model:
 *
 * - a base chart's method that an override replaces but a `super` call still names (passes/inheritance.ts): the
 *   working model keeps it out of the state's declarations, in KIELER it stays where the base's declarations went;
 * - the methods of a chart used as a class (`ref C g`, passes/reference.ts): the working model appends the
 *   instance's declarations to the state, KIELER's class takes the place of the `ref` declaration, in its scope.
 *
 * `next`: the declarations that followed it there, in order.
 */
interface Placed {
    v: CVar
    next: CVar[]
    /** The `ref` declaration whose class it belongs to (what followed an earlier declaration may name it). */
    owner?: CVar
    /** Declared in a region of the scope: among the declarations the regions hand to their state. */
    region?: boolean
}

/** Listed by `declarationsOf` of the scope that has it placed, not where it is declared. */
const PLACED = '#placed'

/**
 * A declaration of a region that KIELER's Region Actions processor moved to the region's state (passes/
 * regionActions.ts): appended to the state's own, before SCL Code Effects makes the code blocks' methods.
 */
export const REGION_DECLARATION = '#region-declaration'

/**
 * Gives `list` the place in `scope` just before the declarations `next` (those that follow it in KIELER's model):
 * none, the end of the scope's written declarations (`region`: of the ones its regions hand to it).
 */
export function placeDeclarations(scope: Scope, list: CVar[], next: CVar[], owner?: CVar, region = false) {
    const placed = (scope.ext.placed ??= []) as Placed[]
    for (const v of list) {
        v.tags.add(PLACED)
        placed.push({ v, next, ...(owner ? { owner } : {}), ...(region ? { region } : {}) })
    }
}

/** A deep copy's places (structure/copy.ts): those of the original, among the copy's own declarations. */
export function copyPlacement(scope: Scope, vars: ReadonlyMap<CVar, CVar>) {
    const placed = scope.ext.placed as Placed[] | undefined
    if (placed) scope.ext.placed = placed.map(p => ({ ...p, v: vars.get(p.v) ?? p.v, next: p.next.map(v => vars.get(v) ?? v) }))
}

/**
 * The state KIELER's Region Actions processor wraps a region with actions in (`_region_<name>`, passes/
 * regionActions.ts): the region's declarations are that state's then, not the state's around the region.
 */
function wrapperOf(region: Scope): CState | undefined {
    if (!isRegion(region)) return undefined
    return region.states.find(s => s.initial && !s.origin && s.name === `_region_${region.name ?? 'unnamed'}`)
}

/** A scope's declarations in KIELER's order. */
export function declarationsOf(scope: Scope): CVar[] {
    // What was placed in a region with actions is declared in its wrapper state.
    const region = !isRegion(scope) && scope.parent && wrapperOf(scope.parent) === scope ? scope.parent : undefined
    const placed = [...((!wrapperOf(scope) && scope.ext.placed as Placed[] | undefined) || []), ...((region?.ext.placed as Placed[] | undefined) ?? [])]
    const out = scope.decls.filter(v => !v.tags.has(PLACED))
    // The code blocks' methods are made after the regions' declarations arrived (the lowering makes them first).
    const block = (v: CVar) => !!v.method && v.generated && !v.display
    const handed = out.reduce((at, v, i) => (v.tags.has(REGION_DECLARATION) ? i : at), -1)
    const early = out.filter((v, i) => block(v) && i < handed)
    if (early.length) {
        const rest = out.filter(v => !early.includes(v))
        rest.splice(rest.reduce((at, v, i) => (v.tags.has(REGION_DECLARATION) ? i : at), -1) + 1, 0, ...early)
        out.splice(0, out.length, ...rest)
    }
    if (!placed.length) return out
    // What a placed declaration comes before: the first of what followed it that is still a declaration here, or the
    // class of a `ref` declaration that followed it (its first method, placed itself).
    const first = new Map<CVar, CVar>()
    for (const p of placed) if (p.owner && !first.has(p.owner)) first.set(p.owner, p.v)
    const anchor = (p: Placed): CVar | undefined => {
        for (const v of p.next) {
            if (out.includes(v) || placed.some(q => q.v === v)) return v
            const method = first.get(v)
            if (method && method !== p.v) return method
        }
        return undefined
    }
    // Nothing followed it: the end of the state's written declarations, or of the ones its regions handed to it;
    // before what the compiler appended since (code blocks, memories). In the order placed.
    let end = out.reduce((at, v, i) => (v.generated ? at : i), -1) + 1
    let regionEnd = Math.max(end, out.reduce((at, v, i) => (v.tags.has(REGION_DECLARATION) ? i : at), -1) + 1)
    let pending = placed
    while (pending.length) {
        const later: Placed[] = []
        for (const p of pending) {
            const before = anchor(p)
            if (!before) {
                if (p.region) out.splice(regionEnd++, 0, p.v)
                else { out.splice(end++, 0, p.v); regionEnd++ }
            } else if (out.includes(before)) {
                const at = out.indexOf(before)
                out.splice(at, 0, p.v)
                if (at < end) end++
                if (at < regionEnd) regionEnd++
            } else later.push(p)
        }
        // (An anchor that never arrives cannot happen: anchors follow their declaration.)
        if (later.length === pending.length) { out.push(...later.map(p => p.v)); break }
        pending = later
    }
    return out
}

/** The methods declared in a scope, in declaration order: its own, those of its class objects and chart instances. */
export function methodsOf(scope: Scope): CVar[] {
    return declarationsOf(scope).filter(v => !!v.method)
}

/**
 * The effects and expressions of a body in the order of EMF's eAllContents (the containment features in the order of
 * KIELER's metamodel): a statement list in written order (a block's declarations first, as lower.ts puts their
 * initial values); `if`: the then branch, the condition, the else branch (Conditional: declarations, statements,
 * expression, else); a loop: its body, the initialisation, the condition, the afterthought (Loop: declarations,
 * statements, initialization, initializationDeclaration, condition, afterthought).
 */
export function walkBody(list: CStmt[], effect: (f: CEffect) => void, expr: (e: CExpr | undefined) => void) {
    for (const s of list) {
        switch (s.k) {
            case 'do': effect(s.f); break
            case 'if':
                walkBody(s.then, effect, expr)
                expr(s.cond)
                if (s.else) walkBody(s.else, effect, expr)
                break
            case 'while':
                walkBody(s.body, effect, expr)
                expr(s.cond)
                break
            case 'for':
                walkBody(s.body, effect, expr)
                walkBody(s.init, effect, expr)
                expr(s.cond)
                walkBody(s.update, effect, expr)
                break
            case 'return': expr(s.expr); break
            case 'expr': expr(s.e); break
            default: break
        }
    }
}

/** Replaces expressions (children first) in the body of every method declared in `root` or below it. */
export function mapBodies(root: CState, fn: (e: CExpr) => CExpr | undefined) {
    for (const scope of allScopes(root)) {
        for (const v of methodsOf(scope)) v.method!.body = rewriteStatements(v.method!.body, { node: fn })
    }
}

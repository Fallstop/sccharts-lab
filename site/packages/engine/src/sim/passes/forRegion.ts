// KIELER's For processor (sccharts/processors/For.xtend). Owner: the structure workstream. structure.md S-21 .. S-24.
//
// `region R for i : a to b` (int literals; counting down when a > b) and `region R for i : A` (0 to the array's first
// size - 1) become one copy of the region per counter value, appended after the state's other regions in counter
// order (S-22); the original goes. In each copy the counter is a constant: KIELER declares `const int i = <value>`
// in the copy, and its Const processor replaces every use by the value and folds the copy's constant expressions.
// Copies keep their transitions' Taken Transition Signaling marks, so all copies share the original's counter
// (S-23); the marks get a `key` per copy for the tracker (structure/track.ts).
//
// What KIELER cannot compile (S-24): a for-region inside another for-region, and a declaration of the region whose
// initial value uses the counter (Region Actions has moved it out of the region, so the copies lose the counter):
// both crash in KIELER's SCG transformation; assigning the counter fails in Const.

import type { ForCopies } from '../../types'
import type { Pass, PassContext } from './context'
import {
    allContainedStates, allScopes, allStates, isRegion, printEffect, type CExpr, type CRef, type CRegion, type CState, type CVar, type Scope,
} from '../model'
import { foldConstants } from '../fold'
import { copyRegion } from '../structure/copy'
import { rewriteScope, rewriteStatements } from '../structure/rewrite'

export const forRegion: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.for',
    name: 'For',
    owner: 'structure',
    run(ctx: PassContext) {
        const regions = allStates(ctx.root).flatMap(s => s.regions.filter(r => r.ext.forCounter !== undefined))
        if (!regions.length) return
        // Nested for-regions and counters used outside their region crash KIELER: reject before copying.
        let crashed = false
        for (const r of regions) {
            const counter = r.ext.forCounter as CVar
            const nested = regions.some(o => o !== r && inside(r, o))
            const outside = usesOutside(ctx.root, r, counter)
            // A code effect (or method) declared outside the region that uses the counter: its C function reads a
            // counter that does not exist (KIELER's Code Effects come before For and put the method in the state
            // around the region).
            const method = !nested && !outside && methodUses(ctx.root, r, counter)
            if (method) {
                crashed = true
                ctx.report({
                    severity: 'error', code: 'for-counter-method', related: [r.origin, method.decl].filter((x): x is string => !!x),
                    span: method.method?.span,
                    message: `The counter \`${counter.name}\` is used in a code block or method of the for-region's state, where it does not exist`,
                    kieler: `‘TickData’ has no member named ‘${counter.name}’\nCompiler did not return success (exit value != 0)`,
                    hint: `KIELER turns a code block on a transition into a method of the state around the region before it copies the for-region, so the method sees no \`${counter.name}\`. Write the effects without braces (\`s += ${counter.name} * 10\`), or pass \`${counter.name}\` to a method as an argument.`,
                })
            }
            if (nested || outside) {
                crashed = true
                ctx.report({
                    severity: 'error', code: 'kieler-crash', related: r.origin ? [r.origin] : undefined,
                    message: nested
                        ? 'KIELER cannot compile a for-region inside another for-region'
                        : `KIELER cannot compile this for-region: a declaration of the region uses its counter \`${counter.name}\``,
                    kieler: 'java.lang.IllegalArgumentException: Can\'t copy valued object. Valued object is null!',
                    hint: nested
                        ? 'Its compiler crashes while copying the inner for-region. Write the inner copies out by hand, or use one for-region over all combinations (`for k : 0 to 5` with `k / 3` and `k % 3`).'
                        : `KIELER moves the region's declarations to the state around it before making the copies, so their initial values cannot see \`${counter.name}\`. Declare the variable in a state inside the region, or assign it on a transition (\`${counter.name}\` itself is a constant in each copy).`,
                })
            }
        }
        if (crashed) return
        const copies = (ctx.shared.forCopies ??= []) as ForCopies[]
        for (const r of regions) {
            const values = range(r)
            if (r.origin) copies.push({ region: r.origin, values, counter: (r.ext.forCounter as CVar).name, name: r.name })
            expand(ctx, r, values)
        }
    },
}

/** Is `inner` (a region) inside `outer` (a region)? */
function inside(outer: CRegion, inner: CRegion): boolean {
    for (let s: Scope | undefined = inner.parent; s; s = up(s)) if (s === outer) return true
    return false
}

function up(s: Scope): Scope | undefined {
    return isRegion(s) ? s.parent : s.parent
}

/** Is the counter referenced anywhere but inside its region (a declaration Region Actions moved out)? */
/** A method declared outside the region whose body uses the counter. */
function methodUses(root: CState, region: CRegion, counter: CVar): CVar | undefined {
    const within = new Set<Scope>([region, ...allContainedStates(region).flatMap(s => [s, ...s.regions])])
    for (const scope of allScopes(root)) {
        if (within.has(scope)) continue
        for (const v of scope.decls) {
            if (!v.method) continue
            let found = false
            const probe = (r: CRef) => { if (r.v === counter) found = true; return undefined }
            rewriteStatements(v.method.body, { read: probe, target: probe })
            if (found) return v
        }
    }
    return undefined
}

function usesOutside(root: CState, region: CRegion, counter: CVar): boolean {
    const within = new Set<Scope>([region, ...allContainedStates(region).flatMap(s => [s, ...s.regions])])
    let found = false
    for (const scope of allScopes(root)) {
        if (within.has(scope)) continue
        usesIn(scope, counter, () => { found = true })
    }
    return found
}

/** Calls `hit` for every use of `v` in a scope's own declarations, actions and (for states) outgoing transitions. */
function usesIn(scope: Scope, v: CVar, hit: () => void) {
    const visit = (e: CExpr | undefined) => {
        if (!e) return
        if (e.k === 'ref') { if (e.v === v) hit(); e.idx.forEach(visit) }
        else if (e.k === 'op') e.args.forEach(visit)
        else if (e.k === 'vector') e.values.forEach(visit)
        else if (e.k === 'call') e.args.forEach(visit)
    }
    for (const d of scope.decls) { visit(d.init); d.dims.forEach(visit) }
    for (const a of scope.actions) {
        visit(a.trigger)
        for (const f of a.effects) if (f.k === 'assign') { visit(f.ref); visit(f.expr) }
    }
    if (!isRegion(scope)) {
        for (const t of scope.out) {
            visit(t.trigger)
            for (const f of t.effects) if (f.k === 'assign') { visit(f.ref); visit(f.expr) }
        }
    }
}

/** The counter values of a for-region (KIELER's getForRegionRange). */
function range(r: CRegion): number[] {
    const from = r.ext.forFrom as CExpr | undefined
    const to = r.ext.forTo as CExpr | undefined
    let first = 0
    let last = -1
    if (from?.k === 'lit' && typeof from.v === 'number' && to?.k === 'lit' && typeof to.v === 'number') {
        first = from.v
        last = to.v
    } else if (from?.k === 'ref') {
        const size = from.v.dims[0]
        if (size?.k === 'lit' && typeof size.v === 'number') last = size.v - 1
    } else {
        return []
    }
    // Xtend's first..second counts down when first > second.
    const out: number[] = []
    if (first <= last) for (let i = first; i <= last; i++) out.push(i)
    else for (let i = first; i >= last; i--) out.push(i)
    return out
}

/** The counter values a source for-region was copied for (the tracker's view of the copies, structure/track.ts). */
export type { ForCopies }

/** Marks the log note that says which copy of a for-region a transition fired in (describe.ts). */
export const FOR_COPY_NOTE = '#for-copy'

/** The tracker key of a for-region copy: appended to the ids of everything inside it. */
export function copyKey(region: string, value: number): string {
    return `|${region}=${value}`
}

function expand(ctx: PassContext, region: CRegion, values: number[]) {
    const counter = region.ext.forCounter as CVar
    const parent = region.parent
    for (const value of values) {
        const copy = copyRegion(region)
        delete copy.ext.forCounter
        delete copy.ext.forFrom
        delete copy.ext.forTo
        delete copy.ext.forLoop
        const literal = (span?: CRef['span']): CExpr => ({ k: 'lit', t: 'int', v: value, span })
        // Const: the counter is replaced by its value; assigning it fails.
        for (const s of allContainedStates(copy)) {
            for (const f of [...s.out.flatMap(t => t.effects), ...[s, ...s.regions].flatMap(x => x.actions).flatMap(a => a.effects)]) {
                if (f.k === 'assign' && f.ref.v === counter) {
                    ctx.report({
                        severity: 'error', code: 'for-counter-assignment', span: f.o.span, related: f.o.by ? [f.o.by] : undefined,
                        message: `The counter \`${counter.name}\` of a for-region cannot be assigned: it is a constant in each copy (here ${value})`,
                        kieler: `Cannot replace left hand side of assignment by a value. (Trying to replace ${counter.name} by ${value} in ${printEffect(f)})`,
                        hint: `Use a variable of your own for values that change: \`int k = ${counter.name}\` in a state of the region, then assign \`k\`.`,
                    })
                }
            }
        }
        // The copy's own variables (its states' declarations), for tracing each copy's value (traceableVariables).
        for (const s of allContainedStates(copy)) for (const scope of [s, ...s.regions]) for (const v of scope.decls) v.forCopy = { region: region.origin ?? '', counter: counter.name, value }
        rewriteScope(copy, { read: r => (r.v === counter ? literal(r.span) as never : undefined) })
        // Const folds the constant expressions of the scope that declares the constant (the copy).
        rewriteScope(copy, { node: e => (e.k === 'op' ? foldConstants(e) : undefined) })
        // The copies share the original's taken counters; the tracker tells them apart.
        const key = copyKey(region.origin ?? '', value)
        for (const s of allContainedStates(copy)) {
            for (const t of s.out) {
                for (const f of t.effects) {
                    if (f.k === 'mark' && f.m.kind === 'take') f.m = { ...f.m, key: (f.m.key ?? f.m.transition) + key }
                }
            }
        }
        copy.parent = parent
        parent.regions.push(copy)
    }
    parent.regions.splice(parent.regions.indexOf(region), 1)
}

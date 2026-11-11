// Rewriting every expression of a part of the working model: triggers, effects (with their targets), declarations'
// initial values and sizes, method bodies, reference arguments, dataflow equations and for-region bounds. The
// structure passes use it to bind a referenced chart's interface (KIELER's replaceValuedObjectReferences), to put a
// for-region's counter value into each copy, and to redirect variables.

import type { CEquation } from '../lower'
import {
    allScopes, isRegion, mapExpr, type CArg, type CEffect, type CExpr, type CRef, type CState, type CStmt, type CVar,
    type Scope,
} from '../model'

export interface Rewriter {
    /** A reference read in an expression (its indices are rewritten already); return the replacement. */
    read?(r: CRef): CExpr | undefined
    /** The target of an assignment or emission (its indices are rewritten already); return the replacement. */
    target?(r: CRef): CRef | undefined
    /** Any other expression node, after its children (for folding). */
    node?(e: CExpr): CExpr | undefined
}

export function rewriteExpr(e: CExpr, w: Rewriter): CExpr {
    return mapExpr(e, x => {
        if (x.k === 'ref') return w.read?.(x) ?? w.node?.(x)
        return w.node?.(x)
    })
}

function rewriteTarget(r: CRef, w: Rewriter): CRef {
    const idx = r.idx.map(i => rewriteExpr(i, w))
    const mapped: CRef = { ...r, idx }
    return w.target?.(mapped) ?? mapped
}

export function rewriteEffect(f: CEffect, w: Rewriter): CEffect {
    switch (f.k) {
        case 'assign': return { ...f, ref: rewriteTarget(f.ref, w), expr: f.expr ? rewriteExpr(f.expr, w) : undefined }
        case 'emit': return { ...f, ref: rewriteTarget(f.ref, w), value: f.value ? rewriteExpr(f.value, w) : undefined }
        case 'print': return { ...f, args: f.args.map(a => rewriteExpr(a, w)) }
        case 'call': {
            const call = { ...f.call, args: f.call.args.map(a => rewriteExpr(a, w)) }
            // The call itself goes through `node` too (a member call redirected to an instance's method).
            const mapped = w.node?.(call)
            return { ...f, call: mapped?.k === 'call' ? mapped : call }
        }
        default: return f
    }
}

export function rewriteStatements(list: CStmt[], w: Rewriter): CStmt[] {
    return list.map((s): CStmt => {
        switch (s.k) {
            case 'do': return { ...s, f: rewriteEffect(s.f, w) }
            case 'if': return { ...s, cond: rewriteExpr(s.cond, w), then: rewriteStatements(s.then, w), else: s.else ? rewriteStatements(s.else, w) : undefined }
            case 'while': return { ...s, cond: rewriteExpr(s.cond, w), body: rewriteStatements(s.body, w) }
            case 'for': return {
                ...s, init: rewriteStatements(s.init, w), cond: s.cond ? rewriteExpr(s.cond, w) : undefined,
                update: rewriteStatements(s.update, w), body: rewriteStatements(s.body, w),
            }
            case 'return': return { ...s, expr: s.expr ? rewriteExpr(s.expr, w) : undefined }
            case 'expr': return { ...s, e: rewriteExpr(s.e, w) }
            default: return s
        }
    })
}

function rewriteArgs(args: CArg[], w: Rewriter): CArg[] {
    return args.map(a => ({ ...a, expr: rewriteExpr(a.expr, w) }))
}

/** Rewrites a variable's declaration parts (initial value, sizes, method body, instance arguments). */
export function rewriteVar(v: CVar, w: Rewriter) {
    if (v.init) v.init = rewriteExpr(v.init, w)
    v.dims = v.dims.map(d => rewriteExpr(d, w))
    if (v.method) {
        for (const p of v.method.params) p.dims = p.dims.map(d => rewriteExpr(d, w))
        v.method.body = rewriteStatements(v.method.body, w)
    }
    if (v.instance) v.instance = { ...v.instance, args: rewriteArgs(v.instance.args, w) }
}

/** Rewrites everything inside a state (itself included) or a region. */
export function rewriteScope(root: CState | Scope, w: Rewriter) {
    const scopes: Scope[] = isRegion(root) ? [root, ...root.states.flatMap(s => allScopes(s))] : allScopes(root)
    for (const scope of scopes) {
        for (const v of scope.decls) rewriteVar(v, w)
        for (const a of scope.actions) {
            if (a.trigger) a.trigger = rewriteExpr(a.trigger, w)
            a.effects = a.effects.map(f => rewriteEffect(f, w))
        }
        if (isRegion(scope)) {
            const eqs = scope.ext.eqs as CEquation[] | undefined
            if (eqs) scope.ext.eqs = eqs.map(eq => ({ ...eq, target: rewriteTarget(eq.target, w), expr: rewriteExpr(eq.expr, w) }))
            if (scope.ext.forFrom) scope.ext.forFrom = rewriteExpr(scope.ext.forFrom as CExpr, w)
            if (scope.ext.forTo) scope.ext.forTo = rewriteExpr(scope.ext.forTo as CExpr, w)
        } else {
            for (const t of scope.out) {
                if (t.trigger) t.trigger = rewriteExpr(t.trigger, w)
                t.effects = t.effects.map(f => rewriteEffect(f, w))
            }
            const args = scope.ext.args as CArg[] | undefined
            if (args) scope.ext.args = rewriteArgs(args, w)
        }
    }
}

/** Every variable declared inside a state (itself included) or region, with method frames. */
export function declaredVars(root: CState | Scope): CVar[] {
    const scopes: Scope[] = isRegion(root) ? [root, ...root.states.flatMap(s => allScopes(s))] : allScopes(root)
    const out: CVar[] = []
    for (const scope of scopes) {
        for (const v of scope.decls) {
            out.push(v)
            if (v.method) out.push(...v.method.params, ...v.method.locals)
        }
    }
    return out
}

/** The scope around a scope: a region's state, a state's region (undefined at the root). */
export function up(s: Scope): Scope | undefined {
    return isRegion(s) ? s.parent : s.parent
}

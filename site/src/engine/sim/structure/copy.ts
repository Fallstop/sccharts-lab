// Deep copies of parts of the working model (EMF's copy): a region with its states, inner regions, transitions,
// actions and declarations. Variables declared inside get copies of their own, and every reference inside the copy
// is redirected to them; effects keep their marks and origins (copyEffect).

import {
    CAction, CRegion, CState, CTransition, CVar, copyEffect, copyExpr, setTarget, type CMethod, type CRef, type CStmt,
} from '../model'
import { rewriteScope, rewriteStatements } from './rewrite'

export function copyVar(v: CVar): CVar {
    const c = new CVar(v.name, v.type)
    c.hostType = v.hostType
    c.signal = v.signal
    c.input = v.input
    c.output = v.output
    c.const = v.const
    c.static = v.static
    c.extern = v.extern
    c.global = v.global
    c.dims = v.dims.map(d => copyExpr(d))
    c.init = copyExpr(v.init)
    c.combine = v.combine
    c.decl = v.decl
    c.display = v.display
    c.role = v.role
    c.of = v.of
    c.generated = v.generated
    c.span = v.span
    c.tags = new Set(v.tags)
    c.declKind = v.declKind
    if (v.instance) c.instance = { ...v.instance, args: v.instance.args.map(a => ({ ...a, expr: copyExpr(a.expr) })) }
    return c
}

function copyStatements(list: CStmt[]): CStmt[] {
    // Rewriting with no changes rebuilds every statement and expression.
    return rewriteStatements(list, {})
}

function copyMethod(m: CMethod, vars: Map<CVar, CVar>): CMethod {
    const frame = (v: CVar) => {
        const c = copyVar(v)
        vars.set(v, c)
        return c
    }
    return { ...m, params: m.params.map(frame), locals: m.locals.map(frame), body: copyStatements(m.body) }
}

function copyAction(a: CAction): CAction {
    const c = new CAction(a.kind)
    c.delay = a.delay
    c.preemption = a.preemption
    c.weak = a.weak
    c.triggerDelay = a.triggerDelay
    c.trigger = copyExpr(a.trigger)
    c.effects = a.effects.map(copyEffect)
    c.origin = a.origin
    c.about = a.about
    c.span = a.span
    c.annotations = [...a.annotations]
    return c
}

/** Copies a region (not attached anywhere: `parent` is the original's until the caller adds it). */
export function copyRegion(region: CRegion): CRegion {
    const vars = new Map<CVar, CVar>()
    const states = new Map<CState, CState>()
    const pending: [CState, CState][] = []

    const decls = (from: CState | CRegion, to: CState | CRegion) => {
        for (const v of from.decls) {
            const c = copyVar(v)
            c.scope = to
            if (v.method) c.method = copyMethod(v.method, vars)
            vars.set(v, c)
            to.decls.push(c)
        }
    }
    const copyR = (r: CRegion, parent: CState): CRegion => {
        const c = new CRegion()
        c.name = r.name
        c.label = r.label
        c.parent = parent
        c.origin = r.origin
        c.about = r.about
        c.dataflow = r.dataflow
        c.final = r.final
        c.abort = r.abort
        c.override = r.override
        c.annotations = new Map(r.annotations)
        c.ext = { ...r.ext }
        decls(r, c)
        c.actions = r.actions.map(copyAction)
        for (const s of r.states) c.states.push(copyS(s, c))
        return c
    }
    const copyS = (s: CState, parent: CRegion): CState => {
        const c = new CState(s.name)
        c.label = s.label
        c.parent = parent
        c.initial = s.initial
        c.final = s.final
        c.connector = s.connector
        c.violation = s.violation
        c.origin = s.origin
        c.about = s.about
        c.annotations = new Map(s.annotations)
        c.ext = { ...s.ext }
        states.set(s, c)
        decls(s, c)
        c.actions = s.actions.map(copyAction)
        for (const r of s.regions) c.regions.push(copyR(r, c))
        pending.push([s, c])
        return c
    }
    const copy = copyR(region, region.parent)
    for (const [s, c] of pending) {
        for (const t of s.out) {
            const n = new CTransition()
            n.source = c
            c.out.push(n)
            setTarget(n, states.get(t.target) ?? t.target)
            n.delay = t.delay
            n.preemption = t.preemption
            n.trigger = copyExpr(t.trigger)
            n.effects = t.effects.map(copyEffect)
            n.triggerDelay = t.triggerDelay
            n.history = t.history
            n.deferred = t.deferred
            n.origin = t.origin
            n.about = t.about
            n.checks = t.checks
            n.annotations = new Map(t.annotations)
            n.span = t.span
        }
    }
    // References to variables declared inside go to their copies.
    const redirect = (r: CRef): CRef | undefined => {
        const v = vars.get(r.v)
        return v ? { ...r, v } : undefined
    }
    rewriteScope(copy, { read: redirect, target: redirect })
    return copy
}

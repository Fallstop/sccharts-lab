// Shared by KIELER's Init Operator, Followed By and Sequential Followed By processors (passes/initOperator.ts,
// passes/followedBy.ts, passes/sequentialFollowedBy.ts; structure.md S-28 .. S-30): finding the operator's uses in
// KIELER's containment order, the state that receives the helper region, and the helper variable's type.

import { allActionSites, isRegion, type CAction, type CExpr, type CState, type CTransition } from '../model'
import type { Diagnostic, ValueType } from '../../types'

export interface OperatorUse {
    /** The holder whose expressions contain it. */
    holder: CTransition | CAction
    /** KIELER's enclosingState of the action: a transition's source's parent state, an action's state. */
    parent: CState | undefined
    /** The operator expression (as found; replaced through `replace`). */
    expr: Extract<CExpr, { k: 'op' }>
}

/** Uses of an operator in triggers and effects, outermost first, in the chart's containment order. */
export function operatorUses(root: CState, op: string): OperatorUse[] {
    const out: OperatorUse[] = []
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const parent = site.transition ? site.transition.source.parent?.parent : isRegion(site.owner) ? site.owner.parent : site.owner
        const visit = (e: CExpr | undefined) => {
            if (!e) return
            if (e.k === 'op') {
                if (e.op === op) out.push({ holder, parent, expr: e })
                e.args.forEach(visit)
            } else if (e.k === 'ref') e.idx.forEach(visit)
            else if (e.k === 'vector') e.values.forEach(visit)
            else if (e.k === 'call') e.args.forEach(visit)
        }
        visit(holder.trigger)
        for (const f of holder.effects) {
            if (f.k === 'assign') { f.ref.idx.forEach(visit); visit(f.expr) }
            else if (f.k === 'emit') visit(f.value)
            else if (f.k === 'print') f.args.forEach(visit)
            else if (f.k === 'call') f.call.args.forEach(visit)
        }
    }
    return out
}

/** Replaces one expression node (by identity) in its holder's trigger and effects. */
export function replaceIn(holder: CTransition | CAction, target: CExpr, replacement: CExpr) {
    const map = (e: CExpr): CExpr => (e === target ? replacement : mapOne(e, map))
    if (holder.trigger) holder.trigger = map(holder.trigger)
    holder.effects = holder.effects.map(f => {
        switch (f.k) {
            case 'assign': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(map) }, expr: f.expr ? map(f.expr) : undefined }
            case 'emit': return { ...f, value: f.value ? map(f.value) : undefined }
            case 'print': return { ...f, args: f.args.map(map) }
            case 'call': return { ...f, call: { ...f.call, args: f.call.args.map(map) } }
            default: return f
        }
    })
}

function mapOne(e: CExpr, map: (e: CExpr) => CExpr): CExpr {
    switch (e.k) {
        case 'op': return { ...e, args: e.args.map(map) }
        case 'ref': return { ...e, idx: e.idx.map(map) }
        case 'vector': return { ...e, values: e.values.map(map) }
        case 'call': return { ...e, args: e.args.map(map) }
        default: return e
    }
}

/**
 * KIELER's inferType (KExpressionsTypeExtensions): from the leaves only (literals and variables; a conditional's
 * condition is skipped, operators do not count): float if arithmetic with a float leaf, else the type all leaves
 * share, else UNKNOWN, which KIELER's simulation cannot serialise (the chart is rejected).
 */
export function inferType(e: CExpr): ValueType | 'unknown' {
    const leafType = (x: CExpr): string | undefined => {
        if (x.k === 'lit') return x.t
        if (x.k === 'ref') {
            let r = x
            while (r.sub) r = r.sub
            return r.v.type
        }
        return undefined
    }
    const operands = (x: Extract<CExpr, { k: 'op' }>) => (x.op === '?:' ? x.args.slice(1) : x.args)
    const has = (x: CExpr, t: string): boolean => (x.k === 'op' ? operands(x).some(a => has(a, t)) : leafType(x) === t)
    const all = (x: CExpr, t: string): boolean => (x.k === 'op' ? operands(x).every(a => all(a, t)) : leafType(x) === t)
    const arithmetic = !has(e, 'bool') && !has(e, 'string') && (has(e, 'int') || has(e, 'float'))
    if (arithmetic && has(e, 'float')) return 'float'
    if (all(e, 'bool')) return 'bool'
    if (all(e, 'int')) return 'int'
    if (all(e, 'float')) return 'float'
    if (all(e, 'string')) return 'string'
    return 'unknown'
}

/** The helper variable's type, or an error like KIELER's when it has none (see inferType). */
export function helperType(e: CExpr, report: (d: Diagnostic) => void, op: string, by: string | undefined): ValueType {
    const t = inferType(e)
    if (t !== 'unknown') return t
    report({
        severity: 'error', code: 'unknown-type', span: e.span, related: by ? [by] : undefined,
        message: `KIELER cannot give the \`${op}\` expression a type: its values mix booleans, numbers or strings`,
        kieler: 'Cannot serialize simulation interface. Unsupported type: UNKNOWN',
        hint: `KIELER stores \`${op}\` in a helper variable whose type comes from all the values and variables in the expression. Make them all one type, for example write \`level > 3\` into a \`bool\` variable first and use that variable here.`,
    })
    return 'int'
}

/**
 * KIELER names some helper variables without making them unique (FollowedBy's `__fbp_next<i>`, and InitOperator's
 * and SequentialFollowedBy's shared `__iop_<k>`). Locals of inner states are renamed when the netlist code generator
 * moves them to the root, but two of the root's own get the same name in the C data struct, which gcc rejects.
 */
export function rootHelperClash(parent: CState, name: string, report: (d: Diagnostic) => void, span: CExpr['span'], by: string | undefined) {
    if (!parent.root || !parent.decls.some(v => v.name === name)) return
    report({
        severity: 'error', code: 'duplicate-declaration', span, related: by ? [by] : undefined,
        message: `KIELER gives two helper variables of the chart the same name (\`${name}\`), so its generated C code does not compile`,
        kieler: `duplicate member ‘${name}’\nCompiler did not return success (exit value != 0)`,
        hint: 'KIELER names the helper variables of `fby` (and of `->` together with `sfby`) by position, so two of them directly in the chart\'s top level clash. Move one of the expressions into a superstate, or compute it with `pre(...)` instead.',
    })
}

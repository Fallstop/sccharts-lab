// Helpers for passes' `uses()` (finding the constructs a pass removes).

import type { Span } from '../../types'
import type { Construct } from './context'
import { allActionSites, allScopes, effectExprs, walkExpr, type CEffect, type CState, type CVar } from '../model'

export function construct(what: string, span?: Span, id?: string): Construct {
    return { what, span, related: id ? [id] : undefined }
}

/** Every variable declared anywhere in the chart. */
export function declsOf(root: CState): CVar[] {
    return allScopes(root).flatMap(s => s.decls)
}

/** Every effect of every transition and action. */
export function effectsOf(root: CState): CEffect[] {
    return allActionSites(root).flatMap(site => (site.transition ?? site.action!).effects)
}

/** Uses of an operator (dataflow `->`, `fby`, `sfby`) in triggers and effects. */
export function opsOf(root: CState, op: string): Construct[] {
    const out: Construct[] = []
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const visit = (e: Parameters<Parameters<typeof walkExpr>[1]>[0]) => {
            if (e.k === 'op' && e.op === op) out.push(construct(`the ${op} operator`, e.span, holder.origin))
        }
        walkExpr(holder.trigger, visit)
        for (const f of holder.effects) for (const e of effectExprs(f)) walkExpr(e, visit)
    }
    for (const v of declsOf(root)) walkExpr(v.init, e => { if (e.k === 'op' && e.op === op) out.push(construct(`the ${op} operator`, e.span, v.decl)) })
    return out
}

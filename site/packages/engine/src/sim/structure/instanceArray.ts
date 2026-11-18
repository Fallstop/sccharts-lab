// An array of chart instances, `ref C g[2]` (KIELER's handleSCChartsDatatype, Reference.xtend "Handle inner behavior
// for each instance"): KIELER keeps an array of class objects and clones the chart's regions and actions once per
// element. The simulator keeps one array per member (as for an array of class instances, lower.ts) and expands the
// chart once per element, so that every element's states have ids of their own (`g[1]/...`, structure/track.ts): the
// first element's declarations are the members of all of them, the further elements' copies only give their regions
// and actions, which work on that element of the members. The methods take the element's indices as hidden first
// parameters.

import { CVar, copyExpr, ref, type CExpr, type CRef, type CState } from '../model'
import { rewriteScope, rewriteStatements } from './rewrite'

/** The index tuples of an array's elements in KIELER's order (the last dimension runs fastest); `[[]]` for no array. */
export function elementIndices(sizes: number[]): number[][] {
    let out: number[][] = [[]]
    for (const n of sizes) out = out.flatMap(at => Array.from({ length: n }, (_, i) => [...at, i]))
    return out
}

/**
 * Makes a freshly expanded copy of a chart the element `at` of an array of instances whose members are those of the
 * first element's copy (`first`, in the order of the copy's own): every reference to one of the chart's own
 * declarations in the copy's regions and actions becomes the member's element (`gs[at].member`), a call of one of its
 * methods passes the indices. For the first element itself, the methods get the hidden index parameters (as lower.ts
 * gives the methods of an array of class instances).
 */
export function elementOf(inst: CState, first: CVar[], at: number[], isFirst: boolean) {
    const literals = (): CExpr[] => at.map(i => ({ k: 'lit', t: 'int', v: i }))
    const members = new Map<CVar, CVar>(inst.decls.map((l, i) => [l, first[i] ?? l]))
    const element = (prefix: () => CExpr[]) => {
        const member = (r: CRef): CRef | undefined => {
            const m = members.get(r.v)
            return m && !m.method ? { ...r, v: m, idx: [...prefix(), ...r.idx] } : undefined
        }
        return {
            read: member, target: member,
            node: (e: CExpr): CExpr | undefined => {
                const m = e.k === 'call' && e.target ? members.get(e.target.v) : undefined
                return e.k === 'call' && m?.method ? { ...e, target: { ...e.target!, v: m }, args: [...prefix(), ...e.args] } : undefined
            },
        }
    }
    if (isFirst) {
        for (const l of inst.decls) {
            if (l.method) {
                const hidden = at.map((_, k) => {
                    const p = new CVar(`_self${k}`, 'int')
                    p.generated = true
                    p.role = 'frame'
                    p.tags.add('#self')
                    return p
                })
                const w = element(() => hidden.map(p => ref(p)))
                l.method = { ...l.method, params: [...hidden, ...l.method.params], body: rewriteStatements(l.method.body, w) }
            }
        }
    }
    // The regions and actions only: the declarations are the first element's (rewritten above, once).
    const decls = inst.decls
    inst.decls = []
    rewriteScope(inst, element(literals))
    inst.decls = decls
}

/** After every element is there: the members of an array of instances get its dimensions and one value per element. */
export function arrayMembers(first: CVar[], dims: CExpr[], count: number[]) {
    const repeat = (value: CExpr, depth = 0): CExpr =>
        depth === count.length ? copyExpr(value) : { k: 'vector', values: Array.from({ length: count[depth] }, () => repeat(value, depth + 1)), span: value.span }
    const nested = new Set<CVar>()
    for (const l of first) {
        // A chart instance inside the chart (no declaration any more): its members name it.
        for (let of = l.member?.of; of; of = of.member?.of) if (!first.includes(of)) nested.add(of)
        if (l.method) continue
        l.dims = [...dims.map(d => copyExpr(d)), ...l.dims]
        if (l.init) l.init = repeat(l.init)
    }
    for (const of of nested) of.dims = [...dims.map(d => copyExpr(d)), ...of.dims]
}

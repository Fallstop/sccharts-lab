// An array of chart instances, `ref C g[2]` (KIELER's handleSCChartsDatatype, Reference.xtend "Handle inner behavior
// for each instance"): KIELER keeps an array of class objects and clones the chart's regions and actions once per
// element. The simulator keeps one array per member (as for an array of class instances, lower.ts) and expands the
// chart once per element, so that every element's states have ids of their own (`g[1]/...`, structure/track.ts): the
// first element's declarations are the members of all of them, the further elements' copies only give their regions
// and actions, which work on that element of the members. The methods take the element's indices as hidden first
// parameters.

import { CVar, copyExpr, ref, type CExpr, type CRef, type CState } from '../model'
import { rewriteExpr, rewriteScope, rewriteStatements, type Rewriter } from './rewrite'

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
    const members = new Map<CVar, CVar>(inst.decls.map((l, i) => [l, first[i] ?? l]))
    const element = (prefix: () => CExpr[]) => elementRewriter(members, prefix)
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
    rewriteScope(inst, element(() => literals(at)))
    inst.decls = decls
}

/** Do the regions and actions of a copy (made an element by elementOf) read or write a field of the instance? */
export function usesFields(inst: CState, first: CVar[]): boolean {
    const fields = new Set(first.filter(l => !l.method))
    let found = false
    const visit = (r: CRef): undefined => {
        if (fields.has(r.v)) found = true
        return undefined
    }
    const decls = inst.decls
    inst.decls = []
    rewriteScope(inst, { read: visit, target: visit })
    inst.decls = decls
    return found
}

const literals = (at: number[]): CExpr[] => at.map(i => ({ k: 'lit', t: 'int', v: i }))

/** What a copy's own declarations are in the element with the indices `prefix`: the member's element, the method with the indices. */
function elementRewriter(members: Map<CVar, CVar>, prefix: () => CExpr[]): Rewriter {
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

/**
 * After every element is there: the members of an array of instances get its dimensions and one value per element.
 * KIELER initialises each element in the class's `_init` method, so a field or method of the chart that an initial
 * value names (`int b = a + 2`, `int c = get()`) is that element's. `instances`: the chart instances inside the chart.
 */
export function arrayMembers(first: CVar[], dims: CExpr[], count: number[], instances: CVar[] = []) {
    const self = new Map<CVar, CVar>(first.map(l => [l, l]))
    const repeat = (value: CExpr, at: number[] = []): CExpr =>
        at.length === count.length
            ? rewriteExpr(copyExpr(value), elementRewriter(self, () => literals(at)))
            : { k: 'vector', values: Array.from({ length: count[at.length] }, (_, i) => repeat(value, [...at, i])), span: value.span }
    for (const l of first) {
        if (l.method) continue
        l.dims = [...dims.map(d => copyExpr(d)), ...l.dims]
        if (l.init) l.init = repeat(l.init)
    }
    // The chart instances inside the chart (no declarations any more): their members name them.
    for (const of of instances) of.dims = [...dims.map(d => copyExpr(d)), ...of.dims]
}

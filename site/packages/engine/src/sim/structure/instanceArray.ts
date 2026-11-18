// An array of chart instances, `ref C g[2]` (KIELER's handleSCChartsDatatype, Reference.xtend 1221-1296): the
// instance's variables become arrays with the instance's dimensions in front of their own (KIELER keeps an array of
// class objects; the simulator keeps one array per member, as for an array of class instances, lower.ts), its
// methods take the element's indices as hidden first parameters, and its regions and actions are cloned once per
// element, with the element's indices put in front of every use of the instance's variables.

import { CAction, CVar, copyEffect, copyExpr, type CExpr, type CRef, type CState } from '../model'
import { copyRegion } from './copy'
import { rewriteEffect, rewriteExpr, rewriteScope, rewriteStatements, type Rewriter } from './rewrite'

/** Puts indices in front of every use of the instance's variables, and of the calls of its methods. */
function indexed(members: ReadonlySet<CVar>, methods: ReadonlySet<CVar>, indices: () => CExpr[]): Rewriter {
    const use = (r: CRef): CRef | undefined => (members.has(r.v) ? { ...r, idx: [...indices(), ...r.idx] } : undefined)
    return {
        read: use,
        target: use,
        node: e => (e.k === 'call' && e.target && methods.has(e.target.v) ? { ...e, args: [...indices(), ...e.args] } : undefined),
    }
}

/**
 * Turns the single expanded instance `inst` into `sizes` many (row-major). Returns the regions' element numbers
 * (KIELER names a clone `<instance><n>_<region>`).
 */
export function spreadInstanceArray(v: CVar, inst: CState, sizes: number[]): Map<object, number> {
    const members = new Set(inst.decls.filter(l => !l.method && !l.member && (!l.declKind || l.declKind === 'class' || l.declKind === 'struct')))
    const methods = new Set(inst.decls.filter(l => !!l.method && !l.member))
    const count = sizes.reduce((a, b) => a * b, 1)
    const element = (n: number): number[] => {
        const out: number[] = []
        for (let k = sizes.length - 1; k >= 0; k--) {
            out.unshift(n % sizes[k])
            n = Math.floor(n / sizes[k])
        }
        return out
    }
    // The variables: the instance's dimensions in front, the initial value once per element.
    const repeat = (value: CExpr, depth = 0): CExpr => (depth === sizes.length ? copyExpr(value)
        : { k: 'vector', values: Array.from({ length: sizes[depth] }, () => repeat(value, depth + 1)), span: value.span })
    for (const l of members) {
        if (l.init) l.init = repeat(l.init)
        l.dims = [...v.dims.map(d => copyExpr(d)), ...l.dims]
    }
    // The methods: hidden parameters carry the element's indices.
    for (const m of methods) {
        const hidden = sizes.map((_, k) => {
            const p = new CVar(`_self${k}`, 'int')
            p.generated = true
            p.role = 'frame'
            p.tags.add('#self')
            return p
        })
        const method = m.method!
        method.body = rewriteStatements(method.body, indexed(members, methods, () => hidden.map(p => ({ k: 'ref' as const, v: p, idx: [] }))))
        method.params = [...hidden, ...method.params]
    }
    // The behaviour: one clone of every region and action per element.
    const numbers = new Map<object, number>()
    const regions = inst.regions
    const actions = inst.actions
    inst.regions = []
    inst.actions = []
    for (let n = 0; n < count; n++) {
        const at = element(n)
        const w = indexed(members, methods, () => at.map(i => ({ k: 'lit' as const, t: 'int' as const, v: i })))
        for (const r of regions) {
            const copy = copyRegion(r)
            rewriteScope(copy, w)
            copy.parent = inst
            inst.regions.push(copy)
            numbers.set(copy, n)
        }
        for (const a of actions) {
            const copy = new CAction(a.kind)
            copy.delay = a.delay
            copy.preemption = a.preemption
            copy.weak = a.weak
            copy.triggerDelay = a.triggerDelay
            copy.origin = a.origin
            copy.about = a.about
            copy.span = a.span
            copy.annotations = [...a.annotations]
            if (a.trigger) copy.trigger = rewriteExpr(copyExpr(a.trigger), w)
            copy.effects = a.effects.map(f => rewriteEffect(copyEffect(f), w))
            inst.actions.push(copy)
        }
    }
    return numbers
}

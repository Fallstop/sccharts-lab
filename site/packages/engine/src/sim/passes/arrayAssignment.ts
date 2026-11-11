// KIELER's Array Assignment processor (sccharts/processors/ArrayAssignment.xtend): `a = {e0, e1, ...}` becomes
// `a[0] = e0; a[1] = e1; ...`, executed in index order (basics.md B-28), with KIELER's cardinality checks.

import type { Pass, PassContext } from './context'
import { allActionSites, copyExpr, copyRef, lit, walkExpr, type CEffect, type CExpr, type CRef } from '../model'
import { printExpr } from '../model'

export const arrayAssignment: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.arrayAssignment',
    name: 'Array Assignment',
    owner: 'core',
    run(ctx: PassContext) {
        for (const site of allActionSites(ctx.root)) {
            const holder = site.transition ?? site.action!
            let again = true
            while (again) {
                again = false
                const out: CEffect[] = []
                for (const f of holder.effects) {
                    if (f.k !== 'assign' || !f.expr || !containsVector(f.expr)) {
                        out.push(f)
                        continue
                    }
                    const expr = computeVectorValues(f.expr)
                    const asm = { ...f, expr }
                    validate(asm, ctx)
                    const target = lowermost(asm.ref)
                    if (target.v.dims.length > 0 && expr.k === 'vector') {
                        expr.values.forEach((v, i) => {
                            if (v.k === 'vector') again = true
                            const r = copyRef(asm.ref)
                            const low = lowermost(r)
                            low.idx = [...target.idx.map(x => copyExpr(x)), lit(i)]
                            out.push({ ...asm, ref: r, expr: v, o: { ...asm.o } })
                        })
                    } else {
                        out.push(asm)
                    }
                }
                holder.effects = out
            }
        }
    },
}

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

function containsVector(e: CExpr): boolean {
    let found = false
    walkExpr(e, x => { if (x.k === 'vector') found = true })
    return found
}

function computeVectorValues(e: CExpr): CExpr {
    if (e.k === 'vector') {
        if (e.range) {
            const [a, b] = [e.values[0], e.values[e.values.length - 1]]
            const start = a?.k === 'lit' ? (a.v as number) : 0
            const end = b?.k === 'lit' ? (b.v as number) : -1
            const values: CExpr[] = []
            for (let i = start; i <= end; i++) values.push(lit(i))
            return { k: 'vector', values, span: e.span }
        }
        return { ...e, values: e.values.map(computeVectorValues) }
    }
    if (e.k !== 'op') return e
    const args = e.args.map(computeVectorValues)
    const vectors = args.filter(a => a.k === 'vector')
    if (vectors.length) {
        if (e.op === '+') {
            const values: CExpr[] = []
            for (const a of args) {
                if (a.k === 'vector') values.push(...a.values)
                else values.push(a)
            }
            return { k: 'vector', values, span: e.span }
        }
        if (e.op === '*') {
            if (vectors.length !== 1 || args.length !== 2) return { ...e, args }
            const vector = vectors[0] as Extract<CExpr, { k: 'vector' }>
            const n = args.find(a => a.k !== 'vector')!
            if (n.k === 'lit' && n.t === 'int') {
                const values: CExpr[] = []
                for (let i = 0; i < (n.v as number); i++) for (const v of vector.values) values.push(copyExpr(v))
                return { k: 'vector', values, span: e.span }
            }
        }
    }
    return { ...e, args }
}

function validate(asm: Extract<CEffect, { k: 'assign' }>, ctx: PassContext) {
    const target = lowermost(asm.ref)
    const v = target.v
    const name = printExpr(target)
    const error = (message: string) => ctx.report({
        severity: 'error', code: 'cardinality', span: asm.o.span, message, kieler: message,
        hint: 'A vector may be shorter than the array (the rest keeps its value) but not longer, and must have the array\'s shape.',
        related: asm.o.by ? [asm.o.by] : undefined,
    })
    const expr = asm.expr!
    if (v.dims.length && expr.k !== 'vector' && expr.k !== 'ref') {
        if (target.idx.length !== v.dims.length) {
            error(`Cardinalities do not match. ${name} is an array of dimension ${v.dims.length - target.idx.length} but only a single value is given.`)
        }
    }
    if (v.dims.length && expr.k === 'vector') {
        const rest = v.dims.slice(target.idx.length)
        if (!rest.length) error(`Cardinalities do not match. ${name} is not an array but a vector of size ${expr.values.length} is given.`)
        let depth = 0
        for (const card of rest) {
            if (card.k === 'lit' && typeof card.v === 'number') {
                let expressions: CExpr[] = [expr]
                for (let d = 0; d < depth; d++) {
                    const deeper: CExpr[] = []
                    for (const e of expressions) {
                        if (e.k === 'vector') deeper.push(...e.values)
                        else if (e.k !== 'ref') error(`Cardinalities do not match. ${name} at dimension ${d} is an array of size ${card.v} but only a single value is given.`)
                    }
                    expressions = deeper
                }
                for (const e of expressions) {
                    if (e.k === 'vector') {
                        if (e.values.length > card.v) error(`Cardinalities do not match. ${name} at dimension ${depth} is an array of size ${card.v} but a vector of size ${e.values.length} is given.`)
                    } else if (e.k !== 'ref') {
                        error(`Cardinalities do not match. ${name} at dimension ${depth} is an array of size ${card.v} but only a single value is given.`)
                    }
                }
            }
            depth++
        }
    }
}

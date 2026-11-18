// Parameter spreading (KIELER's Reference.xtend handleSCChartsDatatype, "Detect parameter spreading" and "Spread
// parameter"; structure.md S-18b): a vector bound to a scalar `input const` of an array of instances gives every
// instance its own value, `ref Cell c[2]({3, 8})`.
//
// KIELER does not put such a binding on its replacement stack. The constant becomes an ordinary public variable of
// the class it makes of the chart, and then one of two things:
// - something in the class names it (a method of the chart, a field's initial value): it stays a field, and an entry
//   action of the declaring state assigns every element its value (`c[0].k = 3; c[1].k = 8`). The chart's regions
//   and actions read the field. Until that entry action runs the field is 0, also in the initial values that read it.
// - nothing in the class names it: the field is removed, and the copy of the chart's regions and actions that KIELER
//   makes for element i has the i-th value in its place.
// A class inside the chart that names the constant gets a field of its own (`<Class>_<name>`): not simulated.

import type { Diagnostic } from '../../types'
import { copyExpr, type CExpr, type CState, type CVar } from '../model'
import { foldConstants } from '../fold'
import { rewriteScope, rewriteVar } from './rewrite'

/** A spread binding of one copy of the chart: the copy's formal and the vector. */
export interface SpreadBinding {
    formal: CVar
    vector: Extract<CExpr, { k: 'vector' }>
}

/** KIELER's test: an array of instances with one dimension, a scalar `input const`, a vector. */
export function isSpread(instance: CVar, formal: CVar | undefined, actual: CExpr): actual is Extract<CExpr, { k: 'vector' }> {
    return instance.dims.length === 1 && !!formal && formal.const && formal.input && !formal.dims.length && actual.k === 'vector'
}

/** The values of a spread vector, one per instance, or what KIELER refuses about it. */
function spreadValues(s: SpreadBinding, size: number, instance: CVar, report: (d: Diagnostic) => void): CExpr[] | undefined {
    const name = s.formal.name
    const fail = (message: string, kieler: string, hint: string): undefined => {
        report({ severity: 'error', code: 'spread-binding', span: s.vector.span ?? instance.span, related: instance.decl ? [instance.decl] : undefined, message, kieler, hint })
        return undefined
    }
    let values = s.vector.values
    if (s.vector.range) {
        // `{0 to 3}`: the numbers from the first up to, not including, the second.
        if (s.formal.type !== 'int') {
            return fail(`\`${name}\` is not an int, so a range of numbers cannot be spread over the instances of \`${instance.name}\``,
                'Cannot spread vector range to non integer variable', 'Write the values one by one, `{a, b, ...}`.')
        }
        const [from, to] = values.map(e => foldConstants(copyExpr(e)))
        if (from?.k !== 'lit' || typeof from.v !== 'number' || to?.k !== 'lit' || typeof to.v !== 'number') {
            return fail(`The range bound to \`${name}\` must be written with numbers or constants`,
                to?.k === 'ref' ? 'End value of spread vector range must be a constant integer variable' : 'Unsupported expression type in vector range',
                'Write the range with numbers, such as `{0 to 3}`.')
        }
        values = []
        for (let i = from.v; i < to.v; i++) values.push({ k: 'lit', t: 'int', v: i })
    }
    if (values.length !== size) {
        return fail(`\`${instance.name}\` has ${size} instance${size === 1 ? '' : 's'}, but ${values.length} value${values.length === 1 ? ' is' : 's are'} bound to \`${name}\``,
            'Cannot spread vector with different size than target array',
            `A vector bound to the constant input \`${name}\` gives every instance one value: write ${size} of them${s.vector.range ? ' (a range `{a to b}` ends before `b`)' : ''}.`)
    }
    const variable = values.find(e => e.k === 'ref')
    if (variable?.k === 'ref') {
        return fail(`\`${variable.v.display ?? variable.v.name}\` is a variable, and \`${name}\` is a constant input: only values and constants can be bound to it`,
            'Cannot bind non-constant variable to constant input (via spread vector)',
            `Bind a number or a \`const\` to \`${name}\`, or make \`${name}\` an ordinary input and bind an array element to each instance.`)
    }
    return values
}

function names(vars: CVar[], formal: CVar): boolean {
    let found = false
    const read = (r: { v: CVar }): undefined => {
        if (r.v === formal) found = true
        return undefined
    }
    for (const v of vars) if (v !== formal) rewriteVar(v, { read, target: read })
    return found
}

/**
 * Applies the spread bindings of the copy `inst` made for element `x`. Returns the fields that stay with the class
 * and their values (the caller assigns them on entry, once the members are arrays).
 */
export function applySpreads(inst: CState, spreads: SpreadBinding[], x: number, size: number, instance: CVar, report: (d: Diagnostic) => void): { field: CVar; values: CExpr[] }[] {
    const kept: { field: CVar; values: CExpr[] }[] = []
    for (const s of spreads) {
        const values = spreadValues(s, size, instance, report)
        if (!values) continue
        const f = s.formal
        // (A code block of a transition or action is a method here and part of the regions in KIELER.)
        if (names(inst.decls.filter(l => l.member), f)) {
            report({
                severity: 'info', code: 'unsupported', span: s.vector.span ?? instance.span, related: instance.decl ? [instance.decl] : undefined,
                message: `The guide's simulator cannot give every instance of \`${instance.name}\` its own \`${f.name}\` inside a class of the chart yet`,
                hint: `A method or initial value of a class inside the chart names \`${f.name}\`, for which KIELER makes a copy of the constant in that class. The official KIELER tools can run this chart. Reading \`${f.name}\` in a method of the chart itself works here.`,
            })
        }
        if (names(inst.decls.filter(l => !l.member && !l.generated), f)) {
            kept.push({ field: f, values })
            continue
        }
        const value = values[x] ?? { k: 'lit', t: 'int', v: 0 }
        rewriteScope(inst, { read: r => (r.v === f && !r.sub ? { ...copyExpr(value), span: r.span } : undefined) })
        inst.decls.splice(inst.decls.indexOf(f), 1)
    }
    return kept
}

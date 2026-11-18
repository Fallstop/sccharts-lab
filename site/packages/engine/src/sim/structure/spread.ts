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
// - a class inside the chart names it (a method or an initial value of `class In { ... } q`): that class gets a field
//   of its own, `<the instance's class>_<name>` (`Cell1_k`), assigned on entry too. KIELER only does that for a
//   single object of the class.

import type { Diagnostic } from '../../types'
import { copyExpr, CVar, type CExpr, type CState } from '../model'
import { foldConstants } from '../fold'
import { GCC_FAILED } from '../codegen'
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
        // The end is a number or an int constant declared with a number (the grammar allows a name there, no more).
        if (s.vector.badEnd || from?.k !== 'lit' || typeof from.v !== 'number' || to?.k !== 'lit' || typeof to.v !== 'number') {
            return fail(`The range bound to \`${name}\` must end at a number or at an int constant declared with a number`,
                'End value of spread vector range must be a constant integer variable',
                'Write the range with numbers, such as `{0 to 3}`, or declare the end as `const int N = 3`.')
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
 * and their values (the caller assigns them on entry, once the members are arrays). `cls`: the class KIELER makes of
 * the instance; `objects`: how many objects the declaration of a class object declares.
 */
export function applySpreads(
    inst: CState, spreads: SpreadBinding[], x: number, size: number, instance: CVar, cls: string, objects: (v: CVar) => number, report: (d: Diagnostic) => void,
): { field: CVar; values: CExpr[] }[] {
    const kept: { field: CVar; values: CExpr[] }[] = []
    for (const s of spreads) {
        const values = spreadValues(s, size, instance, report)
        if (!values) continue
        const f = s.formal
        // The classes inside the chart whose methods or initial values name the constant: a copy of it in each.
        const users = inst.decls.filter(l => l.member && names([l], f))
        for (const owner of new Set(users.map(l => l.member!.of))) {
            const around: CVar[] = []
            for (let c: CVar | undefined = owner; c; c = c.member?.of) around.push(c)
            if (around.some(c => c.dims.length > 0 || objects(c) > 1)) {
                report({
                    severity: 'error', code: 'spread-binding', span: s.vector.span ?? instance.span, related: owner.decl ? [owner.decl] : undefined,
                    message: `\`${f.name}\` is spread over the instances of \`${instance.name}\` and named in the class of \`${owner.display ?? owner.name}\`, which has several objects: KIELER cannot compile that`,
                    kieler: 'NOT YET SUPPORTED',
                    hint: `KIELER copies the constant into a class inside the chart only when the class has a single object. Read \`${f.name}\` in a method of the chart itself and pass it on.`,
                })
                break
            }
            const name = `${cls}_${f.name}`
            // The copy has a fixed name: a member the class declares with it is a second member of that name in
            // KIELER's C struct, and a method makes its compiler look the copy up and find the method.
            const clash = inst.decls.find(l => l.member?.of === owner && l.member.name === name)
            if (clash) {
                const method = !!clash.method || clash.declKind === 'method'
                report({
                    severity: 'error', code: method ? 'kieler-crash' : 'spread-binding', span: clash.span ?? s.vector.span ?? instance.span, related: owner.decl ? [owner.decl] : undefined,
                    message: `KIELER copies \`${f.name}\`, which is spread over the instances of \`${instance.name}\`, into the class of \`${owner.display ?? owner.name}\` under the name \`${name}\`, which the class declares itself`,
                    kieler: method ? `java.lang.Exception: Valued Object not found! [${name}]` : `duplicate member \u2018${name}\u2019\n${GCC_FAILED}`,
                    hint: `Rename \`${name}\` in the class.`,
                })
                break
            }
            const mirror = new CVar(`${owner.name}.${name}`, f.type)
            mirror.member = { of: owner, name }
            mirror.display = `${owner.display ?? owner.name}.${name}`
            mirror.scope = f.scope
            mirror.span = f.span
            const mine = users.filter(l => l.member!.of === owner)
            const last = Math.max(...inst.decls.map((l, i) => (l.member?.of === owner ? i : -1)))
            inst.decls.splice(last + 1, 0, mirror)
            for (const l of mine) rewriteVar(l, { read: r => (r.v === f ? { ...r, v: mirror } : undefined) })
            kept.push({ field: mirror, values })
        }
        // (A code block of a transition or action is a method here and part of the regions in KIELER.)
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

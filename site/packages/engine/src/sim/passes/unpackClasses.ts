// Classes and structs (structure.md). KIELER's Unpack Classes processor only unpacks classes annotated @UnpackClass
// (their members become variables `<instance>_<member>` of the chart, or of the class around them); every other class
// stays a C struct whose methods are C functions. The simulator lowers an instance's members to variables and its
// methods to methods of the instance (lower.ts declareMembers), nested instances and arrays of instances too, and
// runs them as KIELER's C code does. Not simulated: host classes (their methods are C or Java code).

import type { Declaration } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { Pass, PassContext } from './context'
import { declsOf } from './detect'
import { GCC_FAILED } from '../codegen'

export const unpackClasses: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.unpackClasses',
    name: 'Unpack Classes',
    owner: 'structure',
    run(ctx: PassContext) {
        const index = ctx.shared.index as ModelIndex | undefined
        const checked = new Set<Declaration>()
        for (const v of declsOf(ctx.root)) {
            if (v.declKind !== 'class' && v.declKind !== 'struct') continue
            // KIELER's checks on the declaration (UnpackClasses, Signal): once per declaration.
            const d = v.decl ? index?.vos.get(v.decl)?.decl : undefined
            if (d && !checked.has(d)) {
                checked.add(d)
                const signal = (d.members ?? []).find(m => m.signal)
                if (signal) {
                    ctx.report({
                        severity: 'error', code: 'signal-member', span: signal.span, related: v.decl ? [v.decl] : undefined,
                        message: `A ${d.declKind} cannot have a signal as a member (${signal.valuedObjects[0]?.name ? `\`${signal.valuedObjects[0].name}\`` : 'a signal'})`,
                        kieler: 'Signals in class declarations not yet supported',
                        hint: `Make the member a variable (\`bool ${signal.valuedObjects[0]?.name ?? 'S'}\`), or declare the signal outside the ${d.declKind}.`,
                    })
                }
                unpackedArrays(ctx, d)
                if (d.annotations.some(a => a.name === 'UnpackClass') && d.valuedObjects.length > 1) {
                    ctx.report({
                        severity: 'error', code: 'unpack-instances', span: d.annotations.find(a => a.name === 'UnpackClass')!.span, related: v.decl ? [v.decl] : undefined,
                        message: `\`@UnpackClass\` needs exactly one instance, but ${d.className ? `\`${d.className}\`` : 'this class'} has ${d.valuedObjects.length} (${d.valuedObjects.map(x => `\`${x.name}\``).join(', ')})`,
                        kieler: 'Unpacking multiple instances of the same class is not yet supported.',
                        hint: 'Remove `@UnpackClass`, or declare one instance per class.',
                    })
                }
            }
            if (!v.tags.has('#host')) continue
            ctx.report({
                severity: 'info', code: 'unsupported', span: v.span, related: v.decl ? [v.decl] : undefined,
                message: `This chart uses the host class \`${v.name}\`, which cannot run in the browser`,
                hint: 'A host class is implemented in the C (or Java) code next to the chart, so it needs a compiler. The official KIELER tools run this chart.',
            })
            return
        }
    },
}

/**
 * @UnpackClass on an array of instances, at any depth: KIELER gives every member the instance's dimensions in front
 * of its own. It refuses a method, and a member with an initial value then has a value for one element assigned to
 * the whole array, which its C compiler rejects.
 */
function unpackedArrays(ctx: PassContext, d: Declaration, around = false) {
    const unpack = d.annotations.find(a => a.name === 'UnpackClass')
    // An unpacked class inside an unpacked array of instances is an array too: its members got the dimensions.
    const array = !!unpack && d.valuedObjects.length === 1 && (d.valuedObjects[0].cardinalities.length > 0 || around)
    if (unpack && array) {
        const name = d.valuedObjects[0].name
        const method = (d.members ?? []).find(m => m.declKind === 'method')
        if (method) {
            ctx.report({
                severity: 'error', code: 'unpack-array-method', span: unpack.span, related: [d.valuedObjects[0].id],
                message: `\`@UnpackClass\` cannot unpack \`${name}\`: it is an array of instances and its class has a method (\`${method.valuedObjects[0]?.name}\`)`,
                kieler: 'Unpacking an array instance of a class with methods is not yet supported.',
                hint: 'Remove `@UnpackClass`, or the method, or declare a single instance.',
            })
        }
        const initial = (d.members ?? []).filter(m => m.declKind === 'variable').flatMap(m => m.valuedObjects).find(vo => vo.initialValue)
        if (!method && initial) {
            ctx.report({
                severity: 'error', code: 'unpack-array-initial', span: initial.span, related: [initial.id],
                message: `\`${initial.name}\` has an initial value, which \`@UnpackClass\` on the array \`${name}\` cannot keep: KIELER's C code does not compile`,
                kieler: initial.initialValue?.kind === 'vector'
                    ? `Cardinalities do not match. ${name}_${initial.name} at dimension 1 is an array of size ${d.valuedObjects[0].cardinalities[0]?.kind === 'int' ? d.valuedObjects[0].cardinalities[0].value : '?'} but only a single value is given.`
                    : `assignment to expression with array type\n${GCC_FAILED}`,
                hint: `Unpacked, \`${initial.name}\` is the array \`${name}_${initial.name}\`, and KIELER assigns the one value to the whole array. Remove the initial value and set the elements in an entry action, or remove \`@UnpackClass\`.`,
            })
        }
    }
    for (const m of d.members ?? []) if (m.declKind === 'class' || m.declKind === 'struct') unpackedArrays(ctx, m, array)
}

// Classes and structs (structure.md). KIELER's Unpack Classes processor only unpacks classes annotated @UnpackClass
// (their members become variables `<instance>_<member>`); every other class stays a C struct whose methods are C
// functions. The simulator lowers an instance's members to variables and its methods to methods of the instance
// (lower.ts declareMembers), nested instances and arrays of instances too, and runs them as KIELER's C code does. Not
// simulated: host classes (their methods are C or Java code), and @UnpackClass on an array of instances or on a class
// with a class inside.

import type { Declaration } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { Pass, PassContext } from './context'
import { declsOf } from './detect'

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
                if (d.annotations.some(a => a.name === 'UnpackClass') && d.valuedObjects.length > 1) {
                    ctx.report({
                        severity: 'error', code: 'unpack-instances', span: d.annotations.find(a => a.name === 'UnpackClass')!.span, related: v.decl ? [v.decl] : undefined,
                        message: `\`@UnpackClass\` needs exactly one instance, but ${d.className ? `\`${d.className}\`` : 'this class'} has ${d.valuedObjects.length} (${d.valuedObjects.map(x => `\`${x.name}\``).join(', ')})`,
                        kieler: 'Unpacking multiple instances of the same class is not yet supported.',
                        hint: 'Remove `@UnpackClass`, or declare one instance per class.',
                    })
                }
            }
            const host = v.tags.has('#host')
            // Arrays of instances and classes inside classes are tagged only with @UnpackClass (lower.ts).
            const what = host ? undefined : v.tags.has('#array') ? `\`@UnpackClass\` on an array of ${v.declKind} instances (\`${v.name}\`)` : v.tags.has('#nested') ? `\`@UnpackClass\` on a ${v.declKind} with a ${v.declKind} inside (\`${v.name}\`)` : undefined
            if (!host && !what) continue
            ctx.report({
                severity: 'info', code: 'unsupported', span: v.span, related: v.decl ? [v.decl] : undefined,
                message: host ? `This chart uses the host class \`${v.name}\`, which cannot run in the browser` : `The guide's simulator cannot run ${what} yet`,
                hint: host
                    ? 'A host class is implemented in the C (or Java) code next to the chart, so it needs a compiler. The official KIELER tools run this chart.'
                    : 'The official KIELER tools run this chart.',
            })
            return
        }
    },
}

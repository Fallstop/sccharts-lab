// KIELER's Static processor (sccharts/processors/Static.xtend). Owner: the structure workstream. structure.md S-51,
// S-52.
//
// A `static` variable of a state moves to the root, renamed `<hierarchical name of the state>__<name>` (scope names
// from the root down, an unnamed region as `region<index>`, joined with `_`): it is initialised once, at the start,
// and keeps its value when its state is left and entered again; under its new name it is in KIELER's data pool.
// A `global` variable moves to the root too, merged by name with a root variable of that name (its declaration and
// initial value win; the global's uses are redirected). A global of the root itself finds itself as the existing
// variable and is removed, which crashes KIELER where it is used.

import type { Pass, PassContext } from './context'
import { addVar, allStates, isRegion, type CState, type CVar, type Scope } from '../model'
import { rewriteScope } from '../structure/rewrite'

export const staticPass: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.static',
    name: 'Static',
    owner: 'structure',
    run(ctx: PassContext) {
        const root = ctx.root
        for (const state of allStates(root)) {
            for (const v of state.decls.filter(x => x.static && !x.declKind)) {
                v.name = `${hierarchicalName(state, '_')}_${v.name}`
                v.static = false
                v.generated = false
                addVar(root, v)
            }
            for (const v of state.decls.filter(x => x.global && !x.declKind)) {
                const existing = root.decls.find(x => x.name === v.name)
                if (state === root) {
                    // The root's own global finds itself as the existing variable and is removed: only its uses break.
                    let used = false
                    const probe = (r: { v: CVar }) => { if (r.v === v) used = true; return undefined }
                    rewriteScope(root, { read: probe as never, target: probe as never })
                    if (!used) {
                        root.decls.splice(root.decls.indexOf(v), 1)
                        continue
                    }
                    ctx.report({
                        severity: 'error', code: 'kieler-crash', span: v.span, related: v.decl ? [v.decl] : undefined,
                        message: `KIELER cannot compile a global variable (\`${v.name}\`) in the simulated chart itself`,
                        kieler: 'java.lang.IllegalArgumentException: Can\'t copy valued object. Valued object is null!',
                        hint: `\`global\` shares a variable between the instances of a referenced chart. In the chart that runs, \`${v.name}\` is global already: remove the keyword.`,
                    })
                    continue
                }
                if (!existing) {
                    v.global = false
                    addVar(root, v)
                } else {
                    const redirect = (r: { k: 'ref'; v: CVar }) => (r.v === v ? { ...r, v: existing } : undefined)
                    rewriteScope(state, { read: redirect as never, target: redirect as never })
                    state.decls.splice(state.decls.indexOf(v), 1)
                }
            }
        }
    },
}

/** KIELER's getHierarchicalName(scope, descending): scope names from the root down, joined with `_`. */
export function hierarchicalName(scope: Scope, descending: string): string {
    let id = scope.name ?? ''
    if (scope.name === undefined && isRegion(scope)) id = `region${scope.parent.regions.indexOf(scope)}`
    const name = `${id}_${descending}`
    const parent: Scope | undefined = isRegion(scope) ? scope.parent : (scope as CState).parent
    return parent ? hierarchicalName(parent, name) : name
}

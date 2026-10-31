// KIELER's Initialization processor (sccharts/processors/Initialization.xtend): declarations' initial values
// become entry actions of their scope, inserted in front of the scope's other entry actions, in declaration
// order (basics.md B-5, B-6, concurrency.md H-3). Locals and outputs without an initial value get the type's
// default (implicit initialisation: not for inputs, not for generated names starting with `_`).

import type { Pass, PassContext } from './context'
import { allScopes, createEntryAction, initialState, isRegion, ref, type CExpr, type CVar, type Scope } from '../model'

export const initialization: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.initialization',
    name: 'Initialization',
    owner: 'core',
    run(ctx: PassContext) {
        for (const scope of allScopes(ctx.root)) {
            implicitInitialization(scope)
            transformInitialization(scope, ctx)
        }
    },
}

function defaultFor(v: CVar): CExpr | undefined {
    switch (v.type) {
        case 'bool': return { k: 'lit', t: 'bool', v: false }
        case 'int': return { k: 'lit', t: 'int', v: 0 }
        case 'float': return { k: 'lit', t: 'float', v: 0 }
        case 'string': return { k: 'null' }
        default: return undefined
    }
}

function implicitInitialization(scope: Scope) {
    for (const v of scope.decls) {
        if (v.input || v.declKind) continue
        if (v.init || v.name.startsWith('_')) continue
        const init = defaultFor(v)
        if (!init) continue
        let value: CExpr = init
        for (let i = v.dims.length - 1; i >= 0; i--) {
            const c = v.dims[i]
            const n = c.k === 'lit' && typeof c.v === 'number' ? c.v : 0
            const element = value
            value = { k: 'vector', values: Array.from({ length: n }, () => structuredCopy(element)) }
        }
        v.init = value
        v.tags.add('implicitInit')
    }
}

function structuredCopy(e: CExpr): CExpr {
    return e.k === 'vector' ? { ...e, values: e.values.map(structuredCopy) } : { ...e }
}

function transformInitialization(scope: Scope, _ctx: PassContext) {
    const inits = scope.decls.filter(v => v.init !== undefined && !v.declKind)
    for (const v of [...inits].reverse()) {
        const effect = {
            k: 'assign' as const, ref: ref(v), op: '=' as const, expr: v.init,
            o: { by: v.decl, init: v.decl, span: v.span, hidden: v.generated },
        }
        if (isRegion(scope)) {
            const initial = initialState(scope)
            if (!initial) continue
            createEntryAction(initial, 0).effects.push(effect)
        } else {
            createEntryAction(scope, 0).effects.push(effect)
        }
    }
    for (const v of inits) v.init = undefined
}

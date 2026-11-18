// How KIELER initialises class objects (sccharts/processors/Initialization.xtend), for the classes of the chart and
// the classes it makes of chart instances (`ref C g`); structure.md S-60a.
//
// A class with a variable or an object inside gets a method `_init`: one assignment per variable with an initial
// value (every variable has one after the implicit initialisation, except those whose name starts with `_`), and one
// call of the `_init` of every class object inside. The declaring scope's entry action calls it: once for a single
// object, once per element for an array, and not at all for an array of one element or none (createAllIndices only
// lists the indices of more than one element). Two consequences:
// - the members of an array of one object are never initialised: they start at 0 and keep their values when the
//   state is entered again (neverInitialised);
// - an `_init` without statements is called but never generated, and gcc fails on KIELER's code (emptyInits): a class
//   whose only content is an object without variables, an array of one object, or a variable called `_x`.
// A struct is initialised from outside, member by member, so neither applies to it or to what is inside it.

import type { Diagnostic } from '../../types'
import { copyExpr, isRegion, type CVar, type Scope } from '../model'
import { foldConstants } from '../fold'
import { chartInstancesOf, type ChartInstance } from './poolShape'

/** The number of elements of an object's own dimensions (1 for a single object), and whether it is an array. */
function ownElements(v: CVar): { array: boolean; count: number } {
    const own = v.dims.slice(v.member ? v.member.of.dims.length : 0)
    let count = 1
    for (const d of own) {
        const n = foldConstants(copyExpr(d))
        count *= n.k === 'lit' && typeof n.v === 'number' ? n.v : 2
    }
    return { array: own.length > 0, count }
}

/** KIELER calls the object's `_init`: a single object, or an array of more than one. */
const initCalled = (v: CVar): boolean => {
    const { array, count } = ownElements(v)
    return !array || count > 1
}

/** A member of a class object that KIELER never initialises (see above). */
export function neverInitialised(v: CVar): boolean {
    const chain: CVar[] = []
    for (let c = v.member?.of; c; c = c.member?.of) chain.unshift(c)
    for (const c of chain) {
        if (c.declKind === 'struct') return false
        if (!initCalled(c)) return true
    }
    return false
}

const isObject = (v: CVar) => v.declKind === 'class' || v.declKind === 'struct'
const isField = (v: CVar) => !v.declKind && !v.const && !v.tags.has('#const-member')
const hasDefault = (v: CVar) => v.type === 'bool' || v.type === 'int' || v.type === 'float' || v.type === 'string'

/**
 * The class objects whose `_init` KIELER calls although it has no statement. `className`: the class of an object as
 * KIELER names it. Call before the initial values are turned into entry actions.
 */
export function emptyInits(scope: Scope, root: string, className: (v: CVar) => string | undefined): Diagnostic[] {
    const state = isRegion(scope) ? scope.parent : scope
    const charts = new Map<CVar, ChartInstance>()
    const register = (c: ChartInstance) => {
        charts.set(c.v, c)
        c.inside.forEach(register)
    }
    chartInstancesOf(state).forEach(register)
    const members = (inst: CVar) => state.decls.filter(v => v.member?.of === inst)
    const objects = (inst: CVar): CVar[] => [...members(inst).filter(isObject), ...(charts.get(inst)?.inside ?? []).filter(c => c.declared).map(c => c.v)]
    /** The class has a variable or an object: KIELER makes its `_init`. */
    const hasVariables = (inst: CVar): boolean => members(inst).some(isField) || objects(inst).length > 0
    const initialised = (v: CVar) => v.init !== undefined || (hasDefault(v) && !v.member!.name.startsWith('_'))
    const statements = (inst: CVar): boolean => {
        if (members(inst).some(v => isField(v) && initialised(v))) return true
        return objects(inst).some(o => {
            if (o.tags.has('#host')) return false
            // A struct's members are assigned one by one, two levels deep.
            if (o.declKind === 'struct') return [...members(o), ...members(o).filter(isObject).flatMap(members)].some(v => isField(v) && initialised(v))
            return hasVariables(o) && initCalled(o)
        })
    }
    const out: Diagnostic[] = []
    const check = (inst: CVar, path: string[]) => {
        if (inst.declKind === 'struct' || inst.tags.has('#host') || !hasVariables(inst)) return
        const here = [...path, className(inst) ?? inst.name]
        if (!statements(inst)) {
            const type = here.length > 1 ? `${root}_${here.join('_')}` : here[0]
            const name = inst.display ?? (inst.member ? inst.member.name : inst.name)
            out.push({
                severity: 'error', code: 'empty-class-init', span: inst.span, related: inst.decl ? [inst.decl] : undefined,
                message: `KIELER's C code does not compile: the object \`${name}\` has nothing to initialise, and KIELER calls an initialisation function for it that it never writes`,
                kieler: `implicit declaration of function ‘${root}_${type}__init’ [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)`,
                hint: `KIELER initialises a class that holds another object or a variable, and its code fails when there is no value to set: the class holds only objects without variables, an array of one object, or variables whose names start with \`_\`. Give the class of \`${name}\` a variable of its own (\`int used\`).`,
            })
            return
        }
        for (const o of objects(inst)) if (initCalled(o)) check(o, here)
    }
    const top = scope === state ? chartInstancesOf(state).filter(c => c.declared).map(c => c.v) : []
    for (const v of [...scope.decls.filter(v => v.declKind === 'class' && !v.member), ...top]) if (initCalled(v)) check(v, [])
    return out
}

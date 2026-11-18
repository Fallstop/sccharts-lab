// Generic parameters and their arguments, as KIELER checks them (structure.md S-73):
// SCChartsReferenceExtensions.createGenericParameterBindings and SCChartsTypeExtensions.checkForSubtypeProblem.
// Used by the validation (references and `ref` declarations of every chart of the file) and by the Inheritance
// pass (`extends Base<...>`, which KIELER only checks when it compiles the chart).

import type { Declaration, Expression, GenericArgument, GenericParameterDeclaration, Region, ScopeParameter, State, ValuedObject } from '../types'
import { genericKind, type ModelIndex, type VOEntry } from './resolve'

/** A declaration id as name resolution knows it: the id inside a copy of a chart is `<instance>/<id>`. */
export function sourceId(id: string): string {
    const i = id.lastIndexOf('/')
    return i < 0 ? id : id.slice(i + 1)
}

export function entryOf(index: ModelIndex, id: string | undefined): VOEntry | undefined {
    return id === undefined ? undefined : index.vos.get(id) ?? index.vos.get(sourceId(id))
}

export function chartNamed(index: ModelIndex, name: string | undefined): State | undefined {
    return name === undefined ? undefined : index.charts.find(c => c.name === name)
}

/** KIELER's getAllInheritedStates: every base, transitively, each once. */
export function allInheritedStates(state: State, index: ModelIndex): State[] {
    const direct = (s: State) => (s.baseStates ?? []).map(b => chartNamed(index, b.target)).filter((x): x is State => !!x)
    const out: State[] = []
    const work = direct(state).filter(s => s !== state)
    while (work.length) {
        const s = work.shift()!
        if (out.includes(s)) continue
        out.push(s)
        for (const b of [...direct(s)].reverse()) if (b !== state && !out.includes(b) && !work.includes(b)) work.unshift(b)
    }
    return out
}

const isPrivate = (d: Declaration) => d.access === 'private'

/**
 * KIELER's getAllVisibleInheritedRegions: the regions of the base charts (depth first), without those an
 * `override region` of a chart further down (or of the chart itself) hides.
 */
export function visibleInheritedRegions(chart: State, find: (name: string) => State | undefined): { base: State; region: Region }[] {
    const out: { base: State; region: Region }[] = []
    const visit = (s: State, hidden: Set<string>, path: State[]) => {
        if (s !== chart) {
            for (const r of s.regions) if (!r.name || !hidden.has(r.name)) out.push({ base: s, region: r })
        }
        const next = new Set(hidden)
        for (const r of s.regions) if (r.name && r.override) next.add(r.name)
        for (const b of s.baseStates ?? []) {
            const target = find(b.target)
            if (target && !path.includes(target)) visit(target, next, [...path, target])
        }
    }
    visit(chart, new Set(), [chart])
    return out.filter((x, i) => out.findIndex(y => y.region === x.region) === i)
}

/** KIELER's getAllInheritedStateReferencesHierachically: the state's own base references, then theirs, level by level. */
export function inheritedReferences(state: State, index: ModelIndex): { ref: NonNullable<State['baseStates']>[number]; holder: State; target: State }[] {
    const out: { ref: NonNullable<State['baseStates']>[number]; holder: State; target: State }[] = []
    const add = (holder: State) => {
        const added: typeof out = []
        for (const ref of holder.baseStates ?? []) {
            const target = chartNamed(index, ref.target)
            if (!target || target === state || out.some(x => x.ref === ref)) continue
            const entry = { ref, holder, target }
            out.push(entry)
            added.push(entry)
        }
        return added
    }
    const work = add(state)
    while (work.length) work.push(...add(work.shift()!.target))
    return out
}

/**
 * The interface a reference binds (KIELER's createBindings targetVOs): the chart's own inputs and outputs in
 * declaration order, then the visible inherited ones that the base references on the way do not bind themselves.
 */
export function interfaceOf(target: State, index: ModelIndex, path: State[] = []): ValuedObject[] {
    const out: ValuedObject[] = []
    for (const d of target.declarations) if (d.input || d.output) out.push(...d.valuedObjects)
    const bound = new Set<ValuedObject>()
    const around = [...path, target]
    for (const { ref, target: base } of inheritedReferences(target, index)) {
        // A cycle of base charts (rejected as an inconsistent hierarchy): the chart's interface is not asked again.
        if (!ref.parameters.length || around.includes(base)) continue
        for (const b of positionalBindings(interfaceOf(base, index, around), ref.parameters)) if (b.target && !b.error) bound.add(b.target)
    }
    for (const base of allInheritedStates(target, index)) {
        for (const d of base.declarations) if ((d.input || d.output) && !isPrivate(d)) for (const vo of d.valuedObjects) if (!bound.has(vo)) out.push(vo)
    }
    return out
}

/** The explicit and positional bindings of a parameter list (the binding pointer of structure.md S-6). */
export function positionalBindings(targets: ValuedObject[], parameters: ScopeParameter[]): { parameter: ScopeParameter; target?: ValuedObject; error?: boolean }[] {
    const out: { parameter: ScopeParameter; target?: ValuedObject; error?: boolean }[] = []
    let ptr = 0
    for (const parameter of parameters) {
        if (parameter.binding !== undefined) {
            const i = targets.findIndex(v => v.name === parameter.binding)
            if (i < 0) {
                out.push({ parameter, error: true })
                continue
            }
            ptr = i
        }
        if (ptr > targets.length - 1) {
            out.push({ parameter, error: true })
            continue
        }
        out.push({ parameter, target: targets[ptr] })
        ptr++
    }
    return out
}

/** `literal` names of KIELER's ValueType, as its messages print them. */
function literalType(e: Expression): string {
    switch (e.kind) {
        case 'bool': return 'bool'
        case 'int': return 'int'
        case 'float': return 'float'
        // A string literal has no value type in KIELER (StringValue.getValueType is not implemented).
        default: return 'UNKNOWN'
    }
}

const VALUE_CLASS: Record<string, string> = { bool: 'BoolValueImpl', int: 'IntValueImpl', float: 'FloatValueImpl', string: 'StringValueImpl' }

/** The class KIELER names for an argument in its messages. */
function argumentClass(arg: GenericArgument): string {
    if (arg.valueType) return 'ValueTypeReferenceImpl'
    if (arg.expression) return arg.expression.kind === 'ref' ? 'ValuedObjectReferenceImpl' : VALUE_CLASS[arg.expression.kind] ?? 'ValueImpl'
    return 'GenericTypeReferenceImpl'
}

const PRIMITIVES = ['int', 'float', 'bool', 'pure']

/** The declaration type KIELER prints for a variable (`VariableDeclaration.type.literal`). */
function declaredType(entry: VOEntry | undefined): string | undefined {
    if (entry?.generic) return entry.generic.valueType === 'primitive' ? 'primitive' : entry.generic.valueType ?? 'unknown'
    const d = entry?.decl
    if (!d) return undefined
    if (d.declKind === 'variable') return d.type ?? 'pure'
    if (d.declKind === 'class' || d.declKind === 'struct') return d.declKind
    if (d.declKind === 'enum') return 'enum'
    return undefined
}

/**
 * KIELER's checkForSubtypeProblem(GenericParameterDeclaration, Expression): why an argument does not fit a generic
 * parameter, or undefined.
 */
export function subtypeProblem(decl: GenericParameterDeclaration, arg: GenericArgument, index: ModelIndex): string | undefined {
    const name = decl.valuedObject.name
    const kind = genericKind(decl)
    const reference = arg.expression?.kind === 'ref' ? arg.expression : undefined
    const referenced = reference ? entryOf(index, reference.decl) : undefined
    /** The chart a generic parameter used as an argument stands for (its declared type). */
    const parameterChart = (entry: VOEntry | undefined) => chartNamed(index, entry?.generic?.typeName)
    if (kind === 'type') {
        const type = chartNamed(index, decl.typeName)
        // Without a chart to be a subtype of (no `is`, or a name that is no chart), anything goes.
        if (!type) return undefined
        let given: State | undefined
        if (arg.typeName !== undefined) given = chartNamed(index, arg.typeName)
        else if (reference) {
            if (referenced?.generic) given = parameterChart(referenced)
            else return `Type mismatch! Generic parameter ${name} cannot take a reference that is not a type.`
        } else return `Type mismatch! Generic parameter ${name} can only take a state type as parameter.`
        if (!given) return `Cannot infer state type from given parameter for ${name}.`
        if (given !== type && !allInheritedStates(given, index).includes(type)) return `State ${given.name} in generic parameter for ${name} in not a subtype of ${type.name}.`
        // The interfaces must match too: the subtype may not add inputs or outputs (KIELER's format drops the names).
        const io = (s: State) => [s, ...allInheritedStates(s, index)].flatMap(x => x.declarations).filter(d => d.declKind === 'variable' && (d.input || d.output)).flatMap(d => d.valuedObjects)
        const base = new Set(io(type))
        if (io(given).some(vo => !base.has(vo))) {
            return `State ${given.name} in generic parameter for ${name} in not a valid subtype of ${type.name}. There are interface incompatibilities due to the following variables: `
        }
        return undefined
    }
    if (kind === 'reference') {
        const type = chartNamed(index, decl.typeName)
        if (!type) return `Invalid generic type declaration of ${name}! Base type ${decl.typeName} is not a state.`
        const wrong = `Type mismatch! Generic parameter ${name} can only take a variable of a reference declaration as parameter.`
        if (!reference) return wrong
        let given: State | undefined
        if (referenced?.generic) given = parameterChart(referenced)
        else if (referenced?.decl?.declKind === 'reference' && !referenced.decl.extern) {
            const target = index.refTargets.get(referenced.decl)
            given = target?.kind === 'state' ? target : undefined
        } else return wrong
        if (!given) return `Cannot infer state type from given parameter for ${name}.`
        // The instance's chart must be the parameter's chart or extend it.
        if (given !== type && !allInheritedStates(given, index).includes(type)) {
            return `State ${given.name} in the given reference declaration in generic parameter for ${name} in not a subtype of ${type.name}.`
        }
        return undefined
    }
    if (kind === 'primitive') {
        if (!arg.valueType) return `Generic parameter ${name} with primitive type restriction must be bound to a concrete primitive type, not ${argumentClass(arg)}.`
        if (!PRIMITIVES.includes(arg.valueType)) return `Type mismatch! Generic parameter ${name} of type primitive cannot accept type ${arg.valueType}.`
        return undefined
    }
    // A value parameter: a literal or a variable of the declared type.
    const type = decl.valueType as string
    if (arg.expression && arg.expression.kind !== 'ref') {
        const given = literalType(arg.expression)
        return given === type ? undefined : `Type mismatch! Generic parameter ${name} of type ${type} cannot take literal of type ${given}.`
    }
    if (reference) {
        const given = declaredType(referenced)
        return given === type ? undefined : `Type mismatch! Generic parameter ${name} of type ${type} cannot take valued object declared with type ${given ?? 'null'}.`
    }
    return `Expressions as generic parameters are currently not allowed (${argumentClass(arg)}).`
}

export interface GenericBinding {
    declaration?: GenericParameterDeclaration
    argument?: GenericArgument
    /** A type (KIELER's GENERIC_TYPE) or a value or instance (GENERIC_PARAM). */
    type: boolean
    errors: string[]
}

/** KIELER's createGenericParameterBindings: declarations and arguments by position. */
export function genericBindings(decls: GenericParameterDeclaration[], args: GenericArgument[], index: ModelIndex): GenericBinding[] {
    const out: GenericBinding[] = []
    for (let i = 0; i < Math.max(decls.length, args.length); i++) {
        const declaration = decls[i]
        const argument = args[i]
        const kind = declaration ? genericKind(declaration) : undefined
        const binding: GenericBinding = { declaration, argument, type: !declaration || kind === 'type' || kind === 'primitive', errors: [] }
        if (!argument) binding.errors.push(`There is no parameter given for generic parameter declaration of ${declaration.valuedObject.name}.`)
        else if (!declaration) binding.errors.push(`There is no declaration for the given generic parameter (position: ${i}).`)
        else {
            const problem = subtypeProblem(declaration, argument, index)
            if (problem) binding.errors.push(problem)
        }
        out.push(binding)
    }
    return out
}

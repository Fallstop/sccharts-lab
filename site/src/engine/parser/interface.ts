// The variables of a chart as the simulator and the widgets show them (VariableInfo), with constant values
// evaluated where the source allows it (literals, negated numbers, vectors and references to constants).

import type { Declaration, Expression, State, Value, VariableInfo } from '../types'
import type { ModelIndex } from './resolve'

/**
 * Inputs, outputs and local variables and signals declared at the top of a chart, in declaration order, with their
 * types as declared (compile() reports a clock with KIELER's simulation type instead: float, or int with
 * @IntegerClockType). Methods, classes, enums, references (`ref`, except of enums: ints), extern declarations and schedules are not included.
 */
export function extractInterface(chart: State, index?: ModelIndex): VariableInfo[] {
    const out: VariableInfo[] = []
    for (const d of chart.declarations) {
        // `ref E x` of an enum E is an int (KIELER's Enum processor; host enums keep C's type and are left out).
        const target = d.declKind === 'reference' ? index?.refTargets.get(d) : undefined
        const enumRef = !!target && target.kind === 'declaration' && target.declKind === 'enum' && !target.host
        if (d.declKind !== 'variable' && !enumRef) continue
        for (const vo of d.valuedObjects) {
            const type = enumRef ? 'int' : d.type ?? 'pure'
            const info: VariableInfo = {
                name: vo.name,
                id: vo.id,
                type,
                signal: d.signal,
                valued: d.signal && type !== 'pure',
                input: d.input,
                output: d.output,
                const: d.const,
                dims: vo.cardinalities.map(c => {
                    const v = constantValue(c, index)
                    return typeof v === 'number' ? v : -1
                }),
            }
            if (vo.combine) info.combine = vo.combine
            if (vo.initialValue) {
                const v = constantValue(vo.initialValue, index)
                if (v !== undefined) info.initialValue = v
            }
            out.push(info)
        }
    }
    return out
}

/** Value of a constant expression, or undefined when it is not constant (or not computable from the source). */
export function constantValue(e: Expression, index?: ModelIndex, depth = 0): Value | undefined {
    if (depth > 20) return undefined
    switch (e.kind) {
        case 'bool': case 'int': case 'float': case 'string': return e.value
        case 'null': return null
        case 'vector': {
            if (e.range) return undefined
            const values: Value[] = []
            for (const v of e.values) {
                const c = constantValue(v, index, depth + 1)
                if (c === undefined) return undefined
                values.push(c)
            }
            return values
        }
        case 'op': {
            if (e.op === 'neg' && e.args.length === 1) {
                const v = constantValue(e.args[0], index, depth + 1)
                return typeof v === 'number' ? -v : undefined
            }
            return undefined
        }
        case 'ref': {
            // An enum value: its position in the enum.
            if (index && e.decl && e.sub?.decl) {
                const en = index.vos.get(e.decl)?.decl
                if (en?.declKind === 'enum' && !en.host) {
                    const i = (en.members?.[0]?.valuedObjects ?? []).findIndex(vo => vo.id === e.sub!.decl)
                    return i < 0 ? undefined : i
                }
            }
            if (!index || !e.decl || e.indices.length || e.sub) return undefined
            const entry = index.vos.get(e.decl)
            const d: Declaration | undefined = entry?.decl
            if (!d || d.declKind !== 'variable' || !d.const || !entry!.vo.initialValue) return undefined
            return constantValue(entry!.vo.initialValue, index, depth + 1)
        }
        default: return undefined
    }
}

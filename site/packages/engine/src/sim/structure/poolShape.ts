// Which class objects are in KIELER's data pool, and in what shape (structure.md S-60). The simulator (exec.ts), the
// C generator (codegen/layout.ts) and @sccharts-lab/trace read it from here.
//
// A chart instance (`ref C g`) is a class to KIELER after its Reference processor (handleSCChartsDatatype): the
// chart's declarations are the class's, and a class without any declaration is removed there, wherever it is. Much
// later the Methods processor removes the methods it copied into place and the ones nobody calls, and then the
// classes left without a declaration, but only those at the top of the chart: a class inside another class stays
// as an empty object. So:
//
// - an instance of a chart that declares nothing (and binds every input and output) is nowhere;
// - at the top of the chart, an instance is an object while its class has something left: a field, a method that is
//   still a C function and is called, or an instance of a class inside it (constants and schedules are gone by then);
// - inside another instance, every instance whose chart declares anything is an object, `{}` without fields;
// - an array of instances is an array of such objects, `[]` for an array without elements.

import { copyExpr, type CState, type CVar } from '../model'
import { foldConstants } from '../fold'

/** A chart instance after the Reference pass (passes/reference.ts keeps the ones of a state in `ext.chartInstances`). */
export interface ChartInstance {
    v: CVar
    /** KIELER keeps a class for it: its chart declares something. */
    declared: boolean
    /** The chart's methods: the class's. */
    methods: CVar[]
    /** The chart instances declared at the top of its chart: classes inside the class. */
    inside: ChartInstance[]
}

/** A member of a chart instance that its chart declares (not one of the compiler's helpers inside the instance). */
export const DECLARED_MEMBER = '#declared-member'

/** An object of the pool: the way to it (`m`, `c` for `m.c`), each step with the sizes of its own dimensions. */
export interface PoolObject {
    path: { key: string; sizes: number[] }[]
    v: CVar
}

export function chartInstancesOf(state: CState): ChartInstance[] {
    return (state.ext.chartInstances ??= []) as ChartInstance[]
}

/** The sizes of an instance's own dimensions (a member has those of the instances around it in front). */
function ownSizes(v: CVar): number[] {
    const outer = v.member ? v.member.of.dims.length : 0
    return v.dims.slice(outer).map(d => {
        const n = foldConstants(copyExpr(d))
        return n.k === 'lit' && typeof n.v === 'number' ? n.v : 0
    })
}

/** `functions`: the methods KIELER keeps as C functions (structure/methods.ts inlineMethods). */
export function poolObjects(root: CState, functions: ReadonlySet<CVar>): PoolObject[] {
    const charts = new Map<CVar, ChartInstance>()
    const register = (c: ChartInstance) => {
        charts.set(c.v, c)
        c.inside.forEach(register)
    }
    const top = chartInstancesOf(root)
    top.forEach(register)
    const membersOf = (inst: CVar) => root.decls.filter(v => v.member?.of === inst)
    const object = (v: CVar) => (v.declKind === 'class' || v.declKind === 'struct') && !v.tags.has('#host')
    /** The instances inside an instance that KIELER has a class for. */
    const inside = (inst: CVar): CVar[] => [
        ...membersOf(inst).filter(object),
        ...(charts.get(inst)?.inside ?? []).filter(c => c.declared).map(c => c.v),
    ]
    const content = (inst: CVar): boolean => {
        const members = membersOf(inst)
        if (members.some(v => !v.declKind && !v.const && !v.tags.has('#const-member'))) return true
        if (inside(inst).length) return true
        return (charts.get(inst)?.methods ?? members.filter(v => v.method)).some(m => functions.has(m))
    }
    const out: PoolObject[] = []
    const emit = (inst: CVar, path: PoolObject['path']) => {
        const here = [...path, { key: path.length ? inst.member!.name : inst.name, sizes: ownSizes(inst) }]
        out.push({ path: here, v: inst })
        for (const n of inside(inst)) emit(n, here)
    }
    for (const v of root.decls) if (object(v) && !v.member && content(v)) emit(v, [])
    for (const c of top) if (c.declared && content(c.v)) emit(c.v, [])
    return out
}

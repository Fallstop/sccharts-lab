// KIELER's Dataflow processor, classic mode (sccharts/processors/dataflow/Dataflow.xtend, processDataflowRegionClassic),
// called by the Reference processor. structure.md S-25 .. S-34.
//
// A dataflow region becomes a control-flow region `__df_<name>` of its state with one state `__df_main`. Every
// equation becomes a region of `__df_main`: `__df_<k>` -immediate/ x = e-> `__df_d<k>` -delayed-> `__df_<k>`, so it
// is evaluated in every tick, the entry tick included, concurrently with the others (`once`: `__df_d<k>` is final and
// `__df_main` joins a final `__df_done`). Every chart instance used in the equations (`ref C g`) gets a region
// before them: `__df_<i> is C(...)` -join-> `__df_d<i>` -delayed-> `__df_<i>` (a terminated instance restarts one
// tick later, S-34), bound to fresh locals `__df_g_X` for C's inputs and outputs, which `g.X` in the equations
// becomes. A tuple `g = {a, _, c}` sets C's inputs in declaration order (`_` skips one); a vector assigned to an
// array sets its elements. Equations ending with `;` (or `seq`) and the one after them form a sequence: their regions
// get one schedule (KIELER's `schedule seq<n>` with increasing priorities), so they run in written order (S-27).

import type { State } from '../../types'
import type { CEquation } from '../lower'
import {
    CVar, createAction, createControlflowRegion, createState, createTransitionTo, ref, type CArg, type CExpr, type CRef,
    type CRegion, type CState,
} from '../model'
import type { Expansion, ReferenceCall } from './reference'

const PREFIX = '__df_'

/** A schedule group of sequential equations (KIELER's schedule object) and an equation region's priority in it. */
export interface Schedule {
    group: object
    priority: number
    /** For the log: the equations' region names. */
    name: string
}

/** Processes every dataflow region inside `state` (KIELER's processState: eAllContents order). */
export function processDataflow(state: CState, expansion: Expansion) {
    const regions: CRegion[] = []
    const visit = (s: CState) => {
        for (const r of s.regions) {
            if (r.dataflow) regions.push(r)
            for (const c of r.states) visit(c)
        }
    }
    visit(state)
    for (const r of regions) processRegion(r, expansion)
}

/** Does an equation call a method? Then KIELER uses its "OO" translation (processDataflowRegionOO). */
function callsMethod(eqs: CEquation[]): boolean {
    let found = false
    const visit = (e: CExpr) => {
        if (e.k === 'call' && e.target?.v.method) found = true
        if (e.k === 'op') e.args.forEach(visit)
        else if (e.k === 'call' || e.k === 'vector') (e.k === 'call' ? e.args : e.values).forEach(visit)
        else if (e.k === 'ref') e.idx.forEach(visit)
    }
    for (const eq of eqs) visit(eq.expr)
    return found
}

/**
 * KIELER's processDataflowRegionOO, for equations that call methods: one state `__df_<name>` whose immediate during
 * actions (entry actions for `once`) are the equations, in written order; sequences get schedules as in the classic
 * translation. Chart instances in such regions are not supported (KIELER keeps them as objects).
 */
function processRegionOO(df: CRegion, expansion: Expansion, eqs: CEquation[]) {
    const parent = df.parent
    const about = df.origin ?? df.about
    const region = createControlflowRegion(parent, `${PREFIX}${df.name ?? 'null'}`)
    region.about = about
    const main = createState(region, `${PREFIX}${df.name ?? 'null'}`)
    main.initial = true
    main.about = about
    for (const v of [...df.decls]) {
        v.scope = main
        main.decls.push(v)
    }
    df.decls = []
    if (eqs.some(eq => [eq.target, ...refsOf(eq.expr)].some(r => r.v.declKind === 'reference'))) {
        expansion.ctx.report({
            severity: 'info', code: 'unsupported', related: about ? [about] : undefined,
            message: 'The guide\'s simulator cannot run chart instances in a dataflow region that calls methods yet',
            hint: 'KIELER translates such a region differently (its "OO" mode), keeping the instances as objects. The official KIELER tools can run this chart.',
        })
        return
    }
    let group: object | undefined
    let priority = 0
    let lastSequential = false
    for (const eq of eqs) {
        if (eq.sequential && !lastSequential) {
            group = {}
            priority = 0
        }
        const action = createAction(main, df.ext.once ? 'entry' : 'during')
        action.delay = 'immediate'
        action.about = about
        const schedule = (eq.sequential || lastSequential) && group ? [{ group, priority: priority++ }] : undefined
        action.effects.push({ k: 'assign', ref: eq.target, op: eq.op, expr: eq.expr, o: { by: about, span: eq.span, schedule } })
        lastSequential = eq.sequential
    }
    parent.regions.splice(parent.regions.indexOf(df), 1)
}

function refsOf(e: CExpr): CRef[] {
    const out: CRef[] = []
    const visit = (x: CExpr) => {
        if (x.k === 'ref') { out.push(x); x.idx.forEach(visit) }
        else if (x.k === 'op') x.args.forEach(visit)
        else if (x.k === 'vector') x.values.forEach(visit)
        else if (x.k === 'call') x.args.forEach(visit)
    }
    visit(e)
    return out
}

function processRegion(df: CRegion, expansion: Expansion) {
    const eqsAll = (df.ext.eqs as CEquation[] | undefined) ?? []
    if (!df.ext.forCounter && !eqsAll.some(eq => eq.call) && callsMethod(eqsAll)) {
        processRegionOO(df, expansion, eqsAll)
        return
    }
    const parent = df.parent
    const about = df.origin ?? df.about
    const region = createControlflowRegion(parent, `${PREFIX}${df.name ?? 'null'}`)
    region.about = about
    const main = createState(region, `${PREFIX}main`)
    main.initial = true
    main.about = about
    if (df.ext.once) {
        const done = createState(region, `${PREFIX}done`)
        done.final = true
        done.about = about
        createTransitionTo(main, done).preemption = 'termination'
    }
    for (const v of [...df.decls]) {
        v.scope = region
        region.decls.push(v)
    }
    df.decls = []

    const eqs = (df.ext.eqs as CEquation[] | undefined) ?? []
    const counter = df.ext.forCounter as CVar | undefined
    if (counter) {
        // The Dataflow processor ignores the for-loop: the equations keep references to a counter that is gone (S-24).
        expansion.ctx.report({
            severity: 'error', code: 'dataflow-for', span: counter.span, related: about ? [about] : undefined,
            message: 'A dataflow region cannot be a for-region',
            kieler: `The valued object reference points to a valued object (${counter.name}) that is not contained in the model!\nReferences objects are not contained in the resource!`,
            hint: `KIELER turns the dataflow region into control flow without copying it, so \`${counter.name}\` is unknown in its equations. Write the equations for each value (O[0] = I[0], O[1] = I[1], ...), or use a control-flow for-region.`,
        })
        return
    }
    for (const eq of eqs) {
        if (eq.call) {
            expansion.ctx.report({
                severity: 'info', code: 'unsupported', span: eq.span, related: about ? [about] : undefined,
                message: 'The guide\'s simulator cannot run dataflow reference calls (A(x, y)) yet',
                hint: 'Write one equation per input instead: g.A = x. The official KIELER tools can run this chart as written.',
            })
            return
        }
    }

    // Chart instances used in the equations, in order of first use.
    const instances: CVar[] = []
    for (const eq of eqs) {
        for (const r of assignmentRefs(eq)) {
            if (r.v.declKind === 'reference' && r.v.instance && !instances.includes(r.v)) instances.push(r.v)
        }
    }
    const locals = new Map<CVar, Map<string, CVar>>()
    instances.forEach((g, i) => {
        const chart = expansion.findChart(g.instance!.target)
        const r = createControlflowRegion(main, `${PREFIX}refRegion_${i}`)
        r.about = g.decl
        const refState = createState(r, `${PREFIX}${i}`)
        refState.initial = true
        refState.about = g.decl
        const wait = createState(r, `${PREFIX}d${i}`)
        wait.about = g.decl
        createTransitionTo(refState, wait).preemption = 'termination'
        createTransitionTo(wait, refState)
        const args: CArg[] = [...g.instance!.args]
        const own = new Map<string, CVar>()
        // Local versions of the instance's interface (inputs and outputs, in declaration order).
        for (const d of chart ? interfaceOf(chart) : []) {
            const local = new CVar(`${PREFIX}${g.name}_${d.name}`, d.type)
            local.signal = d.signal
            local.generated = true
            local.dims = d.dims
            local.display = `${g.name}.${d.name}`
            local.decl = g.decl
            local.span = g.span
            const scope = g.scope ?? main
            local.scope = scope
            scope.decls.push(local)
            own.set(d.name, local)
            args.push({ expr: ref(local) })
        }
        locals.set(g, own)
        const call: ReferenceCall = { target: g.instance!.target, args, span: g.span }
        refState.ext.call = call
    })

    // Equations: tuples into one equation per input (or array element), in written order.
    let group: object | undefined
    let priority = 0
    let lastSequential = false
    eqs.forEach((eq, k) => {
        const parts: { key: number; target: CRef; op: CEquation['op']; expr: CExpr }[] = []
        if (eq.expr.k === 'vector') {
            const values = [...eq.expr.values]
            const target = eq.target
            if (target.v.declKind === 'reference' && target.v.instance) {
                const chart = expansion.findChart(target.v.instance.target)
                let idx = 0
                for (const input of chart ? interfaceOf(chart).filter(d => d.input) : []) {
                    if (values.length) {
                        const value = values.shift()!
                        if (value.k !== 'ignore') parts.push({ key: idx + k * 100, target: { k: 'ref', v: target.v, idx: [], sub: { k: 'ref', v: placeholder(input.name), idx: [] }, span: target.span }, op: eq.op, expr: value })
                    }
                    idx++
                }
            } else {
                values.forEach((value, idx) => {
                    if (value.k !== 'ignore') parts.push({ key: idx + k * 100, target: { ...target, idx: [...target.idx, { k: 'lit', t: 'int', v: idx }] }, op: eq.op, expr: value })
                })
            }
        } else {
            parts.push({ key: k, target: eq.target, op: eq.op, expr: eq.expr })
        }
        if (eq.sequential && !lastSequential) {
            group = {}
            priority = 0
        }
        for (const part of parts) {
            const r = createControlflowRegion(main, `${PREFIX}subRegion_${part.key}`)
            r.about = about
            if ((eq.sequential || lastSequential) && group) r.ext.schedule = { group, priority: priority++, name: `seq` } satisfies Schedule
            const s = createState(r, `${PREFIX}${part.key}`)
            s.initial = true
            s.about = about
            const d = createState(r, `${PREFIX}d${part.key}`)
            d.about = about
            const t = createTransitionTo(s, d)
            t.delay = 'immediate'
            t.about = about
            const target = instanceRef(part.target, locals)
            const expr = instanceExpr(part.expr, locals)
            t.effects.push({ k: 'assign', ref: target, op: part.op, expr, o: { by: about, span: eq.span } })
            if (df.ext.once) d.final = true
            else createTransitionTo(d, s)
        }
        lastSequential = eq.sequential
    })

    // Remove the dataflow region and the instances' declarations.
    parent.regions.splice(parent.regions.indexOf(df), 1)
    for (const g of instances) {
        const scope = g.scope
        if (scope) scope.decls.splice(scope.decls.indexOf(g), 1)
    }
}

/** The interface of a chart as written: its inputs and outputs in declaration order. */
function interfaceOf(chart: State): { name: string; type: CVar['type']; signal: boolean; input: boolean; dims: CExpr[] }[] {
    const out: { name: string; type: CVar['type']; signal: boolean; input: boolean; dims: CExpr[] }[] = []
    for (const d of chart.declarations) {
        if (d.declKind !== 'variable' || !(d.input || d.output)) continue
        for (const vo of d.valuedObjects) {
            out.push({
                name: vo.name, type: d.type ?? (d.signal ? 'pure' : 'host'), signal: d.signal, input: d.input,
                dims: vo.cardinalities.flatMap(c => (c.kind === 'int' ? [{ k: 'lit', t: 'int', v: c.value } as CExpr] : [])),
            })
        }
    }
    return out
}

const placeholders = new Map<string, CVar>()
/** A stand-in for a member of an instance (`g.A`) before it is replaced by the local `__df_g_A`. */
function placeholder(name: string): CVar {
    let v = placeholders.get(name)
    if (!v) placeholders.set(name, (v = new CVar(name, 'host')))
    return v
}

/** The references of an equation: target first, then the expression's (KIELER's allAssignmentReferences). */
function assignmentRefs(eq: CEquation): CRef[] {
    const out: CRef[] = [eq.target]
    const walk = (e: CExpr) => {
        if (e.k === 'ref') {
            out.push(e)
            e.idx.forEach(walk)
        } else if (e.k === 'op') e.args.forEach(walk)
        else if (e.k === 'vector') e.values.forEach(walk)
        else if (e.k === 'call') e.args.forEach(walk)
    }
    walk(eq.expr)
    return out
}

/** `g.X` becomes the local `__df_g_X`. */
function instanceRef(r: CRef, locals: Map<CVar, Map<string, CVar>>): CRef {
    if (r.sub) {
        const local = locals.get(r.v)?.get(r.sub.v.name)
        if (local) return { k: 'ref', v: local, idx: r.sub.idx, span: r.span }
    }
    return { ...r, idx: r.idx.map(i => instanceExpr(i, locals)) }
}

function instanceExpr(e: CExpr, locals: Map<CVar, Map<string, CVar>>): CExpr {
    switch (e.k) {
        case 'ref': return instanceRef(e, locals)
        case 'op': return { ...e, args: e.args.map(a => instanceExpr(a, locals)) }
        case 'vector': return { ...e, values: e.values.map(a => instanceExpr(a, locals)) }
        case 'call': return { ...e, args: e.args.map(a => instanceExpr(a, locals)) }
        default: return e
    }
}

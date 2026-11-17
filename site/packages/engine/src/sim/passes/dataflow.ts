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
    CVar, createAction, createControlflowRegion, createState, createTransitionTo, ref, walkExpr, type CArg, type CExpr,
    type CRef, type CRegion, type CState, type SchedEntry,
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

/** KIELER's tag on an instance used in an OO dataflow region: its inputs and outputs stay with it (Reference pass). */
export const DF_BINDING = '_DF_keep_io_local'
/** A `ref` declaration the classic translation has removed (`removeFromContainmentAndCleanup`). */
export const DF_REMOVED = '#df-removed'

/** The variable a reference finally names (`c.add`: the method; KIELER's lowermostReference). */
function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

/**
 * Does the region call a method anywhere (an equation, an index, a call's argument, a declaration's initial value)?
 * Then KIELER uses its "OO" translation (processDataflowRegion: eAllContents.filter(ReferenceCall)).
 */
function callsMethod(df: CRegion, eqs: CEquation[], expansion: Expansion): boolean {
    let found = false
    const method = (r: CRef) => {
        const v = lowermost(r).v
        if (v.method || v.declKind === 'method') return true
        // A method of a chart instance (`c.add`): its declaration is the instantiated chart's.
        return v.declKind === 'unresolved' && !!v.decl && expansion.index?.vos.get(v.decl)?.decl?.declKind === 'method'
    }
    const visit = (e: CExpr | undefined) => walkExpr(e, x => {
        if (x.k === 'call' && !x.extern && x.target && method(x.target)) found = true
    })
    for (const eq of eqs) {
        visit(eq.expr)
        visit(eq.trigger)
        eq.target.idx.forEach(visit)
    }
    for (const v of df.decls) {
        visit(v.init)
        v.dims.forEach(visit)
    }
    return found
}

/** A chart instance the Dataflow processor handles: `ref C g` of a chart, not removed, not `@DFignore`. */
function isInstance(v: CVar, expansion: Expansion): boolean {
    if (v.declKind !== 'reference' || !v.instance || v.extern || v.tags.has(DF_REMOVED)) return false
    const d = v.decl ? expansion.index?.vos.get(v.decl)?.decl : undefined
    return !d?.annotations.some(a => a.name === 'DFignore')
}

/**
 * The chart instances an equation names (KIELER's allAssignmentReferences: the target's and the expression's
 * references; a call written as an equation has neither, only the expression after its `=`).
 */
function instancesOf(eq: CEquation, expansion: Expansion): CVar[] {
    const out: CVar[] = []
    const add = (r: CRef) => { if (isInstance(r.v, expansion) && !out.includes(r.v)) out.push(r.v) }
    const visit = (e: CExpr | undefined) => walkExpr(e, x => {
        if (x.k === 'ref') add(x)
        else if (x.k === 'call' && x.target) add(x.target)
    })
    if (eq.call) visit(eq.trigger)
    else {
        add(eq.target)
        eq.target.idx.forEach(visit)
        visit(eq.expr)
    }
    return out
}

/** KIELER's canTerminate: every region of the chart (and of its base charts) has a final state, no during actions. */
function canTerminate(chart: State, expansion: Expansion): boolean {
    const states: State[] = []
    const inherit = (c: State | undefined) => {
        if (!c || states.includes(c)) return
        states.push(c)
        for (const b of c.baseStates ?? []) inherit(expansion.findChart(b.target))
    }
    inherit(chart)
    let terminating = false
    for (const s of states) {
        if (s.actions.some(a => a.kind === 'during') || s.regions.some(r => r.regionType === 'dataflow')) return false
        for (const r of s.regions) {
            if (r.final || r.states.every(x => !x.final)) return false
            terminating = true
        }
    }
    return terminating
}

/** One equation after tuples are taken apart: an assignment or a call. */
interface Part {
    key: number
    target: CRef
    op: CEquation['op']
    expr: CExpr
    /** A dataflow reference call (`expr` is the call), with the `= e` after it. */
    call?: boolean
    trigger?: CExpr
    /** The equation's own `schedule` clause (lost with a tuple's parts: they are new assignments). */
    schedule?: SchedEntry[]
}

/**
 * KIELER's tuple handling, shared by both translations: `g = {a, _, c}` sets the inputs of the chart `g`
 * instantiates in declaration order (its own, then the inherited ones), a vector assigned to an array its elements.
 */
function parts(eq: CEquation, k: number, expansion: Expansion): Part[] {
    if (eq.expr.k !== 'vector' || eq.call) {
        return [{ key: k, target: eq.target, op: eq.op, expr: eq.expr, call: eq.call, trigger: eq.trigger, schedule: eq.schedule }]
    }
    const out: Part[] = []
    const values = [...eq.expr.values]
    const target = eq.target
    if (target.v.declKind === 'reference' && target.v.instance) {
        const chart = expansion.findChart(target.v.instance.target)
        let idx = 0
        for (const input of chart ? interfaceOf(chart, expansion).filter(d => d.input) : []) {
            if (values.length) {
                const value = values.shift()!
                if (value.k !== 'ignore') out.push({ key: idx + k * 100, target: { k: 'ref', v: target.v, idx: [], sub: { k: 'ref', v: placeholder(input), idx: [] }, span: target.span }, op: '=', expr: value })
            }
            idx++
        }
    } else {
        values.forEach((value, idx) => {
            if (value.k !== 'ignore') out.push({ key: idx + k * 100, target: { ...target, idx: [...target.idx, { k: 'lit', t: 'int', v: idx }] }, op: eq.op, expr: value })
        })
    }
    return out
}

/**
 * KIELER's processDataflowRegionOO, for regions that call methods: one state `__df_<name>` whose immediate during
 * actions (entry actions for `once`) are the equations, in written order. A call written as an equation is a call
 * effect, and the `= e` after it the action's trigger. Sequences get schedules as in the classic translation; an
 * equation's own schedule clause stays on its effect. The chart instances the equations name stay declarations,
 * tagged so that the Reference pass keeps their inputs and outputs as members of the instance (they are objects in
 * KIELER's data pool).
 */
function processRegionOO(df: CRegion, expansion: Expansion, eqs: CEquation[]) {
    const parent = df.parent
    const about = df.origin ?? df.about
    const region = createControlflowRegion(parent, `${PREFIX}${df.name ?? 'null'}`)
    region.about = about
    if (df.ext.userSchedule) region.ext.userSchedule = df.ext.userSchedule
    const main = createState(region, `${PREFIX}${df.name ?? 'null'}`)
    main.initial = true
    main.about = about
    for (const v of [...df.decls]) {
        v.scope = main
        main.decls.push(v)
    }
    df.decls = []

    const instances: CVar[] = []
    for (const eq of eqs) for (const g of instancesOf(eq, expansion)) if (!instances.includes(g)) instances.push(g)
    for (const g of instances) {
        g.tags.add(DF_BINDING)
        // KIELER would restart an instance declared in the region itself, but looks for the declaration after it has
        // moved it to the new state: no instance is ever restarted.
        const chart = expansion.findChart(g.instance!.target)
        if (chart && canTerminate(chart, expansion)) {
            expansion.ctx.report({
                severity: 'info', code: 'kieler-quirk', span: g.span, related: g.decl ? [g.decl] : undefined,
                message: `\`${g.name}\` stops for good when \`${chart.name}\` terminates: in a dataflow region that calls methods an instance is not started again`,
                kieler: `An SCChart that can terminate (${chart.name}) is used (${g.name}) in a dataflow region that assumes continuous IO behavior. If you move the reference declaration into the scope of the dataflow region the behavior will be automatically restarted.`,
                hint: `Without a method call in the region, KIELER starts a terminated instance again one tick later. Here it keeps the instance as an object and never restarts it, wherever \`${g.name}\` is declared. Give \`${chart.name}\` a state that loops instead of a final state if it should keep running.`,
            })
        }
    }

    let group: object | undefined
    let priority = 0
    let lastSequential = false
    eqs.forEach((eq, k) => {
        if (eq.sequential && !lastSequential) {
            group = {}
            priority = 0
        }
        for (const part of parts(eq, k, expansion)) {
            const action = createAction(main, df.ext.once ? 'entry' : 'during')
            action.delay = 'immediate'
            action.about = about
            const schedule = [...(part.schedule ?? []), ...((eq.sequential || lastSequential) && group ? [{ group, priority: priority++ }] : [])]
            const o = { by: about, span: eq.span, ...(schedule.length ? { schedule } : {}) }
            if (part.call && part.expr.k === 'call') {
                action.effects.push({ k: 'call', call: part.expr, o })
                if (part.trigger) action.trigger = part.trigger
            } else {
                action.effects.push({ k: 'assign', ref: part.target, op: part.op, expr: part.expr, o })
            }
        }
        lastSequential = eq.sequential
    })
    parent.regions.splice(parent.regions.indexOf(df), 1)
}

function processRegion(df: CRegion, expansion: Expansion) {
    const eqsAll = (df.ext.eqs as CEquation[] | undefined) ?? []
    if (!df.ext.forCounter && callsMethod(df, eqsAll, expansion)) {
        processRegionOO(df, expansion, eqsAll)
        return
    }
    const parent = df.parent
    const about = df.origin ?? df.about
    const region = createControlflowRegion(parent, `${PREFIX}${df.name ?? 'null'}`)
    region.about = about
    if (df.ext.userSchedule) region.ext.userSchedule = df.ext.userSchedule
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
    // Chart instances used in the equations, in order of first use.
    const instances: CVar[] = []
    for (const eq of eqs) for (const g of instancesOf(eq, expansion)) if (!instances.includes(g)) instances.push(g)
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
        for (const d of chart ? interfaceOf(chart, expansion) : []) {
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
        if (eq.sequential && !lastSequential) {
            group = {}
            priority = 0
        }
        for (const part of parts(eq, k, expansion)) {
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
        g.tags.add(DF_REMOVED)
    }
}

interface Port { name: string; id: string; type: CVar['type']; signal: boolean; input: boolean; dims: CExpr[] }

/**
 * The interface of a chart as written: its inputs and outputs in declaration order, then those of the charts it
 * extends (KIELER's `decls += ref.allInheritedDeclarations`).
 */
function interfaceOf(chart: State, expansion: Expansion): Port[] {
    const out: Port[] = []
    const seen = new Set<State>()
    const visit = (c: State | undefined) => {
        if (!c || seen.has(c)) return
        seen.add(c)
        for (const d of c.declarations) {
            if (d.declKind !== 'variable' || !(d.input || d.output)) continue
            for (const vo of d.valuedObjects) {
                if (out.some(x => x.name === vo.name)) continue
                out.push({
                    name: vo.name, id: vo.id, type: d.type ?? (d.signal ? 'pure' : 'host'), signal: d.signal, input: d.input,
                    dims: vo.cardinalities.flatMap(x => (x.kind === 'int' ? [{ k: 'lit', t: 'int', v: x.value } as CExpr] : [])),
                })
            }
        }
        for (const b of c.baseStates ?? []) visit(expansion.findChart(b.target))
    }
    visit(chart)
    return out
}

/** A stand-in for a member of an instance (`g.A`), as the lowering makes one: named, with the member's declaration. */
function placeholder(port: Port): CVar {
    const v = new CVar(port.name, 'host')
    v.declKind = 'unresolved'
    v.decl = port.id
    return v
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

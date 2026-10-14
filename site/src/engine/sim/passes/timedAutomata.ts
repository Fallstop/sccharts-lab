// KIELER's Timed Automata processor (sccharts/processors/TimedAutomata.xtend). Owner: the structure workstream.
// structure.md S-35 .. S-41.
//
// A chart with clocks gets an input `deltaT` (the time since the previous tick, given by the environment) and an
// output `sleepT` (how long the environment may wait before the next tick), both of the clock type (float, or int with
// @IntegerClockType). For every clock, the states of the one region whose transitions test it (looking through
// wrapper states) get a during action `t += deltaT` (delayed: not in the tick they are entered) and, for every bound of
// their timed transitions, an immediate during action `if t < b do sleepT min= b - t`; the root starts every tick
// with `sleepT = maxSleep` (1000, or @DefaultSleep). @SimulateSleep sets `deltaT = pre(sleepT)` after the first tick,
// @NoSleep drops sleepT. A clock tested by several regions, or by a state and inside it, is rejected, unless
// @ClocksUseSD: then the declaring state advances the clock and KIELER's ClockIUR schedule orders its writes
// (clockWithSD). @DeviationOutput and @Logical clocks are not simulated.

import type { Annotation, Diagnostic, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { Pass, PassContext } from './context'
import {
    allContainedStates, allStates, CVar, controlflowRegions, copyExpr, createAction, createImmediateDuringAction, ref,
    type CEffect, type CExpr, type CRegion, type CState, type CTransition,
} from '../model'
import type { InstanceRecord } from './reference'

export const timedAutomata: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.timedautomata',
    name: 'Timed Automata',
    owner: 'structure',
    run(ctx: PassContext) {
        transform(ctx)
    },
}

const MAX_SLEEP_DEFAULT = 1000

/** Every annotation in the chart as written (KIELER searches `rootState.eAllContents`), its instances' included. */
export function chartAnnotations(ctx: PassContext): Annotation[] {
    const index = ctx.shared.index as ModelIndex | undefined
    const charts: State[] = []
    const main = ctx.root.origin ? index?.states.get(ctx.root.origin) : undefined
    if (main) charts.push(main)
    for (const r of (ctx.shared.instances as InstanceRecord[] | undefined) ?? []) charts.push(r.chart)
    const out: Annotation[] = []
    const visit = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (!value || typeof value !== 'object') return
        const obj = value as Record<string, unknown>
        if (obj.kind === 'annotation') out.push(obj as unknown as Annotation)
        for (const [k, v] of Object.entries(obj)) if (k !== 'span' && v && typeof v === 'object') visit(v)
    }
    charts.forEach(visit)
    return out
}

function named(list: Annotation[], ...names: string[]): Annotation | undefined {
    const lower = names.map(n => n.toLowerCase())
    return list.find(a => lower.includes(a.name.toLowerCase()))
}

function isClock(v: CVar): boolean {
    return v.type === 'clock' && !v.declKind
}

function transform(ctx: PassContext) {
    const root = ctx.root
    const states = allStates(root)
    if (!states.some(s => s.decls.some(isClock))) return
    const annotations = chartAnnotations(ctx)
    const intClock = [...annotations].reverse().find(a => ['integralclocktype', 'integerclocktype'].includes(a.name.toLowerCase()))
    const clockType = intClock ? 'int' : 'float'
    const lit = (n: number): CExpr => (clockType === 'int' ? { k: 'lit', t: 'int', v: Math.trunc(n) } : { k: 'lit', t: 'float', v: Math.fround(n) })
    const noSleep = !!named(annotations, 'NoSleep')
    const simulate = !!named(annotations, 'SimulateSleep')
    const useSD = !!named(annotations, 'ClocksUseSD')
    const unsupported = named(annotations, 'DeviationOutput') ??
        (states.some(s => s.decls.some(v => isClock(v) && v.tags.has('@Logical'))) ? ({ name: 'Logical' } as Annotation) : undefined)
    if (unsupported) {
        ctx.report({
            severity: 'info', code: 'unsupported', span: unsupported.span,
            message: `The guide's simulator cannot run \`@${unsupported.name}\` yet`,
            hint: 'This experimental part of KIELER\'s Timed Automata transformation is not implemented in the simulator. The official KIELER tools can run this chart.',
        })
        return
    }
    const sleepAnnotation = named(annotations, 'DefaultSleep')
    let maxSleep = MAX_SLEEP_DEFAULT
    if (sleepAnnotation) {
        const value = sleepAnnotation.values[0]
        if (value === undefined || sleepAnnotation.json) {
            ctx.report({
                severity: 'error', code: 'default-sleep', span: sleepAnnotation.span,
                message: `\`@${sleepAnnotation.name}\` needs a value, e.g. \`@${sleepAnnotation.name} 100\``,
                kieler: `@${sleepAnnotation.name} needs a ${sleepAnnotation.json ? 'plain value, not a JSON object' : 'value'}, e.g. @${sleepAnnotation.name} 100.`,
                hint: `Write the default sleep time after \`@${sleepAnnotation.name}\`, or remove the annotation to keep the default of ${MAX_SLEEP_DEFAULT}. The official KIELER compiler cannot compile this either.`,
            })
            return
        }
        const n = Number(value)
        if (Number.isFinite(n)) maxSleep = n
    }

    // deltaT (input) and sleepT (output): the chart's own, if declared with these names, else generated.
    const own = (name: string) => root.decls.find(v => v.name.toLowerCase() === name.toLowerCase())
    let deltaT = own('deltaT')
    if (deltaT) {
        if (!deltaT.init) deltaT.init = lit(0)
        if (!deltaT.input || (deltaT.type !== clockType && deltaT.type !== 'clock-time')) ctx.report(clockVarError('deltaT', 'input', clockType, deltaT))
    } else {
        deltaT = generated('deltaT', clockType, root, lit(0))
        deltaT.input = true
    }
    let sleepT = own('sleepT')
    if (sleepT) {
        if (!sleepT.init) sleepT.init = lit(0)
        if (!sleepT.output || (sleepT.type !== clockType && sleepT.type !== 'clock-time')) ctx.report(clockVarError('sleepT', 'output', clockType, sleepT))
    } else if (!noSleep) {
        sleepT = generated('sleepT', clockType, root, lit(0))
        sleepT.output = true
    }
    if (!noSleep && sleepT) {
        const start = createImmediateDuringAction(root)
        start.about = sleepT.decl
        start.effects.push({ k: 'assign', ref: ref(sleepT), op: '=', expr: lit(maxSleep), o: { hidden: true, by: sleepT.decl } })
        if (simulate) {
            const sim = createAction(root, 'during')
            sim.about = deltaT.decl
            sim.effects.push({ k: 'assign', ref: ref(deltaT), op: '=', expr: { k: 'op', op: 'pre', args: [ref(sleepT)] }, o: { by: deltaT.decl } })
        }
    }
    // `time` variables get the clock type.
    for (const s of states) for (const scope of [s, ...s.regions]) for (const v of scope.decls) if (v.type === 'clock-time') v.type = clockType

    for (const state of states.filter(s => s.decls.some(isClock))) {
        for (const clock of state.decls.filter(isClock)) {
            clock.type = clockType
            if (!clock.init) clock.init = lit(0)
            if (clock.dims.length) {
                ctx.report({ severity: 'error', code: 'clock-array', span: clock.span, message: `\`${clock.name}\` is an array of clocks, which KIELER cannot handle yet`, kieler: 'Cannot yet handle array of clocks.', hint: 'Declare one clock per timer.' })
                continue
            }
            if (clock.tags.has('@Passive')) continue
            if (useSD) {
                clockWithSD(state, clock, deltaT, noSleep ? undefined : sleepT, ctx, lit)
                continue
            }
            // The region whose states test the clock (looking through single-state wrappers).
            const regions = controlflowRegions(state)
            let region: CRegion | undefined = regions[0]
            if (regions.length > 1) {
                const using: CRegion[] = []
                for (const r of regions) {
                    let test = r
                    while (test.states.length === 1 && test.states[0].out.length === 0 && controlflowRegions(test.states[0]).length === 1) {
                        test = controlflowRegions(test.states[0])[0]
                    }
                    if (test.states.some(s => s.out.some(t => t.trigger && mentionsVar(t.trigger, clock)))) using.push(test)
                }
                region = using[0]
                if (using.length > 1) {
                    // At the second region's transition that tests the clock (the first is where the clock goes).
                    const reading = using.slice(0, 2).map(r => r.states.flatMap(s => s.out).find(t => t.trigger && mentionsVar(t.trigger, clock)))
                    const second = reading[1]
                    const d = sharedClock(state, clock, `Clock \`${clock.name}\` is read by several concurrent regions of \`${state.name}\`.`,
                        'Cannot handle concurrent timed automata using the same clock. Add @ClocksUseSD annotation for experimental support based on schduling directives.',
                        'Declare one clock per region and reset it on entry.')
                    d.span = second?.trigger?.span ?? second?.span ?? clock.span
                    d.related = [...new Set([...reading.flatMap(t => (t?.origin ? [t.origin] : [])), ...(d.related ?? [])])]
                    ctx.report(d)
                }
            }
            if (!region) {
                const d = sharedClock(state, clock, `Clock \`${clock.name}\` is used across concurrent or nested regions of \`${state.name}\`.`,
                    'Cannot handle concurrent or hierarchical timed automata using the same clock. Add @ClocksUseSD annotation for experimental support based on schduling directives.',
                    'Declare a separate clock for each region.')
                d.span = clock.span
                ctx.report(d)
                continue
            }
            for (const sub of region.states.filter(s => !s.connector)) {
                const inner = sub.actions.some(a => a.kind === 'during' || a.kind === 'exit' || a.kind === 'entry') || sub.regions.length > 0
                if (inner) {
                    const actionReads = sub.actions.some(a => a.trigger && mentionsVar(a.trigger, clock))
                    const insideReads = controlflowRegions(sub).some(r => regionMentions(r, clock))
                    if (actionReads || insideReads) {
                        ctx.report(sharedClock(sub, clock, `Clock \`${clock.name}\` is read both by \`${sub.name}\` and inside it.`,
                            'Cannot handle hierarchical timed automata. Add @ClocksUseSD annotation for experimental support based on SDs.',
                            'Give the inner regions their own clock.'))
                    }
                }
                // Time passes: a delayed during action, so not in the tick the state is entered (S-36).
                const progress = createAction(sub, 'during')
                progress.about = clock.decl
                progress.effects.push({ k: 'assign', ref: ref(clock), op: '+=', expr: ref(deltaT), o: { by: clock.decl, span: clock.span } })
                if (!noSleep && sleepT) handleSleep(ctx, sub, clock, sleepT, lit)
            }
        }
    }
}

/**
 * @ClocksUseSD (KIELER's "experimental support based on scheduling directives"): the clock may be shared by
 * concurrent and nested regions. Its declaring state advances it once per tick (a delayed during action), and a
 * schedule ClockIUR orders the clock's writes: the increment (priority 0) before resets `t = ...` (1) before
 * updates (2, confluent with each other). Every state inside asks for sleep times for its timeouts.
 */
function clockWithSD(state: CState, clock: CVar, deltaT: CVar, sleepT: CVar | undefined, ctx: PassContext, lit: (n: number) => CExpr) {
    const group: ScheduleGroup = { name: `${clock.name}SD`, protocols: ['conflict', 'conflict', 'confluent'] }
    const schedule = (f: CEffect, priority: number) => {
        f.o = { ...f.o, schedule: [...(f.o.schedule ?? []), { group, priority }] }
    }
    for (const s of allStates(state)) {
        for (const scope of [s, ...s.regions]) {
            for (const a of scope.actions) for (const f of a.effects) if (f.k === 'assign' && f.ref.v === clock) schedule(f, f.op === '=' ? 1 : 2)
        }
        for (const t of s.out) for (const f of t.effects) if (f.k === 'assign' && f.ref.v === clock) schedule(f, f.op === '=' ? 1 : 2)
        if (sleepT && !s.connector) handleSleep(ctx, s, clock, sleepT, lit)
    }
    const progress = createAction(state, 'during')
    progress.about = clock.decl
    const increment: CEffect = { k: 'assign', ref: ref(clock), op: '+=', expr: ref(deltaT), o: { by: clock.decl, span: clock.span } }
    schedule(increment, 0)
    progress.effects.push(increment)
}

/** A schedule object (deps.ts): `protocols[p]` is KIELER's PriorityProtocol of priority p. */
export interface ScheduleGroup {
    name: string
    protocols?: ('conflict' | 'confluent' | 'commuting')[]
}

function generated(name: string, type: CVar['type'], root: CState, init: CExpr): CVar {
    const v = new CVar(name, type)
    v.init = init
    v.scope = root
    // A tag, not a role: the executor reports variables without a role as the chart's own (TickResult.values).
    v.tags.add(`#${name}`)
    v.decl = `${root.origin ?? root.name}$${name}`
    root.decls.push(v)
    return v
}

function clockVarError(name: string, kind: 'input' | 'output', type: string, v: CVar): Diagnostic {
    return {
        severity: 'error', code: 'clock-variable', span: v.span, related: v.decl ? [v.decl] : undefined,
        message: `\`${name}\` is the time variable of timed charts: it must be ${kind === 'input' ? 'an input' : 'an output'} of type ${type}`,
        kieler: `A variable with name ${name} already exists and is not an ${kind} variable of type ${type}`,
        hint: `KIELER uses \`${name}\` for ${name === 'deltaT' ? 'the time since the previous tick' : 'the time until the next tick'} in charts with clocks. Rename your variable, or declare it as \`${kind} ${type} ${name}\`.`,
    }
}

function sharedClock(state: CState, clock: CVar, lab: string, kieler: string, hint: string): Diagnostic {
    return {
        severity: 'error', code: 'shared-clock', related: [state.origin ?? state.about, clock.decl].filter((x): x is string => !!x),
        message: lab, kieler, hint: `${hint} KIELER's timed automata give every clock to one region, which advances it.`,
    }
}

function mentionsVar(e: CExpr, v: CVar): boolean {
    let found = false
    const visit = (x: CExpr) => {
        if (found) return
        if (x.k === 'ref') { if (x.v === v) found = true; x.idx.forEach(visit) }
        else if (x.k === 'op') x.args.forEach(visit)
        else if (x.k === 'vector') x.values.forEach(visit)
        else if (x.k === 'call') x.args.forEach(visit)
    }
    visit(e)
    return found
}

/** Does anything inside the region use the variable (KIELER's eAllContents check)? */
function regionMentions(r: CRegion, v: CVar): boolean {
    for (const s of allContainedStates(r)) {
        for (const a of [...s.actions, ...s.regions.flatMap(x => x.actions)]) {
            if (a.trigger && mentionsVar(a.trigger, v)) return true
            if (a.effects.some(f => effectMentions(f, v))) return true
        }
        for (const t of s.out) {
            if (t.trigger && mentionsVar(t.trigger, v)) return true
            if (t.effects.some(f => effectMentions(f, v))) return true
        }
    }
    return false
}

function effectMentions(f: CEffect, v: CVar): boolean {
    if (f.k === 'assign') return f.ref.v === v || (!!f.expr && mentionsVar(f.expr, v))
    if (f.k === 'emit') return !!f.value && mentionsVar(f.value, v)
    return false
}

interface Constraint {
    transition: CTransition
    op: Extract<CExpr, { k: 'op' }>
    /** The comparison's direct container (for the greedy-bound and insignificance patterns). */
    container?: CExpr
}

/** KIELER's handleSleep: sleep requests for the bounds of the state's timed transitions (S-38). */
function handleSleep(ctx: PassContext, state: CState, clock: CVar, sleepT: CVar, lit: (n: number) => CExpr) {
    const constraints: Constraint[] = []
    const complex: Extract<CExpr, { k: 'op' }>[] = []
    for (const t of state.out) {
        if (!t.trigger) continue
        const visit = (e: CExpr, parent: CExpr | undefined, grand: CExpr | undefined) => {
            if (e.k === 'ref') {
                if (e.v === clock) {
                    if (parent?.k === 'op' && parent.args.length === 2) {
                        const refs = parent.args.filter(a => a.k === 'ref').length
                        const values = parent.args.filter(a => a.k === 'lit').length
                        if (refs === 1 && values === 1) constraints.push({ transition: t, op: parent, container: grand })
                        else complex.push(parent)
                    } else {
                        ctx.report({
                            severity: 'error', code: 'timing-constraint', span: e.span, related: t.origin ? [t.origin] : undefined,
                            message: `\`${clock.name}\` must be compared with a value here (for example \`${clock.name} >= 300\`)`,
                            kieler: 'Malformed timing constraint.',
                            hint: 'KIELER works out the sleep time from comparisons of the clock with a value, so a clock in a trigger has to be one side of such a comparison.',
                        })
                    }
                }
                e.idx.forEach(i => visit(i, e, parent))
            } else if (e.k === 'op') e.args.forEach(a => visit(a, e, parent))
        }
        visit(t.trigger, undefined, undefined)
    }
    const sleepFor = (bound: CExpr) => {
        const during = createImmediateDuringAction(state)
        during.about = clock.decl
        during.trigger = { k: 'op', op: '<', args: [ref(clock), bound] }
        during.effects.push({ k: 'assign', ref: ref(sleepT), op: 'min=', expr: { k: 'op', op: '-', args: [copyExpr(bound), ref(clock)] }, o: { hidden: true, by: sleepT.decl } })
    }
    // 1. Comparisons with an expression: `t >= e` or `e <= t`.
    for (const c of complex) {
        const [a, b] = c.args
        let exp: CExpr | undefined
        if (a.k === 'ref' && a.v === clock) exp = b
        if (b.k === 'ref' && b.v === clock) exp = a
        if (!exp) {
            ctx.report({ severity: 'error', code: 'timing-constraint', span: c.span, message: 'This timing constraint does not compare the clock', kieler: 'Malformed timing constraint. No reference to clock.' })
        } else if (!((c.op === '>=' && exp === b) || (c.op === '<=' && exp === a))) {
            ctx.report({
                severity: 'error', code: 'timing-constraint', span: c.span,
                message: `KIELER only handles \`${clock.name} >= value\` (or \`value <= ${clock.name}\`) here, not \`${c.op}\``,
                kieler: `Malformed timing constraint. Operator ${c.op} not supported in clock comparison.`,
                hint: `Write the timeout as \`${clock.name} >= value\`.`,
            })
        } else {
            sleepFor(copyExpr(exp))
        }
    }
    // 2. Comparisons with a literal.
    const value = (c: Constraint): number => {
        const v = c.op.args.find(x => x.k === 'lit')
        return v?.k === 'lit' && typeof v.v === 'number' ? v.v : 0
    }
    const thresholds: number[] = []
    if (constraints.length === 1) {
        const c = constraints[0]
        let lower = 0
        if (c.op.op === '>=' || c.op.op === '>') lower = value(c)
        if (c.op.op === '>') lower++
        thresholds.push(lower)
    } else if (!insignificant(constraints)) {
        for (const t of [...new Set(constraints.map(c => c.transition))]) {
            const own = constraints.filter(c => c.transition === t)
            const bounds: number[] = []
            for (const c of own) {
                if (c.op.op === '>=') bounds.push(value(c))
                else if (c.op.op !== '<=' && c.op.op !== '<') {
                    ctx.report({
                        severity: 'error', code: 'timing-constraint', span: c.op.span, related: t.origin ? [t.origin] : undefined,
                        message: `KIELER cannot work out the sleep time for \`${clock.name} ${c.op.op} ...\` when the state has other timeouts`,
                        kieler: `Malformed timing constraint. Operator ${c.op.op} not supported.`,
                        hint: `Write the timeouts of a state as \`${clock.name} >= value\`.`,
                    })
                }
            }
            // `t >= a || t >= b` (exactly two, directly under one ||) asks for the larger bound only (S-38).
            const parent = own[0]?.container
            if (own.length === 2 && parent?.k === 'op' && parent.op === '||' && own.every(c => c.container === parent)) {
                if (bounds.length) thresholds.push(Math.max(...bounds))
            } else {
                thresholds.push(...bounds)
            }
        }
    }
    thresholds.sort((a, b) => a - b)
    for (const t of thresholds) sleepFor(lit(t))
}

/** KIELER's isInsignificant: `g && t >= v` and `g && t < v` on two transitions tell nothing about sleeping. */
function insignificant(cs: Constraint[]): boolean {
    if (cs.length !== 2 || cs[0].transition === cs[1].transition) return false
    const [a, b] = cs
    const pa = a.container
    const pb = b.container
    if (pa?.k !== 'op' || pb?.k !== 'op' || pa.op !== '&&' || pb.op !== '&&') return false
    const ga = pa.args.find(x => x !== a.op)
    const gb = pb.args.find(x => x !== b.op)
    const va = a.op.args.find(x => x.k === 'lit')
    const vb = b.op.args.find(x => x.k === 'lit')
    if (!ga || !gb || va?.k !== 'lit' || vb?.k !== 'lit') return false
    return sameShape(ga, gb) && va.v === vb.v && ((a.op.op === '>=' && b.op.op === '<') || (b.op.op === '>=' && a.op.op === '<'))
}

function sameShape(a: CExpr, b: CExpr): boolean {
    if (a.k !== b.k) return false
    if (a.k === 'lit' && b.k === 'lit') return a.t === b.t && a.v === b.v
    if (a.k === 'ref' && b.k === 'ref') return a.v === b.v && a.idx.length === b.idx.length && a.idx.every((x, i) => sameShape(x, b.idx[i]))
    if (a.k === 'op' && b.k === 'op') return a.op === b.op && a.args.length === b.args.length && a.args.every((x, i) => sameShape(x, b.args[i]))
    return false
}

// KIELER's Signal processor (sccharts/processors/Signal.xtend): signals become bool presence variables that an
// immediate during action of the declaring state resets in every tick; emissions become `S |= true`; a valued
// signal V gets `V_val` (its value) and, unless it is an input, `V_curval` (this tick's combined emissions)
// with during actions `if V do V_val = V_curval` and, with a combine function, `V_curval = neutral`
// (concurrency.md 1.2, SIG-1..SIG-7, V-1..V-6). A scope with signals and state actions gets its regions and actions
// moved into a `_main` state first, which is why such a scope never terminates (K-2).

import type { Pass, PassContext } from './context'
import {
    addRegion, addVar, allActionSites, allStates, assign, copyExpr, createAction, createControlflowRegion,
    createImmediateDuringAction, createState, lit, mapExpr, ref, CVar,
    type CAction, type CEffect, type CExpr, type CRef, type CState,
} from '../model'
import { INT_MAX, INT_MIN } from '../values'
import type { AssignOperator, CombineOperator } from '../../types'

export const signal: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.signal',
    name: 'Signal',
    owner: 'core',
    run(ctx: PassContext) {
        for (const state of allStates(ctx.root)) transformSignal(state, ctx)
    },
}

const COMBINE_ASSIGN: Partial<Record<CombineOperator, AssignOperator>> = {
    '+': '+=', '&': '&=', max: 'max=', min: 'min=', '*': '*=', '|': '|=',
}

function indexIterable(v: CVar): CExpr[][] | undefined {
    if (!v.dims.length) return undefined
    const sizes = v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : 0))
    const out: CExpr[][] = [[]]
    for (const n of sizes) {
        const next: CExpr[][] = []
        for (const prefix of out) for (let i = 0; i < n; i++) next.push([...prefix, lit(i)])
        out.splice(0, out.length, ...next)
    }
    return out
}

/** Gets the correct neutral element of the combine function (Signal.neutralElement), or undefined (KIELER: null). */
function neutralElement(s: CVar): CExpr | undefined {
    if (s.type === 'bool') return lit(s.combine !== '|')
    if (s.type === 'int') {
        switch (s.combine) {
            case '+': return lit(0)
            case 'max': return lit(INT_MIN)
            case 'min': return lit(INT_MAX)
            case '*': return lit(1)
            default: return lit(0) // UNDEFINED, also `&` (concurrency.md K-4)
        }
    }
    if (s.type === 'string') return { k: 'lit', t: 'string', v: '' }
    return undefined
}

function withIndices(r: CRef, indices: CExpr[] | undefined): CRef {
    if (indices) r.idx.push(...indices.map(i => copyExpr(i)))
    return r
}

function transformSignal(state: CState, ctx: PassContext) {
    const signals = state.decls.filter(v => v.signal)
    if (!signals.length) return

    if (state.actions.length > 0) {
        reportSignalActionQuirk(state, signals, ctx)
        const mainRegion = createControlflowRegion(state, '_main')
        const mainState = createState(mainRegion, '_main')
        mainState.initial = true
        mainState.about = state.origin ?? state.about
        mainRegion.about = mainState.about
        for (const region of [...state.regions]) if (region !== mainRegion) addRegion(mainState, region)
        for (const action of [...state.actions]) {
            mainState.actions.push(action)
        }
        state.actions = []
    }

    let absent: CAction | undefined
    for (const s of signals) {
        const iterator = indexIterable(s)
        if (!s.pureSignal) {
            const valueVar = new CVar(s.name + '_val', s.type)
            valueVar.input = s.input
            valueVar.output = s.output
            valueVar.init = copyExpr(s.init)
            valueVar.dims = s.dims.map(d => copyExpr(d))
            valueVar.decl = s.decl
            valueVar.display = s.name
            valueVar.role = 'value'
            valueVar.of = s
            valueVar.span = s.span
            addVar(state, valueVar)
            const supportsWriting = !s.input
            let curval: CVar | undefined
            if (supportsWriting) {
                curval = new CVar(s.name + '_curval', s.type)
                curval.init = copyExpr(s.init)
                curval.dims = s.dims.map(d => copyExpr(d))
                curval.decl = s.decl
                curval.display = s.name
                curval.role = 'curval'
                curval.of = s
                curval.span = s.span
                addVar(state, curval)
                const update = (indices?: CExpr[]) => {
                    const a = createImmediateDuringAction(state)
                    a.about = s.decl
                    a.trigger = withIndices(ref(s), indices)
                    a.effects.push({ k: 'assign', ref: withIndices(ref(valueVar), indices), op: '=', expr: withIndices(ref(curval!), indices), o: { hidden: true, by: s.decl } })
                }
                if (!iterator) update()
                else for (const index of iterator) update(index)
                if (s.type === 'int' && s.combine === '&') {
                    ctx.report({
                        severity: 'warning', code: 'kieler-quirk', span: s.span, related: s.decl ? [s.decl] : undefined,
                        message: `KIELER combines the int signal \`${s.name}\` with \`&\` starting from 0, so its value is always 0`,
                        hint: 'KIELER\'s Signal transformation has no neutral element for & on int (it uses 0 instead of all bits set). Use another combine function, or emit from one region only.',
                    })
                }
                if (s.combine && s.combine !== 'none') {
                    const neutral = neutralElement(s)
                    if (neutral === undefined) {
                        ctx.report({
                            severity: 'error', code: 'unsupported-combine', span: s.span,
                            message: `KIELER cannot compile a ${s.type} signal with a combine function (\`${s.name} combine ${s.combine}\`)`,
                            kieler: 'de.cau.cs.kieler.core.diagnostics.UnsupportedConstructException: Unhandled parameter types: [null]',
                            hint: 'Only int and bool valued signals can have a combine function in KIELER. Use an int signal, or drop the combine function.',
                            related: s.decl ? [s.decl] : undefined,
                        })
                    }
                    const reset = createImmediateDuringAction(state)
                    reset.about = s.decl
                    if (!iterator) reset.effects.push({ k: 'assign', ref: ref(curval), op: '=', expr: neutral ?? lit(0), o: { hidden: true, by: s.decl } })
                    else for (const index of iterator) reset.effects.push({ k: 'assign', ref: withIndices(ref(curval), index), op: '=', expr: copyExpr(neutral ?? lit(0)), o: { hidden: true, by: s.decl } })
                }
            }

            for (const site of allActionSites(state)) {
                const holder = site.transition ?? site.action!
                if (curval) {
                    const effects: CEffect[] = []
                    for (const f of holder.effects) {
                        if (f.k === 'emit' && f.ref.v === s && f.value) {
                            const op = (s.combine && COMBINE_ASSIGN[s.combine]) ?? '='
                            effects.push({ k: 'assign', ref: { ...ref(curval), idx: f.ref.idx.map(i => copyExpr(i)) }, op, expr: f.value, o: { ...f.o, emits: s } })
                        }
                        effects.push(f)
                    }
                    holder.effects = effects
                }
                // val(V) becomes V_val
                const replaceVal = (e: CExpr): CExpr | undefined => {
                    if (e.k === 'op' && e.op === 'val' && e.args[0]?.k === 'ref' && e.args[0].v === s) {
                        const r = e.args[0]
                        return { ...ref(valueVar), idx: r.idx, span: e.span }
                    }
                    return undefined
                }
                if (holder.trigger) holder.trigger = mapExpr(holder.trigger, replaceVal)
                holder.effects = holder.effects.map(f => mapEffectExprs(f, replaceVal))
            }
        }

        // The signal becomes a bool variable, declared again at the end of its scope.
        const scope = s.scope!
        addVar(scope, s)
        s.type = 'bool'
        s.signal = false
        s.init = undefined
        s.combine = undefined
        s.role = 'presence'

        for (const site of allActionSites(state)) {
            const holder = site.transition ?? site.action!
            holder.effects = holder.effects.map(f => {
                if (f.k === 'emit' && f.ref.v === s) {
                    return { k: 'assign', ref: { ...ref(s), idx: f.ref.idx }, op: '|=', expr: lit(true), o: { ...f.o, emits: s } }
                }
                return f
            })
        }

        if (!s.input) {
            if (!absent) {
                absent = createAction(state, 'during')
                absent.delay = 'immediate'
                absent.about = state.origin ?? state.about
            }
            if (!iterator) absent.effects.push(assign(s, lit(false), { hidden: true, by: s.decl }))
            else for (const index of iterator) absent.effects.push({ k: 'assign', ref: withIndices(ref(s), index), op: '=', expr: lit(false), o: { hidden: true, by: s.decl } })
        }
    }
}

/**
 * concurrency.md K-2: a scope with signals and state actions gets a `_main` wrapper that is not final, so it never
 * terminates: a superstate's join never fires, and a root never reports termination (in the simulation the root
 * always has an action, KIELER's taken-transition reset).
 */
function reportSignalActionQuirk(state: CState, signals: CVar[], ctx: PassContext) {
    const names = signals.map(v => `\`${v.name}\``).join(', ')
    const regionsFinish = state.regions.length > 0 && state.regions.every(r => r.dataflow || r.states.some(x => x.final))
    if (state.root && regionsFinish) {
        ctx.report({
            severity: 'info', code: 'kieler-quirk', related: state.origin ? [state.origin] : undefined,
            message: `KIELER never reports this chart as terminated, because it declares signals (${names})`,
            hint: 'In KIELER\'s simulation a chart that declares a signal never terminates, even when every top-level region reaches a final state. The guide shows what KIELER does.',
        })
    } else if (!state.root && state.out.some(t => t.preemption === 'termination')) {
        ctx.report({
            severity: 'warning', code: 'kieler-quirk', related: state.origin ? [state.origin] : undefined,
            message: `KIELER never takes the join of \`${state.name}\`: it declares signals (${names}) and has state actions`,
            hint: 'KIELER moves the regions of such a state into a helper state that never finishes. Declare the signals one level up, or move the actions out of the state.',
        })
    }
}

function mapEffectExprs(f: CEffect, fn: (e: CExpr) => CExpr | undefined): CEffect {
    switch (f.k) {
        case 'assign': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(i => mapExpr(i, fn)) }, expr: f.expr ? mapExpr(f.expr, fn) : undefined }
        case 'emit': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(i => mapExpr(i, fn)) }, value: f.value ? mapExpr(f.value, fn) : undefined }
        case 'print': return { ...f, args: f.args.map(a => mapExpr(a, fn)) }
        case 'call': return { ...f, call: mapExpr(f.call, fn) as typeof f.call }
        default: return f
    }
}

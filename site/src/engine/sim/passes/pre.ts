// KIELER's Pre processor (sccharts/processors/Pre.xtend): every variable used under `pre` gets a register
// `_reg_x` (initialised to the type's default on entry of the declaring state) and `_pre_x`, updated by an
// immediate during action of the declaring state: `_pre_x = _reg_x; _reg_x = x` (concurrency.md PRE-1..PRE-4).
//
// KIELER replaces a `pre(...)` only where its direct container is an assignment, an operator expression, a
// transition trigger or an array index; anywhere else ("Pre expressions are only supported in assignments,
// triggers and other pre expressions") it fails: as an argument of print or a call, as an element of a vector,
// as a declaration's initial value. SCCharts Lab rejects those with a located error, and compiles a `pre(...)`
// that is the whole trigger of a state action with a divergence warning (official KIELER fails on it).

import type { Pass, PassContext } from './context'
import {
    allActionSites, allScopes, createImmediateDuringAction, CAction, CRegion, CVar, lit, mapExpr, owningState, printExpr, ref,
    sameExpr, walkExpr, type CEffect, type CExpr, type CRef, type CState,
} from '../model'

const KIELER_PLACEMENT = 'Pre expressions are only supported in assignments, triggers and other pre expressions'
const UNSUPPORTED = 'The official KIELER compiler cannot compile this either: it only accepts `pre(...)` in an assignment, a transition trigger, an array index or inside a larger expression.'

const isPre = (e: CExpr | undefined): e is Extract<CExpr, { k: 'op' }> => e?.k === 'op' && e.op === 'pre'

function preText(e: Extract<CExpr, { k: 'op' }>): string {
    const a = e.args[0]
    if (a?.k === 'ref') return `pre(${a.v.display ?? a.v.name})`
    if (isPre(a)) return `pre(${preText(a)})`
    return 'pre(...)'
}

/** KIELER's placement rules for pre (see above): errors for the places it fails on, the divergence warning. */
function checkPlacements(ctx: PassContext) {
    const misplaced = (e: CExpr, message: (text: string) => string, hint: (text: string) => string) => {
        ctx.report({ severity: 'error', code: 'pre-placement', span: e.span, message: message(preText(e as never)), hint: `${UNSUPPORTED} ${hint(preText(e as never))}`, kieler: KIELER_PLACEMENT })
    }
    // Vectors and call arguments anywhere in an expression.
    const visitExpr = (e: CExpr | undefined) => {
        if (!e) return
        walkExpr(e, x => {
            if (x.k === 'vector') for (const v of x.values) if (isPre(v)) misplaced(v, t => `\`${t}\` cannot be used here`, t => `Assign the previous value to a variable first, e.g. \`prev = ${t}\`, and use that variable here.`)
            if (x.k === 'call') for (const a of x.args) if (isPre(a)) misplaced(a, t => `\`${t}\` cannot be passed directly as an argument of ${x.name}(...)`, t => `Store the previous value in a variable first, e.g. \`prev = ${t}\`, and pass that variable instead.`)
        })
    }
    for (const site of allActionSites(ctx.root)) {
        const holder = site.transition ?? site.action!
        if (site.action && isPre(holder.trigger)) {
            const text = preText(holder.trigger)
            const operand = holder.trigger.args[0]
            const bool = operand?.k === 'ref' && (operand.v.type === 'bool' || operand.v.type === 'pure' || operand.v.signal)
            const kind = site.action instanceof CAction ? `${site.action.kind === 'entry' ? 'an entry' : site.action.kind === 'exit' ? 'an exit' : site.action.kind === 'during' ? 'a during' : `a ${site.action.kind}`} action` : 'a state action'
            ctx.report({
                severity: 'warning', code: 'kieler-divergence', span: holder.trigger.span,
                message: `The official KIELER compiler fails on \`${text}\` used directly as the trigger of ${kind}`,
                hint: `SCCharts Lab and this guide compile it, but KIELER stops in its Pre transformation. Write \`if ${text}${bool ? ' == true' : ' != 0'}\` instead: it means the same, and KIELER compiles \`pre(...)\` inside a comparison.`,
                kieler: KIELER_PLACEMENT,
            })
        }
        visitExpr(holder.trigger)
        for (const f of holder.effects) {
            if (f.k === 'print') {
                for (const a of f.args) if (isPre(a)) misplaced(a, t => `\`${t}\` cannot be passed directly as an argument of print(...)`, t => `Store the previous value in a variable first, e.g. \`prev = ${t}\`, and pass that variable instead.`)
                f.args.forEach(visitExpr)
            } else if (f.k === 'call') {
                visitExpr(f.call)
            } else if (f.k === 'assign') {
                visitExpr(f.expr)
                f.ref.idx.forEach(visitExpr)
            } else if (f.k === 'emit') {
                visitExpr(f.value)
            }
        }
    }
    for (const scope of allScopes(ctx.root)) {
        for (const v of scope.decls) {
            if (isPre(v.init)) {
                const name = v.display ?? v.name
                misplaced(v.init, t => `\`${t}\` cannot be used in the declaration of \`${name}\``, () => `Give \`${name}\` a plain initial value and assign the previous value to it in an action instead.`)
            } else {
                visitExpr(v.init)
            }
        }
    }
}

type PreExpr = Extract<CExpr, { k: 'op' }>

/**
 * Every `pre(...)` below the root in KIELER's eAllContents order (pre-order over the containment tree; Pre.xtend
 * collects them so): a scope's declarations (initial value, then cardinalities), its actions (effects before the
 * trigger: Action's `effects` feature comes first), then a state's regions and its outgoing transitions (effects,
 * then trigger), a region's states. An outer `pre` comes before the ones inside it.
 */
function presInKielerOrder(root: CState): PreExpr[] {
    const out: PreExpr[] = []
    const expr = (e: CExpr | undefined) => walkExpr(e, x => { if (isPre(x)) out.push(x) })
    const effect = (f: CEffect) => {
        switch (f.k) {
            case 'assign': expr(f.ref); expr(f.expr); break
            case 'emit': expr(f.ref); expr(f.value); break
            case 'print': f.args.forEach(expr); break
            case 'call': expr(f.call); break
            default: break
        }
    }
    const action = (a: { effects: CEffect[]; trigger?: CExpr }) => { a.effects.forEach(effect); expr(a.trigger) }
    const scope = (s: CState | CRegion) => {
        for (const v of s.decls) { expr(v.init); v.dims.forEach(expr) }
        s.actions.forEach(action)
        if (s instanceof CRegion) { s.states.forEach(scope); return }
        s.regions.forEach(scope)
        s.out.forEach(action)
    }
    scope(root)
    return out
}

/** A clock as the reader wrote it (`c`, `!c`). */
function clockText(c: CExpr | undefined): string {
    if (!c) return ''
    if (c.k === 'ref' && !c.idx.length && !c.sub) return c.v.display ?? c.v.name
    return printExpr(c).replace(/^\((.*)\)$/, '$1')
}

export const pre: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.pre',
    name: 'Pre',
    owner: 'core',
    run(ctx: PassContext) {
        checkPlacements(ctx)
        // KIELER pushes every pre onto a stack in eAllContents order and pops them: the last pre of a variable in the
        // chart is handled first and creates its memory (`_reg_x`, `_pre_x` and the during action that updates them,
        // with that pre's clock as the action's trigger); every other pre of the same variable is replaced by the
        // same `_pre_x`, its own clock dropped. So `pre(x)` next to `pre(x, c)` share one memory, clocked or not as
        // the last one says (probes kieler/rare/probe-pre-clock-*). Inner pres are popped first: pre(pre(x)) creates
        // _pre_x, then _pre__pre_x. The memories are created in that order too (their during actions' order).
        const transformed = new Map<CVar, CVar>()
        const deciding = new Map<CVar, PreExpr>()
        const others = new Map<CVar, PreExpr[]>()
        const madeFor = new Map<PreExpr, CVar>()
        const order = presInKielerOrder(ctx.root)
        for (let i = order.length - 1; i >= 0; i--) {
            const p = order[i]
            const operand = p.args[0]
            const v = operand?.k === 'ref' ? operand.v : isPre(operand) ? madeFor.get(operand) : undefined
            if (!v || !v.scope) continue
            let preVar = transformed.get(v)
            if (!preVar) {
                preVar = createPre(v, p.args[1])
                transformed.set(v, preVar)
                deciding.set(v, p)
            } else {
                others.set(v, [...(others.get(v) ?? []), p])
            }
            madeFor.set(p, preVar)
        }
        for (const [v, first] of deciding) reportSharedClock(ctx, v, first, others.get(v) ?? [])
        let changed = true
        const replace = (e: CExpr): CExpr | undefined => {
            if (e.k !== 'op' || e.op !== 'pre') return undefined
            const operand = e.args[0]
            if (operand?.k !== 'ref') return undefined
            if (containsPre(operand)) return undefined
            const v = operand.v
            if (!v.scope) return undefined
            changed = true
            let preVar = transformed.get(v)
            if (!preVar) {
                preVar = createPre(v, e.args[1])
                transformed.set(v, preVar)
            }
            return { ...ref(preVar), idx: operand.idx, span: e.span }
        }
        while (changed) {
            changed = false
            for (const site of allActionSites(ctx.root)) {
                const holder = site.transition ?? site.action!
                if (holder.trigger) holder.trigger = mapExpr(holder.trigger, replace)
                holder.effects = holder.effects.map(f => mapEffect(f, replace))
            }
            // Inside a declaration's initial value (KIELER replaces it there too; the Initialization processor
            // later turns it into an entry assignment).
            for (const scope of allScopes(ctx.root)) {
                for (const v of scope.decls) if (v.init && !isPre(v.init)) v.init = mapExpr(v.init, replace)
            }
        }
    },
}

/**
 * `pre(x)` next to `pre(x, c)` (or two different clocks): KIELER keeps one memory for x, and the last pre of x in the
 * chart decides whether and how it is clocked (above). A kieler-quirk info at each pre whose clock KIELER drops or adds.
 */
function reportSharedClock(ctx: PassContext, v: CVar, decider: PreExpr, rest: PreExpr[]) {
    const clock = decider.args[1]
    const changed = rest.filter(p => !sameExpr(p.args[1], clock))
    if (!changed.length) return
    const name = v.display ?? v.name
    const written = (p: PreExpr) => (p.args[1] ? `pre(${name}, ${clockText(p.args[1])})` : `pre(${name})`)
    const theirs = written(decider)
    const where = decider.span ? ` (line ${decider.span.line})` : ''
    const copy = `${name}Copy`
    for (const p of changed) {
        const mine = written(p)
        const own = clockText(p.args[1])
        const clocked = clock ? clockText(clock) : own
        // Written after it, but earlier in KIELER's order: the trigger of the transition whose effects hold `mine`.
        const trigger = !!p.span && !!decider.span && p.span.start > decider.span.start
        ctx.report({
            severity: 'info', code: 'kieler-quirk', span: p.span,
            message: `In KIELER \`${mine}\` behaves as \`${theirs}\`: KIELER keeps one memory for the previous value of \`${name}\`, made for the last \`pre\` of \`${name}\` in the chart, \`${theirs}\`${where}${trigger ? ' (a transition\'s trigger counts as coming after its effects)' : ''}`,
            hint: (clock
                ? `So \`${mine}\` changes only in ticks in which \`${clocked}\` holds, and the guide's simulation does the same.`
                : `So \`${mine}\` is the value \`${name}\` had in the previous tick, whether \`${own}\` held or not, and the guide's simulation does the same.`)
                + ` To have both, give the clocked one a variable of its own: copy \`${name}\` in every tick (\`immediate during do ${copy} = ${name}\`) and write \`pre(${copy}, ${clocked})\`.`,
        })
    }
}

function containsPre(r: CRef): boolean {
    let found = false
    walkExpr(r, e => { if (e.k === 'op' && e.op === 'pre') found = true })
    return found
}

function neutral(v: CVar): CExpr | undefined {
    const scalar = (): CExpr | undefined => {
        switch (v.type) {
            case 'bool': return lit(false)
            case 'int': return lit(0)
            case 'float': return { k: 'lit', t: 'float', v: 0 }
            case 'string': return { k: 'null' }
            default: return undefined
        }
    }
    let value = scalar()
    if (!value) return undefined
    for (let i = v.dims.length - 1; i >= 0; i--) {
        const d = v.dims[i]
        const n = d.k === 'lit' && typeof d.v === 'number' ? d.v : 0
        const element: CExpr = value
        value = { k: 'vector', values: Array.from({ length: n }, () => ({ ...element })) }
    }
    return value
}

function createPre(v: CVar, clock: CExpr | undefined): CVar {
    const state = owningState(v.scope!)
    const make = (prefix: string, role: string) => {
        const x = new CVar(prefix + v.name, v.type)
        x.dims = v.dims.map(d => ({ ...d }))
        x.combine = v.combine
        x.generated = true
        x.role = role
        x.of = v
        x.display = v.display ?? v.name
        x.decl = v.decl
        x.scope = state
        state.decls.push(x)
        return x
    }
    const reg = make('_reg_', 'reg')
    reg.init = neutral(v)
    const preVar = make('_pre_', 'pre')
    const during = createImmediateDuringAction(state)
    during.about = v.decl
    if (clock) during.trigger = clock
    const o = { hidden: true, by: v.decl }
    if (!v.dims.length) {
        during.effects.unshift({ k: 'assign', ref: ref(reg), op: '=', expr: ref(v), o })
        during.effects.unshift({ k: 'assign', ref: ref(preVar), op: '=', expr: ref(reg), o })
    } else {
        for (const index of indices(v)) {
            during.effects.push({ k: 'assign', ref: ref(reg, index.map(i => lit(i))), op: '=', expr: ref(v, index.map(i => lit(i))), o })
            during.effects.unshift({ k: 'assign', ref: ref(preVar, index.map(i => lit(i))), op: '=', expr: ref(reg, index.map(i => lit(i))), o })
        }
    }
    return preVar
}

function indices(v: CVar): number[][] {
    let out: number[][] = [[]]
    for (const d of v.dims) {
        const n = d.k === 'lit' && typeof d.v === 'number' ? d.v : 0
        out = out.flatMap(prefix => Array.from({ length: n }, (_, i) => [...prefix, i]))
    }
    return out
}

function mapEffect(f: CEffect, fn: (e: CExpr) => CExpr | undefined): CEffect {
    switch (f.k) {
        case 'assign': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(i => mapExpr(i, fn)) }, expr: f.expr ? mapExpr(f.expr, fn) : undefined }
        case 'emit': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(i => mapExpr(i, fn)) }, value: f.value ? mapExpr(f.value, fn) : undefined }
        case 'print': return { ...f, args: f.args.map(a => mapExpr(a, fn)) }
        case 'call': return { ...f, call: mapExpr(f.call, fn) as typeof f.call }
        default: return f
    }
}

export { ref }

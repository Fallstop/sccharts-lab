// KIELER's Pre processor (sccharts/processors/Pre.xtend): every variable used under `pre` gets a register
// `_reg_x` (initialised to the type's default on entry of the declaring state) and `_pre_x`, updated by an
// immediate during action of the declaring state: `_pre_x = _reg_x; _reg_x = x` (concurrency.md PRE-1..PRE-6).
//
// KIELER replaces a `pre(...)` only where its direct container is an assignment, an operator expression, a
// transition trigger or an array index; anywhere else ("Pre expressions are only supported in assignments,
// triggers and other pre expressions") it fails: as an argument of print or a call, as an element of a vector,
// as a declaration's initial value. SCCharts Lab rejects those with a located error, and compiles a `pre(...)`
// that is the whole trigger of a state action with a divergence warning (official KIELER fails on it).
//
// The processor walks the whole model, so the bodies of methods and code blocks are part of it (passes/preBodies.ts:
// their statements as containers, and the operands KIELER's memory cannot name outside the body).

import type { Pass, PassContext } from './context'
import {
    allActionSites, allScopes, createImmediateDuringAction, CAction, CRegion, CVar, lit, mapExpr, owningState, printExpr, ref,
    sameExpr, walkExpr, type CEffect, type CExpr, type CRef, type CState, type CStmt,
} from '../model'
import { declarationsOf, mapBodies, walkBody } from '../structure/bodies'
import { chartVariablesByName, checkOperands, ownField, writtenPre, type PreExpr } from './preBodies'

const KIELER_PLACEMENT = 'Pre expressions are only supported in assignments, triggers and other pre expressions'
const UNSUPPORTED = 'The official KIELER compiler cannot compile this either: it only accepts `pre(...)` in an assignment, a transition trigger, an array index or inside a larger expression.'

const isPre = (e: CExpr | undefined): e is PreExpr => e?.k === 'op' && e.op === 'pre'

/** A pre of a variable, or of such a pre (replaced first, it is a variable when KIELER comes to the outer one). */
const ofVariable = (e: PreExpr): boolean => e.args[0]?.k === 'ref' || (isPre(e.args[0]) && ofVariable(e.args[0]))

/**
 * KIELER's placement rules for pre (see above): errors for the places it fails on, the divergence warning. Whether
 * anything was rejected (KIELER's compilation ends with the Pre processor then).
 */
function checkPlacements(ctx: PassContext): boolean {
    let rejected = false
    /** The method whose body is being checked: its names are written as inside it. */
    let method: CVar | undefined
    const preText = (e: PreExpr) => writtenPre(e, method)
    // A body lowered several times (a method of two instances of a class) is one in KIELER's model.
    const reported = new Set<string>()
    const misplaced = (e: PreExpr, message: (text: string) => string, hint: (text: string) => string) => {
        // KIELER's processor only looks at a pre of a variable (Pre.transform: `valuedObjectRef !== null`): one of a
        // value (a constant, a generic parameter given a number) stays where it is, for the C compiler.
        if (!ofVariable(e)) return
        const text = message(preText(e))
        const key = `${e.span?.start}:${text}`
        rejected = true
        if (reported.has(key)) return
        reported.add(key)
        ctx.report({ severity: 'error', code: 'pre-placement', span: e.span, message: text, hint: `${UNSUPPORTED} ${hint(preText(e))}`, kieler: KIELER_PLACEMENT })
    }
    const variableFirst = (t: string) => `Assign the previous value to a variable first, e.g. \`prev = ${t}\`, and use that variable here.`
    // Vectors and call arguments anywhere in an expression.
    const visitExpr = (e: CExpr | undefined) => {
        if (!e) return
        walkExpr(e, x => {
            if (x.k === 'vector') for (const v of x.values) if (isPre(v)) misplaced(v, t => `\`${t}\` cannot be used here`, variableFirst)
            if (x.k === 'call') for (const a of x.args) if (isPre(a)) misplaced(a, t => `\`${t}\` cannot be passed directly as an argument of ${x.name}(...)`, t => `Store the previous value in a variable first, e.g. \`prev = ${t}\`, and pass that variable instead.`)
        })
    }
    const effect = (f: CEffect) => {
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
    // The statements of a body: a condition, a return and a local's initial value hold their expression themselves.
    const condition = (e: CExpr | undefined) => {
        if (isPre(e)) {
            const operand = e.args[0]
            const bool = operand?.k === 'ref' && (operand.v.type === 'bool' || operand.v.type === 'pure' || operand.v.signal)
            misplaced(e, t => `\`${t}\` cannot be used here`, t => `Compare it instead: \`${t}${bool ? ' == true' : ' != 0'}\` means the same, and KIELER compiles \`pre(...)\` inside a comparison.`)
        } else visitExpr(e)
    }
    const body = (list: CStmt[]) => {
        for (const s of list) {
            switch (s.k) {
                case 'do':
                    if (s.init && s.f.k === 'assign' && isPre(s.f.expr)) {
                        const name = s.f.ref.v.display ?? s.f.ref.v.name
                        misplaced(s.f.expr, t => `\`${t}\` cannot be used in the declaration of \`${name}\``, t => `Declare \`${name}\` without a value and assign the previous value in a statement of its own (\`${name} = ${t}\`).`)
                    } else effect(s.f)
                    break
                case 'if': condition(s.cond); body(s.then); if (s.else) body(s.else); break
                case 'while': condition(s.cond); body(s.body); break
                case 'for': body(s.init); condition(s.cond); body(s.update); body(s.body); break
                case 'return':
                    if (isPre(s.expr)) misplaced(s.expr, t => `\`${t}\` cannot be used directly in a return statement`, t => `Assign the previous value to a variable first, e.g. \`prev = ${t}\`, and return that variable.`)
                    else visitExpr(s.expr)
                    break
                case 'expr': visitExpr(s.e); break
                default: break
            }
        }
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
        holder.effects.forEach(effect)
    }
    for (const scope of allScopes(ctx.root)) {
        for (const v of declarationsOf(scope)) {
            if (isPre(v.init)) {
                const name = v.display ?? v.name
                misplaced(v.init, t => `\`${t}\` cannot be used in the declaration of \`${name}\``, () => `Give \`${name}\` a plain initial value and assign the previous value to it in an action instead.`)
            } else {
                visitExpr(v.init)
            }
            // Whether the method is called or not: KIELER's processor walks every body.
            if (v.method) {
                method = v
                body(v.method.body)
                method = undefined
            }
        }
    }
    return rejected
}

/**
 * Every `pre(...)` below the root in KIELER's eAllContents order (pre-order over the containment tree; Pre.xtend
 * collects them so): a scope's declarations (initial value, then cardinalities; a method or code block's body, in
 * the order of structure/bodies.ts), its actions (effects before the trigger: Action's `effects` feature comes
 * first), then a state's regions and its outgoing transitions (effects, then trigger), a region's states. An outer
 * `pre` comes before the ones inside it. `home`: the method whose body holds a pre.
 */
function presInKielerOrder(root: CState, home: Map<PreExpr, CVar>): PreExpr[] {
    const out: PreExpr[] = []
    // (A body two methods share, an array of chart instances' elements, is walked once.)
    const seen = new Set<PreExpr>()
    let method: CVar | undefined
    const expr = (e: CExpr | undefined) => walkExpr(e, x => {
        if (!isPre(x) || seen.has(x)) return
        seen.add(x)
        out.push(x)
        if (method) home.set(x, method)
    })
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
        for (const v of declarationsOf(s)) {
            expr(v.init)
            v.dims.forEach(expr)
            if (v.method) {
                method = v
                walkBody(v.method.body, effect, expr)
                method = undefined
            }
        }
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
        const misplaced = checkPlacements(ctx)
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
        const home = new Map<PreExpr, CVar>()
        const order = presInKielerOrder(ctx.root, home)
        const byName = chartVariablesByName(ctx.root, order, home)
        // KIELER's key of a pre's operand (Pre.expressionKey) cannot have an index on an instance: `pre(os[i].v)`.
        // (Named from inside the class, `pre(v)`, the member has no instance in front of it: preBodies.ts.)
        for (const p of order) {
            const operand = p.args[0]
            if (operand?.k !== 'ref' || ownField(operand, home.get(p)) || !operand.v.member?.of.dims.length || !operand.idx.length) continue
            ctx.report({
                severity: 'error', code: 'kieler-crash', span: p.span ?? operand.span, related: operand.v.decl ? [operand.v.decl] : undefined,
                message: `KIELER cannot take \`pre\` of a member of an array of instances (\`${operand.v.display ?? operand.v.name}\`): its compiler fails`,
                kieler: 'java.lang.IllegalArgumentException: Cannot handle pre operator on arrays of classes',
                hint: 'Copy the member into a variable of its own in every tick (a during action) and take `pre` of that variable.',
            })
            return
        }
        for (let i = order.length - 1; i >= 0; i--) {
            const p = order[i]
            const operand = p.args[0]
            const v = operand?.k === 'ref' ? operand.v : isPre(operand) ? madeFor.get(operand) : undefined
            if (!v || !v.scope) continue
            let preVar = transformed.get(v)
            if (!preVar) {
                // (A clock KIELER's during action cannot name is reported below; the memory is made without it.)
                preVar = createPre(v, usableClock(p.args[1]) ? p.args[1] : undefined, byName.has(p))
                transformed.set(v, preVar)
                deciding.set(v, p)
            } else {
                others.set(v, [...(others.get(v) ?? []), p])
            }
            madeFor.set(p, preVar)
        }
        for (const [v, first] of deciding) reportSharedClock(ctx, v, first, others.get(v) ?? [], home)
        // What KIELER's later stages fail on (it gets there only when its Pre processor reported nothing).
        if (!misplaced) checkOperands(ctx, order, home, new Set(deciding.values()))
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
            // Inside the bodies of methods and code blocks.
            if (order.some(p => home.has(p))) mapBodies(ctx.root, replace)
        }
    },
}

/**
 * `pre(x)` next to `pre(x, c)` (or two different clocks): KIELER keeps one memory for x, and the last pre of x in the
 * chart decides whether and how it is clocked (above). A kieler-quirk info at each pre whose clock KIELER drops or adds.
 */
function reportSharedClock(ctx: PassContext, v: CVar, decider: PreExpr, rest: PreExpr[], home: ReadonlyMap<PreExpr, CVar>) {
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
        // Written after it, but earlier in KIELER's order: the trigger of the transition whose effects hold `mine`,
        // or a code block, which is a method of the state by then (declarations come before actions and transitions).
        const after = !!p.span && !!decider.span && p.span.start > decider.span.start
        const body = home.get(p)
        const trigger = after && !body && !home.has(decider)
        const block = after && !!body?.generated && !body.display
        ctx.report({
            severity: 'info', code: 'kieler-quirk', span: p.span,
            message: `In KIELER \`${mine}\` behaves as \`${theirs}\`: KIELER keeps one memory for the previous value of \`${name}\`, made for the last \`pre\` of \`${name}\` in the chart, \`${theirs}\`${where}${trigger ? ' (a transition\'s trigger counts as coming after its effects)' : block ? ' (a code block counts as a declaration of its state, which comes before the transitions)' : ''}`,
            hint: (clock
                ? `So \`${mine}\` changes only in ticks in which \`${clocked}\` holds, and the guide's simulation does the same.`
                : `So \`${mine}\` is the value \`${name}\` had in the previous tick, whether \`${own}\` held or not, and the guide's simulation does the same.`)
                + ` To have both, give the clocked one a variable of its own: copy \`${name}\` in every tick (\`immediate during do ${copy} = ${name}\`) and write \`pre(${copy}, ${clocked})\`.`,
        })
    }
}

/** A clock the declaring state's during action can test: no parameter or local variable of a body in it. */
function usableClock(clock: CExpr | undefined): boolean {
    let ok = true
    walkExpr(clock, e => { if (e.k === 'ref' && !e.v.scope) ok = false })
    return ok
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

/** `unseen`: the memory reads the variable by name only (preBodies.ts chartVariablesByName). */
function createPre(v: CVar, clock: CExpr | undefined, unseen = false): CVar {
    const state = owningState(v.scope!)
    const make = (prefix: string, role: string) => {
        const x = new CVar(prefix + v.name, v.type)
        x.dims = v.dims.map(d => ({ ...d }))
        // (KIELER copies the declaration's attributes: the memory of a static variable is static too, so the Static
        // pass moves it to the root under its hierarchical name, into the data pool, and it starts once.)
        x.static = v.static && !v.declKind
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
        during.effects.unshift({ k: 'assign', ref: ref(reg), op: '=', expr: unseen ? { ...ref(v), unseen: true } : ref(v), o })
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

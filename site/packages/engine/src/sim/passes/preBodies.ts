// KIELER's Pre processor and the bodies of methods and code blocks (concurrency.md PRE-6): the operands and clocks
// its memory cannot name.
//
// The memory of `pre(x)` lives outside the body: `_reg_x` and `_pre_x` are declared in the state around the
// declaration of `x` (Pre.getParentState: the first state up the containment tree), and that state's during action
// copies the pre's operand as it is written, `_reg_x = x`. For a variable of the chart that is the variable. For a
// name that only means something inside the body it is not:
//
// - a local variable of the body: KIELER's SCG transformation cannot copy the reference ("Can't copy valued object");
// - a parameter: the during action reads `d->v` in KIELER's C code, and the chart's data has no `v`;
// - a field of a class named from inside the class (`pre(v)` in a method of the class, also of a chart used as a
//   class): the same `d->v`. Through the object (`pre(k.v)`, in the class's own method too) it is `d->k.v` and works.
//
// The same holds for the clock of the pre that makes the memory (the during action's trigger); the clock of any
// other pre of the variable is dropped with it. KIELER fails whether or not the method is called.

import type { PassContext } from './context'
import { allScopes, printExpr, walkExpr, type CExpr, type CRef, type CState, type CVar } from '../model'
import { GCC_FAILED } from '../codegen'
import { methodsOf } from '../structure/bodies'

export type PreExpr = Extract<CExpr, { k: 'op' }>

/**
 * A field of a class named from inside the class, in a body of `method` (or anywhere in the class, `own`): the object
 * and the name as written there (`v`, `l.w`), whose first part KIELER's C code looks up in the chart's data.
 */
export function ownField(r: CRef, method: CVar | undefined): { path: string; name: string; object: CVar } | undefined {
    // A chart used as a class (`ref C g`): what its methods name are the chart's own declarations, the fields.
    // (A code block of the chart's own actions is no method of the class: KIELER moves it out with them.)
    const instance = r.own ? undefined : method?.classInstance
    if (!r.own && !instance) return undefined
    const names: string[] = []
    for (let x: CVar | undefined = r.v; x?.member; x = x.member.of) {
        names.unshift(x.member.name)
        if (instance ? x.member.of === instance : x.member.name === r.own) return { path: names.join('.'), name: names[0], object: x.member.of }
    }
    return r.own && r.v.member ? { path: r.own, name: r.own, object: r.v.member.of } : undefined
}

/** `pre(x)`, `pre(x, c)` as the reader wrote it in a body of `method`. */
export function writtenPre(p: PreExpr, method: CVar | undefined, clock = true): string {
    const name = (e: CExpr | undefined): string => {
        // (The Signal pass ran: `S_val` is `val(S)` to the reader.)
        if (e?.k === 'ref') {
            const base = ownField(e, method)?.path ?? (e.v.role === 'value' ? `val(${e.v.display ?? e.v.name})` : e.v.display ?? e.v.name)
            // (The indices as written: `pre(a[1])` is another thing to fix than `pre(a)`.)
            let last = e
            while (last.sub) last = last.sub
            return base + last.idx.map(i => `[${printExpr(i)}]`).join('')
        }
        return e?.k === 'op' && e.op === 'pre' ? writtenPre(e, method) : '...'
    }
    return clock && p.args[1] ? `pre(${name(p.args[0])}, ${name(p.args[1])})` : `pre(${name(p.args[0])})`
}

/**
 * KIELER's during action for the memory reads the operand, and the clock, by name in the chart's data (`d->v`). So a
 * parameter, or a class's field named from inside the class, that has the name of a variable of the chart is that
 * variable to the memory: `method int last(int v) { return pre(v) + 1 }` with `input int v` gives the previous value
 * of the input, whatever the call passes (probes pre/probe-pre-method-name-of-chart-*). Arrays are left alone: the
 * chart's array there is gcc's error.
 */
export function chartVariablesByName(root: CState, order: PreExpr[], home: ReadonlyMap<PreExpr, CVar>): Set<PreExpr> {
    const redirected = new Set<PreExpr>()
    const params = new Set<CVar>()
    const byName = new Map<string, CVar>()
    for (const scope of allScopes(root)) {
        for (const m of methodsOf(scope)) for (const p of m.method!.params) params.add(p)
        for (const v of scope.decls) if (!v.member && !v.method && !v.declKind && !v.dims.length && !byName.has(v.name)) byName.set(v.name, v)
    }
    for (const p of order) {
        const method = home.get(p)
        if (!method) continue
        const redirect = (e: CExpr | undefined): boolean | undefined => {
            if (e?.k !== 'ref') return
            const name = params.has(e.v) && !e.sub ? e.v.name : ownField(e, method)?.path
            const chart = name === undefined ? undefined : byName.get(name)
            if (!chart || chart === e.v) return
            const r = e as { v: CVar; sub?: CRef; own?: string; idx: CExpr[]; unseen?: boolean }
            r.v = chart
            r.sub = undefined
            r.own = undefined
            r.idx = []
            // The model's object is the parameter or the field: no dependency orders this read (model.ts `unseen`).
            r.unseen = true
            return true
        }
        if (redirect(p.args[0])) redirected.add(p)
        walkExpr(p.args[1], e => { redirect(e) })
    }
    return redirected
}

/**
 * `order`: every pre of the chart; `home`: the method whose body holds a pre; `deciding`: the pres that made a
 * memory (their clocks are the during actions' triggers).
 */
export function checkOperands(ctx: PassContext, order: PreExpr[], home: ReadonlyMap<PreExpr, CVar>, deciding: ReadonlySet<PreExpr>) {
    const frames = new Map<CVar, { method: CVar; param: boolean }>()
    for (const scope of allScopes(ctx.root)) {
        for (const m of methodsOf(scope)) {
            for (const p of m.method!.params) frames.set(p, { method: m, param: true })
            for (const l of m.method!.locals) frames.set(l, { method: m, param: false })
        }
    }
    const bodyOf = (m: CVar) => (m.generated && !m.display ? 'a code block' : `the method \`${(m.display ?? m.name).split('.').pop()}\``)
    const written = (p: PreExpr) => writtenPre(p, home.get(p))
    type Use = { p: PreExpr; r: CRef; clock: boolean }
    const locals: Use[] = []
    const params: Use[] = []
    const fields: (Use & { path: string; name: string; object: CVar })[] = []
    for (const p of order) {
        const uses: Use[] = []
        if (p.args[0]?.k === 'ref') uses.push({ p, r: p.args[0], clock: false })
        if (deciding.has(p) || p.args[0]?.k === 'ref' && frames.has(p.args[0].v)) walkExpr(p.args[1], e => { if (e.k === 'ref') uses.push({ p, r: e, clock: true }) })
        for (const u of uses) {
            const frame = frames.get(u.r.v)
            const f = frame ? undefined : ownField(u.r, home.get(p))
            if (frame) (frame.param ? params : locals).push(u)
            else if (f) fields.push({ ...u, ...f })
        }
    }
    const reported = new Set<string>()
    const once = (u: Use, code: string): boolean => {
        // (A body lowered once per instance of its class is one in KIELER's model.)
        const at = u.r.span?.start ?? u.p.span?.start
        const key = `${code}:${at ?? u.r.v.name}`
        if (reported.has(key)) return false
        reported.add(key)
        return true
    }
    // The SCG transformation comes before the C compiler: a local variable is what KIELER reports.
    for (const u of locals) {
        if (!once(u, 'local')) continue
        const name = u.r.v.name
        const where = bodyOf(frames.get(u.r.v)!.method)
        ctx.report({
            severity: 'error', code: 'kieler-crash', span: u.p.span ?? u.r.span, related: u.r.v.decl ? [u.r.v.decl] : undefined,
            message: u.clock
                ? `KIELER cannot use \`${name}\`, a local variable of ${where}, as the clock of \`${written(u.p)}\`: its compiler fails`
                : `KIELER cannot take \`pre\` of \`${name}\`, a local variable of ${where}: its compiler fails`,
            kieler: 'java.lang.IllegalArgumentException: Can\'t copy valued object. Valued object is null!',
            hint: u.clock
                ? `KIELER updates the memory of \`pre\` in every tick, outside ${where}, where \`${name}\` does not exist. Use a variable of the chart as the clock.`
                : `KIELER keeps the previous value in the chart and updates it in every tick, outside ${where}, where \`${name}\` does not exist (and a local variable is new in every call). Declare \`${name}\` in the chart instead and take \`pre\` of that.`,
        })
    }
    if (locals.length) return
    for (const u of params) {
        if (!once(u, 'param')) continue
        const name = u.r.v.name
        const where = bodyOf(frames.get(u.r.v)!.method)
        ctx.report({
            severity: 'error', code: 'pre-parameter', span: u.p.span ?? u.r.span, related: u.r.v.decl ? [u.r.v.decl] : undefined,
            message: u.clock
                ? `\`${written(u.p)}\` does not compile in KIELER: its clock \`${name}\` is a parameter of ${where}`
                : `\`${written(u.p)}\` does not compile in KIELER: \`${name}\` is a parameter of ${where}`,
            kieler: `‘TickData’ has no member named ‘${name}’\n${GCC_FAILED}`,
            hint: u.clock
                ? `KIELER updates the memory of \`pre\` in every tick, outside ${where}, where it looks for a variable \`${name}\` of the chart. Use a variable of the chart as the clock.`
                : `KIELER keeps the previous value in the chart and updates it in every tick, outside ${where}, where it looks for a variable \`${name}\` of the chart. Take \`pre\` of a variable of the chart: inside the method, or where the method is called (\`prev = pre(x)\`, then pass \`prev\`).`,
        })
    }
    for (const u of fields) {
        if (!once(u, 'field')) continue
        const object = u.object.display ?? u.object.name
        const array = u.object.dims.length > 0
        const through = `${object}${array ? '[i]' : ''}.${u.path}`
        ctx.report({
            severity: 'error', code: 'pre-class-field', span: u.p.span ?? u.r.span, related: u.r.v.decl ? [u.r.v.decl] : undefined,
            message: u.clock
                ? `\`${written(u.p)}\` does not compile in KIELER: its clock \`${u.name}\` is a field of \`${object}\`, named from inside its class`
                : `\`${written(u.p)}\` does not compile in KIELER: \`${u.name}\` is a field of \`${object}\`, named from inside its class`,
            kieler: `‘TickData’ has no member named ‘${u.name}’\n${GCC_FAILED}`,
            hint: `KIELER ${u.clock ? 'updates the memory of `pre`' : 'keeps the previous value in the chart and updates it'} in every tick, outside the class, where it looks for a variable \`${u.name}\` of the chart itself. `
                + (array ? `Copy \`${through}\` into a variable of the chart in every tick and ${u.clock ? 'use that variable as the clock' : 'take `pre` of that variable'}.`
                    : u.clock ? `Use a variable of the chart as the clock.`
                        : `Name the field through the object, in the chart that declares \`${object}\` (\`pre(${through})\`), and pass the value to the method.`),
        })
    }
}

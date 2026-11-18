// The first half of KIELER's User Schedule processor (sccharts/processors/UserSchedule.xtend, transformContracts):
// the schedule clause of a method declaration is the method's contract (structure.md S-27a).
//
// - "Handle default schedule for host classes": a host class with methods without a schedule gets one of its own that
//   orders the methods as they are declared.
// - "Handle Method SDs": the contract of a method is copied onto what calls it: the effect around the call (also a
//   statement of a method body), or the trigger; a call in a condition or a `return` of a method body gets nothing.
//   The copies are marked with the method's name (KIELER's method specific scheduling directive, deps.ts).
// - "Handle Class SDs": the schedules of classes move into the chart, one per instance (lower.ts classSchedule did
//   that). A contract's schedule has to be a class's: KIELER reads the class of every contract's schedule and throws
//   for one declared in the chart. What still names a class's schedule without an instance afterwards is an error:
//   the contract of a method nobody calls, and the copy on a call by the method's name alone (inside the class).
//
// Runs with the User Schedule pass, after every other transformation, on all calls of the chart, reachable or not.

import type { Declaration, Diagnostic, Span } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import { allScopes, CVar, isRegion, walkExpr, type CAction, type CEffect, type CExpr, type CRef, type CStmt, type CTransition, type SchedEntry } from '../model'
import type { PassContext } from './context'
import { isInlined } from '../structure/methods'

type Call = Extract<CExpr, { k: 'call' }>

/** Where a call is written, as far as KIELER's search for the "scheduling unit" goes. */
type Site =
    | { kind: 'effect'; f: CEffect }
    | { kind: 'trigger'; holder: CTransition | CAction }
    /** The initial value of a local declaration that is the call itself. */
    | { kind: 'init'; f: Extract<CEffect, { k: 'assign' }>; used: boolean }
    /** A condition or a `return` of a method body: nothing to attach to. */
    | { kind: 'none' }

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

function effectExpressions(f: CEffect): (CExpr | undefined)[] {
    switch (f.k) {
        case 'assign': return [...f.ref.idx, f.expr]
        case 'emit': return [...f.ref.idx, f.value]
        case 'print': return f.args
        case 'call': return [f.call]
        default: return []
    }
}

export function transformContracts(ctx: PassContext) {
    const scopes = allScopes(ctx.root)
    const methods: CVar[] = scopes.flatMap(scope => scope.decls.filter(v => v.method))
    /** Declarations of the methods that are called somewhere (KIELER clears the contract of those). */
    const handled = new Set<string | CVar>()
    /** Host methods are no variables of the model: the declarations their calls name. */
    const calledHost = new Set<string>()
    const keyOf = (v: CVar) => v.decl ?? v
    /** The method as the chart names it (a chart instance's method is the variable `_x_get`). */
    const say = (v: CVar) => (v.classInstance ? `${v.classInstance.name}.${v.decl?.slice(v.decl.lastIndexOf('$') + 1) ?? v.name}` : v.display ?? v.name)
    let crash: { v: CVar; entry: SchedEntry; span?: Span } | undefined
    const reported = new Set<string>()
    const once = (d: Diagnostic) => {
        const key = `${d.code}:${d.span?.start}:${d.message}`
        if (reported.has(key)) return
        reported.add(key)
        ctx.report(d)
    }

    /** The methods some call names. */
    const calledVars = new Set<CVar>()
    const note = (e: CExpr | undefined) => walkExpr(e, x => { if (x.k === 'call' && x.target?.v.method) calledVars.add(x.target.v) })
    const noteStatements = (list: CStmt[]) => {
        for (const st of list) {
            if (st.k === 'do') effectExpressions(st.f).forEach(note)
            else if (st.k === 'if') { note(st.cond); noteStatements(st.then); if (st.else) noteStatements(st.else) }
            else if (st.k === 'while') { note(st.cond); noteStatements(st.body) }
            else if (st.k === 'for') { noteStatements(st.init); note(st.cond); noteStatements(st.update); noteStatements(st.body) }
            else if (st.k === 'return') note(st.expr)
            else if (st.k === 'expr') note(st.e)
        }
    }
    for (const scope of scopes) {
        for (const holder of [...scope.actions, ...(isRegion(scope) ? [] : scope.out)]) {
            note(holder.trigger)
            for (const f of holder.effects) effectExpressions(f).forEach(note)
        }
    }
    for (const v of methods) noteStatements(v.method!.body)

    const visit = (e: CExpr | undefined, site: Site) => walkExpr(e, x => {
        if (x.k !== 'call' || x.extern || !x.target) return
        const low = lowermost(x.target)
        if (x.target.sub && low.v.decl) calledHost.add(low.v.decl)
        const contract = x.target.v.method?.schedule
        if (!contract?.length) return
        const v = x.target.v
        handled.add(keyOf(v))
        const outside = contract.find(c => !(c.group instanceof CVar) || c.group.scheduleOf === undefined)
        if (outside) {
            crash ??= { v, entry: outside, span: x.span }
            return
        }
        if (site.kind === 'none') return
        if (x.bare && site.kind !== 'trigger') {
            once({
                severity: 'error', code: 'contract-sibling-call', span: x.span, related: v.decl ? [v.decl] : undefined,
                message: `\`${x.name}\` has a contract (\`schedule ...\` on its declaration), and KIELER cannot compile a call of it from another method of the same class`,
                kieler: `Referring to scheduling directive in classes without reference to instance (${(contract[0].group as CVar).scheduleOf})`,
                hint: `KIELER copies the contract onto the calling statement, and inside the class the copy names the class's schedule without an instance. Call \`${x.name}\` from the chart (\`${(contract[0].group as CVar).scheduleOf}.${x.name}(...)\`), or remove the clause from its declaration.`,
            })
            return
        }
        const copies: SchedEntry[] = contract.map(c => ({ group: c.group, priority: c.priority, method: c.method }))
        if (site.kind === 'trigger') {
            const trigger = site.holder.trigger!
            site.holder.trigger = { ...trigger, sched: [...(trigger.sched ?? []), ...copies] }
        } else {
            // On an initial value that is the call, KIELER puts the copy on the call itself, and its Methods processor
            // refuses to inline a call with a schedule (in a method it looks at: one that is called).
            if (site.kind === 'init' && site.used && isInlined(v.method!)) {
                once({
                    severity: 'error', code: 'schedule-inlined-call', span: x.span, related: v.decl ? [v.decl] : undefined,
                    message: `KIELER cannot compile this initial value: \`${x.name}\` has a contract, and KIELER copies the short method into place`,
                    kieler: 'User schedules are not supported in combination with method inlining!',
                    hint: `Declare the variable without a value and assign it in a statement of its own (\`k = ${x.name}()\`).`,
                })
            }
            site.f.o = { ...site.f.o, schedule: [...(site.f.o.schedule ?? []), ...copies] }
        }
    })

    const effect = (f: CEffect) => { for (const e of effectExpressions(f)) visit(e, { kind: 'effect', f }) }
    const statements = (list: CStmt[], used: boolean) => {
        for (const st of list) {
            switch (st.k) {
                case 'do':
                    if (st.init && st.f.k === 'assign' && st.f.expr?.k === 'call') visit(st.f.expr, { kind: 'init', f: st.f, used })
                    else effect(st.f)
                    break
                case 'if': visit(st.cond, { kind: 'none' }); statements(st.then, used); if (st.else) statements(st.else, used); break
                case 'while': visit(st.cond, { kind: 'none' }); statements(st.body, used); break
                case 'for': statements(st.init, used); visit(st.cond, { kind: 'none' }); statements(st.update, used); statements(st.body, used); break
                case 'return': visit(st.expr, { kind: 'none' }); break
                case 'expr': visit(st.e, { kind: 'none' }); break
                default: break
            }
        }
    }
    for (const scope of scopes) {
        const holders: (CTransition | CAction)[] = [...scope.actions, ...(isRegion(scope) ? [] : scope.out)]
        for (const holder of holders) {
            // The trigger as it is now: a copy on it makes a new expression, and the walk is over the old one.
            if (holder.trigger) visit(holder.trigger, { kind: 'trigger', holder })
            for (const f of holder.effects) effect(f)
        }
    }
    for (const v of methods) statements(v.method!.body, calledVars.has(v))

    if (crash) {
        const { v, entry } = crash
        const name = say(v)
        const schedule = entry.group instanceof CVar ? entry.group.display ?? entry.group.name : 'the schedule'
        ctx.report({
            severity: 'error', code: 'kieler-crash', span: v.method?.schedule?.[0]?.span ?? v.span, related: v.decl ? [v.decl] : undefined,
            message: v.member
                ? `KIELER's compiler crashes on this chart: the contract of \`${name}\` names \`${schedule}\`, a schedule declared outside the class`
                : `KIELER's compiler crashes on this chart: \`${name}\` is declared with a schedule (\`schedule ${schedule} ${entry.priority}\`), which only a method of a class may have`,
            kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.kext.ClassDeclaration.getValuedObjects()" because the return value of "de.cau.cs.kieler.kexpressions.extensions.KExpressionsDeclarationExtensions.getEnclosingClass(de.cau.cs.kieler.kexpressions.Declaration)" is null',
            hint: v.member
                ? `A method's contract has to name a schedule of its own class. Declare \`schedule ${schedule}\` inside the class.`
                : `A schedule clause on a method declaration is a contract of a class. Write the clause where \`${name}\` is called (\`do ${name}() schedule ${schedule} ${entry.priority}\`) or on the statements of its body.`,
        })
    }

    // A contract nobody copied still names the class's schedule without an instance.
    for (const v of methods) {
        const contract = v.method!.schedule
        const own = contract?.find(c => c.group instanceof CVar && c.group.scheduleOf !== undefined)
        if (!own || handled.has(keyOf(v))) continue
        handled.add(keyOf(v))
        const instance = (own.group as CVar).scheduleOf!
        ctx.report({
            severity: 'error', code: 'contract-never-called', span: own.span ?? v.span, related: v.decl ? [v.decl] : undefined,
            message: `\`${say(v)}\` has a contract (\`schedule ...\` on its declaration) but is never called, which KIELER cannot compile`,
            kieler: `Referring to scheduling directive in classes without reference to instance (${instance})`,
            hint: `KIELER copies a method's contract onto its calls and gives up on one that is left over. Call the method somewhere, or remove the clause from its declaration.`,
        })
    }

    hostClasses(ctx, scopes.flatMap(scope => scope.decls), calledHost)
}

/**
 * Host classes: KIELER gives a host class with a method without a schedule, and at least one more method, a schedule
 * `_defaultSD` with one priority per method in the order they are declared. Every method then has a contract, and
 * the rule for contracts nobody copied applies: a method of such a host class that is never called is an error.
 */
function hostClasses(ctx: PassContext, vars: CVar[], called: Set<string>) {
    const index = ctx.shared.index as ModelIndex | undefined
    const done = new Set<Declaration>()
    for (const v of vars) {
        if (!v.tags.has('#host') || v.declKind !== 'class' || !v.decl) continue
        const decl = index?.vos.get(v.decl)?.decl
        if (!decl || done.has(decl)) continue
        done.add(decl)
        const members = decl.members ?? []
        const methods = members.filter(m => m.declKind === 'method')
        const own = new Set(members.filter(m => m.declKind === 'schedule').flatMap(m => m.valuedObjects.map(vo => vo.id)))
        const without = methods.filter(m => !m.schedule?.length)
        const defaultSchedule = without.length > 0 && (without.length > 1 || without.length < methods.length)
        const contract = (m: Declaration) => defaultSchedule || !!m.schedule?.some(s => s.ref.decl !== undefined && own.has(s.ref.decl))
        const idle = methods.find(m => contract(m) && !m.valuedObjects.some(vo => called.has(vo.id)))
        if (!idle) continue
        const name = idle.valuedObjects[0]?.name ?? ''
        ctx.report({
            severity: 'error', code: 'contract-never-called', span: idle.valuedObjects[0]?.nameSpan ?? idle.span, related: idle.valuedObjects[0] ? [idle.valuedObjects[0].id] : undefined,
            message: `The method \`${name}\` of the host class \`${v.name}\` is never called, which KIELER cannot compile`,
            kieler: `Referring to scheduling directive in classes without reference to instance (${v.name})`,
            hint: defaultSchedule
                ? `KIELER orders the methods of a host class as they are declared and needs a call of every one of them. Call \`${v.name}.${name}()\` somewhere, or remove the method from the class.`
                : `KIELER copies a method's contract onto its calls and gives up on one that is left over. Call \`${v.name}.${name}()\` somewhere, or remove the clause from its declaration.`,
        })
    }
}

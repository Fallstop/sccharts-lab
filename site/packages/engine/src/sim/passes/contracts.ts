// The first half of KIELER's User Schedule processor (sccharts/processors/UserSchedule.xtend, transformContracts):
// the schedule clause of a method declaration is the method's contract (structure.md S-27a).
//
// - "Handle default schedule for host classes": a host class with methods without a schedule gets one of its own that
//   orders the methods as they are declared.
// - "Handle Method SDs": the contract of a method is copied onto what calls it: the effect around the call (also a
//   statement of a method body), or the trigger; a call in a condition or a `return` of a method body gets nothing.
//   The copies are marked with the method's name (KIELER's method specific scheduling directive, deps.ts).
// - "Handle Class SDs": the schedules of classes move into the chart, one per instance (lower.ts classSchedule did
//   that). A contract's schedule has to be a class's, named alone: KIELER reads the class of every contract's schedule
//   and throws for anything else. What still names a class's schedule without an instance afterwards is an error: the
//   contract of a method nobody calls, the copy on a call by the method's name alone (inside the class), and a clause
//   or an expression inside the class that names the schedule (classSchedules).
//
// Runs with the User Schedule pass, after every other transformation, on all calls of the chart, reachable or not. By
// then a chart used as a class (`ref C x`) is the class of `x` (passes/reference.ts): its declarations are the
// class's members, its regions and actions are the declaring chart's (KIELER rewrites their references to `x.s`).

import type { Declaration, Diagnostic, Span } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import { allScopes, CVar, isRegion, walkExpr, type CAction, type CEffect, type CExpr, type CRef, type CStmt, type CTransition, type SchedEntry, type Scope } from '../model'
import type { PassContext } from './context'

type Call = Extract<CExpr, { k: 'call' }>

/** Where a call is written, as far as KIELER's search for the "scheduling unit" goes. */
type Site =
    | { kind: 'effect'; f: CEffect }
    | { kind: 'trigger'; holder: CTransition | CAction }
    /** The initial value of a local declaration that is a call (`top`), with the call somewhere in it. */
    | { kind: 'init'; f: Extract<CEffect, { k: 'assign' }>; top: Call }
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

/** The instance a method belongs to: a class's, or a chart used as a class (`ref C x`). */
const instanceOf = (v: CVar): CVar | undefined => v.member?.of ?? v.classInstance

/** A schedule's name as it is declared (`s` of the instance's `c.s`). */
const declared = (v: CVar): string => (v.display ?? v.name).split('.').pop()!

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

    classSchedules(scopes, once)

    const visit = (e: CExpr | undefined, site: Site, inClass = false) => walkExpr(e, x => {
        if (x.k !== 'call' || x.extern || !x.target) return
        const low = lowermost(x.target)
        if (x.target.sub && low.v.decl) calledHost.add(low.v.decl)
        const contract = x.target.v.method?.schedule
        if (!contract?.length) return
        const v = x.target.v
        handled.add(keyOf(v))
        // KIELER takes the declaration of what the clause names first as a schedule's, and the class around it.
        const outside = contract.find(c => !(c.group instanceof CVar) || c.qualified || c.group.declKind !== 'schedule' || c.group.scheduleOf === undefined)
        if (outside) {
            crash ??= { v, entry: outside, span: x.span }
            return
        }
        if (site.kind === 'none') return
        if (x.bare && inClass) {
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
            // On an initial value KIELER puts the copy on the value itself: on the outermost call, whose method its
            // Methods processor then refuses to copy into place (structure/methods.ts bodyProblems).
            if (site.kind === 'init') site.top.contract = true
            site.f.o = { ...site.f.o, schedule: [...(site.f.o.schedule ?? []), ...copies] }
        }
    })

    const effect = (f: CEffect, inClass: boolean) => { for (const e of effectExpressions(f)) visit(e, { kind: 'effect', f }, inClass) }
    const statements = (list: CStmt[], inClass: boolean) => {
        const none = (e: CExpr | undefined) => visit(e, { kind: 'none' }, inClass)
        for (const st of list) {
            switch (st.k) {
                case 'do':
                    if (st.init && st.f.k === 'assign' && st.f.expr?.k === 'call') visit(st.f.expr, { kind: 'init', f: st.f, top: st.f.expr }, inClass)
                    else effect(st.f, inClass)
                    break
                case 'if': none(st.cond); statements(st.then, inClass); if (st.else) statements(st.else, inClass); break
                case 'while': none(st.cond); statements(st.body, inClass); break
                case 'for': statements(st.init, inClass); none(st.cond); statements(st.update, inClass); statements(st.body, inClass); break
                case 'return': none(st.expr); break
                case 'expr': none(st.e); break
                default: break
            }
        }
    }
    for (const scope of scopes) {
        const holders: (CTransition | CAction)[] = [...scope.actions, ...(isRegion(scope) ? [] : scope.out)]
        for (const holder of holders) {
            // The trigger as it is now: a copy on it makes a new expression, and the walk is over the old one.
            if (holder.trigger) visit(holder.trigger, { kind: 'trigger', holder })
            for (const f of holder.effects) effect(f, false)
        }
    }
    for (const v of methods) statements(v.method!.body, instanceOf(v) !== undefined)

    if (crash) {
        const { v, entry } = crash
        const name = say(v)
        const group = entry.group instanceof CVar ? entry.group : undefined
        const schedule = group ? group.display ?? group.name : 'the schedule'
        const where = { span: entry.span ?? v.method?.schedule?.[0]?.span ?? v.span, related: v.decl ? [v.decl] : undefined }
        const cast = (found: string) => `java.lang.ClassCastException: class ${found} cannot be cast to class de.cau.cs.kieler.kexpressions.ScheduleDeclaration`
        if (group && entry.qualified) {
            ctx.report({
                severity: 'error', code: 'kieler-crash', ...where,
                message: `KIELER's compiler crashes on this chart: the contract of \`${name}\` names a schedule through an instance (\`schedule ${schedule} ${entry.priority}\`)`,
                kieler: cast('de.cau.cs.kieler.sccharts.impl.PolicyClassDeclarationImpl'),
                hint: `A method's contract names a schedule of its own class by its name alone (\`schedule ${declared(group)} ${entry.priority}\`, declared in the class of \`${name}\`). To order the calls of \`${name}\` with another object's schedule, write the clause where it is called.`,
            })
        } else if (group && group.declKind !== 'schedule') {
            ctx.report({
                severity: 'error', code: 'kieler-crash', ...where,
                message: `\`${schedule}\` is not a schedule, so KIELER's compiler crashes on the contract of \`${name}\` (\`schedule ${schedule} ${entry.priority}\`)`,
                kieler: cast('de.cau.cs.kieler.kexpressions.impl.VariableDeclarationImpl'),
                hint: 'After `schedule` comes the name of a schedule object, declared as `schedule t` in the method\'s class.',
            })
        } else {
            ctx.report({
                severity: 'error', code: 'kieler-crash', ...where,
                message: v.member
                    ? `KIELER's compiler crashes on this chart: the contract of \`${name}\` names \`${schedule}\`, a schedule declared outside the class`
                    : `KIELER's compiler crashes on this chart: \`${name}\` is declared with a schedule (\`schedule ${schedule} ${entry.priority}\`), which only a method of a class may have`,
                kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.kext.ClassDeclaration.getValuedObjects()" because the return value of "de.cau.cs.kieler.kexpressions.extensions.KExpressionsDeclarationExtensions.getEnclosingClass(de.cau.cs.kieler.kexpressions.Declaration)" is null',
                hint: v.member
                    ? `A method's contract has to name a schedule of its own class. Declare \`schedule ${schedule}\` inside the class.`
                    : `A schedule clause on a method declaration is a contract of a class. Write the clause where \`${name}\` is called (\`do ${name}() schedule ${schedule} ${entry.priority}\`) or on the statements of its body.`,
            })
        }
    }

    // A contract nobody copied still names the class's schedule without an instance.
    for (const v of methods) {
        const contract = v.method!.schedule
        // (Named through an instance, `schedule c.s 0`, KIELER finds the instance.)
        const own = contract?.find(c => c.group instanceof CVar && c.group.scheduleOf !== undefined && !c.qualified)
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
 * "Handle Class SDs": what KIELER refuses about the schedules of classes, used or not, once the charts used as classes
 * are expanded. A schedule two classes deep (`Scheduling declarations in nested classes are not yet supported`; a
 * third level is not looked at), one in a class with an array of instances (`... with cardinalities ...`), and every
 * reference to a class's schedule that does not go through an instance: a clause on a statement or a condition of one
 * of the class's methods, and the schedule read as a value in a method or in a member's initial value.
 */
function classSchedules(scopes: Scope[], report: (d: Diagnostic) => void) {
    const seen = new Set<string | CVar>()
    for (const scope of scopes) {
        for (const v of scope.decls) {
            if (v.declKind !== 'schedule' || !v.scheduleDepth) continue
            const name = declared(v)
            if (v.scheduleDepth === 2 && !seen.has(v.decl ?? v)) {
                seen.add(v.decl ?? v)
                report({
                    severity: 'error', code: 'schedule-nested-class', span: v.span, related: v.decl ? [v.decl] : undefined,
                    message: `KIELER cannot compile the schedule \`${name}\` because it is declared in a class inside a class`,
                    kieler: `Scheduling declarations in nested classes are not yet supported (${name})`,
                    hint: `Declare \`schedule ${name}\` in the outer class or in the chart. A chart used as a class (\`ref C x\`) counts as a class around everything it declares.`,
                })
            }
            const inst = v.scheduleInstance
            if (v.scheduleDepth === 1 && inst?.dims.length && !seen.has(inst)) {
                seen.add(inst)
                report({
                    severity: 'error', code: 'schedule-class-array', span: inst.span, related: v.decl ? [v.decl] : undefined,
                    message: `KIELER cannot compile the schedule \`${v.display ?? v.name}\` of a class with an array of instances (\`${inst.name}\`)`,
                    kieler: `Scheduling declarations in nested classes with cardinalities are not yet supported (${inst.name})`,
                    hint: 'Declare single instances (`C a, b`, `ref C a, b`), or declare the schedule in the chart.',
                })
            }
        }
    }

    const isBare = (e: SchedEntry) => !e.qualified && e.method === undefined && e.group instanceof CVar && e.group.scheduleOf !== undefined
    const clause = (list: SchedEntry[] | undefined) => {
        const e = list?.find(isBare)
        if (!e) return
        const v = e.group as CVar
        const name = declared(v)
        report({
            severity: 'error', code: 'schedule-without-instance', span: e.span, related: v.decl ? [v.decl] : undefined,
            message: `\`schedule ${name} ${e.priority}\` inside the class names the class's own schedule, which KIELER cannot compile in a statement`,
            kieler: `Referring to scheduling directive in classes without reference to instance (${v.scheduleOf})`,
            hint: `Write the clause on the method's declaration (\`void m() schedule ${name} ${e.priority} { ... }\`): it then applies to every call of the method. In a statement, use a schedule declared in the chart.`,
        })
    }
    const value = (e: CExpr | undefined) => walkExpr(e, x => {
        clause(x.sched)
        if (x.k !== 'ref' || x.v.declKind !== 'schedule' || x.v.scheduleOf === undefined) return
        const name = declared(x.v)
        report({
            severity: 'error', code: 'schedule-without-instance', span: x.span ?? x.v.span, related: x.v.decl ? [x.v.decl] : undefined,
            message: `\`${name}\` is the class's schedule, which KIELER cannot compile where a value is read`,
            kieler: `Referring to scheduling directive in classes without reference to instance (${x.v.scheduleOf})`,
            hint: `A schedule has no value: it only orders what a \`schedule ${name} ...\` clause is written on. Remove \`${name}\` from the expression.`,
        })
    })
    const statements = (list: CStmt[]) => {
        for (const st of list) {
            switch (st.k) {
                case 'do': clause(st.f.o.schedule); if (st.f.k === 'assign' || st.f.k === 'emit') st.f.ref.idx.forEach(value); effectExpressions(st.f).forEach(value); break
                case 'if': value(st.cond); statements(st.then); if (st.else) statements(st.else); break
                case 'while': value(st.cond); statements(st.body); break
                case 'for': statements(st.init); value(st.cond); statements(st.update); statements(st.body); break
                case 'return': value(st.expr); break
                case 'expr': value(st.e); break
                default: break
            }
        }
    }
    for (const scope of scopes) {
        for (const v of scope.decls) if (v.method && instanceOf(v)) statements(v.method.body)
        // A member's initial value is an entry action by now (the Initialization pass).
        for (const a of scope.actions) for (const f of a.effects) if (f.k === 'assign' && f.o.init !== undefined && instanceOf(f.ref.v)) value(f.expr)
    }
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

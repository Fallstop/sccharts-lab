// Lowering: the resolved AST of one scchart (types.ts) becomes the simulator's working model (model.ts).
//
// Besides the plain copy this does what KIELER does before its own processors run, in the simulation chain:
// - Taken Transition Signaling (sccharts/processors/TakenTransitionSignaling.xtend, the first processor of
//   de.cau.cs.kieler.sccharts.simulation.tts.netlist.c): every source transition gets a bookkeeping effect
//   (here a `take` mark with KIELER's index), and the root gets an entry action that resets the counters.
//   Both influence how KIELER's later processors restructure the chart, so they are kept as real effects.
// - Every source local action with effects gets an `action` mark as its first effect, so the simulator can
//   tell which actions ran however the passes rearrange them.
// - Const inlining (processors/Const.xtend): references to constants become copies of their initial values,
//   with constant folding in scopes that declare constants, so constants never exist at run time.

import type {
    AssignOperator, Declaration, Diagnostic, Effect, Expression, GenericArgument, LocalAction, Reference, Region, ScheduleRef, ScopeParameter,
    SclStatement, Span, State, Transition, ValuedObject, ValueType,
} from '../types'
import type { ModelIndex } from '../parser/resolve'
import {
    CAction, CRegion, CState, CTransition, CVar, copyExpr, mapExpr, setTarget, type CArg, type CExpr, type CEffect, type CGenericArg,
    type CMethod, type CRef, type CStmt, type EffectOrigin, type SchedEntry, type Scope,
} from './model'
import { genericKind } from '../parser/resolve'
import { entryOf, sourceId } from '../parser/generics'
import { originalOf } from './structure/instance'
import { foldConstants } from './fold'
import { placeDeclarations } from './structure/bodies'

/** A dataflow equation (`x = e`, `x += e`, `g.A = e`, `g = {e1, e2}`), lowered; `sequential`: ends with `;`/`seq`. */
export interface CEquation {
    target: CRef
    op: AssignOperator
    expr: CExpr
    sequential: boolean
    /** A dataflow reference call `m(x, y)`: `expr` is the call (KIELER's DataflowReferenceCall). */
    call: boolean
    /** `m(x) = e`: KIELER makes `e` the trigger of the action that calls (Dataflow.xtend, OO translation). */
    trigger?: CExpr
    /** `x = e schedule s 1`: kept by the OO translation only (the classic one makes a new assignment). */
    schedule?: SchedEntry[]
    span?: Span
}

export interface LowerResult {
    root: CState
    /** Source valued object id -> working variable (consts included, although they are inlined). */
    vars: Map<string, CVar>
    /** Source state id -> working state, as lowered (passes may later restructure). */
    states: Map<string, CState>
    regions: Map<string, CRegion>
    /** KIELER's Taken Transition Signaling order: index -> source transition id. */
    takenOrder: string[]
    /** Problems found while lowering (constructs the simulator cannot represent). */
    problems: { message: string; span?: Span; what: string }[]
    /** Errors KIELER reports for what the lowering sees (compile.ts reports them). */
    reports: Diagnostic[]
    /** The members of every class and struct instance, by the member's declaration id (passes/inheritance.ts). */
    instances: Map<CVar, Map<string, CVar>>
    /** The flags of `state(S)` in method bodies (KIELER's MethodSignaling only makes them for the chart it compiles). */
    stateFlags: CVar[]
}

class Lowering {
    readonly vars = new Map<string, CVar>()
    /**
     * Class and struct instances (`class C { ... } c`), nested ones (`l.a`) too: per instance variable, its members by
     * member id and its declaration.
     */
    private readonly instances = new Map<CVar, { members: Map<string, CVar>; decl: Declaration; owner?: CVar }>()
    /**
     * While lowering an instance's methods and initial values: the instance its members belong to (KIELER's class
     * after Unpack Classes; none for a class unpacked into the chart).
     */
    private code: { owner?: CVar } | undefined
    private rootScope: Scope | undefined
    /**
     * While lowering the methods of an instance inside an array of instances (`cs[2]`): its members and the hidden
     * parameters that carry the element's indices (a bare `v` in the body is `cs.v[_self0]`).
     */
    private self: { members: Set<CVar>; idx: CVar[] } | undefined
    readonly states = new Map<string, CState>()
    readonly regions = new Map<string, CRegion>()
    readonly problems: LowerResult['problems'] = []
    /** What KIELER rejects that only the lowering sees (`scchart(C).X` that cannot be copied). */
    readonly reports: Diagnostic[] = []
    /** Consts whose initial value is being lowered (cycle guard). */
    private readonly inlining = new Set<CVar>()
    /** Lowered initial value of each const (lowered on first use). */
    private readonly constValues = new Map<CVar, CExpr>()
    /** Source declaration of each const. */
    private readonly constSource = new Map<CVar, Expression>()
    /** Scopes (source) that declare a constant: KIELER folds constant expressions there. */
    readonly constScopes = new Set<Scope>()
    /** `state(S)` in method bodies: the flag of each state S (KIELER's MethodSignaling, attachStateFlags). */
    readonly stateFlags = new Map<string, CVar>()

    constructor(readonly index: ModelIndex | undefined, private readonly inherited: ReadonlySet<string> = new Set()) {}

    instanceMembers(): Map<CVar, Map<string, CVar>> {
        return new Map([...this.instances].map(([inst, entry]) => [inst, entry.members]))
    }

    /**
     * A class declared without an object (`class K { int f() { ... } }`): nothing can call its methods, but they are
     * in KIELER's model, and its Pre processor walks them like any other (a `pre` in one decides a memory's clock and
     * is refused where a pre is refused). The class is lowered for a stand-in object, which `dropStandIns` takes out
     * again once everything is lowered: only the bodies stay, as declarations of the scope that nothing else names.
     */
    private readonly standIns = new Map<Declaration, { v: CVar; scope: Scope }>()

    dropStandIns() {
        for (const { v, scope } of this.standIns.values()) {
            const inside = (x: CVar): boolean => x === v || (!!x.member && inside(x.member.of))
            const at = scope.decls.indexOf(v)
            const mine = scope.decls.filter(inside)
            scope.decls = scope.decls.filter(x => !inside(x))
            for (const x of mine) this.instances.delete(x)
            placeDeclarations(scope, mine.filter(x => !!x.method), scope.decls.slice(Math.max(at, 0)))
        }
    }

    /** Index references already reported by inheritedIndex (by where they are written). */
    private readonly lostIndices = new Set<string>()

    /**
     * An inherited declaration named alone as an index (`x[k]`, k declared in a base chart). KIELER's Inheritance
     * processor redirects the references to its copies of the base's declarations except those directly inside
     * another reference (replaceVOR skips them as if they were members, `a.b`), so the index still points into the
     * base chart and the compilation fails. Inside an operator (`x[k + 0]`) it is redirected.
     */
    private inheritedIndex(r: Reference) {
        for (let x: Reference | undefined = r; x; x = x.sub) {
            for (const i of x.indices) {
                if (i.kind !== 'ref' || !i.decl || !this.inherited.has(i.decl.split('/').pop()!)) continue
                const key = `${i.span?.start}:${i.decl}`
                if (this.lostIndices.has(key)) continue
                this.lostIndices.add(key)
                this.reports.push({
                    severity: 'error', code: 'inherited-index', span: i.span ?? r.span,
                    message: `\`${i.name}\` is inherited from a base chart, and KIELER cannot compile it as an index written alone (\`${x.name}[${i.name}]\`)`,
                    kieler: `The valued object reference points to a valued object (${i.name}) that is not contained in the model!`,
                    hint: `KIELER's compiler copies the base chart's declarations into this chart and misses a name that stands alone between the brackets. Write the index as an expression (\`${x.name}[${i.name} + 0]\`), or declare \`${i.name}\` in the chart that uses it.`,
                })
            }
        }
    }

    // ----- declarations -----

    /**
     * KIELER's Enum processor (sccharts/processors/Enum.xtend), done while lowering: a `ref E x` of a (non-host)
     * enum E is an int variable, and a value `E.V` is the int literal of its position in E.
     */
    private enumOf(d: Declaration): Declaration | undefined {
        if (d.declKind !== 'reference') return undefined
        // (Inside a copy of a chart the declaration is a copy too: name resolution knows the original.)
        const target = this.index?.refTargets.get(originalOf(d))
        return target && target.kind === 'declaration' && target.declKind === 'enum' && !target.host ? target : undefined
    }

    private enumValue(r: Reference): number | undefined {
        if (!r.decl || !r.sub?.decl || !this.index) return undefined
        const e = entryOf(this.index, r.decl)?.decl
        if (!e || e.declKind !== 'enum' || e.host) return undefined
        const i = (e.members?.[0]?.valuedObjects ?? []).findIndex(vo => vo.id === sourceId(r.sub!.decl!))
        return i < 0 ? undefined : i
    }

    declare(scope: Scope, declarations: Declaration[]) {
        this.rootScope ??= scope
        for (const d of declarations) {
            const enumRef = this.enumOf(d)
            for (const vo of d.valuedObjects) {
                const type: ValueType = enumRef ? 'int' : d.type ?? (d.signal ? 'pure' : 'host')
                const v = new CVar(vo.name, type)
                v.hostType = d.hostType
                v.signal = d.signal
                v.input = d.input
                v.output = d.output
                v.const = d.const
                v.static = d.static
                v.extern = !!d.extern
                v.global = d.global
                v.combine = vo.combine
                v.decl = vo.id
                v.span = vo.nameSpan ?? vo.span
                v.scope = scope
                if (d.declKind !== 'variable' && !enumRef) v.declKind = d.declKind
                if (d.declKind === 'primitive') v.typeParam = d.referenceParameter
                if (d.declKind === 'schedule') v.priorities = d.priorities ?? []
                // Annotations of the declaration (`@Passive clock t`), as `@name` tags.
                for (const a of [...d.annotations, ...(vo.annotations ?? [])]) v.tags.add(`@${a.name}`)
                scope.decls.push(v)
                this.vars.set(vo.id, v)
                if (d.declKind === 'class' || d.declKind === 'struct') {
                    const unpack = d.annotations.some(a => a.name === 'UnpackClass')
                    if (d.host) v.tags.add('#host')
                    else this.declareMembers(scope, d, v, unpack, undefined, unpack ? 0 : 1)
                }
                if (d.const && vo.initialValue) {
                    this.constSource.set(v, vo.initialValue)
                    this.constScopes.add(scope)
                }
            }
            const methods = (c: Declaration): boolean => !!c.members?.some(m => m.declKind === 'method' || ((m.declKind === 'class' || m.declKind === 'struct') && !m.host && methods(m)))
            if (d.declKind === 'class' && !d.host && !d.valuedObjects.length && methods(d)) {
                const v = new CVar(`_${d.className ?? 'class'}`, 'host')
                v.declKind = 'class'
                v.generated = true
                v.scope = scope
                v.span = d.span
                scope.decls.push(v)
                this.declareMembers(scope, d, v)
                this.standIns.set(d, { v, scope })
            }
        }
    }

    /**
     * The members of a class or struct instance: variables of the declaring scope (named `<instance>.<member>`, so they
     * never clash) and, for each method, a method of the instance whose body reads and writes these variables (KIELER
     * keeps the instance as a C struct and its methods as C functions; the simulator runs them the same way). A class
     * or struct inside it is an instance of its own (`l.a`, members `l.a.x`). An array of instances keeps one array per
     * member (`cs[2]`: `cs.v` has the dimension of `cs` in front of its own), which is how KIELER's C indexes them.
     *
     * `@UnpackClass` (KIELER's Unpack Classes processor) moves the members into what holds the instance, named
     * `<instance>_<member>`: into the chart (`o_w`; a class inside it is the instance `o_inn`), or, for a class inside
     * a class, into the outer class (`home`: `o.inn_v`, the pool's `o: { inn_v }`). An array of instances gives every
     * member its dimensions in front (`cs_v[2]`).
     */
    private declareMembers(scope: Scope, d: Declaration, inst: CVar, unpack = false, home?: { of: CVar; name: string }, depth = 1) {
        const members = new Map<string, CVar>()
        const owner = unpack ? home?.of : inst
        for (const m of d.members ?? []) {
            for (const mvo of m.valuedObjects) {
                const nested = m.declKind === 'class' || m.declKind === 'struct'
                if (m.declKind === 'schedule') {
                    members.set(mvo.id, this.classSchedule(scope, d, inst, m, mvo, depth))
                    continue
                }
                if (!nested && m.declKind !== 'variable' && m.declKind !== 'method') continue
                // The member's name in what it belongs to.
                // `@UnpackRenaming "x"` on the member names it `<instance>x` (its own annotation before the declaration's).
                const rename = unpack ? [...(mvo.annotations ?? []), ...m.annotations].find(a => a.name === 'UnpackRenaming')?.values[0] : undefined
                const local = unpack ? `${home ? home.name : inst.name}${rename ?? `_${mvo.name}`}` : mvo.name
                const v = new CVar(owner ? `${owner.name}.${local}` : local, m.declKind === 'method' || nested ? 'host' : m.type ?? (m.signal ? 'pure' : 'host'))
                v.display = owner ? `${owner.display ?? owner.name}.${local}` : local
                v.decl = mvo.id
                v.span = mvo.nameSpan ?? mvo.span
                v.scope = scope
                const link = owner ? { of: owner, name: local } : undefined
                const unpackInner = nested && !m.host && m.annotations.some(a => a.name === 'UnpackClass')
                // An unpacked class inside a class is no member itself: its members are the outer class's.
                if (link && !unpackInner) v.member = link
                // A const member is a constant of the type: not in KIELER's data pool (conformance structure/157).
                // KIELER's Const processor puts the value where a const member is named and removes the member (it
                // is not in the data pool, conformance structure/157), two levels deep only (getAllNestedValuedObjects:
                // a class's members and those of the classes directly inside it): one further in stays a variable.
                // The classes are unpacked by then: an unpacked class's members count as those of what holds it.
                if (m.const && mvo.initialValue && depth <= 2) {
                    // Unpacked into the chart, it is a constant of the chart.
                    if (link) v.tags.add('#const-member')
                    else v.const = true
                    this.constSource.set(v, mvo.initialValue)
                }
                if (m.declKind === 'method') v.declKind = 'method'
                if (nested) v.declKind = m.declKind
                v.hostType = m.hostType
                scope.decls.push(v)
                members.set(mvo.id, v)
                if (nested) {
                    if (m.host) v.tags.add('#host')
                    else this.declareMembers(scope, m, v, unpackInner, unpackInner ? link : undefined, unpackInner ? depth : depth + 1)
                }
            }
        }
        this.instances.set(inst, { members, decl: d, owner })
    }

    /** Schedules declared two or more classes deep, by declaration: KIELER leaves them where they are (or refuses them). */
    private readonly deepSchedules = new Map<string, CVar>()

    /**
     * A schedule declared in a class (UserSchedule.transformContracts, "Handle Class SDs"). KIELER moves the schedule
     * of a class of the chart into the chart, one copy per instance (`C_c_s`), so `schedule c.s 1` and the contracts of
     * the class's methods name that instance's schedule. It refuses one in a class inside a class, and does not look
     * further in (getAllNestedValuedObjects: two levels): a schedule deeper than that stays one object for all
     * instances. `depth` 0: the class is unpacked into the chart (@UnpackClass), where the schedule is the chart's.
     * What KIELER refuses is reported once the charts used as classes are expanded (a `ref C x` is one more class
     * around the schedule): passes/contracts.ts classSchedules.
     */
    private classSchedule(scope: Scope, d: Declaration, inst: CVar, m: Declaration, vo: Declaration['valuedObjects'][number], depth: number): CVar {
        const shared = depth > 1 ? this.deepSchedules.get(vo.id) : undefined
        if (shared) return shared
        const v = new CVar(depth === 1 ? `${d.className ?? 'class'}_${inst.name}_${vo.name}` : depth === 0 ? `${inst.name}_${vo.name}` : vo.name, 'host')
        v.declKind = 'schedule'
        v.priorities = m.priorities ?? []
        v.decl = vo.id
        v.span = vo.nameSpan ?? vo.span
        v.scope = scope
        v.display = `${inst.display ?? inst.name}.${vo.name}`
        if (depth > 0) v.scheduleDepth = depth
        if (depth === 1) {
            v.scheduleOf = inst.name
            v.scheduleInstance = inst
        }
        if (depth > 1) this.deepSchedules.set(vo.id, v)
        scope.decls.push(v)
        return v
    }

    /**
     * Whether KIELER applies a member's initial value (Initialization.collectInitializations). A class initialises
     * its variables in an `_init` method that calls the `_init` of the classes inside it. A struct gets its members'
     * values assigned from outside, but only two levels deep (`getAllNestedValuedObjects`: its members and the members
     * of the structs or classes directly inside it): a member further in keeps 0 whatever it declares.
     */
    private initialised(v: CVar): boolean {
        const chain: CVar[] = []
        for (let c = v.member?.of; c; c = c.member?.of) chain.unshift(c)
        const struct = chain.findIndex(c => c.declKind === 'struct')
        return struct < 0 || chain.length - 1 - struct <= 1
    }

    /** A variable declared in the chart itself (a member of KIELER's C data struct), by name. */
    private chartVariable(name: string): CVar | undefined {
        return this.rootScope?.decls.find(v => v.name === name && !v.member && !v.declKind && !v.const && !v.generated)
    }

    /**
     * Lowers the members' cardinalities and initial values and the methods of an instance (its own dimensions are
     * set). A member of an array of instances has the instance's dimensions in front of its own, and its initial value
     * is repeated for every element; a method gets one hidden parameter per dimension, the element's index.
     */
    private initialiseInstance(inst: CVar) {
        const entry = this.instances.get(inst)
        if (!entry) return
        const { members, decl } = entry
        const savedCode = this.code
        // A struct has no code of its own: KIELER copies an initial value into the chart's initialisation as it is
        // written, so a member's name in it (a sibling's too) is looked up in the chart's data.
        this.code = { owner: decl.declKind === 'struct' ? undefined : entry.owner }
        // While lowering the instance's methods, the members' names mean the instance's members.
        const saved = new Map<string, CVar | undefined>()
        for (const [id, v] of members) {
            saved.set(id, this.vars.get(id))
            this.vars.set(id, v)
        }
        // The class's constants, evaluated while its members' names are in scope.
        for (const v of members.values()) if (this.constSource.has(v)) this.constValue(v)
        const outer = inst.dims
        const sizes = outer.map(c => {
            const n = foldConstants(copyExpr(c))
            return n.k === 'lit' && typeof n.v === 'number' ? n.v : undefined
        })
        // An initial value is lowered once with the element's indices as placeholders (a sibling member it reads,
        // `int b = a + 1`, is the element's own) and repeated for every element with the placeholders filled in.
        const at = outer.map((_, k) => new CVar(`_at${k}`, 'int'))
        const repeat = (value: CExpr, indices: number[] = []): CExpr => {
            if (sizes.some(n => n === undefined || n < 0)) return value
            if (indices.length === sizes.length) {
                return mapExpr(copyExpr(value), x => {
                    const k = x.k === 'ref' ? at.indexOf(x.v) : -1
                    return k < 0 ? undefined : { k: 'lit', t: 'int', v: indices[k] }
                })
            }
            return { k: 'vector', values: Array.from({ length: sizes[indices.length]! }, (_, i) => repeat(value, [...indices, i])), span: value.span }
        }
        const initial = (e: Expression): CExpr => {
            if (!outer.length) return this.expr(e)
            const savedSelf = this.self
            this.self = { members: new Set(members.values()), idx: at }
            const value = this.expr(e)
            this.self = savedSelf
            return repeat(value)
        }
        for (const m of decl.members ?? []) {
            for (const mvo of m.valuedObjects) {
                const v = members.get(mvo.id)
                if (!v) continue
                if (m.declKind === 'variable' || m.declKind === 'class' || m.declKind === 'struct') {
                    const own = mvo.cardinalities.map(c => this.expr(c))
                    v.dims = [...outer.map(c => copyExpr(c)), ...own]
                    if (m.declKind === 'variable' && !mvo.initialValue && own.some(c => c.k !== 'lit')) {
                        this.reports.push({
                            severity: 'error', code: 'array-cardinality', span: mvo.cardinalities[own.findIndex(c => c.k !== 'lit')]?.span ?? mvo.span,
                            message: `The size of the array \`${mvo.name}\` is not a number KIELER knows when it compiles the chart`,
                            kieler: `Cannot initialize array with non integer cardinality: ${mvo.name}`,
                            hint: 'KIELER only puts the value of a constant where it is named when the constant is a member of a class of the chart or of a class directly inside one, and it does not compute an expression there. Write the size as a number.',
                        })
                    }
                    // A replaced const keeps a value that is a number: a chart that inherits the instance reads it.
                    const plain = (e: CExpr): boolean => e.k === 'lit' || (e.k === 'vector' && e.values.every(plain))
                    if (m.declKind === 'variable' && mvo.initialValue && this.initialised(v) && (!this.constSource.has(v) || plain(this.constValue(v)))) v.init = initial(mvo.initialValue)
                    if (m.declKind !== 'variable') this.initialiseInstance(v)
                } else if (m.declKind === 'method') {
                    const savedSelf = this.self
                    const hidden = outer.map((_, k) => {
                        const p = new CVar(`_self${k}`, 'int')
                        p.generated = true
                        p.role = 'frame'
                        p.tags.add('#self')
                        return p
                    })
                    this.self = hidden.length ? { members: new Set(members.values()), idx: hidden } : undefined
                    v.method = this.method(m, hidden)
                    this.self = savedSelf
                }
            }
        }
        for (const [id, v] of saved) {
            if (v) this.vars.set(id, v)
            else this.vars.delete(id)
        }
        this.code = savedCode
    }

    /** Second step: initial values and cardinalities (after every scope declared its variables). */
    initialise(declarations: Declaration[]) {
        for (const d of declarations) {
            if (d.declKind === 'class' || d.declKind === 'struct') {
                for (const vo of d.valuedObjects) {
                    const inst = this.vars.get(vo.id)!
                    inst.dims = vo.cardinalities.map(c => this.expr(c))
                    this.initialiseInstance(inst)
                }
                const standIn = this.standIns.get(d)
                if (standIn) this.initialiseInstance(standIn.v)
            }
            for (const vo of d.valuedObjects) {
                const v = this.vars.get(vo.id)!
                v.dims = vo.cardinalities.map(c => this.expr(c))
                if (vo.initialValue && !d.const) v.init = this.expr(vo.initialValue)
                else if (vo.initialValue && d.const) v.init = this.constValue(v)
            }
            if (d.declKind === 'reference' && d.referenceTarget && !d.extern && !this.enumOf(d)) {
                for (const vo of d.valuedObjects) {
                    const own = !!vo.genericArguments?.length
                    const generics = this.genericArgs(own ? vo.genericArguments : d.genericArguments)
                    this.vars.get(vo.id)!.instance = {
                        target: d.referenceTarget, args: this.args(vo.parameters ?? []),
                        group: d.valuedObjects[0].id,
                        // (separateReferenceDeclarationsWithIndividualBindingsInVOs)
                        ...(d.valuedObjects.length > 1 && d.valuedObjects.some(x => x.parameters?.length || x.genericArguments?.length) ? { separate: true } : {}),
                        ...(generics.length ? { generics, declGenerics: !own } : {}),
                        ...(d.referenceParameter ? { typeParam: d.referenceParameter } : {}),
                    }
                }
            }
            if (d.declKind === 'method' && d.valuedObjects.length) {
                const v = this.vars.get(d.valuedObjects[0].id)!
                v.method = this.method(d)
            }
        }
    }

    /** Arguments of a reference, lowered in the referencing scope (structure.md S-6). */
    args(parameters: ScopeParameter[]): CArg[] {
        return parameters.map(p => ({ expr: this.argument(p.expression), binding: p.binding, span: p.span }))
    }

    /**
     * An argument of a reference. A constant's name is its value here (constants are inlined while lowering), but
     * KIELER's Reference processor runs before its Const processor and binds the name: the literal remembers it.
     */
    private argument(e: Expression): CExpr {
        const value = this.expr(e)
        return e.kind === 'ref' && value.k === 'lit' ? { ...value, konst: e.name } : value
    }

    /** Generic arguments, lowered where they are written (structure.md S-73). */
    genericArgs(list: GenericArgument[] | undefined): CGenericArg[] {
        return (list ?? []).map((a): CGenericArg => {
            const at = { text: a.text, span: a.span }
            if (a.valueType) return { ...at, k: 'type', type: a.valueType }
            if (a.expression) return { ...at, k: 'expr', expr: this.argument(a.expression), ...(a.expression.kind === 'ref' ? { named: true } : {}) }
            return { ...at, k: 'chart', name: a.typeName ?? '', args: this.genericArgs(a.typeArguments) }
        })
    }

    /**
     * The chart's generic parameters as variables of no scope (`root.ext.generics`): the chart's body names them,
     * and the Reference pass puts the arguments in their place.
     */
    private generics(root: CState, chart: State) {
        const list: CVar[] = []
        for (const g of chart.genericParameterDeclarations ?? []) {
            const kind = genericKind(g)
            const v = new CVar(g.valuedObject.name, kind === 'value' ? g.valueType as ValueType : 'host')
            v.declKind = 'generic'
            v.generic = { kind, ...(g.typeName !== undefined ? { type: g.typeName } : {}) }
            v.decl = g.valuedObject.id
            v.span = g.valuedObject.span
            v.scope = root
            this.vars.set(g.valuedObject.id, v)
            list.push(v)
        }
        if (list.length) root.ext.generics = list
    }

    // ----- methods and SCL code (structure.md S-43, S-44) -----

    /** Variables of a method frame or code block: registered for name resolution, but in no scope. */
    private frameVars(declarations: Declaration[], into: CVar[], block?: number): { v: CVar; init: CExpr; span?: Span }[] {
        const inits: { v: CVar; init: CExpr; span?: Span }[] = []
        for (const d of declarations) {
            for (const vo of d.valuedObjects) {
                const v = new CVar(vo.name, d.type ?? 'host')
                if (block !== undefined) v.block = block
                v.hostType = d.hostType
                v.decl = vo.id
                v.span = vo.nameSpan ?? vo.span
                v.generated = true
                v.role = 'frame'
                if (d.declKind === 'primitive') v.typeParam = d.referenceParameter
                this.vars.set(vo.id, v)
                into.push(v)
            }
        }
        for (const d of declarations) {
            for (const vo of d.valuedObjects) {
                const v = this.vars.get(vo.id)!
                v.dims = vo.cardinalities.map(c => this.expr(c))
                if (vo.initialValue) inits.push({ v, init: this.expr(vo.initialValue), span: vo.span })
            }
        }
        return inits
    }

    private method(d: Declaration, hidden: CVar[] = []): CMethod {
        const name = d.valuedObjects[0]?.name ?? ''
        const contract = this.schedule(d.schedule)?.map(e => ({ ...e, method: name, span: e.span ?? d.schedule?.[0]?.span }))
        const params: CVar[] = [...hidden]
        const locals: CVar[] = []
        for (const p of d.parameters ?? []) this.frameVars([p], params)
        const by = d.valuedObjects[0]?.id
        const scope = this.blockCount++
        const body = d.body ? this.block(d.body.declarations, d.body.statements, locals, by, scope) : []
        const rt = d.returnType
        const returnType: CMethod['returnType'] = !rt || rt === 'void' ? 'void'
            : (['bool', 'int', 'float', 'string', 'pure', 'host'] as const).find(t => t === rt) ?? 'host'
        const inline = d.annotations.some(a => a.name.toLowerCase() === 'inline')
        return {
            params, locals, body, scope, returnType, by, span: d.span, ...(inline ? { inline } : {}), ...(contract ? { schedule: contract } : {}),
            ...(d.returnParameter ? { returnParam: d.returnParameter } : {}),
        }
    }

    /** The SCL blocks of method bodies and code blocks, numbered (KIELER's SCL scopes; model.ts CStmt). */
    private blockCount = 0

    /**
     * An SCL block: its declarations (initialisations become statements where they are written), then statements.
     * `scope`: the block's number (its declarations' `block`).
     */
    private block(declarations: Declaration[], statements: SclStatement[], locals: CVar[], by: string | undefined, scope: number): CStmt[] {
        const out: CStmt[] = []
        for (const i of this.frameVars(declarations, locals, scope)) {
            out.push({ k: 'do', init: true, f: { k: 'assign', ref: { k: 'ref', v: i.v, idx: [], span: i.span }, op: '=', expr: i.init, o: { by, span: i.span, hidden: true } } })
        }
        for (const s of statements) out.push(...this.statement(s, locals, by))
        return out
    }

    private statement(s: SclStatement, locals: CVar[], by: string | undefined): CStmt[] {
        switch (s.kind) {
            case 'assign': case 'postfix': case 'call': case 'print': case 'randomize': case 'hostcode':
                return [{ k: 'do', f: this.effect(s, by ?? '') }]
            case 'return': return [{ k: 'return', expr: s.expression ? this.expr(s.expression) : undefined, span: s.span }]
            case 'block': {
                // A plain block is flattened; its statements remember it (outermost block first).
                const scope = this.blockCount++
                return this.block(s.declarations, s.statements, locals, by, scope).map(x => ({ ...x, blocks: [scope, ...(x.blocks ?? [])] }))
            }
            case 'if': {
                const scope = this.blockCount++
                const elseScope = s.else ? this.blockCount++ : undefined
                return [{
                    // `if x > 0 schedule s 1 { ... }`: the schedule stays on the condition, as on a trigger.
                    k: 'if', cond: this.trigger(s.condition, s.conditionSchedule), span: s.span, scope,
                    then: this.block(s.declarations, s.statements, locals, by, scope),
                    ...(s.else ? { else: this.block(s.else.declarations, s.else.statements, locals, by, elseScope!), elseScope } : { else: undefined }),
                }]
            }
            case 'while': {
                const scope = this.blockCount++
                return [{ k: 'while', cond: this.expr(s.condition), body: this.block(s.declarations, s.statements, locals, by, scope), scope, span: s.span }]
            }
            case 'for': {
                // One scope for the loop: its own declaration and the body's.
                const scope = this.blockCount++
                let init: CStmt[] = []
                if (s.init?.kind === 'declaration') init = this.block([s.init], [], locals, by, scope)
                else if (s.init) init = this.statement(s.init, locals, by)
                return [{
                    k: 'for', init, cond: s.condition ? this.expr(s.condition) : undefined, span: s.span, scope,
                    update: s.update ? this.statement(s.update, locals, by) : [],
                    body: this.block(s.declarations, s.statements, locals, by, scope),
                }]
            }
            case 'expression': return [{ k: 'expr', e: this.expr(s.expression), span: s.span }]
            case 'label': return [{ k: 'label', name: s.name, span: s.span }]
            case 'goto': return [{ k: 'goto', target: s.target, span: s.span }]
        }
    }

    /**
     * KIELER's SCL Code Effects processor (sccharts/processors/SclCodeEffect.xtend) turns `do { ... }` into a void
     * method `_effect<n>` of the state (an action's state; for a transition, the state containing its source) and
     * calls it. Done here, while lowering, because the method needs the block's own declarations.
     */
    private codeEffect(f: Extract<Effect, { kind: 'code' }>, by: string, owner: Scope | undefined): CEffect {
        const v = new CVar(`_effect${this.effectCount++}`, 'host')
        v.declKind = 'method'
        v.generated = true
        v.span = f.span
        const locals: CVar[] = []
        const scope = this.blockCount++
        v.method = { params: [], locals, body: this.block(f.declarations ?? [], f.statements ?? [], locals, by, scope), scope, returnType: 'void', by, span: f.span }
        if (owner) {
            v.scope = owner
            owner.decls.push(v)
        }
        return {
            k: 'call', o: { by, span: f.span },
            call: { k: 'call', name: v.name, args: [], target: { k: 'ref', v, idx: [], span: f.span }, span: f.span },
        }
    }

    private effectCount = 0

    /**
     * `scchart(C).X`, a constant of another chart (KIELER's StaticAccess, processors/StaticAccess.xtend): KIELER copies
     * X's declaration into the simulated chart and its Const processor inlines the copy's initial value. Only the
     * declaration is copied: an initial value that names another constant of C points out of the model, which KIELER
     * rejects (`static-access`, compile.ts); a subscript is dropped with the access, so an array element becomes the
     * whole array (gcc rejects the vector in C).
     */
    private staticConst(e: Extract<Expression, { kind: 'special' }>): CExpr {
        const sub = e.sub!
        const entry = sub.decl && this.index ? entryOf(this.index, sub.decl) : undefined
        const init = entry?.vo?.initialValue
        if (!entry?.decl?.const || !init) return { k: 'unsupported', what: e.text, span: e.span }
        const names = new Set<string>()
        const visit = (x: Expression) => {
            if (x.kind === 'ref') { names.add(x.name); x.indices.forEach(visit) }
            else if (x.kind === 'op') x.args.forEach(visit)
            else if (x.kind === 'vector') x.values.forEach(visit)
        }
        visit(init)
        const constant = sub.name
        if (names.size) {
            const first = [...names][0]
            this.reports.push({
                severity: 'error', code: 'static-access', span: e.span,
                message: `\`${e.text}\` cannot be copied: the value of \`${constant}\` uses \`${first}\`, another name of \`${e.target}\``,
                kieler: `The valued object reference points to a valued object (${first}) that is not contained in the model!\nReferences objects are not contained in the resource!`,
                hint: `KIELER copies only the declaration of \`${constant}\` into this chart, and \`${first}\` stays behind. Give \`${constant}\` a value without names (\`const int ${constant} = 6\`), or declare the constant in this chart.`,
            })
            return { k: 'lit', t: 'int', v: 0, span: e.span }
        }
        if (sub.indices.length && init.kind === 'vector') {
            this.reports.push({
                severity: 'error', code: 'static-access', span: e.span,
                message: `\`${e.text}\` does not work: KIELER drops the index and reads the whole array \`${constant}\`, which the C code cannot use here`,
                kieler: `expected expression before ‘{’ token\nCompiler did not return success (exit value != 0)`,
                hint: `Declare the array in this chart (\`const int ${constant}[${init.values.length}] = ...\`), or give the element a constant of its own in \`${e.target}\`.`,
            })
            return { k: 'lit', t: 'int', v: 0, span: e.span }
        }
        if (sub.indices.length || sub.sub) return { k: 'unsupported', what: e.text, span: e.span }
        const value = foldConstants(this.expr(init))
        return { ...value, span: e.span }
    }

    /**
     * KIELER's MethodSignaling (processors/MethodSignaling.xtend, run at the start of Reference): `state(S)` in a
     * method body reads a flag `_<region>_<S>_active` (bool, false at first) declared in the state around S's region,
     * which an entry action of S sets and an exit action of S clears (attachStateFlags).
     */
    private stateFlag(state: string, text: string): CVar {
        let v = this.stateFlags.get(state)
        if (!v) {
            const source = this.index?.states.get(state) ?? this.index?.states.get(sourceId(state))
            const region = source ? this.index?.parentRegion.get(source) : undefined
            v = new CVar(`_${region?.name || 'default'}_${source?.name ?? state}_active`, 'bool')
            v.generated = true
            v.display = text
            v.init = { k: 'lit', t: 'bool', v: false }
            this.stateFlags.set(state, v)
        }
        return v
    }

    /** Declares the `state(S)` flags and gives each S its entry and exit action (stateFlag). */
    attachStateFlags() {
        for (const [id, v] of this.stateFlags) {
            const target = this.states.get(id)
            const owner = target?.parent?.parent
            if (!target || !owner) continue
            v.scope = owner
            owner.decls.push(v)
            const set = (kind: 'entry' | 'exit', value: boolean) => {
                const a = new CAction(kind)
                a.about = id
                a.effects.push({ k: 'assign', ref: { k: 'ref', v, idx: [] }, op: '=', expr: { k: 'lit', t: 'bool', v: value }, o: { hidden: true, by: id } })
                target.actions.push(a)
            }
            set('entry', true)
            set('exit', false)
        }
    }

    private constValue(v: CVar): CExpr {
        const done = this.constValues.get(v)
        if (done) return copyExpr(done)
        const source = this.constSource.get(v)
        if (!source || this.inlining.has(v)) return { k: 'unsupported', what: `const ${v.name}` }
        this.inlining.add(v)
        const value = foldConstants(this.expr(source))
        this.inlining.delete(v)
        this.constValues.set(v, value)
        return copyExpr(value)
    }

    // ----- expressions -----

    expr(e: Expression): CExpr {
        switch (e.kind) {
            case 'bool': return { k: 'lit', t: 'bool', v: e.value, span: e.span }
            case 'int': return { k: 'lit', t: 'int', v: e.value | 0, span: e.span }
            // SCGTransformation: createFloatValue(Float.valueOf(value.floatValue())): every float literal is single precision.
            case 'float': return { k: 'lit', t: 'float', v: Math.fround(e.value), span: e.span }
            case 'string': return { k: 'lit', t: 'string', v: e.value, span: e.span }
            case 'null': return { k: 'null', span: e.span }
            case 'ref': return this.refExpr(e)
            case 'op': return { k: 'op', op: e.op, args: e.args.map(a => this.expr(a)), span: e.span }
            case 'vector': return { k: 'vector', values: e.values.map(a => this.expr(a)), range: e.range, ...(e.range && !this.rangeEnd(e.values[1]) ? { badEnd: true } : {}), span: e.span }
            case 'random': return { k: 'random', span: e.span }
            case 'hostcode': return { k: 'host', text: e.text, span: e.span }
            case 'ignore': return { k: 'ignore', span: e.span }
            case 'call': return this.call(e.name, e.args.map(a => this.expr(a)), e.target ? this.ref(e.target) : undefined, e)
            case 'special': {
                // `scchart(Decl).Bit.ZERO`: an enum value of another chart is its position, as `Bit.ZERO` (S-58).
                const value = e.access === 'scchart' && e.sub ? this.enumValue(e.sub) : undefined
                if (value !== undefined) return { k: 'lit', t: 'int', v: value, span: e.span }
                if (e.access === 'scchart' && e.sub) return this.staticConst(e)
                if (e.access === 'state' && e.state) return { k: 'ref', v: this.stateFlag(e.state, e.text), idx: [], span: e.span }
                return { k: 'unsupported', what: e.text, span: e.span }
            }
            default: return { k: 'unsupported', what: e.kind, span: e.span }
        }
    }

    /**
     * The end of a range `{0 to N}` as KIELER's Reference processor takes it when it spreads the range: a number, or
     * an int constant declared with a number (`const int N = 2`; not `= 1 + 1`, not another constant, not a float).
     */
    private rangeEnd(e: Expression | undefined): boolean {
        if (!e || e.kind === 'int') return true
        let r = e.kind === 'ref' && !e.sub ? e : e.kind === 'special' ? e.sub : undefined
        while (r?.sub) r = r.sub
        const entry = r?.decl && this.index ? entryOf(this.index, r.decl) : undefined
        const d = entry?.decl
        return !!d && d.declKind === 'variable' && !!d.const && d.type === 'int' && entry!.vo.initialValue?.kind === 'int'
    }

    private refExpr(r: Reference): CExpr {
        this.inheritedIndex(r)
        const enumValue = this.enumValue(r)
        if (enumValue !== undefined) return { k: 'lit', t: 'int', v: enumValue, span: r.span }
        let v = r.decl ? this.vars.get(r.decl) : undefined
        let last = r
        // A const member, by its name inside the class or through an instance (`a.N`, `cs[1].N`).
        if (v && !v.const) {
            while (last.sub) last = last.sub
            v = last === r ? v : this.ref(r).v
            if (!this.constSource.has(v) || v.decl !== last.decl) v = undefined
        }
        // An `input const` has no value of its own: it is whatever a reference binds to it (passes/reference.ts).
        if (v?.const && v.input && !this.constSource.has(v)) v = undefined
        if (v) {
            let value = this.constValue(v)
            for (const i of last.indices) {
                const index = this.constIndex(i, v)
                const fail = (message: string, kieler: string): CExpr => {
                    this.reports.push({
                        severity: 'error', code: 'const-array-element', span: i.span ?? r.span, message, kieler,
                        hint: `KIELER puts the element's value where \`${v!.display ?? v!.name}[...]\` is written, so the index must be a number it knows there: a literal, or a constant declared before \`${v!.display ?? v!.name}\`. Use a variable array if the index changes while the chart runs.`,
                    })
                    return { k: 'lit', t: 'int', v: 0, span: r.span }
                }
                if (index === undefined) {
                    return fail(`The constant array \`${v.display ?? v.name}\` can only be indexed with a number KIELER knows when it compiles the chart`,
                        `Cannot insert const array element. ${i.kind === 'ref' ? i.name : 'The index'} is not a valid index (integer value).`)
                }
                if (value.k !== 'vector') {
                    return fail(`The constant \`${v.display ?? v.name}\` has no elements to index`,
                        `Cannot insert const array element. Array ${last.name} must be initialized with a vector value.`)
                }
                if (index < 0 || index >= value.values.length) {
                    return fail(`The constant array \`${v.display ?? v.name}\` has no element ${index}`,
                        `Cannot insert const array element. Array ${last.name} does not provide a value for index ${index}.`)
                }
                value = copyExpr(value.values[index])
            }
            return { ...this.constAtUse(value, v), span: r.span }
        }
        this.inheritedConstArray(r)
        return this.ref(r)
    }

    /**
     * A constant of a base chart, or a const member of an instance declared there (`c.N`, two levels deep as for
     * the chart's own): the lowering leaves the name to the Inheritance pass, which reads the constant's storage.
     * Returns the constant's entry and the reference that names it.
     */
    private inheritedConst(r: Reference): { last: Reference; vo: ValuedObject } | undefined {
        const source = r.decl?.split('/').pop()
        if (!source || !this.inherited.has(source) || (r.decl && this.vars.has(r.decl))) return undefined
        let last = r
        let depth = 0
        while (last.sub) { last = last.sub; depth++ }
        if (depth > 2 || !last.decl) return undefined
        const entry = this.index?.vos.get(last.decl.split('/').pop()!)
        return entry?.decl?.const && entry.vo.initialValue ? { last, vo: entry.vo } : undefined
    }

    /**
     * An element of an inherited const array. The inherited declarations come first in the chart, so when KIELER
     * replaces the array none of the chart's own constants is a number yet: the index must be a literal, or be
     * computed inside the value of one of the chart's own constants (constIndex).
     */
    private inheritedConstArray(r: Reference) {
        const found = this.inheritedConst(r)
        if (!found || !found.last.indices.length) return
        const { last, vo } = found
        const within = [...this.inlining].pop()
        let value: Expression | undefined = vo.initialValue
        for (const i of last.indices) {
            // An inherited name alone is reported by inheritedIndex.
            if (i.kind === 'ref' && i.decl && this.inherited.has(i.decl.split('/').pop()!)) return
            let index = i.kind === 'int' ? i.value : undefined
            if (index === undefined && within?.const && this.computedBefore(i, within)) {
                const folded = foldConstants(this.expr(i))
                if (folded.k === 'lit' && typeof folded.v === 'number') index = folded.v
            }
            const element: Expression | undefined = index !== undefined && value?.kind === 'vector' ? value.values[index] : undefined
            if (index === undefined || (value?.kind === 'vector' && !element)) {
                this.reports.push({
                    severity: 'error', code: 'const-array-element', span: i.span ?? r.span,
                    message: index === undefined
                        ? `The inherited constant array \`${last.name}\` can only be indexed with a number written out`
                        : `The constant array \`${last.name}\` has no element ${index}`,
                    kieler: index === undefined
                        ? `Cannot insert const array element. ${i.kind === 'ref' ? i.name : 'The index'} is not a valid index (integer value).`
                        : `Cannot insert const array element. Array ${last.name} does not provide a value for index ${index}.`,
                    hint: `KIELER puts the element's value where \`${last.name}[...]\` is written, and the constants of a base chart are replaced before this chart's own, which are still names then. Write the index as a number inside the array.`,
                })
                return
            }
            value = element
        }
    }

    /**
     * The index of a const array's element, as KIELER's Const processor needs it: an int literal at the moment the
     * array is replaced. The processor first computes the values of each scope's own constants, in order, from the
     * ones computed before (evaluateExpressions; not the constants of classes), then replaces the constants scope
     * by scope from the root, in each scope as declared, a class's constants at the class. Replacing puts the
     * value's expression where the name was and computes nothing: `N[K]` is fine when K has been replaced by a
     * number by the time N is, `N[0 + 1]` only inside a value that was computed in the first step.
     */
    private constIndex(i: Expression, array: CVar): number | undefined {
        if (i.kind === 'int') return i.value
        const within = [...this.inlining].pop()
        if (within?.const && this.computedBefore(i, within)) {
            const value = foldConstants(this.expr(i))
            return value.k === 'lit' && typeof value.v === 'number' && Number.isInteger(value.v) ? value.v : undefined
        }
        return this.literalAt(i, array)
    }

    /** The constant a reference names (by its name, or through an instance), if the lowering replaces it. */
    private constOf(e: Reference): CVar | undefined {
        let last = e
        while (last.sub) last = last.sub
        const k = last === e ? (e.decl ? this.vars.get(e.decl) : undefined) : this.ref(e).v
        return k && k.decl === last.decl && this.constSource.has(k) ? k : undefined
    }

    /** KIELER replaces the constants scope by scope from the root, in each scope in the order they are declared. */
    private replacedBefore(k: CVar, other: CVar): boolean {
        if (k.scope === other.scope) return (k.span?.start ?? 0) < (other.span?.start ?? 0)
        for (let scope: Scope | undefined = other.scope?.parent; scope; scope = scope.parent) if (scope === k.scope) return true
        return false
    }

    private readonly computedConsts = new Map<CVar, boolean>()

    /** Whether KIELER's first step computes the value of a scope's own constant (it is then a number or a vector). */
    private computed(k: CVar): boolean {
        if (!k.const) return false
        const done = this.computedConsts.get(k)
        if (done !== undefined) return done
        this.computedConsts.set(k, false)
        const source = this.constSource.get(k)
        const result = !!source && this.computedBefore(source, k)
        this.computedConsts.set(k, result)
        return result
    }

    /** Whether an expression names only constants KIELER has computed before the scope's constant `within`. */
    private computedBefore(e: Expression, within: CVar): boolean {
        switch (e.kind) {
            case 'int': case 'bool': case 'float': return true
            case 'op': return e.args.every(a => this.computedBefore(a, within))
            case 'vector': return e.values.every(a => this.computedBefore(a, within))
            case 'ref': {
                const k = this.constOf(e)
                if (!k || !this.replacedBefore(k, within) || !this.computed(k)) return false
                for (let x: Reference | undefined = e; x; x = x.sub) if (!x.indices.every(a => this.computedBefore(a, within))) return false
                return true
            }
            default: return false
        }
    }

    private readonly substituting = new Set<CVar>()

    /** The int literal an expression has become when KIELER replaces the constant `at`, if it is one by then. */
    private literalAt(e: Expression, at: CVar): number | undefined {
        if (e.kind === 'int') return e.value
        if (e.kind !== 'ref') return undefined
        const k = this.constOf(e)
        if (!k || !this.replacedBefore(k, at) || this.substituting.has(k)) return undefined
        if (this.computed(k)) {
            const value = foldConstants(this.refExpr(e))
            return value.k === 'lit' && typeof value.v === 'number' && Number.isInteger(value.v) ? value.v : undefined
        }
        let last = e
        while (last.sub) last = last.sub
        this.substituting.add(k)
        let written: Expression | undefined = this.constSource.get(k)
        for (const x of last.indices) {
            const n = this.literalAt(x, at)
            written = written?.kind === 'vector' && n !== undefined ? written.values[n] : undefined
        }
        const result = written ? this.literalAt(written, at) : undefined
        this.substituting.delete(k)
        return result
    }

    /**
     * A const member's value where it is used. KIELER puts the value's expression there as written, and a member's
     * name in it means the member only inside the member's own class: anywhere else its C code looks the name up in
     * the chart's data (the chart's variable of that name, or gcc fails; probes probe-const-member-reads-*).
     */
    private constAtUse(value: CExpr, constant: CVar): CExpr {
        const home = constant.member?.of
        if (!home) return value
        return mapExpr(value, x => {
            if (x.k !== 'ref' || x.v.member?.of !== home) return undefined
            if (this.code && this.code.owner === home) {
                return this.self?.members.has(x.v) ? { ...x, idx: [...this.self.idx.map(p => ({ k: 'ref' as const, v: p, idx: [] })), ...x.idx] } : undefined
            }
            const chart = this.chartVariable(x.v.member.name)
            if (chart) return { ...x, v: chart }
            const marker = new CVar(x.v.member.name, 'int')
            marker.tags.add('#outer-member')
            marker.span = x.span
            return { ...x, v: marker }
        })
    }

    ref(r: Reference): CRef {
        this.inheritedIndex(r)
        let v = r.decl ? this.vars.get(r.decl) : undefined
        if (!v) {
            // Not resolved (the front end reports it) or a member of a type the simulator does not model.
            v = new CVar(r.name, 'host')
            v.declKind = 'unresolved'
            if (r.decl) v.decl = r.decl
        }
        // Inside a class's method or initial value, the name of a member of a class around it: KIELER's C code looks
        // it up in the chart's data (`d->w`), so it means the chart's variable of that name, and without one gcc
        // fails (checkCodegen; probes structure/probe-class-outer-member-*).
        if (v.member && this.code && v.member.of !== this.code.owner) {
            const chart = this.chartVariable(r.name)
            if (chart) v = chart
            else {
                v = new CVar(r.name, 'int')
                v.tags.add('#outer-member')
                v.span = r.span
            }
        }
        const idx = r.indices.map(i => this.expr(i))
        // A member of the instance whose method is being lowered, inside an array of instances: the element's indices.
        if (this.self?.members.has(v)) idx.unshift(...this.self.idx.map(p => ({ k: 'ref' as const, v: p, idx: [] })))
        // Named from inside its class (`v`, `l.w` in a method of the class): not through the instance or one around it.
        const inside = (x: CVar | undefined, of: CVar): boolean => !!x && (x === of || inside(x.member?.of, of))
        const home = this.code?.owner
        const own = !!home && !inside(home, v)
        // A member of a class instance (`c.x`, `l.a.x`, `cs[1].v`, `c.inc()`): the instance's member variable or method,
        // with the indices of the instances on the way in front of the member's own.
        let sub = r.sub
        for (let entry = this.instances.get(v); sub && entry; entry = this.instances.get(v)) {
            const member = sub.decl ? entry.members.get(sub.decl) : undefined
            if (!member) break
            v = member
            idx.push(...sub.indices.map(i => this.expr(i)))
            sub = sub.sub
        }
        const out: CRef = { k: 'ref', v, idx, span: r.span }
        if (sub) out.sub = this.ref(sub)
        if (own && inside(v.member?.of, home)) out.own = r.name
        const unindexed = this.equations ? undefined : this.unindexedObject(r)
        if (unindexed) out.unindexed = unindexed
        return out
    }

    /** Set while a dataflow equation is lowered (KIELER translates the instances named there in its own ways). */
    private equations = false

    /**
     * The first array of objects (of a class, a struct or a chart) that a reference goes through without its index:
     * `q` of `q.w` with `class In { ... } q[2]`, `c` of `c.get()` with `ref C c[2]`.
     */
    private unindexedObject(r: Reference): string | undefined {
        for (let x: Reference | undefined = r; x?.sub; x = x.sub) {
            const entry = x.decl && this.index ? entryOf(this.index, x.decl) : undefined
            const d = entry?.decl
            if (!d || !entry?.vo || d.host || d.extern) continue
            const object = d.declKind === 'class' || d.declKind === 'struct' || (d.declKind === 'reference' && !this.enumOf(d))
            if (object && entry.vo.cardinalities.length > x.indices.length) return x.name
        }
        return undefined
    }

    /**
     * A call: a method of an element of an array of instances (`cs[i].inc()`) takes the element's indices as its first
     * (hidden) arguments.
     */
    private call(name: string, args: CExpr[], target: CRef | undefined, from: { extern?: boolean; paramAccess?: unknown; span?: Span; target?: Reference }): Extract<CExpr, { k: 'call' }> {
        if (target && target.v.declKind === 'method' && target.v.member && target.idx.length) {
            args = [...target.idx, ...args]
            target = { ...target, idx: [] }
        }
        // A method called by its name alone (inside a class or a chart used as one: a method of the same instance).
        const bare = target?.v.declKind === 'method' && !target.v.generated && !!from.target && !from.target.sub
        return { k: 'call', name, args, extern: from.extern, target, paramAccess: from.paramAccess as never, span: from.span, ...(bare ? { bare } : {}) }
    }

    // ----- effects -----

    /**
     * `schedule s 1`: the schedule object and the priority. `schedule c.s 1` names the schedule of the instance `c`
     * (classSchedule; `qualified`), `schedule x.s 1` that of a chart used as a class (`ref C x`), which the Reference
     * pass knows once it expanded `x`. What KIELER refuses (a class's schedule named without its instance) is found
     * after the references are expanded: passes/contracts.ts.
     */
    schedule(list: ScheduleRef[] | undefined): SchedEntry[] | undefined {
        if (!list?.length) return undefined
        const out: SchedEntry[] = []
        for (const s of list) {
            const first = s.ref.decl ? this.vars.get(s.ref.decl) : undefined
            let v = first
            for (let sub = s.ref.sub; sub && v; sub = sub.sub) v = sub.decl ? this.instances.get(v)?.members.get(sub.decl) : undefined
            const qualified = s.ref.sub ? { qualified: true } : {}
            // Declared in a base chart (the Inheritance pass knows the base's copy) or in a chart used as a class (the
            // Reference pass knows the instance's): passes/userSchedule.ts drops what nothing redirects.
            if (!v && s.ref.decl && (this.inherited.has(s.ref.decl.split('/').pop()!) || (s.ref.sub && first?.declKind === 'reference'))) {
                const ref = this.ref(s.ref)
                out.push({ group: ref.v, priority: s.priority, ref, span: s.span, ...qualified })
                continue
            }
            // Not resolved: the front end reports it. A variable that is not a schedule crashes KIELER's dependency
            // analysis where it orders an access (deps.ts), a contract's when the method is called (contracts.ts).
            if (!v) continue
            out.push({ group: v, priority: s.priority, span: s.span, ...qualified })
        }
        return out.length ? out : undefined
    }

    /**
     * The target of an assignment. A const member written through its instance (`a.N = 4`; the validation only
     * refuses the name alone) crashes KIELER's Const processor, which puts the value in the reference's place.
     */
    private target(r: Reference): CRef {
        const ref = this.ref(r)
        const inherited = r.sub ? this.inheritedConst(r) : undefined
        if ((r.sub && !ref.sub && this.constSource.has(ref.v) && ref.v.tags.has('#const-member')) || inherited) {
            this.reports.push({
                severity: 'error', code: 'kieler-crash', span: r.span,
                message: `\`${inherited ? inherited.last.name : ref.v.display ?? ref.v.name}\` is a constant and cannot be changed: KIELER's compiler crashes on this assignment`,
                kieler: 'java.lang.ClassCastException: class de.cau.cs.kieler.kexpressions.impl.IntValueImpl cannot be cast to class de.cau.cs.kieler.kexpressions.ValuedObjectReference',
                hint: 'Remove `const` from the member\'s declaration if it needs to change.',
            })
        }
        return ref
    }

    effect(f: Effect, by: string, owner?: Scope): CEffect {
        // An emission's schedule is lost: KIELER's Signal processor replaces the emission by new assignments.
        const schedule = 'schedule' in f && f.kind !== 'emit' ? this.schedule(f.schedule) : undefined
        const o: EffectOrigin = schedule ? { by, span: f.span, schedule } : { by, span: f.span }
        switch (f.kind) {
            case 'assign': return { k: 'assign', ref: this.target(f.target), op: f.operator, expr: this.expr(f.expression), o }
            case 'postfix': return { k: 'assign', ref: this.target(f.target), op: f.operator, o }
            case 'emit': return { k: 'emit', ref: this.ref(f.target), value: f.value ? this.expr(f.value) : undefined, o }
            case 'print': return { k: 'print', args: f.args.map(a => this.expr(a)), o }
            case 'call': return { k: 'call', o, call: this.call(f.name, f.args.map(a => this.expr(a)), f.target ? this.ref(f.target) : undefined, f) }
            case 'randomize': return { k: 'randomize', o }
            case 'hostcode': return { k: 'host', text: f.text, o }
            case 'code': return this.codeEffect(f, by, owner)
        }
    }

    // ----- structure -----

    state(s: State, parent: CRegion | undefined): CState {
        const c = new CState(s.name)
        c.label = s.label
        c.parent = parent
        c.initial = s.initial
        c.final = s.final
        c.connector = s.connector
        c.violation = s.violation
        c.root = s.isRoot
        c.origin = s.id
        if (s.reference) c.ext.reference = s.reference
        if (s.callsReference) c.ext.calls = true
        if (s.baseStates?.length) c.ext.baseStates = s.baseStates
        this.states.set(s.id, c)
        this.generics(c, s)
        this.declare(c, s.declarations)
        // After the declarations: `state S schedule s 0 { schedule s ... }` names the state's own schedule.
        const schedule = this.schedule(s.schedule)
        if (schedule) c.ext.userSchedule = schedule
        for (const r of s.regions) c.regions.push(this.region(r, c))
        for (const a of s.actions) c.actions.push(this.action(a))
        return c
    }

    region(r: Region, parent: CState): CRegion {
        const c = new CRegion()
        c.name = r.name
        c.label = r.label
        c.parent = parent
        c.origin = r.id
        c.dataflow = r.regionType === 'dataflow'
        c.final = !!r.final
        c.abort = !!r.abort
        c.override = !!r.override
        if (r.forLoop) {
            c.ext.forLoop = r.forLoop
            // The counter (resolved to `<regionId>$<name>`, parser/ids.ts counterId) is a variable of the region
            // until the For pass replaces it by a literal in each copy.
            const counter = new CVar(r.forLoop.variable, 'int')
            counter.declKind = 'counter'
            counter.decl = `${r.id}$${r.forLoop.variable}`
            counter.span = r.forLoop.span
            counter.scope = c
            this.vars.set(counter.decl, counter)
            c.ext.forCounter = counter
        }
        if (r.equations.length) c.ext.equations = r.equations
        if (r.reference) c.ext.reference = r.reference
        if (r.once) c.ext.once = true
        // A dataflow region's schedule goes to the control-flow region the Dataflow pass makes of it.
        const schedule = this.schedule(r.schedule)
        if (schedule) c.ext.userSchedule = schedule
        this.regions.set(r.id, c)
        this.declare(c, r.declarations)
        for (const s of r.states) c.states.push(this.state(s, c))
        for (const a of r.actions) c.actions.push(this.action(a))
        return c
    }

    action(a: LocalAction): CAction {
        const c = new CAction(a.kind)
        c.delay = a.delay ?? 'undefined'
        if (a.preemption) c.preemption = a.preemption
        c.weak = !!a.weak
        c.triggerDelay = a.triggerDelay
        c.origin = a.id
        c.span = a.span
        c.annotations = a.annotations.map(x => x.name)
        // Triggers and effects are lowered in the second step (all variables must be declared first).
        ;(c as CAction & { src?: LocalAction }).src = a
        return c
    }

    /** Lowers the triggers and effects of every action and transition (second step). */
    contents(source: State, target: CState) {
        this.initialise(source.declarations)
        if (source.reference) {
            target.ext.args = this.args(source.reference.parameters)
            const generics = this.genericArgs(source.reference.genericArguments)
            if (generics.length) target.ext.genericArgs = generics
        }
        // `extends Base<...>(...)`: the arguments, lowered in this state (passes/inheritance.ts binds them).
        if (source.baseStates?.length) {
            target.ext.baseArgs = source.baseStates.map(b => ({ args: this.args(b.parameters), generics: this.genericArgs(b.genericArguments) }))
        }
        this.actionContents(source.actions, target.actions, target)
        source.regions.forEach((r, i) => {
            const cr = target.regions[i]
            this.initialise(r.declarations)
            if (r.forLoop) {
                // structure.md S-21: `for i : a to b` (int literals) or `for i : ARRAY` (its first dimension).
                cr.ext.forFrom = this.expr(r.forLoop.from)
                if (r.forLoop.to) cr.ext.forTo = this.expr(r.forLoop.to)
            }
            // `region Q is R(args)`: the arguments, lowered in the state around the region.
            if (r.reference?.parameters.length) cr.ext.args = this.args(r.reference.parameters)
            if (r.regionType === 'dataflow') {
                // Equations, lowered like effects (passes/dataflow.ts turns them into control flow, structure.md S-25).
                this.equations = true
                const eqs: CEquation[] = r.equations.map(eq => {
                    const call = eq.callArgs !== undefined
                    const out: CEquation = {
                        target: this.ref(eq.target), op: eq.operator, expr: this.expr(eq.call ?? eq.expression),
                        sequential: !!eq.sequential, call, span: eq.span,
                    }
                    if (eq.call) out.trigger = this.expr(eq.expression)
                    const schedule = this.schedule(eq.schedule)
                    if (schedule) out.schedule = schedule
                    return out
                })
                this.equations = false
                cr.ext.eqs = eqs
            }
            this.actionContents(r.actions, cr.actions, target)
            r.states.forEach((s, j) => this.contents(s, cr.states[j]))
        })
    }

    private actionContents(source: LocalAction[], target: CAction[], owner: Scope) {
        source.forEach((a, i) => {
            const c = target[i]
            if (a.trigger) c.trigger = this.trigger(a.trigger, a.triggerSchedule)
            c.effects = a.effects.map(f => this.effect(f, a.id, owner))
            delete (c as CAction & { src?: LocalAction }).src
        })
    }

    /** Transitions, after all states exist (targets may be anywhere in the region). */
    transitions(source: State) {
        const c = this.states.get(source.id)!
        for (const t of source.transitions) c.out.push(this.transition(t, c))
        for (const r of source.regions) for (const s of r.states) this.transitions(s)
    }

    private transition(t: Transition, source: CState): CTransition {
        const c = new CTransition()
        c.source = source
        const target = t.target ? this.states.get(t.target) : undefined
        if (target) setTarget(c, target)
        else {
            this.problems.push({ message: `The target ${t.targetName} of ${t.id} does not exist`, span: t.targetSpan, what: 'target' })
            setTarget(c, source)
        }
        c.delay = t.delay ?? 'undefined'
        c.preemption = t.preemption
        c.triggerDelay = t.triggerDelay
        c.history = t.history
        c.deferred = t.deferred
        c.origin = t.id
        c.span = t.span
        if (t.trigger) c.trigger = this.trigger(t.trigger, t.triggerSchedule)
        c.effects = t.effects.map(f => this.effect(f, t.id, source.parent?.parent ?? source))
        return c
    }

    /** A trigger with its schedule (`if A schedule s 1`), which KIELER keeps on the trigger expression. */
    private trigger(e: Expression, schedule: ScheduleRef[] | undefined): CExpr {
        const c = this.expr(e)
        const sched = this.schedule(schedule)
        return sched ? { ...c, sched: [...(c.sched ?? []), ...sched] } : c
    }
}

/**
 * The declarations KIELER's Inheritance processor replaces by copies in a chart: those of every base chart, of
 * the chart itself and of the states inside it that extend one (by their ids in the source).
 */
export function inheritedDeclarations(chart: State, index: ModelIndex | undefined): Set<string> {
    const out = new Set<string>()
    const seen = new Set<State>()
    const bases = (s: State) => {
        for (const b of s.baseStates ?? []) {
            const base = index?.charts.find(c => c.name === b.target)
            if (!base || seen.has(base)) continue
            seen.add(base)
            for (const d of base.declarations) for (const vo of d.valuedObjects) out.add(vo.id.split('/').pop()!)
            bases(base)
        }
    }
    const visit = (s: State) => {
        bases(s)
        for (const r of s.regions) for (const c of r.states) visit(c)
    }
    visit(chart)
    return out
}

/**
 * Lowers the scchart `chart` (with the resolved index from compile()). `inherited`: for the copy of a base chart,
 * the declarations inherited in the chart that extends it (inheritedDeclarations).
 */
export function lowerChart(chart: State, index: ModelIndex | undefined, inherited?: ReadonlySet<string>): LowerResult {
    const l = new Lowering(index, new Set([...(inherited ?? []), ...inheritedDeclarations(chart, index)]))
    const root = l.state(chart, undefined)
    root.root = true
    l.contents(chart, root)
    l.transitions(chart)
    l.attachStateFlags()

    // Constant folding where KIELER's Const processor evaluates expressions (scopes that declare constants).
    for (const scope of l.constScopes) foldScope(scope)

    // Marks for source local actions (first effect; only actions that have effects).
    for (const s of l.states.values()) markActions(s)
    for (const r of l.regions.values()) markActions(r)

    // Taken Transition Signaling, on the source model: pre-order over the states below the root.
    const takenOrder: string[] = []
    const visit = (s: State, include: boolean) => {
        if (include) {
            for (const t of s.transitions) {
                const ct = l.states.get(s.id)!.out.find(x => x.origin === t.id)
                if (ct) ct.effects.unshift({ k: 'mark', m: { kind: 'take', transition: t.id, index: takenOrder.length }, o: { by: t.id, hidden: true } })
                takenOrder.push(t.id)
            }
        }
        for (const r of s.regions) for (const c of r.states) visit(c, true)
    }
    visit(chart, false)
    if (takenOrder.length > 0) {
        // USE_VALUE_CHANGE_SIGNALING: the counters are reset by a root entry action (appended to the root's actions).
        const reset = new CAction('entry')
        reset.effects.push({ k: 'mark', m: { kind: 'ttsReset' }, o: { hidden: true } })
        root.actions.push(reset)
    }

    l.dropStandIns()
    return { root, vars: l.vars, states: l.states, regions: l.regions, takenOrder, problems: l.problems, reports: l.reports, instances: l.instanceMembers(), stateFlags: [...l.stateFlags.values()] }
}

function markActions(scope: Scope) {
    for (const a of scope.actions) {
        if (a.origin && a.effects.length > 0) a.effects.unshift({ k: 'mark', m: { kind: 'action', action: a.origin }, o: { by: a.origin, hidden: true } })
    }
}

function foldScope(scope: Scope) {
    const visitScope = (s: Scope) => {
        for (const v of s.decls) {
            if (v.init) v.init = foldConstants(v.init)
            v.dims = v.dims.map(foldConstants)
        }
        for (const a of s.actions) {
            if (a.trigger) a.trigger = foldConstants(a.trigger)
            a.effects = a.effects.map(foldEffect)
        }
        if (s instanceof CState) {
            for (const t of s.out) {
                if (t.trigger) t.trigger = foldConstants(t.trigger)
                t.effects = t.effects.map(foldEffect)
            }
            for (const r of s.regions) visitScope(r)
        } else {
            for (const c of s.states) visitScope(c)
        }
    }
    visitScope(scope)
}

function foldEffect(f: CEffect): CEffect {
    switch (f.k) {
        case 'assign': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(foldConstants) }, expr: f.expr ? foldConstants(f.expr) : undefined }
        case 'emit': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(foldConstants) }, value: f.value ? foldConstants(f.value) : undefined }
        case 'print': return { ...f, args: f.args.map(foldConstants) }
        default: return f
    }
}

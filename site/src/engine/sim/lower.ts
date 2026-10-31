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
    AssignOperator, Declaration, Diagnostic, Effect, Expression, LocalAction, Reference, Region, ScopeParameter, SclStatement, Span,
    State, Transition, ValuedObject, ValueType,
} from '../types'
import type { ModelIndex } from '../parser/resolve'
import {
    CAction, CRegion, CState, CTransition, CVar, copyExpr, setTarget, type CArg, type CExpr, type CEffect, type CMethod, type CRef,
    type CStmt, type Scope,
} from './model'
import { foldConstants } from './fold'

/** A dataflow equation (`x = e`, `x += e`, `g.A = e`, `g = {e1, e2}`), lowered; `sequential`: ends with `;`/`seq`. */
export interface CEquation {
    target: CRef
    op: AssignOperator
    expr: CExpr
    sequential: boolean
    /** A dataflow reference call `A(x, y)` (not supported by the simulator). */
    call: boolean
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
}

class Lowering {
    readonly vars = new Map<string, CVar>()
    /** Class and struct instances (`class C { ... } c`): per instance id, its members by member id. */
    private readonly instances = new Map<string, Map<string, CVar>>()
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

    constructor(readonly index: ModelIndex | undefined) {}

    // ----- declarations -----

    /**
     * KIELER's Enum processor (sccharts/processors/Enum.xtend), done while lowering: a `ref E x` of a (non-host)
     * enum E is an int variable, and a value `E.V` is the int literal of its position in E.
     */
    private enumOf(d: Declaration): Declaration | undefined {
        if (d.declKind !== 'reference') return undefined
        const target = this.index?.refTargets.get(d)
        return target && target.kind === 'declaration' && target.declKind === 'enum' && !target.host ? target : undefined
    }

    private enumValue(r: Reference): number | undefined {
        if (!r.decl || !r.sub?.decl || !this.index) return undefined
        const e = this.index.vos.get(r.decl)?.decl
        if (!e || e.declKind !== 'enum' || e.host) return undefined
        const i = (e.members?.[0]?.valuedObjects ?? []).findIndex(vo => vo.id === r.sub!.decl)
        return i < 0 ? undefined : i
    }

    declare(scope: Scope, declarations: Declaration[]) {
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
                // Annotations of the declaration (`@Passive clock t`), as `@name` tags.
                for (const a of [...d.annotations, ...(vo.annotations ?? [])]) v.tags.add(`@${a.name}`)
                scope.decls.push(v)
                this.vars.set(vo.id, v)
                if (d.declKind === 'class' || d.declKind === 'struct') {
                    if (d.host) v.tags.add('#host')
                    else if (vo.cardinalities.length) v.tags.add('#array')
                    else if ((d.members ?? []).some(m => m.declKind === 'class' || m.declKind === 'struct')) v.tags.add('#nested')
                    else this.declareMembers(scope, d, vo, v)
                }
                if (d.const && vo.initialValue) {
                    this.constSource.set(v, vo.initialValue)
                    this.constScopes.add(scope)
                }
            }
        }
    }

    /**
     * The members of a class or struct instance: variables of the declaring scope (named `<instance>.<member>`, so they
     * never clash) and, for each method, a method of the instance whose body reads and writes these variables (KIELER
     * keeps the instance as a C struct and its methods as C functions; the simulator runs them the same way).
     */
    private declareMembers(scope: Scope, d: Declaration, vo: ValuedObject, inst: CVar) {
        const members = new Map<string, CVar>()
        // @UnpackClass (KIELER's Unpack Classes processor): the members become variables `<instance>_<member>`.
        const unpack = d.annotations.some(a => a.name === 'UnpackClass')
        for (const m of d.members ?? []) {
            for (const mvo of m.valuedObjects) {
                if (m.declKind !== 'variable' && m.declKind !== 'method') continue
                const v = new CVar(unpack ? `${vo.name}_${mvo.name}` : `${vo.name}.${mvo.name}`, m.declKind === 'method' ? 'host' : m.type ?? (m.signal ? 'pure' : 'host'))
                v.display = unpack ? v.name : `${vo.name}.${mvo.name}`
                v.decl = mvo.id
                v.span = mvo.nameSpan ?? mvo.span
                v.scope = scope
                if (!unpack) v.member = { of: inst, name: mvo.name }
                // A const member is a constant of the type: not in KIELER's data pool (conformance structure/157).
                if (m.const) v.tags.add('#const-member')
                if (m.declKind === 'method') v.declKind = 'method'
                v.hostType = m.hostType
                scope.decls.push(v)
                members.set(mvo.id, v)
            }
        }
        this.instances.set(vo.id, members)
    }

    /** Lowers the members' initial values and the methods of the instances of a class declaration. */
    private initialiseMembers(d: Declaration) {
        for (const vo of d.valuedObjects) {
            const members = this.instances.get(vo.id)
            if (!members) continue
            // While lowering the instance's methods, the members' names mean the instance's members.
            const saved = new Map<string, CVar | undefined>()
            for (const [id, v] of members) {
                saved.set(id, this.vars.get(id))
                this.vars.set(id, v)
            }
            for (const m of d.members ?? []) {
                for (const mvo of m.valuedObjects) {
                    const v = members.get(mvo.id)
                    if (!v) continue
                    if (m.declKind === 'variable') {
                        v.dims = mvo.cardinalities.map(c => this.expr(c))
                        if (mvo.initialValue) v.init = this.expr(mvo.initialValue)
                    } else if (m.declKind === 'method') {
                        v.method = this.method(m)
                    }
                }
            }
            for (const [id, v] of saved) {
                if (v) this.vars.set(id, v)
                else this.vars.delete(id)
            }
        }
    }

    /** Second step: initial values and cardinalities (after every scope declared its variables). */
    initialise(declarations: Declaration[]) {
        for (const d of declarations) {
            if (d.declKind === 'class' || d.declKind === 'struct') this.initialiseMembers(d)
            for (const vo of d.valuedObjects) {
                const v = this.vars.get(vo.id)!
                v.dims = vo.cardinalities.map(c => this.expr(c))
                if (vo.initialValue && !d.const) v.init = this.expr(vo.initialValue)
                else if (vo.initialValue && d.const) v.init = this.constValue(v)
            }
            if (d.declKind === 'reference' && d.referenceTarget && !d.extern && !this.enumOf(d)) {
                for (const vo of d.valuedObjects) {
                    this.vars.get(vo.id)!.instance = { target: d.referenceTarget, args: this.args(vo.parameters ?? []) }
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
        return parameters.map(p => ({ expr: this.expr(p.expression), binding: p.binding, span: p.span }))
    }

    // ----- methods and SCL code (structure.md S-43, S-44) -----

    /** Variables of a method frame or code block: registered for name resolution, but in no scope. */
    private frameVars(declarations: Declaration[], into: CVar[]): { v: CVar; init: CExpr; span?: Span }[] {
        const inits: { v: CVar; init: CExpr; span?: Span }[] = []
        for (const d of declarations) {
            for (const vo of d.valuedObjects) {
                const v = new CVar(vo.name, d.type ?? 'host')
                v.hostType = d.hostType
                v.decl = vo.id
                v.span = vo.nameSpan ?? vo.span
                v.generated = true
                v.role = 'frame'
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

    private method(d: Declaration): CMethod {
        const params: CVar[] = []
        const locals: CVar[] = []
        for (const p of d.parameters ?? []) this.frameVars([p], params)
        const by = d.valuedObjects[0]?.id
        const body = d.body ? this.block(d.body.declarations, d.body.statements, locals, by) : []
        const rt = d.returnType
        const returnType: CMethod['returnType'] = !rt || rt === 'void' ? 'void'
            : (['bool', 'int', 'float', 'string', 'pure', 'host'] as const).find(t => t === rt) ?? 'host'
        const inline = d.annotations.some(a => a.name.toLowerCase() === 'inline')
        return { params, locals, body, returnType, by, span: d.span, ...(inline ? { inline } : {}) }
    }

    /** An SCL block: its declarations (initialisations become statements where they are written), then statements. */
    private block(declarations: Declaration[], statements: SclStatement[], locals: CVar[], by: string | undefined): CStmt[] {
        const out: CStmt[] = []
        for (const i of this.frameVars(declarations, locals)) {
            out.push({ k: 'do', f: { k: 'assign', ref: { k: 'ref', v: i.v, idx: [], span: i.span }, op: '=', expr: i.init, o: { by, span: i.span, hidden: true } } })
        }
        for (const s of statements) out.push(...this.statement(s, locals, by))
        return out
    }

    private statement(s: SclStatement, locals: CVar[], by: string | undefined): CStmt[] {
        switch (s.kind) {
            case 'assign': case 'postfix': case 'call': case 'print': case 'randomize': case 'hostcode':
                return [{ k: 'do', f: this.effect(s, by ?? '') }]
            case 'return': return [{ k: 'return', expr: s.expression ? this.expr(s.expression) : undefined, span: s.span }]
            case 'block': return this.block(s.declarations, s.statements, locals, by)
            case 'if': return [{
                k: 'if', cond: this.expr(s.condition), span: s.span,
                then: this.block(s.declarations, s.statements, locals, by),
                else: s.else ? this.block(s.else.declarations, s.else.statements, locals, by) : undefined,
            }]
            case 'while': return [{ k: 'while', cond: this.expr(s.condition), body: this.block(s.declarations, s.statements, locals, by), span: s.span }]
            case 'for': {
                let init: CStmt[] = []
                if (s.init?.kind === 'declaration') init = this.block([s.init], [], locals, by)
                else if (s.init) init = this.statement(s.init, locals, by)
                return [{
                    k: 'for', init, cond: s.condition ? this.expr(s.condition) : undefined, span: s.span,
                    update: s.update ? this.statement(s.update, locals, by) : [],
                    body: this.block(s.declarations, s.statements, locals, by),
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
        v.method = { params: [], locals, body: this.block(f.declarations ?? [], f.statements ?? [], locals, by), returnType: 'void', by, span: f.span }
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
        const entry = sub.decl ? this.index?.vos.get(sub.decl) : undefined
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
            const source = this.index?.states.get(state)
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
            case 'vector': return { k: 'vector', values: e.values.map(a => this.expr(a)), range: e.range, span: e.span }
            case 'random': return { k: 'random', span: e.span }
            case 'hostcode': return { k: 'host', text: e.text, span: e.span }
            case 'ignore': return { k: 'ignore', span: e.span }
            case 'call': return {
                k: 'call', name: e.name, args: e.args.map(a => this.expr(a)), extern: e.extern,
                target: e.target ? this.ref(e.target) : undefined, paramAccess: e.paramAccess, span: e.span,
            }
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

    private refExpr(r: Reference): CExpr {
        const enumValue = this.enumValue(r)
        if (enumValue !== undefined) return { k: 'lit', t: 'int', v: enumValue, span: r.span }
        const v = r.decl ? this.vars.get(r.decl) : undefined
        if (v?.const) {
            let value = this.constValue(v)
            for (const i of r.indices) {
                const index = foldConstants(this.expr(i))
                if (value.k === 'vector' && index.k === 'lit' && typeof index.v === 'number' && index.v >= 0 && index.v < value.values.length) {
                    value = copyExpr(value.values[index.v])
                } else {
                    return { k: 'unsupported', what: `const array element ${v.name}`, span: r.span }
                }
            }
            return { ...value, span: r.span }
        }
        return this.ref(r)
    }

    ref(r: Reference): CRef {
        // A member of a class instance (`c.x`, `c.inc()`): the instance's member variable or method.
        const members = r.decl ? this.instances.get(r.decl) : undefined
        const member = members && r.sub?.decl ? members.get(r.sub.decl) : undefined
        if (member) {
            const out: CRef = { k: 'ref', v: member, idx: [...r.indices, ...r.sub!.indices].map(i => this.expr(i)), span: r.span }
            if (r.sub!.sub) out.sub = this.ref(r.sub!.sub)
            return out
        }
        let v = r.decl ? this.vars.get(r.decl) : undefined
        if (!v) {
            // Not resolved (the front end reports it) or a member of a type the simulator does not model.
            v = new CVar(r.name, 'host')
            v.declKind = 'unresolved'
            if (r.decl) v.decl = r.decl
        }
        const out: CRef = { k: 'ref', v, idx: r.indices.map(i => this.expr(i)), span: r.span }
        if (r.sub) out.sub = this.ref(r.sub)
        return out
    }

    // ----- effects -----

    effect(f: Effect, by: string, owner?: Scope): CEffect {
        const o = { by, span: f.span }
        switch (f.kind) {
            case 'assign': return { k: 'assign', ref: this.ref(f.target), op: f.operator, expr: this.expr(f.expression), o }
            case 'postfix': return { k: 'assign', ref: this.ref(f.target), op: f.operator, o }
            case 'emit': return { k: 'emit', ref: this.ref(f.target), value: f.value ? this.expr(f.value) : undefined, o }
            case 'print': return { k: 'print', args: f.args.map(a => this.expr(a)), o }
            case 'call': return {
                k: 'call', o,
                call: { k: 'call', name: f.name, args: f.args.map(a => this.expr(a)), extern: f.extern, target: f.target ? this.ref(f.target) : undefined, paramAccess: f.paramAccess, span: f.span },
            }
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
        this.declare(c, s.declarations)
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
        if (source.reference) target.ext.args = this.args(source.reference.parameters)
        this.actionContents(source.actions, target.actions, target)
        source.regions.forEach((r, i) => {
            const cr = target.regions[i]
            this.initialise(r.declarations)
            if (r.forLoop) {
                // structure.md S-21: `for i : a to b` (int literals) or `for i : ARRAY` (its first dimension).
                cr.ext.forFrom = this.expr(r.forLoop.from)
                if (r.forLoop.to) cr.ext.forTo = this.expr(r.forLoop.to)
            }
            if (r.regionType === 'dataflow') {
                // Equations, lowered like effects (passes/dataflow.ts turns them into control flow, structure.md S-25).
                const eqs: CEquation[] = r.equations.map(eq => ({
                    target: this.ref(eq.target), op: eq.operator, expr: this.expr(eq.expression),
                    sequential: !!eq.sequential, call: eq.callArgs !== undefined, span: eq.span,
                }))
                cr.ext.eqs = eqs
            }
            this.actionContents(r.actions, cr.actions, target)
            r.states.forEach((s, j) => this.contents(s, cr.states[j]))
        })
    }

    private actionContents(source: LocalAction[], target: CAction[], owner: Scope) {
        source.forEach((a, i) => {
            const c = target[i]
            if (a.trigger) c.trigger = this.expr(a.trigger)
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
        if (t.trigger) c.trigger = this.expr(t.trigger)
        c.effects = t.effects.map(f => this.effect(f, t.id, source.parent?.parent ?? source))
        return c
    }
}

/** Lowers the scchart `chart` (with the resolved index from compile()). */
export function lowerChart(chart: State, index: ModelIndex | undefined): LowerResult {
    const l = new Lowering(index)
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

    return { root, vars: l.vars, states: l.states, regions: l.regions, takenOrder, problems: l.problems, reports: l.reports }
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

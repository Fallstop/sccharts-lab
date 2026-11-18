// KIELER's Reference processor (sccharts/processors/Reference.xtend), with the Dataflow processor it calls
// (passes/dataflow.ts). Owner: the structure workstream. structure.md S-4 .. S-18, S-33, S-34.
//
// `state S is C(args)` is macro expansion: a fresh copy of the chart C (lowered from its AST with every id
// prefixed by `S/`, structure/instance.ts) replaces S. Its interface (C's inputs and outputs, in declaration
// order) is bound to the arguments by KIELER's binding pointer (explicit `x to y` moves it), the rest by name;
// binding is substitution: inside the copy every formal is the actual (a variable or an array cell), and a literal
// input becomes a local initialised with the literal. Output initial values become entry actions of S, after C's
// own root actions. Copied locals whose names are visible around S are renamed `_x_` (`_x_2`, ...). The copy
// takes S's place at the end of its region (EMF's add, then remove), with S's name, flags and transitions.
//
// `ref C g(args)` outside dataflow copies C's regions into the declaring state as `g_<region>`, and its actions
// after the state's own (handleSCChartsDatatype; its locals become hidden members). In dataflow regions, instances
// are reference states the Dataflow processor creates.
//
// Binding is by NAME, on KIELER's replacement stack (structure/replacements.ts): what an instance binds is still
// bound inside the references and instances nested in it (S-18a, S-73).
//
// Order (expandRoot): references of states (in each copy: its own references, then its dataflow regions and the
// references these create), then the chart's dataflow regions, then `ref` declarations, then the references the
// dataflow regions created.

import type { Diagnostic, ScopeCall, Span, State, ValueType } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import { interfaceOf, sourceId } from '../../parser/generics'
import type { Pass, PassContext } from './context'
import {
    addVar, allContainedStates, allRegions, allScopes, copyExpr, createEntryAction, effectExprs, isRegion, ref, sameExpr, setSource,
    setTarget, walkExpr, type CArg, type CExpr, type CGenericArg, type CRef, type CRegion, type CState, type CStmt, type CVar, type Scope,
} from '../model'
import { inheritedDeclarations, type CEquation } from '../lower'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { declaredVars, rewriteScope } from '../structure/rewrite'
import { declarationsOf, placeDeclarations } from '../structure/bodies'
import { Replacements, Replacer } from '../structure/replacements'
import { arrayMembers, elementIndices, elementOf, usesFields } from '../structure/instanceArray'
import { chartInstancesOf, DECLARED_MEMBER, type ChartInstance } from '../structure/poolShape'
import { applySpreads, isSpread, type SpreadBinding } from '../structure/spread'
import { fileNames, type UniqueNames } from '../structure/classNames'
import { foldConstants } from '../fold'
import { DF_BINDING, DF_REMOVED, processDataflow } from './dataflow'
import { allInherited, inherit } from './inheritance'

export const reference: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.reference',
    name: 'Reference',
    owner: 'structure',
    run(ctx: PassContext) {
        new Expansion(ctx).run()
    },
}

/** What the tracker needs to know about an instance (structure/track.ts). */
export interface InstanceRecord {
    /** Id of the referencing state (a prefixed id inside other instances), or of the state declaring `ref`. */
    state: string
    prefix: string
    chart: State
    /** A `ref` declaration's instance (its regions join the declaring state's), not a referencing state. */
    declaration?: boolean
}

/** A reference to expand: a state's `is C(args)`, or one the Dataflow processor made. */
export interface ReferenceCall {
    target: string
    args: CArg[]
    /** The generic arguments (`is C<4>`; a dataflow instance takes those of its `ref` declaration). */
    generics?: CGenericArg[]
    span?: Span
    super?: boolean
}

class Recursion extends Error {}

/** A chart with type parameters may be expanded inside itself (each time with other types): KIELER has no check there. */
const MAX_DEPTH = 64

export class Expansion {
    readonly index: ModelIndex | undefined
    /** Charts being expanded, outermost first (the simulated chart, then each chart a copy is being made of). */
    private readonly stack: string[] = []
    readonly records: InstanceRecord[] = []
    /** KIELER's replacedWithLiterals: variables that got a literal as their initial value. */
    private readonly literals = new Set<CVar>()
    private readonly reported = new Set<string>()
    /** Interface declarations removed from their copy: a reference still naming one points out of the model. */
    private readonly removed = new Set<CVar>()
    /** Names whose assignment was already reported (a written parameter that stands for a value). */
    private readonly failed: Set<CVar>
    readonly ctx: PassContext
    /** While set, nothing is reported (the further elements of an array of instances repeat the first's reports). */
    private muted = 0
    /** KIELER's classes for `ref` declarations: one per declaration, named after the chart (structure/classNames.ts). */
    private readonly classes = new Map<Scope, Map<string, { name: string; key: string }>>()
    private readonly names: UniqueNames
    private classKeys = 0
    /** How many `ref` instances are being expanded around the current place. */
    private instanceDepth = 0
    /** The ports an OO dataflow instance has lost, with why: bound in its declaration, bound around it, declared again inside. */
    private readonly lostPorts = new Map<CVar, Map<string, 'bound' | 'outer' | 'inner'>>()

    constructor(ctx: PassContext) {
        this.ctx = { root: ctx.root, config: ctx.config, vars: ctx.vars, shared: ctx.shared, report: d => { if (!this.muted) ctx.report(d) } }
        this.index = ctx.shared.index as ModelIndex | undefined
        ctx.shared.instances = this.records
        this.failed = (ctx.shared.failedVars ??= new Set<CVar>()) as Set<CVar>
        this.names = (ctx.shared.uniqueNames ??= fileNames(this.index?.programs[0])) as UniqueNames
    }

    run() {
        const root = this.ctx.root
        this.stack.push(root.name)
        try {
            this.expandRoot(root, undefined)
            this.checkRemovedInstances(root)
            this.validate(root)
        } catch (e) {
            if (!(e instanceof Recursion)) throw e
        }
    }

    private replacer(replacements: Replacements, owner: string | undefined, expand: boolean): Replacer {
        return new Replacer(replacements, {
            report: d => this.ctx.report(d), owner, literals: this.literals, reported: this.reported, failed: this.failed,
            ...(expand ? {
                expand: (state: CState, r: Replacements) => this.expandState(state, r),
                expandRegion: (region: CRegion, r: Replacements) => this.expandRegion(region, r),
            } : {}),
        })
    }

    /** KIELER's expandRoot: inheritance, the chart's own generic parameters, references, dataflow, `ref` declarations. */
    private expandRoot(root: CState, replacements: Replacements | undefined, chart?: State) {
        // Inheritance first (inheritBaseStates): the states inside that extend a chart, then the chart itself.
        for (const s of allContainedStates(root).filter(x => x.ext.baseStates !== undefined)) {
            const source = this.sourceState(s)
            if (source) this.inheritedSchedule(s, source)
            if (source) inherit(this.ctx, s, source, name => this.findChart(name), replacements)
        }
        const source = chart ?? this.sourceState(root)
        if (root.ext.baseStates && source) this.inheritedSchedule(root, source)
        if (root.ext.baseStates && source) inherit(this.ctx, root, source, name => this.findChart(name), replacements)
        // The chart's own generic parameters, bound where it is instantiated (a `ref` declaration).
        const generics = root.ext.generics as CVar[] | undefined
        if (generics?.length) {
            if (!replacements || (replacements.empty && !replacements.types.size)) {
                this.ctx.report({
                    severity: 'error', code: 'unbound-generic', span: generics[0].span, related: root.origin ? [root.origin] : undefined,
                    message: `\`${root.name}\` has generic parameters, so it cannot be simulated on its own`,
                    kieler: 'A root SCChart cannot have unbound generic parameters.',
                    hint: `KIELER compiles the first chart of the file. Put a chart first that uses this one with arguments, for example \`state S is ${root.name}<...>\`.`,
                })
                throw new Recursion()
            }
            this.replaceGenericTypes(root, replacements)
            this.replacer(replacements, root.origin, false).state(root)
            delete root.ext.generics
        }
        const references = () => {
            for (const s of allContainedStates(root).filter(isReferencing)) this.expandState(s, new Replacements(replacements))
            for (const r of allRegions(root).filter(x => x.ext.reference !== undefined)) this.expandRegion(r, new Replacements(replacements))
        }
        references()
        processDataflow(root, this)
        this.expandDeclarations(root, replacements)
        references()
    }

    /**
     * A schedule declared at the top of a base chart (S-27a): KIELER's Inheritance enters every variable it copies
     * into its variable store, and a schedule is one without a type there, which the simulation's interface cannot
     * hold. Not inside a `ref` instance: the copy KIELER inherits in is not the one that reaches the model (the
     * instance's root becomes a class, whose schedule is moved out as a copy, and its regions are cloned), and a
     * variable of the store that is no longer in the model is left out.
     */
    private inheritedSchedule(state: CState, chart: State, span?: Span) {
        if (this.instanceDepth) return
        for (const base of allInherited(chart, name => this.findChart(name))) {
            const d = base.declarations.find(x => x.declKind === 'schedule' && x.valuedObjects.length)
            if (!d) continue
            const vo = d.valuedObjects[0]
            const name = d.access === undefined || d.access === 'public' ? vo.name : `${base.name}_${vo.name}`
            this.ctx.report({
                severity: 'error', code: 'inherited-schedule', span: span ?? (this.local(base) ? vo.nameSpan ?? vo.span : undefined), related: state.origin ? [state.origin] : undefined,
                message: `\`${state.name}\` inherits the schedule \`${vo.name}\` from \`${base.name}\`, which KIELER cannot compile`,
                kieler: `Cannot serialize simulation interface. Unsupported type: null\nCannot serialize simulation interface. Unsupported type null for variable ${name}`,
                hint: `KIELER keeps an inherited schedule as a variable without a type in the simulation's interface. Declare the schedule in a class of \`${base.name}\` (\`class C { schedule ${vo.name} } c\`, named \`schedule c.${vo.name} 1\`), or in the chart that uses it.`,
            })
            return
        }
    }

    /** The source (AST) state of a working state: an instance's copy has the ids of its chart behind a prefix. */
    private sourceState(s: CState): State | undefined {
        const id = s.origin
        return id === undefined ? undefined : this.index?.states.get(id) ?? this.index?.states.get(sourceId(id))
    }

    /**
     * The classic dataflow translation removes the instances it wires from the chart. Whatever else names such an
     * instance (another dataflow region, an action, a transition) then points at nothing, which KIELER's check at
     * the end of the expansion reports (Reference.xtend validate).
     */
    private checkRemovedInstances(root: CState) {
        const names: string[] = []
        let first: { v: CVar; span?: Span } | undefined
        const visit = (r: CRef): undefined => {
            if (!r.v.tags.has(DF_REMOVED)) return undefined
            first ??= { v: r.v, span: r.span }
            names.push(r.v.name)
            for (let sub = r.sub; sub; sub = sub.sub) names.push(sub.v.name)
            return undefined
        }
        rewriteScope(root, { read: visit, target: visit, node: e => (e.k === 'call' && e.target ? visit(e.target) : undefined) })
        if (!first) return
        const g = first.v
        this.ctx.report({
            severity: 'error', code: 'dataflow-instance-shared', span: first.span ?? g.span, related: g.decl ? [g.decl] : undefined,
            message: `\`${g.name}\` is wired in a dataflow region and used somewhere else too: KIELER moves the instance into that region and this use is left without it`,
            kieler: [...names.map(n => `The valued object reference points to a valued object (${n}) that is not contained in the model!`), 'References objects are not contained in the resource!'].join('\n'),
            hint: `Use \`${g.name}\` in one dataflow region only (a dataflow region that calls a method and one that does not translate differently and cannot share an instance), or declare one instance per region.`,
        })
    }

    // ----- names and charts -----

    findChart(name: string): State | undefined {
        return this.index?.charts.find(c => c.name === name)
    }

    /** Is the chart written in the simulated file (are its spans this file's)? */
    private local(chart: State): boolean {
        return !this.index || !!this.index.programs[0]?.charts.includes(chart)
    }

    /** KIELER's valuedObjectNameMap: the innermost declaration of a name, from a scope up to the root. */
    lookup(from: Scope, name: string): CVar | undefined {
        for (let s: Scope | undefined = from; s; s = isRegion(s) ? s.parent : s.parent) {
            const v = s.decls.find(x => x.name === name)
            if (v) return v
        }
        return undefined
    }

    /** Names declared around a state (its region and every enclosing scope): KIELER's getAllReservedVariableNames. */
    private reserved(s: Scope): Set<string> {
        const out = new Set<string>()
        for (let x: Scope | undefined = s.parent; x; x = isRegion(x) ? x.parent : x.parent) for (const v of x.decls) out.add(v.name)
        return out
    }

    // ----- bindings -----

    /**
     * KIELER's createBindings for a chart's interface: its inputs and outputs (and the inherited ones its base
     * references leave open) receive the arguments by the binding pointer and, if unbound, the variable of the same
     * name visible from `scope`. The names on the replacement stack count for that: a name that is bound further out
     * means what it is bound to. Returns the bindings in KIELER's order (the front end reports binding errors).
     *
     * `dataflow`: an instance of a dataflow region that calls methods (S-33a) takes explicit bindings only
     * (handleSCChartsDatatype: "For dataflow only explicit bindings otherwise all"); what would be bound by position
     * or by name stays a member of the instance.
     */
    private interfaceBindings(chart: State, args: CArg[], scope: Scope, replacements: Replacements, owner: string, span: Span | undefined, dataflow = false): { name: string; actual: CExpr }[] {
        const formals = this.index ? interfaceOf(chart, this.index).map(vo => vo.name) : []
        const out: { name: string; actual: CExpr }[] = []
        const bound = new Set<number>()
        let ptr = 0
        let crashed = false
        for (const a of args) {
            if (a.binding !== undefined) {
                const i = formals.indexOf(a.binding)
                if (i < 0) continue
                ptr = i
            }
            if (ptr >= formals.length) {
                // More arguments than inputs and outputs: for an instance of an OO dataflow region KIELER asks the
                // binding without a target whether its target is an input (handleSCChartsDatatype) and throws.
                if (dataflow && !crashed) {
                    crashed = true
                    this.ctx.report({
                        severity: 'error', code: 'kieler-crash', span: a.span ?? span, related: [owner],
                        message: `\`${chart.name}\` has ${formals.length} input${formals.length === 1 ? '' : 's'} and output${formals.length === 1 ? '' : 's'}, but ${args.length} are bound here: KIELER's compiler crashes on the extra one`,
                        kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.ValuedObject.eContainer()" because "valuedObject" is null',
                        hint: `Remove the extra argument. In a dataflow region that calls a method, an instance's inputs and outputs are wired by equations (\`g.input = ...\`); only explicit bindings (\`x to input\`) are applied.`,
                    })
                }
                continue
            }
            if (!dataflow || a.binding !== undefined) out.push({ name: formals[ptr], actual: a.expr })
            bound.add(ptr)
            ptr++
        }
        if (bound.size < formals.length) {
            // The names visible here that are bound further out (KIELER walks all of them, needed or not).
            const visible = new Map<string, CVar>()
            for (let s: Scope | undefined = scope; s; s = isRegion(s) ? s.parent : s.parent) for (const v of s.decls) if (!visible.has(v.name)) visible.set(v.name, v)
            for (const name of [...visible.keys()]) {
                if (!replacements.has(name)) continue
                const outer = replacements.peek(name)
                if (outer?.k === 'ref') visible.set(name, outer.v)
                else if (outer) {
                    this.ctx.report({
                        severity: 'error', code: 'kieler-crash', span, related: [owner],
                        message: `\`${name}\` is a variable here and also a generic parameter that stands for a value: KIELER's compiler crashes when it binds \`${chart.name}\` by name`,
                        kieler: `java.lang.IllegalStateException: There is a matching valued object on the replacement stack for an implicitly bound variable ( ${name}).However, the binding is not a valued object reference, so the type does not match.`,
                        hint: `Rename the variable \`${name}\` or the generic parameter, or bind every input and output of \`${chart.name}\` in the parameter list.`,
                    })
                    throw new Recursion()
                }
            }
            formals.forEach((name, i) => {
                if (bound.has(i) || dataflow) return
                const v = visible.get(name)
                if (v) out.push({ name, actual: { k: 'ref', v, idx: [] } })
            })
        }
        return out
    }

    /**
     * KIELER's createGenericParameterBindings on the working model: the copy's generic parameters take the arguments
     * by position. Types go to `replacements.types`, values and instances onto the stack.
     */
    private bindGenerics(inst: CState, args: CGenericArg[] | undefined, replacements: Replacements) {
        const generics = (inst.ext.generics as CVar[] | undefined) ?? []
        generics.forEach((g, i) => {
            const arg = args?.[i]
            if (!arg) return
            if (g.generic?.kind === 'type' || g.generic?.kind === 'primitive') replacements.types.set(g.name, arg)
            else replacements.push(g.name, arg.k === 'expr' ? arg.expr : { k: 'unsupported', what: arg.text, span: arg.span })
        })
    }

    /**
     * KIELER's replaceGenericTypeParametersInState: the type parameters of a copy become the types it was given.
     * `state S is W(...)` and `ref W w` name the chart (with the generic arguments that came with it), a declaration
     * of a primitive type parameter becomes a plain variable of the type, a method's generic return and parameter
     * types become the type.
     */
    private replaceGenericTypes(root: CState, replacements: Replacements) {
        const types = replacements.types
        for (const s of allContainedStates(root)) {
            const call = s.ext.reference as ScopeCall | undefined
            if (!call?.targetParameter || s.ext.target !== undefined) continue
            const type = types.get(call.target)
            if (type?.k !== 'chart') continue
            s.ext.target = type.name
            if (type.args.length) {
                if (!(s.ext.genericArgs as CGenericArg[] | undefined)?.length) s.ext.genericArgs = type.args.map(copyGenericArg)
                else {
                    this.ctx.report({
                        severity: 'error', code: 'generic-arguments-conflict', span: call.span, related: s.origin ? [s.origin] : undefined,
                        message: `\`${call.target}\` already comes with generic arguments (\`${type.text}\`), and \`${s.name}\` gives it some more`,
                        kieler: `Conflicting generic parameters passed to scope call in ${s.name} via generic type and in call.`,
                        hint: 'Give the generic arguments in one place: where the chart is passed as a type, or where it is used.',
                    })
                }
            }
        }
        for (const scope of allScopes(root)) {
            for (const v of scope.decls) {
                if (v.declKind === 'reference' && v.instance?.typeParam) {
                    const type = types.get(v.instance.target)
                    if (type?.k === 'chart') {
                        const { typeParam: _, ...rest } = v.instance
                        v.instance = { ...rest, target: type.name }
                        if (type.args.length) {
                            if (!v.instance.generics?.length) v.instance = { ...v.instance, generics: type.args.map(copyGenericArg), declGenerics: true }
                            else {
                                this.ctx.report({
                                    severity: 'error', code: 'generic-arguments-conflict', span: v.span, related: v.decl ? [v.decl] : undefined,
                                    message: `\`${type.name}\` already comes with generic arguments (\`${type.text}\`), and the declaration of \`${v.name}\` gives it some more`,
                                    kieler: `Conflicting generic parameters passed to reference declaration of ${v.name} via generic type and in declaration.`,
                                    hint: 'Give the generic arguments in one place: where the chart is passed as a type, or in the declaration.',
                                })
                            }
                        }
                    } else if (type?.k === 'type') plainVariable(v, type.type, d => this.ctx.report(d))
                } else if (v.typeParam) {
                    const type = types.get(typeName(v.typeParam))
                    if (type?.k === 'type') plainVariable(v, type.type, d => this.ctx.report(d))
                }
                const m = v.method
                if (!m || v.member) continue
                if (m.returnParam) {
                    const type = types.get(typeName(m.returnParam))
                    if (type?.k === 'type') {
                        m.returnType = type.type
                        delete m.returnParam
                    } else {
                        this.ctx.report({
                            severity: 'error', code: 'generic-method-type', span: m.span, related: v.decl ? [v.decl] : undefined,
                            message: `The return type of \`${v.name}\` is a generic parameter that was not given a primitive type`,
                            kieler: 'Only primitive generic types are currently supported as return types.',
                            hint: 'Give the chart a type such as `int` for this parameter.',
                        })
                    }
                }
                for (const p of m.params) {
                    if (!p.typeParam) continue
                    const type = types.get(typeName(p.typeParam))
                    if (type?.k === 'type') plainVariable(p, type.type, d => this.ctx.report(d))
                    else {
                        this.ctx.report({
                            severity: 'error', code: 'generic-method-type', span: p.span ?? m.span, related: v.decl ? [v.decl] : undefined,
                            message: `The type of the parameter \`${p.name}\` of \`${v.name}\` is a generic parameter that was not given a primitive type`,
                            kieler: 'Only primitive generic types are currently supported as parameter types.',
                            hint: 'Give the chart a type such as `int` for this parameter.',
                        })
                    }
                }
            }
        }
    }

    /** The interface declarations of a copy go; what still names one afterwards points out of the model. */
    private removeInterface(inst: CState) {
        for (const v of inst.decls) if (v.input || v.output) this.removed.add(v)
        inst.decls = inst.decls.filter(v => !(v.input || v.output))
    }

    /** Output initial values become entry actions of the copy, after the chart's own (S-10); input ones are dropped. */
    private interfaceInitialValues(inst: CState, chart: State, bindings: { name: string; actual: CExpr }[], owner: string, span: Span | undefined) {
        for (const f of inst.decls) {
            if (!(f.input || f.output)) continue
            if (f.output && f.init && (!f.declKind || f.declKind === 'primitive')) {
                const actual = bindings.find(b => b.name === f.name)?.actual
                const target = actual?.k === 'ref' ? actual.v : undefined
                // Only when the two initial values differ: with equal ones "not its own" would only be noise.
                if (target?.init && !sameExpr(f.init, target.init)) {
                    this.ctx.report({
                        severity: 'info', code: 'kieler-quirk', span, related: [owner],
                        message: `\`${target.display ?? target.name}\` gets the initial value of \`${chart.name}\`'s output \`${f.name}\` whenever \`${owner.split(/[.:/]/).pop()}\` is entered, not its own`,
                        hint: `KIELER turns the referenced chart's output initial values into entry actions of the referencing state, so they win over the initial value declared here and are applied again on every entry.`,
                    })
                }
                const entry = createEntryAction(inst)
                entry.about = owner
                entry.effects.push({ k: 'assign', ref: ref(f), op: '=', expr: f.init, o: { by: f.decl, init: f.decl, span: f.span } })
            }
            f.init = undefined
        }
    }

    /** Charts with type parameters may nest in themselves; a chart without is being copied into itself for ever. */
    private checkRecursion(chart: State, owner: string, span: Span | undefined) {
        const typed = (chart.genericParameterDeclarations ?? []).some(g => g.typeName !== undefined ? !g.reference : g.valueType === undefined || g.valueType === 'primitive')
        const itself = this.stack[0] === chart.name
        if (this.stack.includes(chart.name) && (itself || !typed)) {
            this.recursive(chart.name, owner, span)
            throw new Recursion()
        }
        if (this.stack.length > MAX_DEPTH) {
            this.ctx.report({
                severity: 'error', code: 'kieler-crash', span, related: [owner],
                message: `\`${chart.name}\` is used inside itself without end`,
                kieler: 'java.lang.StackOverflowError',
                hint: 'A chart with type parameters that uses itself is copied into itself for ever: KIELER\'s compiler runs out of stack. Express the repetition with states and transitions instead.',
            })
            throw new Recursion()
        }
    }

    // ----- one instance -----

    /** Expands `state S is C(args)` (KIELER's expandReferencedScope for states). */
    expandState(s: CState, replacements: Replacements) {
        const call = referenceCall(s)
        if (!call || call.super) return
        if (s.ext.calls) {
            // `calls` is not expanded (isModuleExpansionReference): KIELER's C code calls a function it never defines (S-19).
            delete s.ext.reference
            this.ctx.report({
                severity: 'error', code: 'module-call', span: call.span, related: s.origin ? [s.origin] : undefined,
                message: `\`calls ${call.target}\` does not work in KIELER's C simulation`,
                kieler: `implicit declaration of function ‘_r${call.target}’ [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)`,
                hint: `Write \`state ${s.name} is ${call.target}(...)\` instead: is copies the chart into the state, calls generates a C function call that KIELER's netlist code never defines.`,
            })
            return
        }
        const id = s.origin ?? s.about ?? s.name
        const written = s.ext.reference as ScopeCall | undefined
        if (written?.targetParameter && s.ext.target === undefined) {
            // The type parameter was given no chart (or a chart type handed on from another parameter).
            delete s.ext.reference
            this.ctx.report({
                severity: 'error', code: 'generic-type-unbound', span: call.span, related: [id],
                message: `\`${call.target}\` is a type parameter that stands for no chart here, so \`${s.name}\` cannot be an instance of it`,
                kieler: `Invalid reference ${call.target}! Only States/Regions can be instantiated.`,
                hint: `KIELER puts a chart in the place of \`${call.target}\` only where the chart is named itself in the generic arguments (\`<SomeChart>\`), not through \`extends\` and not handed on from another type parameter.`,
            })
            return
        }
        const chart = this.findChart((s.ext.target as string | undefined) ?? call.target)
        if (!chart) return
        const prefix = id + REFERENCE_SEPARATOR
        this.checkRecursion(chart, id, call.span)
        const lowered = lowerInstance(chart, this.index, prefix, this.local(chart) ? undefined : call.span)
        for (const d of lowered.reports) this.ctx.report(d)
        const inst = lowered.root
        if (lowered.stateFlags.length) this.stateAccess(lowered.stateFlags[0], chart, id, call.span)
        // Inheritance of the copy, with what is bound further out (the bindings of this reference come after).
        if (inst.ext.baseStates) this.inheritedSchedule(inst, chart, call.span)
        if (inst.ext.baseStates) inherit(this.ctx, inst, chart, name => this.findChart(name), replacements)
        const bindings = this.interfaceBindings(chart, call.args, s, replacements, id, call.span)
        for (const b of bindings) replacements.push(b.name, b.actual)
        this.bindGenerics(inst, call.generics ?? (s.ext.genericArgs as CGenericArg[] | undefined), replacements)
        this.interfaceInitialValues(inst, chart, bindings, id, call.span)
        this.records.push({ state: id, prefix, chart })
        this.replaceGenericTypes(inst, replacements)
        delete inst.ext.generics
        // Name clashes with the referencing state's surroundings (resolveNameClashes, S-11).
        this.resolveNameClashes(inst, s)
        this.stack.push(chart.name)
        try {
            // Binding is substitution by name; the references inside the copy are expanded on the way.
            this.replacer(replacements, id, true).state(inst)
            // The copy takes the referencing state's place: appended to the region, with its transitions.
            const region = s.parent!
            inst.name = s.name
            inst.label = s.label
            inst.initial = s.initial
            inst.final = s.final
            inst.origin = s.origin
            inst.about = s.about
            for (const [k, v] of s.annotations) inst.annotations.set(k, v)
            region.states.splice(region.states.indexOf(s), 1)
            inst.parent = region
            region.states.push(inst)
            for (const t of [...s.out]) setSource(t, inst)
            for (const t of [...s.incoming]) setTarget(t, inst)
            this.removeInterface(inst)
            // Its dataflow regions, and the references these create.
            processDataflow(inst, this)
            for (const x of allContainedStates(inst).filter(isReferencing)) this.expandState(x, new Replacements())
        } finally {
            this.stack.pop()
        }
    }

    /**
     * `state(S)` in a method of a chart referenced with `is`: KIELER's MethodSignaling makes the flag for the chart it
     * compiles and for the instances of `ref` declarations, not for a copy made for a referencing state, so the C code
     * still has the access (structure.md S-69).
     */
    private stateAccess(flag: CVar, chart: State, owner: string, span: Span | undefined) {
        this.ctx.report({
            severity: 'error', code: 'state-access-copy', span, related: [owner],
            message: `\`${chart.name}\` uses \`${flag.display ?? 'state(...)'}\` in a method, which does not work in a chart referenced with \`is\``,
            kieler: 'implicit declaration of function \u2018state\u2019 [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)',
            hint: `KIELER only translates \`state(...)\` in the chart it compiles and in instances declared with \`ref ${chart.name} x\`. Declare the instance with \`ref\`, or let the chart set a variable in the state's entry and exit actions.`,
        })
    }

    /** KIELER's resolveNameClashes: a copied declaration whose name is declared around the reference is renamed `_x_`. */
    private resolveNameClashes(copy: CState | CRegion, referencing: Scope) {
        const reserved = this.reserved(referencing)
        for (const v of declaredVars(copy)) {
            if (v.input || v.output) continue
            if (!reserved.has(v.name)) continue
            const base = `_${v.name}_`
            let name = base
            for (let i = 2; reserved.has(name); i++) name = base + i
            v.name = name
        }
    }

    /**
     * `region Q is R` (KIELER's expandReferencedScope for regions, structure.md S-17): a copy of the inherited region
     * R, appended to the state's regions in Q's place. What R names outside itself is bound like a chart's interface:
     * in the order it is first named, to the arguments, otherwise to the variable of the same name around Q. (The
     * form `region is super.R` is handled where the base charts are inherited, passes/inheritance.ts.)
     */
    expandRegion(region: CRegion, replacements: Replacements) {
        const call = region.ext.reference as ScopeCall | undefined
        if (!call || call.super) return
        delete region.ext.reference
        const parent = region.parent
        const source = this.findInheritedRegion(region, call.target)
        if (!source) return
        const id = region.origin ?? region.name ?? ''
        const prefix = `${id}${REFERENCE_SEPARATOR}`
        const lowered = lowerInstance(source.chart, this.index, prefix)
        const copy = lowered.root.regions.find(r => r.origin === prefix + source.region)
        if (!copy) return
        // The variables the region names (in the order they are first named) are its interface.
        const inside = new Set(declaredVars(copy))
        const targets: CVar[] = []
        const visit = (r: CRef) => {
            if (!inside.has(r.v) && !targets.includes(r.v)) targets.push(r.v)
        }
        rewriteScope(copy, { read: r => { visit(r); return undefined }, target: r => { visit(r); return undefined } })
        const args = (region.ext.args as CArg[] | undefined) ?? []
        const bound = new Map<CVar, CExpr>()
        let ptr = 0
        for (const a of args) {
            if (a.binding !== undefined) {
                const i = targets.findIndex(v => v.name === a.binding)
                if (i < 0) continue
                ptr = i
            }
            if (ptr >= targets.length) continue
            bound.set(targets[ptr], a.expr)
            ptr++
        }
        for (const v of targets) {
            if (bound.has(v)) continue
            const outer = this.lookup(region, v.name)
            if (outer) bound.set(v, replacements.peek(v.name)?.k === 'ref' ? replacements.peek(v.name)! : { k: 'ref', v: outer, idx: [] })
        }
        for (const [v, actual] of bound) replacements.push(v.name, actual)
        this.resolveNameClashes(copy, region)
        this.replacer(replacements, id, true).scope(copy)
        copy.name = region.name
        copy.label = region.label
        copy.parent = parent
        for (const [k, v] of region.annotations) copy.annotations.set(k, v)
        parent.regions.splice(parent.regions.indexOf(region), 1)
        parent.regions.push(copy)
        this.records.push({ state: parent.origin ?? '', prefix, chart: source.chart, declaration: true })
        processDataflow(parent, this)
        for (const x of allContainedStates(parent).filter(isReferencing)) this.expandState(x, new Replacements())
    }

    /** The region a `region Q is R` names: R among the regions the next enclosing state with base charts inherits. */
    private findInheritedRegion(region: CRegion, name: string): { chart: State; region: string } | undefined {
        for (let s: CState | undefined = region.parent; s; s = s.parent?.parent) {
            const bases = s.ext.inheritedRegions as { chart: State; region: string; name?: string }[] | undefined
            if (!bases) continue
            const found = bases.find(r => r.name === name)
            return found ? { chart: found.chart, region: found.region } : undefined
        }
        return undefined
    }

    /**
     * `ref C g(args)` declarations the classic dataflow translation has not taken (KIELER's handleSCChartsDatatype,
     * S-18): outside dataflow, and the instances of dataflow regions that call methods (S-33a). An array of
     * instances (`ref C gs[2]`) keeps one array per member; the chart's regions and actions are there once per
     * element, working on that element's members, and its methods take the element's indices as hidden parameters
     * (structure/instanceArray.ts).
     */
    private expandDeclarations(root: CState, parent: Replacements | undefined) {
        for (const scope of allScopes(root)) {
            for (const v of [...scope.decls]) {
                if (v.declKind !== 'reference' || !v.instance || v.input || v.instance.typeParam) continue
                const chart = this.findChart(v.instance.target)
                if (!chart) continue
                const id = v.decl ?? v.name
                const sizes = v.dims.map(d => {
                    const n = foldConstants(copyExpr(d))
                    return n.k === 'lit' && typeof n.v === 'number' ? n.v : undefined
                })
                if (sizes.some(n => n === undefined)) {
                    this.ctx.report({
                        severity: 'error', code: 'reference-array-size', span: v.span, related: v.decl ? [v.decl] : undefined,
                        message: `The size of the array of instances \`${v.name}\` must be a number or a constant`,
                        kieler: 'Can only handle reference arrays with constant cardinality',
                        hint: `Write the size as a number (\`ref ${chart.name} ${v.name}[2]\`) or as a \`const int\` with a number as its value.`,
                    })
                    continue
                }
                const elements = elementIndices(sizes as number[])
                // An array without elements (`ref C g[0]`) still has its class, and KIELER's loop over the elements, from
                // 0 to their number minus one, counts down in Xtend: two copies of the chart's regions and actions,
                // for the elements 0 and -1, both working on element 0 (emptyArrayBehaviour).
                const none = !elements.length
                const zero = sizes.map(() => 0)
                const copies = none ? [{ at: zero, tag: '0' }, { at: zero, tag: '-1' }] : elements.map(at => ({ at, tag: at.join('][') }))
                const target = isRegion(scope) ? scope.parent : scope
                /** The first element's declarations: the members of every element. */
                let members: CVar[] = []
                /** The class's methods, where KIELER declares them (structure/bodies.ts). */
                let classMethods: CVar[] = []
                let outside = false
                copies.forEach(({ at, tag }, x) => {
                    const prefix = sizes.length ? `${id}[${tag}]${REFERENCE_SEPARATOR}` : id + REFERENCE_SEPARATOR
                    // What lowering and expanding the chart reports is the same for every element: once.
                    if (x > 0) this.muted++
                    let inst: CState
                    try {
                        inst = this.instantiate(v, chart, prefix, scope, parent)
                    } finally {
                        if (x > 0) this.muted--
                    }
                    // The chart is the instance's class: one more class around every schedule declared in it, and its
                    // own schedules are the instance's (passes/contracts.ts classSchedules reports what KIELER refuses).
                    for (const local of inst.decls) {
                        if (local.declKind === 'schedule') {
                            local.scheduleDepth = (local.scheduleDepth ?? 0) + 1
                            local.scheduleOf = local.scheduleDepth === 1 ? v.name : undefined
                            local.scheduleInstance = local.scheduleDepth === 1 ? v : undefined
                            if (local.scheduleDepth === 1) local.display = `${v.name}.${local.name}`
                        }
                        // (A code block of the chart's own actions is no method of the class: KIELER moves it out with them.)
                        if (local.method && !local.member && !local.generated) local.classInstance = v
                    }
                    if (x === 0 && !this.muted) {
                        const cls = this.classOf(v, scope, chart)
                        v.className = cls.name
                        v.classKey = cls.key
                    }
                    const spread = applySpreads(inst, (inst.ext.spreads as SpreadBinding[] | undefined) ?? [], x, elements.length, v, v.className ?? `${chart.name}1`,
                        o => this.index?.vos.get(sourceId(o.decl ?? ''))?.decl?.valuedObjects.length ?? 1, d => { if (x === 0) this.ctx.report(d) })
                    if (x === 0) {
                        members = [...inst.decls]
                        if (!this.muted) for (const l of members) if (l.method) l.method = { ...l.method, cls: v.classKey, instance: v }
                        this.checkSignals(v, inst, chart)
                        this.redirectMembers(v, prefix, inst, root, sizes.length)
                    }
                    if (sizes.length) elementOf(inst, members, at, x === 0)
                    if (x === 0) {
                        // The class KIELER makes of the instance (structure/poolShape.ts): the chart's declarations,
                        // the chart instances declared in it as classes inside (objects inside this instance's object).
                        const inside = chartInstancesOf(inst)
                        const all = (list: ChartInstance[]): CVar[] => list.flatMap(c => [c.v, ...all(c.inside)])
                        if (sizes.length) arrayMembers(members, v.dims, sizes as number[], all(inside))
                        // What is spread over the elements and stays a field: assigned when the declaring state is entered.
                        if (spread.length) {
                            const entry = createEntryAction(target, 0)
                            for (const { field, values } of spread) {
                                values.forEach((value, i) => entry.effects.push({
                                    k: 'assign', ref: { k: 'ref', v: field, idx: [{ k: 'lit', t: 'int', v: i }] }, op: '=', expr: copyExpr(value),
                                    o: { by: field.decl, span: field.span },
                                }))
                            }
                        }
                        for (const c of inside) c.v.member = { of: v, name: c.v.name }
                        // (In the chart's own order, the classes of the instances inside it at their places.)
                        classMethods = declarationsOf(inst).filter(l => l.method && !l.generated)
                        chartInstancesOf(target).push({
                            v, inside, methods: inst.decls.filter(l => l.method && !l.generated),
                            declared: inst.decls.some(l => !l.generated) || inside.some(c => c.declared),
                        })
                        // The instance's locals become hidden members of the declaring state (in KIELER's data pool:
                        // members of an object named after the declaration, `"g": {"k": 0}`).
                        for (const local of [...inst.decls]) {
                            // A member of an instance inside the chart keeps its instance; the instance is the member.
                            if (!local.member && (!local.declKind || local.declKind === 'class' || local.declKind === 'struct')) local.member = { of: v, name: local.name }
                            // In messages: the member as the declaring chart writes it (`g.a`).
                            // (Written in the chart, whatever its name: `int _a` is a field like any other.)
                            if (!local.generated) local.tags.add(DECLARED_MEMBER)
                            if (!local.generated && !local.display) local.display = `${v.name}.${local.name}`
                            local.name = `_${v.name}_${local.name}`
                            local.generated = true
                            addVar(target, local)
                        }
                    }
                    if (none && x === 0 && usesFields(inst, members)) {
                        outside = true
                        this.emptyArrayBehaviour(v, chart)
                    }
                    if (outside) return
                    for (const r of [...inst.regions]) {
                        r.name = `${v.name}${elements.length > 1 ? x : ''}_${r.name ?? 'default'}`
                        r.parent = target
                        target.regions.push(r)
                    }
                    target.actions.push(...inst.actions)
                    this.records.push({ state: target.origin ?? '', prefix, chart, declaration: true })
                })
                // KIELER's class takes the declaration's place (`ref.replace(classDecl)`), its methods with it. A
                // region's declarations go on before the Pre processor runs (Region Actions): to the end of its
                // state's, or, when the region has actions, into the state that wraps it (structure/bodies.ts).
                const following = scope.decls.slice(scope.decls.indexOf(v) + 1)
                if (isRegion(scope) && !scope.actions.length) {
                    // (Before the rest of its region's declarations, and those of the regions after it.)
                    const regions = target.regions.slice(target.regions.indexOf(scope) + 1).filter(r => !r.actions.length)
                    placeDeclarations(target, classMethods, [...following, ...regions.flatMap(r => r.decls)], v, true)
                } else placeDeclarations(scope, classMethods, following, v)
                scope.decls.splice(scope.decls.indexOf(v), 1)
            }
        }
    }

    /**
     * `ref C g[0]` of a chart whose regions or actions name a field. The two copies KIELER makes of them work on the
     * element 0 that the array does not have, so on whatever lies behind it in KIELER's C data (the counters of the
     * taken transitions in the probes structure/probe-reference-instance-array-zero-*).
     */
    private emptyArrayBehaviour(v: CVar, chart: State) {
        this.ctx.report({
            severity: 'info', code: 'unsupported', span: v.span, related: v.decl ? [v.decl] : undefined,
            message: `The guide's simulator cannot run \`${v.name}\`, an array of no instances of \`${chart.name}\`, whose regions and actions KIELER still runs on the fields of an instance that is not there`,
            hint: `KIELER makes two copies of \`${chart.name}\`'s regions and actions for an array without elements, and their reads and writes of \`${chart.name}\`'s fields go to memory behind the empty array. Give the array at least one element, or remove the declaration.`,
        })
    }

    /**
     * One expanded copy of the chart a `ref` declaration instantiates, with its interface and generic parameters
     * bound (on top of what the instances around it have bound, `parent`).
     */
    private instantiate(v: CVar, chart: State, prefix: string, scope: Scope, parent: Replacements | undefined): CState {
        const id = v.decl ?? v.name
        const dataflow = v.tags.has(DF_BINDING)
        this.checkRecursion(chart, id, v.span)
        const lowered = lowerInstance(chart, this.index, prefix, this.local(chart) ? undefined : v.span)
        for (const d of lowered.reports) this.ctx.report(d)
        const inst = lowered.root
        // (Before the base charts' declarations join them.)
        const own = new Set(inst.decls)
        const replacements = new Replacements(parent)
        const bindings = this.interfaceBindings(chart, v.instance!.args, scope, replacements, id, v.span, dataflow)
        // A vector bound to a scalar constant input of an array of instances is spread over them, not substituted.
        const spreads: SpreadBinding[] = []
        for (const b of bindings) {
            const formal = inst.decls.find(l => l.name === b.name && (l.input || l.output))
            if (isSpread(v, formal, b.actual)) spreads.push({ formal: formal!, vector: b.actual })
            else replacements.push(b.name, b.actual)
        }
        inst.ext.spreads = spreads
        this.bindGenerics(inst, v.instance!.generics, replacements)
        const implicit = !!(inst.ext.generics as CVar[] | undefined)?.length || !!inst.ext.baseStates
        this.stack.push(chart.name)
        this.instanceDepth++
        try {
            this.expandRoot(inst, replacements, chart)
        } finally {
            this.instanceDepth--
            this.stack.pop()
        }
        // Without base charts and generic parameters nothing has bound the interface yet. (The interface
        // declarations go with their initial values: no entry actions here.)
        if (!implicit) this.replacer(replacements, id, false).state(inst)
        // (A spread constant is an ordinary variable of the class from here on.)
        for (const s of spreads) {
            s.formal.input = false
            s.formal.const = false
        }
        if (!dataflow) {
            this.removeInterface(inst)
            return inst
        }
        // An instance of an OO dataflow region keeps its inputs and outputs as public variables, initial values
        // included, except those whose name is on the replacement stack: bound here, bound for an instance around
        // this one (S-18a), or declared again somewhere inside the chart (KIELER asks `containsKey`, and the walk
        // leaves every name it has pushed as a key).
        for (const f of [...inst.decls]) {
            if (!(f.input || f.output)) continue
            if (replacements.has(f.name)) {
                this.removed.add(f)
                inst.decls.splice(inst.decls.indexOf(f), 1)
                if (!this.lostPorts.has(v)) this.lostPorts.set(v, new Map())
                this.lostPorts.get(v)!.set(f.name, bindings.some(b => b.name === f.name) ? 'bound' : parent?.has(f.name) ? 'outer' : 'inner')
                continue
            }
            // (KIELER's simulation interface still lists an inherited one as an input or output.)
            if (!own.has(f) && !f.declKind) f.tags.add(f.input ? '#port-input' : '#port-output')
            f.input = false
            f.output = false
            // (A constant input that nothing binds is a variable that stays 0: there is no value to put in its place.)
            if (f.const && !f.init) f.const = false
        }
        return inst
    }

    /**
     * The class KIELER makes of the instance's declaration (createPolicyClassDeclaration, uniqueName): `<Chart>1`,
     * the next declaration of that chart `<Chart>2`, past every name the file has already (a class `<Chart>1`).
     * Instances declared together share it, unless one of them has arguments
     * (separateReferenceDeclarationsWithIndividualBindingsInVOs gives every further one its own).
     */
    private classOf(v: CVar, scope: Scope, chart: State): { name: string; key: string } {
        const group = v.instance?.separate ? undefined : v.instance?.group
        const known = group !== undefined ? this.classes.get(scope)?.get(group) : undefined
        if (known) return known
        // (The chart's own name is taken: it is in the file, or in a file it imports.)
        this.names.add(chart.name)
        const name = this.names.unique(chart.name)
        const made = { name, key: `${name}#${++this.classKeys}` }
        if (group !== undefined) {
            if (!this.classes.has(scope)) this.classes.set(scope, new Map())
            this.classes.get(scope)!.set(group, made)
        }
        return made
    }

    /**
     * The instance is a class to KIELER from here on, and its Signal processor refuses a class with a signal: a local
     * signal of the chart, or an input or output signal that an OO dataflow region keeps with the instance.
     */
    private checkSignals(v: CVar, inst: CState, chart: State) {
        const signal = inst.decls.find(l => l.signal)
        if (!signal) return
        const port = v.tags.has(DF_BINDING) && signal.decl !== undefined && !!this.index?.vos.get(sourceId(signal.decl))?.decl?.input
        this.ctx.report({
            severity: 'error', code: 'signal-member', span: v.span, related: v.decl ? [v.decl] : undefined,
            message: `\`${v.name}\` cannot be an instance of \`${chart.name}\`: the chart has the signal \`${signal.name}\``,
            kieler: 'Signals in class declarations not yet supported',
            hint: v.tags.has(DF_BINDING)
                ? `A dataflow region that calls a method keeps its instances as objects, and KIELER does not compile an object with a signal. Make \`${signal.name}\` a variable (\`${port ? 'input ' : ''}bool ${signal.name}\`) in \`${chart.name}\`.`
                : `KIELER turns the instance into an object, and it does not compile an object with a signal. Make \`${signal.name}\` a variable (\`bool ${signal.name}\`) in \`${chart.name}\`.`,
        })
    }

    /**
     * KIELER's validate: every reference must name a variable that is still in the model. A generic parameter that
     * was not replaced, or an input or output of a copy named where the replacement does not look, points out of it.
     */
    private validate(root: CState) {
        const lost = new Map<CVar, Span | undefined>()
        // (The Inheritance pass removes the declarations `extends Base(...)` binds.)
        for (const v of (this.ctx.shared.removedVars as Set<CVar> | undefined) ?? []) this.removed.add(v)
        let visit = (e: CExpr | undefined, span?: Span) => walkExpr(e, x => {
            if (x.k !== 'ref') return
            for (let r: CRef | undefined = x; r; r = r.sub) {
                if ((r.v.declKind === 'generic' || this.removed.has(r.v)) && !lost.has(r.v) && !this.failed.has(r.v)) lost.set(r.v, x.span ?? span)
            }
        })
        const statements = (list: CStmt[]) => {
            for (const s of list) {
                switch (s.k) {
                    case 'do': for (const e of effectExprs(s.f)) visit(e, s.f.o.span); break
                    case 'if': visit(s.cond); statements(s.then); if (s.else) statements(s.else); break
                    case 'while': visit(s.cond); statements(s.body); break
                    case 'for': statements(s.init); visit(s.cond); statements(s.update); statements(s.body); break
                    case 'return': visit(s.expr); break
                    case 'expr': visit(s.e); break
                    default: break
                }
            }
        }
        const generic = (list: CGenericArg[] | undefined) => {
            for (const g of list ?? []) {
                if (g.k === 'expr') visit(g.expr, g.span)
                else if (g.k === 'chart') generic(g.args)
            }
        }
        // A state inside a copy made for `is` keeps its `extends`: KIELER inherits for the copy itself only, so what
        // the state takes from its base charts is not there.
        const inheritedIds = new Set<string>()
        for (const s of allContainedStates(root)) {
            if (s.ext.baseStates === undefined) continue
            const source = this.sourceState(s)
            if (source) for (const id of inheritedDeclarations(source, this.index)) inheritedIds.add(id)
        }
        const visitPlain = visit
        visit = (e: CExpr | undefined, span?: Span) => {
            visitPlain(e, span)
            walkExpr(e, x => {
                if (x.k === 'ref' && x.v.declKind === 'unresolved' && x.v.decl && inheritedIds.has(sourceId(x.v.decl)) && !lost.has(x.v)) lost.set(x.v, x.span ?? span)
            })
        }
        for (const scope of allScopes(root)) {
            for (const v of scope.decls) {
                visit(v.init, v.span)
                v.dims.forEach(d => visit(d, v.span))
                if (v.method) statements(v.method.body)
                for (const a of v.instance?.args ?? []) visit(a.expr, a.span)
                generic(v.instance?.generics)
            }
            for (const a of scope.actions) {
                visit(a.trigger, a.span)
                for (const f of a.effects) for (const e of effectExprs(f)) visit(e, f.o.span)
            }
            if (isRegion(scope)) {
                for (const eq of (scope.ext.eqs as CEquation[] | undefined) ?? []) { visit(eq.target, eq.span); visit(eq.expr, eq.span) }
                visit(scope.ext.forFrom as CExpr | undefined)
                visit(scope.ext.forTo as CExpr | undefined)
            } else {
                for (const t of scope.out) {
                    visit(t.trigger, t.span)
                    for (const f of t.effects) for (const e of effectExprs(f)) visit(e, f.o.span)
                }
                for (const a of (scope.ext.args as CArg[] | undefined) ?? []) visit(a.expr, a.span)
                generic(scope.ext.genericArgs as CGenericArg[] | undefined)
                for (const b of (scope.ext.baseArgs as { args: CArg[]; generics: CGenericArg[] }[] | undefined) ?? []) {
                    for (const a of b.args) visit(a.expr, a.span)
                    generic(b.generics)
                }
            }
        }
        for (const [v, span] of lost) {
            if (v.declKind === 'unresolved') {
                this.ctx.report({
                    severity: 'error', code: 'unbound-reference', span: span ?? v.span, related: v.decl ? [v.decl] : undefined,
                    message: `\`${v.name}\` comes from a base chart of a state inside a chart referenced with \`is\`, and KIELER does not inherit there`,
                    kieler: `The valued object reference points to a valued object (${v.name}) that is not contained in the model!\nReferences objects are not contained in the resource!`,
                    hint: 'KIELER applies `extends` to the chart it compiles, to the states inside it and to instances declared with `ref`, but not to the states inside a chart it copies for `state S is C`. Declare the instance with `ref`, or let the referenced chart itself extend the base chart.',
                })
                continue
            }
            const parameter = v.declKind === 'generic'
            this.ctx.report({
                severity: 'error', code: 'unbound-reference', span: span ?? v.span, related: v.decl ? [v.decl] : undefined,
                message: parameter
                    ? `The generic parameter \`${v.name}\` is named where KIELER does not put its argument in`
                    : `\`${v.name}\` is an input or output of a referenced chart, named where KIELER does not put the bound variable in`,
                kieler: `The valued object reference points to a valued object (${v.name}) that is not contained in the model!\nReferences objects are not contained in the resource!`,
                hint: parameter
                    ? `KIELER replaces a generic parameter in triggers, effects, initial values, method bodies and the arguments of references, but not in the range of a for-region, in the members of a class, in \`print\`, in the generic arguments of \`is C<...>\` and \`ref C<...> x\`, or in a chart that only inherits it without giving it a value. Copy \`${v.name}\` into a variable of the chart and use that there.`
                    : `KIELER replaces an input or output of a referenced chart in triggers, effects, initial values, method bodies and the arguments of references, but not in the range of a for-region, in the members of a class or in \`print\`. Copy \`${v.name}\` into a variable of the chart and use that there.`,
            })
        }
    }

    /**
     * A chart used as a class (structure.md S-65): `c.step` and `c.increment()` in the chart that declares `ref C c`
     * mean the instance's own field and method (KIELER's handleSCChartsDatatype). `root` is the chart being expanded:
     * the copy that declares the instance, which is not yet part of the simulated chart.
     */
    private redirectMembers(v: CVar, prefix: string, inst: CState, root: CState, dimensions = 0) {
        // By the declaration's own id (an inherited one is `<instance>/<chart>/<id>`: the last part).
        const byDecl = new Map<string, CVar>()
        for (const local of inst.decls) if (local.decl?.startsWith(prefix)) byDecl.set(local.decl.split(REFERENCE_SEPARATOR).pop()!, local)
        // The member as name resolution found it, or (KIELER's fixMemberAssociation) the instance's member of that
        // name: a method by its number of parameters. The instance may be of another chart than the one the member
        // was resolved in: a subtype given for a chart type parameter, or the instance behind `V is ref C`.
        const named = (name: string, args?: number): CVar | undefined => {
            const all = inst.decls.filter(l => !l.member && l.name === name)
            return (args !== undefined ? all.find(l => l.method && l.method.params.filter(p => !p.tags.has('#self')).length === args) : undefined) ?? all[0]
        }
        const member = (r: CRef, args?: number): CRef | undefined => {
            if (r.v !== v || !r.sub) return undefined
            // (Inside a referenced chart's copy the member's id carries that copy's prefix.)
            const id = r.sub.v.decl
            const m = (id ? byDecl.get(id) ?? byDecl.get(sourceId(id)) : undefined) ?? (r.sub.v.declKind === 'unresolved' ? named(r.sub.v.name, args) : undefined)
            if (!m) return undefined
            // (An array named without its index on the way stays marked: codegen.ts.)
            const unindexed = r.unindexed ?? r.sub.unindexed
            let out: CRef = { ...r.sub, v: m, idx: [...r.idx, ...r.sub.idx], ...(unindexed ? { unindexed } : {}) }
            // A class or struct object of the chart (`g.q.w`, `g.q.get()`): on to its member, a variable of its own.
            while (out.sub && (out.v.declKind === 'class' || out.v.declKind === 'struct')) {
                const next = out.sub.v.decl === undefined ? undefined : sourceId(out.sub.v.decl)
                const inner = inst.decls.find(l => l.member?.of === out.v && l.decl !== undefined && sourceId(l.decl) === next)
                if (!inner) break
                out = { ...out.sub, v: inner, idx: [...out.idx, ...out.sub.idx], ...(out.unindexed ?? out.sub.unindexed ? { unindexed: out.unindexed ?? out.sub.unindexed } : {}) }
            }
            return out
        }
        // What is left without its member afterwards: a port that is a variable bound further out (instantiate).
        const lost: CRef[] = []
        const resolve = (r: CRef): CRef | undefined => {
            const m = member(r)
            if (!m && r.v === v && r.sub && !r.sub.sub && r.sub.v.declKind === 'unresolved') lost.push(r)
            return m
        }
        rewriteScope(root, {
            read: resolve,
            target: resolve,
            node: e => {
                if (e.k !== 'call' || !e.target) return undefined
                const t = member(e.target, e.args.length)
                if (!t) return undefined
                // A method of an element of an array of instances takes the element's indices as its first arguments
                // (a method of a class object inside it: the indices of every array on the way).
                if (t.v.method && (t.v.member ? t.idx.length : dimensions)) {
                    const own = t.v.member ? t.idx.length : dimensions
                    return { ...e, target: { ...t, idx: t.idx.slice(own) }, name: t.v.name, args: [...t.idx.slice(0, own), ...e.args] }
                }
                return { ...e, target: t, name: t.v.name }
            },
        })
        if (lost.length && v.tags.has(DF_BINDING)) {
            const names = [...new Set(lost.map(r => r.sub!.v.name))]
            const why = this.lostPorts.get(v)?.get(names[0]) ?? 'outer'
            const chart = v.instance?.target ?? 'the chart'
            this.ctx.report({
                severity: 'error', code: 'dataflow-instance-port', span: lost[0].span ?? v.span, related: v.decl ? [v.decl] : undefined,
                message: why === 'bound' ? `\`${v.name}.${names[0]}\` does not exist in KIELER's compiled chart: the declaration of \`${v.name}\` binds \`${names[0]}\`, so it is no member of the instance`
                    : why === 'inner' ? `\`${v.name}.${names[0]}\` does not exist in KIELER's compiled chart: \`${chart}\` declares another \`${names[0]}\` inside, and KIELER then takes its input or output \`${names[0]}\` for bound`
                    : `\`${v.name}.${names[0]}\` does not exist in KIELER's compiled chart: the chart around \`${v.name}\` is itself an instance, and a variable called \`${names[0]}\` is bound for it`,
                kieler: [...names.map(n => `The valued object reference points to a valued object (${n}) that is not contained in the model!`), 'References objects are not contained in the resource!'].join('\n'),
                hint: why === 'bound' ? `An input or output bound in the declaration (\`x to ${names[0]}\`) is the bound variable. Wire it with the binding or with an equation, not both.`
                    : why === 'inner' ? `KIELER keeps the names it has seen while it binds the instance, and a variable \`${names[0]}\` declared in a state or region of \`${chart}\` is one of them. Rename the inner \`${names[0]}\`.`
                    : `KIELER keeps what is bound for an instance by name, so inside it every chart's \`${names[0]}\` means the variable bound further out, and \`${v.name}\` loses its own. Rename \`${names[0]}\` in one of the two charts.`,
            })
        }
    }

    private recursive(chart: string, owner: string, span: Span | undefined) {
        const path = [...this.stack]
        const cycle = path.slice(path.lastIndexOf(chart))
        const chain = [...cycle, chart].join(' -> ')
        const user = cycle[cycle.length - 1]
        this.ctx.report({
            severity: 'error', code: 'recursive-reference', span, related: [owner],
            message: cycle.length === 1 ? `\`${chart}\` uses itself, so its copy would contain another copy for ever` : `\`${user}\` uses \`${chart}\`, which leads back to \`${user}\``,
            kieler: `Recursive reference: chart ${cycle.length === 1 ? `${user} uses itself` : `\`${user}\` uses \`${chart}\`, which leads back to \`${user}\``} (${chain}).`,
            hint: `A reference such as \`state S is ${chart}(...)\` inserts a copy of \`${chart}\`, so a chart that uses itself, directly or through other charts, would be copied for ever (official KIELER never finishes compiling it). Express the repetition with states and transitions instead, e.g. a transition back to an earlier state.`,
        })
    }
}

export function isReferencing(s: CState): boolean {
    return s.ext.reference !== undefined || s.ext.call !== undefined
}

function referenceCall(s: CState): ReferenceCall | undefined {
    if (s.ext.call) return s.ext.call as ReferenceCall
    const call = s.ext.reference as ScopeCall | undefined
    if (!call) return undefined
    return { target: call.target, args: (s.ext.args as CArg[] | undefined) ?? [], span: call.targetSpan ?? call.span, super: call.super }
}

/** The name of a generic parameter from its declaration id (`<chart>$<name>`, behind an instance's prefix). */
function typeName(id: string): string {
    return id.slice(id.lastIndexOf('$') + 1).replace(/#\d+$/, '')
}

/** KIELER's createVariableDeclaration(type) for a declaration of a generic type: a plain variable, no longer an input or output. */
export function plainVariable(v: CVar, type: ValueType, report?: (d: Diagnostic) => void) {
    if (type === 'pure') {
        report?.({
            severity: 'error', code: 'generic-pure-type', span: v.span, related: v.decl ? [v.decl] : undefined,
            message: `\`${v.name}\` would be a variable of type pure: only signals can be pure`,
            kieler: `Cannot serialize simulation interface. Unsupported type: pure\nCannot serialize simulation interface. Unsupported type pure for variable ${v.name}`,
            hint: 'Give the type parameter `int`, `bool` or `float`: `pure` passes KIELER\'s check of the generic arguments, but its simulation cannot hold a pure variable.',
        })
    }
    v.type = type
    v.declKind = undefined
    v.typeParam = undefined
    v.instance = undefined
    v.input = false
    v.output = false
    v.const = false
}

function copyGenericArg(g: CGenericArg): CGenericArg {
    if (g.k === 'expr') return { ...g, expr: copyExpr(g.expr) }
    if (g.k === 'chart') return { ...g, args: g.args.map(copyGenericArg) }
    return { ...g }
}


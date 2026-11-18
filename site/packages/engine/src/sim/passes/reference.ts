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
// Order (expandRoot): references of states (in each copy: its own references, then its dataflow regions and the
// references these create), then the chart's dataflow regions, then `ref` declarations, then the references the
// dataflow regions created.

import type { ScopeCall, Span, State } from '../../types'
import type { ModelIndex } from '../../parser/resolve'
import type { Pass, PassContext } from './context'
import { construct } from './detect'
import {
    addVar, allContainedStates, allRegions, allScopes, allStates, copyExpr, createEntryAction, CVar, isRegion, ref, sameExpr,
    setSource, setTarget, type CArg, type CExpr, type CRef, type CState, type Scope,
} from '../model'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { declaredVars, rewriteScope, rewriteStatements } from '../structure/rewrite'
import { DF_BINDING, DF_REMOVED, processDataflow } from './dataflow'
import { inherit } from './inheritance'

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
    span?: Span
    super?: boolean
}

interface Instance {
    inst: CState
    /** The chart's inputs and outputs (KIELER's binding targets). */
    formals: CVar[]
    /** Formals bound to a variable or array cell. */
    map: Map<CVar, CRef>
    /** Every bound formal with what it is bound to (KIELER pushes these on its replacement stack, by name). */
    bound: Map<CVar, CExpr>
    /** The chart's own top-level declarations, as lowered. */
    own: CVar[]
    /** The inputs and outputs an OO dataflow instance keeps as members. */
    ports: Set<CVar>
}

class Recursion extends Error {}

/** KIELER names the expression class it cannot substitute (S-8). */
const CLASS_NAMES: Partial<Record<CExpr['k'], string>> = {
    op: 'de.cau.cs.kieler.kexpressions.impl.OperatorExpressionImpl',
    random: 'de.cau.cs.kieler.kexpressions.impl.RandomCallImpl',
    host: 'de.cau.cs.kieler.kexpressions.impl.TextExpressionImpl',
    call: 'de.cau.cs.kieler.kexpressions.impl.ReferenceCallImpl',
}

export class Expansion {
    readonly index: ModelIndex | undefined
    /** Charts being expanded, outermost first (the simulated chart, then each chart a copy is being made of). */
    private readonly stack: string[] = []
    readonly records: InstanceRecord[] = []
    /** Formals bound to an expression KIELER cannot substitute (reported where they are used). */
    private readonly badBindings = new Map<CVar, { actual: CExpr; state: string }>()
    private readonly reportedBad = new Set<CVar>()

    readonly ctx: PassContext
    /** While set, nothing is reported (the further elements of an array of instances repeat the first's reports). */
    private muted = 0
    /** What the `ref` instances being expanded have bound, by the bound name (KIELER's replacement stack). */
    private replacements = new Map<string, CExpr>()
    /** KIELER's classes for `ref` declarations: one per declaration, named after the chart with a running number. */
    private readonly classes = new Map<Scope, Map<object, { name: string; key: string }>>()
    private readonly classNumbers = new Map<string, number>()
    private classKeys = 0

    constructor(ctx: PassContext) {
        this.ctx = { root: ctx.root, config: ctx.config, vars: ctx.vars, shared: ctx.shared, report: d => { if (!this.muted) ctx.report(d) } }
        this.index = ctx.shared.index as ModelIndex | undefined
        ctx.shared.instances = this.records
    }

    run() {
        const root = this.ctx.root
        this.stack.push(root.name)
        try {
            this.expandRoot(root)
        } catch (e) {
            if (!(e instanceof Recursion)) throw e
        }
    }

    private expandRoot(root: CState, chart?: State) {
        // Inheritance first (KIELER's expandRoot: inheritBaseStates), for the chart itself.
        const source = chart ?? (root.origin ? this.index?.states.get(root.origin) : undefined)
        if (root.ext.baseStates && source) inherit(this.ctx, root, source, name => this.findChart(name))
        const unsupported = [
            ...allStates(root).filter(s => s.ext.baseStates !== undefined).map(s => construct('inheritance (extends) of inner states', undefined, s.origin)),
            ...allRegions(root).filter(r => r.ext.reference !== undefined).map(r => construct('region references (is ...) outside an override region', undefined, r.origin)),
        ]
        if (unsupported.length) {
            this.ctx.report({
                severity: 'info', code: 'unsupported', related: unsupported.flatMap(u => u.related ?? []),
                message: `The guide's simulator cannot run ${unsupported[0].what} yet`,
                hint: 'This needs more of KIELER\'s Inheritance transformation than the simulator implements. The official KIELER tools can run this chart.',
            })
            return
        }
        for (const s of allContainedStates(root).filter(isReferencing)) this.expandState(s)
        processDataflow(root, this)
        this.expandDeclarations(root)
        for (const s of allContainedStates(root).filter(isReferencing)) this.expandState(s)
        if (!chart) this.checkRemovedInstances(root)
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
    private reserved(s: CState): Set<string> {
        const out = new Set<string>()
        for (let x: Scope | undefined = s.parent; x; x = isRegion(x) ? x.parent : x.parent) for (const v of x.decls) out.add(v.name)
        return out
    }

    // ----- one instance -----

    /**
     * A fresh copy of the chart with its bindings worked out: the formals (its inputs and outputs) receive the
     * arguments by KIELER's binding pointer and, if unbound, the variable of the same name visible from `scope`
     * (KIELER's createBindings; the front end reports binding errors).
     */
    private instantiate(chart: State, prefix: string, call: ReferenceCall, scope: Scope, owner: string, outputInits: boolean, dataflow = false): Instance {
        if (this.stack.includes(chart.name)) {
            this.recursive(chart.name, owner, call.span)
            throw new Recursion()
        }
        const lowered = lowerInstance(chart, this.index, prefix, this.local(chart) ? undefined : call.span)
        for (const d of lowered.reports) this.ctx.report(d)
        const inst = lowered.root
        const own = [...inst.decls]
        // The chart's own inputs and outputs, then the inherited ones (KIELER's binding targets).
        const ownIO = inst.decls.filter(v => (v.input || v.output) && !v.declKind)
        if (inst.ext.baseStates) inherit(this.ctx, inst, chart, name => this.findChart(name))
        const formals = [...ownIO, ...inst.decls.filter(v => (v.input || v.output) && !v.declKind && !ownIO.includes(v))]
        const bound = new Map<CVar, CExpr>()
        let ptr = 0
        let crashed = false
        for (const a of call.args) {
            if (a.binding !== undefined) {
                const i = formals.findIndex(f => f.name === a.binding)
                if (i < 0) continue
                ptr = i
            }
            if (ptr >= formals.length) {
                // More arguments than inputs and outputs: for an instance of an OO dataflow region KIELER asks the
                // binding without a target whether its target is an input (handleSCChartsDatatype) and throws.
                if (dataflow && !crashed) {
                    crashed = true
                    this.ctx.report({
                        severity: 'error', code: 'kieler-crash', span: a.span ?? call.span, related: [owner],
                        message: `\`${chart.name}\` has ${formals.length} input${formals.length === 1 ? '' : 's'} and output${formals.length === 1 ? '' : 's'}, but ${call.args.length} are bound here: KIELER's compiler crashes on the extra one`,
                        kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.ValuedObject.eContainer()" because "valuedObject" is null',
                        hint: `Remove the extra argument. In a dataflow region that calls a method, an instance's inputs and outputs are wired by equations (\`g.input = ...\`); only explicit bindings (\`x to input\`) are applied.`,
                    })
                }
                continue
            }
            // An instance of an OO dataflow region takes explicit bindings only (handleSCChartsDatatype: "For
            // dataflow only explicit bindings otherwise all"); what is bound by position or by name stays a member.
            if (!dataflow || a.binding !== undefined) bound.set(formals[ptr], a.expr)
            ptr++
        }
        for (const f of formals) {
            if (bound.has(f) || dataflow) continue
            const v = this.lookup(scope, f.name)
            if (v) bound.set(f, { k: 'ref', v, idx: [] })
        }
        const ports = new Set<CVar>()
        if (dataflow) {
            // The unbound inputs and outputs become public variables of the instance, initial values included.
            for (const f of formals) {
                if (bound.has(f)) continue
                // (KIELER's simulation interface still lists an inherited one as an input or output.)
                if (!ownIO.includes(f)) f.tags.add(f.input ? '#port-input' : '#port-output')
                f.input = false
                f.output = false
                ports.add(f)
            }
        }
        const map = new Map<CVar, CRef>()
        for (const [f, actual] of bound) {
            if (actual.k === 'ref' && !actual.sub) map.set(f, actual)
            else if (actual.k === 'lit' || actual.k === 'vector' || actual.k === 'null') {
                // replaceReferenceWithLiteral: the formal becomes a local with the literal as its initial value.
                f.input = false
                f.output = false
                f.init = copyExpr(actual)
            } else {
                this.badBindings.set(f, { actual, state: owner })
            }
        }
        // Output initial values become entry actions of the referencing state, after the chart's own (S-10).
        for (const f of formals) {
            const actual = map.get(f)?.v
            // Only when the two initial values differ: with equal ones "not its own" would only be noise.
            if (f.output && f.init && outputInits && actual?.init && !sameExpr(f.init, actual.init)) {
                this.ctx.report({
                    severity: 'info', code: 'kieler-quirk', span: call.span, related: [owner],
                    message: `\`${actual.display ?? actual.name}\` gets the initial value of \`${chart.name}\`'s output \`${f.name}\` whenever \`${owner.split(/[.:/]/).pop()}\` is entered, not its own`,
                    hint: `KIELER turns the referenced chart's output initial values into entry actions of the referencing state, so they win over the initial value declared here and are applied again on every entry.`,
                })
            }
            if (f.output && f.init && outputInits) {
                const entry = createEntryAction(inst)
                entry.about = owner
                entry.effects.push({ k: 'assign', ref: ref(f), op: '=', expr: f.init, o: { by: f.decl, init: f.decl, span: f.span } })
            }
            // The declarations go, with their initial values (input initial values are dropped).
            if (f.input || f.output) f.init = undefined
        }
        return { inst, formals, map, bound, own, ports }
    }

    /**
     * Substitutes the bound formals everywhere in the copy and removes the interface declarations (S-9).
     *
     * `outer`, for a `ref` declaration inside another instance: what the instances around it have bound, by name.
     * KIELER keeps its replacements by name and does not shadow them with the copied chart's own top-level
     * declarations (handleSCChartsDatatype calls replaceValuedObjectReferencesInState on the copy directly), so a
     * local, or an input or output an OO dataflow instance keeps, that has the name of something bound further out
     * becomes that outer variable (S-18a); such a port is no member of the instance any more.
     */
    private bind({ inst, formals, map, bound, own, ports }: Instance, outer?: Map<string, CExpr>) {
        const leaked = new Map<CVar, CExpr>()
        for (const l of outer?.size ? own : []) {
            const actual = bound.has(l) || l.method ? undefined : outer!.get(l.name)
            if (actual) leaked.set(l, actual)
        }
        const replace = (r: CRef): CRef | undefined => {
            const actual = map.get(r.v) ?? (leaked.get(r.v)?.k === 'ref' ? leaked.get(r.v) as CRef : undefined)
            if (actual && !actual.sub) {
                // KIELER's replaceReferences: the actual's variable, and its indices if the use has none.
                return { ...r, v: actual.v, idx: r.idx.length ? r.idx : actual.idx.map(i => copyExpr(i)) }
            }
            const bad = this.badBindings.get(r.v)
            if (bad && !this.reportedBad.has(r.v)) {
                this.reportedBad.add(r.v)
                const kind = CLASS_NAMES[bad.actual.k] ?? 'de.cau.cs.kieler.kexpressions.impl.ExpressionImpl'
                this.ctx.report({
                    severity: 'error', code: 'binding-expression', span: bad.actual.span, related: [bad.state],
                    message: `\`${r.v.name}\` of the referenced chart is bound to an expression: only variables, array cells and values can be passed`,
                    kieler: `A binding for the valued object reference "${r.v.name}" exists, but the type "${kind}" is not supported.`,
                    hint: `Compute the value into a variable of this chart first (for example \`t = ...\`) and pass that variable as \`${r.v.name}\`.`,
                })
            }
            return undefined
        }
        rewriteScope(inst, { read: replace, target: replace })
        inst.decls = inst.decls.filter(v => (!formals.includes(v) || !(v.input || v.output)) && !(ports.has(v) && leaked.has(v)))
    }

    /** Expands `state S is C(args)` (KIELER's expandReferencedScope for states). */
    expandState(s: CState) {
        const call = referenceCall(s)
        if (!call || call.super) return
        if (s.ext.calls) {
            // `calls` is not expanded (isModuleExpansionReference): KIELER's C code calls a function it never defines (S-19).
            delete s.ext.reference
            this.ctx.report({
                severity: 'error', code: 'module-call', span: call.span, related: s.origin ? [s.origin] : undefined,
                message: `\`calls ${call.target}\` does not work in KIELER's C simulation`,
                kieler: `implicit declaration of function \u2018_r${call.target}\u2019 [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)`,
                hint: `Write \`state ${s.name} is ${call.target}(...)\` instead: is copies the chart into the state, calls generates a C function call that KIELER's netlist code never defines.`,
            })
            return
        }
        const chart = this.findChart(call.target)
        if (!chart) return
        const id = s.origin ?? s.about ?? s.name
        const prefix = id + REFERENCE_SEPARATOR
        const instance = this.instantiate(chart, prefix, call, s, id, true)
        const { inst, formals } = instance
        this.records.push({ state: id, prefix, chart })
        // Name clashes with the referencing state's surroundings (resolveNameClashes, S-11).
        const reserved = this.reserved(s)
        for (const v of declaredVars(inst)) {
            if (formals.includes(v) && (v.input || v.output)) continue
            if (!reserved.has(v.name)) continue
            const base = `_${v.name}_`
            let name = base
            for (let i = 2; reserved.has(name); i++) name = base + i
            v.name = name
        }
        this.bind(instance)
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
        // Inside the copy: its references, its dataflow regions, and the references these create.
        this.stack.push(chart.name)
        try {
            for (const x of allContainedStates(inst).filter(isReferencing)) this.expandState(x)
            processDataflow(inst, this)
            for (const x of allContainedStates(inst).filter(isReferencing)) this.expandState(x)
        } finally {
            this.stack.pop()
        }
    }

    /**
     * `ref C g(args)` declarations the classic dataflow translation has not taken (KIELER's handleSCChartsDatatype,
     * S-18): outside dataflow, and the instances of dataflow regions that call methods (S-33a). An array of
     * instances (`ref C gs[2]`) keeps one array per member; the chart's regions and actions are there once per
     * element, working on that element's members, and its methods take the element's indices as hidden parameters.
     */
    private expandDeclarations(root: CState) {
        for (const scope of allScopes(root)) {
            for (const v of [...scope.decls]) {
                if (v.declKind !== 'reference' || !v.instance || v.input) continue
                const chart = this.findChart(v.instance.target)
                if (!chart) continue
                const id = v.decl ?? v.name
                const sizes = v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : undefined))
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
                const target = isRegion(scope) ? scope.parent : scope
                /** The first element's declarations: the members of every element. */
                let members: CVar[] = []
                elements.forEach((at, x) => {
                    const prefix = sizes.length ? `${id}[${at.join('][')}]${REFERENCE_SEPARATOR}` : id + REFERENCE_SEPARATOR
                    // What lowering and expanding the chart reports is the same for every element: once.
                    if (x > 0) this.muted++
                    let instance: Instance
                    const outer = this.replacements
                    try {
                        instance = this.instantiate(chart, prefix, { target: v.instance!.target, args: v.instance!.args, span: v.span }, scope, id, false, v.tags.has(DF_BINDING))
                        this.replacements = new Map(outer)
                        for (const [f, actual] of instance.bound) this.replacements.set(f.name, actual)
                        this.stack.push(chart.name)
                        try {
                            this.expandRoot(instance.inst, chart)
                        } finally {
                            this.stack.pop()
                            this.replacements = outer
                        }
                        this.bind(instance, outer)
                    } finally {
                        if (x > 0) this.muted--
                    }
                    const { inst } = instance
                    if (x === 0) {
                        members = [...inst.decls]
                        if (!this.muted) {
                            const cls = this.classOf(v, scope, chart)
                            v.className = cls.name
                            for (const l of members) if (l.method) l.method = { ...l.method, cls: cls.key }
                        }
                        this.checkSignals(v, inst, chart)
                        this.redirectMembers(v, prefix, inst, root, sizes.length)
                        // A chart class instance without fields is still an (empty) object in KIELER's data pool
                        // (structure.md S-60, conformance structure/131).
                        if (target === this.ctx.root && !v.instance!.args.length && !inst.decls.some(l => !l.declKind)) {
                            ((this.ctx.root.ext.emptyInstances ??= []) as string[]).push(v.name)
                        }
                    }
                    if (sizes.length) elementOf(inst, members, at, x === 0)
                    if (x === 0) {
                        if (sizes.length) arrayMembers(members, v.dims, sizes as number[])
                        // The instance's locals become hidden members of the declaring state (in KIELER's data pool:
                        // members of an object named after the declaration, `"g": {"k": 0}`).
                        for (const local of [...inst.decls]) {
                            // A member of an instance inside the chart keeps its instance; the instance is the member.
                            if (!local.member && (!local.declKind || local.declKind === 'class' || local.declKind === 'struct')) local.member = { of: v, name: local.name }
                            // A chart instance inside the chart is no declaration any more: it is the member (an
                            // object inside this instance's object in the pool).
                            let top = local.member?.of
                            while (top?.member) top = top.member.of
                            if (top && top !== v && top.declKind === 'reference') top.member = { of: v, name: top.name }
                            // In messages: the member as the declaring chart writes it (`g.a`).
                            if (!local.generated && !local.display) local.display = `${v.name}.${local.name}`
                            local.name = `_${v.name}_${local.name}`
                            local.generated = true
                            addVar(target, local)
                        }
                    }
                    for (const r of [...inst.regions]) {
                        r.name = `${v.name}${elements.length > 1 ? x : ''}_${r.name ?? 'default'}`
                        r.parent = target
                        target.regions.push(r)
                    }
                    target.actions.push(...inst.actions)
                    this.records.push({ state: target.origin ?? '', prefix, chart, declaration: true })
                })
                scope.decls.splice(scope.decls.indexOf(v), 1)
            }
        }
    }

    /**
     * The class KIELER makes of the instance's declaration (createPolicyClassDeclaration, uniqueName): `<Chart>1`,
     * the next declaration of that chart `<Chart>2`. Instances declared together share it, unless one of them has
     * bindings (separateReferenceDeclarationsWithIndividualBindingsInVOs gives every further one its own).
     */
    private classOf(v: CVar, scope: Scope, chart: State): { name: string; key: string } {
        const d = v.decl ? this.index?.vos.get(v.decl.split(REFERENCE_SEPARATOR).pop()!)?.decl : undefined
        const first = d?.valuedObjects[0]?.name === v.name
        const shared = d && (first || !d.valuedObjects.some(vo => vo.parameters?.length)) ? d : undefined
        const known = shared ? this.classes.get(scope)?.get(shared) : undefined
        if (known) return known
        const n = (this.classNumbers.get(chart.name) ?? 0) + 1
        this.classNumbers.set(chart.name, n)
        const made = { name: `${chart.name}${n}`, key: `${chart.name}${n}#${++this.classKeys}` }
        if (shared) {
            if (!this.classes.has(scope)) this.classes.set(scope, new Map())
            this.classes.get(scope)!.set(shared, made)
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
        const port = v.tags.has(DF_BINDING) && signal.decl !== undefined && !!this.index?.vos.get(signal.decl.split(REFERENCE_SEPARATOR).pop()!)?.decl?.input
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
     * A chart used as a class (structure.md S-65): `c.step` and `c.increment()` in the chart that declares `ref C c`
     * mean the instance's own field and method (KIELER's handleSCChartsDatatype).
     */
    private redirectMembers(v: CVar, prefix: string, inst: CState, root: CState, dimensions = 0) {
        // By the declaration's own id (an inherited one is `<instance>/<chart>/<id>`: the last part).
        const byDecl = new Map<string, CVar>()
        for (const local of inst.decls) if (local.decl?.startsWith(prefix)) byDecl.set(local.decl.split(REFERENCE_SEPARATOR).pop()!, local)
        const member = (r: CRef): CRef | undefined => {
            if (r.v !== v || !r.sub) return undefined
            // (Inside a referenced chart's copy the member's id carries that copy's prefix.)
            const m = r.sub.v.decl ? byDecl.get(r.sub.v.decl.split(REFERENCE_SEPARATOR).pop()!) : undefined
            return m ? { ...r.sub, v: m, idx: [...r.idx, ...r.sub.idx] } : undefined
        }
        // What is left without its member afterwards: a port that became a variable further out (bind's `outer`).
        const lost: CRef[] = []
        const resolve = (r: CRef): CRef | undefined => {
            const m = member(r)
            if (!m && r.v === v && r.sub && !r.sub.sub && r.sub.v.declKind === 'unresolved') lost.push(r)
            return m
        }
        // (Inside the chart being expanded: `root` is the copy that declares the instance, not yet part of the chart.)
        rewriteScope(root, {
            read: resolve,
            target: resolve,
            node: e => {
                if (e.k !== 'call' || !e.target) return undefined
                const t = member(e.target)
                if (!t) return undefined
                // A method of an element of an array of instances takes the element's indices as its first arguments.
                if (dimensions && t.v.method) return { ...e, target: { ...t, idx: t.idx.slice(dimensions) }, name: t.v.name, args: [...t.idx.slice(0, dimensions), ...e.args] }
                return { ...e, target: t, name: t.v.name }
            },
        })
        if (lost.length && v.tags.has(DF_BINDING)) {
            const names = [...new Set(lost.map(r => r.sub!.v.name))]
            this.ctx.report({
                severity: 'error', code: 'dataflow-instance-port', span: lost[0].span ?? v.span, related: v.decl ? [v.decl] : undefined,
                message: `\`${v.name}.${names[0]}\` does not exist in KIELER's compiled chart: the chart around \`${v.name}\` is itself an instance, and a variable called \`${names[0]}\` is bound for it`,
                kieler: [...names.map(n => `The valued object reference points to a valued object (${n}) that is not contained in the model!`), 'References objects are not contained in the resource!'].join('\n'),
                hint: `KIELER keeps what is bound for an instance by name, so inside it every chart's \`${names[0]}\` means the variable bound further out, and \`${v.name}\` loses its own. Rename \`${names[0]}\` in one of the two charts.`,
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

/** The index tuples of an array's elements in KIELER's order (the last dimension runs fastest); `[[]]` for no array. */
function elementIndices(sizes: number[]): number[][] {
    let out: number[][] = [[]]
    for (const n of sizes) out = out.flatMap(at => Array.from({ length: n }, (_, i) => [...at, i]))
    return out
}

/**
 * Makes a freshly expanded copy of a chart the element `at` of an array of instances whose members are those of the
 * first element's copy (`first`, in the order of the copy's own): every reference to one of the chart's own declarations in the copy's regions and
 * actions becomes the member's element (`gs[at].member`), a call of one of its methods passes the indices. For the
 * first element itself, the members get the array's dimensions in front of their own and the methods the hidden
 * index parameters (as lower.ts gives the members and methods of an array of class instances).
 */
function elementOf(inst: CState, first: CVar[], at: number[], isFirst: boolean) {
    const literals = (): CExpr[] => at.map(i => ({ k: 'lit', t: 'int', v: i }))
    const members = new Map<CVar, CVar>(inst.decls.map((l, i) => [l, first[i] ?? l]))
    const element = (prefix: () => CExpr[]) => {
        const member = (r: CRef): CRef | undefined => {
            const m = members.get(r.v)
            return m && !m.method ? { ...r, v: m, idx: [...prefix(), ...r.idx] } : undefined
        }
        return {
            read: member, target: member,
            node: (e: CExpr): CExpr | undefined => {
                const m = e.k === 'call' && e.target ? members.get(e.target.v) : undefined
                return e.k === 'call' && m?.method ? { ...e, target: { ...e.target!, v: m }, args: [...prefix(), ...e.args] } : undefined
            },
        }
    }
    if (isFirst) {
        for (const l of inst.decls) {
            if (l.method) {
                const hidden = at.map((_, k) => {
                    const p = new CVar(`_self${k}`, 'int')
                    p.generated = true
                    p.role = 'frame'
                    p.tags.add('#self')
                    return p
                })
                const w = element(() => hidden.map(p => ref(p)))
                l.method = { ...l.method, params: [...hidden, ...l.method.params], body: rewriteStatements(l.method.body, w) }
            }
        }
    }
    // The regions and actions only: the declarations are the first element's (rewritten above, once).
    const decls = inst.decls
    inst.decls = []
    rewriteScope(inst, element(literals))
    inst.decls = decls
}

/** After every element is there: the members of an array of instances get its dimensions and one value per element. */
function arrayMembers(first: CVar[], dims: CExpr[], count: number[]) {
    const repeat = (value: CExpr, depth = 0): CExpr =>
        depth === count.length ? copyExpr(value) : { k: 'vector', values: Array.from({ length: count[depth] }, () => repeat(value, depth + 1)), span: value.span }
    const nested = new Set<CVar>()
    for (const l of first) {
        // A chart instance inside the chart (no declaration any more): its members name it.
        for (let of = l.member?.of; of; of = of.member?.of) if (!first.includes(of)) nested.add(of)
        if (l.method) continue
        l.dims = [...dims.map(d => copyExpr(d)), ...l.dims]
        if (l.init) l.init = repeat(l.init)
    }
    for (const of of nested) of.dims = [...dims.map(d => copyExpr(d)), ...of.dims]
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

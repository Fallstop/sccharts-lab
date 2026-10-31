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
    addVar, allContainedStates, allRegions, allScopes, allStates, copyExpr, createEntryAction, isRegion, ref, sameExpr, setSource,
    setTarget, type CArg, type CExpr, type CRef, type CState, type CVar, type Scope,
} from '../model'
import { lowerInstance, REFERENCE_SEPARATOR } from '../structure/instance'
import { declaredVars, rewriteScope } from '../structure/rewrite'
import { processDataflow } from './dataflow'
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

    constructor(readonly ctx: PassContext) {
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
    private instantiate(chart: State, prefix: string, call: ReferenceCall, scope: Scope, owner: string, outputInits: boolean): Instance {
        if (this.stack.includes(chart.name)) {
            this.recursive(chart.name, owner, call.span)
            throw new Recursion()
        }
        const lowered = lowerInstance(chart, this.index, prefix, this.local(chart) ? undefined : call.span)
        for (const d of lowered.reports) this.ctx.report(d)
        const inst = lowered.root
        // The chart's own inputs and outputs, then the inherited ones (KIELER's binding targets).
        const ownIO = inst.decls.filter(v => (v.input || v.output) && !v.declKind)
        if (inst.ext.baseStates) inherit(this.ctx, inst, chart, name => this.findChart(name))
        const formals = [...ownIO, ...inst.decls.filter(v => (v.input || v.output) && !v.declKind && !ownIO.includes(v))]
        const bound = new Map<CVar, CExpr>()
        let ptr = 0
        for (const a of call.args) {
            if (a.binding !== undefined) {
                const i = formals.findIndex(f => f.name === a.binding)
                if (i < 0) continue
                ptr = i
            }
            if (ptr >= formals.length) continue
            bound.set(formals[ptr], a.expr)
            ptr++
        }
        for (const f of formals) {
            if (bound.has(f)) continue
            const v = this.lookup(scope, f.name)
            if (v) bound.set(f, { k: 'ref', v, idx: [] })
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
        return { inst, formals, map }
    }

    /** Substitutes the bound formals everywhere in the copy and removes the interface declarations (S-9). */
    private bind({ inst, formals, map }: Instance) {
        const replace = (r: CRef): CRef | undefined => {
            const actual = map.get(r.v)
            if (actual) {
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
        inst.decls = inst.decls.filter(v => !formals.includes(v) || !(v.input || v.output))
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

    /** `ref C g(args)` declarations not used by dataflow (KIELER's handleSCChartsDatatype, S-18). */
    private expandDeclarations(root: CState) {
        for (const scope of allScopes(root)) {
            for (const v of [...scope.decls]) {
                if (v.declKind !== 'reference' || !v.instance || v.input) continue
                const chart = this.findChart(v.instance.target)
                if (!chart) continue
                const id = v.decl ?? v.name
                const prefix = id + REFERENCE_SEPARATOR
                const instance = this.instantiate(chart, prefix, { target: v.instance.target, args: v.instance.args, span: v.span }, scope, id, false)
                const { inst } = instance
                this.stack.push(chart.name)
                try {
                    this.expandRoot(inst, chart)
                } finally {
                    this.stack.pop()
                }
                this.bind(instance)
                this.redirectMembers(v, prefix, inst)
                const target = isRegion(scope) ? scope.parent : scope
                // The instance's locals become hidden members of the declaring state (in KIELER's data pool: members
                // of an object named after the declaration, `"g": {"k": 0}`).
                // A chart class instance without fields is still an (empty) object in KIELER's data pool (structure.md
                // S-60, conformance structure/131).
                if (target === this.ctx.root && !v.instance.args.length && !inst.decls.some(l => !l.declKind)) {
                    ((this.ctx.root.ext.emptyInstances ??= []) as string[]).push(v.name)
                }
                for (const local of [...inst.decls]) {
                    if (!local.declKind) local.member = { of: v, name: local.name }
                    local.name = `_${v.name}_${local.name}`
                    local.generated = true
                    addVar(target, local)
                }
                for (const r of [...inst.regions]) {
                    r.name = `${v.name}_${r.name ?? 'default'}`
                    r.parent = target
                    target.regions.push(r)
                }
                target.actions.push(...inst.actions)
                scope.decls.splice(scope.decls.indexOf(v), 1)
                this.records.push({ state: target.origin ?? '', prefix, chart, declaration: true })
            }
        }
    }

    /**
     * A chart used as a class (structure.md S-65): `c.step` and `c.increment()` in the chart that declares `ref C c`
     * mean the instance's own field and method (KIELER's handleSCChartsDatatype).
     */
    private redirectMembers(v: CVar, prefix: string, inst: CState) {
        // By the declaration's own id (an inherited one is `<instance>/<chart>/<id>`: the last part).
        const byDecl = new Map<string, CVar>()
        for (const local of inst.decls) if (local.decl?.startsWith(prefix)) byDecl.set(local.decl.split(REFERENCE_SEPARATOR).pop()!, local)
        if (!byDecl.size) return
        const member = (r: CRef): CRef | undefined => {
            if (r.v !== v || !r.sub) return undefined
            const m = r.sub.v.decl ? byDecl.get(r.sub.v.decl) : undefined
            return m ? { ...r.sub, v: m, idx: [...r.idx, ...r.sub.idx] } : undefined
        }
        rewriteScope(this.ctx.root, {
            read: r => member(r),
            target: r => member(r),
            node: e => {
                if (e.k !== 'call' || !e.target) return undefined
                const t = member(e.target)
                return t ? { ...e, target: t, name: t.v.name } : undefined
            },
        })
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

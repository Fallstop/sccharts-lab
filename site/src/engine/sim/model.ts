// The simulator's working model: a mutable copy of the chart in KIELER's SCCharts metamodel terms (states,
// regions, transitions, local actions, valued objects), which the desugaring passes rewrite into core SCCharts
// exactly as KIELER's processors do, and which scg.ts then turns into a sequentially constructive graph.
//
// Everything carries provenance back to the source: `origin` is the id (types.ts) of the source element a
// model element is, `about` the source element a generated element implements, and effects carry the
// source element that ran them. The helpers below mirror KIELER's extension methods
// (SCChartsStateExtensions, SCChartsTransitionExtensions, SCChartsActionExtensions, ...) with the same
// semantics, including their quirks, because the passes are ported from KIELER line by line.

import type {
    AssignOperator, CombineOperator, DelayType, LocalActionKind, OperatorType, PreemptionType, Span, ValueType,
} from '../types'

// ---------------------------------------------------------------------------------------------------
// Valued objects
// ---------------------------------------------------------------------------------------------------

export type Scope = CState | CRegion

let uidCounter = 0
const nextUid = () => ++uidCounter

export class CVar {
    readonly uid = nextUid()
    name: string
    type: ValueType
    hostType?: string
    signal = false
    input = false
    output = false
    const = false
    static = false
    extern = false
    global = false
    /** Array cardinalities (int literals after const inlining). */
    dims: CExpr[] = []
    init?: CExpr
    combine?: CombineOperator
    /** Declaration scope. */
    scope?: Scope
    /** Source ValuedObject id (types.ts `<scopeId>$<name>`) of the declaration this variable is or implements. */
    decl?: string
    /** Name the reader knows the variable by (the signal's name for `V_val`, the variable's for `_pre_x`). */
    display?: string
    /** What a generated variable is for: 'value' | 'curval' | 'pre' | 'reg' | 'term' | 'trig' | 'exit' | ... */
    role?: string
    /** The source variable a generated one belongs to (the signal of `V_val`, the operand of `_pre_x`). */
    of?: CVar
    /** Created by a pass (KIELER prefixes such names with `_`; they are not in KIELER's data pool). */
    generated = false
    /** Declaration span (for diagnostics). */
    span?: Span
    /** Annotations by name (KIELER's tag annotations on valued objects, e.g. `_termination_delayed`). */
    tags = new Set<string>()
    /** The source declaration kind when it is not a plain variable (method, class, ...): handled by other passes. */
    declKind?: string
    /** A method (declKind 'method', or a code effect's generated `_effect<n>`): its parameters and SCL body. */
    method?: CMethod
    /** A member of a class or struct instance (lower.ts declareMembers): the instance and the member's name. */
    member?: { of: CVar; name: string }
    /** `ref Chart x(args)` (declKind 'reference'): the chart it instantiates (structure.md S-18, S-33). */
    instance?: { target: string; args: CArg[] }
    /** A declaration of a state inside a for-region copy (passes/forRegion.ts): the source region and the counter's
     *  value in that copy. */
    forCopy?: { region: string; counter: string; value: number }

    constructor(name: string, type: ValueType) {
        this.name = name
        this.type = type
    }

    /** A pure signal before the Signal pass (no value). */
    get pureSignal(): boolean {
        return this.signal && (this.type === 'pure' || this.type === undefined)
    }
}

// ---------------------------------------------------------------------------------------------------
// Expressions and effects
// ---------------------------------------------------------------------------------------------------

export interface CRef {
    k: 'ref'
    v: CVar
    idx: CExpr[]
    /** `a.b`: member access. */
    sub?: CRef
    span?: Span
}

export type CExpr =
    | { k: 'lit'; t: 'bool' | 'int' | 'float' | 'string'; v: boolean | number | string; span?: Span }
    | { k: 'null'; span?: Span }
    | CRef
    | { k: 'op'; op: OperatorType; args: CExpr[]; span?: Span }
    | { k: 'vector'; values: CExpr[]; range?: boolean; span?: Span }
    | { k: 'call'; name: string; args: CExpr[]; extern?: boolean; target?: CRef; paramAccess?: ('&' | '!&' | null)[]; span?: Span }
    | { k: 'random'; span?: Span }
    | { k: 'host'; text: string; span?: Span }
    | { k: 'ignore'; span?: Span }
    /** A construct the simulator does not model (yet); evaluating it is a runtime error. */
    | { k: 'unsupported'; what: string; span?: Span }

/** Where an effect comes from, for the log and for diagnostics. */
export interface EffectOrigin {
    /** Source element (transition, action, declaration) whose effect this is. */
    by?: string
    /** Source span of the effect as written. */
    span?: Span
    /** Initialisation of a declaration (Initialization pass): the declaration's valued object id. */
    init?: string
    /** Generated by a pass and not visible to the reader as such (signal resets, `_term` flags, ...). */
    hidden?: boolean
    /** This write implements an emission of the signal (its presence, or its value for a valued signal). */
    emits?: CVar
    /**
     * KIELER's user schedules (`schedule` priorities, passes/userSchedule.ts): accesses of one schedule object are
     * ordered by priority instead of initialise-update-read (dataflow sequences, structure.md S-27).
     */
    schedule?: { group: object; priority: number }[]
}

/** Bookkeeping effects with no data access: they record what happened in source terms. */
export type Mark =
    /**
     * A source transition fired (KIELER's Taken Transition Signaling `_taken_transitions[index] += 1`).
     * Preemption passes refine how the tracker enters its target: `history` is the history KIELER actually applies
     * (passes/history.ts: `reset` where it ignores the keyword, P-51), `deferEntry` that the target is entered one
     * tick late (passes/deferred.ts, P-54 a: its regions are entered by an `enterRegions` mark).
     * Structure passes: a transition inside a referenced chart's copy has `index` -1 (KIELER does not count it,
     * structure.md S-15; it is no effect in KIELER's model) and an id `<reference state>/<id in that chart>`; a
     * for-region copy keeps the original's id and index (S-23) and gets a `key` that tells the copies apart for
     * the tracker (structure/track.ts).
     */
    | { kind: 'take'; transition: string; index: number; history?: 'reset' | 'shallow' | 'deep'; deferEntry?: boolean; key?: string }
    /** The effects of a source local action ran. */
    | { kind: 'action'; action: string }
    /** The root entry action KIELER's Taken Transition Signaling adds (resets the counters). */
    | { kind: 'ttsReset' }
    /** Tracker hook, no KIELER effect: the source state's regions are entered now (a deferred entry's second tick). */
    | { kind: 'enterRegions'; state: string }
    /** Tracker hook, no KIELER effect: control is back in the source state (weak suspend's quiet re-entry, P-46). */
    | { kind: 'resume'; state: string; suspended: string }

export type CEffect =
    | { k: 'assign'; ref: CRef; op: AssignOperator | '++' | '--'; expr?: CExpr; o: EffectOrigin }
    | { k: 'emit'; ref: CRef; value?: CExpr; o: EffectOrigin }
    | { k: 'print'; args: CExpr[]; o: EffectOrigin }
    | { k: 'call'; call: Extract<CExpr, { k: 'call' }>; o: EffectOrigin }
    | { k: 'host'; text: string; o: EffectOrigin }
    | { k: 'randomize'; o: EffectOrigin }
    | { k: 'mark'; m: Mark; o: EffectOrigin }
    | { k: 'unsupported'; what: string; o: EffectOrigin }

/** A statement of an SCL body (methods, and code effects `do { ... }`, which KIELER turns into methods). */
export type CStmt =
    /** An effect statement: assignment, `x++`, call, print, ... */
    | { k: 'do'; f: CEffect }
    | { k: 'if'; cond: CExpr; then: CStmt[]; else?: CStmt[]; span?: Span }
    | { k: 'while'; cond: CExpr; body: CStmt[]; span?: Span }
    | { k: 'for'; init: CStmt[]; cond?: CExpr; update: CStmt[]; body: CStmt[]; span?: Span }
    | { k: 'return'; expr?: CExpr; span?: Span }
    /** SCL `name:` and `goto name` (a jump to a label of this block or an enclosing one). */
    | { k: 'label'; name: string; span?: Span }
    | { k: 'goto'; target: string; span?: Span }
    /** An expression evaluated for its effect (a call). */
    | { k: 'expr'; e: CExpr; span?: Span }
    | { k: 'unsupported'; what: string; span?: Span }

/** An argument of a reference (`state S is C(args)`, `ref C x(args)`): `expr` or `expr to binding`. */
export interface CArg {
    expr: CExpr
    binding?: string
    span?: Span
}

/** A method's signature and body. Parameters and locals are variables of no scope (method frames). */
export interface CMethod {
    params: CVar[]
    /** Every local declared in the body (initialisations are `do` statements where they are declared). */
    locals: CVar[]
    body: CStmt[]
    /** Return type as written ('void' when there is none). */
    returnType: ValueType | 'void'
    /** The source element the body comes from (method declaration or code effect's action/transition). */
    by?: string
    /** `@inline`: KIELER inlines every call of it, whatever its size (SCGAnnotations.ANNOTATION_METHOD_INLINING). */
    inline?: boolean
    span?: Span
}

// ---------------------------------------------------------------------------------------------------
// States, regions, transitions, actions
// ---------------------------------------------------------------------------------------------------

export type Delay = DelayType

export class CAction {
    readonly uid = nextUid()
    kind: LocalActionKind
    delay: Delay = 'undefined'
    /** Entry and exit actions: KIELER's PreemptionActionType; the metamodel default is strong. */
    preemption: 'weak' | 'strong' = 'strong'
    /** `weak suspend` */
    weak = false
    triggerDelay?: number
    trigger?: CExpr
    effects: CEffect[] = []
    /** Source action id when this is a source action (types.ts `<stateId>!<kind><n>`). */
    origin?: string
    /** Source element a generated action implements. */
    about?: string
    span?: Span
    /** Names of the source action's annotations (`@HardReset period 300`). */
    annotations: string[] = []

    constructor(kind: LocalActionKind) {
        this.kind = kind
    }
}

export class CTransition {
    readonly uid = nextUid()
    source!: CState
    target!: CState
    delay: Delay = 'undefined'
    preemption: PreemptionType = 'weak'
    trigger?: CExpr
    effects: CEffect[] = []
    triggerDelay?: number
    history?: 'reset' | 'shallow' | 'deep'
    deferred?: 'shallow' | 'deep'
    /** Source transition id when this is (a move or a SurfaceDepth copy of) a source transition. */
    origin?: string
    /** Source element a generated transition implements (the abort it realises, the action it runs, ...). */
    about?: string
    /** The source transition whose trigger this generated transition tests (an abort's copies), for the log. */
    checks?: string
    /** String annotations by name (KIELER's `_termination` annotation and similar markers). */
    annotations = new Map<string, string[]>()
    span?: Span
}

export class CRegion {
    readonly uid = nextUid()
    name?: string
    label?: string
    parent!: CState
    states: CState[] = []
    decls: CVar[] = []
    actions: CAction[] = []
    /** Source region id. */
    origin?: string
    /** Source element a generated region implements. */
    about?: string
    dataflow = false
    final = false
    abort = false
    override = false
    annotations = new Map<string, string[]>()
    /** Extension point for the structure passes (for-regions, dataflow equations, references). */
    ext: Record<string, unknown> = {}

    get isRegion(): true { return true }
}

export class CState {
    readonly uid = nextUid()
    name: string
    label?: string
    parent?: CRegion
    initial = false
    final = false
    connector = false
    violation = false
    /** The scchart itself. */
    root = false
    decls: CVar[] = []
    actions: CAction[] = []
    regions: CRegion[] = []
    /** Outgoing transitions in priority order. */
    out: CTransition[] = []
    /** Incoming transitions (kept in sync by the helpers below). */
    incoming: CTransition[] = []
    /** Source state id. */
    origin?: string
    /** Source element a generated state implements (the superstate whose abort it realises, ...). */
    about?: string
    annotations = new Map<string, string[]>()
    /** Extension point for the structure passes (references `is`, ...). */
    ext: Record<string, unknown> = {}

    constructor(name: string) {
        this.name = name
    }

    get isRegion(): false { return false }
}

export function isRegion(s: Scope): s is CRegion {
    return s.isRegion
}

// ---------------------------------------------------------------------------------------------------
// Constructors and structural edits (SCChartsStateExtensions, SCChartsTransitionExtensions, ...)
// ---------------------------------------------------------------------------------------------------

export function createState(region: CRegion, name: string): CState {
    const s = new CState(name)
    s.parent = region
    region.states.push(s)
    return s
}

export function createInitialState(region: CRegion, name: string): CState {
    const s = createState(region, name)
    s.initial = true
    return s
}

export function createFinalState(region: CRegion, name: string): CState {
    const s = createState(region, name)
    s.final = true
    return s
}

/** KIELER's createControlflowRegion(state, id): reuses a single empty implicit region instead of adding one. */
export function createControlflowRegion(state: CState, name: string): CRegion {
    if (state.regions.length === 1 && !state.regions[0].dataflow && allContainedStates(state.regions[0]).length === 0) {
        const implicit = state.regions[0]
        implicit.name = name
        return implicit
    }
    const r = new CRegion()
    r.name = name
    r.parent = state
    state.regions.push(r)
    return r
}

export function addRegion(state: CState, region: CRegion, index?: number) {
    if (region.parent && region.parent !== state) {
        const list = region.parent.regions
        const i = list.indexOf(region)
        if (i >= 0) list.splice(i, 1)
    }
    region.parent = state
    if (index === undefined) state.regions.push(region)
    else state.regions.splice(index, 0, region)
}

/** Moves a state into a region (EMF containment: it leaves its previous region). */
export function addState(region: CRegion, state: CState) {
    if (state.parent) {
        const list = state.parent.states
        const i = list.indexOf(state)
        if (i >= 0) list.splice(i, 1)
    }
    state.parent = region
    region.states.push(state)
}

/** Detaches a state from its region. Its transitions stay attached to it (as in EMF). */
export function removeState(state: CState) {
    if (!state.parent) return
    const list = state.parent.states
    const i = list.indexOf(state)
    if (i >= 0) list.splice(i, 1)
}

export function setTarget(t: CTransition, target: CState) {
    if (t.target) {
        const i = t.target.incoming.indexOf(t)
        if (i >= 0) t.target.incoming.splice(i, 1)
    }
    t.target = target
    target.incoming.push(t)
}

/** Moves a transition to a new source (appended: lowest priority), as KIELER's setSourceState. */
export function setSource(t: CTransition, source: CState, index?: number) {
    if (t.source) {
        const i = t.source.out.indexOf(t)
        if (i >= 0) t.source.out.splice(i, 1)
    }
    t.source = source
    if (index === undefined) source.out.push(t)
    else source.out.splice(index, 0, t)
}

/** Removes a transition from its source and target. */
export function removeTransition(t: CTransition) {
    const i = t.source.out.indexOf(t)
    if (i >= 0) t.source.out.splice(i, 1)
    const j = t.target?.incoming.indexOf(t) ?? -1
    if (j >= 0) t.target.incoming.splice(j, 1)
}

export function createTransitionTo(source: CState, target: CState, index?: number): CTransition {
    const t = new CTransition()
    setTarget(t, target)
    setSource(t, source, index)
    return t
}

export function createImmediateTransitionTo(source: CState, target: CState): CTransition {
    const t = createTransitionTo(source, target)
    t.delay = 'immediate'
    return t
}

export function setHighestPriority(t: CTransition) {
    setSource(t, t.source, 0)
}

export function setLowestPriority(t: CTransition) {
    setSource(t, t.source)
}

/** KIELER's setSpecificPriority (1-based). */
export function setSpecificPriority(t: CTransition, priority: number) {
    const list = t.source.out
    list.splice(list.indexOf(t), 1)
    const index = priority > list.length ? list.length : priority - 1
    list.splice(index, 0, t)
}

/** SCChartsTransitionExtensions.isImplicitlyImmediate. */
export function isImplicitlyImmediate(t: CTransition): boolean {
    return t.delay === 'immediate' || t.source.connector ||
        (t.preemption === 'termination' && t.trigger === undefined && t.delay !== 'delayed')
}

/** SCChartsActionExtensions.isImmediate: the delay is IMMEDIATE (entry and exit actions always are). */
export function isImmediate(a: CTransition | CAction): boolean {
    if (a instanceof CAction && (a.kind === 'entry' || a.kind === 'exit')) return true
    return a.delay === 'immediate'
}

/** setImmediate(boolean) on an action or transition: IMMEDIATE or UNDEFINED. */
export function setImmediate(a: CTransition | CAction, immediate = true) {
    a.delay = immediate ? 'immediate' : 'undefined'
}

export const isTermination = (t: CTransition) => t.preemption === 'termination'
export const isStrongAbort = (t: CTransition) => t.preemption === 'strong'
export const isWeakAbort = (t: CTransition) => t.preemption === 'weak'

export function createAction(scope: Scope, kind: LocalActionKind, index?: number): CAction {
    const a = new CAction(kind)
    if (index === undefined) scope.actions.push(a)
    else scope.actions.splice(index, 0, a)
    return a
}

export function createEntryAction(scope: Scope, index?: number): CAction {
    return createAction(scope, 'entry', index)
}

export function createImmediateDuringAction(scope: Scope): CAction {
    const a = createAction(scope, 'during')
    a.delay = 'immediate'
    return a
}

export function removeAction(scope: Scope, action: CAction) {
    const i = scope.actions.indexOf(action)
    if (i >= 0) scope.actions.splice(i, 1)
}

export function addVar(scope: Scope, v: CVar, index?: number) {
    if (v.scope) {
        const list = v.scope.decls
        const i = list.indexOf(v)
        if (i >= 0) list.splice(i, 1)
    }
    v.scope = scope
    if (index === undefined) scope.decls.push(v)
    else scope.decls.splice(index, 0, v)
}

/** A generated (hidden) variable, as KIELER's createValuedObject(...).uniqueName in a scope. */
export function createVar(scope: Scope, name: string, type: ValueType, role?: string): CVar {
    const v = new CVar(name, type)
    v.generated = name.startsWith('_')
    v.role = role
    addVar(scope, v)
    return v
}

// ----- queries -----

/**
 * A state's name as the reader knows it: the compiler's own states (`_AC`, `__df_main`, KIELER names them with `_`)
 * are named after the nearest enclosing state the chart has.
 */
export function readableName(s: CState | undefined): string | undefined {
    for (let x = s; x; x = x.parent?.parent) if (!x.name.startsWith('_')) return x.name
    return undefined
}

/** A name in code font (a diagnostic's message or hint is inline Markdown); undefined stays undefined. */
export function quoted(name: string | undefined): string | undefined {
    return name === undefined ? undefined : `\`${name}\``
}

/** A region's name, unless the compiler made it (then undefined: "a region of S"). */
export function readableRegionName(r: { name?: string } | undefined): string | undefined {
    return r?.name && !r.name.startsWith('_') ? r.name : undefined
}

export function isRootState(s: CState): boolean {
    return s.root
}

export function isHierarchical(s: CState): boolean {
    return s.regions.length > 0
}

export function controlflowRegions(s: CState): CRegion[] {
    return s.regions.filter(r => !r.dataflow)
}

/** SCChartsControlflowRegionExtensions.controlflowRegionsContainStates (a referencing region counts as well). */
export function controlflowRegionsContainStates(s: CState): boolean {
    return controlflowRegions(s).some(r => r.states.length > 0 || r.ext.reference !== undefined)
}

export function containsInnerActions(s: CState): boolean {
    return s.actions.some(a => a.kind === 'during' || a.kind === 'exit' || a.kind === 'entry')
}

export function actionsOf(scope: Scope, kind: LocalActionKind): CAction[] {
    return scope.actions.filter(a => a.kind === kind)
}

export function finalStates(r: CRegion): CState[] {
    return r.states.filter(s => s.final)
}

export function initialState(r: CRegion): CState | undefined {
    return r.states.find(s => s.initial)
}

/** regionsMayTerminate: every non-final control-flow region has a final state. */
export function regionsMayTerminate(s: CState): boolean {
    return controlflowRegions(s).filter(r => !r.final).every(r => finalStates(r).length > 0)
}

/** SCChartsTransformationExtension.isImmediatelyReachable (from an initial state by implicitly immediate transitions). */
export function isImmediatelyReachable(finalState: CState): boolean {
    if (finalState.initial) return true
    const visited = new Set<CState>([finalState])
    const next = finalState.incoming.filter(isImplicitlyImmediate)
    while (next.length) {
        const t = next.shift()!
        if (!visited.has(t.source)) {
            if (t.source.initial) return true
            visited.add(t.source)
            next.push(...t.source.incoming.filter(isImplicitlyImmediate))
        }
    }
    return false
}

export function canImmediateTerminateRegion(r: CRegion): boolean {
    return r.states.filter(s => s.final).some(isImmediatelyReachable)
}

export function canImmediateTerminate(s: CState): boolean {
    return controlflowRegions(s).every(canImmediateTerminateRegion)
}

export function canImmediateAborted(s: CState): boolean {
    return s.out.some(t => (isStrongAbort(t) || isWeakAbort(t)) && isImplicitlyImmediate(t))
}

/** A final state without outgoing transitions, inner behaviour or actions (getSimpleFinalStates). */
export function simpleFinalState(r: CRegion): CState | undefined {
    return finalStates(r).find(s => s.out.length === 0 && !controlflowRegionsContainStates(s) && s.actions.length === 0)
}

export function getOrCreateSimpleFinalState(r: CRegion, name: string): CState {
    return simpleFinalState(r) ?? createFinalState(r, name)
}

/** StateIterator.getStateIterator: pre-order over states, a state's regions in order, each region's states in order. */
export function allStates(s: CState, includeRoot = true): CState[] {
    const out: CState[] = []
    const visit = (state: CState, include: boolean) => {
        if (include) out.push(state)
        for (const r of state.regions) for (const c of r.states) visit(c, true)
    }
    visit(s, includeRoot)
    return out
}

/** All states inside a state or region (not the scope itself). */
export function allContainedStates(scope: Scope): CState[] {
    if (isRegion(scope)) {
        const out: CState[] = []
        for (const c of scope.states) out.push(...allStates(c, true))
        return out
    }
    return allStates(scope, false)
}

/** sccAllScopes: every state and region, in pre-order (a state, then each of its regions and their contents). */
export function allScopes(s: CState): Scope[] {
    const out: Scope[] = []
    const visit = (state: CState) => {
        out.push(state)
        for (const r of state.regions) {
            out.push(r)
            for (const c of r.states) visit(c)
        }
    }
    visit(s)
    return out
}

export function allRegions(s: CState): CRegion[] {
    return allScopes(s).filter(isRegion)
}

/** Every transition of the chart (pre-order over states, each state's transitions in priority order). */
export function allTransitions(s: CState): CTransition[] {
    return allStates(s).flatMap(x => x.out)
}

/** The state that contains a scope's declarations at run time (a region's declarations belong to its parent). */
export function owningState(scope: Scope): CState {
    return isRegion(scope) ? scope.parent : scope
}

/** Nearest enclosing state of a region (its parent) or of a state (its parent region's parent). */
export function parentState(s: CState): CState | undefined {
    return s.parent?.parent
}

// ---------------------------------------------------------------------------------------------------
// Expressions: copying, walking, building
// ---------------------------------------------------------------------------------------------------

export function copyExpr<E extends CExpr | undefined>(e: E): E {
    if (!e) return e
    switch (e.k) {
        case 'lit': case 'null': case 'random': case 'host': case 'ignore': case 'unsupported': return { ...e }
        case 'ref': return copyRef(e) as E
        case 'op': return { ...e, args: e.args.map(a => copyExpr(a)) }
        case 'vector': return { ...e, values: e.values.map(a => copyExpr(a)) }
        case 'call': return { ...e, args: e.args.map(a => copyExpr(a)), target: e.target ? copyRef(e.target) : undefined } as E
    }
}

export function copyRef(r: CRef): CRef {
    return { k: 'ref', v: r.v, idx: r.idx.map(i => copyExpr(i)), sub: r.sub ? copyRef(r.sub) : undefined, span: r.span }
}

export function copyEffect(f: CEffect): CEffect {
    const o = { ...f.o }
    switch (f.k) {
        case 'assign': return { ...f, ref: copyRef(f.ref), expr: copyExpr(f.expr), o }
        case 'emit': return { ...f, ref: copyRef(f.ref), value: copyExpr(f.value), o }
        case 'print': return { ...f, args: f.args.map(a => copyExpr(a)), o }
        case 'call': return { ...f, call: copyExpr(f.call), o }
        default: return { ...f, o }
    }
}

export function ref(v: CVar, idx: CExpr[] = []): CRef {
    return { k: 'ref', v, idx }
}

export const TRUE: CExpr = { k: 'lit', t: 'bool', v: true }
export const FALSE: CExpr = { k: 'lit', t: 'bool', v: false }
export const lit = (v: boolean | number, t: 'bool' | 'int' | 'float' = typeof v === 'boolean' ? 'bool' : 'int'): CExpr => ({ k: 'lit', t, v })

export function op(o: OperatorType, ...args: CExpr[]): CExpr {
    return { k: 'op', op: o, args }
}

/** KIELER's `and` of a list (null entries skipped; a single expression stays itself). */
export function and(list: (CExpr | undefined)[]): CExpr | undefined {
    const items = list.filter((e): e is CExpr => e !== undefined)
    if (!items.length) return undefined
    if (items.length === 1) return items[0]
    return { k: 'op', op: '&&', args: items }
}

export function or(list: (CExpr | undefined)[]): CExpr | undefined {
    const items = list.filter((e): e is CExpr => e !== undefined)
    if (!items.length) return undefined
    if (items.length === 1) return items[0]
    return { k: 'op', op: '||', args: items }
}

export function assign(v: CVar, expr: CExpr | undefined, o: EffectOrigin = { hidden: true }, operator: AssignOperator = '='): CEffect {
    return { k: 'assign', ref: ref(v), op: operator, expr, o }
}

/** Calls `fn` on every expression node (pre-order), including indices and call arguments. */
export function walkExpr(e: CExpr | undefined, fn: (e: CExpr) => void) {
    if (!e) return
    fn(e)
    switch (e.k) {
        case 'ref': walkRef(e, fn); break
        case 'op': for (const a of e.args) walkExpr(a, fn); break
        case 'vector': for (const a of e.values) walkExpr(a, fn); break
        case 'call': for (const a of e.args) walkExpr(a, fn); if (e.target) walkRef(e.target, fn); break
        default: break
    }
}

function walkRef(r: CRef, fn: (e: CExpr) => void) {
    for (const i of r.idx) walkExpr(i, fn)
    if (r.sub) walkExpr(r.sub, fn)
}

/** Every expression of an effect (the target reference included). */
export function effectExprs(f: CEffect): CExpr[] {
    switch (f.k) {
        case 'assign': return f.expr ? [f.ref, f.expr] : [f.ref]
        case 'emit': return f.value ? [f.ref, f.value] : [f.ref]
        case 'print': return f.args
        case 'call': return [f.call]
        default: return []
    }
}

/** Rebuilds an expression bottom-up: `fn` may return a replacement for a node (after its children were mapped). */
export function mapExpr(e: CExpr, fn: (e: CExpr) => CExpr | undefined): CExpr {
    let mapped: CExpr
    switch (e.k) {
        case 'ref': mapped = mapRefParts(e, fn); break
        case 'op': mapped = { ...e, args: e.args.map(a => mapExpr(a, fn)) }; break
        case 'vector': mapped = { ...e, values: e.values.map(a => mapExpr(a, fn)) }; break
        case 'call': mapped = { ...e, args: e.args.map(a => mapExpr(a, fn)), target: e.target ? mapRefParts(e.target, fn) : undefined }; break
        default: mapped = e
    }
    return fn(mapped) ?? mapped
}

function mapRefParts(r: CRef, fn: (e: CExpr) => CExpr | undefined): CRef {
    return { ...r, idx: r.idx.map(i => mapExpr(i, fn)), sub: r.sub ? mapRefParts(r.sub, fn) : undefined }
}

/** Maps the expressions of an effect; the target reference's indices are mapped, the target itself is kept. */
export function mapEffect(f: CEffect, fn: (e: CExpr) => CExpr | undefined): CEffect {
    switch (f.k) {
        case 'assign': return { ...f, ref: mapRefParts(f.ref, fn), expr: f.expr ? mapExpr(f.expr, fn) : undefined }
        case 'emit': return { ...f, ref: mapRefParts(f.ref, fn), value: f.value ? mapExpr(f.value, fn) : undefined }
        case 'print': return { ...f, args: f.args.map(a => mapExpr(a, fn)) }
        case 'call': return { ...f, call: mapExpr(f.call, fn) as typeof f.call }
        default: return f
    }
}

/** Every action-like element of a chart that holds expressions: transitions and local actions, with their owner. */
export interface ActionSite {
    owner: Scope
    transition?: CTransition
    action?: CAction
}

export function allActionSites(root: CState): ActionSite[] {
    const out: ActionSite[] = []
    for (const scope of allScopes(root)) {
        for (const a of scope.actions) out.push({ owner: scope, action: a })
        if (!isRegion(scope)) for (const t of scope.out) out.push({ owner: scope, transition: t })
    }
    return out
}

/** Applies `fn` to the trigger and every effect expression of every transition and action below (and of) `root`. */
export function mapAllExpressions(root: Scope, fn: (e: CExpr) => CExpr | undefined) {
    const states = isRegion(root) ? allContainedStates(root) : allStates(root)
    const scopes: Scope[] = isRegion(root) ? [root, ...states.flatMap(s => [s, ...s.regions])] : allScopes(root)
    const seen = new Set<Scope>()
    for (const scope of scopes) {
        if (seen.has(scope)) continue
        seen.add(scope)
        for (const a of scope.actions) {
            if (a.trigger) a.trigger = mapExpr(a.trigger, fn)
            a.effects = a.effects.map(f => mapEffect(f, fn))
        }
        if (!isRegion(scope)) {
            for (const t of scope.out) {
                if (t.trigger) t.trigger = mapExpr(t.trigger, fn)
                t.effects = t.effects.map(f => mapEffect(f, fn))
            }
        }
        for (const v of scope.decls) {
            if (v.init) v.init = mapExpr(v.init, fn)
        }
    }
}

/** Structural equality of expressions (KIELER's KExpressionsCompareExtensions.equals2). */
export function sameExpr(a: CExpr | undefined, b: CExpr | undefined): boolean {
    if (a === b) return true
    if (!a || !b || a.k !== b.k) return false
    switch (a.k) {
        case 'lit': return a.t === (b as typeof a).t && a.v === (b as typeof a).v
        case 'null': case 'random': case 'ignore': return true
        case 'host': return a.text === (b as typeof a).text
        case 'unsupported': return false
        case 'ref': return sameRef(a, b as CRef)
        case 'op': {
            const o = b as typeof a
            return a.op === o.op && a.args.length === o.args.length && a.args.every((x, i) => sameExpr(x, o.args[i]))
        }
        case 'vector': {
            const o = b as typeof a
            return !!a.range === !!o.range && a.values.length === o.values.length && a.values.every((x, i) => sameExpr(x, o.values[i]))
        }
        case 'call': {
            const o = b as typeof a
            return a.name === o.name && a.args.length === o.args.length && a.args.every((x, i) => sameExpr(x, o.args[i]))
        }
    }
}

function sameRef(a: CRef, b: CRef): boolean {
    return a.v === b.v && a.idx.length === b.idx.length && a.idx.every((x, i) => sameExpr(x, b.idx[i])) &&
        (a.sub === undefined ? b.sub === undefined : b.sub !== undefined && sameRef(a.sub, b.sub))
}

/** True if the expression references `v` anywhere. */
export function mentions(e: CExpr | undefined, v: CVar): boolean {
    let found = false
    walkExpr(e, x => { if (x.k === 'ref' && x.v === v) found = true })
    return found
}

/** Debug printing of the working model (for tests and for comparing with KIELER's model dump). */
export function printExpr(e: CExpr | undefined): string {
    if (!e) return ''
    switch (e.k) {
        case 'lit': return e.t === 'string' ? JSON.stringify(e.v) : String(e.v)
        case 'null': return 'null'
        case 'ref': return printRef(e)
        case 'op': {
            if (e.op === 'neg') return `-${printExpr(e.args[0])}`
            if (e.op === '!' || e.op === '~') return `${e.op}${printExpr(e.args[0])}`
            if (e.op === 'pre' || e.op === 'val') return `${e.op}(${e.args.map(printExpr).join(', ')})`
            if (e.op === '?:') return `(${printExpr(e.args[0])} ? ${printExpr(e.args[1])} : ${printExpr(e.args[2])})`
            return `(${e.args.map(printExpr).join(` ${e.op} `)})`
        }
        case 'vector': return `{${e.values.map(printExpr).join(', ')}}`
        case 'call': return `${e.extern ? 'extern ' : ''}${e.name}(${e.args.map(printExpr).join(', ')})`
        case 'random': return 'random()'
        case 'host': return '`' + e.text + '`'
        case 'ignore': return '_'
        case 'unsupported': return `<${e.what}>`
    }
}

function printRef(r: CRef): string {
    return r.v.name + r.idx.map(i => `[${printExpr(i)}]`).join('') + (r.sub ? '.' + printRef(r.sub) : '')
}

export function printEffect(f: CEffect): string {
    switch (f.k) {
        case 'assign': return f.op === '++' || f.op === '--' ? `${printRef(f.ref)}${f.op}` : `${printRef(f.ref)} ${f.op} ${printExpr(f.expr)}`
        case 'emit': return f.value ? `${printRef(f.ref)}(${printExpr(f.value)})` : printRef(f.ref)
        case 'print': return `print(${f.args.map(printExpr).join(', ')})`
        case 'call': return printExpr(f.call)
        case 'host': return '`' + f.text + '`'
        case 'randomize': return 'randomize()'
        case 'mark': return `#${f.m.kind}${'transition' in f.m ? '[' + f.m.index + ']' : 'action' in f.m ? '[' + f.m.action + ']' : ''}`
        case 'unsupported': return `<${f.what}>`
    }
}

/** Prints the working model in an SCTX-like notation (debugging aid; mirrors KIELER's model dump). */
export function printModel(root: CState): string {
    const lines: string[] = []
    const ind = (n: number) => '  '.repeat(n)
    const decls = (scope: Scope, d: number) => {
        for (const v of scope.decls) {
            const mods = [v.input && 'input', v.output && 'output', v.const && 'const', v.signal && 'signal'].filter(Boolean).join(' ')
            lines.push(`${ind(d)}${mods ? mods + ' ' : ''}${v.type} ${v.name}${v.dims.map(x => `[${printExpr(x)}]`).join('')}${v.init ? ' = ' + printExpr(v.init) : ''}${v.combine ? ' combine ' + v.combine : ''}`)
        }
    }
    const actions = (scope: Scope, d: number) => {
        for (const a of scope.actions) {
            const head = [a.kind === 'entry' || a.kind === 'exit' ? a.preemption : '', a.delay === 'immediate' && a.kind !== 'entry' && a.kind !== 'exit' ? 'immediate' : '', a.kind].filter(Boolean).join(' ')
            lines.push(`${ind(d)}${head}${a.trigger ? ' if ' + printExpr(a.trigger) : ''}${a.effects.length ? ' do ' + a.effects.map(printEffect).join('; ') : ''}`)
        }
    }
    const state = (s: CState, d: number) => {
        const mods = [s.initial && 'initial', s.final && 'final', s.connector && 'connector'].filter(Boolean).join(' ')
        const head = s.root ? `scchart ${s.name}` : `${mods ? mods + ' ' : ''}state ${s.name}`
        const hasBody = s.root || s.decls.length || s.actions.length || s.regions.length
        lines.push(`${ind(d)}${head}${hasBody ? ' {' : ''}`)
        if (hasBody) {
            decls(s, d + 1)
            actions(s, d + 1)
            for (const r of s.regions) {
                lines.push(`${ind(d + 1)}${r.final ? 'final ' : ''}region ${r.name ?? ''}${r.dataflow ? ' (dataflow)' : ''} {`)
                decls(r, d + 2)
                actions(r, d + 2)
                for (const c of r.states) state(c, d + 2)
                lines.push(`${ind(d + 1)}}`)
            }
            lines.push(`${ind(d)}}`)
        }
        for (const t of s.out) {
            const kw = t.preemption === 'termination' ? 'join to' : t.preemption === 'strong' ? 'abort to' : 'go to'
            const delay = t.delay === 'immediate' ? 'immediate ' : t.delay === 'delayed' ? 'delayed ' : ''
            lines.push(`${ind(d)}${delay}${t.trigger ? 'if ' + printExpr(t.trigger) + ' ' : ''}${t.effects.length ? 'do ' + t.effects.map(printEffect).join('; ') + ' ' : ''}${kw} ${t.target.name}`)
        }
    }
    state(root, 0)
    return lines.join('\n')
}

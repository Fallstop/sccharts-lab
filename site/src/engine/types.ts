// The shared contract of the guide's SCCharts engine: the AST the parser produces, and the shapes the
// compiler, simulator and diagram renderer exchange. Everything here is plain data (JSON-serialisable),
// so it can cross a Web Worker boundary and be cached at build time.
//
// The textual syntax is KIELER's SCTX. The authoritative grammar is
// ../kieler-server-fork/modules/sccharts/src/de/cau/cs/kieler/sccharts/text/SCTX.xtext (with SCL, KExt,
// KEffects, KExpressions and Annotations). Names below follow the KIELER metamodel where one exists.

// ---------------------------------------------------------------------------------------------------
// Source locations and diagnostics
// ---------------------------------------------------------------------------------------------------

/** Offsets are UTF-16 indices into the source; lines and columns are 1-based. `end` is exclusive. */
export interface Span {
    start: number
    end: number
    line: number
    col: number
    endLine: number
    endCol: number
}

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
    severity: Severity
    message: string
    span?: Span
    /** Stable machine-readable code, e.g. 'parse', 'unknown-variable', 'causality-cycle', 'instantaneous-loop'. */
    code?: string
    /** One or two sentences a beginner can act on ("Make one of the transitions delayed ..."). */
    hint?: string
    /** Ids of the model elements involved (states, transitions, regions), for highlighting in the diagram. */
    related?: string[]
    /** KIELER's own message for the same problem (validation and linking diagnostics), when it has one. */
    kieler?: string
    /** The name the message suggests instead (its "did you mean"): a quick fix may put it in place of `span`. */
    suggestion?: string
    /** A runtime error (`TickResult.error`): the tick in which the simulation stopped. Later ticks repeat the error
     *  with this tick, since KIELER's simulation stays stopped. */
    tick?: number
}

// ---------------------------------------------------------------------------------------------------
// Element ids
// ---------------------------------------------------------------------------------------------------
//
// Every state, region, transition and action has an `id` that is unique within a Program and stable
// for unchanged source (so a diagram can keep its highlight while the text is edited elsewhere):
//
//   root state     <ChartName>                                   e.g. ABRO
//   region         <parentStateId>:<regionName | index>          e.g. ABRO:main, ABRO.WaitAB:0
//   state          <parentStateId>.<stateName>                   e.g. ABRO.WaitAB.WaitA
//                  (regions are not part of a state's id unless two regions of the same parent
//                  contain a state of the same name; then it is <regionId>.<stateName>)
//   transition     <sourceStateId>-><priority>                   e.g. ABRO.WaitAB->1
//   action         <stateId>!<kind><index among that kind>       e.g. ABRO.WaitAB!entry0
//   declaration    <scopeId>$<valuedObjectName>                  e.g. ABRO$O
//
// The diagram renderer puts these ids on SVG elements as data-id attributes; the simulator reports
// them in TickResult.

// ---------------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------------

export interface NodeBase {
    span: Span
}

export interface Program extends NodeBase {
    kind: 'program'
    /** `import "file"` strings in order. */
    imports: string[]
    /** Spans of the import names (parallel to imports). */
    importSpans?: Span[]
    pragmas: Pragma[]
    /** Every `scchart` in the file, in order. The simulator runs one of them (default: the first, as KIELER: Reference.xtend keeps rootStates.head). */
    charts: State[]
    /** Ordinary `// ...` and `/* ... *\/` comments (hidden from the grammar), in source order. */
    comments?: { kind: 'line' | 'block'; text: string; span: Span }[]
}

export interface Annotation extends NodeBase {
    kind: 'annotation'
    /** Name without the '@' (or 'comment' for a doc comment). */
    name: string
    values: string[]
    /** Typed annotation `@layout[elk.direction] UP`: the part in brackets. */
    type?: string
    /** JSON annotation `@name {"key": 1}`: the object's source text. */
    json?: string
}

export interface Pragma extends NodeBase {
    kind: 'pragma'
    name: string
    values: string[]
    /** JSON pragma `#name {"key": 1}`: the object's source text. */
    json?: string
}

export interface State extends NodeBase {
    kind: 'state'
    id: string
    name: string
    /** Optional display label: `state A "Waiting for A"`. */
    label?: string
    isRoot: boolean
    initial: boolean
    final: boolean
    connector: boolean
    violation: boolean
    annotations: Annotation[]
    /** Text of the `/** ... *\/` doc comment directly before the element, without the comment markers. */
    doc?: string
    declarations: Declaration[]
    /**
     * Declarations written after the actions, states or regions (a syntax error). KIELER's parser drops them, so they
     * are not in the scope and the names they declare do not resolve (as in KIELER); kept for the linker's hint.
     */
    lateDeclarations?: Declaration[]
    actions: LocalAction[]
    /** Concurrent regions. Empty for a simple state. States written directly inside a superstate
     *  (without `region`) form one implicit region (`implicit: true`). */
    regions: Region[]
    /** Outgoing transitions in priority order: transitions[0] has priority 1. */
    transitions: Transition[]
    /** `state S is Other(a, b to c)`: the state is an instance of another SCChart. */
    reference?: ScopeCall
    /** `calls` (module call) instead of `is`. */
    callsReference?: boolean
    /** `extends` base states (inheritance, rare). */
    baseStates?: ScopeCall[]
    /** Generic parameter declarations `scchart X<T is int>`, kept as written. */
    genericParameters?: string[]
    /** Span of just the state's name (for go-to-definition and renaming). */
    nameSpan: Span
    /** `policy` regions of a root state (kept apart from `regions`; they describe method call protocols). */
    policies?: Region[]
}

export interface Region extends NodeBase {
    kind: 'region'
    id: string
    regionType: 'controlflow' | 'dataflow'
    name?: string
    label?: string
    /** States written straight into a superstate or scchart without a `region` keyword. */
    implicit: boolean
    annotations: Annotation[]
    doc?: string
    /** `final region` / `abort region` / `override region` modifiers. */
    final?: boolean
    abort?: boolean
    override?: boolean
    declarations: Declaration[]
    actions: LocalAction[]
    /** Control-flow regions. */
    states: State[]
    /** Dataflow regions (`dataflow { O = A && B }`). */
    equations: Equation[]
    /** `region R for i : 0 to 3` (end omitted: `for i : ARRAY` iterates an array's indices). */
    forLoop?: { variable: string; from: Expression; to?: Expression; span: Span }
    /** `region R is super.X`: resolves only to regions inherited through `extends`; it does not instantiate a chart. */
    reference?: ScopeCall
    /** Dataflow `once`. */
    once?: boolean
    /** Span of the region's name (when it has one). */
    nameSpan?: Span
    /** A `policy` region of a chart or host class (method call protocol); not part of the behaviour. */
    policy?: boolean
}

export type DelayType = 'delayed' | 'immediate' | 'auto' | 'undefined'
export type PreemptionType = 'weak' | 'strong' | 'termination'

export interface Transition extends NodeBase {
    kind: 'transition'
    id: string
    /** Id of the source state. */
    source: string
    /** Target state name as written. */
    targetName: string
    /** Resolved id of the target state (set by the resolver; undefined if it does not resolve). */
    target?: string
    targetSpan: Span
    /** Priority, 1-based, in the order the transitions are written under their source state. */
    priority: number
    /** As written; undefined means the keyword was omitted (delayed, except for connector sources). */
    delay?: DelayType
    /** `go to` = weak abort, `abort to` = strong abort, `join to` = termination. */
    preemption: PreemptionType
    /** Count delay: `if 3 A go to B` fires on the third tick in which A holds. */
    triggerDelay?: number
    trigger?: Expression
    /** `Pr=0.5` probability and `nondeterministic` (kept, not simulated). */
    probability?: number
    nondeterministic?: boolean
    effects: Effect[]
    deferred?: 'shallow' | 'deep'
    history?: 'reset' | 'shallow' | 'deep'
    label?: string
    annotations: Annotation[]
    doc?: string
}

export type LocalActionKind = 'entry' | 'during' | 'exit' | 'suspend' | 'period' | 'ode'

export interface LocalAction extends NodeBase {
    kind: LocalActionKind
    id: string
    /** `immediate during`, `immediate suspend`, ... */
    delay?: DelayType
    /** `weak entry` / `strong exit` (PreemptionActionType) */
    preemption?: 'weak' | 'strong'
    /** `weak suspend` */
    weak?: boolean
    triggerDelay?: number
    trigger?: Expression
    /** `entry if A Pr 0.5`, `during if A Pr=0.5` (kept, not simulated). */
    probability?: number
    effects: Effect[]
    label?: string
    annotations: Annotation[]
    doc?: string
}

export interface Equation extends NodeBase {
    kind: 'equation'
    target: Reference
    operator: AssignOperator
    expression: Expression
    sequential?: boolean
    /** Dataflow reference call `A(x, y)` / `A(x) = e`: the call's arguments (expression is then the call or `e`). */
    callArgs?: Expression[]
    annotations?: Annotation[]
}

export interface ScopeCall extends NodeBase {
    kind: 'scopeCall'
    target: string
    /** Bindings in order. `binding` is set for explicit `x to y` bindings (the referenced chart's name). */
    parameters: ScopeParameter[]
    genericParameters?: string[]
    super?: boolean
    /** Span of the target name. */
    targetSpan?: Span
}

export interface ScopeParameter {
    expression: Expression
    /** Explicit binding `x to y`: the name of the referenced chart's interface variable. */
    binding?: string
    /** Resolved ValuedObject id of the explicit binding (set by the resolver). */
    bindingDecl?: string
    /** `x to y[1]` */
    bindingIndices?: Expression[]
    /** Span of the binding name after `to`. */
    bindingSpan?: Span
    /** `&x`: call by reference. */
    byReference?: boolean
    /** `!&x`: pure output. */
    pureOutput?: boolean
    span: Span
}

// ----- Declarations -----

export type ValueType = 'pure' | 'bool' | 'int' | 'float' | 'string' | 'clock' | 'clock-time' | 'host'

export type CombineOperator = 'none' | '+' | '*' | 'max' | 'min' | '|' | '&' | 'host'

export interface Declaration extends NodeBase {
    kind: 'declaration'
    /** `variable` for ordinary (and signal) declarations; others are parsed so charts that use them
     *  still load, and the simulator reports them as unsupported if they matter. */
    declKind: 'variable' | 'reference' | 'method' | 'enum' | 'class' | 'struct' | 'schedule' | 'primitive'
    /** Undefined only for `signal S` (a pure signal). */
    type?: ValueType
    /** `host "unsigned char" x` */
    hostType?: string
    /** For `ref`/reference declarations: `ref Other o`. */
    referenceTarget?: string
    signal: boolean
    input: boolean
    output: boolean
    const: boolean
    global: boolean
    static: boolean
    extern?: boolean
    access?: 'public' | 'protected' | 'private'
    annotations: Annotation[]
    doc?: string
    valuedObjects: ValuedObject[]
    /** Raw source text of declarations the engine does not model in detail (methods, classes, enums). */
    text?: string
    /** `extern "rand", @Java "Math.random" rand`: the host code strings with their tag annotations. */
    externs?: { code: string; annotations: Annotation[] }[]
    /** `ref Container.Chart x`: the container part. */
    referenceContainer?: string
    /** Span of the referenced type's name (`ref Chart x`, `primitive T x`). */
    referenceSpan?: Span
    /** `ref Chart<T> x`: generic arguments as written. */
    genericParameters?: string[]
    /** Class, struct and enum: the type name (`class Counter {...} c` -> 'Counter'); also kept on host classes. */
    className?: string
    /** `host class ...`, `host enum ...` */
    host?: boolean
    /** Members of a class or struct (declarations and methods), or the members of an enum (one declaration). */
    members?: Declaration[]
    /** Methods: return type as written (`int`, `void`, `host "char*"` -> 'host'), the parameters and the body. */
    returnType?: string
    returnHostType?: string
    parameters?: Declaration[]
    body?: { declarations: Declaration[]; statements: SclStatement[]; span: Span }
    /** `override method ...` */
    override?: boolean
    /** Schedule declarations: `schedule {conflicting, commuting} s` priorities, and `global` protocol. */
    priorities?: string[]
    /** `policy` regions of a host class. */
    policies?: Region[]
}

export interface ValuedObject extends NodeBase {
    kind: 'valuedObject'
    id: string
    name: string
    /** Array dimensions: `int a[3][2]` → two expressions. */
    cardinalities: Expression[]
    initialValue?: Expression
    combine?: CombineOperator
    label?: string
    /** `ref Chart c(x to y)`: bindings of a reference valued object. */
    parameters?: ScopeParameter[]
    genericParameters?: string[]
    annotations?: Annotation[]
    /** Span of just the name. */
    nameSpan?: Span
}

// ----- Expressions -----

export type OperatorType =
    | '||' | '&&' | '|' | '^' | '&'
    | '==' | '!=' | '<' | '<=' | '>' | '>='
    | '<<' | '>>' | '>>>'
    | '+' | '-' | '*' | '/' | '%'
    | '!' | '~' | 'neg'          // 'neg' is unary minus
    | '?:'                       // ternary: args [cond, then, else?]
    | 'pre' | 'val'
    | '->' | 'fby' | 'sfby'      // dataflow initialisation and followed-by

export type Expression =
    | { kind: 'bool'; value: boolean; span: Span }
    | { kind: 'int'; value: number; span: Span }
    | { kind: 'float'; value: number; span: Span }
    | { kind: 'string'; value: string; span: Span }
    | Reference
    | { kind: 'op'; op: OperatorType; args: Expression[]; span: Span }
    /** Call of a method or referenced chart: `f(x)`, `obj.f(x)` (name 'obj.f'); `extern f(x)` sets extern.
     *  `target` is the called reference (with indices, sub-reference and resolved decl) for non-extern calls. */
    | { kind: 'call'; name: string; args: Expression[]; extern?: boolean; target?: Reference; super?: boolean; paramAccess?: ParamAccess[]; span: Span }
    | { kind: 'random'; span: Span }
    | { kind: 'randomize'; span: Span }
    | { kind: 'hostcode'; text: string; span: Span }   // `...` backtick host code
    | { kind: 'vector'; values: Expression[]; range?: boolean; span: Span }  // {1, 2, 3}; range: {1 to 5} (values [from, to])
    | { kind: 'ignore'; span: Span }                    // `_` in a vector
    | { kind: 'null'; span: Span }
    /**
     * `scchart(Chart).x` (target 'Chart', sub x) or `state(R.S)` (container 'R', target 'S'). `state`: the id of the
     * state a `state(...)` names, set by name resolution.
     */
    | { kind: 'special'; access: 'static' | 'scchart' | 'state'; text: string; target?: string; container?: string; sub?: Reference; state?: string; span: Span }
    /** `this` (only as a parameter of a reference). */
    | { kind: 'this'; span: Span }

/** Parameter passing mode of a call argument: `&x` call by reference, `!&x` pure output, null for a plain value. */
export type ParamAccess = '&' | '!&' | null

export interface Reference {
    kind: 'ref'
    name: string
    indices: Expression[]
    /** `a.b` member access. */
    sub?: Reference
    span: Span
    /** Resolved declaration (ValuedObject id), set by the resolver. */
    decl?: string
}

// ----- Effects -----

export type AssignOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=' | '>>>=' | 'min=' | 'max='

export type Effect =
    | { kind: 'assign'; target: Reference; operator: AssignOperator; expression: Expression; span: Span; annotations?: Annotation[] }
    | { kind: 'postfix'; target: Reference; operator: '++' | '--'; span: Span; annotations?: Annotation[] }
    /** `S` or `S(value)`. A bare name in an effect list parses as an emission; emitting a non-signal is a
     *  warning in KIELER's validator and an error from its compiler in reachable code (the validator reports
     *  both). `S(v)` where S is a method or a reference becomes a 'call' effect in the resolver (KIELER's
     *  KEffectsEmissionReferenceCallConverter). */
    | { kind: 'emit'; target: Reference; value?: Expression; span: Span; annotations?: Annotation[] }
    | { kind: 'call'; name: string; args: Expression[]; extern?: boolean; target?: Reference; super?: boolean; paramAccess?: ParamAccess[]; span: Span; annotations?: Annotation[] }
    | { kind: 'print'; args: Expression[]; span: Span; annotations?: Annotation[] }
    | { kind: 'randomize'; args: Expression[]; span: Span; annotations?: Annotation[] }
    | { kind: 'hostcode'; text: string; span: Span; annotations?: Annotation[] }
    /** `{ ... }` SCL code block. `text` is its source including the braces; the parsed body is kept too. */
    | { kind: 'code'; text: string; span: Span; declarations?: Declaration[]; statements?: SclStatement[]; annotations?: Annotation[] }

/** Statements of SCL code blocks (`do { ... }`) and method bodies, as SCTX allows them. */
export type SclStatement =
    | Extract<Effect, { kind: 'assign' | 'postfix' | 'call' | 'print' | 'randomize' | 'hostcode' }>
    | { kind: 'label'; name: string; span: Span }
    | { kind: 'goto'; target: string; span: Span }
    | { kind: 'return'; expression: Expression; span: Span }
    | { kind: 'block'; declarations: Declaration[]; statements: SclStatement[]; span: Span }
    | { kind: 'if'; condition: Expression; declarations: Declaration[]; statements: SclStatement[]; else?: { declarations: Declaration[]; statements: SclStatement[]; span: Span }; span: Span }
    | { kind: 'while'; condition: Expression; declarations: Declaration[]; statements: SclStatement[]; span: Span }
    /** `for (int i = 0; i < n; i++) { ... }`: init is a declaration or a statement. */
    | { kind: 'for'; init?: Declaration | SclStatement; condition: Expression; update?: SclStatement; declarations: Declaration[]; statements: SclStatement[]; span: Span }
    /** An expression used as a statement (`for (; c; x)` update or initialisation without assignment). */
    | { kind: 'expression'; expression: Expression; span: Span }

// ---------------------------------------------------------------------------------------------------
// Engine API shapes
// ---------------------------------------------------------------------------------------------------

export type Value = boolean | number | string | Value[] | null

export interface ParseResult {
    program?: Program
    diagnostics: Diagnostic[]
}

export interface VariableInfo {
    name: string
    /** Declaration id. */
    id: string
    /** In compile()'s interface, KIELER's simulation type: a clock (and `clock-time`) of a timed chart is `float`, or
     *  `int` with @IntegerClockType, as in KIELER's interface and data pool. */
    type: ValueType
    signal: boolean
    /** Valued signal (a signal with a type other than pure). */
    valued: boolean
    combine?: CombineOperator
    input: boolean
    output: boolean
    const: boolean
    /** Array dimensions (empty for scalars). */
    dims: number[]
    initialValue?: Value
}

/**
 * A value a trigger read at the moment it was checked (not after the tick). `name` is the reference as written in
 * the trigger (`n`, `a[i]`, `pre(x)`, `val(S)`; inside a referenced chart the referenced chart's names, with the
 * instance's values); `signal` marks a signal's presence (`value` true: present).
 */
export interface TraceSeen {
    name: string
    value: Value
    signal?: boolean
}

export type TraceEvent =
    | { kind: 'enter'; state: string }
    | { kind: 'exit'; state: string }
    /** A source transition's trigger was evaluated (once per tick, result and values read). `reason`: the values in
     *  words ("n was 0 and S was present"), `seen` the same as data. Constants and for-region counters are left out. */
    | { kind: 'check'; transition: string; result: boolean; reason?: string; seen?: TraceSeen[] }
    /** A source transition fired. `reason`/`seen`: what its trigger read when it was last checked true in this tick.
     *  `unchecked`: it has a trigger but fired without that trigger being checked: KIELER takes a superstate's last
     *  transition without checking it when, after the exit actions, no other transition holds (preemption.md P-23). */
    | { kind: 'take'; transition: string; reason?: string; seen?: TraceSeen[]; unchecked?: boolean }
    | { kind: 'action'; action: string; fired: boolean }
    | { kind: 'write'; variable: string; value: Value; by: string; how: 'init' | 'update' }
    | { kind: 'emit'; signal: string; value?: Value; by: string }
    | { kind: 'pause'; state: string; region: string }
    | { kind: 'terminate'; region: string }
    /** The state (or an ancestor's suspend) froze it in this tick; `reason`/`seen`: what the suspend trigger read. */
    | { kind: 'suspend'; state: string; reason?: string; seen?: TraceSeen[] }
    | { kind: 'print'; text: string; by: string }
    /** A plain-English explanation; `markdown` is the same with names and code in code spans (inline Markdown). */
    | { kind: 'note'; text: string; markdown?: string; related?: string[] }

export interface TickResult {
    /** 1 for the first reaction. */
    tick: number
    /**
     * The inputs by interface name (a signal: its presence) at the end of the tick: what the environment gave or kept
     * (missing inputs keep their value), unless the chart itself wrote the input in the tick (basics.md B-10), when it
     * is the value the chart wrote. `ranWith` has the values the tick started with.
     */
    inputs: Record<string, Value>
    /**
     * Every input's value as this tick ran with it: after the environment's values were applied (missing inputs keep
     * theirs, B-9; tick 1's assignments KIELER makes before reading inputs, B-7) and before the chart wrote any, by
     * KIELER's names: a valued input signal V as `V` (its presence) and `V_val` (its value); an unset string is null.
     * Sending these to `step()` again, tick by tick, gives the same run. (Optional only for hand-made results.)
     */
    ranWith?: Record<string, Value>
    /** Every interface and local variable after the tick. For a valued signal: its value. */
    values: Record<string, Value>
    /** Signal presence in this tick (pure and valued signals). */
    present: Record<string, boolean>
    /** Ids of all states active at the end of the tick (including ancestors and the root). */
    active: string[]
    entered: string[]
    exited: string[]
    /** Transition ids in the order they fired. A transition can fire more than once (immediate chains). */
    taken: string[]
    /** Ids of local actions whose effects ran. */
    actions: string[]
    /** The root has terminated (in this tick or an earlier one): nothing will happen in later ticks.
     *  Sticky. KIELER's _TERM flag (the oracle's `terminated`) is true only in the tick of termination,
     *  so compare against the first tick whose `terminated` is true. */
    terminated: boolean
    /** True only in the tick in which the root terminated (KIELER's _TERM). */
    terminatedNow?: boolean
    /** Micro-steps of the reaction in execution order, for "explain this tick". */
    log: TraceEvent[]
    /** Text from print() effects. */
    printed: string[]
    /** A runtime failure (division by zero, array index out of range, runaway immediate loop, ...). */
    error?: Diagnostic
    /**
     * For-region copies (structure.md S-21 .. S-23), when the chart has for-regions: every copy, in KIELER's order (the
     * for-regions in order, each copy in counter order), with the states active in that copy at the end of the tick and
     * the states entered in it during the tick. `active`, `entered` and `exited` above report a copy's states by the
     * ids of the one region the diagram draws, once for all copies; this says which copy is where.
     */
    copies?: ForCopyState[]
}

/** One copy of a for-region in a tick (TickResult.copies). */
export interface ForCopyState {
    /** The for-region's id (as written: the diagram draws it once). */
    region: string
    /** The counter's value in this copy (the engine gives a number; a string is allowed in hand-made results). */
    value: number | string
    /** Source ids of the states active in this copy at the end of the tick, outermost first. */
    active: string[]
    /** Source ids of the states entered in this copy during the tick, in order. */
    entered: string[]
}

/** A for-region and its copies (CompileResult.forCopies). */
export interface ForCopies {
    /** The for-region's id. */
    region: string
    /** The counter's name. */
    counter: string
    /** The counter's values, one per copy, in KIELER's order of the copies. */
    values: number[]
    /** The region's name, when it has one. */
    name?: string
}

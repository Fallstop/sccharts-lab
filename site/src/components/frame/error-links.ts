// Where the guide explains a compiler message: the section of reference/errors.mdx ("Compiler messages") that
// is about it. Widgets put an "About this message" link next to each diagnostic they show (frame/Diagnostics.astro,
// SimPanel's and CompareSim's rejected view, the playground).
//
//   errorLink(diagnostic)            '/reference/errors/#the-scg-is-not-asc-schedulable' or undefined
//   errorLink('causality-cycle')     an engine diagnostic code
//   errorLink("no viable alternative at input 'x'")   KIELER's own words (a recording, the playground's server)
//
// The anchors are the slugs Starlight gives the page's headings (github-slugger over the heading text, as
// Astro's heading-ids plugin does). tests/widgets/error-links.test.ts parses the MDX and fails when a heading
// named here disappears or is renamed, and when the page gets a message heading this file does not link to.
// To add one: put its slug in CODES (an engine diagnostic code) and a pattern for KIELER's words in MESSAGES.
//
// Pure and small: islands import it.

/** The page that explains KIELER's messages. */
export const ERRORS_PAGE = '/reference/errors/'

/** Anything that carries a message: the engine's `Diagnostic`, the frame's `ShownDiagnostic`, a recording. */
export interface LinkableDiagnostic {
    code?: string
    message?: string
    /** KIELER's own wording, when the guide's message differs. */
    kieler?: string
}

// Anchors (heading slugs), named once here so that the test can check each.
const A = {
    syntax: 'syntax-errors',
    firstMessage: 'fix-the-first-message-first',
    noViable: 'no-viable-alternative-at-input-x',
    extraneous: 'extraneous-input-go-expecting-to',
    primitive: 'mismatched-input-bool-expecting-primitive',
    ruleId: 'mismatched-input-reset-expecting-rule_id',
    missingTo: 'missing-to-at-done',
    eofBrace: 'mismatched-input-eof-expecting-',
    missingEof: 'missing-eof-at-if',
    region: 'mismatched-input-region-expecting-',
    inputString: 'for-input-string-3000000000',
    character: 'mismatched-character-eof-expecting-',
    semicolon: 'missing-semicolon',
    nameErrors: 'name-errors',
    unknownVariable: 'couldnt-resolve-reference-to-valuedobject-button',
    unknownState: 'couldnt-resolve-reference-to-state-done',
    unknownChart: 'couldnt-resolve-reference-to-namedobject-blinkr',
    noInitial: 'every-region-must-have-an-initial-state',
    twoInitial: 'every-region-must-not-have-more-than-one-initial-state',
    joinSimple: 'a-state-with-a-termination-transition-must-have-inner-behaviour',
    strongAbort: 'causality-problem-strong-abort-transitions-must-have-a-higher-priority-than-weak-abort-or-termination-transitions',
    assignSignal: 'non-variables-cannot-be-used-in-an-assignment',
    floatTrigger: 'float-tests-must-have-a-comparison-operator',
    assignConst: 'you-cannot-assign-a-value-to-a-const-object',
    constInit: 'a-const-declaration-must-have-an-initialization-part',
    arraySize: 'array-cardinalities-must-be-an-int-literal-or-a-reference-to-a-constant-int-object',
    arrayInit: 'initial-value-of-an-array-can-not-be-a-single-value',
    cardinality: 'cardinalities-do-not-match',
    constIndex: 'cannot-insert-const-array-element',
    countZero: 'a-count-delay-of-0-is-not-allowed-on-a-trigger',
    connectorDeadEnd: 'connector-states-must-have-an-outgoing-transition',
    binding: 'the-referencing-binding-is-erroneous',
    pure: 'pure-types-are-only-allowed-if-used-in-combination-with-signals',
    asc: 'the-scg-is-not-asc-schedulable',
    cantSchedule: 'cant-schedule-from-_g1-to-_g7',
    circular: 'circular-dependency-involving-mode-prevents-scheduling-this-tick',
    immediateLoop: 'there-is-an-immediate-loop-the-model-is-not-sasc',
    loopWarning: 'instantaneous-loop-detected',
    iasc: 'the-scg-is-not-iasc-schedulable',
    gcc: 'compiler-did-not-return-success-exit-value--0',
    duplicate: 'the-variable-is-declared-multiple-times-in-this-scope',
    emitVariable: 'non-signals-should-not-be-used-in-an-emission',
    internalErrors: 'internal-errors',
    setup: 'the-compiler-failed-during-compilation-setup',
    unsupportedConstruct: 'unsupportedconstructexception-unhandled-parameter-types-null',
    unknownType: 'cannot-serialize-simulation-interface-unsupported-type-unknown',
    copyNull: 'cant-copy-valued-object-valued-object-is-null',
    replaceLeft: 'cannot-replace-left-hand-side-of-assignment-by-a-value',
    recursive: 'recursive-reference-chart-main-uses-itself-main---main',
    forRange: 'the-for-region-range-for-i--1-to-n-ends-at-n-which-is-not-an-integer-literal',
    suspend: 'this-suspend-has-no-trigger-kieler-cannot-compile-a-suspend-without-an-if-condition',
    noChart: 'there-is-no-scchart-to-compile-add-a-scchart-declaration-first',
    sharedClock: 'cannot-handle-concurrent-timed-automata-using-the-same-clock',
    deltaT: 'a-variable-with-name-deltat-already-exists-and-is-not-an-input-variable-of-type-float',
    unreachableTransition: 'the-transition-is-not-reachable',
    unreachableState: 'the-state-is-not-reachable',
    relativeWrite: 'this-assignment-looks-like-old-relative-write-sc-syntax-and-is-considered-deprecated',
    allOrNone: 'all-or-none-concurrent-regions-should-have-final-states',
    finalForJoin: 'every-region-should-have-a-final-state-whenever-its-parent-state-has-a-termination-transition',
    abortTrigger: 'abort-transitions-should-have-a-trigger',
    connectorImmediate: 'outgoing-transitions-of-connector-states-should-be-marked-as-immediate',
    connectorDefault: 'connector-states-should-have-an-outgoing-transition-without-trigger',
    implicit: 'valued-objects-are-bound-implicitly',
    referenceTermination: 'the-referenced-scchart-does-not-terminate-but-you-are-using-a-termination-to-proceed',
    externCall: 'you-are-using-an-external-reference-without-call-syntax-if-you-want-to-generate-a-call-you-must-add-parentheses',
    minMax: 'min-or-max-combine-operators-are-currently-not-supported',
    duringCount: 'count-delays-on-during-actions-are-not-supported-yet-the-valued-will-be-ignored-by-the-transformation',
    countUnary: 'a-count-delay-was-recognized-in-front-of-an-unary-operation',
    valuedInput: 'valued-input-signals-currently-do-not-support-emission-overwriting',
    staticInit: 'static-variables-should-be-initialized',
    regionAction: 'actions-in-regions-are-highly-experimental-and-may-not-produce-the-expected-results',
    brokenImport: 'broken-import-there-is-no-sccharts-model-with-the-given-name',
    rootNames: 'there-are-multiple-root-states-with-the-same-name',
    regionNames: 'there-are-multiple-regions-with-the-same-name',
    variableStore: 'valuedobject-with-name-_hsteps-is-contained-in-the-model-but-not-in-variablestore',
    print: 'you-do-a-calculation-inside-a-print-call-effect-you-should-use-printf-syntax-to-be-safe-on-different-code-generators',
    layout: 'layout-annotations-must-have-the-format-layoutid-value',
    label: 'the-trigger-of-this-action-is-hidden-by-the-label',
    gccWarnings: 'c-compiler-warnings-in-sccharts-lab',
    objects: 'enums-structs-classes-and-methods',
} as const

/** Every anchor this module can return (the test checks that the page has each). */
export const ANCHORS: readonly string[] = Object.values(A)

/** Engine diagnostic codes (src/engine) and the section about them. Codes not listed here are matched by their
 *  KIELER wording, or get no link: the guide's own notes (`kieler-quirk`, `kieler-divergence`, `unsupported`,
 *  `ternary-grouping`, ...) are not compiler messages. `parse` is matched by its message, else the syntax errors
 *  section. Some codes stand for more than one of KIELER's messages and go by their words on purpose: `static-access`
 *  (gcc's `expected expression before ‘{’ token` links to the C compiler's section; `The valued object reference
 *  points to a valued object (…) that is not contained in the model!` has no section yet), `kieler-crash` (the
 *  crash's own section, else the internal errors as a whole), `method-twice`, `module-call` and
 *  `for-counter-method` (gcc's words). */
export const CODES: Readonly<Record<string, string>> = {
    'missing-semicolon': A.semicolon,
    'unknown-variable': A.unknownVariable,
    'unknown-binding': A.unknownVariable,
    'unknown-state': A.unknownState,
    'unknown-chart': A.unknownChart,
    'unknown-region': A.unknownChart,
    'unknown-label': A.nameErrors,
    'no-initial-state': A.noInitial,
    'multiple-initial-states': A.twoInitial,
    'termination-without-inner-behaviour': A.joinSimple,
    'strong-abort-priority': A.strongAbort,
    'assignment-to-signal': A.assignSignal,
    'float-trigger': A.floatTrigger,
    'assignment-to-const': A.assignConst,
    'const-without-value': A.constInit,
    'array-size': A.arraySize,
    'array-initial-value': A.arrayInit,
    cardinality: A.cardinality,
    'count-delay-zero': A.countZero,
    'connector-no-transition': A.connectorDeadEnd,
    'binding-error': A.binding,
    'binding-expression': A.binding,
    'pure-variable': A.pure,
    'causality-cycle': A.asc,
    'write-conflict': A.asc,
    'update-conflict': A.asc,
    'emission-conflict': A.asc,
    'val-cycle': A.asc,
    'abort-trigger-cycle': A.asc,
    'suspend-abort-cycle': A.asc,
    'period-abort-cycle': A.asc,
    'inline-loop': A.asc,
    'instantaneous-loop': A.asc,
    'count-delay-reset': A.asc,
    'immediate-loop': A.immediateLoop,
    'kieler-loop-warning': A.loopWarning,
    'c-keyword': A.gcc,
    'c-name': A.gcc,
    'c-string': A.gcc,
    'c-float-modulo': A.gcc,
    'unsigned-shift': A.gcc,
    'val-not-signal': A.gcc,
    'array-assignment': A.gcc,
    'string-arithmetic': A.gcc,
    'vector-ignore': A.gcc,
    'randomize-stdlib': A.gcc,
    'randomize-tick1': A.gcc,
    'float-modulo': A.gcc,
    'empty-method': A.gcc,
    'for-outer-counter': A.gcc,
    'enum-assignment': A.objects,
    'enum-initial-value': A.objects,
    'class-initial-value': A.objects,
    'assignment-to-class': A.objects,
    'class-reference': A.objects,
    'method-without-call': A.objects,
    'method-arguments': A.objects,
    'struct-member': A.objects,
    'class-without-name': A.objects,
    'method-without-value': A.objects,
    'method-without-return': A.objects,
    'return-outside-method': A.objects,
    'class-without-variable': A.objects,
    'state-access': A.objects,
    'duplicate-declaration': A.duplicate,
    'duplicate-variable': A.duplicate,
    'non-signal-emission': A.emitVariable,
    'unsupported-combine': A.unsupportedConstruct,
    'unknown-type': A.unknownType,
    'for-counter-assignment': A.replaceLeft,
    'recursive-reference': A.recursive,
    'for-range': A.forRange,
    'suspend-without-trigger': A.suspend,
    'no-chart': A.noChart,
    'shared-clock': A.sharedClock,
    'clock-variable': A.deltaT,
    'unreachable-transition': A.unreachableTransition,
    'unreachable-state': A.unreachableState,
    'relative-write': A.relativeWrite,
    'regions-cannot-terminate': A.allOrNone,
    'missing-final-state': A.finalForJoin,
    'abort-without-trigger': A.abortTrigger,
    'connector-not-immediate': A.connectorImmediate,
    'connector-no-default': A.connectorDefault,
    'implicit-binding': A.implicit,
    'reference-never-terminates': A.referenceTermination,
    'extern-without-call': A.externCall,
    'extern-not-called': A.externCall,
    'minmax-combine': A.minMax,
    'during-count-delay': A.duringCount,
    'count-delay-unary': A.countUnary,
    'valued-input-emission': A.valuedInput,
    'static-without-value': A.staticInit,
    'region-action': A.regionAction,
    'broken-import': A.brokenImport,
    'duplicate-chart': A.rootNames,
    'duplicate-region': A.regionNames,
    'print-calculation': A.print,
    'layout-annotation': A.layout,
    'label-hides-trigger': A.label,
    'label-hides-effects': A.label,
}

/** KIELER's words (and SCCharts Lab's, where it rewords them), most specific first. A message may start with
 *  KIELER's `line:column ` prefix; it is ignored. */
export const MESSAGES: readonly (readonly [RegExp, string])[] = [
    // Syntax
    [/^no viable alternative at input/, A.noViable],
    [/^extraneous input/, A.extraneous],
    [/^mismatched input '.*' expecting 'primitive'/, A.primitive],
    [/^mismatched input '.*' expecting RULE_ID|^missing RULE_ID at/, A.ruleId],
    [/^mismatched input '<EOF>' expecting '\}'/, A.eofBrace],
    [/^mismatched input 'region' expecting/, A.region],
    [/^missing EOF at/, A.missingEof],
    [/^missing '.+' at /, A.missingTo],
    [/^For input string:/, A.inputString],
    [/^mismatched character/, A.character],
    [/^Missing Semicolon/i, A.semicolon],
    [/^The required feature '.+' must be set/s, A.firstMessage],
    // Names
    [/^Couldn't resolve reference to ValuedObject/, A.unknownVariable],
    [/^Couldn't resolve reference to State/, A.unknownState],
    [/^Couldn't resolve reference to NamedObject/, A.unknownChart],
    [/^Couldn't resolve reference to /, A.nameErrors],
    // Structure
    [/^Every region must have an initial state/, A.noInitial],
    [/^Every region must not have more than one initial state/, A.twoInitial],
    [/^A state with a termination transition must have inner behaviour/, A.joinSimple],
    [/^Causality problem!\s*Strong abort transitions/, A.strongAbort],
    [/^Non-variables cannot be used in an assignment/, A.assignSignal],
    [/^Float tests must have a comparison operator/, A.floatTrigger],
    [/^You cannot assign a value to a const object/, A.assignConst],
    [/^A const declaration must have an initialization part/, A.constInit],
    [/^Array cardinalities must be|^Cannot initialize array with non integer cardinality/, A.arraySize],
    [/^Initial value of an array can not be a single value/, A.arrayInit],
    [/^Cardinalities do not match/, A.cardinality],
    [/^Cannot insert const array element/, A.constIndex],
    [/^A count delay of 0 is not allowed/, A.countZero],
    [/^Connector states must have an outgoing transition/, A.connectorDeadEnd],
    [/^The referencing binding is erroneous|^There are binding errors in a referenced state|^A binding for the valued object reference/, A.binding],
    [/^Pure types are only allowed/, A.pure],
    // Enums, structs, classes and methods
    [/^Cannot assign enum value of an incompatible type|^An enum typed variable can only be initialized with a value of the correct enum type|^Composed types \(class\/struct\) cannot be initialized|^(Assignments to|Referencing) class\/struct types is|^Assignments to class\/struct types are not supported/, A.objects],
    [/^Methods must be used with call syntax|^Number of arguments does not match required parameters|^All members of a struct must be publicly accessible/, A.objects],
    [/^A class\/struct must have a unique name|^The method does not return any value|^Return statements can only be used in method bodies|^A class\/struct should have at least one variable defined/, A.objects],
    [/^State access expressions are only permissible/, A.objects],
    // Scheduling
    [/^The SCG is NOT asc-schedulable/, A.asc],
    [/^Can't schedule from/, A.cantSchedule],
    [/^Circular dependency (involving .+ )?prevents scheduling/, A.circular],
    [/^There is an immediate loop/, A.immediateLoop],
    [/^Instantaneous loop detected|^Potential instantaneous loop/, A.loopWarning],
    [/^The SCG is not IASC-schedulable/, A.iasc],
    // Warnings that come before a C compiler error, and the C compiler's own words
    [/^The variable is declared multiple times/, A.duplicate],
    [/^Non-signals should not be used in an emission|^\S+ is an? .*variable, not a signal, so it cannot be emitted/, A.emitVariable],
    [/^(suggest parentheses around comparison|logical not is only applied|comparison with string literal|division by zero)/, A.gccWarnings],
    [/Compiler did not return success/, A.gcc],
    [/^(duplicate member|expected identifier|expected expression before|implicit declaration of function|assignment to expression with array type|invalid operands to binary|redefinition of|unknown type name|‘.+’ undeclared|‘.+’ redeclared as different kind of symbol|conflicting types for|missing terminating|two or more data types)/, A.gcc],
    [/^You are using modulo with floats/, A.gcc],
    // Internal errors (KIELER's crashes; the Java exception's name may come first)
    [/The compiler failed during compilation setup/, A.setup],
    [/UnsupportedConstructException: Unhandled parameter types/, A.unsupportedConstruct],
    [/^Cannot serialize simulation interface/, A.unknownType],
    [/Can't copy valued object\. Valued object is null/, A.copyNull],
    [/^Cannot replace left hand side of assignment/, A.replaceLeft],
    [/^Recursive reference:/, A.recursive],
    [/^The for-region range/, A.forRange],
    [/^This suspend has no trigger/, A.suspend],
    [/^There is no SCChart to compile/, A.noChart],
    // Timed SCCharts
    [/^Cannot handle (concurrent|hierarchical) timed automata|^Clock \S+ is read (by several concurrent regions|both by)/, A.sharedClock],
    [/^A variable with name deltaT already exists/, A.deltaT],
    // Warnings
    [/^The transition is not reachable/, A.unreachableTransition],
    [/^The state is not reachable/, A.unreachableState],
    [/^This assignment looks like old relative write|^This assignment reads .+, so the compiler treats it as an update/s, A.relativeWrite],
    [/^All or none concurrent regions should have final states/, A.allOrNone],
    [/^Every region should have a final state whenever/, A.finalForJoin],
    [/^Abort transitions should have a trigger/, A.abortTrigger],
    [/^Outgoing transitions of connector states should be marked as immediate/, A.connectorImmediate],
    [/^Connector states should have an outgoing transition without trigger/, A.connectorDefault],
    [/^Valued Objects are bound implicitly/, A.implicit],
    [/^The referenced SCChart does not terminate/, A.referenceTermination],
    [/^You are using an external reference without call syntax/, A.externCall],
    [/^Min or max combine operators/, A.minMax],
    [/^Count Delays on During Actions/, A.duringCount],
    [/^A count delay was recognized in front of an unary operation/, A.countUnary],
    [/^Valued input signals currently do not support emission/, A.valuedInput],
    [/^Static variables should be initialized/, A.staticInit],
    [/^Actions in regions are highly experimental/, A.regionAction],
    [/^Broken Import:/, A.brokenImport],
    [/^There are multiple root states with the same name/, A.rootNames],
    [/^There are multiple regions with the same name/, A.regionNames],
    [/is contained in the model but not in VariableStore/, A.variableStore],
    [/^You do a calculation inside a print call effect/, A.print],
    [/^Layout annotations must have the format/, A.layout],
    [/^The (trigger|effects) of this action (is|are) hidden by the label/, A.label],
]

/** The guide's own syntax-error messages (engine code `parse`) that match one of KIELER's sections; any other
 *  syntax error links to the syntax errors section as a whole. */
const PARSE: readonly (readonly [RegExp, string])[] = [
    [/is a keyword and cannot be used as a name/, A.ruleId],
    [/^Expected 'to' after/, A.missingTo],
    [/^The number \S+ is too large/, A.inputString],
    [/is never closed$/, A.character],
    [/is missing its closing '\}'/, A.eofBrace],
    [/^A (policy )?region cannot follow states that are not in a region/, A.region],
    [/^This '\}' has no matching '\{'/, A.extraneous],
    [/^Expected an scchart but found/, A.missingEof],
    [/^Unexpected ';' after the declaration/, A.primitive],
    // Where KIELER says `no viable alternative at input '…'` (the rows of that section's table).
    [/^Write 'go to' as two words|^'=' assigns; use '==' to compare|^Declarations must come before|^A \/\/\* comment is not allowed here/, A.noViable],
    [/^Unexpected name '.+' after the trigger|^Expected a value\b|^Expected a trigger condition after 'if'|^Expected 'go to', 'abort to' or 'join to'/, A.noViable],
]

const strip = (m: string) => m.replace(/^\s*\d+:\d+\s+/, '').trim()
const match = (rules: readonly (readonly [RegExp, string])[], m: string | undefined) => {
    if (!m) return undefined
    const s = strip(m)
    return rules.find(([re]) => re.test(s))?.[1]
}

/** The anchor (heading slug) on the errors page for a diagnostic, an engine code or KIELER's words. */
export function errorAnchor(d: LinkableDiagnostic | string | undefined): string | undefined {
    if (!d) return undefined
    if (typeof d === 'string') return /^[a-z][a-z0-9-]*$/.test(d) ? (CODES[d] ?? (d === 'parse' ? A.syntax : undefined)) : match(MESSAGES, d)
    const byCode = d.code ? CODES[d.code] : undefined
    if (byCode) return byCode
    // A syntax error: the guide's own message says best which section it is (KIELER may give several messages for
    // one mistake, such as `mismatched input 'bool' …` and `no viable alternative at input ';'`).
    const byParse = d.code === 'parse' ? match(PARSE, d.message) : undefined
    if (byParse) return byParse
    const byWords = match(MESSAGES, d.kieler) ?? match(MESSAGES, d.message)
    if (byWords) return byWords
    if (d.code === 'parse') return A.syntax
    // A crash the page has no section of its own for: what an internal error is, and the ones it has met.
    if (d.code === 'kieler-crash') return A.internalErrors
    return undefined
}

/** `/reference/errors/#anchor` for a diagnostic, an engine code or KIELER's words; undefined when the page does
 *  not explain it (the guide's own notes, a message nobody has met yet). */
export function errorLink(d: LinkableDiagnostic | string | undefined): string | undefined {
    const anchor = errorAnchor(d)
    return anchor ? `${ERRORS_PAGE}#${anchor}` : undefined
}

/** Who said a message that only a recording has: a C compiler warning (`… [-Waddress]`) is gcc's, which SCCharts
 *  Lab passes on; anything else is KIELER's. */
export function whoSays(message: string): 'The C compiler says' | 'KIELER says' {
    return /\[-W[\w=+-]*\]/.test(message) ? 'The C compiler says' : 'KIELER says'
}

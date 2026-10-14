# Simulator status

Updated by the simulator workstream as features land. The API shape is the one in
`docs-internal/ARCHITECTURE.md` and `src/engine/types.ts`; additions are listed under "API". Architecture and
how to add a feature: `README.md`. The differential fuzzer that keeps this honest: `tools/fuzz/README.md`.

## API

```ts
import { compile, createSimulation, describeTick } from '~engine/index'

const result = compile(source)           // front end now; the simulator's checks run on first use of ok/diagnostics
if (result.ok) {
  const sim = createSimulation(result)
  const t1 = sim.step({ button: true })   // missing inputs keep their value (as KIELER)
  describeTick(t1, result.program!, previousTick)   // plain-English sentences (previousTick optional)
}
```

- **Final polish (engine-5), for widgets-E and playground-5:**
  - `describeTick(result, program, previous?, { markdown: true })` gives the same sentences as inline Markdown, with
    state, variable, signal and chart names, triggers and values in code spans ("Inside `Left` (a copy of
    `PushSwitch`, with `press` bound to `left`): `Off` went to `On` because `press` was `true`."). The plain form
    (default) is unchanged in shape, has no code marks at all (a runtime error's message and hint lose theirs) and
    keeps the prefixes the widgets classify by (`The chart starts`, `No transition fired`, ` went to `, ...). Use
    the Markdown form instead of marking names up afterwards: `annotate` (src/components/sim/describe.ts) breaks
    code spans that contain a chart name (it wraps `B` inside `` `if B != 0` `` again). With `markdown`, the
    transition regex in `annotate` would meet `` `Off` `` instead of `Off`; the ids of a take are in the tick's log.
  - Elements inside the copy of a referenced chart are named by the reference, also for imported charts (compile()
    records the imported programs; their triggers' reasons come back too): "Inside Left (a copy of PushSwitch, with
    press bound to left): Off went to On because press was true.", "The chart starts in Off (inside Left) and Off
    (inside Right).", "No transition fired: On (inside Left) waits for press and Off (inside Right) waits for
    press." (was "its copy of", no copy in free play, nothing for HallLights).
  - `elementName(id, program, { markdown? })` (new export): a readable name for any id of a tick's result or log,
    states, transitions, regions and local actions, inside copies too: `{ name: 'Off → On', within: 'inside Left (a
    copy of PushSwitch)' }`, `{ name: 'PushSwitch', within: 'inside Left' }` for a copy's root, `{ name: 'Left' }`
    outside copies; undefined for unknown ids. For "Explain this tick" (`Check LampPanel.Left/PushSwitch.Off->1`,
    `Leave Left/PushSwitch.Off` today).
  - Log notes (`TraceEvent` `note`) have `markdown` beside `text` (every note the engine writes).
  - `traceableVariables`: a local of a state inside a for-region has one entry per copy, key `<declaration
    id>|<region id>=<value>` (`F.W$k|F:0=2`), name `k (i = 2)`, and `copy: { region, counter, value }`;
    `SimTickResult.trace` has each copy's value under its key (was: one entry, the first copy's value). A for-region's
    own declarations are shared by the copies and keep one entry.
  - Runtime errors (`TickResult.error`, a Diagnostic): `tick` is the tick it happened in; every later `step()` returns
    the same error object (with that tick) and the values of the last tick that ran (inputs are not read any more),
    as KIELER's dead process does; `rewind(n)` to before it runs again. Division by zero: message ``Division by zero:
    `b - 1` is 0``, hint "... Test that `b - 1` is not 0 first, for example with `if (b - 1) != 0` ..." (the
    divisor as the chart writes it: `pre(k)`, `val(S)`, `a[i]`; without a name when it is a value KIELER computes).
    Message and hint are inline Markdown. Widgets: Step/Run off, Restart offered (SimPanel `halted`) fits this.
  - `Diagnostic.suggestion` messages now end in ``(did you mean `Off`?)`` (backticks).
  - New codes: `conditional-without-else` (error, gcc's `‘__CONDSELF__’ undeclared`), `c-array-address` (error, gcc's
    `invalid operands to binary *`), `index-out-of-range` (now also a compile-time warning for a constant index outside
    its array, saying what KIELER's C code reads or writes instead). `kieler-quirk` for a trigger's conditional without
    else (info), `pre(x)` next to `pre(x, c)` (info) and a condition whose index KIELER drops (warning); `kieler-crash`
    for two code blocks of one state with a label of the same name. None of these needs a new section of
    reference/errors.mdx: error-links.ts already links gcc's `‘…’ undeclared` and `invalid operands to binary`
    messages (`kieler`) to the C compiler section.
- **For-region copies** (new in round 4, for the per-copy trace lanes and the diagram's ×n badges; **widgets-D**:
  `trace.ts` and `link.ts markCopies` read them as they are, checked on `advanced/for-regions` Seatbelts):
  `CompileResult.forCopies` (read like `ok`: it runs the simulator's compilation) lists each for-region as
  `{ region, counter, values, name? }`, `values` in KIELER's order of the copies (S-22); `TickResult.copies` has
  every copy in every tick as `{ region, value, active, entered }`: the source ids of the states active in that copy
  at the end of the tick (outermost first) and of those entered in it during the tick (`types.ts` `ForCopyState`,
  `ForCopies`). `active`/`entered`/`exited` keep reporting a copy's states by the region's source ids, once. Both are
  absent for a chart without for-regions. Tests: tests/engine/api.test.ts.
- **What each tick ran with** (new in round 4; the playground's `runInputs` takes a shared run from it and checks it
  by replaying the run): `TickResult.ranWith` has every input as the tick read it, after the
  environment's values were applied (missing inputs keep theirs, B-9; tick 1's GO-block assignments, B-7) and before
  the chart wrote any (B-10), by KIELER's names (a valued input signal `V` as `V`, its presence, and `V_val`, its
  value; an unset string is null). Sending them to `step()` again, tick by tick, gives the same run: checked for the
  scenario of every runnable example (tests/engine/api.test.ts). `TickResult.inputs` is unchanged (the inputs after
  the tick, by interface name), and its comment now says so.
- **Quick fixes** (new in round 4; **playground-4**): `Diagnostic.suggestion` is the name a "did you mean" offers
  (`unknown-state`, `unknown-variable`, unknown members), to put in place of `span`. The message ends in
  ``(did you mean `Off`?)`` (backticks since the final polish; the playground's `suggestionOf` reads `suggestion`).
- **Expressions on their own** (round 3, for the operators page's "How KIELER reads it"):
  `parseExpression(source, { as?: 'expression' | 'effect' | 'auto' })` returns `{ as, expression?, effect?,
  diagnostics }`: the text read with KIELER's `Expression` rule (as in a trigger or an initial value) or its `Effect`
  rule (as after `do`), with the chart parser's grammar, backtracking and messages (spans are offsets in the text;
  'auto', the default, takes the expression if the text is one, else the effect; names are not resolved).
  `formatExpressionParenthesised(expr, { nary?: 'flat' | 'left' })` and `formatEffectParenthesised(effect)` print
  it with every operation that is an operand of another one in parentheses: `a + b * c` -> `a + (b * c)`,
  `!a && b` -> `(!a) && b`, `x > 0 ? 1 : 2` -> `x > (0 ? 1 : 2)` (KIELER's conditional takes single values),
  `a - b - c` stays one n-ary node (`nary: 'left'` gives `(a - b) - c`, the C evaluation order). Rejected as in
  KIELER, with a hint: `!a + b` ('!' applies only to the value right after it), `a < b < c`, `a ? b : c ? d : e`,
  `x + 1 = 3`. Checked against KIELER: tests/engine/expression.test.ts. **Round 4:** a syntax error's `kieler` now
  has KIELER's words where they are known: what KIELER says for the text written as a trigger (`if <text> go to S`)
  or after `do` (parser/kielerWording.ts; "no viable alternative at input '=='" for `A == B == C`, "... '?'" for
  `B ? -1 : 2`, "... '+'" for `!a + b`, "... '='" for `x = = 1`). KIELER's ANTLR parser backtracks and names the
  token where a failing decision started, which is often not where the guide's parser stops; the rules give words
  only for shapes where they agreed with KIELER on every one of 1619 recorded texts (920 to fit them, a holdout of 600
  and 99 typical mistakes: 852 of 852 said right, 61 % of the broken texts covered;
  tests/engine/kieler/expressions/wording.json). Elsewhere `kieler` stays empty, and a trigger that starts with a
  number (a count delay in KIELER) gets none.
- **Variables a reader may trace** (round 3, for the playground's variables picker and the widgets):
  `traceableVariables(result)` lists, in declaration order, the simulation interface (inputs, outputs, the chart's
  own locals, inherited ones, clocks, KIELER's `deltaT` and `sleepT`), the members of the chart's class and struct
  instances (`pt.x`), and the locals of every state and region inside the chart (not inside referenced charts),
  each as a `TraceableVariable`: `key`, `name` (as written), `group` (`input`, `output`, `local`, `member`, `time`),
  `type` as declared (a clock stays `clock`; `simulationType` has KIELER's `float`/`int`), `signal`, `valued`,
  `input`, `output`, `dims`, `scope` (`{ kind: 'chart' | 'state' | 'region', id, name }`), `inPool` (in KIELER's data
  pool by that name: traced by default), `added` (deltaT/sleepT), `member` (`{ instance, member }`), `copy` (a local
  of a for-region copy's state, one entry per copy, see "Final polish"). Values per tick: `inPool` ones in `values`
  (signals: `present`), the others in `SimTickResult.trace[key]` (`key` is the local's declaration id, `Chart.S$c`,
  `Chart.W$k|Chart:0=2` for a copy's, or `pt.x` for a member; a local signal is its presence, a valued one its
  value). Tests: tests/engine/api.test.ts, tests/engine/polish.test.ts.
- `compile()` runs the simulator's compilation (KIELER's transformations, the causality and instantaneous-loop
  analysis, the checks gcc would fail on) after the front end, **lazily**: on the first read of `ok`,
  `diagnostics` or `sim` (`CompileResult.sim`: the compiled chart, for tools). `ok` is false exactly when KIELER
  rejects the chart; the error diagnostics are in source terms (`SIMULATOR_CODES` lists every code the
  simulator adds; every code is in "Diagnostic codes" below), with KIELER's own text in `kieler`, a `hint`, `related`
  ids and a `span` (the first related element's when the problem has no place of its own).
- Charts using a construct the simulator does not run get an **info** diagnostic with code `unsupported` that names
  the construct and says the official KIELER tools run the chart. `ok` stays true (KIELER accepts the chart), but
  the simulation cannot run it: `createSimulation` returns a simulation whose every `step()` has that as `error`.
- Other simulator diagnostics: `kieler-quirk` (info or warning: KIELER behaviour the guide reproduces, e.g. a chart
  with signals never terminates, or a chart whose behaviour changes from one KIELER compilation to the next),
  `kieler-bug` (warning: KIELER computes something else, the guide shows the intended result), `kieler-divergence`
  (warning: official KIELER fails on it, SCCharts Lab and the guide compile it, as the lab server's warning),
  `kieler-loop-warning` (info: KIELER's "Instantaneous loop detected!" on charts that work; that is official
  KIELER's wording, checked with the 0.3.0 jar; SCCharts Lab says `Potential instantaneous loop.` or `... through
  lamp.` instead. The hint says what the loop goes through: count delays, entry/during/exit actions, clocks,
  periods, strong aborts, or a superstate left and entered again).
- `compile().interface`: KIELER's simulation interface. A clock (and `clock-time`) of a timed chart has KIELER's
  type, `float` (or `int` with @IntegerClockType), not `clock`; `extractInterface()` keeps the declared types.
  A `ref E x` of an enum is an `int`.
- `createSimulation(result)` works for any `CompileResult`; for a rejected chart every `step()` returns a
  `TickResult` whose `error` is the first error.
- `step()` returns `SimTickResult` = `TickResult` + `pool`: KIELER's data pool with KIELER's names (`S`, `V`,
  `V_val`, `V_curval`, ..., plus environment values that are not inputs), exactly what the oracle's `values`
  contain. A value of the pool is a `PoolValue`: a `Value`, or for a class or struct instance and the locals of a
  `ref C g(...)` instance an object of its members (`"c1": {"count": 3}`, `"g": {"k": 0}`). `TickResult.values`
  is keyed by the interface names (a valued signal's value, a pure signal's presence, no constants); `present`
  has every signal's presence.
- `sim.takenCounts(tick)`: KIELER's `taken` array for a tick (Taken Transition Signaling order).
- `TickResult.terminated` is sticky; `terminatedNow` is KIELER's `_TERM` (true only in the termination tick).
- `log`: `enter`/`exit` (source states, innermost first), `check` (a source transition's trigger, once per tick,
  result and values read; aborts are checked where KIELER checks them), `take`, `action` (`fired: false` when an
  action's trigger was false), `write` (visible variables, `how: 'init'` for initialisations, `by` the element id),
  `emit` (`value` for valued signals), `print`, `pause` (states waiting for the next tick), `terminate`, `note`,
  `suspend` (a state that was suspended in the tick, at the start of the log).
- **What a trigger read** (reasons.ts): a `check` event carries `reason` ("n was 0 and S was present") and `seen`
  (the same as data: `{ name, value, signal? }`), read when the condition was evaluated, not after the tick; a
  `take` event carries what its trigger read when it was last checked true in that tick, and `unchecked: true`
  when it fired without its trigger being checked (KIELER takes a superstate's last transition after the exit
  actions without checking it, preemption.md P-23); a `suspend` event carries what the suspend trigger read.
  Names are as written in the trigger (`n`, `a[i]`, `pre(x)`, `val(S)`), inside a referenced chart the referenced
  chart's names with the instance's values; constants and for-region counters are left out. `describeTick` uses
  these: a one-variable trigger says what it was ("Off went to On because button was true", "... because S was
  present", "... because push was false"), any other "A went to B because n == 0 held (n was 0)" (expressions as
  KIELER's diagrams print them, no extra parentheses), a count delay "because A was true for the 3rd time while S
  was active", and for P-23 "M was aborted and went to C without checking X ... if none of the others applies then,
  it takes the last one regardless of its trigger." A state entered in the tick whose delayed transition's trigger
  already holds at the end of it gets "coin is true, but Locked was entered in this tick: its transition is
  delayed, so it is first checked in tick 2." (also in tick 1; "transitions are ... they are" for several). The
  widgets show these reasons as they are (their old `dropStaleReasons` workaround is gone).
- Preemption (preemption.md): `active`/`entered`/`exited` follow what KIELER does, not what the keywords suggest:
  a history entry resumes the state KIELER's history record names (also when it ignores the keyword, P-51, or a
  deferred entry was not recorded); a superstate entered one tick late by `deferred` (P-54 a) is active alone in
  the deferred tick and its inner states are entered in the next; weak suspend's rewind leaves the states the
  region moved on to (`exited`) and makes the bookmarked state active again without entering it; when a state with
  abort regions is done (any of its regions finished), its regions stop and their states are left at the end of the
  tick. Each of these is explained by a `note` (plain English, `related` ids). `describeTick` says what a strong or
  weak abort meant for the inside of a superstate, counts ("because A held for the 3rd time while S was active"),
  which states were suspended (and does not list their transitions as waiting), and passes the notes on. Generated
  transitions and actions never appear in `taken`/`actions`: only source ids (copies made by Deferred and Weak
  Suspend report the source transition they copy).
- Runtime errors (division by zero, `-2147483648 / -1`, an index outside an array past what the guide can lay out
  (memory.ts), unsupported host calls, a loop in a method running away, a typed method ending without `return`) set
  `TickResult.error`; the tick is not applied (KIELER's process would crash) and later steps repeat the error (same
  object, the tick it happened in). Every trigger is computed in every tick, also while its state is not active (as
  KIELER's netlist code does), so a division by zero there stops the simulation too.
- `rewind(n)` restores the state after tick `n` (snapshots, no replay), `reset()` starts again.
- Structure (structure.md): `compile(source, { files })` resolves `import`ed files and references to their charts.
  `interface` also lists what KIELER adds: the inherited declarations of a chart that `extends` others (in front),
  and `deltaT` (input) and `sleepT` (output) of a chart with clocks or `period` (unless it declares them, or
  @NoSleep). A referenced chart's states, transitions and actions are reported as
  `<reference state>/<id in the referenced chart>` (the ids the diagram gives an expanded reference;
  `active` includes `<reference state>/<chart>`, its copy's root); a `ref` or dataflow instance's as
  `<declaration id>/<id>`. A for-region copy reports the source ids (several copies in one state: once), and a
  transition of a copy is followed in the `log` by a `note` naming the copy (related `['#for-copy', transition,
  region, value]`). Writes by dataflow equations have `by` the dataflow region's id; clock increments the clock's
  declaration; a period's clock the period action. `describeTick` explains instances ("Inside R (its copy of
  Beep): ..."), copies ("In the copy of the for-region R with i = 2: ..."), time ("Time passed: the clock t
  advanced to 300 (deltaT = 100).", periods, sleepT) and dataflow ("The dataflow equations computed ...").

## Diagnostic codes

Every diagnostic the engine produces has one of these codes (stable: the widgets link them to the sections of
`reference/errors.mdx`, src/components/frame/error-links.ts). Where KIELER has a message for it, `kieler` holds it
verbatim; widgets that need KIELER's section can match `kieler` first, then the code.

- **Syntax** (error): `parse` (every syntax error; for the mistakes whose KIELER wording is certain, `kieler` has it:
  `no viable alternative at input ';'` after a declaration, `... input 'goto'`, `... input '=='` in an effect,
  `... input 'output'` for a declaration after the states, `... input 'e3'` for `1e3`, `mismatched input 'region'
  expecting '}'` for a region after states, `mismatched input 'initial' expecting '}'` for states after a region in
  braces, `extraneous input '}' expecting EOF`, `For input string: "3000000000"`, `mismatched character '<EOF>'
  expecting '*'` / `'"'`), `missing-semicolon`; `swallowed-line` (warning, the guide's own).
- **Names** (error, `Couldn't resolve reference to ...`): `unknown-variable`, `unknown-state`, `unknown-chart`,
  `unknown-region`, `unknown-binding`, `unknown-label`, `unknown-type`, `not-callable`. Reported after syntax errors
  too (the corpus test compares them with KIELER). An unresolved transition target has `related` = the state it leaves
  and the transition (`['Lamp.On', 'Lamp.On->1']`: the widgets can mark the source; the transition is not drawn), and
  `suggestion` when there is a near name.
- **Validation errors**: `no-initial-state`, `multiple-initial-states`, `termination-without-inner-behaviour`,
  `strong-abort-priority`, `connector-no-transition`, `count-delay-zero`, `float-trigger`, `assignment-to-signal`,
  `assignment-to-const`, `assignment-to-class`, `assignment-to-reference`, `class-reference`, `const-without-value`,
  `array-size`, `array-initial-value`, `pure-variable`, `binding-error`, `input-reference-parameters`,
  `super-reference-parameters`, `reference-initial-value`, `class-initial-value`, `class-without-name`,
  `struct-member`, `enum-assignment`, `enum-initial-value`, `state-access` (`state(...)` outside a method body, or
  ambiguous between anonymous regions; inside a method body it is accepted and simulated, S-69), `private-interface`,
  `method-arguments`,
  `method-signature` (KIELER's method inheritance checks), `method-without-call`, `return-outside-method`,
  `return-without-type`, `this-parameter`, `inheritance-cycle`, `inherited-name`, `override-anonymous`,
  `override-missing`, `override-nothing`, `dataflow-scalar-to-reference`, `deprecated-import`,
  `violation-without-enforcer`, `non-signal-emission` (error when the emission is reachable, else warning), `for-range`,
  `no-chart`, `unknown-chart` (`compile({ chart })`).
- **Indices** (warning): `index-out-of-range` for a constant index outside its array (after constant folding and in
  for-region copies), with what KIELER's C code reads or writes instead (memory.ts). **gcc** (error):
  `conditional-without-else`, a `(c) ? a` where KIELER's C code has nothing to put for the missing branch;
  `c-array-address`, a condition whose dropped index (guardIndices.ts) leaves gcc an array to multiply or to compare
  with a float.
- **Validation warnings**: `unreachable-state`, `unreachable-transition`, `relative-write`, `missing-final-state`,
  `regions-cannot-terminate`, `abort-without-trigger`, `connector-not-immediate`, `connector-no-default`,
  `implicit-binding`, `reference-never-terminates`, `extern-without-call`, `minmax-combine`, `during-count-delay`,
  `count-delay-unary`, `valued-input-emission`, `static-without-value`, `region-action`, `broken-import`,
  `duplicate-chart`, `duplicate-region`, `duplicate-variable`, `print-calculation`, `layout-annotation`,
  `class-without-variable`, `float-modulo`, `immediate-loop`; `ternary-grouping` (the guide's own: how KIELER groups
  `? :`). **Infos**: `label-hides-trigger`, `label-hides-effects` (transitions and actions).
- **Scheduling** (error, `The SCG is NOT asc-schedulable!`): `instantaneous-loop` (a cycle of immediate
  transitions), `write-conflict` (two regions assign different values; for-region copies sharing a region
  declaration), `update-conflict` (non-commuting updates, also inside a code block or method KIELER does not inline),
  `emission-conflict` (a valued signal without combine), `causality-cycle` (reads and writes waiting for each
  other), `val-cycle` (`val(V)` feeding an emission of V), `abort-trigger-cycle` (an abort out of a superstate whose
  trigger the inside writes, where KIELER cannot order them), `suspend-abort-cycle` (a strong abort out of a state
  with its own suspend), `period-abort-cycle` (a transition out of a state with a `period`), `abort-region-loop`,
  `inline-loop` (`@inline` on a method with a loop), `count-delay-reset` (a count delay inside a state with a self-loop,
  preemption.md P-36a: its own message, naming the count delay and the loop, and the counter by hand as the way out);
  `kieler-nondeterministic` (KIELER's verdict changes from run to run).
- **KIELER's compiler and gcc** (error): `kieler-crash` (KIELER's internal errors, `The compiler failed during
  compilation setup.` and others), `cardinality`, `unsigned-shift`, `array-assignment`, `vector-ignore`,
  `string-arithmetic`, `val-not-signal`, `duplicate-declaration`, `c-keyword`, `c-name` (a primed name `x'` or a kept
  `^` in a name that reaches the C code, S-71, and a variable `d` in a method kept as a C function, S-72; gcc's first
  error in `kieler`), `c-string` (a line break or a quote in a string literal, S-72), `c-float-modulo` (`%` on a float,
  S-72), `extern-not-called` (an `extern` function named without parentheses, S-72), `static-access` (a
  `scchart(C).X` that KIELER cannot copy, S-70), `unsupported-combine`,
  `randomize-tick1`, `randomize-stdlib`, `region-action-final`, `pre-placement`, `empty-method` (a method with
  parameters and an empty body), `for-outer-counter` (a `for` counter that is a chart variable), `method-twice`,
  `method-without-value`, `method-without-return`, `signal-member`, `unpack-instances`, `suspend-without-trigger`,
  `abort-region-order`, `abort-region-alone`, `binding-expression`, `recursive-reference`, `for-counter-assignment`,
  `for-counter-method`, `dataflow-for`, `unknown-type`, `shared-clock`, `clock-variable`, `clock-array`,
  `timing-constraint`, `default-sleep`, `inheritance-conflict`, `module-call`.
- **The guide's notes**: `unsupported` (info: the simulator cannot run it), `kieler-quirk` (info or warning),
  `kieler-bug` (warning), `kieler-divergence` (warning), `kieler-loop-warning` (info), `internal` (error: an engine
  bug).
- **Runtime** (`TickResult.error.code`): `division-by-zero`, `division-overflow` (`-2147483648 / -1`),
  `index-out-of-range`, `runaway-loop`, `missing-return`, `float-modulo`, `array-assignment`, `unsupported`,
  `internal`.

## Final polish (engine-5)

Each behaviour below was probed with KIELER (lab server; official 0.3.0 agrees on the cd-official set) and is a
recorded probe in `tests/engine/kieler/rare/` (62 new, all agreeing tick by tick; tests/engine/polish.test.ts pins the
API around them).

- **Backward `goto`** (structure.md S-44b): labels and gotos are no SCG nodes and no loop to KIELER, so a short body
  with a jump back is inlined (structure/methods.ts builds the graph as SCLToSCGTransformation does: a label stands
  for the next node of its list, one that ends a nested list for the body's end, statements after a goto up to the
  next label are dropped) and the jump is a cycle, rejected (`instantaneous-loop`, "`goto again` jumps back to
  `again`, a loop within the tick that KIELER cannot schedule", at the goto; corpus `effect-code-goto` and content-D's
  `goto-back-guarded` included). In a body that stays a C function (a loop, a call, 30 nodes or more: probed at 29 and
  30) KIELER's structured C code drops the jump back and the method ends there (no runaway loop any more).
- **Conditional without else** (basics.md B-24): the missing branch is the enclosing assignment's target (nested
  too: `x = 1 + (c ? 2)`, `x += c ? 1`, arguments of a C function inside an assignment, a suspend flag) or, in a
  condition, its guard variable: the previous result, kept from tick to tick (ExprCompiler.selves, exec.ts).
  `kieler-quirk` info at each one in a trigger; `conditional-without-else` error where gcc fails.
- **Every condition every tick** (basics.md B-22): exec.ts computes each condition at its place in the schedule in
  every tick, whether control reaches it or not, into KIELER's char guard (`_c<g>`): random() and C functions in the
  trigger of an inactive state run, a division by zero there stops the run, an int condition is truncated to char
  except a plain read of an input the chart never writes (copy propagation). Probes `probe-trigger-*`.
- **`pre(x)` next to `pre(x, c)`** (concurrency.md PRE-5): one memory, made for the last pre of x in KIELER's
  eAllContents order (a transition's trigger after its effects); passes/pre.ts follows the stack order, also for the
  order of the during actions it creates. `kieler-quirk` info at every pre whose clock KIELER drops or adds.
- **Indices outside an array** (basics.md B-28): memory.ts lays out KIELER's struct up to the taken counters and
  reads and writes there byte by byte (neighbouring variables, multi-dimensional rows, padding, bools under an int,
  doubles, pointers of strings); a log note for each such write, a warning for constant indices; beyond the known
  part a runtime error. The for-regions page's "Indices are not checked" aside stays true.
- **Two KIELER defects the `polish` fuzz profile found** (both also in official 0.3.0): (1) in a condition, an array
  element with a variable index loses its index in KIELER's C code when no plain variable comes before it and one
  comes after it (`ov[n] > 0 && a` is `ov > 0 && a`, the array's address, which is never 0; `a && ov[n] > 0` keeps
  it): guardIndices.ts reproduces it with a `kieler-quirk` warning, and rejects (`c-array-address`) what gcc then
  fails on (`ov[n] * 2`, a comparison with a float); probes `probe-index-dropped-*`, `probe-index-kept-*`. (2) Two code
  blocks or methods of one state (its methods, actions, transitions; the chart's methods) with a label of the same
  name: KIELER resolves the later block's `goto` to the earlier block's label and its compiler crashes
  (`kieler-crash`; official 0.3.0 never answers); probes `probe-label-*`.
- **Names in describeTick and the log** (API above): copies named by their reference with the bindings the trigger
  read; imported charts too; `elementName`; Markdown form. An inlined method's `if` tests are no longer logged as
  checks of the transition (advanced/methods Thermometer). Production QA: each for-region copy's check is logged (a
  check was logged once per transition, result and values read, so in Seatbelts a copy's true check after another
  copy's was missing and "Explain this tick" read "false", then "Take"); only for-region charts' logs change.

## Round 4 (engine-4)

- **Messages name things in code font.** Every diagnostic's message and hint (both are inline Markdown) writes the
  names of the reader's states, regions, variables, signals, methods and charts in backticks, as the hints already
  did for code: "State `Ready` can never be entered", "`x` and `y` depend on each other within one tick". Checked on
  every example, conformance chart and probe (a scan for chart identifiers outside code spans finds only English words
  that are also names in some chart). Exceptions, on purpose: KIELER's own words in `kieler` (and KIELER's reasons
  quoted inside a message, such as a binding error's); syntax messages keep ANTLR's quotes around tokens (`Unexpected
  name 'b' after the trigger`: `error-links.ts` matches them; the chart or state named in them is in backticks);
  runtime errors and the log's notes, which describeTick turns into sentences (with `markdown: true`, in code font;
  notes carry a `markdown` form). The "(did you mean ...)" part has backticks since the final polish. The descriptions of KIELER's hidden helpers name states the same way ("the
  count delay on `Watching`'s transition to `Expired`").
- **Places.** A clock read by several concurrent regions (`shared-clock`, `advanced/time` TwoTimers) is reported at the
  second region's timeout, with both timed transitions related; one used across nested regions at the clock.
- **Validation after a syntax error.** Still withheld, except `broken-import`: on the corpus's 112 files that both
  reject for their syntax, the engine's validation of the partial model matches KIELER's in 83 files; of its
  unreachable-state warnings 7 of 15 are KIELER's, of its missing initial states 1 of 5 (they follow from where the two
  parsers' recovery resumes), while its broken imports are all KIELER's (4 of 4). tests/corpus/corpus.test.ts checks
  that nothing else is reported on such a file.
- **Rare forms** (probes `tests/engine/kieler/rare/`, 34 charts recorded with KIELER): `state(R.S)` in a method body
  (S-69: KIELER's MethodSignaling flag, set by an entry and cleared by an exit action of S; simulated, every probe
  agrees tick by tick); `scchart(C).X` (S-70: the constant's value; what KIELER cannot copy is `static-access`); primed
  and caret names (S-71, `c-name`; a called method that stays a C function and has a `^` name compiles in current
  KIELER but not in official 0.3.0: a `kieler-divergence` warning). Any expression the lowering could not represent is an `unsupported` info at
  compile time now (`The guide's simulator cannot evaluate ...`), never a runtime error in a later tick.

## Tools (round 4)

- `tools/fuzz`: the `rare` profile (not part of `mix`, so old seeds generate the same charts). Final polish: the
  `polish` profile (not in `mix` either): conditionals without else, `pre(n, a)` next to `pre(n)`, gotos in code
  blocks, writes past an array.
- `tools/oracle`: unchanged. The rare-form probes were also run through official KIELER 0.3.0 (structure.md S-69 to
  S-71 say where it differs).

## Tools (round 3)

- `tools/oracle/oracle.mjs`: `startOracle()` also returns `kill()` (SIGKILL, for a compilation that never answers;
  pending runs fail) and `pid`; a result also has `issues` (the lab server's structured compiler issues: severity,
  code, message, hint, details, line, column, processor) and `internalErrors` (`{ message, processor, details }` of
  KIELER's crashes, `details` with the Java stack trace). The CLI and the other fields are unchanged.
- `tools/fuzz`: profiles `beginner`, `objects`, `abortObjects`; features `structs`, `enums`, `code` (methods with
  `if`/`for`/`while`, code blocks), `labels`; a `diagnostics` outcome when KIELER's front-end warnings or infos differ.
- `tests/conformance/engine-diagnostics.test.ts`: the engine's front-end errors, warnings and infos against the LSP
  diagnostics of every recording that parses (positions and KIELER's words); `tests/corpus/corpus.test.ts` also
  compares the linking errors of files that both reject for their syntax.

## Messages (round 3)

Everything a beginner reads was checked on the guide's examples (every rejected example and conformance chart
compiled, `_g`, `_region`, `__fbp`, `__df_`, `_H`, `_AC` and `null_` searched for: none left in messages or hints,
except KIELER's helper name in the `duplicate-declaration` of two `fby`s, which is the name gcc's error shows).

- Hints with code put it in backticks (they are rendered as inline Markdown: `x *= 10` no longer turns italic).
- Scheduling cycles name what the reader wrote: the dedicated messages above; hidden helpers by what they are
  ("Cooking's suspend condition", "the count delay on Watching's transition to Expired", "whether a region of S
  finished": generated state and region names never appear).
- `write-conflict`: "Two concurrent regions assign different values to mode", hint "KIELER does not check whether
  the two assignments can happen in the same tick: ..." (no longer contradicts itself).
- `abort-trigger-cycle` replaces the strong-abort explanation of `patterns/watchdog`'s WatchdogInside: KIELER also
  rejects the weak-abort version, and accepts both without the count delay inside (probes
  `preemption/probe-abort-trigger-inside-*`); the hint's fixes (a region next to the state, or `pre(expired)`) are
  recorded too.
- Syntax: `1e3` is "1e3 is not a number in SCTX" with "A float exponent needs a decimal point: write `1.0e3`, not
  `1e3`." (KIELER: `no viable alternative at input 'e3'`); a region after states says "write `region Main:` before
  the first state (`initial state Idle`)"; a declaration after the states is left out of the scope as in KIELER,
  and the names it declares get "lit is declared on line 10, after the states ... Move the declaration to the top".

## Works

Conformance (`pnpm exec vitest run tests/conformance/engine.test.ts`): every recording passes except the skips
listed by `ENGINE_SKIPS=1` (priority compiler scenarios, host code that needs a C compiler, B-34/B-35 not reproduced
on purpose); `engine-expected-failures.json` is empty. That is the basics, concurrency, preemption (#77 abort region
included) and structure recordings, every example in `src/examples`, and the probes in `tests/engine/kieler/`.

- States, delayed/immediate transitions, priorities, self-loops, effects in order, immediate chains,
  superstates, concurrent regions, final states, `join to` (triggered, delayed, immediate), root termination,
  locals re-initialised on entry, region declarations.
- Entry, during and exit actions (strong and weak), weak (`go to`) and strong (`abort to`) aborts, final states
  with outgoing transitions, connectors.
- Signals (pure and valued, combine functions), `pre`, `val`; inputs persist; input initial values (B-7).
- C semantics: 32-bit int wrap, truncating division, single-precision float literals, bool as char, string
  pointer equality, arrays and vector assignment, `min=`/`max=`, `++`/`--`, `random()` (glibc sequence), `print`.
- The order of side effects: the schedule is KIELER's (SimpleGuardScheduler on scheduling blocks, analysis.ts
  kielerSchedule), so concurrent `random()` calls, and prints, run in KIELER's order (probes
  `probe-random-order-*`).
- KIELER's acceptance: write-write conflicts, non-commuting updates, read/write and signal cycles (also false
  cycles), instantaneous loops, schizophrenic superstates (weak-abort self-loops are accepted, entry-tick
  terminations in reset loops are lost as in KIELER: K-3), KIELER's crashes (SuperfluousForkRemover on
  single-region superstates, SurfaceDepth on states with four or more transitions in its conditional shape) and
  its netlist's equal-branch conditional (README.md, "KIELER defects"; probes in `tests/engine/kieler/`).
- KIELER's run-to-run variation (compile.ts nondeterminism): when several superstates qualify for the
  schizophrenia cure, every order KIELER can take is analysed (each path through the choices, up to 24 analyses);
  a chart some orders accept and others reject is rejected (`kieler-nondeterministic`), a chart whose orders are
  all accepted but untangle different superstates gets a `kieler-quirk` info (its behaviour can change from one
  KIELER compilation to the next; measured: from 1 of 6 to 5 of 6 runs show the guide's behaviour).

- Preemption (preemption.md P-1 .. P-65): entry/during/exit actions (weak, strong), weak and strong aborts,
  terminations, connectors, `auto`/`undefined` (core); count delays (P-28..P-36, also on aborts, frozen by
  suspension, the stale immediate count of P-30); `suspend` and `immediate suspend` with KIELER's flag and its
  consequences (frozen own transitions, entry actions lost on first entry, exits skipped, delayed termination;
  P-37..P-45); `weak suspend` (P-46, also nested regions, exit actions, immediate); history, deep and shallow, with
  KIELER's top-level-only processing (P-47..P-52); `deferred` and `deep deferred` with KIELER's three strategies,
  including the copy (P-53..P-56); final regions (P-61); **abort regions** (P-62, abortRegions.ts: KIELER's
  SCGAbortRegionProcessor, the sequential preemptive fork and its par-or join, nesting of several regions, the
  depth guard's off-by-one that lets the region just before an abort region react in the tick it finishes, the
  entry guard, data order without concurrency, `Sequential forks must not be schizophrenic!`, the order checks
  only for states that can be reached). `kieler-quirk` infos explain P-12, P-20, P-23, P-30, P-38, P-42..P-44, P-51
  and P-54 a where a chart can show them. Probes in `tests/engine/kieler/preemption/`.

- Structure (structure.md S-1 .. S-56): references `state S is C(...)` with KIELER's binding pointer, implicit and
  literal bindings, array and array-cell bindings, signals, output initial values as entry actions, name clashes,
  nested references, imports, recursive references and `calls` (a C function KIELER never defines) rejected;
  `ref C g(args)` instances (their locals as the object `g` in the pool); `extends` with override regions and
  `region is super.R`; for-regions (literal ranges, arrays, descending, copies appended, shared taken counters,
  KIELER's crashes and errors); dataflow regions (classic and, with method calls, KIELER's "OO" translation;
  sequences by user schedules, `once`, chart instances with tuples and restart, vector equations); `->`, `fby`,
  `sfby` (KIELER's helper names and types, its sfby defect, fby blocking termination, root-level name clashes);
  clocks (deltaT/sleepT exactly per S-38, @IntegerClockType, @DefaultSleep, @SimulateSleep, @NoSleep, @Passive,
  **@ClocksUseSD** (shared and hierarchical clocks with KIELER's ClockIUR schedule), shared and hierarchical clocks
  without it rejected); `period` (soft and hard reset, immediate, guards on the state's own transitions); methods
  (simple ones inlined into the SCG as KIELER's Methods processor does, the others run as C functions, invisible
  to the dependency analysis), SCL code effects; **classes and structs** (members, private members, methods with
  parameters and return values, several instances, @UnpackClass; instances as objects in the pool); **enums**
  (`ref E x` an int, `E.V` its position); `static`, `global`; print and `random()` (core).
- Referenced charts have no take counters in KIELER, which changes what Surface/Depth makes of their states: an
  immediate untriggered transition with no other effect merges its state into the target (SITO), an untriggered
  immediate self-loop (or a cycle of such transitions) leaves its state without transitions and without SCG node
  (its region counts as finished), and a triggered and an untriggered transition to the same state are a conditional
  with equal branches (the netlist defect). A state left without node also trips KIELER's dependency analysis, which
  walks the graph depth first: a region that starts in it ends the walk there, so everything not yet reached gets no
  data dependencies and concurrent reads may come before writes (reproduced, `kieler-quirk` warning naming the
  variables); any other transition into it makes the analysis throw a NullPointerException (`kieler-crash`). Probes
  `structure/probe-reference-*`.

- Differential testing (tools/fuzz): the campaigns (statistics below; 5 and 6 are round 3's, 1990 charts, 7 is round 4's, 900,
  8 to 11 the final polish's, 1490) plus
  the earlier ones: about 720 charts (hierarchy, concurrency, signals, `pre`, connectors, joins, aborts, actions with
  triggers, data types), 752 preemption charts and 60 structure charts, each agreeing with KIELER in acceptance
  and in every tick except KIELER's own run-to-run variation.

### Fuzz campaigns (tools/fuzz)

| Campaign | Charts | Match | Both reject | Nondeterministic | Unsupported | KIELER timeout / failure | Disagreements |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (seed 11, 12 profiles x 130) | 1560 | 520 | 1005 | 4 | 0 | 19 | 12, all fixed or explained (below) |
| 2 (seed 23, after the fixes) | 1560 | 515 | 1009 | 9 | 1 | 26 | 0 |
| 3 (seed 31, timedClasses, abortRegions, refAborts, mix x 190) | 760 | 216 | 531 | 2 | 1 | 9 | 1, fixed (below) |
| 4 (seed 41, refAborts, structure x 110, after that fix) | 220 | 73 | 140 | 1 | 0 | 6 | 0 |
| 5 (seed 51, beginner, objects, abortObjects x 330) | 990 | 297 | 677 | 2 | 1 | 9 | 4, all fixed or explained (below) |
| 6 (seed 61, beginner 400, objects 250, abortObjects 200, mix 150; front-end warnings and infos compared too) | 1000 | 314 | 670 | 5 | 1 | 8 | 2: 1 fixed, 1 a KIELER hiccup (below) |
| 7 (seed 71, beginner, objects, rare x 300; round 4) | 900 | 325 | 550 | 13 | 2 | 10 | 0 |
| 8 (seed 81, beginner, rare x 220; final polish) | 440 | 172 | 261 | 5 | 0 | 2 | 0 |
| 9 (seed 91, polish x 200, the new profile) | 200 | 104 | 83 | 1 | 0 | 0 | 12, all fixed (below) |
| 10 (seed 101, polish x 250, after those fixes) | 250 | 92 | 154 | 2 | 0 | 0 | 2, fixed (below) |
| 11 (seed 111, polish, beginner, rare x 200) | 600 | 230 | 354 | 9 | 0 | 5 | 2, explained (below) |

Campaigns 8 to 11 (final polish): 8 runs the profiles `beginner` and `rare` on the engine with this round's changes
(no disagreement in 440 charts; the five charts the engine flags as depending on KIELER's cure order were run 5 to 15
more times each and all vary in KIELER: verdicts from 1 of 6 to 4 of 6 rejecting, one behaviour shown in 11 of 15
runs; of the two timeouts one matches with 120 s, the other varies like the five). The new profile `polish`
(tools/fuzz/README.md) found two defects of KIELER itself in campaign 9, both now reproduced: a variable index of an
array element dropped in a condition (2 charts; guardIndices.ts) and code blocks of one state sharing a label name
(10 charts; `kieler-crash`). Campaign 10's two: the label clash only crashes KIELER where its thread analysis walks the
code, not in a state that is never entered (fixed; `probe-label-unreachable`). Campaign 11's two are explained:
`z += (d) ? 1` next to a concurrent `z++` is `z += d ? 1 : z` in KIELER's C code, which reads z although KIELER's model
does not, so KIELER orders the two updates freely and the guide's order differs from KIELER's there (now a
`kieler-quirk` warning: the guide cannot promise KIELER's order); and a chart KIELER accepts in 2 of 13 runs and
rejects in the others, whose accepting cure order the engine's search does not reach (it rejects; its variants
without the count delay of the superstate are flagged `kieler-nondeterministic`). Its 9 charts flagged as depending on
the cure order were each run 5 more times (one 15 more): every one varies in KIELER (verdicts in 7, behaviour in 2:
3 of 5 and 8 of 15 runs show the guide's). Of its 5 timeouts, 3 answered with 120 s as the engine says (2 rejected, 1
matching); the other 2, which the engine rejects (`c-name`, a scheduling cycle), never answered.

Campaign 7 (round 4) adds the profile `rare` (tools/fuzz/README.md): a method reading `state(R0.R0s1)` called in
triggers (58 of its accepted charts agree tick by tick), constants of another chart `scchart(FK).K` in triggers and
effects (74), a primed constant (36), and in 25 charts a primed or `^` output that gcc rejects (rejected by both). No
disagreement in 900 charts. The 13 charts the engine flags as depending on KIELER's cure order were each run five more
times (one of them seventeen more): every one varies from run to run in KIELER (verdicts, or behaviour in tick 5 or
8; the last accepted 16 of 18 runs). Of the 10 KIELER timeouts (40 s), 4 answered with 120 s (3 rejected as the engine
does, 1 matching tick by tick); the other 6, all rejected by the engine, never answered.

Campaigns 5 and 6 use the new profiles (tools/fuzz/README.md): `beginner` (signals, aborts, `pre`, count delays in
two or three regions), `objects` (classes with `if`/`for`/`while` in methods, structs, enums, code blocks, labels)
and `abortObjects`. Campaign 6 also compares KIELER's front-end warnings and infos (labels, unreachable states and
transitions, ...) with the engine's, by position: no difference in its 314 matches. Campaign 5's disagreements: a
method with a parameter and an empty body, which gcc rejects in KIELER's code (2, fixed: `empty-method`, probes
`structure/probe-empty-method-*`); a code block with a loop next to a concurrent update of the same variable, which
KIELER's dependency analysis sees through the call node (1, fixed: deps.ts innerAccesses, probes
`structure/probe-method-inner-*`; it also fixes conformance `structure/154`); a chart with seven superstates to cure,
whose other cure orders the search did not reach within its 24 analyses (1: now a `kieler-quirk` info; 6 of 12 KIELER
runs show the guide's behaviour; the search now tries every single change of one choice first). Campaign 6's: a
state with abort regions that can never be entered, on which KIELER's SimpleGuardTransformation throws (fixed:
`kieler-crash`, probes `preemption/probe-abort-region-dead-*`); one "The compiler failed during compilation setup."
that four reruns did not reproduce (they match the engine).

Campaign 1's disagreements: abort regions in states that cannot be reached were checked (5, fixed: KIELER's SCG
has no nodes for them); KIELER's equal-branch defect and Surface/Depth's clean-ups inside referenced charts (3,
fixed); a state with abort regions re-entered in the tick it finishes (1, now `unsupported`); two charts whose
behaviour depends on KIELER's cure order (confirmed: 1 of 6 and 5 of 6 KIELER runs differ; the engine says so with
the `kieler-quirk` info); one KIELER failure ("The compiler failed during compilation setup.") that six reruns did
not reproduce (an oracle hiccup after a JVM restart).

Campaign 3's disagreement: a count delay whose transition fired a tick late in KIELER, next to a referenced chart
whose region starts in a state without node. KIELER's dependency analysis stops at that region (above), so the
count delay's own regions were scheduled without dependencies (fixed: the engine walks the graph as KIELER does;
probes `structure/probe-reference-dependency-*`). Of the 3880 charts of the three campaigns, 2 meet such a region
and none such a transition. Hand-written variants (26 charts, all agreeing now) found three more cases around such
states: a single-region superstate whose region starts in one (KIELER's fork removal re-routes the flows into it to
nothing: accepted when only a thread's entry is left without target, otherwise ThreadAnalyzer throws), and a cycle
of two silent transitions (merged and dropped like a self-loop, not an instantaneous loop). Probes
`structure/probe-reference-silent-cycle`, `probe-reference-nodeless-*`.

The "nondeterministic" charts of the campaigns (13: eight whose verdict and five whose behaviour the engine flags
as depending on KIELER's cure order) were each run six more times in KIELER: every one of them varies from run to
run (verdicts from 1 of 6 to 4 of 6 rejecting; behaviours matching the guide's in 1 to 5 of 6 runs).

CS303 course charts (`/home/fallstop/Documents/projects/CS303`, run in the scratchpad only, never copied into the
repository): all 19 charts KIELER accepts, 3 random input sequences of 30 ticks each, agree with KIELER in every
tick (57 runs; the @ClocksUseSD charts after this round's support).

## Not yet (charts get the `unsupported` info and cannot be simulated)

User-written schedules (`schedule` declarations and `schedule s 1` clauses), `ode` actions, `extends` with bindings
or generic parameters and inner states that extend, chart instances in dataflow regions that call methods, dataflow
reference calls `A(x, y)`, recursive methods, @DeviationOutput and @Logical clocks, arrays of class instances and
classes inside classes, abort regions in a state that is left and entered again in the same tick (KIELER's thread
reincarnation guards). Never (no C compiler in the browser): host code (backticks), `extern` functions, host
classes and host enums; the info says "cannot run in the browser".

## Known differences

- KIELER's cure order (above): the guide shows one of the behaviours KIELER can show, and says so.
- B-34 (KIELER reorders tick-1 assignments around input reads) and B-35 (partial assignment evaluation): the
  guide computes the intended result and warns (`kieler-bug`) for B-34 patterns.
- The order of side effects follows KIELER's scheduler, but where KIELER builds a guard expression from a hash map
  (some synchronizers' empty-thread guards), the order of the dependencies it pulls in can change from run to run;
  the guide takes them in thread order.
- Host code: charts KIELER accepts are accepted (and not simulated); those gcc rejects (an extern function without
  its header, a function defined in `#hostcode`) are accepted too, since the simulator cannot know the C headers.

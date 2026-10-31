# Semantics: basics

How SCCharts behave in the first tick, with variables, plain transitions, final states and expressions,
as implemented by KIELER. Every rule below was established with the oracle (`tools/oracle/oracle.mjs`,
the sccharts-lite fork of the KIELER server, built from kieler/semantics 5f02d129) and checked against
the KIELER sources in `../kieler-server-fork/modules`. The conformance suite that pins each rule down is
`tests/conformance/basics/` (chart `NN-name.sctx`, scenario `NN-name.scenario.json`, recording
`NN-name.oracle.json`); `tests/conformance/basics/basics.test.ts` checks that the recordings still say
what this document says.

Unless stated otherwise, "KIELER" means the default simulation system
`de.cau.cs.kieler.sccharts.simulation.tts.netlist.c` (taken-transition signalling + netlist-based C code,
compiled with gcc and run as a separate process). Differences of the priority-based system
(`--system priority`) are noted where they exist; section 9 lists them all.

Source paths below are relative to `../kieler-server-fork/modules/`. Abbreviations:
`proc/` = `sccharts/src/de/cau/cs/kieler/sccharts/processors/`,
`val/` = `sccharts/src/de/cau/cs/kieler/sccharts/text/validation/SCTXValidator.xtend`,
`ccode/` = `scg/src/de/cau/cs/kieler/scg/processors/codegen/c/`,
`opt/` = `scg/src/de/cau/cs/kieler/scg/processors/optimizer/`,
`csim` = `simulation/src/de/cau/cs/kieler/simulation/processor/CSimulationTemplateGenerator.xtend`.

Each rule has: the statement; evidence (conformance chart and ticks); where KIELER implements it; a
teaching note (what beginners get wrong, the plain-English version); an implementation note for the
interpreter.

---

## 1. Ticks and the first tick

### B-1 What a tick is, as the simulator sees it

**Rule.** A tick (step) is: (1) the environment's new input values are written into the inputs;
(2) the chart reacts once, in zero logical time; (3) the whole data pool (inputs, outputs, locals) is
reported. The values the oracle reports for tick *n* are the values **after** reaction *n*. Tick 1 is
the first reaction; there is no observable "tick 0" in the recordings (the server's initial pool after
`reset()` is not recorded).

**Evidence.** Every recording; e.g. `01-first-tick` tick 1 already shows the effect of the immediate
transition (x = 1).

**Source.** `simulation/resources/c/templates/c-main.ftl` (main loop: `reset`, then per tick
`receiveVariables(); tick(); sendVariables(0);`), `csim` lines 106-196.

**Teaching note.** "Inputs in, reaction, outputs out. The numbers you see belong to the end of the tick."

**Implementation note.** `TickResult.values` must be the state after the reaction. Inputs that the
chart itself writes during the tick are reported with the written value (see B-10).

### B-2 Tick 1 enters the chart

**Rule.** In tick 1 the root state is entered: its variables are initialised (B-4..B-7), its entry
actions run, every region's initial state is entered (recursively for superstates), and then the
**immediate** behaviour runs: immediate transitions of the entered states are checked and taken in
the same tick, as are chains of them (B-14). Delayed transitions of states entered in tick 1 are not
checked in tick 1; the earliest tick they can fire is tick 2.

**Evidence.** `01-first-tick` t1 (immediate fires, x = 1; the delayed `if I` does not although I is
true), t2 (delayed fires). `02-delayed-waits` t1/t2. `03-immediate-chain` t1.

**Source.** The delayed/immediate split is made by Surface/Depth: `proc/SurfaceDepth.xtend` 227-303
(the surface of a state only contains its immediate transitions; a pause separates surface and depth).

**Teaching note.** Beginners expect `if I go to B` to fire in tick 1 when I is already true. It cannot:
a delayed transition never fires in the tick its source state is entered. "Tick 1 sets things up;
ordinary transitions start counting from tick 2."

**Implementation note.** Treat the root's entry like any state entry, with the root's own declarations
initialised first. After initialisation, perform the "entry closure" of the initial configuration.

---

## 2. Variables and initialisation

### B-3 Types and their run-time representation

**Rule.** The C simulation represents `int` as a 32-bit C `int`, `bool` as C `char`, `float` as C
`double`, `string` as `char*` (pointer). Consequences are spelled out in B-20..B-30.

**Source.** `ccode/CCodeSerializeHRExtensions.xtend` 97-107.

### B-4 Default values

**Rule.** A variable without an initialiser starts as: int 0, bool false, float 0.0, string null.
This holds for outputs and locals (KIELER inserts an implicit initialiser) and for inputs (the C
data struct is a zero-initialised global and inputs are never implicitly initialised). Null strings
are **omitted** from KIELER's data pool (the oracle shows no entry for them at all).

**Evidence.** `28-default-values` t1: I = 0, B = false, F = 0, x = 0, b = false, f = 0, localInt = 0,
localBool = false, localFloat = 0; S, s, localString absent.

**Source.** `proc/Initialization.xtend` 118-162 (`implicitInitialization`: only non-inputs, only names
not starting with `_`; `initialValue` per type: BOOL false, INT 0, FLOAT 0, STRING null). The pool
omission: `csim` 251 (`cJSON_CreateNull()` for a NULL string); the server's JSON (Gson) drops nulls.

**Teaching note.** "Everything starts at zero, false or empty." Strings are the exception that shows
up oddly in tools: an unset string is *missing*, not `""`.

**Implementation note.** Represent a null string as `null`; when comparing with recordings, a `null`
value corresponds to the key being absent.

### B-5 Initialisers run when their scope is entered, in declaration order, after inputs are read

**Rule.** `T x = e` assigns `e` to `x` each time the declaring scope (root, superstate) is entered.
Initialisers of one scope run in declaration order, before that state's own entry actions. `e` is
evaluated with the current values, so a root initialiser that reads an input sees the tick-1 input,
and an initialiser that reads a variable declared later sees that variable's *previous* value
(0 in tick 1). An initialiser is not a continuous definition: it is not re-evaluated in later ticks.

**Evidence.** `29-initialiser-reads-input` (y = I = 5 in tick 1; stays 5 when I becomes 7).
`30-initialiser-order` (`y = x + 1` declared before `x = 5`: y = 1, in both compilers).

**Source.** `proc/Initialization.xtend` 165-190 (each initialiser becomes an entry action inserted at
position 0, iterating the declarations in reverse so the final order is declaration order). The system
runs `entryAction` (weak), then `initialization`, then `entryAction` (strong):
`sccharts/system/de.cau.cs.kieler.sccharts.extended.kico`.

**Teaching note.** "An initial value is set when the state is entered, top to bottom." Don't make one
initialiser depend on a variable declared after it.

**Implementation note.** On entering a scope: for each declaration in order, for each valued object
with an initialiser (explicit or implicit default for non-inputs), assign; then run entry actions.
Netlist caveat: see B-34 for tick-1 reordering when inputs are involved.

### B-6 Locals are re-initialised on every entry of their scope

**Rule.** Every entry of a state, including re-entry by a self-loop and re-entry of a superstate,
re-initialises the variables declared in it: explicit initialisers and the implicit defaults of B-4
(a local without initialiser is reset to 0/false/null on every entry). A variable declared inside a
`region` belongs to the region's parent state: it is initialised when the parent is entered, not when
the region's initial state is entered again.

**Evidence.** `13-self-loop-reinitialises-locals` (x = c is 11 every tick: c = 10, then +1, on every
re-entry). `14-superstate-reinitialises-locals` t4/t5 (c, without initialiser, back to 0 on
re-entry). `70-region-local-initialised-once` t4 (seen = 12, c not reset when A is re-entered).

**Source.** `proc/Initialization.xtend` 165-190 (initialisation as entry action, so it runs on every
entry); region declarations are hoisted to the parent state by `regionactions`
(`proc/RegionActionsAndDeclarations.xtend`), which runs before `initialization`.

**Teaching note.** A counter declared inside a state that loops back to itself never counts past 1.
Declare it one level up if it must survive re-entry. "A state's variables are fresh every time you
enter it."

**Implementation note.** Model locals as storage owned by the scope; on entry, reset them. KIELER
lets a state's own outgoing transitions read its locals (the scope check in `val/` 942-958 tests the
wrong class, `AbstractDeclarativeValidator.State`, and never fires), so do not reject that.

### B-7 Inputs with initialisers

**Rule (netlist).** `input int I = 42` gives I the value 42 before the environment supplies anything.
If the environment supplies a value in tick 1, that value wins. **Priority** differs: there the
initialiser runs inside tick 1 after the inputs are read and overwrites the supplied value (which then
persists, B-9).

**Evidence.** `31-input-initial-value` (netlist: J = 3 supplied wins; I = 42, B = true kept).
`68-input-initial-value-priority` (priority: J = 42 overwrites the supplied 3).

**Source.** Netlist: the GO-init optimiser moves the constant assignment `I = 42` into `reset()`, which
runs before the first input is read (`opt/GOInitOptimizer.xtend` 82-151). Priority keeps it in `tick()`.

**Teaching note.** Avoid initialising inputs; give the environment the job. If you must, say it is "the
value used until the environment provides one" (default tools).

**Implementation note.** Follow the netlist behaviour: apply input initialisers before applying the
tick-1 inputs.

### B-8 const

**Rule.** `const` declarations are compile-time constants: every reference is replaced by the
initialiser (after constant folding), and the constant does not exist at run time (it is not in the
pool). Rules: a const needs an initialiser; it cannot be assigned; an array size must be an int
literal or a const whose initialiser is an int literal (a computed const such as `N * 2` is
accepted in expressions but rejected as a size); a const array can only be indexed by constant indices.

**Evidence.** `32-const` (N, M, T, H, ON absent from the pool; a has 3 elements; x = M + I = 7;
y = T[2] = 6). `33-const-assignment-rejected`, `34-const-needs-initialiser`,
`35-const-cardinality-literal`.

**Source.** `proc/Const.xtend` 92-180; `val/` 967-973 (assignment); 
`kexpressions/src/de/cau/cs/kieler/kexpressions/validation/KExpressionsValidator.xtend` 30;
`kexpressions/src/de/cau/cs/kieler/kexpressions/kext/validation/KExtValidator.xtend` 47.

**Messages.** `You cannot assign a value to a const object.` (plus a second error from the Const
processor: `Cannot replace left hand side of assignment by a value. (...)`);
`A const declaration must have an initialization part!`;
`Array cardinalities must be an int literal or a reference to a constant int object.`;
const array indexed by a variable: `Cannot insert const array element. ValuedObjectReferenceImpl@… I is
not a valid index (integer value).`

**Modifier order (version-dependent).** Current KIELER (and the lab server) parses `input` / `output`
before `const`: `output const int M = 4` (`75-const-after-input-output`), and rejects `const output int M`
with `mismatched input 'output' expecting 'primitive'` (`76-const-before-output-rejected`). Official KIELER
0.3.0 has the opposite order: it accepts `const output int M = 4` and rejects `output const int` with
`no viable alternative at input 'const'` (section 10.1). Both accept `const static int` and reject
`static const int`. Plain `const int N = 3` works everywhere.

**Teaching note.** "A const is a name for a number; it vanishes when the chart is compiled." Do not
combine `const` with `input` or `output` in the guide's charts: the two KIELER versions disagree.

**Implementation note.** Inline consts in the compiler; leave them out of `values` and `interface`.
Follow current KIELER's modifier order (`input`, `output`, `const`, `global`, `static`, from
`KExt.xtext` `VariableDeclarationWOSemicolon`).

---

## 3. Inputs in the simulator

### B-9 Inputs persist

**Rule.** An input keeps its value from the end of the previous tick unless the environment supplies
a new one. "Value at the end of the previous tick" includes writes the chart made to the input (B-10).
An input array given with fewer elements than declared updates only those leading elements.

**Evidence.** `36-inputs-persist` (I stays true, N stays 5 with empty input sets; only N changes in
t4). `58-input-array-partial` t3 (A = [4] gives [4, 2, 3]). `37-input-written-by-chart`.

**Source.** The server sends only inputs, taken from its pool, which keeps the last reported values:
`simulation/src/de/cau/cs/kieler/simulation/SimulationModelWrapper.xtend` 185-197 (`ONLY_INPUTS`,
default true). The C side only overwrites variables present in the message (`csim` 139-149) and
parses arrays element by element up to the message's length (`csim` 343-354).

**Teaching note.** "Inputs are switches, not buttons: they stay where you put them." Scenarios must say
when an input goes back to false. A pure input *signal* behaves the same in KIELER's simulator (the
signals spec covers presence).

**Implementation note.** `step(inputs)` merges the given inputs into the current input values; missing
keys keep their value. Arrays: element-wise prefix overwrite.

### B-10 A chart may write its inputs

**Rule.** Assignments to inputs are allowed; the written value is visible for the rest of the tick and
persists into later ticks until the environment supplies a new value, which overwrites it at the
start of that tick.

**Evidence.** `37-input-written-by-chart` (I = 1 → chart writes 11 → next tick reads 11 and writes 21;
supplying 7 in t4 gives seen = 7).

**Teaching note.** Legal, but confusing; recommend copying an input into a local instead.

---

## 4. Transitions

### B-11 Delayed and immediate transitions

**Rule.** A transition is *immediate* if it is written `immediate`, or its source is a connector state,
or it is a `join to` without trigger not marked `delayed`. Everything else is *delayed*: no keyword,
`delayed`, and `auto` all mean delayed. In the tick a state is entered (its *entry tick*), only its
immediate transitions are candidates. In every later tick in which the state is still active, **all**
its transitions are candidates, in priority order, immediate ones included (an immediate transition
whose trigger was false on entry fires as soon as its trigger holds later).

**Evidence.** `07-entry-tick-immediate-only` t1 (priority-1 delayed `if I` skipped although I is true;
immediate priority 2 fires). `08-priority-delayed-beats-immediate` t2 (both enabled in a later tick:
priority 1, the delayed one, wins). `04-delayed-then-immediate` t3 (C's immediate transition fires in a
later tick). `auto` and `delayed`: probe (`initial state A auto go to B; state B delayed go to C`
fires at t2 and t3).

**Source.** `sccharts/src/de/cau/cs/kieler/sccharts/extensions/SCChartsTransitionExtensions.xtend`
132-135 (`isImplicitlyImmediate`). `proc/SurfaceDepth.xtend` 227-235: every immediate transition is
copied to the front (highest priority, same relative order) for the surface, and the original is made
delayed, so the depth (later ticks) checks all transitions in their original order. Grammar:
`sccharts/src/de/cau/cs/kieler/sccharts/text/SCTX.xtext` 106, 439-440 (`undefined | delayed |
immediate | auto`).

**Teaching note.** The keyword is about the *entry tick only*. "Immediate: may also fire in the tick the
state is entered. Delayed: waits at least one tick." Priority still rules in later ticks.

**Implementation note.** For an active state S in a tick: if S was entered in this tick, candidates are
S's immediate transitions in priority order; otherwise all of S's transitions in priority order.

### B-12 Priority: the first enabled transition wins

**Rule.** A state's outgoing transitions have priorities 1, 2, ... in the order written. Among the
candidates (B-11), the first whose trigger holds (or that has no trigger) is taken; at most one
transition leaves a state per visit, and only the taken transition's effects run. Triggers are
evaluated lazily in priority order, each with the current values at that moment.

**Evidence.** `06-priority-first-wins` (I and J and the untriggered default all enabled: x = 1;
then J only: x = 2; then neither: default, x = 3).

**Source.** `proc/SurfaceDepth.xtend` 243-303 (chain of conditional states in priority order).

**Teaching note.** "Top to bottom; the first that matches wins; the rest are ignored." An untriggered
transition placed first hides all later ones.

**Implementation note.** Evaluate candidate triggers in order and stop at the first true one. Do not
evaluate later triggers (they may have side effects only in pathological host code, but the order
matters for the trace log).

### B-13 Transitions without trigger; unreachable transitions

**Rule.** A delayed transition without trigger fires in the first tick after the entry tick, always.
An immediate transition without trigger fires in the entry tick, always. The validator warns
`The transition is not reachable.` for: any transition after an immediate untriggered (non-`join`)
transition; any delayed transition after an untriggered delayed transition. An immediate transition
after an untriggered **delayed** transition is reachable (it is a candidate in the entry tick) and is
not flagged.

**Evidence.** `09-no-trigger` (warning on line 7; x = 1 at t2, x = 2 at t3; the `if I` transition never
fires). `10-immediate-after-untriggered-delayed` (immediate priority 2 fires in tick 1, x = 2).
`03-immediate-chain` t2 (D's untriggered delayed transition).

**Source.** `val/` 699-722 (`checkTransitionsAreReachable`, a warning).

**Teaching note.** `go to B` with nothing else means "next tick". Put it last.

### B-14 Chains of immediate transitions within one tick

**Rule.** Entering a state (by any transition, in any tick) makes it a state in its entry tick, so its
immediate transitions are checked at once; a reaction keeps following immediate transitions until it
reaches a state where no candidate is enabled. In particular a delayed transition taken in tick *n*
enters its target in tick *n*, and the target's immediate transitions may fire in tick *n*. A state
entered again within the same tick (via a cycle that contains a delayed transition) is again in its
entry tick, so the delayed transition does not fire twice in one tick.

**Evidence.** `03-immediate-chain` t1 (A → B → C → D in tick 1). `04-delayed-then-immediate` t2 (delayed
A → B, then immediate B → C, stop at C because J is false). `05-cycle-with-one-delay` t2/t3 (B → C → A → B
each tick, each transition once: taken = [1, 1, 1]). `16-trigger-sees-earlier-effects` (trigger reads a
value written earlier in the chain).

**Teaching note.** "Immediate transitions are like falling through trapdoors: you keep going until you
land on a floor (a state with nothing enabled)."

**Implementation note.** Implement as a work loop per region: current state S, `entered` flag. While a
candidate fires: run exit, effects, enter target (initialisers, then entry actions), set `entered = true`,
continue with the target. Because KIELER rejects every immediate cycle (B-17), the loop is finite for
accepted charts; still guard it (e.g. a step limit) and report a runtime error rather than hang.

### B-15 Self-loops are a full exit and re-entry

**Rule.** A transition from S to S leaves S and enters it again: S's exit actions run, the effects run,
then S is entered anew (locals re-initialised, B-6; entry actions run; inner regions restart at their
initial states). A delayed self-loop without trigger therefore fires in every tick from tick 2 on.

**Evidence.** `11-self-loop-every-tick` (x = 0, 1, 2, 3). `12-self-loop-reenters` (entries = 1, 2, 3,
4: entry action on every re-entry). `13-self-loop-reinitialises-locals`.
`72-self-loop-exit-effect-entry` (order exit, effect, entry: log = 3, 3123, 3123123; same in priority).

**Source.** No special case in KIELER: a self-loop is an ordinary transition whose target is its
source; entry actions are placed inside the state (`proc/Entry.xtend` 98-158).

**Teaching note.** A self-loop is not "stay here"; it is "leave and come back". Use a during action to
act while staying.

**Implementation note.** No special casing; the state's `entered` flag becomes true again.

### B-16 Effect lists run left to right, each seeing the previous writes

**Rule.** The effects of a transition (`do e1; e2; ...`) run in written order; each effect sees the
writes of the effects before it (and of everything that ran earlier in the tick). There is no
simultaneous assignment.

**Evidence.** `15-effects-sequential` (`x = 1; y = x; x = 5; z = x + y`: x = 5, y = 1, z = 6).

**Source.** `proc/TriggerEffect.xtend` 80-101: a transition with several effects is split into a chain
of immediate transitions through fresh connector-like states, one effect each, in order.

**Teaching note.** "Effects are a little program, run top to bottom." (Contrast: concurrent regions,
where the order between regions is decided by the scheduler; see the causality spec.)

**Implementation note.** Execute effects sequentially against the live store. KIELER warns about
`x = x + 1`-style assignments (B-31); within one region this changes nothing.

### B-17 Instantaneous loops are rejected

**Rule (netlist).** A chart is rejected if its states can be connected in a cycle that a single tick
could traverse without passing a pause: any cycle made only of immediate transitions (including
immediate self-loops, cycles through several states, cycles leaving a superstate by an immediate abort
while its inner states pause, and cycles closed by an untriggered `join to` whose inner region
terminates immediately). The check is structural: triggers are not considered, so mutually exclusive
guards (`if I` / `if !I`), bounded counters (`if x < 3`) and a single guard on the cycle do not help.
A cycle that contains at least one delayed transition is fine (B-14).

**Evidence.** Rejected: `17-loop-unconditional`, `18-loop-self`, `19-loop-guarded`,
`20-loop-bounded-counter`, `21-loop-three-states`, `22-loop-through-superstate`,
`74-loop-through-join-immediate` (inner path to the final state is immediate, so A can terminate in its
entry tick; rejected without any validator warning, because the validator ignores termination
transitions); probe: `initial state A { initial final state A1 } join to B; state B immediate do x++ go
to A` (rejected the same way). Accepted: `05-cycle-with-one-delay`; `73-loop-through-join-with-pause`
(same shape as 74 but A1 -> A2 is delayed: fires once per tick, x = 1, 2, 3); probe: a delayed weak
abort `if I go to B` out of a superstate closing the cycle (accepted).

**Messages (oracle).** Errors, from the netlist guard scheduler:
`Can't schedule from <guard> to <guard>` (one or more, e.g. `Can't schedule from _g1 to _g1`), then
`The SCG is NOT asc-schedulable!`; the fork adds `Circular dependency prevents scheduling this tick.`
(or `Circular dependency involving <names> prevents scheduling this tick.`) with the hint "Give the
shared state one owner, or read the previous tick's value with pre()". Warnings: the fork's
`Potential instantaneous loop.` (official KIELER's text: `Instantaneous loop detected!`). The validator
adds a warning diagnostic on each transition of the cycle:
`There is an immediate loop. The model is not SASC.\nInvolved states: [B, A]` (state order is a hash
order, not stable). For `errorIncludes` use `NOT asc-schedulable` or `Can't schedule`, which official
KIELER prints too.

**Source.** `scg/src/de/cau/cs/kieler/scg/processors/SimpleGuardScheduler.xtend` 98-104, 140-150;
`scg/src/de/cau/cs/kieler/scg/diagnostics/Scheduling.java` 54 and `Loops.java` 59 (fork wording);
loop analyser `scg/src/de/cau/cs/kieler/scg/processors/analyzer/LoopAnalyzerV2.xtend`; validator
`val/` 503-560 (`checkNoImmediateLoops`, warning only, ignores `join` transitions).

**Priority compiler.** Accepts all of these. It generates a `goto` loop, so a loop whose guards
eventually fail runs and finishes within the tick (`71-loop-bounded-counter-priority`: x = 3 and the
self-loop's taken count is 3 in tick 1), and a loop that never ends makes the tick never return: the
simulation stops answering and the oracle repeats the last values.

**Teaching note.** "A tick must end. If a chain of immediate transitions can come back to where it
started, the compiler refuses the chart, even if you know the guards prevent it." Fix: make one
transition on the cycle delayed. Beginners write `immediate if x < 3 do x++ go to A` to loop; explain
that loops across ticks need a delayed transition.

**Implementation note.** Static check: per control-flow region (and across hierarchy for aborts and
terminations), find cycles in the graph of implicitly immediate transitions; for a superstate
source, an immediate weak/strong abort counts as an immediate edge regardless of inner pauses; an
untriggered `join to` counts as immediate when its inner regions can terminate in their entry tick.
Report with code `instantaneous-loop`, quoting KIELER's messages.

---

## 5. Final states and termination

### B-18 Root termination

**Rule.** The root terminates in the tick in which all of its regions are in final states at the end
of the reaction. From then on the chart does nothing: no transition fires, no action runs, values keep
their last values. KIELER's `_TERM` flag (the oracle's `terminated`) is true **only in the tick of
termination**; it is false in every later tick. The effects of the transition into the final state run
normally in the termination tick. Termination can happen in tick 1.

**Evidence.** `23-root-final-terminates` (t2 x = 1 and terminated = true; t3, t4 terminated = false,
nothing changes although I changes). `24-terminate-in-tick-one` (terminated = true in t1).

**Source.** Netlist: `_TERM` is computed per tick in `logic()` from the final-state guards and reset at
the next tick (observable in generated C, e.g. `d->_TERM = (d->_g6 && d->_cg1) || ...`). The priority
system does not put `_TERM` in the pool at all (`terminated` is undefined in its recordings).

**Teaching note.** "Reaching a final state at the top level ends the program." In the tools the end is
a single event, not a lasting state.

**Implementation note.** `TickResult.terminated` should be true in the termination tick only, to match
the recordings; keep a separate sticky "dead" flag so later steps do nothing (and the UI can say
"terminated in tick n").

### B-19 Final states with outgoing transitions

**Rule.** A final state may have outgoing transitions. (a) If entering it makes the root's regions all
final, the root terminates in that tick and the final state's delayed transitions never fire.
(b) If the final state has an immediate transition that is enabled on entry, it is taken in the same
tick, so the region is not final at the end of the tick and nothing terminates. (c) While the parent
keeps running (for example a concurrent region never finishes), a final state's outgoing transitions
behave like any state's.

**Evidence.** (a) `25-root-final-with-outgoing` (terminated in t2; B's delayed transition never fires,
x stays 0). (b) `26-final-with-immediate-outgoing` (x = 5, terminated false). (c)
`27-final-outgoing-in-running-parent` (B → A fires at t3 and t5; KIELER warns
`All or none concurrent regions should have final states.`).

**Source.** `proc/ComplexFinalState.xtend` (final states with outgoing transitions get a `_CFSterm`
flag); `val/` around 830-850 (`REGION_CANNOT_TERMINATE` warning).

**Teaching note.** "Final" means "this region may now count as finished", not "stop here for ever".

---

## 6. Expressions (C semantics, with KIELER's twists)

### B-20 Integer arithmetic

**Rule.** int arithmetic is 32-bit two's complement and wraps on overflow (gcc's behaviour; gcc warns
`integer overflow in expression` for constant overflow). `/` truncates towards zero; `%` has the sign
of the dividend: 7 / 2 = 3, -7 / 2 = -3, 7 / -2 = -3, -7 / -2 = 3; -7 % 2 = -1, 7 % -2 = 1,
-7 % -2 = -1. `int / int` is integer division even when the result is stored in a float. Int literals
above 2147483647 are rejected at parse time (`For input string: "3000000000"`); there are no hex or
octal literals.

**Evidence.** `38-int-division`, `39-int-overflow` (2147483647 + 1 = -2147483648; × 2 = -2;
-(-2147483648) = -2147483648).

**Division by zero** is not checked: the C simulation process dies of SIGFPE in that tick. KIELER's
server does not report an error; it keeps reporting the previous pool for every later step (values
frozen, `taken` all 0). Probe: `do x = A / B go to T` with B = 0. A division by zero that is never
evaluated (short-circuit, B-24) is harmless. Not in the suite (the engine should raise a runtime error
instead: `TickResult.error`).

**Teaching note.** "int means a C int: whole numbers, division rounds towards zero, and very large
numbers wrap round."

**Implementation note.** Use `Math.trunc` for `/` and JS `%` (same sign rule) on int operands, then
`| 0`; multiplication with `Math.imul`; `+`/`-` then `| 0`. Division by zero (and `-2147483648 / -1`,
which also traps on x86): stop with a runtime error.

### B-21 Floats: double arithmetic, single-precision literals

**Rule.** float variables and arithmetic are C doubles, but **every float literal is rounded to single
precision** before it reaches the C code: `0.1` becomes 0.10000000149011612, `0.2` becomes
0.20000000298023224, `7.9` becomes 7.900000095367432; literals exact in single precision (2.5, 1500,
0.5) are unchanged. Float inputs from the environment keep full double precision. So an input 0.1 is
not equal to the literal 0.1. A float stored into an int is truncated towards zero (`(int)(e)`):
7.9 → 7, -7.9 → -7. Float literal syntax: `1.5`, `1.`, `1.5e3`, `1.5f`, `2f`; `1e3` (no dot) is a
parse error.

**Evidence.** `40-float-literals` (a = 0.10000000149011612, d = F + 0.2 = 0.3000000029802322,
c = 1.0 / 3 = 0.3333333333333333, i = 7, j = -7, k = 3). `41-float-comparison` (F == 0.1 false,
lit == 0.1 true, F < 0.1 true for the input 0.1).

**Source.** Casts: `ccode/CCodeSerializeHRExtensions.xtend` 242-255. Literal grammar:
`annotations/src/de/cau/cs/kieler/annotations/Annotations.xtext` 201-204. The single-precision
rounding is observed in the generated C (e.g. `d->a = 0.10000000149011612 + 0.20000000298023224;`);
where in the pipeline the literal passes through a Java `float` was not pinned down (the FLOAT value
converter itself uses `Double.valueOf`).

**Teaching note.** Never test floats with `==`. And note that writing `0.1` in a chart gives a slightly
different number from typing 0.1 into the simulator's input box.

**Implementation note.** Parse a float literal `v` as `Math.fround(v)`; do all arithmetic in JS
doubles; assigning a float to an int variable: `Math.trunc` then wrap to int32. Reported values are JS
numbers; cJSON prints with up to 17 significant digits, which round-trips.

### B-22 Float triggers need a comparison; ints can be triggers

**Rule.** A trigger (or action trigger) that is a bare float variable is rejected:
`Float tests must have a comparison operator!`. A bare int is accepted and means "not zero".

KIELER's netlist code computes the condition of every conditional of the graph in every tick, at its place
in the schedule, whether control reaches it or not, into a `char` guard variable `_c<g> = <condition>`
(SimpleGuardExpressions). Consequences: a `random()` or a C function call in the trigger of a state that is
not active still runs in every tick (it takes values of the random sequence, its side effects happen); a
division by zero there kills the simulation although the state is never entered; an int-valued condition is
truncated to `char` (`if (c) ? n` with n = 256 does not hold). Copy propagation drops the guard variable
for a plain reference to an input the chart never writes, so `if n` with the input n = 256 holds. A state
that can never be entered has no code (its trigger never runs).

**Evidence.** `42-float-trigger-rejected`, `43-int-as-trigger` (I = -3 and 2 enable it, 0 does not).
Probes `kieler/rare/probe-trigger-*` (random sequence, a C function's counter, a division by zero in tick 1,
256 as an input trigger, a state that is never entered); the generated C code (dumped): `d->_cg6 =
((float) rand() / RAND_MAX) > 2.0;` before `d->_g7 = d->_g6 && d->_cg6;`.

**Defect.** When the sequentializer writes such a guard, an array element whose index contains a variable loses
the whole index if no plain variable (one without indices, not inside an index) comes before it in the condition
(pre-order) and one comes after it: `ov[n] > 0 && a` becomes `d->ov > 0 && d->a`, `ok[n] && y > 0` becomes
`d->ok && d->y > 0`, `ov[n] + y > 1` and `ov[n] == y` lose it too, while `a && ov[n] > 0`, `y == ov[n]`, `ov[n] > 0
&& ov[1] < 3`, literal indices (`ok[1] && a`, a for-region copy's `key[i]`) and assignments keep theirs. The C code
then tests the array's address, which is never 0 (so `> 0`, `!= 7`, `+ 1 > 100` hold and `== 0`, `< 3`, `!` do not);
gcc rejects other arithmetic with it and comparisons with a double (`invalid operands to binary * (have ‘int *’ and
‘int’)`, `... binary > (have ‘double *’ and ‘double’)`). Official KIELER 0.3.0 does the same. Probes
`kieler/rare/probe-index-dropped-*`, `probe-index-kept-*`; the SCG before the sequentializer still has the index
(dumped). The engine reproduces it (sim/guardIndices.ts) with a `kieler-quirk` warning.

**Source.** `scg/.../processors/SimpleGuardExpressions.xtend:164-186` (a guard `_c<g>` per conditional),
`scg/.../processors/optimizer/CopyPropagationV2.xtend:126-140` (propagated only for unmodified inputs),
`scg/.../processors/SimpleGuardSequentializer.xtend` (where the index disappears).

**Source.** `val/` 1205-1214.

### B-23 bool and int mix with C rules; bools are chars

**Rule.** There is no type checking between bool and int. true/false are 1/0 in arithmetic
(`true + 1 = 2`); `&&`, `||`, `!` and comparisons yield 0/1; an int stored in a bool keeps its char
value: 5 is shown as true but reads back as 5 (`x = b` gives 5, `b + b` gives 10); values are
converted to C `char`, so 256 becomes 0 (false; gcc warns
`overflow in conversion from ‘int’ to ‘char’ changes value from ‘256’ to ‘0’`), 300 becomes 44 (true),
-1 stays -1 (true), and 0.5 becomes 0 (false). Reported bools are `char != 0`.

**Evidence.** `44-bool-int-mixing`. Probe: `b4 = 300` → true; `b2 = -1; x2 = b2` → x2 = -1.

**Teaching note.** Keep bools for conditions. "A bool is really a small number; don't do sums with it."

**Implementation note.** Store bool variables as signed 8-bit integers (`(v << 24) >> 24` after
truncating floats); report `!= 0`. Comparisons and logical operators produce 1/0 ints.

### B-24 Operators, precedence and parsing traps

**Rule.** Precedence, from loosest to tightest (from the grammar):
`||` < `&&` < `|` < `^` < `&` < comparisons (`== != < <= > >=`, **non-associative**: `1 < 2 < 3` is a
parse error) < `<< >> >>>` < `+ -` < `* / %` < unary `-` < ternary `c ? a : b` (the dataflow operators `->`, `fby`, `sfby`
are the alternative at the same level) < atoms. Two KIELER-specific traps:

1. The ternary binds tighter than every binary operator and its three parts must each be atomic (a
   literal, a name, a call, `pre`/`val`, or a parenthesised expression): `A > 2 ? A : 0` means
   `A > (2 ? A : 0)`; `B ? 10 : 20 + 1` means `(B ? 10 : 20) + 1`; `2 * B ? 3 : 4` means
   `2 * (B ? 3 : 4)`; `-B ? 1 : 2` means `-(B ? 1 : 2)`; `A == 5 ? 1 : 2` means `A == (5 ? 1 : 2)`.
   Parse errors (`no viable alternative at input '?'` or `':'`): `A ? 1 + 2 : 3`, `B ? -1 : 2`,
   `B ? 1 : -2` (a negative literal is not atomic; write `(-1)`), `!B ? 1 : 2` (write `(!B) ? 1 : 2`).
   The else part is optional, and KIELER's C code fills it in with the target of the assignment it is in:
   `x = c ? e` keeps x when c is false (`x = c ? e : x`), also nested (`x = 1 + (c ? 2)` is `x = 1 + (c ? 2 : x)`)
   and with compound operators (`x += c ? 1` doubles x). In a trigger the target is the condition's guard
   variable (B-22), so a false `c` keeps the trigger's previous result (false until `c` first holds), also while
   the state is not active; a suspend trigger is an assignment to the suspend flag, which is true at that point,
   so a false `c` suspends. Where there is no assignment (an argument of `print`, of a call that is a whole effect,
   an assigned element's index, the conditions and returns of a method compiled as a C function) the placeholder
   reaches gcc: `‘__CONDSELF__’ undeclared (first use in this function)`. Probes `kieler/rare/probe-cond-noelse-*`.
2. `!` and `~` are only allowed as a whole operand of a comparison or a logical/bitwise operator, and
   apply to an atom: `!A == 0` is `(!A) == 0`; `~A + 1` and `!A + 1` and `1 + ~A` are parse errors;
   write `(~A) + 1`.

`&&` and `||` short-circuit (C). `&` binds weaker than `==` (as in C): `A & 3 == 2` is `A & (3 == 2)`
(gcc warns `suggest parentheses around comparison in operand of ‘&’`).

**Evidence.** `47-ternary`, `48-ternary-binds-tight` (y = 0 for every A), `49-logic-short-circuit`
(s = true with Z = 0 not evaluated; t = (!A) == 0). Parse errors: probes (`no viable alternative at
input '+'`, `no viable alternative at input '<'`, `no viable alternative at input ':'`).

**Source.** `kexpressions/src/de/cau/cs/kieler/kexpressions/KExpressions.xtext` 71-300 (TernaryOperation
276-279 takes `AtomicValuedExpression`s; `NotOrValuedExpression` 138-155; `CompareOperation` 130-135
allows at most one comparison operator); serialiser precedence `kexpressions/.../extensions/KExpressionsSerializeHRExtensions.xtend`
196-222; conditional placeholder `ccode/CCodeSerializeHRExtensions.xtend` 75, 227.

**Quirk.** `x = - -x` is written to C as `--d->x`, a pre-decrement (gcc warns
`operation on ‘d->x’ may be undefined`). Probe result: x = -I, then `- -x` gives x - 1. Don't teach it;
the engine should evaluate it as double negation and may warn.

**Teaching note.** Parenthesise every ternary condition: `(A > 2) ? A : 0`.

**Implementation note.** The parser must reproduce these precedences exactly (owned by the parser
workstream). Evaluate `&&`/`||` lazily.

### B-25 Bitwise operators and shifts

**Rule.** `& | ^ ~ << >>` are C operators on 32-bit ints; `>>` on a negative int is an arithmetic shift
(-12 >> 1 = -6). `>>>` and `>>>=` parse, but the C back end copies them into C, which has no such
operator: gcc fails (`expected expression before ‘>’ token` / `expected expression before ‘>=’ token`)
and KIELER reports `Compiler did not return success (exit value != 0)\nEither the source code cannot
be compiled or the gcc command is not available on PATH. ...`.

**Evidence.** `45-bitwise-and-shifts`, `46-unsigned-shift-rejected`.

**Source.** `kexpressions/.../extensions/KExpressionsSerializeHRExtensions.xtend` 318-324.

**Implementation note.** `<<`: `(a << (b & 31)) | 0`; `>>`: `a >> b`; reject `>>>` with KIELER's message
(as a compile error, since KIELER rejects the chart).

### B-26 Strings compare by pointer

**Rule.** Strings are C `char*`. `==`/`!=` compare pointers, not text (gcc warns
`comparison with string literal results in unspecified behavior`). Observed (gcc merges identical
literals): a literal equals an identical literal (`"x" == "x"` true) and a variable that was assigned
from an identical literal equals it (`t = "hi"`; `t == "hi"` true); a string received from the
environment never equals a literal, whatever its text (`S == "hi"` false for S = "hi"). `s == null` is
true for an unset string. There is no concatenation: `t + "b"` fails in gcc
(`invalid operands to binary + (have ‘char *’ and ‘char *’)`). Assignment copies the pointer.

**Evidence.** `59-strings`, `60-string-concat-rejected`.

**Teaching note.** Don't compare strings in SCCharts; KIELER's C back end can't do it. Use an int or an
enum-like set of constants.

**Implementation note.** Model a string value as `{ text, origin }` where origin is a literal id (same
for identical literal text) or a fresh id per environment value; `==` compares origins; null equals
null. Warn on any string comparison.

### B-27 Assignment operators, ++ and --

**Rule.** `= += -= *= /= %= &= |= ^= <<= >>=` behave as in C. `x min= e` stores the smaller and
`x max= e` the larger of x and e (`x = (x < e) ? x : e`). `x++` and `x--` exist only as effects (not
inside expressions: `x = I++` is a parse error); on a float they add/subtract 1.0. `>>>=` is rejected
by gcc (B-25). **Twist:** with an int target and a float right-hand side, KIELER truncates the
right-hand side *before* applying a compound operator: `x *= 1.5` is `x *= (int)(1.5)`, i.e. `x *= 1`.
A plain `x = x * 1.5` truncates the product instead.

**Evidence.** `50-assignment-operators`, `51-min-max-assign`, `52-compound-assign-float-to-int` (x
stays 7; y = 7 * 1.5 → 10; f++ → 2.5).

**Source.** `ccode/CCodeSerializeHRExtensions.xtend` 196-255 (min/max 217-222; cast of the right-hand
side 251-252).

**Implementation note.** For compound operators on an int target: `rhs = isFloat(rhs) ? trunc(rhs) :
rhs`, then apply, then wrap to int32.

### B-28 Arrays and vector assignment

**Rule.** `T a[n]` / `T a[n][m]` declare arrays (size: int literal or literal-valued const, B-8).
Elements default to the type's default. A vector initialiser may be shorter than the array (the rest
is zero) but not longer (`Cardinalities do not match. arr at dimension 0 is an array of size 2 but a
vector of size 3 is given.`). A vector assignment `a = {e0, e1, ...}` is expanded into element
assignments `a[0] = e0; a[1] = e1; ...` executed **in index order**, each seeing the previous ones, so
`arr = {arr[1], arr[2], arr[0]}` does not rotate; a shorter vector assigns only the leading elements.
The ignore value `_` (documented by the KIELER wiki) is broken in this KIELER: in a vector
assignment it reaches the C code (`‘_’ undeclared (first use in this function)`), and `_` standing for
a whole row is rejected earlier (`Cardinalities do not match. m at dimension 1 is an array of size 2
but only a single value is given.`). Whole-array assignment (`b = a`) and scalar-to-array assignment
(`arr = 5`) fail in gcc (`assignment to expression with array type`). Indices are not range-checked:
an out-of-range index reads or writes neighbouring memory of the C struct, and that struct's layout is
deterministic: the chart's own top-level declarations in the order written (constants and signals left out:
Const removes the constants, the Signal processor declares the signals anew at the end), then
`int _taken_transitions[n]`, then everything KIELER generates, with gcc's x86-64 layout (bool = `char`, int 4
bytes, float = `double` 8, string = pointer 8, each aligned to its size, padding between). So `a[3]` of
`int a[3]` is the int declared after it, `a[-1]` the one before, `m[0][3]` of `int m[2][3]` is `m[1][0]` (C
computes one address), an int written over two bools sets both bytewise, and padding keeps what is written
there. `{0 to 3}` is a range vector: [0, 1, 2, 3].

**Evidence.** `53-arrays`, `54-vector-assign-sequential` ([1,2,3] → [2,3,2] → [3,2,3]),
`55-vector-ignore-rejected`, `56-vector-shape-mismatch`, `57-array-copy-rejected`,
`58-input-array-partial`. The wiki's own example (`arr = {{arr[0] + 1, _}, _, {arr[2] + 1, _}}`) is
rejected with the cardinality message.

**Source.** `proc/ArrayAssignment.xtend` (expansion); `ccode/CCodeSerializeHRExtensions.xtend` (indices
serialised verbatim).

**Teaching note.** Vector assignment is shorthand for element-by-element assignment, top to bottom.
Don't use `_`.

**Implementation note.** Expand vector assignments to sequential element writes. Out-of-range access:
the engine lays out the known part of the struct (sim/memory.ts) and reads or writes there, byte by byte
where the types differ, with a warning for constant indices and a log note for each write; an access into
the taken counters or past them, or a partial pointer, is a runtime error (the guide cannot predict what
KIELER's generated variables hold). Probes `kieler/rare/probe-overflow-*` (15 layouts, all agreeing).
Reject `_` in vectors with the gcc-style message to match KIELER's rejection.

### B-29 random() and randomize()

**Rule.** `random()` is `((float) rand() / RAND_MAX)`: glibc `rand()`, converted to single precision,
divided in single precision by RAND_MAX (2147483647, which is 2^31 as a float); range [0, 1]. The
simulation never seeds the generator, so the sequence is the same on every run: glibc's default
sequence 1804289383, 846930886, 1681692777, 1714636915, 1957747793, 424238335, ... Each evaluation
consumes one number, in execution order. `random() * 100` stored in an int truncates. `randomize()`
(an effect) seeds with `srand(time(NULL))`, making runs irreproducible; inside the tick-1 block of the
netlist compiler it even breaks compilation (`‘null’ undeclared`: B-34's code motion into `reset()`
serialises the call as `null`). Elsewhere it compiles if gcc sees `srand`: current KIELER adds
`#include <stdlib.h>` only for `random()`, so a chart that calls `randomize()` but never `random()` fails
with `implicit declaration of function ‘srand’` (`77-randomize-needs-stdlib`) unless it has
`#hostcode "#include <stdlib.h>"` (`structure/99-randomize-after-tick-1`; structure.md S-50).
**Version-dependent:** official KIELER 0.3.0 adds no include at all, so there `random()` itself only
compiles with `#hostcode "#include <stdlib.h>"` (section 10.1).

**Evidence.** `61-random` (r = 0.8401877284049988 with percent = 39; then 0.7830992341041565 / 79;
0.911647379398346 / 19); `77-randomize-needs-stdlib`. Probes for randomize() and for official KIELER.

**Source.** `ccode/CCodeSerializeHRExtensions.xtend` 350-373 (`random()` adds `<stdlib.h>`,
`randomize()` adds `<time.h>`).

**Implementation note.** To match recordings, implement glibc's default `rand()` (TYPE_3, seed 1):
`r[0] = 1`; `r[i] = (16807 * r[i-1]) % 2147483647` for i = 1..30 (Schrage's method, add 2147483647 when
negative); `r[i] = r[i-31]` for i = 31..33; `r[i] = (r[i-31] + r[i-3]) mod 2^32` for i ≥ 34; the k-th
call returns `r[k + 343] >>> 1` (k = 1, 2, ...). Then `random()` = `Math.fround(Math.fround(n) /
2147483648)`; `random() * 100` is computed in single precision too (`Math.fround(r * 100)`) before an int
target truncates it. Verified in Node: 1804289383 → 0.8401877284049988, 846930886 → 0.39438292384147644
(× 100 → 39), 1681692777 → 0.7830992341041565.

### B-30 print()

**Rule.** `print(a, b, ...)` becomes one C `printf` whose format has one conversion per argument,
joined by single spaces: int `%d`, bool `%x` (so true prints `1`), float `%f` (`1.500000`), string
`%s`; a string literal argument is printed with `%s`, never used as a format string
(`print("x=%d!", x)` prints `x=%d! 3`). No newline is added. The text goes to the simulation process's
stdout, mixed into the line that carries the JSON pool; KIELER's server strips it off and writes it to
its own stdout and `simulationPrintOutput` list. Neither the oracle nor the KIELER language-server
clients receive it (it is in no notification and not on stderr), so recordings never contain print
output. In the netlist compiler a `print` in the tick-1 block runs in `reset()`, before tick 1.

**Evidence.** Probes: generated code `printf("%s %d %x %f %s", "vals", d->x, d->b, d->f, d->s);`,
executable output `vals 3 1 1.500000 str3x=%d! 3{"b":true,...}`.

**Source.** `ccode/CCodeSerializeHRExtensions.xtend` 267-309;
`simulation/src/de/cau/cs/kieler/simulation/SimulationModelWrapper.xtend` 230-270.

**Implementation note.** Put printed text into `TickResult.printed` (one entry per print call),
formatted like printf above.

### B-31 Relative-write warning

**Rule.** An assignment `x = ... x ...` that reads its own target as an operand gets a warning. Official
KIELER: `This assignment looks like old relative write SC syntax and is considered deprecated.\nIf you
want to create a relative write in new syntax, please use an infix assignment operator.` The fork,
when x is read exactly once, explains instead: `This assignment reads x, so the compiler treats it as an
update of x (a relative write, as in the deprecated old SC syntax).\nWrite it as x += 1 to say so. In
one region it means the same.\n...`. Within one region it has no effect on behaviour.

**Evidence.** Diagnostics in `52-compound-assign-float-to-int`, `53-arrays`.

**Source.** `val/` 1218-1252.

---

## 7. The taken-transition counters (`taken`)

### B-32 Index order of `_taken_transitions`

**Rule.** The simulation systems run the Taken Transition Signaling processor first, on the source
model. It numbers every transition of the **first** root state in this order: a pre-order walk of the
state tree, starting below the root; for each state, first its own outgoing transitions in priority
order, then all states nested inside it (its regions in source order, each region's states in source
order, recursively), then the next sibling state. Each transition gets the effect
`_taken_transitions[i] += 1` appended, and the root gets an entry action zeroing the array, so the
array counts cumulatively; the oracle's `taken` is the per-tick difference. Consequences: transitions
created by later transformations are not counted; transitions of referenced charts (`state S is
Other`) are not counted (reference expansion runs later); copies made by later expansion (for example
`for` regions) increment the same index; a chart without transitions has no array (`taken` is
undefined). In the priority compiler a transition can count more than once per tick (B-17).

**Evidence.** `62-taken-transition-order` (order P→Q(c), P→Q(f), X1→X2, Y1→Y2, Q→P, U→V);
`14-superstate-reinitialises-locals` (S's transition index 0, the inner one 1, T's 2);
`06-priority-first-wins` (A's three, then B, C, D). Reference: probe (`state C is Inner(...)`; join
gives taken = [1]; Inner's transitions absent).

**Source.** `proc/TakenTransitionSignaling.xtend` 53-60 (collect), 77 (`model.rootStates.head`),
85-111 (array, reset as root entry action because `USE_VALUE_CHANGE_SIGNALING` is true), 119-132
(indices); `sccharts/src/de/cau/cs/kieler/sccharts/iterators/StateIterator.xtend` 86-96 (EMF
`AbstractTreeIterator`, pre-order, root excluded); system file
`sccharts/system/de.cau.cs.kieler.sccharts.simulation.tts.netlist.c.kico`.

**Implementation note.** Number transitions by this walk at compile time; `TickResult.taken` lists ids
in firing order, so the comparison converts ids to indices and counts.

### B-33 Which chart is simulated

**Rule.** When a file contains several `scchart` definitions, KIELER compiles and simulates the
**first** one; reference expansion removes all others. (`compile()` does the same; early versions of
`ARCHITECTURE.md` and `types.ts` said "the last scchart".)

**Evidence.** `69-first-chart-is-simulated` (only First's I and a exist); probes with a reference in
either order (the first chart always runs).

**Source.** `proc/Reference.xtend` 162-183 (`model.rootStates.head`, `removeIf[it !== firstRoot]`);
`proc/TakenTransitionSignaling.xtend` 77.

---

## 8. Bugs in KIELER's netlist compiler that change results

These are upstream behaviour (present in kieler/semantics 5f02d129, not introduced by the fork). The
guide should avoid charts that hit them, or show them as caveats. The engine should implement the
intended semantics (as the priority compiler does) and may warn; the recordings mark them with
`"kielerBug"` in the scenario so the engine conformance test can expect the difference.

### B-34 Tick-1 effects are reordered around input reads (GO-init optimisation)

**Rule (netlist).** When the generated `logic()` starts with a block executed only in tick 1
(`if (_GO) { ... }`, which is the case when tick 1's work is a straight sequence: initialisers, entry
actions and untriggered immediate transitions from the initial states), the optimiser moves every
assignment of that block whose **right-hand side** does not mention an input into `reset()`. `reset()`
runs before the first inputs are read; the input-reading assignments stay in tick 1. The relative order
inside each group is kept, but the groups are swapped: everything that does not read an input happens
first. Input references in **array indices** are not noticed, so such an assignment runs in `reset()`
with the input still 0 (or its initialiser).

**Evidence.** `63-kieler-bug-tick1-reorder` (`y = I; y += 10; z = y` then `z += 1`: netlist y = 3,
z = 11; priority `64-...` y = 13, z = 14). `65-kieler-bug-tick1-input-index` (`arr[I] = 5` with I = 2
sets arr[0]). Also explains B-7 and probes `y = I` as initialiser followed by `entry do y += 1` (3
instead of 4).

**Source.** `opt/GOInitOptimizer.xtend` 82-151 (line 99: only `node.expression` is inspected);
enabled by `"de.cau.cs.kieler.scg.opt.goInit": true` in `scg/system/de.cau.cs.kieler.scg.netlist.kico`.

**Teaching note.** Only matters in tick 1 and only when a tick-1 effect sequence mixes input reads with
other writes of the same variables. Rule of thumb for the guide's examples: in tick 1, don't combine
an input-dependent assignment with later updates of the same variable.

### B-35 A compound assignment followed by a read, in code that runs every tick (partial evaluation)

**Rule (netlist).** In code the netlist compiler executes unconditionally (every tick, for example
the entry action of a state that self-loops every tick), the partial-assignment evaluator treats
`x op= c` (c a constant) as if it were `x = c` and substitutes c for later reads of x in the same
block: `x = 10; x += 1; y = x` gives y = 1; `entry do count += 1; shown = count` gives shown = 1 for
ever while count counts. The variable itself is updated correctly; only the substituted reads are
wrong.

**Evidence.** `66-kieler-bug-compound-then-read` (count 1, 2, 3; shown 1, 1, 1) versus
`67-...-priority` (shown 1, 2, 3). Probes: `entry do x = 10; x += 1; y = x` → y = 1; `x *= 3; y = x + 1`
→ y = 4 (priority 31). The same statements inside conditional code (an ordinary transition) are
correct (probes `do x = 1; x += 5; y = x` → y = 6).

**Source.** `opt/PartialAssignmentEvaluation.xtend` 115-119 (records `node.expression` as the value of
the target whenever it is a constant, ignoring `node.operator`).

### B-36 "Potential instantaneous loop" warnings on accepted charts

**Rule.** The netlist loop analyser sometimes warns `Potential instantaneous loop.` (official:
`Instantaneous loop detected!`) for charts that compile and behave correctly, e.g. a state with a
local, an entry action and a during action that self-loops every tick (probe: `initial state A { int c
= 10; int d; entry do c += 1; d += 1; during do seen = c * 100 + d } do x += 1 go to A`). It is a
warning only; `ok` stays true.

---

## 9. Netlist versus priority

| Topic | netlist (default) | priority |
| --- | --- | --- |
| Instantaneous loops (B-17) | rejected | accepted; loops run in the tick, or the tick never returns |
| `_TERM` / `terminated` (B-18) | true in the termination tick | not in the pool (undefined) |
| Input initialisers (B-7) | value before the first input; supplied tick-1 value wins | overwrite the supplied tick-1 value |
| Tick-1 reordering (B-34) | yes | no (written order) |
| Compound-then-read bug (B-35) | yes | no |
| Everything else in this suite | — | same values and same `taken`: all 54 charts of the suite that the netlist compiler accepts were rerun with priority; only the four rows above differ (charts 31, 63, 65, 66), and all 7 rejected loop charts are accepted by priority |

---

## 10. What KIELER rejects in this area

| Chart | Message (substring to match) | Where |
| --- | --- | --- |
| Cycle of immediate transitions | `Can't schedule from …`, `The SCG is NOT asc-schedulable!` (+ fork: `Circular dependency prevents scheduling this tick.`) | netlist scheduler |
| Assignment to a const | `You cannot assign a value to a const object.` | validator |
| const without initialiser | `A const declaration must have an initialization part!` | validator |
| Array size not a literal or literal const | `Array cardinalities must be an int literal or a reference to a constant int object.` | validator |
| const array indexed by a variable | `Cannot insert const array element.` | Const processor |
| Vector longer than the array / `_` for a row | `Cardinalities do not match.` | ArrayAssignment |
| `_` element in a vector assignment | `‘_’ undeclared (first use in this function)` + `Compiler did not return success` | gcc |
| `b = a` (arrays), `arr = 5` | `assignment to expression with array type` | gcc |
| `>>>`, `>>>=` | `expected expression before ‘>’ token` / `‘>=’ token` + `Compiler did not return success` | gcc |
| String `+` | `invalid operands to binary +` | gcc |
| `randomize()` in the tick-1 block | `‘null’ undeclared` | gcc |
| `randomize()` without `<stdlib.h>` (no `random()`, no `#hostcode` include) | `implicit declaration of function ‘srand’` | gcc |
| `const` before `input` / `output` (current KIELER) | `mismatched input 'output' expecting 'primitive'` | parser |
| Bare float trigger | `Float tests must have a comparison operator!` | validator |
| Int literal > 2147483647 | `For input string: "3000000000"` | parser |
| `1 < 2 < 3`, `A ? 1 + 2 : 3`, `B ? -1 : 2`, `!B ? 1 : 2`, `~A + 1`, `!A + 1`, `x = I++`, `1e3` | `no viable alternative at input …` | parser |

Warnings (chart still compiles): `The transition is not reachable.`, `The state is not reachable.`,
`There is an immediate loop. The model is not SASC.` (only when the chart is rejected anyway, or by the
priority compiler), `All or none concurrent regions should have final states.`, the relative-write
warning (B-31), gcc warnings forwarded as KIELER warnings (`overflow in conversion …`,
`comparison with string literal results in unspecified behavior`, `suggest parentheses around
comparison in operand of ‘&’`, `division by zero`).

### 10.1 Official KIELER 0.3.0 versus current KIELER

The oracle runs the lab's fork of the KIELER server, built from current KIELER sources (kieler/semantics
5f02d129). Readers who use the **KIELER VS Code extension** (`kieler.keith-vscode` 0.3.0 from Open
VSX) run an older compiler: its `extension/server/kieler-language-server.jar` was built in May 2024. A few
things differ between the two, so the guide must not present them as universal. Each row below was
checked by running the same chart through both servers (October 2026); on every chart that both accept,
the recorded values were identical.

| Topic | Official KIELER 0.3.0 | Current KIELER / lab server | Evidence |
| --- | --- | --- | --- |
| `const` with `input` / `output` | `const output int M`; `output const int M` → `no viable alternative at input 'const'` + `Pure types are only allowed if used in combination with signals.` | `output const int M`; `const output int M` → `mismatched input 'output' expecting 'primitive'` | B-8, `75`, `76` |
| Other misplaced modifiers (`output input bool x`) | `no viable alternative at input 'input'` + `Pure types are only allowed if used in combination with signals.` | `mismatched input 'input' expecting 'primitive'` | probe |
| A `;` after a declaration (`input bool A;`) | `no viable alternative at input 'bool'` + `no viable alternative at input ';'` | `mismatched input 'bool' expecting 'primitive'` + `no viable alternative at input ';'` | probe; `learn/first-chart` |
| String inputs | the value is corrupted: `learn/variables/greeting` with `name` "hi", then "bye" reports `name` = `nameIsHi` in every tick | the values as given (`hi`, `bye`) | probe (October 2026) |
| `random()` | needs `#hostcode "#include <stdlib.h>"`, else gcc fails (`Compiler did not return success`) | compiles as is (`<stdlib.h>` added) | B-29, probe |
| `randomize()` | needs `#hostcode "#include <stdlib.h>"` | needs it too unless the chart also calls `random()` | B-29, `77`, `structure/99` |
| Compiler crashes | the Java exception as the message, or **no answer at all** (the compilation never reports back; the oracle times out) | a located error message | below |
| File without any `scchart` | compiles nothing, without a message (the oracle reports that the simulation did not start) | `There is no SCChart to compile. Add a scchart declaration first.` | probe |

Crashes in official KIELER, as observed through the oracle (`SCCHARTS_SERVER_JAR=<official jar>`):

- **No answer** (the oracle's 90 s probe timeout; in VS Code the compilation never finishes): a `join to`
  on a single region without final state into a simple state with an entry or during action
  (concurrency.md T-6, test 18; `structure/39`), a region that is only an `initial final state` under a
  `join to` (K-1, test 22), nested for-regions (`structure/35`), a for-region declaration whose initial value
  uses the counter (`structure/94`), a recursive reference (`structure/21`), a keyword as a variable name
(`input bool go`) and the colon form `input button: bool` (an exception in the Compilation Thread; probes of the
learn/first-chart review). The lab server answers with
  `The compiler failed during compilation setup.`, `Can't copy valued object. Valued object is null!` or
  `Recursive reference: …`, and a syntax error for the last two (for `go`: `mismatched input 'go' expecting RULE_ID`).
- **Java exception text**: `for i : 3` (`java.lang.NullPointerException: Cannot invoke
  "de.cau.cs.kieler.kexpressions.IntValue.getValue()" because "_forEnd" is null` …), `for i : 0 to N`
  (`java.lang.ClassCastException: … ValuedObjectReferenceImpl cannot be cast to class … IntValue`), a bare
  `@DefaultSleep` (`java.lang.ClassCastException: … TagAnnotationImpl cannot be cast to class …
  StringAnnotation`), `global` in the root (`Can't copy valued object…` followed by more exceptions; both
  servers), duplicate root declarations (`Compiler did not return success`, then
  `java.lang.IllegalArgumentException: Cannot initialize using an ambiguous VariableStore.`; the lab server
  shows gcc's `duplicate member ‘x’`), emitting a variable (`java.lang.NullPointerException: Assigned valued
  object is null or not supported` and follow-up exceptions). The lab server gives the messages listed in each
  spec (`The for-region range "for i : 3" has a start value but no end value.`, `@DefaultSleep needs a
  value, e.g. @DefaultSleep 100.`, …).

Message wording that differs although the outcome is the same is a **lab server** change, not a version
difference; the specs mark those as "lab" or "fork": the loop warning (`Instantaneous loop detected!` vs
`Potential instantaneous loop.` / `… through x.`), the extra `Circular dependency … prevents scheduling this
tick.` error, the relative-write warning (B-31), the clock errors (structure.md S-39) and the
`kieler-divergence` warnings on charts the lab compiles although official KIELER fails on them.

**Running the official jar.** The jar is at
`/mnt/home/fallstop/Documents/projects/sccharts-lab/keith-vscode/out/upstream/kieler-language-server.jar`
(93.8 MB, sha1 `6a7b33c6…`; it is the vsix's `extension/server/kieler-language-server.jar`). It has the same
main class and runs on the same Java 21, so the oracle drives it unchanged:
`SCCHARTS_SERVER_JAR=<that jar> node tools/oracle/oracle.mjs chart.sctx --ticks 3`, or
`startOracle({ jar })` from a script (`--batch` reuses one JVM). Give each probe a timeout: the crashes
above never answer. The Java simulation systems need `javac` on `PATH` for the official jar
(`PATH=/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin:$PATH`);
the lab server finds it itself. Run only one server at a time (memory).

---

## 11. Interpreter outline for this area

Per tick:

1. Merge the given inputs into the input store (B-9); in tick 1 first apply input initialisers (B-7).
2. If the chart already terminated, report the unchanged pool with `terminated = false` and stop.
3. Tick 1: enter the root (initialise declarations in order, B-5; entry actions; enter initial states
   recursively).
4. For every active region, in the scheduling order decided by the causality rules (other specs):
   take the region's state S; candidates = immediate transitions if S was entered this tick, else all
   (B-11); take the first enabled one (B-12); run exit actions, effects in order (B-16), enter the
   target (B-6, entry actions); repeat while transitions fire (B-14).
5. Termination: if every root region is in a final state, `terminated = true` for this tick and mark
   the chart dead (B-18, B-19).
6. Expression evaluation follows B-20..B-30; record `taken` per transition index (B-32).

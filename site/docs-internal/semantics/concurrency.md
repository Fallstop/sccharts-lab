# Semantics spec: hierarchy, termination, concurrency, signals and `pre`

Area **concurrency** of the guide's semantics investigation. Everything below was established by running
charts through the KIELER oracle (`tools/oracle/oracle.mjs`: the sccharts-lite server, netlist-based C
simulation with taken-transition signalling, the same compiler as official KIELER) and by reading the KIELER
sources under `../kieler-server-fork/modules`. Each rule cites the conformance chart that demonstrates it
(`tests/conformance/concurrency/NN-*.sctx`, with a scenario and an `.oracle.json` recording; "test 26" means
`26-*.sctx`) and the source that implements it. Throwaway probes that informed a rule but did not become a test
are marked *(probe)*.

Every rule has five parts: **Rule** (the precise statement), **Evidence**, **Source**, **Teaching** (what
beginners get wrong, what is surprising, and a one-line plain-English version in italics) and
**Implementation** (for the in-browser interpreter: ordering within the tick, corner cases).

Source paths are abbreviated:

| Abbreviation | Path under `../kieler-server-fork/modules/` |
| --- | --- |
| `proc/` | `sccharts/src/de/cau/cs/kieler/sccharts/processors/` |
| `ext/` | `sccharts/src/de/cau/cs/kieler/sccharts/extensions/` |
| `validator` | `sccharts/src/de/cau/cs/kieler/sccharts/text/validation/SCTXValidator.xtend` |
| `scoping` | `sccharts/src/de/cau/cs/kieler/sccharts/text/scoping/SCTXScopeProvider.xtend` |
| `deps` | `kicool/src/de/cau/cs/kieler/kicool/processors/dependencies/AbstractDependencyAnalysis.xtend` |
| `scheduler` | `scg/src/de/cau/cs/kieler/scg/processors/SimpleGuardScheduler.xtend` |
| `guards` | `scg/src/de/cau/cs/kieler/scg/processors/SimpleGuardTransformation.xtend` |
| `keffects` | `kexpressions/src/de/cau/cs/kieler/kexpressions/keffects/extensions/KEffectsExtensions.xtend` |

Rule families: **H** hierarchy and scope, **T** final states and termination, **C** concurrency and the
initialise–update–read protocol, **SIG** pure signals, **V** valued signals, **PRE** `pre` and `val`, **A** ABRO,
**K** KIELER defects (reproducible behaviour the guide must not present as language semantics, but which the
oracle shows and the simulator must know about), **R** every rejection in this area with its message text.
(The signal and `pre` families were called S and P until October 2026; they were renamed because
`structure.md` uses S-n and `preemption.md` uses P-n. A bare S-n or P-n elsewhere always means those specs.)

Message texts: "official" is upstream KIELER; the oracle runs the lab's fork, which keeps those messages and
adds its own (marked "lab server"). Scenario `errorIncludes` use official texts wherever the fork shows them.

---

## 0. Reading the oracle traces (for engine and test authors)

Facts about what the oracle reports, not about the language; every comparison depends on them.

- **Only root-level declarations appear in `values`.** KIELER hoists every nested local to the root under a
  generated name (`_<Chart>_local_<name>`, `proc/ValuedObjectRise.xtend:81-89`; region-level declarations
  first become `_region<i>_<region>_<name>`, `proc/RegionActionsAndDeclarations.xtend:66-76`). The oracle
  drops names starting with `_`, so a test that wants to show a nested local copies it into a root output.
  An `output` declared inside a superstate is such a local and is not in the interface (H-6).
- **`terminated` is KIELER's `_TERM` flag: true only in the tick in which the root terminates**, false in
  every tick before and after (test 23). After termination nothing executes. The engine's
  `TickResult.terminated` ("nothing will happen in later ticks") is sticky, so a comparator must compare the
  *first* tick in which it becomes true. With `--system priority` the field is absent.
- **`taken[i]`** counts firings of transition *i* in this tick. Index order
  (`proc/TakenTransitionSignaling.xtend:53-60`, `StateIterator.sccAllContainedStates`): a pre-order walk of
  all states below the root in source order; for each state first its outgoing transitions in priority
  order, then the states of its regions, region by region. Example: test 14
  (`[S.join, W→F]` for each of the three regions).
- **Inputs keep their value until the environment sets them again, including values the chart itself wrote
  into an input** (an emitted input signal stays present: tests 49, 63).
- A valued signal `V` appears as `V` (presence, bool), `V_val` (value) and, unless it is an input, `V_curval`
  (V-1). For a valued *input* signal both `V` and `V_val` are inputs.
- Tick 1 is the first reaction (initial states entered, immediate behaviour runs).

---

## 1. What KIELER compiles a chart into (the model an interpreter must reproduce)

KIELER defines everything in this area by source-to-source transformations into a sequentially constructive
graph (SCG), a static dependency analysis on that graph, and a topological schedule. An interpreter that
follows this section reproduces the oracle on every accepted chart of the suite (except the K defects) and
rejects the charts KIELER rejects for causality.

### 1.1 Threads and concurrency

- Every control-flow region of a state is a **thread** (`proc/scg/SCGTransformation.xtend:512-700`: one
  entry/exit pair per region under a fork/join per state). Regions of the same state are **concurrent** with
  each other and with everything nested inside each other, at any depth (test 41). Two accesses are
  concurrent iff their least common ancestor fork has them in different threads (`deps:534-550`). Accesses in
  the same region are never concurrent, even from different states of it (test 38).
- The transformations add **generated threads** (extra regions of the declaring state), concurrent with the
  user's regions of that state:
  - the signal-reset thread of a state that declares non-input signals (SIG-1);
  - valued-signal helper threads (V-1);
  - one thread per `pre` operand (PRE-1);
  - one thread per `during` action (`proc/During.xtend:112-140`).
- Within a thread execution is sequential: a transition's trigger is read, then its effects run left to
  right, then the target's entry actions, then any immediate continuation (test 36).

### 1.2 Desugaring that matters for scheduling

| Source | Becomes (per tick, in the stated thread) | Access kind |
| --- | --- | --- |
| `signal S` (local/output) in scope X | thread of X: `S = false` in every tick X is active (`proc/Signal.xtend:313-332`) | absolute write of `S` |
| emission `S` | `S \|= true` (`proc/Signal.xtend:288`, `keffects:97`) | relative write, operator `\|=` |
| test `S`, `!S`, `S && T` | read of `S` | read |
| valued `V` (non-input), emission `V(e)` | `V_curval op= e; V \|= true`, `op` from the combine function (`+=`, `*=`, `max=`, `min=`, `\|=`, `&=`); `V_curval = e` with no combine or `combine none` (`proc/Signal.xtend:236-244`, `keffects:112-123`) | relative write of `V_curval` (absolute without combine) |
| valued `V` with a combine | thread of X: `V_curval = neutral` every tick (`proc/Signal.xtend:213-224`) | absolute write |
| valued `V` (non-input) | thread of X: `if V then V_val = V_curval` every tick (`proc/Signal.xtend:192-196`) | reads `V`, `V_curval`; absolute write of `V_val` |
| `val(V)` | read of `V_val` (`proc/Signal.xtend:249-261`) | read |
| `pre(x)`, x declared in scope X | thread of X: `_pre_x = _reg_x; _reg_x = x` every tick; `_reg_x` initialised to the type default on entry of X (`proc/Pre.xtend:140-192`) | `pre(x)` reads `_pre_x` |
| local `int c = 5` in scope X | entry action of X, before user entry actions: `c = 5` (`proc/Initialization.xtend:165-191`) | absolute write |

### 1.3 Classifying writes (`deps:160-262`)

For an assignment to `x`:

1. `x = e` where `e` reads `x` **exactly once**: **relative** write (old SC syntax; KIELER warns), whose
   operator is the plain assignment `=` whatever `e` computes (`x = x + 1`, `x = x * 2` and `x = 3 - x` all
   have operator `=`; this matters for commuting, 1.4). `x = x * x` (two reads) is **absolute** (test 73).
2. `x op= e` (`+=`, `-=`, `*=`, …) where `e` does not read `x`, and `x++` / `x--`: **relative** write.
   `x += x` (reads `x`) is **absolute** (test 73).
3. Every other `x = e`: **absolute** write.
4. The assignment's own read of `x` is discarded once its write is recorded (`deps:200-205`), so an update
   never depends on itself.
5. Arrays: a constant index is its own variable; a non-constant index makes the access an access to the
   whole array, which interacts with every cell (tests 39, 40; `deps:377-396`).

### 1.4 Dependencies and the acceptance test

Between every pair of **concurrent** accesses to the same variable (`deps:401-526`):

| First \ second | absolute write | relative write | read |
| --- | --- | --- | --- |
| absolute write | conflict unless confluent | abs → rel | abs → read |
| relative write | | nothing if commuting, else conflict | rel → read |
| read | | | nothing |

- **Confluent** absolute writes: both `=` with the same constant value or structurally equal expressions
  (`deps:576-601`): `x = 3` ‖ `x = 3`, `y = i` ‖ `y = i` (test 28). Confluent pairs get no edge.
- **Commuting** relative writes: same operator, or both from {`+=`, `-=`, `++`, `--`} (`deps:458-465`,
  `:488-491`, `processDependency` / `isCommuting`). Two `*=` commute (test 31); `+=` with `*=` does not (test
  32). Emissions of one signal always commute (all `|=`). The test compares only the assignment operators, so
  **any two old-style updates commute** (both have operator `=`), even when their result depends on the order
  (`x = x * 2` ‖ `x = x + 3`, test 74); they are then applied in the textual order of their threads (C-5). An
  old-style update and a compound assignment (`x = x + 1` ‖ `x += 3`, or `x++`) do **not** commute, although
  both are relative writes: conflict (test 75).
- **Conflict** = edges in both directions, so an immediate cycle.
- Edges are static: guards, states and reachability are ignored (tests 30, 47). Accesses that can never
  happen in the same tick still get their edge.

Add each thread's own order within one tick (a pause ends the instantaneous path) and trigger → effect order.
KIELER rejects the chart if this graph has a cycle (`scheduler:71-160`: "Can't schedule from … to …", "The SCG
is NOT asc-schedulable!"). Otherwise every topological order gives the same result, with one exception: **within a tick, for each
variable, all concurrent absolute writes happen first, then all relative writes, then all reads, while every
thread keeps its own order** (C-3). The exception is a set of concurrent old-style updates with different
arithmetic (C-5): KIELER's schedule runs them in textual thread order, and only that order reproduces the
oracle.

**Implementation.** Either reproduce this literally (build the dependency graph once per compiled chart,
reject on a cycle, then in every tick execute the active nodes in a fixed topological order), or run threads
as coroutines and let a read of `x` (or a write that must follow another write class) wait while any
concurrent thread that is still running in this tick could still perform an earlier-class access to `x`. The
static graph is the reference: it is what decides acceptance, including the "false cycles" of C-9.

---

## H. Hierarchy and scope

### H-1 Entering a superstate enters its inside in the same tick
**Rule.** When a superstate is entered, its entry actions run, then every region's initial state is entered
(recursively) in the same tick. Immediate transitions inside run in that tick; delayed ones are first
checked in the next tick.
**Evidence.** Test 01: tick 2 enters `Inside`, runs `entry do step = 1` and the immediate `A → B`
(`step = 12`); `B → C` fires in tick 3 (`step = 123`).
**Source.** `proc/Entry.xtend` (entry actions precede the content), `proc/SurfaceDepth.xtend` (a state's
surface is everything up to its first pause).
**Teaching.** Beginners expect a superstate to "start" a tick later. *Entering a superstate enters all the
way down at once.*
**Implementation.** In the entry tick: incoming transition's effects → generated initialisations (H-3) →
user entry actions of the superstate → initial states of all regions (concurrently, subject to section 1) →
their entry actions → immediate transitions.

### H-2 Scopes nest; inner declarations shadow outer ones
**Rule.** Every state with a body (and every region) is a declaration scope. A name resolves to the nearest
enclosing declaration; an inner declaration shadows an outer one. Same-named locals in different
superstates are independent variables with no scheduling interaction.
**Evidence.** Test 02 (inner `x` 10 → 11, the output `x` stays 1); test 03 (`y1 = 2`, `y2 = 101`).
**Source.** `scoping:343-365` (`getScopeHierarchical` walks `nextDeclarationScope` outwards).
**Teaching.** Shadowing is silent: no warning. Prefer distinct names. *The nearest declaration wins.*
**Implementation.** Resolve by walking containers outwards; give every declaration its own storage
(KIELER renames them apart, section 0).

### H-3 Locals are re-initialised on every entry
**Rule.** A variable or signal declared in a superstate is initialised every time that superstate is
entered: to its initialiser or, without one, to the type default (`false`, `0`, `0.0`; `string` gets
`null`). Inputs are never initialised by the chart.
**Evidence.** Test 04: after the reset in tick 4, `c` restarts at 5 and `d` at 0 (ticks 5–6 show 6/1 and
7/2). Test 64: a valued local signal returns to 7. Test 68: `pre(k)` restarts too (PRE-4).
**Source.** `proc/Initialization.xtend:118-152` (implicit defaults for non-input declarations without
initialiser), `:165-191` (initialisation becomes an entry action at position 0 of the declaring scope, `:180`).
**Teaching.** "Local" means "fresh on every entry", like a local variable in a function call. To keep a value
across re-entries, declare it one level up. *Every entry starts from scratch.*
**Implementation.** Initialise in the entry sequence of the declaring state, before the user's entry
actions; the initialisation is an absolute write and takes part in scheduling.

### H-4 Region declarations belong to the parent state
**Rule.** `region R { int c = 5 ... }` declares `c` in the region's parent state: it is initialised when the
parent is entered, not when the region's initial state is re-entered. It is visible only inside `R`.
**Evidence.** Test 05: `B → A` in tick 3 keeps `c = 6`; the parent's re-entry in tick 4 resets it (tick 5:
`seen = 6`).
**Source.** `proc/RegionActionsAndDeclarations.xtend:66-76` (moved to the parent with a `_region<i>_<R>_`
prefix). Regions *with actions* are wrapped in a new state instead (`:77-98`; warning "Actions in regions
are highly experimental and may not produce the expected results.").
**Teaching.** *A region's variable lives as long as the state around the region.*
**Implementation.** Scope for name lookup = the region; lifetime and initialisation = the parent state.

### H-5 A state's own transitions see its locals
**Rule.** The triggers and effects of a state's *outgoing* transitions are resolved in that state's scope:
they see the state's own local declarations, which shadow outer names, with their current values. The
state's region-level declarations are not visible there ("Couldn't resolve reference to ValuedObject 'c'."
*(probe)*).
**Evidence.** Test 06: `if c == 5` on `S`'s outgoing transition reads `S`'s local `c` (5), not the output
`c` (1), and fires.
**Source.** `scoping:343-365` (a transition is contained in its source state, so lookup starts there). The
validator check meant to forbid this, `checkScopeOfOutgoingTransitionVarRefs` ("Variable or signal used out
of its scope.\nDeclare it one hierarchy layer up!"), never fires for states: it tests
`instanceof AbstractDeclarativeValidator.State`, an unrelated class (`validator:942-960`, test at `:945`).
**Teaching.** Surprising and fragile; KIELER intended this to be an error. Recommend declaring such variables
one level up. *Don't read a superstate's locals on its own way out.*
**Implementation.** Resolve transition expressions starting at the source state's own declarations; do not
report an error (KIELER doesn't).

### H-6 `input` / `output` on inner declarations make plain locals
**Rule.** Only the root's `input` / `output` declarations form the chart interface. Inside a superstate they
are ordinary locals (initialised on entry, H-3).
**Evidence.** Test 07: the recorded interface contains only `y`; `z` behaves as a local (3, then 4).
**Source.** `proc/ValuedObjectRise.xtend:81-89` (nested declarations hoisted and renamed); the simulation
interface is the root's declarations.
**Teaching.** *Declare inputs and outputs at the top of the `scchart`.*
**Implementation.** Build `interface` from root declarations only; treat inner `input`/`output` as locals.

### H-7 Duplicate names in one scope: rejected at the root, accepted in a superstate
**Rule.** Two declarations of the same name in one scope get only the warning "The variable is declared
multiple times in this scope." (also for `int x = 1, x = 2` in one declaration, and for two different types).
What happens next depends on the scope:
- **Root** (and a region of the root, `region R { int x  int x … }`): both keep their name in the generated
  C, which then fails (`duplicate member 'x'`, `duplicate member '_region0_R_x'`), so KIELER rejects the chart.
  Official KIELER adds `java.lang.IllegalArgumentException: Cannot initialize using an ambiguous
  VariableStore.`; both servers warn "VariableStore contains ambiguous information for variables.".
- **Superstate** (a state below the root): the locals are hoisted to the root under distinct generated names
  (section 0), so the chart compiles with only the warning. Every reference to the name binds to the
  **first** declaration; the second is a dead variable of its own (test 76: `int x = 1; int x = 2`, then
  `x += 10; o = x` gives `o = 11`).
**Evidence.** Test 08 (root, rejected); test 76 (superstate, accepted); probes: region of the root (rejected),
two types `int x = 1` / `bool x = true` in a superstate (accepted, `o = 1`), official KIELER on all of them
(same outcomes).
**Source.** `validator:761-770` (`checkDuplicateVariable`, warning only); `proc/ValuedObjectRise.xtend:81-89`
(hoisting renames nested locals apart); scoping resolves the name to the first match.
**Teaching.** *One name, one declaration per scope.* A duplicate inside a superstate is silently harmless only
by accident; treat the warning as an error.
**Implementation.** Root (or root-region) duplicates: reject with an error, quoting KIELER's warning text.
Superstate duplicates: warn, resolve the name to the first declaration, and still initialise the second
(it is never read).

---

## T. Final states and termination

### T-1 `join to` fires when every region is final; it is weak
**Rule.** A superstate *terminates* in a tick when, after its inner behaviour for that tick, every
control-flow region of it is in a final state. Its termination transition (`join to`) is then enabled. It
behaves like a weak abort: the inner behaviour of the tick runs first, then the join's effects, then the
target's entry actions, all in the same tick.
**Evidence.** Test 09: tick 2 runs the inner `n = 1`, then the join's `n *= 10` (`n = 10`), then `D`'s entry
(`done = true`).
**Source.** `proc/Termination.xtend:136-229` (one `_term` flag per region, set by transitions into final
states; their conjunction becomes a weak-abort trigger), called from `proc/Abort.xtend:139-160`
(`handleTermination`); `proc/ComplexFinalState.xtend:162-245` when final states have outgoing transitions or
inner behaviour.
**Teaching.** *A join waits for every region to finish, then fires in that same tick.* Effects on the join
run after everything the regions did in that tick.
**Implementation.** After the superstate's regions have completed their step in the tick, evaluate the
superstate's outgoing weak transitions in priority order; a join's guard is "all regions currently in a
final state" ∧ its trigger (T-4).

### T-2 All regions must be final at the same time
**Rule.** Termination needs every region in a final state simultaneously, at the end of the inner step. A
region that leaves a final state (a final state with an outgoing transition) no longer counts.
**Evidence.** Test 10 (join in tick 4 when the second region finishes); test 11 (tick 3: one region arrives
while the other leaves, no join; tick 5: join).
**Source.** `proc/ComplexFinalState.xtend:224-233` (`_term = false` on transitions out of a final state).
**Teaching.** Final is a place, not a flag: leaving it undoes it. *All regions must be home at the same time.*
**Implementation.** Compute finality from the regions' current states after the inner step, not from
history.

### T-3 A trigger-less join is immediate: a superstate can terminate in its entry tick
**Rule.** `join to X` without trigger is implicitly immediate. If a superstate's regions reach final states
through immediate transitions in the tick the superstate is entered, it terminates and the join fires in
that same tick.
**Evidence.** Test 12: `P → S`, immediate `W → F` and the join all in tick 2 (`n = 123`).
**Source.** `ext/SCChartsTransitionExtensions.xtend:132-135` (`isImplicitlyImmediate`: termination, no
trigger, not explicitly `delayed`).
**Teaching.** *A superstate can be entered and finished in one tick.* (KIELER exception: K-3; initial final
states: T-8, K-1.)
**Implementation.** Check a trigger-less join in the superstate's entry tick as well.

### T-4 A join with a trigger is delayed unless marked `immediate`
**Rule.** `if c join to X` is delayed: it is not taken in the tick the superstate is entered, even if the
superstate terminates in that tick and `c` holds. `immediate if c join to X` is checked in the entry tick.
`delayed join to X` (no trigger) is delayed as well. While the superstate stays terminated, the trigger is
re-evaluated in every tick.
**Evidence.** Test 13 (terminated in tick 2, joins in tick 4 when `c` holds, `n = 11`); test 14 (tick 1:
only the `immediate if c` join; tick 2: the `if c` and `delayed` joins).
**Source.** `ext/SCChartsTransitionExtensions.xtend:132-135`; `proc/Termination.xtend:214-224`
(KISEMA-1314).
**Teaching.** Asymmetry worth a callout: `join to` is immediate, `if c join to` is delayed, as for every
transition with a trigger. *Adding a condition to a join makes it wait for the next tick.*
**Implementation.** A delayed join is skipped in the superstate's entry tick only; afterwards it is checked
every tick.

### T-5 Joins have priorities like any other transition
**Rule.** A join is one of the state's outgoing transitions in priority (textual) order. If a weak abort of
higher priority is enabled in the same tick, it wins, and vice versa. In both cases the inner behaviour ran.
**Evidence.** Test 15 (`first = 1`: the abort written first wins; `second = 2`: the join written first wins;
the inner `W → F` was taken in both).
**Source.** `proc/Abort.xtend:246-289` (weak-abort and termination triggers collected in priority order).
**Teaching.** *Write the transition that should win first.* (Strong aborts must come first anyway:
"Strong abort transitions must have a higher priority than weak abort or termination transitions.")
**Implementation.** Same as other weak transitions: first enabled in priority order wins.

### T-6 Missing final states
**Rule.**
- `join to` on a state without regions: error "A state with a termination transition must have inner
  behaviour." (test 16).
- A region without final states in a superstate with a join: warning "Every region should have a final state
  whenever its parent state has a termination transition." (only if the superstate has no actions); a region
  with final states next to one without: warning "All or none concurrent regions should have final states."
  The chart compiles and the join never fires (test 17). **This is also the normal outcome for a single
  region**: a superstate whose only region has no final state compiles with the warning and stays for ever
  (test 77: join to a plain `state D`; test 78: `Programme` whose join leads back to the initial `Idle`; test 79:
  an initial superstate joining to a plain state; official KIELER agrees).
- **One shape crashes the compiler:** a single region without final state whose `join to` leads to a simple,
  non-final state with an `entry` or `during` action (test 18). KIELER's SCG optimiser `SuperfluousForkRemover`
  throws a NullPointerException (lab server: "The compiler failed during compilation setup."; official KIELER
  never reports back). In probes the chart compiles again with a target without actions, with only an `exit`
  action, with a final target (`final state D { entry … }`), with a target that has inner states (even with its
  own entry action), with an entry action on the superstate instead, or with two regions without final states
  (official KIELER agrees on every probe). A dataflow region (never final) under a `join to` behaves the same way
  (`structure/39`). This boundary is sampled, not derived from the source.
**Evidence.** Tests 16, 17, 18, 77, 78, 79; `structure/39-err-dataflow-join-target-entry-crash`; probes listed
above.
**Source.** `validator:860-883` (`checkFinalStates`: error at `:870`, warning at `:878`), `validator:834-848`
(`checkAllHaveFinalStates`); crash in
`scg/src/de/cau/cs/kieler/scg/processors/optimizer/SuperfluousForkRemover.xtend`.
**Teaching.** A superstate without final states simply never terminates; that is normal when it has no
`join to`, and with one KIELER warns and the join just never fires. *A join needs somewhere to finish in every
region.* (Do not present the crash as the usual result: it needs the specific target of test 18.)
**Implementation.** Reject test 18's shape (single region without final state, `join to` a simple non-final
state with an entry or during action) as an error, since KIELER cannot compile it; keep the shapes of tests 17,
77, 78 and 79 running with the warnings (the join never fires).

### T-7 Root termination
**Rule.** The root (the `scchart`) terminates when all its regions are in final states. In that tick its
behaviour runs normally, including root `during` actions; afterwards nothing runs and all values keep their
last values. (K-2: a root that declares a signal never terminates in KIELER's simulator.)
**Evidence.** Test 23 (tick 2: both regions final, `terminated`, the delayed during action ran: `n = 1`;
ticks 3–4: nothing, `n = 1`).
**Source.** `guards:177-180, 220-226` (`_TERM` is set when the main thread's exit is reached).
**Teaching.** Most embedded charts never terminate; root termination means "the program is over".
*When every top-level region is final, the chart stops.*
**Implementation.** Report termination in the tick it happens and stop executing (section 0 for the
oracle's one-tick pulse).

### T-8 An initial final state counts only once a transition enters it
**Rule.** A region whose initial state is final *and has outgoing transitions* does not count as terminated
before it first enters a final state through a transition, so not in its entry tick.
**Evidence.** Test 19: no join in tick 1 although `F` is initial and final; join in tick 3 when `G → F`
enters it.
**Source.** `proc/ComplexFinalState.xtend:206-233`: the `_term` flag's initial value `true` (`:216-218`) is
overwritten by the parent's entry action `_term = false` (`:214`); only transitions into final states set it.
**Teaching.** Rare; avoid `initial final` states that can be left. *Starting at the finish line doesn't
count.* (An initial final state with no transitions at all: K-1.)
**Implementation.** Track per region a "reached final" flag set only by transitions into final states and
cleared on entry of the parent and by transitions from final to non-final states.

---

## C. Concurrency and the initialise–update–read protocol

### C-1 Concurrent regions react in the same tick; data, not text, decides the order
**Rule.** All active regions react in every tick. Their textual order does not affect the result, with one
exception: concurrent old-style updates of one variable with order-dependent arithmetic (`x = x * 2` ‖
`x = x + 3`), which KIELER accepts and applies in textual region order (C-5).
**Evidence.** Test 27 (readers written before and after the writer both see the write); test 43; test 74 (the
exception).
**Source.** Section 1; `scheduler` (order comes from dependencies, not from text). Observed (test 74 and its
probes): nodes without a dependency between them run in the SCG's node order, which follows the text.
**Teaching.** Regions are not executed top to bottom. *Regions run "at the same time"; data decides the
order.* (Old-style updates from several regions are the one place where text order leaks through: write
updates with `+=`, which KIELER checks properly.)
**Implementation.** Never use source order between threads except as the tie-breaker among independent
nodes; make that tie-breaker the textual (pre-order) thread order, which test 74 needs.

### C-2 A region sees its own writes in order
**Rule.** Within one region, effects and transitions execute in sequence; a read sees the writes made
earlier in the same thread plus all concurrent writes scheduled before it (C-3).
**Evidence.** Test 36 (`sawZero` sees the old `x`, `y = x + 1` the new one, the immediate `B → C` sees
`x == 5`); test 38.
**Source.** Sequential control flow in the SCG (`proc/scg/SCGTransformation.xtend:684-760`).
**Teaching.** Inside one region SCCharts is sequential code: "sequentially constructive". *Within a region,
statements run in the order you wrote them.*
**Implementation.** Execute a transition as: evaluate trigger, run effects left to right, then entry
actions, then continue immediately if enabled.

### C-3 Initialise, then update, then read
**Rule.** For each variable within one tick: all absolute writes in concurrent threads happen before all
relative writes (updates), which happen before all reads. A thread's own read that precedes its own write
in program order still happens first.
**Evidence.** Test 33 (`x = 100`, `+5`, read: 105 regardless of region order); test 37 (`z = 0`: the
region's read before its own write; `y = 1`: the other region's read waits for that write); test 27.
**Source.** Section 1.4; `deps:493-526` (`accessType`).
**Teaching.** *Within a tick, writers go first and readers last; a region never waits for itself.*
**Implementation.** Section 1.4. Relative writes are applied cumulatively to the value left by the absolute
writes; reads see the final value of the tick (unless sequentially earlier in their own thread).

### C-4 Concurrent absolute writes must agree
**Rule.** Two concurrent absolute writes of a variable are accepted only if confluent (same constant or
structurally equal expression). Otherwise the chart is rejected, even if the writes can never happen in the
same tick.
**Evidence.** Test 28 (accepted; `x = 3`, `y = 5`); test 29; test 30 (`if a` vs `if !a`, still rejected);
test 41 (regions nested in one superstate conflict the same way).
**Source.** `deps:453-486` (`processDependency`), `:576-601` (`isConfluentTo`).
**Errors.** "Can't schedule from <a> to <b>" (several), "The SCG is NOT asc-schedulable!"; lab server adds
"Circular dependency involving x prevents scheduling this tick." and the warning "Potential instantaneous
loop through x." (official: "Instantaneous loop detected!"). Priority compiler: "The SCG is not
IASC-schedulable!".
**Teaching.** The classic beginner error: two regions each "owning" an output. Fix: one writer, an update
(`+=`), or a valued signal with a combine function. *Two regions may not set the same variable to different
values.*
**Implementation.** Structural equality of expressions (same operator tree, same references, same
literals) counts as confluent; `x = 1 + 0` vs `x = 1` was not probed.

### C-5 Concurrent relative writes must commute (by operator)
**Rule.** Concurrent relative writes are accepted if their assignment operators commute (same operator, or
all from {`+=`, `-=`, `++`, `--`}); all of them apply in the tick. Other combinations are rejected. The test
looks at the operators only: old-style updates (`x = x <op> e`, C-6) all have operator `=`, so any number of
them commute with each other even when the result depends on their order, and they conflict with every
compound operator (`+=`, `*=`, `++`, …).
- Commuting compound operators (`+=` ‖ `-=`, `*=` ‖ `*=`) give the same result in any order.
- Old-style updates are applied in the **textual order of their threads** (pre-order: a region's nested
  regions before the next region of the outer state): test 74, regions `Second` then `First` with
  `x = x * 2; y = y + 3` and `x = x + 3; y = y * 2`, gives `x = 5, y = 8` (the other order would give
  `8, 5`); *probes*: the same with the regions swapped gives `8, 5`; nested regions `x = x * 2`, `x = x - 1`
  inside the first region and `x = x + 10` in the second give `x = 11`. Official KIELER gives the same values.
- An absolute write and old-style updates still follow C-3 (absolute first: `x = 5` ‖ `x = x * 2` gives 10,
  *probe*), and reads come after them (`seen = x` ‖ `x = x * 2` sees 2, *probe*).
**Evidence.** Test 31 (`x = 10 + 2 - 5 + 1 = 8`, `y = 1 * 2 * 3 = 6`); test 32 (`+=` with `*=`); test 74
(old-style, order-dependent, accepted); test 75 (`x = x + 1` ‖ `x += 3`, rejected; *probe*: `x = x + 1` ‖
`x++` likewise).
**Source.** `deps:453-491` (`processDependency`: two relative writes whose operators are not `isCommuting`
become a write-write conflict; `isCommuting` compares `AssignOperator`s only).
**Teaching.** Counters can be bumped from several regions at once. *Several regions may add to the same
counter in one tick.* Always use `+=` / `-=` for that: with old-style `x = x + 1` the same chart is accepted,
but mixing it with `+=` is rejected, and old-style updates with different arithmetic silently depend on the
order in which the regions are written.
**Implementation.** Apply every relative write of the tick; for commuting compound operators the order is
irrelevant; for old-style updates apply them in textual thread order. Reject old-style ‖ compound pairs.

### C-6 Old-style updates and write classification
**Rule.** `x = x + 2` (target read exactly once) is an update, but not quite like `x += 2`: its operator is
`=`, so it commutes with every other old-style update and with no compound assignment (C-5). `x = x * x` and
`x += x` read the target and are absolute writes, scheduled before other regions' updates.
**Evidence.** Test 34 (`x = 1 + 2 + 3 = 6`); test 73 (`x = 3·3 + 1 = 10`, `w = 3 + 3 + 1 = 7`); tests 74, 75.
**Source.** `deps:216-240`; warning `validator:1218` (`checkOldStyleRelativeWriteSyntax`): official "This
assignment looks like old relative write SC syntax and is considered deprecated.\nIf you want to create a
relative write in new syntax, please use an infix assignment operator."; the lab server rewords it ("This
assignment reads x, so the compiler treats it as an update of x …") when `x` is read exactly once.
**Teaching.** Prefer `+=`, `++`: they say "update" explicitly. *Write updates with `+=`.* (The lab server's
reworded warning ends "It only matters when another region also writes x in the same tick: this assignment
then runs after that write instead of conflicting with it." That holds next to an absolute write; next to a
`+=` the chart is rejected (test 75), and next to another old-style update the result depends on the region
order (test 74). Its advice "Write it as x *= 2" would likewise turn test 74 into a rejected chart.)
**Implementation.** Classify per section 1.3 before building the dependency graph, keeping the assignment
operator (`=` for old-style updates) for the commuting test; emit the warning for `x = …x…` with `=`.

### C-7 Causality cycles are rejected
**Rule.** If a read must wait for a concurrent write that itself depends (through guards or sequence) on
that read, the chart is rejected.
**Evidence.** Test 35 (`if !y do x` ‖ `if !x do y`); test 46; test 59.
**Source.** `scheduler:71-160`.
**Errors.** As C-4.
**Teaching.** Fix with `pre()` (last tick's value), by making one side wait a tick, or by merging the logic
into one region. *A region can't wait for something that waits for it.*
**Implementation.** Cycle detection on the graph of section 1.4 including trigger → effect edges.

### C-8 Arrays
**Rule.** Concurrent writes to different constant indices do not interact; an access with a non-constant
index interacts with every cell.
**Evidence.** Test 39 (`a = [1, 2]`); test 40.
**Source.** `deps:377-396` (specific vs generic identifiers).
**Teaching.** *Different fixed cells are different variables; `a[i]` touches them all.*
**Implementation.** Key accesses by (array, constant index) or (array, *).

### C-9 The analysis is static
**Rule.** KIELER never considers which states or guards can be active together. "False cycles" that exist
only on paper are rejected.
**Evidence.** Tests 30 and 47 (guards `I` / `!I` exclude each other; Esterel's constructive semantics would
accept the equivalent program).
**Source.** `deps` (no guard information in `ValuedObjectAccess`).
**Teaching.** SCCharts accepts some programs Esterel rejects (SIG-3) and rejects some Esterel accepts (this
rule). *If the code could conflict, KIELER says no, even when it never would.*
**Implementation.** Do not prune edges by guard analysis.

### C-10 Netlist vs priority-based compiler
**Rule.** For the charts of this suite, both compilers accept and reject the same charts and agree tick for
tick, except: `20`, `21` (K-1: "This region has no state left to start in once KIELER has normalized the
chart, so KIELER's priority-based compiler cannot compile it." (lab server)), `26`, `72` (K-3) and `64`,
`68` are rejected only by the priority compiler ("The SCG is not IASC-schedulable!"; `64` and `68` have a
weak-abort self-loop around a superstate whose inner immediate transition runs on re-entry; the netlist
compiler accepts them with a "Potential instantaneous loop" warning and behaves as the rules here say); and
in `71`, tick 5, the priority compiler counts the strong copy's join as taken but reports `OStrong` absent.
**Evidence.** Whole suite re-run with `--system priority` and compared value by value *(probe)*; for `71`,
each copy alone agrees with the netlist result and renaming the states does not change it *(probes)*. Tests
74–77 were re-run with priority too: the same values (74 included, so priority also applies old-style updates
in textual order) and the same rejection of 75 ("The SCG is not IASC-schedulable!") *(probe)*.
**Source.** `scg/src/de/cau/cs/kieler/scg/processors/priority/PriorityProcessor.xtend:117` (message).
**Teaching.** Use the netlist compiler (the default) when following the guide.
**Implementation.** The engine follows the netlist compiler; the recordings use it.

---

## S. Pure signals

### SIG-1 Present iff emitted in this tick
**Rule.** A pure signal is present in a tick iff some active part of the chart emits it in that tick.
Local and output signals are reset to absent at the start of every tick in which their declaring scope is
active; a bool variable keeps its value. An initial value on a pure signal (`output signal S = true`) is
ignored *(probe)*.
**Evidence.** Test 42 (`S` absent again in tick 3, `B` stays true); test 48.
**Source.** `proc/Signal.xtend:313-332` (immediate during action `S = false` in the declaring state, for
non-input signals); `:274-277` (initial value removed).
**Teaching.** *A signal is an event of this tick; a variable is memory.*
**Implementation.** Reset presence at the start of every tick of the declaring scope (it is an absolute
write, so it precedes every emission); emissions set it; tests read it after all emissions (SIG-2).

### SIG-2 Emissions before tests
**Rule.** Emission is an update (`S |= true`) and a test is a read, so in concurrent regions every emission
of `S` in the tick happens before every test of `S`. Several regions may emit the same signal.
**Evidence.** Test 43 (testers written before and after the emitter both count); test 45.
**Source.** `proc/Signal.xtend:280-311`; section 1.4.
**Teaching.** *If any region emits S in this tick, every other region sees S present in this tick.*
**Implementation.** As C-3 with emission = relative write.

### SIG-3 A region's test before its own emission sees "absent"
**Rule.** In one region, a test of `S` that precedes the region's own emission of `S` sees `S` without that
emission. So `immediate if !S do S` is accepted (Esterel rejects `present S else emit S`): the test sees `S`
absent, fires, and `S` is present. A concurrent test of `S` waits for that emission.
**Evidence.** Test 44 (tick 1: `S` present, `took = true`); test 45 (the emitting region fires, the other
region sees `S` present and fires only in tick 2).
**Source.** Section 1.4 (no edge between accesses of the same thread).
**Teaching.** The "sequentially constructive" difference from Esterel; also explains why `if S do S` never
fires on its own. *A region can't see its own future.*
**Implementation.** Same-thread accesses are ordered only by program order.

### SIG-4 Cycles through signals
**Rule.** Tests and emissions across regions that form a cycle are rejected, including false cycles (C-7,
C-9).
**Evidence.** Test 46 (`if S do U` ‖ `if U do S`); test 47.
**Source.** As C-7.
**Errors.** "The SCG is NOT asc-schedulable!"; lab server: "Circular dependency prevents scheduling this
tick." (no names for signals).
**Teaching.** *Two regions that each wait for the other's signal deadlock; KIELER refuses them.*
**Implementation.** As C-7.

### SIG-5 Input signals
**Rule.** Input signals are set by the environment and never reset by the chart. The chart may emit its own
input signal; it is then present in that tick and, because the simulator keeps inputs until the environment
changes them, stays present until the environment sets it absent.
**Evidence.** Test 49 (present in ticks 2–3, absent from tick 4 when the environment says so).
**Source.** `proc/Signal.xtend:315` (no reset for inputs).
**Teaching.** *Don't emit your own inputs.*
**Implementation.** No reset thread for inputs; a chart write to an input persists in the pool.

### SIG-6 Signals are emitted, variables are assigned
**Rule.** Assigning a signal is an error. Emitting a variable is rejected too (warning in the validator,
failure in code generation).
**Evidence.** Test 50 ("Non-variables cannot be used in an assignment."); test 51 (official: warning
"Non-signals should not be used in an emission.", then a code generation failure; lab server: "b is an
output bool variable, not a signal, so it cannot be emitted.").
**Source.** `validator:669-675`, `:576-583`.
**Teaching.** *`S` emits a signal; `x = …` sets a variable; never mix them.*
**Implementation.** Both are errors.

### SIG-7 A signal name in an expression is its presence
**Rule.** In any expression, `S` (pure or valued) is its presence as a bool; in arithmetic it counts as 0/1.
**Evidence.** Test 61 (`V + 1 = 2` while `val(V) + 1 = 6`).
**Source.** `proc/Signal.xtend:301-310` (references become the presence variable).
**Teaching.** Forgetting `val()` gives 0/1 arithmetic without any warning. *Use `val(V)` for the value.*
**Implementation.** Treat a signal reference as a bool read; C-style bool → int conversion in arithmetic.

---

## V. Valued signals

### V-1 Presence plus a persistent value
**Rule.** A valued signal (`signal int V`, `signal bool V`, …) has a presence (as SIG-1) and a value. The value
persists until the next emission and starts at the declaration's initial value (or the type default).
`V(e)` emits with value `e`; `val(V)` reads the value and in the same tick already sees this tick's
emissions, in any region.
**Evidence.** Test 52 (initial 5; `V(3)` in tick 2 read as 3 in the same tick; value kept while absent;
`V(8)`).
**Source.** Section 1.2; `proc/Signal.xtend:171-262`.
**Teaching.** *A valued signal is an event that carries a value; the value stays after the event.*
**Implementation.** Per tick: reset presence and, with a combine, `V_curval` to the neutral element; apply
emissions to `V_curval`; then `if V then V_val = V_curval`; `val(V)` reads `V_val`. Report `V_curval` as
the oracle does: this tick's combined value, the neutral element when nothing was emitted (with a combine),
or the last emitted value (without one).

### V-2 Reading the value and emitting it in the same tick is a cycle
**Rule.** `val(V)` waits for all emissions of `V`. Any emission that depends on `val(V)` in the same tick is
rejected: `V(val(V) + 1)`, `if val(V) < 2 do V(2)` *(probe)*, `seen = val(V); V(seen + 1)` *(probe)*. Use
`pre(val(V))`.
**Evidence.** Test 59 (rejected); test 60 (`V(pre(val(V)) + 1)`: 1, 2, 2, 3).
**Source.** Section 1.2 (`V_val` written after `V_curval`, read by the emission).
**Teaching.** A very common first counter; show the error and the `pre` fix. *To build on a signal's value,
use last tick's value.*
**Implementation.** Falls out of section 1.4 once valued signals are desugared.

### V-3 Without a combine function: one value per tick
**Rule.** Without a combine function (or with `combine none`), concurrent emissions with different values
are rejected and with equal values accepted. One region may emit several times; the last emission wins.
**Evidence.** Tests 53, 55 (rejected); test 54 (accepted, value 1); test 58 (`N(1); N(2)` → 2).
**Source.** `keffects:112-123` (no combine → absolute `V_curval = e`).
**Teaching.** *Two regions emitting different values need a combine function.*
**Implementation.** As C-4 on `V_curval`.

### V-4 Combine functions
**Rule.** With `combine op`, all emissions of the tick are combined, starting from the neutral element:

| `op` | int neutral | 5 and 6 give | bool neutral | true and false give |
| --- | --- | --- | --- | --- |
| `+` | 0 | 11 | | |
| `*` | 1 | 30 | | |
| `max` | -2147483648 | 6 | | |
| `min` | 2147483647 | 5 | | |
| `\|` | 0 | 7 | false | true |
| `&` | **0** (K-4) | **0** | true | false |

`max`/`min` work but warn "Min or max combine operators are currently not supported.". Emissions in one
region combine too (`P(1); P(2)` → 3). For `bool` any combine other than `|` has neutral element `true`
*(probe: `combine +`)*; `float` crashes (K-5); `string` with `+` fails in gcc ("invalid operands to binary +")
*(probe)*.
**Evidence.** Tests 56, 58.
**Source.** `proc/Signal.xtend:338-370` (`neutralElement`); `keffects:112-123`; `validator:781-789`.
**Teaching.** *A combine function says how to merge values emitted in the same tick.*
**Implementation.** Use KIELER's neutral elements exactly, including int `&` → 0, and 32-bit int bounds.

### V-5 Emission without a value
**Rule.** Emitting a valued signal without a value (`V`) sets only the presence. With a combine function the
value becomes the tick's neutral element (0 for `+`); without one it is unchanged.
**Evidence.** Test 57 (`P_val` 4 → 0, `N_val` stays 4).
**Source.** `proc/Signal.xtend:192-196, 213-224, 233-245` (no `V_curval` write for a value-less emission).
**Teaching.** Surprising: a bare emission can erase a combined signal's value. *Emit valued signals with a
value.*
**Implementation.** Falls out of V-1.

### V-6 Valued input signals
**Rule.** The environment sets presence and value (`V`, `V_val`); the value persists like any input.
Emitting a valued input warns "Valued input signals currently do not support emission (overwriting)."; the
presence is set and the value silently dropped.
**Evidence.** Test 63.
**Source.** `proc/Signal.xtend:181-189` (no `_curval` for inputs); `validator:589-595`.
**Teaching.** *Inputs come from outside; don't emit them.*
**Implementation.** No `V_curval` and no `V_val` update thread for inputs.

### V-7 Emissions are not tests
**Rule.** `if V(3) go to …` is not a test of the value; it fails to link ("Couldn't resolve reference to
ValuedObject 'V'.") *(probe)*.
**Evidence.** *(probe)* `v-emit-in-trigger`.
**Source.** Grammar (`SCTX.xtext` `Transition`: the trigger is an expression); `validator:602-620`
("Valued emission cannot be used in triggers. Use val() to check the value of a valued signal." for the
call form).
**Teaching.** *Test values with `val(V) == 3`.*
**Implementation.** Parser/resolver error.

---

## P. `pre` and `val`

### PRE-1 `pre(x)` is last tick's final value; in tick 1 it is the type default
**Rule.** `pre(x)` is the value `x` had at the end of the previous tick. In the first tick (of the declaring
scope, PRE-4) it is the type default (0, `false`), **not** `x`'s initial value. `pre(pre(x))` goes two ticks
back.
**Evidence.** Test 65 (tick 1: `pre(i) = 0`, `pre(x) = 0` although `x = 50`; then 5/50, 6/5/56, 7/6/63).
**Source.** `proc/Pre.xtend:140-192` (`_reg_x` initialised to the type's neutral element; immediate during
action `_pre_x = _reg_x; _reg_x = x`).
**Teaching.** Off-by-one surprise: in tick 1 `pre(x)` is 0 even if `x` starts at 50. *`pre(x)` is what `x`
was when the last tick ended.*
**Implementation.** `pre(x)` reads a per-scope register and does not depend on this tick's writes of `x` (so
`x = pre(x) + i` is fine *(probe)*); the register is updated after all of the tick's writes of `x`.

### PRE-2 `pre` of signals
**Rule.** `pre(S)` is the presence in the previous tick (inputs, outputs, locals). For a valued signal
`pre(V)` is the previous presence and `pre(val(V))` the previous value, which persists while absent.
**Evidence.** Test 66.
**Source.** `proc/Pre.xtend` runs after `proc/Signal.xtend` (`sccharts/system/de.cau.cs.kieler.sccharts.extended.kico`),
so it sees signals as their presence variables and `val(V)` as `V_val`.
**Teaching.** *`pre(S)` asks "was S present last tick?".*
**Implementation.** Apply PRE-1 to the presence and to `V_val`.

### PRE-3 `val` applies only directly to valued signals
**Rule.** `val(pre(V))`, `val(S)` on a pure signal and `val(x)` on a variable are left untranslated and the
C compiler fails ("implicit declaration of function 'val'").
**Evidence.** Test 67; *(probes)* for `val(S)` and `val(x)`.
**Source.** `proc/Signal.xtend:249-261` (only `val(<valued signal>)` is replaced).
**Teaching.** *Write `pre(val(V))`, never `val(pre(V))`.*
**Implementation.** Reject these as errors.

### PRE-4 `pre` restarts when its scope is re-entered
**Rule.** The `pre` register of a variable declared in a superstate is re-initialised when the superstate is
entered: in the entry tick `pre(k)` is 0 again.
**Evidence.** Test 68 (tick 4: `p = 0` after the reset; tick 5: `p = 4`).
**Source.** `proc/Pre.xtend:140-160` (register declared in the variable's scope, initialised by H-3).
**Teaching.** *A fresh scope has no past.*
**Implementation.** Reset the register with the scope's initialisations.

### PRE-5 `pre(x, c)`: a clock, and one memory per variable
**Rule.** `pre(x, c)` (`c` a bool or a signal) only updates its memory in ticks in which `c` holds: there it
is `x` of the previous such tick, in between it keeps that value. KIELER keeps **one** memory per variable:
Pre.xtend collects every `pre` in eAllContents order (a scope's declarations, its actions with their effects
before their trigger, a state's regions, then its outgoing transitions with their effects before their
trigger), pushes them on a stack and pops them; the first one popped for a variable, the **last** one in that
order, creates `_reg_x`/`_pre_x` and its during action with its clock as the trigger, and every other `pre` of
`x` is replaced by the same `_pre_x`, its own clock dropped. So `pre(v, c); pre(v)` are both unclocked,
`pre(v); pre(v, c)` both clocked, two clocks give the last one's, and on a transition `if pre(v, c) > 2 do p =
pre(v)` the trigger's clock decides. The engine reproduces it (passes/pre.ts) with a `kieler-quirk` info at
every `pre` whose clock changes.
**Evidence.** Probes `kieler/rare/probe-pre-clock-*` (8 charts, lab and official KIELER 0.3.0 agree).
**Source.** `proc/Pre.xtend:70-110` (the stack and the `transformedVariables` map keyed by the reference).
**Teaching.** *Don't mix `pre(x)` and `pre(x, c)`: copy `x` into a second variable for the clocked one.*

---

## A. ABRO

### A-1 The Quick Start ABRO
**Rule.** KIELER's Quick Start ABRO (bool inputs, `entry do O = false`, `do O = true join to done`,
`if R abort to ABO`) ignores tick 1 (delayed waits), sets `O` in the tick the second of `A`, `B` arrives,
handles `A` and `B` in the same tick, and resets on `R`.
**Evidence.** Test 69 (verbatim copy of the wiki chart).
**Source.** Wiki `Quick-Start-Guide.md`; T-1, T-2.
**Teaching.** The canonical first example; `O` is a variable here, so it stays true until `R`.
*Wait for A and B in any order, then signal O; R starts over.*
**Implementation.** Integration test of H-1, T-1, T-2 and strong abort.

### A-2 ABRO with signals
**Rule.** With signals, `O` is present for exactly one tick; inputs in the reset tick are ignored (the waits
are delayed).
**Evidence.** Test 70.
**Source.** SIG-1, T-1.
**Teaching.** *With signals, O is a one-tick pulse.*
**Implementation.** Integration test.

### A-3 Strong vs weak reset
**Rule.** When `R` arrives in the same tick as the last of `A`/`B`, a strong reset (`abort to`) suppresses
`O`; a weak reset (`go to`) lets the regions finish and emit `O` first, then resets.
**Evidence.** Test 71.
**Source.** `proc/Abort.xtend` (strong vs weak).
**Teaching.** *Strong abort: R wins. Weak abort: the last words are spoken first.*
**Implementation.** Integration test of T-1 with both preemption kinds.

### A-4 Immediate ABRO is broken in KIELER
**Rule.** With `immediate if A` / `immediate if B` and `A`, `B` present in tick 1, KIELER loses the join and
the chart never reacts again (K-3).
**Evidence.** Test 72.
**Source.** K-3.
**Teaching.** Do not present immediate ABRO as working; use the delayed version.
**Implementation.** See K-3.

---

## K. KIELER defects (observed, reproducible, not language semantics)

### K-1 A region that is only `initial final state` breaks its parent
**Rule (observed).** A region consisting of a single `initial final state` without transitions:
- disables every abort of the parent state (test 20: `if b go to X` never fires);
- makes a triggered join never fire (test 21);
- as the parent's only region, with a trigger-less join, crashes the compiler (test 22; NullPointerException
  in `SuperfluousForkRemover`; lab server: "The compiler failed during compilation setup."; official KIELER
  never reports back). Unlike T-6, the join target's shape does not matter: a plain `state D` crashes too
  *(probe, both servers)*.
A trigger-less join with another region that finishes normally still works *(probe)*.
**Evidence.** Tests 20, 21, 22.
**Source.** `proc/Abort.xtend:297` reuses the region's simple final state as its `_aborted` state, and
`:359-361` deletes it because nothing enters it: the region becomes empty. The priority compiler then
reports "This region has no state left to start in once KIELER has normalized the chart, so KIELER's
priority-based compiler cannot compile it." (lab server).
**Teaching.** *Never write a region that is nothing but a final state.*
**Implementation.** Reproduce: aborts and triggered joins of such a parent never fire; reject test 22's shape.

### K-2 A signal declaration plus a state action blocks termination
**Rule (observed).** A scope that declares a signal and also has an entry, during or exit action never
terminates: its `join to` never fires, and its exit action runs when the inner region finishes although the
state is not left (test 25: `n = 5` in tick 2). In KIELER's simulation the root always has such an action
(the taken-transition reset), so **a root that declares any signal (input, output or local) never reports
termination** (test 24; *probe*: an input signal alone suffices).
**Evidence.** Tests 24, 25.
**Source.** `proc/Signal.xtend:147-160` moves the regions and actions of such a scope into a new non-final
state `_main`; `proc/TakenTransitionSignaling.xtend:97-98` adds the root entry action. Without simulation
(plain netlist C code) the root case needs a user-written root action *(probe, generated C)*.
**Teaching.** Superstates: declare the local signal one level up, or drop the action. *(The guide should
mention it where termination of the root is discussed.)*
**Implementation.** Reproduce: a scope with signal declarations and actions has an extra non-final wrapper.

### K-3 Entry-tick termination inside a reset loop is lost
**Rule (observed).** Superstate S has a trigger-less join and can terminate in the tick it is entered, and S
lies inside a state P whose abort targets P itself (`if R go to P` / `if R abort to P`):
- if the immediate path to the final states is guarded (`immediate if A go to F`), KIELER compiles the chart
  (warning "Potential instantaneous loop.", official "Instantaneous loop detected!") but the join does not
  fire in S's entry tick (test 26, tick 1). Later terminations are joined normally (test 26, tick 5). With a
  strong reset the chart then never reacts again, not even to `R` (test 72);
- if the path is unguarded (`immediate go to F`), and in some strong-abort variants with bool effects, the
  netlist compiler rejects the chart as a causality cycle *(probes)*; compare the structural loop check for
  untriggered joins that terminate immediately in `basics.md` (test `basics/74-loop-through-join-immediate`);
- with an abort to a *different* state, or no abort, everything is correct (T-3) *(probes)*;
- the priority compiler rejects every variant ("The SCG is not IASC-schedulable!").
**Evidence.** Tests 26, 72.
**Source.** Netlist handling of re-entry in the same tick (schizophrenia) in the SCG guard processors
(`guards`, `scg/.../SimpleGuardExpressions.xtend:320-390`); not isolated further.
**Teaching.** Avoid immediate termination inside a reset loop (use delayed waits as in the Quick Start
ABRO). Treat the instantaneous-loop warning as a red flag.
**Implementation.** Faithfully reproducing this is hard; detect the pattern and warn, and expect tests 26
and 72 to differ unless the netlist guard logic is emulated.

### K-4 Integer `combine &` always yields 0
**Rule (observed).** For `int` signals `combine &` uses neutral element 0, so the combined value is always 0.
**Evidence.** Test 56 (`And(5)` ‖ `And(6)` → 0, not 4).
**Source.** `proc/Signal.xtend:347-366` ("UNDEFINED" branch returns 0).
**Teaching.** *Don't use `&` on int signals.*
**Implementation.** Neutral element 0 for int `&`.

### K-5 `float` valued signals with a combine function crash
**Rule (observed).** Any combine function on a `float` signal makes the compiler fail.
**Evidence.** Test 62 ("UnsupportedConstructException: Unhandled parameter types: [null]").
**Source.** `proc/Signal.xtend:338-370` (`neutralElement` has no float case and returns null).
**Teaching.** *Float signals cannot have combine functions.*
**Implementation.** Reject.

---

## R. Everything KIELER rejects in this area

| Construct | Test | Message (official KIELER; lab server additions in brackets) |
| --- | --- | --- |
| Concurrent absolute writes with different values | 29, 30, 41, 53, 55 | "Can't schedule from … to …", "The SCG is NOT asc-schedulable!" [+ "Circular dependency involving x prevents scheduling this tick."]; warning "Instantaneous loop detected!" [lab: "Potential instantaneous loop through x."]; priority compiler: "The SCG is not IASC-schedulable!" |
| Non-commuting relative writes (including old-style `x = x + 1` next to `x += 3` or `x++`) | 32, 75 | same |
| Read/write cycles, signal cycles, false cycles | 35, 46, 47 | same |
| `val(V)` feeding an emission of `V` | 59 | same |
| Non-constant array index next to a concurrent write | 40 | same |
| Immediate termination in a reset loop, unguarded | *(probe)* | same (K-3) |
| `join to` on a simple state | 16 | "A state with a termination transition must have inner behaviour." |
| `join to` on a single region without a final state, target a simple state with an entry or during action | 18 | internal NullPointerException, no answer from the compiler [lab: "The compiler failed during compilation setup."] (with a plain target: accepted, test 77) |
| Single-region `initial final state` with `join to` (any target) | 22 | internal NullPointerException, no answer [lab: "The compiler failed during compilation setup."] |
| Assigning a signal | 50 | "Non-variables cannot be used in an assignment." |
| Emitting a variable | 51 | warning "Non-signals should not be used in an emission.", then a code generation failure [lab: "b is an output bool variable, not a signal, so it cannot be emitted."] |
| Duplicate declaration in the root's scope (or a root region's) | 08 | warning "The variable is declared multiple times in this scope.", then gcc "duplicate member" (official adds "Cannot initialize using an ambiguous VariableStore."); in a superstate only the warning (H-7, test 76) |
| `float` signal with a combine function | 62 | "UnsupportedConstructException: Unhandled parameter types: [null]" |
| `string` signal with `combine +` | *(probe)* | gcc "invalid operands to binary +" |
| `val(pre(V))`, `val(S)`, `val(x)` | 67 | gcc "implicit declaration of function 'val'" |
| `if V(3) …` | *(probe)* | "Couldn't resolve reference to ValuedObject 'V'." |
| A region-local used on the parent's outgoing transition | *(probe)* | "Couldn't resolve reference to ValuedObject 'c'." |

Warnings that do **not** reject: "All or none concurrent regions should have final states.", "Every region
should have a final state whenever its parent state has a termination transition." (tests 17, 77), "The
variable is declared multiple times in this scope." inside a superstate (test 76), "Min or max combine
operators are currently not supported.", "Valued input signals currently do not support emission
(overwriting).", the old relative-write warning, "Actions in regions are highly experimental and may not
produce the expected results.", and the instantaneous-loop warning on charts with a weak-abort self-loop
(tests 04, 05, 64, 68, 71), which behave correctly with the netlist compiler.

---

## Open questions and limits

- K-3's accept/reject boundary (which effects make the netlist compiler reject rather than mis-compile) is
  sampled, not characterised.
- Confluence of semantically equal but structurally different expressions (`x = 1 + 0` vs `x = 1`) and
  `combine host` / combine functions on array signals were not probed.
- Termination of superstates containing dataflow regions or referenced charts (`is`), and interactions with
  suspension and history, are outside this area.

# The simulator (`src/engine/sim`)

The guide's simulator runs SCCharts exactly as KIELER's netlist-based C simulation
(`de.cau.cs.kieler.sccharts.simulation.tts.netlist.c`) does: it rewrites the chart into core SCCharts with
KIELER's own transformations, builds the sequentially constructive graph (SCG), applies KIELER's acceptance test,
and runs the graph tick by tick in a static schedule. KIELER's quirks therefore emerge from the same machinery
instead of being special-cased. Pure TypeScript, no Node or DOM APIs, deterministic.

```
compile() (../index.ts)
  front end: parse, resolve, validate                    ../parser
  compileChart (compile.ts), on first use of ok/diagnostics
    lower.ts        AST -> working model (model.ts); Taken Transition Signaling marks; const inlining (fold.ts);
                    KIELER's MethodSignaling for `state(S)` in methods and StaticAccess for `scchart(C).X`
    passes/         KIELER's processors in KIELER's order (passes/index.ts): Signal, Pre, During, ..., Abort,
                    Initialization, Entry, Connector, Array Assignment
    codegen.ts      what gcc would reject in KIELER's generated C (>>>, val(pre(V)), b = a, C keywords, primed
                    and `^` names, ...)
    scg.ts          core chart -> SCG (Trigger/Effect, Surface/Depth with its depth transition optimisation,
                    SCGTransformation in one step), with KIELER's node order and control-flow creation order
    abortRegions.ts KIELER's SCGAbortRegionProcessor (sequential preemptive forks, par-or joins) and its checks
    sfr.ts          KIELER's superfluous thread and fork removal (and the crashes it causes)
    goblock.ts      tick 1's GO block: KIELER's GO-init behaviour for inputs, B-34 warnings, randomize()
    deps.ts         KIELER's dependency analysis (absolute/relative writes, reads, confluence, commutation,
                    where its search stops)
    analysis.ts     thread path types, loop analysis, schizophrenia curing (structural depth join),
                    synchronizers, dead nodes, acceptance (cycles) and the schedule (kielerSchedule: KIELER's
                    scheduling blocks and their order)
createSimulation() (index.ts)
  exec.ts           netlist-style tick over the schedule; inputs, pool, TickResult, runtime errors
  eval.ts           expressions and effects with C semantics (values.ts, random.ts)
  reasons.ts        what a trigger read when it was checked (the log's check/take/suspend reasons)
  tracker.ts        the source-level configuration (active/entered/exited) driven by the take marks
describeTick()      describe.ts
```

## Provenance

Every element of the working model knows where it comes from: `origin` is the id (`types.ts`) of the source
element it *is* (a moved or copied source transition keeps it), `about` the source element a generated element
implements, and every effect carries `o.by` (the source transition, action or declaration), `o.span` and
`o.hidden` (generated bookkeeping). Two kinds of mark effects ride along through all transformations:

- `{ kind: 'take', transition, index }` is the first effect of every source transition. KIELER's Taken Transition
  Signaling adds the same effect (`_taken_transitions[index] += 1`) before its other processors run, so the
  structure the transformations produce is KIELER's. When it runs, the transition fired: it counts for `taken`
  (in KIELER's index order), logs `take`, and moves the source-level configuration (tracker.ts).
- `{ kind: 'action', action }` is the first effect of every source local action with effects.

Variables made by passes are `generated` (KIELER names them with `_`) and point to the source variable (`of`,
`display`, `decl`), so diagnostics and the log speak about `V`, not `V_curval`.

## Adding a feature (for the preemption and structure workstreams)

1. Find the pass in `passes/` (one module per KIELER processor, already in KIELER's order in `passes/index.ts`).
   A pass without `run` is a placeholder: its `uses(root)` finds the constructs it is responsible for, and
   charts that use them get an `info` diagnostic with code `unsupported` and cannot be simulated
   (`createSimulation` reports it as the error of every step). `compile().ok` stays true: KIELER accepts the chart.
2. Implement `run(ctx)` by porting KIELER's processor (`../kieler-server-fork/modules/sccharts/src/de/cau/cs/kieler/
   sccharts/processors/<Name>.xtend`) onto the working model. `model.ts` has KIELER's extension methods with the
   same names and semantics (`createState`, `createControlflowRegion` with its reuse of an empty implicit region,
   `createTransitionTo`, `setHighestPriority`, `isImplicitlyImmediate`, `isImmediate`, `regionsMayTerminate`,
   `canImmediateTerminate`, `getOrCreateSimpleFinalState`, `allStates` in KIELER's pre-order, ...). Iterate over
   snapshots (`allStates(root)` returns an array) where KIELER calls `.toList`.
3. Keep provenance: set `about` on generated states, regions and transitions to the source element they
   implement (`state.origin ?? state.about`), copy effects with `copyEffect` (marks and origins come along), mark
   bookkeeping assignments `o: { hidden: true }`. Report problems with `ctx.report(diagnostic)`: a clear message,
   a `hint`, KIELER's text in `kieler`, `related` element ids, and `code`: `kieler-quirk` (info) for reproduced
   rule-like quirks, `kieler-bug` (warning) where the simulator deliberately does the intended thing.
4. Remove the `uses` (or keep it for documentation) once `run` covers it, and check
   `tests/conformance/engine.test.ts`: charts that were skipped as unsupported are now compared with KIELER.
   Remove now-passing entries from `tests/conformance/engine-expected-failures.json` (the run prints them).
5. Things beyond SCCharts processors: new expression or effect kinds are evaluated in `eval.ts` (method calls go
   to structure/methods.ts); `hostCode.ts` reports host code and extern calls, which cannot run in the browser.

Do not special-case behaviour in the executor if a transformation can produce it: the acceptance test (cycles,
schizophrenia) depends on the graph KIELER builds.

## Preemption: history, suspend, count delays, weak suspend, deferred, final and abort regions

The preemption passes (preemption.md) are ports of KIELER's processors, in KIELER's order (passes/index.ts), so
the quirks of P-20, P-23, P-30, P-38, P-42..P-44, P-46, P-51 and P-54 come out of the rewriting itself. Shared
helpers (EMF iteration orders, `and`/`not`, deep copies, DoNotDefer, tracker marks) are in passes/contained.ts.

- **History** (passes/history.ts) also runs the static quirk checks (passes/quirks.ts, `kieler-quirk` infos for
  P-12, P-20, P-23, P-30, P-38, P-42..P-44) before anything is rewritten. It only processes top-level targets and,
  recursively, states inside history targets (P-51); the history KIELER really applies is put on the take mark
  (`history`), and each region's record (`_H<state>` and the source state of each value) on
  `root.ext.historyRecords`, so the tracker resumes exactly what KIELER resumes.
- **Suspend** (suspend.ts): the `_enabled` flag guards every contained action and transition; flags are listed
  on `root.ext.suspends` and the executor logs a `suspend` event for every active state whose flag says it was
  suspended in the tick (preemptionLog.ts). A suspend without trigger is rejected (`suspend-without-trigger`).
- **Count delays** (countDelay.ts): counter, DoNotDefer entry reset, during count, `pre(counter) == n - 1`.
- **Weak suspend** (weakSuspend.ts): bookmarks, `_WS`, `_Init`, `_lastWishDone`, exit actions moved onto
  `__exit` states; the way back is a shallow deferred transition carrying a `resume` mark.
- **Deferred** (deferred.ts): simple delay, simple guard or a copy of the state (complex), chosen per target as
  KIELER does. Simple delay sets `deferEntry` on the take mark and an `enterRegions` mark on the delayed entry, so
  the tracker enters the state's regions one tick late. A copy keeps the `initial` flag (EcoreUtil.copy), and
  scg.ts picks the region's start as KIELER's SCG does after Surface/Depth moved pause states to the end.
- **Final regions** (finalRegion.ts): all states final. **Abort regions** (../abortRegions.ts, P-62): KIELER's
  SCGAbortRegionProcessor on the SCG, after it is built and before the superfluous fork remover. A state's fork
  becomes a sequential preemptive fork with a par-or (`any`) join; several content regions are nested into a thread
  of their own, with KIELER's node and flow order. analysis.ts then gives the threads KIELER's sequential order
  (SimpleGuardTransformation's control dependencies between duty nodes), the entry guard (a later thread does not
  start when an earlier one finished in the tick) and the depth guard (threads 0 .. i-2 only: the region just
  before an abort region still reacts in the tick it finishes), the par-or synchronizer and its liveness rule;
  deps.ts treats the threads as not concurrent; ThreadAnalyzer's path type degradation is ported. exec.ts kills
  the depths inside a par-or join's threads after it fired (`!pre(join)`) and the tracker leaves the states inside.
  The order checks (`abort-region-order`, `abort-region-alone`) run on the SCG's forks (passes/abortRegion.ts), so
  states that cannot be reached are not checked; a preemptive fork in an instantaneous loop is rejected
  (`abort-region-loop`, "Sequential forks must not be schizophrenic!"); a state re-entered in the tick it finishes
  (KIELER's thread reincarnation guards) gets the `unsupported` info.

The marks `enterRegions` and `resume` have no KIELER effect (scg.ts gives them weight 0). exec.ts hands the take
mark's refinements and the hooks to preemptionLog.ts, which moves the tracker and writes plain-English `note`
events; describePreemption.ts adds describeTick's sentences (what a strong or weak abort meant for the inside,
count delays, suspended states, the notes).

## Structure: references, for-regions, dataflow, time, methods

The structure passes (structure.md) are KIELER's processors too, so their quirks come from the same rewriting:

- **References** (passes/reference.ts, with dataflow.ts and inheritance.ts, which KIELER's Reference processor
  calls): every instance is a fresh lowering of the referenced chart's AST with its ids prefixed
  `<reference state>/` (structure/instance.ts), so its variables are its own and its elements report ids the
  diagram can draw (an expanded reference uses the same ids). Binding is substitution (structure/rewrite.ts walks
  every expression, target, method body, reference argument and equation). An instance's transitions carry `take`
  marks with index -1: no KIELER effect (scg.ts gives them weight 0), not counted (S-15), but the tracker follows
  them. Expansion order and placement are KIELER's (the copy is appended to the region; output initialisations
  are entry actions after the chart's own; dataflow regions, then `ref` declarations, then the references the
  dataflow created).
- **For-regions** (passes/forRegion.ts): copies are deep copies (structure/copy.ts) with the counter replaced and
  constants folded (KIELER's Const). Their take marks keep the original's id and index and get a `key` per copy;
  structure/track.ts gives the tracker a view of the chart with every instance and every copy, and reports copies
  by their source ids.
- **Dataflow** (passes/dataflow.ts): equations become regions (or, when they call methods, immediate during
  actions); `;` sequences get KIELER's user schedules, which passes/userSchedule.ts copies onto the effects and
  deps.ts orders by priority before initialise-update-read.
- **`->`, `fby`, `sfby`** (initOperator.ts, followedBy.ts, sequentialFollowedBy.ts, structure/delays.ts): helper
  regions and variables with KIELER's names and inferred types (an UNKNOWN type is rejected as KIELER's
  simulation does; two unrenamed helpers at the chart's top level clash in C).
- **Time** (period.ts, timedAutomata.ts): `period` becomes a clock, a `tick` flag guarding everything inside and a
  Period region; clocks become delayed during actions `t += deltaT` and sleep requests `if t < b do sleepT min=
  b - t` on the states of the region that tests them, after `sleepT = maxSleep` at the start of the tick. With
  @ClocksUseSD the declaring state advances the clock and a schedule (KIELER's ClockIUR: increment, resets,
  updates, the last confluent; deps.ts honours the protocols) orders its writes; every state inside asks for sleep.
- **Classes, structs and enums** (lower.ts): an instance's members are variables `<instance>.<member>` of the
  declaring scope (marked `member`, reported as the object `<instance>` in the pool), its methods methods of the
  instance whose bodies use those variables; @UnpackClass gives KIELER's `<instance>_<member>` variables instead.
  KIELER's Enum processor is a substitution: `ref E x` is an int, `E.V` the int of V's position. Host classes and
  host enums need C code (passes/unpackClasses.ts, passes/enum.ts report them).
- **Methods** (lower.ts lowers bodies to `CStmt`; structure/methods.ts): KIELER's SCG Methods processor inlines
  simple methods (and `@inline` ones; with a loop that is an unschedulable cycle, `inline-loop`) into the SCG after
  the superfluous fork removal (compile.ts), labels and `goto`s included (a jump back is a cycle in the tick, which
  the analysis rejects: S-44b); the others are interpreted as C functions at run time (eval.ts calls
  compileMethodCall), with the jumps KIELER's structured C code keeps: forward ones (a jump back ends the method). Their bodies' accesses count as the calling node's for the dependency
  analysis (deps.ts innerAccesses, KIELER's processInnerAccesses), with the calling node's operator deciding whether
  updates commute. Code effects are methods `_effect<n>` (lowered in place).
- **Charts used as classes** (passes/reference.ts redirectMembers, structure.md S-65): `ref C c` without bindings
  expands an instance of C; `c.x` and `c.m()` in the declaring chart mean the instance's field and method; an
  instance without fields is `{}` in the pool. Inheritance (passes/inheritance.ts) renames inherited private and
  protected fields `<Base>_<field>` and makes an override replace the base method in the base's own bodies, except
  when the override calls `super` (KIELER's defect, S-66).
- **Static and global** (static.ts): moved to the root, statics under KIELER's hierarchical name (in the pool).
- **Special access** (lower.ts, structure.md S-69, S-70): `state(S)` in a method body reads a bool flag of the state
  around `S`'s region, set by an entry and cleared by an exit action that the lowering gives `S` (KIELER's
  MethodSignaling); `scchart(C).X` is the value of `C`'s constant `X` (KIELER's StaticAccess copies the declaration and
  Const inlines it), and what KIELER cannot copy is reported (`static-access`). An expression the lowering cannot
  represent becomes an `unsupported` info at compile time (compile.ts `leftovers`).
- **Host code** (hostCode.ts): accepted, never simulated ("cannot run in the browser").

## Semantics notes

- **Acceptance.** KIELER rejects a chart when the guard graph of its netlist has a cycle. The simulator builds
  the same graph at node level: control flow within a tick, concurrent non-confluent data dependencies, and each
  join's synchronizer inputs (instantaneous: its first thread's exit; depth: the exits of the non-instantaneous
  threads; surface: those exits and every pause surface of those threads). Before that, it runs KIELER's loop
  analysis and structural depth join: forks inside an instantaneous loop with a potentially instantaneous
  thread are cured by copying the loop's nodes of that thread; the copies, reached when the thread starts, cannot
  reach its exit. That is why weak-abort self-loops on superstates are accepted, and why an entry-tick
  termination inside such a loop is lost (concurrency.md K-3) exactly as in KIELER. Details that decide the
  outcome in bigger charts, all as in KIELER: the critical nodes stay those of the first loop analysis for every
  cure (StructuralDepthJoinProcessor keeps its first LoopData); `hasConcurrentDelay` and `propagateDelay` search
  the incoming control flows in KIELER's EMF order (scg.ts gives every flow its creation rank: state by state in
  region order, generated states after written ones, flows into final states moved to the region's exit last,
  rewired flows appended); effect chains of a transition are shared by its surface copy and depth original.
- **Dead nodes.** KIELER's basic block analysis (BasicBlockTransformation) is one pass in block creation order,
  not a fixpoint: a block is alive if a predecessor block created before it is alive, a join if no (non-final)
  thread exit block is dead, a depth if its surface is alive. Blocks come from a depth-first walk from the root
  entry, then from the remaining nodes in node order; a cured fork's copy has no join (EMF does not copy the
  two-way fork/join link), so the walk does not continue after it. That reproduces K-1, joins with a region
  without final states, and superstates whose join is only reached through a cured copy (never left, as in
  KIELER's code, whose dead blocks have the guard `false`).
- **Schedule.** KIELER's netlist emits code per scheduling block (a basic block cut where a node has an incoming
  concurrent dependency): guard, then the block's nodes. kielerSchedule orders the blocks as SimpleGuardScheduler
  orders their guards: depth first in creation order, pulling in dependencies in KIELER's order (control
  dependencies, data dependencies by source node, the guard expression's references). Values do not depend on the
  order; `random()` and `print` do. The acceptance test stays on the node graph (no chart of the recordings or the
  fuzz campaigns has a cycle among blocks but not among nodes; `Analysis.blockCycle` would show one).
- **Execution.** Each tick visits the alive nodes in the static schedule once. A node runs if a predecessor
  activated it this tick, a depth if its surface was reached last tick, a join by its synchronizer rule (some
  counted thread exits now; every other counted thread has no pause reached now (surface) or resumed now
  (depth)). The root's exit is KIELER's `_TERM`. Every condition is computed when the schedule reaches it, whether
  it is active or not, as KIELER's netlist code computes each conditional's guard `_c<g>` in every tick (random()
  and C functions in triggers run, a division by zero there stops the run); the guard is a `char` that keeps its
  value, which a conditional without else (`c ? a`) gives when `c` is false (basics.md B-22, B-24).
- **Memory.** An index outside its array reads or writes what lies there in KIELER's struct of the chart's
  variables (memory.ts, basics.md B-28): the top-level declarations in written order, byte by byte; beyond the part
  the guide can lay out, a runtime error.
- **Inputs.** Persist (B-9); KIELER's GO-init moves tick-1 assignments of inputs that read no input before the
  first inputs (B-7; goblock.ts). The GO block is the root entry's basic block: it ends where control flow also
  arrives from elsewhere (an initial state a transition returns to), so such a state's entry assignments run in
  tick 1 after the inputs are read; unknown keys stay in the pool as in KIELER's server; strings from the
  environment are fresh pointers every tick (B-26).
- **Runtime errors.** Division by zero, `INT_MIN / -1`, index out of range, unsupported calls: the tick is not
  applied (KIELER's process would crash) and every later step repeats the error.

## KIELER defects the simulator reproduces

Found by differential testing against the oracle (random charts, several hundred); each has a probe chart with a
KIELER recording in `tests/engine/kieler/` (part of the conformance run, area `kieler-probes`).

- **Surface/Depth crash** (scg.ts): KIELER's SurfaceDepth runs on every state, reachable or not, and treats a
  state whose first two outgoing transitions are an immediate triggered and an immediate default one, both
  without effects after Trigger/Effect, as an already built conditional; with four or more transitions it
  deletes by a shrinking index and throws `IndexOutOfBoundsException`. Error `kieler-crash`.
- **SuperfluousForkRemover crashes** (sfr.ts): after the superfluous thread remover, a fork left without
  threads outside the root, or a single-region superstate whose named region's thread entry cannot be found,
  makes KIELER throw ("The compiler failed during compilation setup."). Error `kieler-crash`.
- **Conditional with equal branches** (scg.ts): the netlist gives a conditional whose then and else lead to the
  same node the guard `(g && c) || (g && c)`, so the else path never passes control. It arises in the watcher
  region of a superstate with several delayed strong aborts, the last without trigger. Reproduced, with a
  `kieler-quirk` warning.
- **Lost terminations in cured loops** (analysis.ts): concurrency.md K-3, with a `kieler-quirk` warning.
- **Chance** (compile.ts, analysis.ts): when several superstates qualify for the schizophrenia cure at once,
  KIELER takes the first in a hash map of EMF objects (ThreadData.forkMap), an order fixed within a run that
  changes from run to run, and some charts are accepted in some runs and rejected in others (measured on six
  random charts: from 2 of 12 to 15 of 20 runs accept), others behave differently (an immediate transition fires
  in some runs and not in others). The analysis cures in node order and records every choice; compile.ts then
  analyses the other paths through the choices (AnalysisInput.script: the forks that can be first in an order
  consistent with the earlier choices; forks concurrent to all others cannot change each other's cure and are not
  tried; at most 24 analyses). Some path rejects and another accepts: `kieler-nondeterministic` (with the reason of
  the runs that reject it); all accept but cure different superstates: a `kieler-quirk` info that the chart may
  run differently from one compilation to the next.
- **Where `pre` may stand** (passes/pre.ts): KIELER's Pre processor only replaces a `pre(...)` whose direct
  container is an assignment, an operator, a transition trigger or an index; as a whole argument of print or a
  call, an element of a vector or a declaration's initial value it fails (`pre-placement`, the lab server's
  messages). As the whole trigger of a state action official KIELER fails too, but SCCharts Lab compiles it with
  a divergence warning; the guide does the same (`kieler-divergence`).
- **Preemption** (passes/): everything in preemption.md that is a rule-like quirk of KIELER's expansions is
  reproduced (P-20, P-23, P-30, P-38, P-42..P-44, P-46, P-51, P-54), with `kieler-quirk` infos where a chart can
  show it. Found while porting, with probes in `tests/engine/kieler/preemption/`: a deferred entry is not recorded
  by history (Deferred removes the target's entry actions, including History's `_H = k`), so history resumes the
  state before it; Deferred's copy of an initial state stays initial, and which initial state the region starts in
  then depends on Surface/Depth's reordering; Suspend guards the actions of nested suspended states with the outer
  flag, but not the inner state's own flag updates; the delayed entry Deferred creates is not guarded by a
  suspend (it is created later), so a deferred superstate entered while its parent is suspended starts its inner
  states anyway and their entry actions, which the suspend does guard, are lost.
- **Dead-block order and the GO block** (analysis.ts, goblock.ts): see the semantics notes; probes in
  `tests/engine/kieler/` (`probe-dead-block-order`, `probe-go-block-*`, `probe-cure-order-incoming-flows`).
- **DTO across states** (scg.ts): Surface/Depth's depth transition optimisation does not stop at the state: when
  the state has exactly one incoming transition, an immediate one, it compares the depth's next transition with the
  first other transition of that transition's source and merges them too, so the depth continues in the
  predecessor (typically the connector the Abort transformation puts before the target of a join; its transition
  then counts again in every tick). Probe `probe-dto-into-connector`.
- **Referenced charts without take counters** (scg.ts): KIELER's Taken Transition Signaling only counts the
  simulated chart's transitions, so a referenced chart's transitions often have no effects at all, and
  Surface/Depth's clean-ups and the netlist treat them so: a state whose only way on is an immediate untriggered
  transition is merged into the target (the tracker follows it, scg.ts silentHops), an untriggered immediate
  self-loop (or a cycle of them) leaves its state without transitions and without a node (its region counts as
  finished), and a triggered and an untriggered transition to the same state are the equal-branch conditional.
  KIELER's SCG gives a thread's entry a flow without target into such a node-less state, and no flow at all to other
  transitions into it; its dependency search (DependencyTransformationV2, a depth-first walk with a stack that loops
  while the top is not null) stops at the first, and throws on the second when it is a conditional, depth or join.
  deps.ts dependencyReach walks the graph the same way: the nodes it has not reached have no accesses (and
  compile.ts warns, naming the variables whose concurrent accesses are left unordered), or the chart is rejected
  with `kieler-crash`. Before that, the fork of a single-region superstate whose region starts in such a state is
  removed with its flows re-routed to nothing (sfr.ts): KIELER's ThreadAnalyzer throws on them unless they are a
  thread entry's. Probes `structure/probe-reference-*`.

- **Found in the final polish** (probes `tests/engine/kieler/rare/`): backward `goto`s in inlined bodies are cycles,
  in C functions they are dropped (`probe-goto-*`); a conditional without else is the assignment's target or the
  condition's previous result (`probe-cond-noelse-*`); every condition runs every tick (`probe-trigger-*`); `pre(x)`
  and `pre(x, c)` share the memory of the last one (`probe-pre-clock-*`); indices outside an array follow KIELER's
  struct (`probe-overflow-*`). Two defects of KIELER itself, found by the `polish` fuzz profile and present in official
  0.3.0 too: the netlist code generator drops a variable index of an array element in a condition when a plain
  variable follows and none precedes it (`ov[n] > 0 && a` tests the array's address; guardIndices.ts,
  `probe-index-dropped-*`), and a `goto` in a code block finds a label of the same name in an earlier block of the same
  state, which crashes the compiler (compile.ts labelClashes, `probe-label-*`).
- **Found in round 3** (probes in `tests/engine/kieler/`): a method with parameters and an empty body makes gcc
  fail on KIELER's code (`empty-method`, `structure/probe-empty-method-*`); a method or code block KIELER does not
  inline gives its body's accesses to the calling node, an assignment with `=`, so its `x += 1` conflicts with a
  concurrent `x += 1` (deps.ts innerAccesses, `structure/probe-method-inner-*`); a state with abort regions whose
  code is dead makes SimpleGuardTransformation throw (`preemption/probe-abort-region-dead-*`); an abort out of a
  superstate whose trigger is emitted inside by a transition with a count delay cannot be scheduled, weak or strong
  (without the count delay it can; `preemption/probe-abort-trigger-inside-*`).

## Known deviations (deliberate)

- B-34 (GO-init reorders tick-1 assignments around input reads, and ignores inputs in array indices) and B-35
  (partial assignment evaluation ignores compound operators): intended semantics, with a `kieler-bug` warning
  for B-34 patterns.
- Where KIELER's scheduler takes dependencies from a hash map (some synchronizers' guards), the order of
  concurrent `random()` calls and prints may change from run to run in KIELER; the guide takes thread order.

## Files

| File | |
| --- | --- |
| `index.ts` | `createSimulation`, `Simulation`, re-exports |
| `compile.ts` | `compileChart`: the pipeline and its diagnostics |
| `model.ts` | the working model and KIELER's helpers |
| `lower.ts`, `fold.ts` | AST to model, TTS marks, const inlining and folding |
| `passes/` | KIELER's processors (`index.ts`: the order) |
| `scg.ts`, `sfr.ts`, `goblock.ts` | the SCG and KIELER's clean-ups of it |
| `deps.ts`, `analysis.ts` | dependencies, loops, curing, synchronizers, acceptance, schedule |
| `exec.ts`, `eval.ts`, `values.ts`, `random.ts` | running ticks |
| `memory.ts` | KIELER's struct layout, for indices outside an array (and the warnings for constant ones) |
| `guardIndices.ts` | the indices KIELER's C code drops in conditions (its sequentializer defect) |
| `reasons.ts` | the values a trigger read when it was checked (log reasons, describeTick) |
| `abortRegions.ts` | abort regions on the SCG (KIELER's SCGAbortRegionProcessor) |
| `tracker.ts`, `describe.ts` | source-level configuration, plain-English tick descriptions |
| `describeStructure.ts` | descriptions of instances, for-region copies, clocks, periods and dataflow |
| `preemptionLog.ts`, `describePreemption.ts` | the preemption passes' log events and notes (history, deferred entries, weak suspend, suspended states) and describeTick's sentences for aborts, count delays and suspension |
| `structure/` | the structure passes' helpers: instances (`instance.ts`), deep copies (`copy.ts`), rewriting every expression (`rewrite.ts`), the tracker's view (`track.ts`), `->`/`fby`/`sfby` helpers (`delays.ts`), methods (`methods.ts`: inlining and running) |
| `STATUS.md` | what works now |
| `tests/engine/kieler/` | probe charts for the KIELER defects above, with recordings |
| `../../../tools/fuzz/` | the differential fuzzer (generator, runner, reducer) |

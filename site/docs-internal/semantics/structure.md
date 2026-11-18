# Semantics: structure (reuse and larger-scale constructs)

Scope: files with several charts, references (`state S is C(...)`, `ref` declarations), bindings, imports,
`region ... is super.R`, for-regions, dataflow regions (`->`, `fby`, `sfby`, `pre`, sequential equations,
chart instances), Timed SCCharts (`clock`, `deltaT`/`sleepT`, `period`, timing annotations), methods and code
effects (with SCL statements), enums, structs, classes, charts used as classes and inheritance between charts,
host code (`extern`, backticks, `#hostcode*`, `host` types), `print`, strings and `random()` in the C
simulation, `static` and `global`, and the compilation/simulation systems.

Everything here was established with the oracle (the sccharts-lite server, which compiles exactly as KIELER
does; netlist-based C simulation unless a rule says otherwise) and by reading the KIELER sources. Every rule
names its evidence: a chart in `tests/conformance/structure/` (recorded in `<name>.oracle.json`, checked by
`structure.test.ts`) and, where a chart would add little, a throwaway probe whose result is quoted. Source
paths are relative to `../kieler-server-fork/modules/`; `processors/` means
`sccharts/src/de/cau/cs/kieler/sccharts/processors/`.

Conventions: "tick n" is the n-th reaction (tick 1 enters the initial states). "Pool" is the oracle's data
pool after a tick. Generated helper variables start with `_` and are hidden from the pool. KIELER's messages
are quoted exactly, including their oddities.

Contents: 1 [Several charts in a file](#1-several-charts-in-a-file) · 2 [References](#2-references) ·
2a [Generic parameters](#2a-generic-parameters) ·
3 [Imports](#3-imports) · 4 [For-regions](#4-for-regions) · 5 [Dataflow](#5-dataflow) · 6 [Time](#6-time) ·
7 [Methods and code effects](#7-methods-and-code-effects) ·
8 [Object-oriented data: enums, structs, classes](#8-object-oriented-data-enums-structs-classes) ·
9 [Host code](#9-host-code) · 10 [`static` and `global`](#10-static-and-global) ·
11 [Compilation and simulation systems](#11-compilation-and-simulation-systems) ·
12 [What KIELER rejects](#12-what-kieler-rejects) · 13 [Notes for the oracle and the engine](#13-notes-for-the-oracle-and-the-engine)

---

## 1. Several charts in a file

### S-1 The first chart is the one that is compiled and simulated

A file may hold any number of `scchart` roots. KIELER compiles and simulates **the first one** in the file.
The others exist only to be referenced; after reference expansion they are deleted from the model.

- Evidence: `01-two-roots-first-wins` (tick 2: `X = true`, there is no `Y`), `24-region-is-super` (the first
  chart, which extends the second, is simulated), `28-duplicate-root-names`. Probe: with `Beep` first and
  `Main` (which references `Beep`) second, `Beep` itself is simulated.
- Source: `processors/Reference.xtend:163-184` (`model.rootStates.head`, then
  `model.rootStates.removeIf[ it !== firstRoot ]`); `processors/TakenTransitionSignaling.xtend:77` (taken
  transitions only for `rootStates.head`). The simulation highlighter also uses `rootStates.head`
  (`sccharts.ide/.../SimulationStateTracker.xtend:102`).
- No annotation or pragma selects another chart: the reference processor always takes `rootStates.head`
  (searched `processors/` and the simulation code). To run another chart, move it to the top or into its own
  file.
- Teaching: put the chart you want to run first; helper charts go below it (or in imported files). Plain
  English: "KIELER runs the top chart in the file."
- Implementation: `compile()` defaults to `program.charts[0]` (early versions of `types.ts` and ARCHITECTURE.md
  said "the last scchart"; that was wrong). The interface (inputs, outputs) is the first chart's.

### S-2 The whole file is linked and validated, but only the first chart is scheduled

A link or validation error in any chart of the file rejects the file. Problems that only the scheduler finds
(causality cycles, write-write conflicts) are found only in the simulated chart and the charts it references.

- Evidence: `27-err-second-root-link-error` ("Couldn't resolve reference to ValuedObject 'q'." in the unused
  second chart). Probe: a second, unreferenced chart with two regions writing `p = 1` / `p = 2` concurrently
  compiles and the first chart runs.
- Teaching: an unused chart can still break your build with a typo, but not with a causality problem.
- Implementation: parse, resolve and validate every chart; run the causality/scheduling analysis only on
  `charts[0]` after reference expansion (which pulls in exactly the charts it uses).

### S-3 Duplicate chart names: warning, first one wins

- Warning (editor diagnostic, severity warning): `There are multiple root states with the same name. 'St28Twin'`.
- Evidence: `28-duplicate-root-names`. Source: `sccharts/src/.../text/validation/SCTXValidator.xtend:647`.
- Teaching: give every chart its own name; a copy-pasted chart keeps the old name and is silently ignored.
- Implementation: warn on the second and later charts of a name; which one a reference `is Name` resolves to
  is unspecified in KIELER (hash order, S-5), so the engine may simply take the first.

---

## 2. References

### S-4 `state S is C(args)` is macro expansion

A referencing state is replaced, at compile time, by a **copy** of the referenced chart `C`'s body:
declarations (minus the bound inputs/outputs), root-level actions, regions. The copy keeps the referencing
state's name, label, `initial`/`final` flags and annotations, and takes over its incoming and outgoing
transitions. After that it behaves exactly like a superstate written in place (hierarchy, preemption,
termination, suspension, history all apply as to any superstate).

- Evidence: `02-reference-explicit`, `08-reference-instances-are-independent`, `12-reference-root-actions`.
- Source: `processors/Reference.xtend:264-379` (`expandReferencedScope`: copy at 274, transitions moved at
  341-346, bound I/O declarations removed at 362).
- Teaching: a reference is "paste the other chart here, with these wires". Two references are two independent
  copies. Plain English: "`is` makes a fresh copy of the chart inside this state."
- Implementation: expand references before anything else (they are the first processor of the chain). A
  reference may itself contain references (expand recursively, with the bindings of the outer copy applied).

### S-5 What a reference can name

`C` resolves against every root chart of every file loaded into the compiler: the same file (earlier or later,
forward references are fine) and imported files (S-20). Charts in other files of the same folder are **not**
visible without an `import`.

- Evidence: `02` (C below the referencing chart), `16-import`. Probe: no `import`, `beep.sctx` in the same
  folder → `Couldn't resolve reference to NamedObject 'Beep'.`
- Source: `sccharts/src/.../text/scoping/SCTXScopeProvider.xtend:117-134` (state context: all root states of
  the resource set, plus the root's generic type parameters), `:409` (`getAllAvailableRootStates`).
- Unknown name: `Couldn't resolve reference to NamedObject 'Nope'.` (link error).
- Teaching: a reference names a chart, not a file; another file's charts become visible through `import`.
- Implementation: build one name table from the main file's charts and all imported files' charts. KIELER
  collects them in a hash set, so with duplicate names the winner is unspecified; prefer the main file.

### S-6 Binding by order and explicitly; the binding pointer

The **formals** of `C` are its `input` and `output` valued objects in declaration order (each name of a
multi-name declaration in order; a declaration that is both `input` and `output` appears once). Arguments are
processed left to right with a pointer into that list, starting at 0:

- `actual to formal` (explicit) moves the pointer to `formal`, binds it, and advances the pointer by one;
- `actual` alone (by order) binds the formal at the pointer and advances it.

So **after an explicit binding, the next positional argument binds to the formal declared after it**, not to
the first unbound one. An argument when the pointer is past the end is an error:
`A Valued Object is supposed to be bound, but there is no free Valued Object left in the referenced scope: extra`.
`to` names that are not formals of `C` are link errors (`Couldn't resolve reference to ValuedObject 'nope'.`).

- Evidence: `03-reference-order`, `05-binding-order-continues-after-explicit` (`Sum(1 to b, 2, o, z to a)` →
  `a = 7, b = 1, c = 2` → `o = 712`), `18-err-too-many-arguments`. Probe: `Sub(1 to b, 2, o)` with formals
  `a, b, c, d` leaves `a` unbound → error (S-7).
- Source: `sccharts/src/.../extensions/SCChartsReferenceExtensions.xtend:91-158`; the editor validation uses
  the same function (`SCTXValidator.xtend:977-1013`), so editor and compiler agree.
- Teaching: explicit bindings (`local to remote`) are the safe kind; order bindings break silently when the
  referenced chart's declarations are reordered. Plain English: "`x to y` wires your x to its y."
- Implementation: binding errors are reported once per referencing state as
  `The referencing binding is erroneous!\n<message>` (editor) and `There are binding errors in a referenced
  state!\n<message>` (compiler), followed by follow-up errors ("The valued object reference points to a valued
  object (second) that is not contained in the model!", "References objects are not contained in the
  resource!"). The useful part is `<message>`.

### S-7 Implicit binding by name, with a warning

Formals left unbound after the arguments are bound **by name** to the valued object of the same name visible
at the referencing state: a local, input, output or signal of any enclosing scope up to the root. The editor
warns, listing the names, each followed by ", ":

    Valued Objects are bound implicitly!
    second, 

(the message really ends with ", "; with two names: `second, beep, `). `is C` and `is C()` bind everything
implicitly. If no such name is visible:
`Valued object in the referenced scope was not bound properly: second`.

- Evidence: `04-reference-implicit`, `17-err-missing-binding`. Probes: implicit binding to a parent *local*
  (`int a = 9` → `o = 9`) and to a variable of an enclosing superstate (`o = 4`), each with the warning.
- Source: `SCChartsReferenceExtensions.xtend:161-207`; warning text `SCTXValidator.xtend:1007` (the
  `replaceFirst` that was meant to drop the last ", " discards its result).
- Teaching: implicit binding is handy for big interfaces but fragile; the guide should show explicit bindings
  first and mention the warning. Plain English: "anything you don't wire is wired to the variable of the same
  name, with a warning."
- Implementation: after the argument loop, look each unbound formal's name up from the referencing state
  outwards (state, enclosing states, root; declarations of all kinds); emit the warning once per reference,
  only for `state ... is` references (not for `ref` declarations, which bind implicitly without warning).
- Inside a referenced chart the lookup ends at that chart's copy, and a name that is an input or output of the
  copy means what it is bound to: `Outer(a to x, p to o)` with `state T is Inner` inside binds `Inner`'s `x` to `a`,
  not to a variable `x` of the chart around `Outer` (`tests/engine/kieler/structure/probe-reference-nested-implicit`;
  `SCChartsReferenceExtensions.xtend:161-181`, the names on the replacement stack, S-74).

### S-8 What can be bound

| Actual | Formal input | Formal output |
| --- | --- | --- |
| variable or signal | yes | yes |
| array (whole) | to an array: yes; to a scalar: error `It is not possible to bind array a to scalar v!` | same |
| array cell `a[1]` | to a scalar: yes | yes (probe) |
| literal (`true`, `3`) | yes: the formal becomes that constant | error `It is not possible to bind the literal false \n                    to the output beep !` (sic: newline and 20 spaces) |
| any other expression (`a && b`, `x + 1`) | compile error, no editor diagnostic: `A binding for the valued object reference "second" exists, but the type "de.cau.cs.kieler.kexpressions.impl.OperatorExpressionImpl" is not supported.` | same |

Types are **not checked**: a `float` bound to a `bool` input compiles (probe). Pure and valued signals bind to
signals (`14-reference-signals`); binding a `bool` variable to a signal formal or a signal to a `bool` formal
fails (probes: `O is an output bool variable, not a signal, so it cannot be emitted.`, lab server wording of a
KIELER code-generation crash; and a scheduling cycle "Circular dependency involving o").

- Evidence: `06-reference-literal-input`, `15-reference-arrays`, `19-err-literal-to-output`,
  `20-err-expression-binding`, `25-err-array-to-scalar`.
- Source: `kexpressions/src/.../kext/extensions/KExtReferenceExtensions.xtend:167-211`;
  `processors/Reference.xtend:746-756` (expression actuals).
- Teaching: wire variables (or constants into inputs), never expressions: compute `a && b` into a variable in
  the parent and pass that. The editor does not flag an expression; only compiling does.
- Implementation: accept a reference (optionally indexed) or a literal; reject the rest with the compiler's
  message (it is not an editor diagnostic). Do not type-check.

### S-9 Binding is substitution

Inside the copy, every occurrence of a bound formal is replaced by its actual. Consequences:

- An output formal **is** the parent's variable: writes are immediately visible to the parent and to its other
  regions in the same tick (`14`: `Beat` emitted by the instance is seen by a sibling region in the same tick).
- Writing an input formal writes the actual (`13-reference-input-written-through`: `a += 1` increments the
  parent's `z`).
- One variable bound to two outputs is written by both, in the instance's own order (probe:
  `Sub(o to b, o to c)` with `b = 1; c = 2` → `o = 2`).
- A literal input is a constant inside the copy.

- **Where KIELER does not look.** The substitution walks declarations (sizes, initial values, method bodies,
  the arguments of `ref` declarations), actions, transitions, reference arguments and dataflow equations. It skips
  the range of a for-region, the members of a class (initial values and methods), the arguments of `print`
  (and of host calls: expression types the processor "ignores"), and the **initial value of a local variable of a
  method body** (`int r = q`: the walk goes through a body's statements, and a declaration is none; `int r = 0; r =
  q` and a `for` loop's own declaration are replaced). An input or output named there keeps pointing at
  the declaration that is removed afterwards: `The valued object reference points to a valued object (x) that is
  not contained in the model!` (rejected; engine code `unbound-reference`). Probes
  `structure/probe-reference-interface-print`, `-interface-class-method`, `-interface-for-range`,
  `structure/probe-method-local-init-bound-input*`, `generics/probe-generic-method-local-init`. The same holds for
  generic parameters (S-74). Source: `processors/Reference.xtend:447-560` (the walk), `:637-680` (method bodies), `:814-818` (ignored
  expression types), `:900-925` (`validate`).
- Teaching: an instance works directly on the variables you pass it; nothing is copied in at the start or out
  at the end of a tick. Plain English: "inside the instance, its `beep` simply *is* your `speaker`."
- Implementation: substitute (or alias) at expansion time; do not copy values in and out. Scheduling
  (initialise–update–read) then sees the instance's reads and writes of the parent's variables directly.

### S-10 Output initial values become entry actions; input initial values are dropped

`output int count = 100` in `C` becomes an entry action `count = 100` of the referencing state: the bound
variable is set to 100 **every time the referencing state is entered**, overriding the parent's own initial
value. Initial values of `C`'s **inputs** are discarded (the input declarations are removed).

- Evidence: `07-reference-output-initialised-on-entry` (tick 1 `o = 100` although the parent declares
  `o = 0`; re-entry in tick 4 resets `o = 100`; KIELER also warns "Potential instantaneous loop." for this
  chart). Probe: `input int a = 50` bound to `z = 1` → `b = 1`.
- Source: `processors/Reference.xtend:319-324`, `:362`.
- Teaching: surprising: the referenced chart's output initialiser wins over yours, and is re-applied on every
  entry.
- Implementation: model it as an entry action of the referencing state appended **after** the copy's own
  entry actions (`createEntryAction` appends; probe: `C` with `output int count = 100` and
  `entry do count = count + 5` gives `o = 100`, not 105).

### S-11 Locals of the referenced chart are per instance and renamed

Each copy has its own locals (initialised as usual, i.e. on entry of the referencing state). KIELER renames a
copied local whose name is already visible in the parent (to `_name_`, then `_name_2`, ...), and the netlist
code generator later moves locals to the root as `_<Root>_local_<name>`, so they are hidden in the pool.

- Evidence: `08` (two instances count independently). Probes: two instances' locals appear as
  `_Main_local_shared`, `_Main_local_shared1`; a clash with the parent's `local` gives
  `_Main_local__local_` while the parent's `local` stays visible.
- Source: `processors/Reference.xtend:867-898` (`resolveNameClashes`).
- Teaching: instances never share locals; to share state between instances, pass a parent variable (or use
  `global`, S-52).
- Implementation: give each copy its own storage; hide copied locals from the public interface.

### S-12 Root-level actions of the referenced chart belong to the referencing state

`entry`, `during`, `exit`, `suspend`, `period` actions written at the top of `C` are actions of the
referencing state. `12-reference-root-actions`: entering `R` runs `log += 1`, leaving it runs `log += 10`.

- Teaching: a referenced chart's own entry and exit actions run when the referencing state is entered and left.
- Implementation: the copy's actions become the referencing state's actions in `C`'s order, followed by the
  output-initialisation entry actions of S-10.

### S-13 Termination and `join to`

The referencing state terminates when the copy terminates (all its regions in final states), and a `join to`
on it fires in that same tick. If `C` cannot terminate, the editor warns
`The referenced SCChart does not terminate, but you are using a termination to proceed.` and the join never
fires.

- Evidence: `09-reference-join` (tick 2: `steps = 1, done = true`), `23-warn-join-never-terminates`.
- Source: `SCTXValidator.xtend:1016-1027`.
- Teaching: `join to` after a reference waits for the referenced chart's final states; a chart without final
  states never finishes. Plain English: "join fires when the other chart is done."
- Implementation: no special case once expanded. The warning uses KIELER's `mayTerminate`
  (`sccharts/src/.../extensions/SCChartsStateExtensions.xtend:199`): every control-flow region of `C`'s root
  contains a final state somewhere inside it (a weak test: reachability is not checked).

### S-14 Preemption of a referencing state

As for any superstate (S-4): a weak abort (`go to`) lets the instance run in the abort tick and its trigger
sees the instance's writes of that tick; a strong abort (`abort to`) is tested before the instance runs, and
in the tick it fires the instance does not run.

- Evidence: `10-reference-weak-abort` (`if o >= 3 go to E` fires in tick 4, `o = 3`),
  `11-reference-strong-abort` (`if o >= 3 abort to E` fires in tick 5; in tick 4 `o` was still 2 when tested),
  `26-reference-taken-transitions`.
- KIELER rejects a strong abort with lower priority than a weak one:
  `Causality problem!\nStrong abort transitions must have a higher priority than weak abort or termination transitions.`
  (probe; general rule, not specific to references).
- Teaching: the difference between `go to` and `abort to` is easiest to see with a referenced counter: the
  weak abort leaves one tick earlier because it sees the instance's write of that tick.
- Implementation: nothing reference-specific; expand first, then apply the general preemption rules.

### S-15 Taken-transition counters cover only the simulated chart's own transitions

The simulator's `taken[]` array is built before references are expanded: it lists the transitions written in
the first chart (in `StateIterator.sccAllContainedStates` order), not those inside referenced charts. A chart
with no transitions of its own has no `taken` at all (the oracle reports `taken: undefined`).

- Evidence: `26-reference-taken-transitions` (`[Start → R, R → Done]`), `02` (no transitions: undefined).
- Source: `processors/TakenTransitionSignaling.xtend:56, 77`; it runs first in every `tts` system (see
  `sccharts/system/*.tts.*.kico`).
- Teaching: in the simulator, transitions inside an instance are not highlighted as taken in KIELER either.
- Implementation: number the first chart's transitions before expansion; transitions of copies (and of
  for-region copies, S-23) map back to the transition they were copied from. For references, KIELER does not
  count them at all.

### S-15a Silent transitions inside a referenced chart, and states without code

Because a copy has no take counters (S-15), a transition of a referenced chart without trigger and without effect
is empty in KIELER's model, and Surface/Depth's clean-ups treat it differently from the same transition in the
simulated chart:

1. **Merged.** An untriggered immediate transition without effect to another state merges its source into the
   target (SITO). `initial state C0xs0 immediate go to C0xs1  final state C0xs1` becomes a region that is only a
   final state, with the consequences of `concurrency.md` T-6/K-1: under the delayed self-loop of the
   referencing state the chart is rejected (`Can't schedule from …`, `160-err-reference-silent-merge`). A
   transition back into the merged state leads to its target: `P immediate go to Q`, `Q go to P` is `Q` with a
   delayed self-loop, accepted (`probe-reference-silent-merge-back`, `-region`); `Q immediate if p go to P` is
   an instantaneous cycle, rejected (`-triggered`).
2. **Dropped: the state is left without code.** An untriggered immediate self-loop without effect (`state Spin
   immediate go to Spin`), or a cycle of such transitions (`Spin → Spin2 → Spin`), is removed together with the
   state's later transitions. The state then has no transitions and no node in KIELER's graph. In the simulated
   chart the same loop is an instantaneous loop (`The SCG is NOT asc-schedulable!`, control probes); inside a
   reference it is accepted (only the editor's warning `There is an immediate loop. The model is not SASC.`
   remains) and control that reaches the state simply ends there: its region counts as finished
   (`158-reference-silent-self-loop`, `159-reference-silent-cycle`).
3. **Equal branches.** A triggered and an untriggered transition from one state to the same target (`if q go to
   B`, `go to B`) become one conditional with two equal branches, and KIELER's netlist code passes no control
   through the else branch: when the trigger is false, the instance stops for good
   (`161-reference-equal-branches`: `x` stays 0 although the untriggered `go to B` should fire).

A state without code (case 2) trips later steps:

- **The dependency analysis stops.** KIELER's dependency search walks the graph depth first with a stack, the
  regions of a fork from the last to the first, and ends the whole walk (`while (!nodes.empty && nodes.peek !==
  null)`) as soon as it meets the start of a region whose first state has no code. Everything it has not visited
  by then gets no data dependencies: concurrent reads are not ordered after writes, signal tests not after
  emissions, signal resets not before emissions, and those regions run in region order. With the reference in
  the last region, as in the charts below, nothing gets dependencies: `162-reference-dependency-stop` (a
  signal emitted by `Write` is never seen by `Read`, which runs first, and the reset after the emission leaves
  it absent at the end of every tick), `159` and `164-reference-nodeless-single-region` (`Read` sees each new
  value of `x` one tick late). With the reference in the **first** region the walk has visited everything else
  before it gets there, and the chart behaves normally (probe: `Read` counts `S` in the tick `Write` emits it).
  Count delays in such a chart fire a tick late (probe
  `tests/engine/kieler/structure/probe-reference-dependency-count-delay`).
- **Any other way in crashes.** A transition into the state other than a region's start leaves a control flow
  without target, and the dependency analysis throws: `java.lang.NullPointerException: Cannot invoke
  "de.cau.cs.kieler.kexpressions.keffects.Link.getTarget()" because "cf" is null`
  (`163-err-reference-nodeless-transition`).
- **Single-region superstates.** When the state without code starts the only region of a superstate, KIELER's
  Superfluous Fork Remover replaces the superstate's fork by its one thread and re-routes the flows into the
  fork to the state's missing node. If the superstate is itself a region's start, only a region entry is left
  without target: accepted, and the dependency analysis stops there (`164`). If the superstate is entered by a
  transition, KIELER's ThreadAnalyzer throws a NullPointerException (lab: `The compiler failed during
  compilation setup.`, `165-err-reference-nodeless-superstate`).

- Evidence: `158`–`165` (copies of the engine's probes `tests/engine/kieler/structure/probe-reference-*`, which
  the differential fuzzer found); control probes: the referenced charts of `158` and `159` simulated on their
  own are rejected as instantaneous loops. Official KIELER 0.3.0 agrees on all ten (on `165` it never answers).
  The **priority** compiler differs on all but `163` (probe, `--system priority`): it cannot compile `158` (a
  NullPointerException in its code generator), `159`, `162` and `164` (lab: `This region has no state left to
  start in once KIELER has normalized the chart, so KIELER's priority-based compiler cannot compile it.`) or `165`
  (`Part of this chart leads to no next state once KIELER has normalized it, …`), accepts `160`, and runs `161`
  correctly (`x = 1` in tick 4: no equal-branch defect there).
- Source: `processors/SurfaceDepth.xtend:44-60, 128-141` (DTO, SCSO, SITO and dead-code clean-ups, which only
  touch transitions without effects; the take counters of the simulated chart are effects; the optimisations are in
  `extensions/SCChartsOptimization.xtend`), `scg/.../processors/DependencyTransformationV2.xtend:106-176`
  (`searchDependencies`, the `nodes.peek !== null` stop at `:117`), `scg/.../processors/optimizer/SuperfluousForkRemover.xtend`,
  `scg/.../processors/analyzer/ThreadAnalyzer.xtend`.
- Teaching: none of this happens in a sensible chart. A state whose only behaviour is an immediate transition
  back to itself is an instantaneous loop, and KIELER only fails to see it inside a referenced chart; the guide
  should simply say "never write an untriggered immediate transition back into the same state (or round a
  cycle of states)".
- Implementation: reproduce it (the engine does: a `kieler-quirk` warning names the variables left without
  dependencies, `kieler-crash` for `163` and `165`).

### S-16 A reference that leads back to itself is rejected

- Lab server: `Recursive reference: chart St21Main uses itself (St21Main -> St21Main).` (and `A uses B, which
  leads back to A (A -> B -> A)` for longer cycles). Official KIELER never finishes compiling (stack
  overflow), so it rejects the chart too, without a message.
- Evidence: `21-err-recursive-reference`. Source: `processors/Reference.xtend:390-415` (fork addition).
- Teaching: a chart cannot contain itself; repetition is a transition back to an earlier state.
- Implementation: track the stack of charts being expanded; report the reference that closes the cycle.

### S-17 `region R is ...` refers to inherited regions only

`region R is X` does **not** instantiate a chart: `X` must be a region inherited from a base chart (`scchart A
extends B`). A chart name does not resolve: `Couldn't resolve reference to NamedObject 'St22Beep'.` (`types.ts`
describes `Region.reference` as "`region R is Other(...)`"; that is misleading.)

- **`region is super.R`** takes the base chart's version of a region, normally inside the `override region R` that
  replaces it; it also works outside an override region and inside a state of an ordinary region
  (`probe-extends-region-super`, `-super-inner-state`, `-override-is-super`: `override region R is super.R`). It
  takes no arguments (`A reference to a super scope must not have parameters!` / `... generic parameters!`).
- **`region Q is R`** (without `super`) is a **copy** of the inherited region `R`, appended to the state's regions
  in `Q`'s place; `R` itself is inherited as well, so the behaviour runs twice (`probe-extends-region`: `o` grows
  by 2 per tick; two copies: by 3, `-two`). It also works inside a state of the extending chart, where the copy
  restarts with the state (`-inner-state`). A region the state overrides itself is not visible without `super`
  (`-overridden`: `Couldn't resolve reference to NamedObject 'R'.`).
- The copy is bound like a referenced chart, with the **names the region uses** as its interface, in the order
  they are first named: arguments bind them by the pointer of S-6, the rest by name to the variables around `Q`
  (the inherited declarations count). `region Q is R(p)` therefore makes the copy write `p` where `R` writes its
  first variable `o` (`-binding`: both grow). A name with nothing to bind to is an error: a declaration of `R`
  itself (`-own-declaration`) and a generic parameter of the base chart (`-generic`), both
  `The referencing binding is erroneous!\nValued object in the referenced scope was not bound properly: k`.

- Evidence: `22-err-region-is-chart`, `24-region-is-super`, probes `tests/engine/kieler/parity/probe-extends-region*`.
- Source: `SCTXScopeProvider.xtend:109-134` (region context: `getAllVisibleInheritedRegions(!super)`),
  `processors/Reference.xtend:264-379` (`expandReferencedScope`, the `Region` branches),
  `SCChartsReferenceExtensions.xtend:116-118` (a region's binding targets: every valued object it names),
  `Inheritance.xtend:398-404, 532-544` (the bindings kept for `super`).
- Teaching: to run a chart concurrently with other regions, write `region { initial state R is C(...) }`.
- Implementation: `super.X` where the base charts are inherited (passes/inheritance.ts); `region Q is R` in the
  Reference pass (`expandRegion`), validation in `validate.ts` `checkRegionReference`.

### S-18 `ref C g(args)` outside dataflow: a concurrent instance

A `ref` declaration with bindings, in a state's declarations and not used in a dataflow region, instantiates
`C` with those bindings (same rules as S-6 to S-10). The instance runs concurrently with the state's regions,
from the tick the state is entered, for as long as it is active.

- Evidence: `29-ref-declaration-instance` (`O = X && Y` from tick 1).
- Source: `processors/Reference.xtend:927-1000` (`handleSCChartsDatatype`).
- `ref` without bindings and without inputs/outputs is the object-oriented "class" use of a chart (methods
  `g.m()`): S-65.
- Teaching: rarely needed; `state S is C(...)` in its own region says the same more visibly.
- Implementation: treat it as an extra concurrent region of the declaring state containing
  `initial state _ is C(args)`.

### S-18a Inside an instance, bindings are kept by name

KIELER keeps what is bound for a `ref` instance on a stack of replacements **by name** and hands that stack on to
the `ref` declarations inside the instantiated chart. When it then replaces the references in such an inner copy, it
does not shadow the stack with the copy's own top-level declarations (`handleSCChartsDatatype` calls
`replaceValuedObjectReferencesInState` on the copy directly; only the dispatcher `replaceValuedObjectReferences`
pushes a scope's own declarations). So inside an instance of an instance, a top-level variable of the inner chart
that has the name of something bound further out **is** that outer variable:

- `ref Outer1 g(x, o)` binds Outer1's input `a` to `x`; Outer1 declares `ref Inner1 i`, and Inner1 has a local
  `int a = 100` that its region counts up. KIELER's result: the chart's **input `x`** is counted up (the pool shows
  `x` one above what the environment gave), `i.a` stays 100, `i.get()` returns `x`.
- With an OO dataflow instance inside (S-33a) the same happens to its inputs and outputs, which are members there:
  the inner instance's port of the bound name is replaced by the outer variable and is no member any more. An
  equation that wires it (`t.a = ...`, `s = t.s`) is left without its target: `The valued object reference points
  to a valued object (a) that is not contained in the model!`. Without such an equation the chart compiles and the
  inner chart reads the outer variable.
- `state S is Mid(x, o)` instead of a `ref` declaration has no such leak: the copy's declarations are pushed.
- What KIELER asks before it keeps a port of an OO dataflow instance is whether the port's *name is a key* of the
  stack (`replacements.containsKey`), and the walk over the copy leaves every name it pushed as a key. So a port is
  also lost when a state or region inside the instantiated chart declares a variable of the port's name
  (`structure/probe-reference-dataflow-port-redeclared-inside`: `output int s` and an inner `int s`, `o = g.s`
  rejected).
- A **literal** on the stack (a generic argument, S-74) does not remove the port: KIELER replaces the declaration
  by a plain variable that starts with the literal, which stays a member an equation can wire
  (`generics/probe-generic-dataflow-leak-port`, `-leak-port-unwired`); a variable given as the generic argument
  removes it as above (`-leak-port-variable`, `-leak-port-variable-unwired`).

- Evidence: `dataflow/probe-dataflow-nested-ref-name-leak`, `-instance-nested-name-leak` (rejected),
  `-instance-nested-name-leak-unused`, `-instance-nested-name-leak-output` (rejected),
  `-instance-in-referenced-chart-same-names` (no leak).
- Source: `processors/Reference.xtend:951-1004` (`new Replacements(parentReplacements)`, `replacements.push`,
  `newState.expandRoot(replacements, false)`, `newState.replaceValuedObjectReferencesInState(replacements, false)`),
  `:448-465` (the dispatcher that does push), `kext/extensions/Replacements.xtend` (keyed by name).
- Teaching: do not teach nesting `ref` instances; if a guide chart does, give the charts' variables different names.
- Implementation: KIELER's replacement stack itself (structure/replacements.ts, the one of S-74): passes/reference.ts
  starts an instance's stack from a copy of the stack of the instance around it and walks the copy's root without
  pushing its declarations. An OO dataflow instance's port whose name is on that stack is removed
  (`instantiate`, KIELER's `containsKey`).

### S-18b A vector bound to a constant input of an array of instances is spread

`ref Cell c[2]({3, 8})` with `input const int k` in `Cell` gives the first instance 3 and the second 8. KIELER's
Reference processor recognises exactly this form: an array of instances with **one** dimension, a **scalar**
`input const`, a **vector** as the argument (by position, or `{3, 8} to k`; in a dataflow region that calls a
method only the explicit form is applied at all). Such a binding is not substituted like the others. The constant
becomes an ordinary public variable of the class KIELER makes of the chart (S-65), and then:

- **Something in the class names it** (a method of the chart, a field's initial value): it stays a field
  (`"c": [{"k": 3}, {"k": 8}]`), and an entry action of the declaring state assigns every element its value. The
  chart's regions and actions read the field. Until that entry action runs the field is 0, so `int x = k + 1`
  starts at 1 in every element (`probe-instance-spread-method`, `-initial-value`, `-initial-value-and-region`,
  `-array-of-one`: the assignment also reaches an array of one instance, which nothing else initialises, S-60a).
- **Nothing in the class names it** (only regions and actions do): the field is removed, and the copy of the
  chart's regions and actions for element *i* has the *i*-th value in its place (`-region`, `-entry`, `-two`,
  `-two-states`, `-bool`, `-generic`, `-inner-state`, `-two-arrays`, `-nested`).
- **A class inside the chart names it** (a method or an initial value of `class In { ... } q`): KIELER gives that
  class a field of its own, named after the instance's class, `<Class>_<name>` (`"q": {"Cell1_k": 3}`), assigned on
  entry too; the chart's own field stays only if the chart's own methods or initial values name the constant as
  well (`-inner-class*`). Only for a single object of the class: with two objects or an array of them KIELER stops
  with `NOT YET SUPPORTED` (`-inner-class-two-objects`, `-array`; `-and-method`, `-two-deep`, `-initial-value`,
  `-two-classes`, `-and-region` run).

The values may be numbers, constants and expressions (`{Y, 8}`, `{1 + 2, 8}`); a range counts up to, not
including, its end (`{0 to 3}` is 0, 1, 2: `-range`).

| Chart | Message |
| --- | --- |
| another number of values than instances | `Cannot spread vector with different size than target array` (`-size`) |
| a variable among the values | `Cannot bind non-constant variable to constant input (via spread vector)` (`-variable`) |
| a range for a constant that is no int, or with other bounds than numbers | `Cannot spread vector range to non integer variable`, `End value of spread vector range must be a constant integer variable` (source) |
| a vector for the constant of a single instance or of a two-dimensional array | not spread: gcc's `expected expression before '{' token` where the constant is read (`probe-instance-vector-to-constant*`) |
| a vector for an ordinary scalar input of an array of instances | not spread: the same gcc error (`probe-instance-vector-to-input`) |

An `input const` that a reference binds to one value is that value wherever the chart names it
(`probe-input-const-literal-method`, `-region`, `-array`: a constant array bound to a vector, indexed in the
chart). In the simulated chart itself it is an input like any other, in the pool and settable
(`probe-input-const-root`, `-root-value`). In a dataflow region that calls a method, a constant input that
nothing binds explicitly is a field that stays 0 (`probe-instance-constant-input-dataflow-*`).

- Source: `processors/Reference.xtend:972-986` (detection), `1019-1176` (the field, its mirrors in inner classes,
  the entry action), `1255-1280` (the value in each element's copy).
- Engine: `sim/structure/spread.ts`, codes `spread-binding`, `binding-vector`.

### S-19 `state S calls C(...)` runs as a reference

In KIELER 1.6.1 (official 0.4.3 and the lab server) `state S calls C(...)` behaves as `state S is C(...)`: the
same bindings (with the implicit-binding warning), the same copy of `C`, the same pool
(`tests/engine/kieler/parity/probe-state-calls`, `probe-state-calls-input`). Official KIELER 0.3.0 compiled it
to a C function call that its netlist back end never defined (`implicit declaration of function ‘_rSubQ1’`).

- Teaching: do not teach it; `is` says the same.
- Implementation: expand it as a reference.

---

## 2a. Generic parameters

A chart can declare generic parameters after its name, `scchart C<N is int, T is primitive, W is Worker, V is ref
Worker, X>`, and everything that uses the chart gives arguments: `state S is C<4, int, Fast, w, Fast>(p)`, `ref
C<...> g` or `ref C g<...>`, `scchart D extends C<...>`. KIELER binds them in its Reference and Inheritance
processors, on the same replacement stack that binds inputs and outputs.

### S-73 Parameters and arguments

| Parameter | What it is | Argument |
| --- | --- | --- |
| `N is int` (`bool`, `float`, `string`, `pure`) | a **value**: a name the chart uses like a variable | a literal of exactly that type (`4`, `true`, `1.5`), or a variable, signal, constant, array or array element declared with that type |
| `T is primitive` | a **primitive type**: `primitive T x`, `const primitive T K`, `primitive T a[2]`, `method primitive T f(primitive T v)` | `int`, `bool`, `float` or `pure`, written out |
| `W is Chart`, or `X` without `is` | a **chart type**: `state S is W(...)`, `ref W w` | a chart that is `Chart` or extends it (any number of levels) without adding inputs or outputs; for `X` anything (also a type: `ref X v` with `int` is an int variable) |
| `V is ref Chart` | an **instance**: `V.method()`, `V.field` | a variable declared `ref Chart v` (or of a chart that extends it; the instance's own override runs) |

- Arguments are bound **by position**, never by name; every parameter needs one, also one the chart never names
  (`There is no parameter given for generic parameter declaration of N.`), and a surplus one is an error (`There
  is no declaration for the given generic parameter (position: 1).`), also on a chart without generic parameters.
- A bare name in the arguments is a chart first, then a type parameter of the chart around it, then a variable
  (`KExtGenericParamterConverter`). A type parameter `W` hides a chart called `W` in `state S is W`
  (`probe-generic-type-hides-chart`). After `is` only a chart can be named (an enum: `Couldn't resolve reference to
  NamedObject 'Color'.`); `primitive N x` needs `N is primitive` (`Couldn't resolve reference to EObject 'N'.`).
- **Literals.** The type must be equal (`Type mismatch! Generic parameter F of type float cannot take literal of
  type int.`). A **string literal is always refused** (`... cannot take literal of type UNKNOWN.`: a string value
  has no type in KIELER); a string variable works. A negative number and any expression are syntax errors, and so
  is `Holder<Box<4>>` (the `>>` is a shift operator; `Holder<Box<4> >` parses).
- **Variables.** KIELER compares the declared type of the *first* name: `C<a[1]>` and the whole array `C<a>` pass
  for an int array (the chart may then index the parameter, `N[1]`), a member `C<c.x>` does not (`... cannot take
  valued object declared with type class.`).
- Two parameters may have the same name (the last argument wins), and the chart may declare a variable with a
  parameter's name (S-74).
- The first chart of a file cannot be generic: `A root SCChart cannot have unbound generic parameters.` (also
  when it never names the parameter, and when it only hands it to its base chart).
- `ref C<2> g<7>`: `Cannot mix generic parameters in variables and declaration`. With arguments or bindings on the
  variables (`ref C g<2>, h<5>`) KIELER makes a declaration, and a class, of each: the trace has `C1.n` and `C2.n`,
  as for two declarations of one chart (`-decl-class-two-declarations`); one declaration with two plain variables
  is one class `C1` (`-decl-class-one-declaration`).
- Generic arguments on references and `ref` declarations are checked by the validation in every chart of the file;
  those on `extends` only when the chart is compiled (S-76), so a wrong one in an unused chart goes unnoticed
  (`probe-generic-extends-mismatch-unused-chart` against `-argument-missing-unused-chart`).

- Evidence: `tests/engine/kieler/generics/probe-generic-*` (204 probes: `-value`, `-value-input`, `-literal-*`,
  `-type-mismatch-*`, `-argument-*`, `-chart-type*`, `-instance*`, `-untyped-*`, `-decl*`, `-root*`, ...).
- Source: grammar `kexpressions/.../kext/KExt.xtext:281-330`, `sccharts/.../text/SCTX.xtext:27-36, 67-89, 406-427`;
  scoping `text/scoping/SCTXScopeProvider.xtend:117-134, 177-252, 374-402`,
  `kext/converter/KExtGenericParamterConverter.xtend`; bindings and their messages
  `extensions/SCChartsReferenceExtensions.xtend:273-336`, `extensions/SCChartsTypeExtensions.xtend:72-176`;
  `kexpressions/.../extensions/KExpressionsGenericParameterExtensions.xtend` (the four kinds);
  `kexpressions/.../validation/KExpressionsValidator.xtend:64-76`.
- Teaching: generic charts are the wiki's "templates". Show a value parameter with a literal first; mention that
  strings need a variable.
- Implementation: `parser/parser.ts` (`GenericParameterDeclaration`, `GenericArgument` beside the strings),
  `parser/resolve.ts` (scoping), `parser/generics.ts` (bindings and messages), `parser/validate.ts`.

### S-74 Binding is by name: where a parameter is replaced, and what it captures

A value parameter is replaced like a bound input (S-9), with KIELER's replacement stack, which is keyed by
**name**: binding pushes `N -> argument`; every scope the walk enters pushes its own declarations as themselves
and pops them when it leaves; a nested reference starts from a **copy of the whole stack**.

- A **variable** argument is substitution: the parameter *is* the variable (`C<i>` follows the input tick by
  tick; an array element with a variable index is read anew; the chart may write it, `-value-written-variable`).
- A **literal** argument is the literal wherever the parameter is named. Writing it crashes KIELER's compiler
  (`N += 1`: `ClassCastException: IntValueImpl cannot be cast to ... ValuedObjectReference`, engine `kieler-crash`,
  `-value-written-literal`; also in a state that cannot be reached, `-value-written-literal-unreachable`). `pre(N)`
  becomes `pre(4)`: KIELER's Pre processor only handles variables and leaves it, and where code is made for it gcc
  refuses the register (`expected identifier ... before numeric constant`; a bool in a trigger: `The compiler
  failed during compilation setup.`; engine `generic-pre`; `-value-pre-literal`, `-value-pre-int-trigger`,
  `-value-pre-bool-trigger`, `-value-pre-bool-effect`). In a state that cannot be reached no code is made and the
  chart is accepted (`-value-pre-unreachable`, found by the `generics` fuzz profile).
- A **constant** as the argument is still a name when KIELER binds it (its Const processor runs after the
  Reference processor): reads get the value, but a write is an assignment to the constant, `Cannot replace left
  hand side of assignment by a value. (Trying to replace ... K by ... (value: 4) in ... K += 1)` (engine
  `bound-const-written`; `-value-written-const`, `-extends-written-const`), also for a captured local
  (`-capture-const-written`, found by the `generics` fuzz profile) and for an input of an ordinary reference
  (`structure/probe-reference-const-written`; a literal there makes the input a local that starts with it and can
  be written, `structure/probe-reference-literal-written`). `pre(N)` fails with a constant as with a literal
  (`-value-pre-const`). A computed constant and an element of a constant array are fine as arguments
  (`-value-const-computed`, `-value-const-array-element`); a for-region counter is not (no declared type,
  `-value-for-counter`).
- **Not replaced** (as S-9): the range of a for-region (`-value-for-range`), class members (`-value-class-initial`,
  `-value-class-method`), `print` (`-value-print`), and additionally the **generic arguments** of a reference and
  of a `ref` declaration's chart: `state T is Inner<N>(o)` and `ref Inner<N> g` fail (`-forward-is`,
  `-forward-decl`: `The valued object reference points to a valued object (N) that is not contained in the
  model!`), while `ref Inner g<N>` (arguments after the variable) and `state T is Inner(N, o)` work
  (`-forward-decl-variable`, `-value-inner-argument`). Through `extends` all of these are replaced (S-76).
- **Capture.** The top of a copy does not push its declarations, and a generic parameter is no declaration, so
  nothing renames a nested chart's local out of the way (S-11 does that for inputs and outputs):
  - a chart referenced inside an instance of `Outer<N>` that declares `int N = 100` at its top gets the outer
    parameter: with a literal the local **starts with the argument** (it stays a variable and can be written,
    `-capture`, `-capture-literal-written`); with a variable argument the local *is* that variable
    (`-capture-variable`). At any depth of nesting, also for a local the nested chart inherits
    (`-capture-extending`), and even when the simulated chart has a variable of that name (`-capture-detached`).
    A local of an inner state keeps its own value (`-capture-inner-scope`);
  - the generic chart's own variable of the parameter's name behaves the same (`-own-declaration`: starts with
    3, not 50); inside an inner state that declares the name, the name is the variable (`-shadow-inner-scope`);
  - an input of the same name loses to the parameter (`-parameter-and-input-same-name`); a nested generic chart
    with a parameter of that name gets its own argument (`-inner-own-parameter`);
  - a chart with such a variable that binds an inner reference **by name** crashes the compiler
    (`IllegalStateException: There is a matching valued object on the replacement stack for an implicitly bound
    variable ( N). ...`, `-implicit-crash`).
- **Method bodies and code blocks** are walked scope by scope (`replaceValuedObjectReferencesInSclScope`): the
  body pushes its parameters and its top-level declarations, an `if` branch, an `else` branch, a loop and a plain
  `{ ... }` block push their own, all at once and for as long as the block is walked. So a local hides a bound name
  **inside its block only**: after `for (int N = 0; N < 1; N++) { }` the name `N` is the argument again (`return N`
  gives 5, not the counter's last value), and likewise after a `while`, a block, an `else` (`-method-scope-*`,
  `binding-method-scope-*` for an input bound to a variable). Two things the walk does not do:
  - it does **not visit the initial values of the declarations in a body** (`int x = N`): the name stays and points
    at a parameter (or an input) that is gone, `The valued object reference points to a valued object (N) that is
    not contained in the model!` (`-method-local-initial-value*`, `-code-effect-local-initial-value`,
    `binding-method-local-initial-value`, also with a literal bound). The one exception is the initial value of a
    `for` loop's own declaration, which it visits with the loop's condition and step
    (`-method-for-initial-value`). A chart's own variable there is fine (`method-local-initial-value-own-variable`);
  - it replaces the condition of an `if` **before** it pushes the branch's declarations, while KIELER's scoping
    puts that condition inside the branch's scope: `if (N > 4) { int N = 1 ... }` names the local in the condition,
    the stack still has the argument for the name, and with a value KIELER tries to give the local that value as
    its initial value and casts the local's container, the `if`, to a chart scope: `ClassCastException: class
    de.cau.cs.kieler.scl.impl.ConditionalImpl cannot be cast to class de.cau.cs.kieler.sccharts.Scope`
    (`-method-scope-if-condition`; engine `kieler-crash`).
  Source: `Reference.xtend:638-682`, `:771-787` (`replaceReferenceWithLiteral`: `oldDeclaration.eContainer.asScope`).
  Implementation: the lowering numbers the SCL blocks (`CMethod.scope`, `CStmt.scope`/`elseScope`/`blocks`, a
  local's `block`), `Replacer.method` pushes and pops block by block.
- The exception KIELER throws for an assignment to a parameter that stands for a value names the value's class:
  `IntValueImpl`, `BoolValueImpl`, `FloatValueImpl` (`-assigned-int`, `-assigned-bool`, `-assigned-float`; through
  `extends`: `parity/probe-extends-generic-assigned-*`, `-binding-assigned-bool`). A string is no generic argument
  (`-assigned-string`: a literal of type UNKNOWN).
- `scchart(G).K` reads a constant of a generic chart, and works inside one (`-static-access-of`, `-static-access-in`);
  a constant whose value is the parameter stays behind (`-static-access-parameter`, S-70).
- `state(S)` in a method works in the chart KIELER compiles and in instances declared with `ref`, **not** in a
  chart copied for `state S is C` (MethodSignaling is not run on that copy): gcc's `implicit declaration of
  function ‘state’` (`-state-access`, `structure/probe-reference-state-access`, `-state-access-declared`; engine
  `state-access-copy`).

- Evidence: the probes named above (all `tests/engine/kieler/generics/probe-generic-…`).
- Source: `kexpressions/.../kext/extensions/Replacements.xtend` (name-keyed stacks; the copy constructor copies the
  stacks but not the type replacements); `processors/Reference.xtend:195-261` (`expandRoot`), `:264-379`
  (`expandReferencedScope`: bindings pushed at 306-317, nested references expanded during the walk at 486-488),
  `:447-560` (the walk and its pushes), `:684-789` (`replaceReferences`, `replaceReferenceWithLiteral`: a declared
  variable gets the literal as its initial value, anything else is replaced by it), `:867-898` (renaming looks at
  declarations only), `SCChartsReferenceExtensions.xtend:161-181` (the IllegalStateException).
- Teaching: do not name a variable like a generic parameter; pass a variable when the chart writes the parameter.
- Implementation: `sim/structure/replacements.ts` (the stack and the walk), `sim/passes/reference.ts`.

### S-75 Type parameters

- `primitive T x` is a variable of the type given for `T`, with its initial value and arithmetic (`-primitive-int`,
  `-primitive-float-initial`, `-primitive-array`, `-primitive-const`); a method's generic return and parameter types
  become the type (`-method-types`; anything but a primitive type there: `Only primitive generic types are
  currently supported as return types.`). `pure` passes the check and then fails in the simulation (`Cannot
  serialize simulation interface. Unsupported type: pure`, `-primitive-pure`); `string` is refused (`... cannot
  accept type string.`). A primitive type parameter cannot be handed on to another generic chart (`Generic parameter
  U with primitive type restriction must be bound to a concrete primitive type, not ValuedObjectReferenceImpl.`).
- **A declaration of a generic type is no longer an input or output.** KIELER replaces it by a plain variable
  declaration of the type. Its static check therefore refuses to bind `input primitive T x` or `output primitive T
  y` to a variable (`Cannot substitute reference of type T by valued object of type int`, `-primitive-interface-
  variable`); only a literal of the given type binds to such an input (`-primitive-input-literal`; another type:
  `Type of literal value bool does not match generic type argument int for T`). Through `extends Base<int>` the
  base chart's `input primitive T x` becomes a local `x` the environment cannot set (`-extends-type`).
- `state S is W(args)` is an instance of the chart given for `W`, bound as that chart is (the validation checks the
  bindings against `W`'s declared chart); `ref W w` an instance of it, also in a dataflow region, whose methods
  are found by signature in the chart actually given (`-chart-type*`, `-chart-type-decl-override`).
- The chart given for `W` may carry generic arguments of its own (`Holder<Box<4> >`), which are used unless the
  use gives some too (`Conflicting generic parameters passed to scope call in S via generic type and in call.`,
  `-nested-argument-conflict`). KIELER's validation checks `state S is W(q)` against `Box` without arguments, so only
  `ref W w` (`-nested-argument-decl`) and `state S is W<5>(q)` with a bare `Box` (`-chart-type-own-arguments`)
  work.
- A chart type parameter cannot be handed on (`state U is V(o)` then stays `Invalid reference V! Only
  States/Regions can be instantiated.`, `-chart-type-forward`).
- The lab server's recursion check covers charts with type parameters only when the simulated chart itself is
  reached again (`-recursion-type-root`); a chart with value parameters only is checked like any other
  (`-recursion`, S-16).

- Source: `processors/Reference.xtend:562-635` (`replaceGenericTypeParametersInState`), `:390-415` (recursion),
  `extensions/SCChartsTypeExtensions.xtend:201-280` (the interface checks), `SCTXValidator.xtend:1059-1076`.
- Implementation: `sim/passes/reference.ts` `replaceGenericTypes`, `plainVariable`.

### S-76 Generic arguments on `extends`

`scchart D extends Base<3>` binds the base chart's parameters in the Inheritance processor (S-66), which replaces
**every** reference in the chart, so what the Reference processor skips works here: the parameter in a for-region
range (with a literal: `-extends-for-range`; a variable or even a constant is still a name when the for-region is
copied: `The for-region range ... ends at K, which is not an integer literal.`, `-extends-for-range-const`), in a
class method, in `print`, and in the generic arguments of `state T is Inner<N>` and `ref Inner<N> g`
(`-extends-class-method`, `-extends-print`, `-extends-forward-is`, `-extends-forward-decl`).

- The argument may be a literal, a variable or constant of the extending chart (`-extends-input`, `-extends-const`),
  or the extending chart's own parameter (`scchart Mid<M is int> extends Base<M>`, `-extends-forward`). The
  extending chart cannot name the base chart's parameter (`Couldn't resolve reference to ValuedObject 'N'.`).
- Errors come from the compiler, not the validation: `Errornous generic parameter. Paramter N of Base was not set
  correcly. <message of S-73>` (wrong type, missing, surplus; engine `generic-argument`); without any argument the
  parameter simply stays unbound (`... (N) that is not contained in the model!`). An inner state's `extends` is
  checked by the validation too (`The binding of inherited variables is erroneous!`).
- A base chart reached along two paths with arguments is `Conflicting generic parameters. Binding Paramter N of
  Base was already set to ... and cannot be set to ...` even when the arguments are equal (KIELER compares the
  objects; `-extends-diamond-method`).
- Types: `extends Base<int>` turns the inherited declarations and methods of type `T` into `int` ones
  (`-extends-type-used`, `-extends-method`), and an override may declare the concrete types (`override method int
  inc(int v)` for `method primitive T inc(primitive T v)`, `-extends-override-concrete`; another type: `Overriding
  methods must not declare a different return type than the given generic type argument (int vs. bool).`, for a
  parameter `(index 0: int vs. bool)`, `-extends-override-wrong-return`, `-wrong-parameter`).
  `ref W w` in the base is replaced, `state S is W` is **not** (`Invalid reference W!`, `-extends-chart-type`).
- A chart that extends a generic base can be referenced, declared with `ref` and extended further like any other
  (`-extends-referenced`, `-decl-of-extending`).
- **The parameter list of `extends`** (inputs and outputs of the base, S-66) through two levels: when the lower
  level binds an **element** (`Mid extends Base(b[1], q)`) and the upper level binds that array (`Main extends
  Mid(a, p)`), KIELER replaces the `b` of `b[1]` by the whole binding of `b` and the index is lost
  (`replacement = bindingReplacements.get(replacement.valuedObject)`): `x` is the array `a`, and `y = x` is gcc's
  `assignment to 'int' from 'int *' makes integer from pointer without a cast` (`parity/probe-extends-binding-index-
  lost*`, `-extends-inner-binding-index-lost`; engine `array-as-value`, a check of any whole array used as a
  number, `codegen/probe-array-as-value*`). One level keeps the index (`-extends-binding-index`), and so does an
  element bound on the upper level and passed on by name (`-index-upper`).
- **One argument too many** (`extends Base(2, 4)` with one input, an argument for a base without inputs or
  outputs, at the root, on an inner state, in the base of a base, in a referenced chart): the binding has no
  target and the Inheritance processor asks it for one, a `NullPointerException` (`... because the return value of
  "...Binding.getTargetValuedObject()" is null` for a literal, `... because "valuedObject" is null` for a
  variable; `parity/probe-extends-binding-surplus-*`, `-extends-inner-binding-surplus`; engine `kieler-crash`). One
  too few is the crash of S-66.
- **Cycles.** Charts that extend each other are the validator's `Inconsistent inheritance hierarchy! Cycle
  including base state: B` on every reference of the cycle, with or without bindings and generic arguments, also
  when the simulated chart uses none of them. With bindings the validator's own binding check never comes back
  (`Error executing EValidator` at 1:1; official KIELER then does not answer the compilation at all, the lab server
  stops with `The compiler ran out of stack space during Reference Expansion`). The name clash check asks every
  base for its visible inherited declarations as soon as it has found a clash, and overflows on a cycle the same
  way, so a clash through the cycle (an inner state that extends one of the charts) is not reported.
  `parity/probe-extends-cycle-*` (11); cycles of references (`is`, `ref`) are `Recursive reference: ...`
  (`parity/probe-reference-cycle-*`). The engine reports `inheritance-cycle` / `recursive-reference` for all of
  them (it used to overflow its own stack on a cycle with bindings).
- Generic charts of an imported file work like those of the same file (S-20; `-import`: a value parameter, a chart
  type parameter and a generic base from one imported library; `-import-wrong`: the binding error across files).

- Source: `processors/Inheritance.xtend:278-447` (bindings and replacement), `:449-508` (types);
  `extensions/SCChartsInheritanceExtensions.xtend:296-365` (overrides), `extensions/SCChartsGenericTypeExtensions.xtend`.
- Implementation: `sim/passes/inheritance.ts` `bindInherited`.

### S-77 Generic charts with dataflow instances and schedules

Generic parameters, the two dataflow translations (S-33, S-33a) and written schedules (S-27a) are independent
steps of one Reference processor, and combine as each rule says. Probed together
(`tests/engine/kieler/generics/probe-generic-dataflow-*`, `probe-generic-schedule-*`):

- **An instance of a generic chart in a dataflow region.** In the OO translation it is an object like any other,
  with the parameter's value inside (`ref Gain<3> g`, `-oo-instance`; a variable as the argument, `ref Gain g<n>`:
  the instance reads the variable, `-oo-variable-argument`; with an explicit binding, `-explicit-binding`; a binding
  by position is ignored and the generic argument is not, `-positional-binding`). In the classic translation the
  reference state takes the generic arguments of the declaration (`-classic-two`). Its methods are called by
  equations (`-call`).
- **Arrays.** `ref C<2> gs[2]` is an array of objects in an OO region (`-instance-array`, `-array-call`:
  `accs[n % 2].add(1)`) and gcc's error in a classic one (`-instance-array-classic`, S-65). The size cannot be a
  generic parameter of the chart around it: the validation wants a number or a constant
  (`-array-size-parameter`).
- **Type parameters.** `ref W w` with `<W is Worker>` is wired like a declared instance in both translations once
  `W` is a chart (`-type-parameter`, `-type-parameter-classic`). A port of a primitive type parameter (`input
  primitive T a`) is a member of an OO instance like any other (`-primitive-port`). The classic translation takes
  `g.a` for an instance of its own, because a declaration of a generic type is a reference declaration to KIELER
  until the type is given, and its compiler crashes on the type parameter (`java.lang.ClassCastException: ...
  ValuedObjectImpl cannot be cast to ... DeclarationScope`; `-primitive-port-classic`, `-primitive-port-vector`;
  engine `kieler-crash`). For the same reason the validation refuses an equation of the generic chart that
  *assigns* a variable of a generic type (`s = a + 1` with `output primitive T s`: `You are assigning a scalar
  value to a reference...`, `-primitive-target`, `-primitive-target-local`); reading one is fine
  (`-primitive-read`).
- **Inheritance.** A chart that `extends Base<3>` wires instances in both translations and calls the base's method
  with the parameter's value in an equation (`-extends`); an OO instance of a chart that extends a generic base has
  the inherited inputs and outputs as members (`-instance-extends`).
- **The by-name leak (S-18a) with generic arguments.** `ref Mid<4> m` binds `N`; a local `N` of the OO dataflow
  instance inside `Mid` starts with 4 (`-leak-local`), an input `N` of it becomes a plain member that starts with 4
  and can still be wired (`-leak-port`, `-leak-port-unwired`). With a variable as the argument (`Mid<v>`) the port
  is that variable and no member (`-leak-port-variable`: rejected; unwired the instance reads `v`,
  `-leak-port-variable-unwired`). A method of the inner chart with the parameter's name keeps its calls
  (`-leak-method-name`).
- **Where a parameter is not replaced.** In a referenced chart's OO region the arguments of a call written as an
  equation are replaced, the condition after it (`k.add(N) = x > L`) is not: the input and the parameter stay
  behind (`-call-trigger`, rejected). Assignments, call arguments and scheduled equations are fine
  (`-value-in-equation`).
- **Schedules.** A generic chart used as a class has contracts like any class: the parameter's value in the
  bodies, a primitive type parameter as a return and parameter type (`probe-generic-schedule-contract`, `-rev`);
  two instances declared together have a schedule each (`-two-instances`); `schedule b.s N` with a variable given
  as the generic argument (`-instance-clause`); scheduled writes of a generic value and of a variable given as an
  argument in a chart referenced with `is` (`-referenced`). Rejected as without generics: a contract method nobody
  calls (`-contract-never-called`), an array of instances (`-contract-array`), a schedule inherited from the
  generic base (`-extends`).
- Implementation: nothing of its own: passes/reference.ts (`interfaceBindings`, `bindGenerics`, `instantiate`),
  passes/dataflow.ts and passes/contracts.ts on the one replacement stack (structure/replacements.ts).

---

## 3. Imports

### S-20 `import "path"`

- `import "beep"` and `import "beep.sctx"` both load `beep.sctx` from the importing file's folder (paths are
  relative to it; ".sctx" is appended unless present). `import "dir/*"` loads every `.sctx` file in `dir`
  (`import "*"`: the file's own folder). A file never imports itself.
- Imports go before the first `scchart` (with pragmas, in any order).
- Imported charts are only referenceable; the importing file's first chart is simulated (S-1).
- A missing file is only a **warning**, `Broken Import: There is no SCCharts model with the given name.`
  (folder: `Broken Import: There are no SCCharts models in the given directory.`), followed by link errors
  for whatever it should have provided.
- The old `#import "file"` pragma is a **syntax error**, `no viable alternative at input 'import'` (official
  KIELER and lab server): `import` is a keyword, so the pragma cannot be parsed. Error recovery still reads the
  line as an import, so a missing file also draws the Broken Import warning. The validator message meant for
  it (`The import pragma is no longer supported. Use import keyword.`, `SCTXValidator.xtend:472-477`) is never
  reached from SCTX text (`96-err-import-pragma`).
- Evidence: `16-import` (with scenario `"imports": ["16-st16-beep.sctx"]`), `96-err-import-pragma`. Probes: `import "beep"`,
  `import "beep.sctx"` and `import "*"` all work; `import "nothere"` → the warning plus
  `Couldn't resolve reference to NamedObject 'Beep'.`; no import → link error.
- Source: `sccharts/src/.../text/SCTXResource.xtend:199-290` (`updateImports`, `importResource`),
  `SCTXValidator.xtend:473-492`.
- Teaching: `import` names a file (without `.sctx`), `is` names a chart in it. Plain English: "import the file,
  then use its charts by name."
- Implementation: the engine receives imported files through `compile(source, { files })`; resolve chart names
  over the main file plus all imported files, transitively (probe: main imports `a`, `a` imports `b`, main
  references a chart of `b`: works). Report a missing file as a warning with KIELER's text.

---

## 4. For-regions

### S-21 `region R for i : a to b` and `region for i : ARRAY`

A for-region is replaced by one copy of the region per counter value; in each copy the counter is a
`const int` with that value (replaced by the literal everywhere, so it is not in the pool).

- `for i : a to b`: `a` and `b` must be **integer literals** (non-negative: the grammar has no `-`).
  Both ends are included. If `a > b` the copies count down (`3 to 1` → 3, 2, 1). `5 to 5` → one copy.
- `for i : A` (an array): `i = 0 .. size - 1`, where the size is the array's first dimension, an int literal
  or a `const int` with a literal initial value.
- Copies are concurrent regions of the same state; each gets the region's name.
- Evidence: `30-for-range`, `31-for-array`, `32-for-descending-and-order`. Probes: `5 to 5`, `const int N = 3;
  input bool A[N]; for i : A`.
- Source: `processors/For.xtend:98-150` (`getForRegionRange`, `transformForRegionRange`; the Xtend range
  `firstValue..secondValue` counts down when `firstValue > secondValue`).
- Teaching: a for-region is shorthand for writing the same region N times with a different constant. Plain
  English: "one copy of the region per value of i, all running at once."
- Implementation: expand after references (and after region actions) and before everything else that looks at
  regions; substitute the counter by an int literal in each copy.

### S-22 Copies are appended after the state's other regions

The copies replace the for-region at the **end** of the parent state's region list: other regions in source
order first, then the copies in counter order. This order is observable: KIELER runs concurrent relative
updates of the same variable in region order (`32`: regions First, R (3 to 1), Last updating
`s = s * 10 + k` give `s = 97321`, in both netlist and priority).

- Source: `processors/For.xtend:147` (`region.parentState.regions += regionCopyCopy`, then the original is
  removed).
- Teaching: the order of regions normally does not matter; it shows only through concurrent updates of one
  variable (`s += ...` from several regions is fine; order-dependent updates like `s = s * 10 + i` are a bad
  idea).
- Implementation: when expanding, append copies after all regions of the state; keep region order as the
  tie-breaker for concurrent updates.

### S-23 Termination and taken counters

- A state with for-regions terminates when every copy (and every other region) is final; the root chart
  terminates likewise (`31`, tick 3 `terminated = true`).
- All copies share the **original transition's taken counter**: `taken[k]` adds up the firings of every copy
  (`31` tick 2: `taken = [2]`; `32`: `[1, 3, 1]`), because taken-transition signalling runs before the
  expansion (S-15).
- Teaching: a join after for-regions waits for every copy.
- Implementation: keep a back-pointer from each copied transition to its original for the taken counters.

### S-24 What KIELER rejects in for-regions

| Chart | Message |
| --- | --- |
| `for i : 3` (number, no end) | lab: `The for-region range "for i : 3" has a start value but no end value.`; official KIELER crashes (`java.lang.NullPointerException: … because "_forEnd" is null`) |
| `for i : 0 to N`, `N` a const | lab: `The for-region range "for i : 0 to N" ends at N, which is not an integer literal.`; official crashes (`java.lang.ClassCastException: … ValuedObjectReferenceImpl cannot be cast to class … IntValue`) |
| nested for-regions | lab: internal error `java.lang.IllegalArgumentException: Can't copy valued object. Valued object is null!`; official KIELER never reports back |
| a declaration at the top of the for-region whose initial value uses the counter (`int k = i`) | the same (lab: `Can't copy valued object…`; official: no answer) |
| a declaration at the top of the for-region written by several copies (`int k = 0`, `do k = i`) | write-write conflict: `The SCG is NOT asc-schedulable!` (lab: also `Circular dependency involving k prevents scheduling this tick.`) |
| assigning the counter (`i = 5`) | `Cannot replace left hand side of assignment by a value. (Trying to replace ... i by ... (value: 1) in ... i = 5)` |
| `for i : A` with `A[0]` | `Error executing EValidator` (probe) |
| `for i : -1 to 1` | parse error `no viable alternative at input '-'` (probe) |
| `dataflow for i : ...` whose counter is still named after the translation | `The valued object reference points to a valued object (i) that is not contained in the model!` once per use, then `References objects are not contained in the resource!` (below) |

A declaration at the top of a for-region is a region declaration: it moves to the parent state (H-4 in
`concurrency.md`), so all copies share **one** variable. With an initial value that does not use the counter
it compiles and every copy can read it (`95-for-declaration-shared`: `int k = 5` read by three copies,
`sum = 15`); writing it from several copies is a write-write conflict (example
`src/examples/advanced/for-regions/shared-local`); naming the counter in its initial value crashes the compiler
(`94-err-for-declaration-uses-counter`: the region declarations have already been moved to the parent state
when For runs, and For replaces the counter only inside the region copies, `For.xtend:126-150`, so the moved
initial value keeps a reference to the removed original counter). A variable each copy needs for itself is declared
inside a **state** of the for-region (`initial state W { int k = i * 2 … }`): one per copy (example
`src/examples/advanced/for-regions/local-per-copy`, `sum = 12`; official KIELER agrees on all four).

Evidence: `33`–`37`, `94`, `95`; source `processors/For.xtend:49-78` (lab diagnostics),
`SCTXValidator.xtend:1167-1176` (array size not determinable: "The range of the counter variable of the for
region is not determinable. The array cardinalities of you array must be an int or a const int.").

- Teaching: keep for-regions flat and simple: literal bounds, no nesting, and per-copy variables inside a
  state of the region, not at its top.
- Implementation: reject these with KIELER's texts (for the crashes, the engine may give a clearer message
  but must still reject).

---

## 5. Dataflow

**`dataflow for`.** KIELER's Dataflow processor ignores the loop: it turns the region into control flow once,
without copying it, and removes the region with its counter. So the equations run **once per tick**, whatever the
range says (`dataflow for i : 0 to 1 { add() }` calls `add()` once in every tick), and the range itself is never
looked at: the validator's range check is for control-flow regions (`checkForRegion(ControlflowRegion)`), so a
constant as the end, or a variable that is no array as the range, is accepted there. The chart is rejected only
when something still names the counter afterwards (an equation's expression or index, a call's argument, the
expression after a call's `=`, the initial value of a declaration of the region): one message per use. A use that
the translation drops on the way does not count: the index of an instance's port in the classic translation
(S-33), a call removed with the vector after it (S-33a). Official KIELER gives the same message for the counter
as an index or a call's argument and does not answer within 60 s when it is in an expression, a trigger or a
declaration (the lab server reports the message there too). Probes `dataflow/probe-dataflow-for-*` (18: 11
accepted, 7 rejected); the fuzz profile `dataflowObjects` draws the form.

### S-25 A dataflow region recomputes all its equations in every tick

`dataflow { x = e ... }` (or `dataflow:` followed by equations up to the next region) holds equations. Every
equation is evaluated in every tick the region is active, **including the tick it is entered**. KIELER
compiles each equation into its own concurrent region: an initial state with an immediate transition doing
`x = e` into a "delay" state, and a delayed transition back. Because equations are concurrent:

- their textual order is irrelevant; a variable is written before it is read in the same tick
  (initialise–update–read), so chains of equations settle in one tick;
- two equations writing the same variable conflict unless their writes commute in KIELER's sense (S-31: old-style
  updates with each other, applied in textual order; `+=` with `+=`; an absolute write before updates), and an
  instantaneous cycle (`X = Y + I; Y = X`) cannot be scheduled (S-31);
- several dataflow regions, and dataflow regions next to control-flow regions in the same state, communicate
  within the tick the same way (probe: a control-flow region reacting to `O = A` in the same tick).

Equations may use any expression and compound operators (`X += I`). An equation that calls a method (`O =
twice(I)`, `c.add(x)`) changes how KIELER compiles the **whole region**: S-33a.

- Evidence: `40-dataflow-basic`, `41-dataflow-order-independent`, `45-dataflow-self-update`.
- Source: `processors/dataflow/Dataflow.xtend:309-540` (`processDataflowRegionClassic`; equation regions at
  483-505; the region is wrapped in a state `__df_main` at 320).
- Teaching: think of a dataflow region as wiring: outputs follow inputs within the tick. Plain English: "each
  equation is re-evaluated every tick, in whatever order the data needs."
- Implementation: treat each equation as a concurrent thread with one assignment per tick (also in the entry
  tick); schedule by data dependencies like concurrent regions.

### S-26 An equation may read the variable it writes

`N = N + 1` is accepted and reads the value from before this tick's write (it is an update, as in a
control-flow effect); `X += I` accumulates. This is unlike Lustre/SCADE, where `N = N + 1` is a cycle.

- Evidence: `45-dataflow-self-update` (`N = 1, 2, 3`; `X = 1, 3, 6`).
- Teaching: surprising for anyone who knows Lustre; prefer `N = 0 fby (N + 1)` or `pre(N) + 1`, which say
  what is meant.
- Implementation: an equation reading its own target is an update (relative write): evaluate the right-hand
  side with the value from before this equation's write.

### S-27 Sequential equations: `;` or `seq`

An equation followed by `;` or the keyword `seq` is ordered before the next equation (KIELER adds scheduling
directives). In a run of sequential equations a variable may be written several times and read in between,
like statements: `X = I; X = X * 10; X = X + 1` gives `21` for `I = 2`. Two writes `X = I; X = I + 1` are
accepted (last wins, probe), whereas without `;` they conflict (S-31). Without `;`, only writes that KIELER
considers commuting may share a variable, and some of those also run in textual order (S-31). The compiler warns (harmlessly)
`ValuedObject with name _<Root>_local_seq0 is contained in the model but not in VariableStore.`

A `;` after a **call written as an equation** (`k.add(1);`, S-33a) does nothing: KIELER's `isSequential` is true
for assignments only. Such a call is part of a sequence only as the equation after an assignment's `;`. In `o1 =
k.get() + n; k.add(1); k.add(2);` the read and the first call are ordered, and `k.add(2)` is not: it runs before the
read like any other write (KIELER's C code: `k.v += 2; o1 = k.v + n; k.v += 1`).

- Evidence: `44-dataflow-sequential`. Probes: `seq` keyword gives the same result; `O = A && B; P = A || B;`
  (semicolons after independent equations) changes nothing but adds the warning. Calls:
  `dataflow/probe-dataflow-call-semicolon-no-sequence`, `-call-semicolon-between`, `-call-after-sequenced-read`,
  `-call-sequence`, `-call-condition-sequence` (found by the `dataflowObjects` fuzz profile, seed 2).
- Source (calls): `extensions/SCChartsDataflowRegionExtensions.xtend:52-54` (`(a instanceof DataflowAssignment) &&
  sequential`; a `DataflowReferenceCall` is no `DataflowAssignment`).
- Source: `Dataflow.xtend:477-489` (schedule per run of sequential equations), grammar `SCTX.xtext`
  (`sequential?=(';'|'seq')?`).
- Teaching: a `;` after an equation is not a harmless separator; it sequences equations.
- Implementation: a run is a maximal sequence of consecutive equations in which every equation but the last
  ends with `;`/`seq` (the equation after the last `;` belongs to the run). Execute a run as one sequential
  thread in textual order; runs and the other equations are concurrent with each other.

### S-27a Written schedules: `schedule` declarations and `schedule s 1` clauses

`schedule {conflicting, commuting} s` declares a schedule object `s` (the list gives the protocol of priorities 0,
1, ...; a priority past the list is conflicting; `global <protocol>` and the name string change nothing in the
compiler). A clause `schedule s 1` puts what it is written on into `s` at priority 1:

- after an assignment, `x++` or `print(...)`: that effect's reads and writes;
- after a trigger (`if x > 0 schedule s 0 go to B`, also on actions): every variable the trigger reads, as long as
  the trigger stays the whole condition (a trigger that is a single variable keeps it on the variable);
- on a state (`state S schedule s 1 { ... }`, `state S is C(...) schedule s 1`): the triggers and effects of its
  outgoing transitions and, unless the state has no regions and no actions, of its actions and of everything in
  its regions, after all other transformations (so also the regions and transitions they made);
- on a region (`region R schedule s 1 { ... }`): the same for its actions and states.

For a variable, the accesses that share a schedule object are ordered by priority instead of
initialise-update-read: a lower priority comes first, whatever it reads or writes; at one priority a read comes
before a write, two writes conflict unless the priority is commuting. Pairs ordered this way are left out of
initialise-update-read. Contradictory orders (two objects, or a schedule against a data dependency) are a cycle:
`Can't schedule from ...`. KIELER warns `ValuedObject with name s is contained in the model but not in
VariableStore.`

An emission's clause is lost: the Signal processor replaces the emission by new assignments; so is the clause of a
trigger that is a single signal (`if V schedule s 0`, `if V[1] schedule s 0`, also on a during action and for a
signal parameter of a referenced chart), whose reference is replaced by a new one of the presence variable, and of
`val(V)` alone, which becomes the reference inside it. A trigger with an operator keeps it (`!V`, `V && c`,
`pre(V)`, `val(V) > 1`, a count `2 V`), and so does a base chart's signal tested alone in the extending chart
(`probe-schedule-signal-*`, `-inherited-signal-trigger`, `-binding-*`). A
clause naming a variable that is not a schedule crashes the dependency analysis (`java.lang.ClassCastException:
... VariableDeclarationImpl cannot be cast to ... ScheduleDeclaration`) **where it has something to order**: KIELER
casts the declaration for every access it makes with the clause. So it crashes on an assignment (its write, also
`o = random()`), on anything that reads a variable (`print(o)`, a trigger), and on a call of a C function (the
scheduled call is a writer); it is silently accepted on `print("x")`, on a trigger without a variable (`if true`,
a constant) and on a call of a short method that only prints (`-not-a-schedule-print-const`, `-print-var`,
`-print-index`, `-print-const-decl`, `-trigger-const`, `-call-cfn`, `-call-print`, `-randomize`). A clause on a
state reaches the counters of the taken transitions inside, which are assignments (`-not-a-schedule-state-print`,
`-state-idle` crash; `-state-empty`, without a transition inside, and `-referenced-state-print`, whose referenced
chart's transitions are not counted, do not). Only the code KIELER's dependency search visits counts: not a state
that is never entered (`-dead-state`, `-dead-state-call`), not a method nobody calls or that only such methods
call (`-chain-uncalled`); a method reached through other methods does, however deep, its own local variables
included (`-not-a-schedule-transitive`, `-three-deep`, `-cfn-in-cfn`, `-class-chain`, `-trigger-chain`, `-local`).

- **Priority 1 quirk.** A scheduled access's priority replaces its access class in KIELER's dependency analysis,
  and 1 is the class of a relative write: two assignments at priority 1 whose operators do not commute (`w += 1`
  and `w = 2`, or `w += 1` and `y = w`) are a write-write pair, even at a `commuting` priority and even when one of
  them only reads: concurrent, they are rejected (`probe-schedule-commuting-mixed`, `-p1-write-read`). The same
  pair at priority 0 is confluent (`-commuting-mixed-p0`); two `=` at priority 1 commute (`-commuting-same-op`).
- A vector assignment `x = {1, 2} schedule s 0` loses its schedule: KIELER's ArrayAssignment makes new element
  assignments (`probe-schedule-array-vector`, rejected as an unscheduled conflict).
- `state S schedule s 0 { schedule s ... }` names the state's own `s` (`probe-schedule-state-local`).
- **In code blocks and method bodies** a clause stands after an assignment, `x++`, `print(...)`, a call, and after an
  `if` condition (`if x > 0 schedule s 1 { ... }`); not after `return`, `while (...)` or the block itself. The body's
  statements keep their clauses whichever way KIELER compiles the body: copied into place (a short method or block),
  its statements are nodes of the tick with their clauses; kept as a C function (a loop, a call, 28 statements or
  more), its accesses count as the calling effect's, each with the clauses written inside
  (`-method-body`, `-body-rev`, `-body-loop`, `-body-if`, `-body-nested-call`, `-codeblock-loop`, `-codeblock-goto`,
  `-codeblock-in-action`, `-body-in-trigger`, `-cfn-calls-scheduled`, `-body-twice`). A method nobody calls is not
  looked at (`-body-never-called`, also a clause naming a variable that is not a schedule: `-not-a-schedule-uncalled`
  against `-not-a-schedule-block`).
- **On a call effect** (`do f() schedule s 1`, also the clauses a state or region passes down):
  - a short method: the clause goes to every assignment of the copied body, after the assignment's own clauses, and
    not to the body's conditions (`-call`, `-call-rev`, `-call-if`, `-call-inlined-args`, `-call-p1-quirk`,
    `-state-schedule-codeblock`);
  - a C function: the clause does not reach the body, whose accesses stay in initialise-update-read (`-call-loop`,
    `-state-schedule-cfn`, `-block-call-noparam-sched-cfn`: two writes conflict). The scheduled call itself reads and
    writes the *method* (for `c.m()`: reads `m`, writes the instance `c`) in that schedule, so two scheduled calls of
    one function are ordered by priority, and at one priority each reads what the other writes: a circle
    (`-call-same-cfn`, `-call-same-cfn-rev`, `-call-same-cfn-same-prio`, `-call-two-cfn`, `-call-instance-writer`),
    unless the priority is commuting (`-call-same-cfn-commuting`, `-noarg`, `-p1`, `-call-instance-cfn-commuting`,
    `-value-call-cfn-commuting-write`; two functions that write one variable still conflict inside:
    `-call-two-cfn-commuting`). A C function called by a C function gives its scheduled statements to the calling
    effect too, and a clause on the inner call statement reaches neither body (`-cfn-in-cfn`, `-rev`, `-value`,
    `-class`, `-two-callers`, `-call-clause`, `-cfn-statement-call`);
  - **exactly one argument: the clause is lost.** `f(1) schedule s 1` parses as a valued emission, and the converter
    that makes it a call again copies the target and the value only. The clause's names are never looked up
    (`schedule nosuch 1` is accepted). Zero or two arguments keep it; so do calls in code blocks, and what a state
    or region passes down (`-call-one-arg-inlined`, `-call-one-arg-unknown`, `-call-two-arg-unknown`,
    `-one-arg-instance`, `-one-arg-entry`, `-region-schedule-one-arg`).
- **A scheduled assignment whose value calls a C function** (`o = get() schedule s 0`) reads the method in that
  schedule; the function's body does not get the clause (`-call-value-loop`). Two such effects are ordered through
  the method, and at one conflicting priority two *reads* are a circle (`-readers-same-prio`, `-readers-diff-prio`,
  `-readers-same-prio-commuting`, `-value-call-cfn-*`).
- **A scheduled trigger that calls a short method of the chart** is refused: `User schedules are not supported in
  combination with method inlining!` (the trigger's schedule is put on every reference of the trigger, and the call
  is one). A C function is fine; a member call `c.get()` is fine too, because the schedule sits on `get` and is lost
  when the call is replaced (`-call-in-trigger`, `-call-in-trigger-loop`, `-trigger-call-op`,
  `-trigger-call-alone-cfn`, `-trigger-member-call-scheduled`).
- **A scheduled condition of a body that is a call of a short method** is refused with the same message, a member
  call too: in a body the clause sits on the condition itself, so `if yes() schedule s 0` puts it on the call, and
  an operator around the call is fine (`if yes() && o == 0 schedule s 0`), as is a call of a C function
  (`-cfn-cond-call`, `-member`, `-codeblock`, `-op`, `-cfn`, `-plain`). KIELER's Methods processor only meets the
  call in the bodies it works on: the C functions the tick calls and the ones they call in turn, and the bodies it
  copies into place (`@inline`); not a method nobody calls and not a state that is never entered
  (`-cfn-cond-call-transitive`, `-inline-anno`, `-uncalled`, `-dead-state`).
- **The index of a scheduled target** is read without the clause when the target is a plain array (`o[i] = 7 schedule
  s 0` reads `i` in initialise-update-read) and with it when the target is a member (`c.arr[i] = 7 schedule s 0`)
  (`-index-read-schedule`, `-member-index-schedule`).
- **Schedules of classes.** A `schedule` declared in a class is one schedule per instance: KIELER moves it into the
  chart as `<Class>_<instance>_<name>` (the warning then names `C_c_s`). `schedule c.s 1` names the instance's, on
  anything a clause can stand on; two instances have two schedules (`-instance`, `-instance-nonmember`,
  `-instance-two`, `-instance-trigger`, `-instance-state-region`, `-instance-codeblock`, `-instance-in-method`,
  `-instance-in-cfn`, `-instance-commuting`, `-instance-conflict`, `-inherited-instance-clause`). Refused, used or
  not: a schedule in a class inside a class (`Scheduling declarations in nested classes are not yet supported (s)`)
  and in a class with an array of instances (`... with cardinalities are not yet supported (cs)`)
  (`-instance-nested`, `-instance-nested-unused`, `-instance-array`, `-instance-array-unused`, `-contract-array`,
  `-contract-nested`). KIELER looks two classes deep: a schedule further in stays one ordinary schedule
  (`-three-levels`, `-clause-three-levels`). In an unpacked class (@UnpackClass) it is the chart's (`-unpack-instance-
  clause`). A `private schedule` can only be named inside the class. Inside the class, **every reference to the
  class's schedule that does not go through an instance** is an error, whether the method is called or not:
  `Referring to scheduling directive in classes without reference to instance (c)`, once per instance. That is a
  clause on a statement or a condition of a method (`-contract-body-clause`, `-class-bare-unused`,
  `-class-bare-clause-on-call`, `-class-two-instances-bare`, `-class-inner-bare-outer`: a class inside the class
  naming the outer one's) and the schedule read as a value, in a method or in a member's initial value
  (`-class-schedule-value`, `-value-uncalled`, `-print`, `-condition`, `-value-init`). Through the instance it is
  fine, inside the class too (`void set() { v = 1 schedule c.s 0 }`: `-class-method-clause-qualified`).
- **A chart used as a class** (`ref Sub x`, S-65) is the class of `x` by the time KIELER looks: Sub's declarations
  are the members, its regions and actions belong to the declaring chart. So:
  - Sub's schedule is the instance's: `schedule x.s 1` names it on anything a clause can stand on, also from a
    chart that is itself referenced, with a binding, for a `private schedule` and for one Sub inherits; two
    instances have two schedules (`-ref-clause`, `-rev`, `-trigger`, `-state-region`, `-codeblock`, `-two`,
    `-commuting`, `-conflict`, `-and-contract`, `-bound`, `-in-referenced`, `-ref-private-schedule`,
    `-ref-clause-sub-inherits`, `-ref-in-state-clause`, `-ref-and-state`). After `x.` a schedule clause sees only
    schedules: a variable `s` of Sub, a class of Sub (`x.c.s`) and anything behind a `ref` inherited from a base
    chart do not resolve (`-ref-clause-not-a-schedule`, `-nested-class`, `-inherited`); `o = x.s` does not either.
  - A class of Sub is a class inside a class: its schedule is refused, used or not, also when `x` is declared in an
    inner state, in a base chart or in a chart referenced by a state, and for a chart instance inside Sub; three
    levels deep is not looked at (`-ref-nested-class`, `-ref-nested-ref`, `-inherited`, `-in-referenced`,
    `-sub-inherits`, `-class-in-state-nested-ref`, `-ref-array-nested`, `-chart-instance-class-schedule`,
    `-chart-instance-in-instance`; `-ref-three-levels`, `-ref-three-refs`). A schedule that deep (a class inside a
    class of Sub, which Sub compiled alone is refused for) stays an ordinary schedule that orders what names it,
    also in an array of instances, and every instance has its own (`-chart-instance-deep-class`,
    `-deep-class-order`, `-deep-class-two`, `-deep-class-array`; `-deep-class-two-order`: two instances that each
    order their writes of one output contradict each other). The
    same Sub referenced by a state (`state S is Sub`) keeps its class at the first level (`-ref-nested-class-state`),
    and a class declared in an inner state of Sub is not a member of the class of `x` (`-ref-inner-state-class`).
  - An array of instances (`ref Sub x[2]`) of a chart with a schedule is refused like a class's
    (`... with cardinalities are not yet supported (x)`: `-ref-array`, `-contract`, `-clause`, `-bare`,
    `-ref-inherited-array`), used or not, also an array of one (`-chart-instance-array`, `-array-unused`,
    `-array-of-one`, `-array-in-copy`).
  - Sub's own name for its schedule is rewritten to `x.s` where KIELER moves code out of the class: on its
    transitions, triggers, states, regions and actions, in code blocks there and in the methods of its inner
    states, and a call of its contract method by its name alone from a transition becomes `x.set()`
    (`-ref-bare-effect`, `-trigger`, `-state-clause`, `-region-clause`, `-codeblock-transition`, `-codeblock-entry`,
    `-inner-state-method`, `-call-in-transition`, `-ref-contract-bare-trigger`). In the methods Sub declares at its
    top, and in the methods of its classes, the name stays bare: the error above with `(x)`, called or not
    (`-ref-bare-statement`, `-uncalled`, `-inherited`, `-in-middle`, `-ref-bare-class-method`, `-ref-two-bare`,
    `-ref-inherited-bare`); so does a call of a contract method by its name alone from another method
    (`-ref-sibling-call`; in a condition it gets no contract and is fine: `-ref-sibling-in-condition`) and the
    schedule read as a value in a method or an initial value (`-ref-schedule-value`, `-value-init`).
- **A schedule read as a value** where no class is in the way (`o = s`, `o = c.s`, a chart's schedule read in a
  class method, Sub's own on one of its transitions) is a variable KIELER's C code never declares: gcc fails
  (`'TickData' has no member named 's'`, `C_c_s`, `Sub1_x_s`), in the tick and in a C function, not in a method
  nobody calls or a state never entered (`-chart-schedule-value`, `-cfn`, `-trigger`, `-uncalled`, `-dead-state`,
  `-instance-schedule-value`, `-class-schedule-value-chart-schedule`, `-ref-schedule-value-transition`).
- **A schedule declaration cannot be inherited.** `scchart T extends Base` where `Base` declares `schedule s` at its
  top is rejected, used or not: KIELER's Inheritance enters every variable it copies into its variable store, the
  schedule without a type, and the simulation's interface fails (`Cannot serialize simulation interface.
  Unsupported type null for variable s`; a private one: `Base_s`). The same for a base two charts up, a superstate
  that extends, a chart referenced with `is` and the instance of a classic dataflow region (a referenced state)
  (`-inherited-declaration`, `-unused`, `-two-levels`, `-private`, `-inner-state`, `-is`, `-dataflow-classic`). Not
  inside a declared instance: there the copy that Inheritance entered is not the one that reaches the model (the
  instance's root becomes a class whose schedule is moved out as a copy, its regions are cloned), and a store entry
  whose variable is gone is left out (`-inherited-declaration-instance`, `-inner-state-in-instance`,
  `-dataflow-oo`). A schedule in a class of the base chart is inherited without trouble
  (`-inherited-instance-clause`). Engine code `inherited-schedule`.
- **Contracts.** `void set(int x) schedule s 0 { ... }` in a class is the method's contract: the clause is copied
  onto what calls the method, marked with the method's name. The copy goes on the effect around the call (also a
  statement of a method body: `-contract-in-method-statement`), or on the trigger; a call in a condition or a
  `return` of a method body gets none, so there the contract is ignored (`-contract-in-return`,
  `-sibling-in-condition`). What a marked clause orders:
  - the call was copied into place: every access of the copied statements and of the calling effect, *and the object
    itself* for every member touched (KIELER registers the member's parent). So `c.set(5)` at priority 0 comes
    before `o = c.get()` at 1 (`-class-methods`, `-class-methods-rev`, `-contract-sequential`,
    `-contract-two-instances`, `-contract-in-state`, `-contract-during`, `-contract-exit-action`,
    `-contract-inherited`, `-contract-referenced`, `-chart-as-class-contract`), two calls at one conflicting priority
    are a circle even when both only read (`-contract-same-prio`, `-contract-for-region`; fine when commuting:
    `-contract-same-prio-commuting`), and two methods that touch no member of the object are not ordered at all
    (`-contract-other-var`). The conditions of the body are not scheduled (`-contract-cond-body`);
  - the call stays (a C function): the method and the object, nothing inside the body (`-contract-cfn`,
    `-contract-cfn-rev`, `-contract-trigger-cfn`, `-contract-trigger-alone-cfn`, `-chart-class-cfn`);
  - in a trigger with a call copied into place the copy is lost for the call, but stays on the trigger's other
    references (`-contract-trigger-op`, `-contract-trigger-alone`, `-contract-trigger-other-ref`), and it makes a
    short chart method called in the same trigger an error (`-contract-trigger-root-call`).
  - The priority 1 quirk works through the object: `o += c.get()` and `c.set(5)`, both contracts at priority 1,
    conflict whatever the protocol (`-contract-p1-op`, `-contract-p1-same-op`, `-contract-p1`).
  - A contract and other clauses add up; contradicting orders are a circle (`-contract-and-clause`,
    `-contract-and-clause-call`, `-contract-cycle`, `-contract-and-instance-clause`).
  - Rejected: a contract on a method that is not in a class, or naming a schedule declared outside the class, once
    the method is called anywhere, reachable or not (`java.lang.NullPointerException ... getEnclosingClass(...) is
    null`: `-method-decl`, `-contract-outside-schedule`, `-contract-unpack`, `-root-contract-dead-call`,
    `-referenced-root-contract`; never called it is accepted: `-contract-noncalled-root`,
    `-contract-outside-never-called`); a contract that names its schedule through an instance (`schedule c.s 0`: of
    another object, of a chart used as a class, even of the method's own instance) or names something that is no
    schedule, again once the method is called, also from a method nobody calls (`java.lang.ClassCastException:
    PolicyClassDeclarationImpl`, or `VariableDeclarationImpl`, `cannot be cast to ... ScheduleDeclaration`: KIELER
    takes the declaration of the first name as the schedule's; `-contract-other-object`, `-other-class`,
    `-other-object-dead`, `-contract-ref-object`, `-contract-qualified-own`, `-contract-not-a-schedule`, `-root`;
    never called all of these are accepted: `-contract-other-object-uncalled`, `-qualified-own-uncalled`,
    `-not-a-schedule-uncalled`, `-ref-contract-uncalled-qualified-root`); a contract method that is never called
    (`Referring to scheduling directive in classes without reference to instance (c)`: `-contract-never-called`,
    `-chart-class-never-called`, `-ref-in-referenced-contract-uncalled`, `-ref-inherited-contract-uncalled`; a call
    in a method nobody calls or in a state never entered counts: `-contract-called-in-dead-method`,
    `-contract-dead-state-only`); a call by the method's name alone in a statement of another method of the class
    (`-contract-sibling-call`, `-order-twoclass*`).
  - **In the initial value of a local variable of a body** the copy goes on the value itself, that is on its
    outermost expression. When that is a call of a method KIELER copies into place, the Methods processor refuses
    (`User schedules are not supported in combination with method inlining!`), whichever call below it brought
    the contract: `int k = c.get()`, `int k = wrap(c.get())` with a short `wrap`, `d.id(c.get())`
    (`-contract-in-local-init`, `-init-arg-inlined`, `-init-arg-member-inlined`, `-init-contract-cfn-arg`,
    `-init-nested-used`, `-init-in-inline-anno`). It is fine when the outermost call is a C function (the contract
    then orders the block's statement: `-init-arg-cfn`, `-order`, `-method`, `-twice`, `-local-init-cfn`), when the
    value is an operator (`-init-operator`, `-init-operator-cfn`, `-init-top-extern`), and in a body the Methods
    processor never works on: a method nobody calls, a code block of a state that is never entered
    (`-init-arg-uncalled`, `-init-dead-state`). The initial value of a state's variable is an entry action by then
    and fine (`-contract-init-rev`, `-contract-init-alone`).
  - Inside C functions the copies work as on effects: on a statement that assigns, calls or passes the contract
    method's value they order the calling effect against the object's other contracts, in a condition or a
    `return` there is none (`-order-assign*`, `-witharg*`, `-withcall*`, `-withcond*`, `-withreturn*`,
    `-contract-in-class-cfn*`, `-contract-own-cfn-*`).
- **Host classes** get a schedule of their own when a method has none and there is another method: one priority per
  method, in the order declared. Every method then has a contract: a method that is never called is the error above
  (`-host-two-methods`), and two concurrent calls of one method are a circle (`-host-typedef-same-method`).
- Some charts with many contradicting schedules make KIELER's compiler never finish (found by the `schedules` fuzz
  profile, seed 1; the engine rejects them).
- Evidence: `tests/engine/kieler/schedules/probe-schedule-*` (commuting, conflicting, cycle, read-first, global,
  referenced-state, two-objects, trigger, trigger-ref, state-body, simple-state, region, during, entry, aborts,
  emit, relative, instances, unknown, not-a-schedule, and the probes named above), `tests/engine/kieler/parity/
  probe-user-schedule*`.
- Source: `processors/UserSchedule.xtend:85-140, 141-400 (transformContracts), 463-494`,
  `SCGTransformation.xtend:632-657`, `AbstractDependencyAnalysis.xtend:160-375` (the accesses per schedule, method
  specific matches, artificial writers), `400-526` (processDependencies, accessType),
  `MethodSpecificSchedulingDirectiveUtil.xtend`, `DependencyTransformationV2.xtend:178-232` (inner accesses),
  `MethodProcessor.xtend:89-128 (process: remaining calls), 150-177 (inlineCalls), 219, 288-312`,
  `ValuedObjectAccess.xtend:62-73` (the cast), `Reference.xtend:927-1010` (a referenced chart becomes a class),
  `SCLToSCGTransformation.xtend:484-493`,
  `KEffectsEmissionReferenceCallConverter.xtend:62-112`, `processors/Signal.xtend:233-309`.
- Teaching: rarely needed; data dependencies order most charts. Shows that "who goes first" is a compiler decision
  the programmer can override. A contract says it once, on the method, for every call.

**Dataflow.** A clause on a dataflow region (`dataflow D schedule s 1 { ... }`) is copied to the control-flow
region KIELER makes of it, so it is on every equation of the region (and, in a region that calls methods, not on the
regions of its chart instances, which belong to the declaring state). A clause on an equation (`o = 1 schedule s 1`)
is **lost** in a region without method calls (the classic translation makes a new assignment of target, operator
and expression only) and **kept** in a region that calls a method (the OO translation copies it, S-33a); on a call
written as an equation it orders the call (`c.add(10) schedule s 0` before `c.add(x) schedule s 1`). A vector
equation's clause is lost in both (its parts are new assignments).

| Chart | KIELER |
| --- | --- |
| `dataflow D schedule s 1 { o = 1 }` next to a transition's `o = 2 schedule s 0` | `o = 1` (the region's write last); with the priorities swapped, tick 1 keeps the transition's 2 |
| `dataflow { o = 1 schedule s 1 }` next to that transition (no method call in the region) | rejected, at either priority: the clause is gone, two unordered absolute writes (`Can't schedule from ...`) |
| the same region with `m = twice(x)` in it | accepted, ordered by the priorities |
| `dataflow { o = x schedule s 1  m = o + 1 schedule s 0 }` | classic: `m` follows `o` in the same tick (clauses ignored); with a method call (`o = twice(x) schedule s 1`): `m` reads the previous tick's `o` |
| a scheduled region with a `;` sequence in it | rejected: the region's one priority is on every equation of the sequence, whose writes then conflict |
| a scheduled OO region that wires an instance (`g.a = ...`, `o = g.s`) | rejected: at one priority a read comes before a write, against the data flow through the instance |
| `g = {x, twice(x)} schedule s 1` next to a transition's `g.a = 50 schedule s 0` | rejected: the vector's parts carry no clause |

- Evidence (dataflow): `dataflow/probe-dataflow-region-schedule`, `-region-schedule-first`,
  `-region-schedule-two-regions`, `-region-schedule-sequence` (rejected), `-region-schedule-instance` (rejected),
  `-equation-schedule-lost`, `-equation-schedule-lost-first` (rejected), `-equation-schedule-ignored`,
  `-equation-schedule-oo`, `-equation-schedule-oo-first`, `-equation-schedule-oo-order`, `-call-schedule`,
  `-vector-schedule-lost` (rejected).
- Source (dataflow): `processors/dataflow/Dataflow.xtend:124-129, 315-320` (`r.schedule += s.copy`), `:231-250` (OO:
  `it.schedule += assignment.schedule`), `:511-516` (classic: reference, operator and expression only).
- Implementation: lowering keeps clauses on effects (`o.schedule`), triggers and `if` conditions (`sched`), states
  and regions (`ext.userSchedule`, a dataflow region's too), equations (`CEquation.schedule`) and method declarations
  (`CMethod.schedule`), and makes a class's schedule one variable per instance (lower.ts classSchedule). The lowering only records (how many classes are around a schedule,
  whether a clause is written through an instance, whether a method is called by its name alone); what KIELER
  refuses is decided where KIELER decides it, on the model after the Reference pass made every chart used as a
  class the class of its instance: passes/contracts.ts (classSchedules: nesting, arrays, a class's schedule without
  its instance; then the contracts are copied onto the calls); passes/dataflow.ts hands a dataflow region's clause
  on and keeps an equation's in the OO translation only; passes/userSchedule.ts spreads the clauses of states and
  regions; structure/methods.ts passes a calling effect's clauses to the copied body and ports the
  Methods processor's view of the bodies (bodyProblems: the functions that remain, a call with a schedule that
  cannot be copied into place, a schedule read as a value); deps.ts gives every access the clauses of its place
  (`schedule`: method specific matches, the object, the method a call names), orders them, and finds the clause
  that names no schedule where an access is made with it (scheduleCasts). Open: charts with host classes are not
  analysed, so two concurrent calls of one host method are not rejected.

### S-28 Delays: `->`, `fby`, `pre`, `sfby`

| Expression | First tick of the enclosing state | Later ticks |
| --- | --- | --- |
| `a -> b` | `a` | `b` (current value) |
| `a fby b` | `a` | `b` of the previous tick |
| `a -> pre(b)` | rewritten to `a fby b` | |
| `pre(x)` | 0 / false (the neutral element, whatever `x`'s initial value) | `x` of the previous tick |
| `a -> b -> c` | `a` | `c` (current value): the middle operands are ignored (probe: `1 -> 2 -> I` = 1, I, I, ...) |
| `a fby b fby c` | `a` | tick 2: `b` of tick 1; then `c` of two ticks before (probe: `1 fby 2 fby I` = 1, 2, I₁, I₂, ...) |
| `a sfby b` | `a` | `b` (current value), i.e. like `->` |
| `a sfby b sfby c` | `a` | `b`, `b`, ... (c never appears: KIELER defect) |

"First tick" is the first tick of the state that contains the equation: re-entering that state restarts the
delays (`50-dataflow-reentry-restarts-delays`, tick 3: `A = 0, B = 0` again).

- Evidence: `42-dataflow-init-fby-pre` (`input int I = 7`: first-tick `pre(I)` is 0), `46-dataflow-sfby`, `57-dataflow-delay-chains`,
  `50`. Probe: `output int N = 10; N = pre(N) + 1` gives `N = 1` in tick 1.
- Source: `processors/InitOperator.xtend:73` (rewrite), `:91-104` (region: Init −immediate/ v = a→ Delay
  −delayed/ v = b→ Loop −immediate→ Delay); `processors/FollowedBy.xtend:92-130`;
  `processors/SequentialFollowedBy.xtend:97-112`; `processors/Pre.xtend` (`getNeutralElement`).
- These operators also work in control-flow effects (S-30).
- Teaching: `->` initialises, `fby` delays by one tick with a start value, `pre` delays without one (0 at
  first). Plain English: "`0 fby x` is x one tick late, starting with 0." Avoid `sfby`.
- Implementation: give each occurrence its own state, created when the enclosing state (for dataflow: the
  state holding the dataflow region) is entered: `->` and `sfby` select their first operand in that state's
  first tick and their second after; `fby` keeps a register updated at the end of every tick with the second
  operand's value; `pre` registers start at 0/false. The operands are evaluated in every tick (also the first,
  for the second operand of `fby`).

### S-29 Precedence traps: `->`, `fby`, `sfby` and `?:` take atoms

The operands of `->`, `fby` and `sfby` (and of the ternary `c ? a : b`) are atomic expressions, so these
operators bind more tightly than everything else:

- `0 fby N + 1` is `(0 fby N) + 1`; write `0 fby (N + 1)` (`43-dataflow-delay-precedence`: N1 = 1, 2, 3 vs
  N2 = 0, 1, 2).
- `0 -> I + 100` is `(0 -> I) + 100` (probe: 100, 106).
- `A > B ? A : B` is `A > (B ? A : B)`; write `(A > B) ? A : B` (`52-dataflow-ternary-precedence`:
  `wrong = 0`, `right = max`).
- Source: `kexpressions/src/.../KExpressions.xtext` (rules `TernaryOperation`, `InitExpression`,
  `FbyExpression`, `SfbyExpression`, all over `AtomicValuedExpression`).
- Teaching: always parenthesise the operands of `fby`, `->` and `?:`.
- Implementation: in the expression grammar these operators sit just above atoms (atom: literal, reference,
  call, `pre(...)`/`val(...)`, parenthesised expression); `a -> b -> c` and `a fby b fby c` are n-ary
  (one operator node with all operands), `?:` takes three atoms.

### S-30 `fby` outside a dataflow region blocks termination

`->` and `fby` can be used in any effect. KIELER implements `fby` with a helper region that is not final, so a
superstate containing an `fby` never terminates (its `join to` never fires); `->`'s helper region is final and
does not interfere.

- Evidence: `51-fby-blocks-termination` (tick 1: `doneY = true`, `doneX = false` for ever).
- Source: `processors/FollowedBy.xtend:92` (no `final = true`) vs `processors/InitOperator.xtend:91`.
- Teaching: avoid `fby` in control-flow effects inside superstates that should finish.
- Implementation: the helper region is added to the state enclosing the action (for a transition: the
  superstate containing its source state; for an entry/during/exit action: the state owning it). That state,
  and every state containing it, can never terminate. Reproduce it.

### S-30a `->` and `fby` with a bool operand next to an int expression cannot be simulated

KIELER stores the value of an `->` or `fby` in a helper variable (`__iop_<n>` for `->`, `__fbp_<n>` and
`__fbp_next<n>` for `fby`) whose type it infers from the operands (`KExpressionsTypeExtensions.inferType`).
When the operands mix a bool (a literal or a bool variable) with an expression over ints (a comparison of
ints included), the inferred type is `UNKNOWN`, and the simulation cannot be built:
`Cannot serialize simulation interface. Unsupported type: UNKNOWN` (lab adds `… Unsupported type UNKNOWN for
variable _St89MixedDelay_local___iop_0`; official adds `Compiler did not return success`).

| Expression (target `bool high`, `int level`, `bool B`, `float f`) | Result |
| --- | --- |
| `false -> (level > 3)`, `false fby (level < 1)`, `0 -> B` | rejected (UNKNOWN) |
| `false -> B`, `(level > 9) -> (level > 3)`, `1 -> f` | compiles |

The same holds in control-flow effects (`do high = false -> (level > 3)`, probe). KIELER defect: the C type of
the helper should simply be the target's.

- Evidence: `89-err-dataflow-mixed-type-delay` (both operators); example
  `src/examples/advanced/dataflow/mixed-types`; probes for the other rows (official KIELER agrees on all).
- Source: `processors/InitOperator.xtend:85-88`, `processors/FollowedBy.xtend:82, 99, 116`
  (`createVariableDeclaration(… inferType)`); `kexpressions/.../extensions/KExpressionsTypeExtensions.xtend:42-58`
  (`isArithmetic` is false when a bool is present, and a bool literal next to an int comparison is neither
  "all bool" nor "all int").
- Teaching: give both operands the same kind of expression: `(level > 9) -> (level > 3)`, or `false -> B`
  with a bool variable `B`, not a bool literal next to an int comparison.
- Implementation: infer the helper type as KIELER does and reject `UNKNOWN` with KIELER's message.

### S-31 What KIELER rejects in dataflow regions

| Chart | Message |
| --- | --- |
| a signal as the left-hand side (`S = A && B`) | `Non-variables cannot be used in an assignment.` |
| two equations for one variable that are both absolute writes with different right-hand sides (`X = I`, `X = I + 1`), or relative writes whose operators do not commute (`X = X + I` with `X += 2`, `59-err-dataflow-update-conflict`) | `Can't schedule from _g2 to _g6`, `Can't schedule from _g6 to _g2`, `The SCG is NOT asc-schedulable!`, `Circular dependency prevents scheduling this tick.` (+ warnings `Potential instantaneous loop.`) |
| an instantaneous cycle (`X = Y + I; Y = X`) | the same four errors |
| a scalar assigned to an instance (`g = X`) | `You are assigning a scalar value to a reference. You should specify the input variable of the reference or use a vector value instead of a scalar.` |
| `dataflow for` whose counter is used | see S-24 |
| a chart that indexes its own array port, wired in a classic region | gcc: `subscripted value is neither array nor pointer nor vector` (S-33) |
| a vector after the call of an extern function (`f(1) = {true}`) | `java.lang.NullPointerException: Cannot invoke "...DeclarationScope.getDeclarations()" because the return value of "...asDeclarationScope(...)" is null` (S-33a) |
| `false -> (level > 3)` and similar mixed operands | see S-30a |
| `dataflow once` in a state with a self-loop; `join to` from a dataflow state into a state with an entry action | see S-32 |
| `g(X, Y).O` (call syntax on an instance) | parse error `mismatched input '.' expecting '}'` (probe) |
| `add(x, y)` with `ref DAdd add` (calling an instance) | `Couldn't resolve reference to ValuedObject 'add'.` (a call names a method or an extern function only; `dataflow/probe-dataflow-call-of-instance`) |
| an extern function called as an equation of its own (`absf(x)`) | `You are assigning a scalar value to a reference. ...` (the call is its own target, S-33a; `-call-extern`) |
| an instance wired in a classic region and named anywhere else (a second dataflow region, a transition) | `The valued object reference points to a valued object (g) that is not contained in the model!` (S-33) |
| `ref C g(x)`, `ref C g(x to a)` wired in a classic region | `There are binding errors in a referenced state!\nA Valued Object is supposed to be bound, but there is no free Valued Object left in the referenced scope: __df_g_r` (S-33) |
| an instance declared in the chart and wired in a dataflow region of an inner state | `The referencing binding is erroneous!` (the validator only excuses instances used by the dataflow regions of the declaring state; `-instance-declared-outside`) |

Evidence: `53`–`56`, `59`. Source: `SCTXValidator.xtend:668-673` (non-variable assignment), `:1179-1190`.

Several equations for one variable **are** accepted when the general concurrency rules allow it
(`concurrency.md` C-3 to C-6; `58-dataflow-concurrent-updates`, official KIELER agrees):

- old-style updates (`X = X * 2`, `X = X + 3`: the target read once, operator `=`) all commute with each
  other, whatever their arithmetic, and are applied **in textual order** (`X = 1 * 2 + 3 = 5`; written the
  other way round, `Y = (1 + 3) * 2 = 8`);
- compound updates whose operators commute (`Z += I`, `Z += 2`);
- one absolute write followed by updates (`W = I`, `W = W * 10`: the absolute write first, initialise–update).

An update keeps building on the variable's value from the previous tick (`X` = 5, 13, …). Old-style updates in
several equations are order-dependent and look like Lustre equations that they are not; use one equation per
variable (or `;` sequences, S-27).

- Teaching: one equation per variable, no instantaneous cycles; break a feedback loop with `pre` or `fby`.
- Implementation: the double write and the cycle fall out of the general concurrency analysis (S-25); the
  signal and scalar-to-instance cases are validator errors.

### S-32 Other dataflow details

- Declarations inside a dataflow region (`dataflow { int t  t = I * 2  X = t + 1 }`) are region locals, hidden
  from the pool (probe: `X = 3, 5`).
- A vector equation assigns array elements: `O = {A + 1, B * 2}` (probe: `O = [2, 4]`); `_` skips one. KIELER makes
  one new assignment `O[k] = value` per value from the array's name alone, so an index, a member or an operator
  written on the target is gone: `A[2] = {x, x + 10}` writes `A[0]` and `A[1]`, `A += {x, x + 10}` assigns, a row
  `B[1] = {..}` of a two-dimensional array assigns the rows `B[0]`, `B[1]` (gcc: `assignment to expression with array
  type`), `gs[1] = {..}` on an array of instances is a gcc error too. A vector assigned to a scalar is dropped
  (`o = {x, x + 10}` leaves `o` alone). Probes `dataflow/probe-dataflow-vector-*`, `-instance-array-vector`.
  Source: `Dataflow.xtend:208-221, 465-476` (`createAssignment(rdInstance, value)`, `indices += createIntValue(idx)`;
  neither branch for a scalar).
- An equation may write an input; the written value replaces the environment's for that tick and shows in the
  pool (probe: `I = 3; X = I` → pool `I = 3, X = 3`).
- A weak abort out of the enclosing state lets the equations run in the abort tick (probe).
- `dataflow once { ... }`: the equations run only in the entry tick, then the region terminates at once
  (`49-dataflow-once`: the join fires in tick 1). Source: `Dataflow.xtend:324-331, 500-502`.
- A state with a `dataflow once` region and a weak or strong **self-loop** (`if R go to S`, `if R abort to
  S`) is rejected: `Can't schedule from … to …`, `The SCG is NOT asc-schedulable!` (lab: also `Circular
  dependency prevents scheduling this tick.`), warning `Instantaneous loop detected!` (lab: `Potential
  instantaneous loop through X.`) (`38-err-dataflow-once-weak-self-loop`). A plain dataflow region with the same
  self-loop compiles (with the loop warning) and so does a `dataflow once` state left for another state and
  re-entered later (probes, official KIELER agrees).
- A plain dataflow region never terminates, so a `join to` on its state never fires. If the join's target is a
  simple state with an entry action, the compiler crashes: lab `The compiler failed during compilation setup.`,
  official KIELER never reports back (`39-err-dataflow-join-target-entry-crash`). This is the single-region
  crash of `concurrency.md` T-6; a plain target, an entry action on the dataflow state itself, or `dataflow
  once` compile (probes, both servers).
- Teaching: a dataflow region never terminates (except `once`), so a superstate with one never joins; do not
  put a `join to` on it.
- Implementation: a dataflow region is never final; a `once` region is final after its entry tick. Reject the
  two shapes above.

### S-33 Chart instances in dataflow

`ref C g1, g2` declares instances; in a dataflow region `g1.A = e` sets an input, `g1 = {e1, _, e3}` sets
inputs in declaration order (`_` skips one; only inputs count), and `g1.O` reads an output. Inputs that are
never set keep their default (0/false). Each instance becomes a concurrent region running a copy of `C`
(S-4); its inputs and outputs become hidden locals `__df_g1_A`.

- Evidence: `47-dataflow-ref-instances`.
- Source: `Dataflow.xtend:351-417`.
- `ref C g(X, Y)` with bindings **and** dataflow use → binding errors (probe:
  `There are binding errors in a referenced state!\nA Valued Object is supposed to be bound, but there is no free Valued Object left in the referenced scope: __df_g_B`).
  Any binding does it, explicit ones too: the translation puts one local per input and output after the written
  bindings, always one argument too many (`dataflow/probe-dataflow-instance-classic-binding`, `-explicit-binding`;
  found by the `dataflowObjects` fuzz profile).
- The translation **removes the instance's declaration** from the chart. Whatever else names the instance then
  points at nothing and the chart is rejected (`The valued object reference points to a valued object (g) that is
  not contained in the model!`): a second classic dataflow region, a region that calls a method (S-33a), in either
  order, a transition or an action (`-instance-two-classic`, `-instance-shared-oo-classic`, `-shared-classic-oo`,
  `-instance-classic-and-transition`). An instance belongs to one classic dataflow region.
- An array of instances (`ref C gs[2]`) is one instance to the classic translation: `gs[0].a` and `gs[1].a` both
  write the one local `__df_gs_a`, a conflict (`-instance-array-classic`, rejected). It works in a region that calls
  a method (S-33a).
- **Every index at every level counts for finding the instances, and a port's index is dropped.** The instances
  of a region are those named anywhere in an equation (`allAssignmentReferences`: the references with everything
  they contain), so `c.a[ix.n] = 7` makes `ix` an instance although it is named in an index only. The replacement
  then puts the local in place of `c` and removes the member after it (`reference.valuedObject = replacement;
  reference.subReference = null`), and the local is a new valued object with the port's name and **no array size**
  (`createValuedObject => [name = ...]`): an array port of an instance is ONE variable, `c.a[1]`, `c.a[0]` and
  `c.a[i / 0]` are all `__df_c_a`, and the index is never evaluated (no index error, no division by zero; an
  instance's output named only there is read nowhere, the instance runs all the same). A tuple sets the port as a
  single value (`c = {7}`). The referenced chart is bound to that single variable: if it indexes the port itself
  (`s = a[1]`, `b[1] = 4`) gcc rejects the subscript, and an array output with a vector as its initial value is
  `expected expression before '{' token`; a chart that only passes the array on, or never names it, is fine.
  Probes `dataflow/probe-dataflow-index-*`, `-array-port-*` (20). Source: `Dataflow.xtend:340-348, 400-411, 513-522`.
- What this section describes is KIELER's **classic** translation, used for a region in which no equation calls a
  method. Otherwise: S-33a.
- Teaching: instances are like logic gates on a schematic: wire their inputs, read their outputs.
- Implementation: one concurrent region per instance (in order of first use), running a copy of `C` whose
  formals are fresh hidden locals; `g.X` reads/writes those locals; tuples assign the inputs in order.

### S-33a A dataflow region that calls a method: instances stay objects (KIELER's "OO" translation)

As soon as anything inside a dataflow region calls a method (in an equation, an index at any level, also the index
of a target's member as in `c.a[ix()] = 7`, a call's argument, a condition, the initial value of a declaration of the
region), KIELER compiles **that region** differently (`processDataflowRegionOO`; decided per region):

- The region becomes one state whose **immediate during actions** are the equations in written order (entry
  actions for `dataflow once`, whose state is not final: a `join to` on the enclosing state never fires). Each
  action is a thread of its own, so the equations are still ordered by the data they read and write, not by their
  position; `;` sequences get schedules as in S-27.
- A **call written as an equation** (the grammar's `DataflowReferenceCall`) is a call effect: `add(x)`, `c.add(x)`
  (a method of a class instance or of a chart instance), `accs[n % 2].add(1)`, `super.add(x)`. An expression after it
  is not assigned anything: `c.add(x) = x > 2` makes `x > 2` the **trigger** of the action, the method runs only
  while it holds. A call names a method (or an extern function, which is then a validator error, S-31); a chart
  instance cannot be called (`add(x, y)` with `ref DAdd add` does not resolve).
- **Chart instances stay declarations**, which KIELER's Reference processor then turns into objects as for a chart
  used as a class (S-65), with one difference: the instance's inputs and outputs that are not bound explicitly
  become **public members** of the object, with their initial values. The data pool has `"inc": {"a": 1, "s": 2}`
  (the classic translation hides `__df_inc_a`). An input no equation sets keeps its value (0, or its initial value);
  the instance's own regions and actions run concurrently with the equations, in the scope that declares the
  instance (the chart, a state, or the state the dataflow region becomes when the region declares it).
- **Bindings.** Only explicit bindings are applied (`ref Two g(x to a)`: `a` is `x` and no member). A binding by
  position is ignored (`ref Two g(x)`: `a` stays a member with 0), and there is no implicit binding by name. More
  arguments than the chart has inputs and outputs crash the compiler (`NullPointerException` in
  `handleSCChartsDatatype`, which asks the binding without a target whether its target is an input).
- An instance counts as "used by the region" when an equation names it: in its target, its expression, a call's
  argument or condition, or as the object a call written as an equation is made on (that call is its own reference:
  `DataflowReferenceCallImpl.getReference` returns `this`). An instance with inputs that no equation names is an
  ordinary `ref` declaration and its bindings are missing.
- **No restart.** A terminated instance is not started again (the classic translation restarts it one tick later,
  S-34). KIELER means to restart an instance declared in the region itself (`_DF_restart_behavior`), but tests
  `dataflowRegion.declarations.contains(...)` after it has moved the declarations to the new state, so the test never
  holds; it warns instead (`An SCChart that can terminate (Fin) is used (g) in a dataflow region that assumes
  continuous IO behavior. ...`) wherever the instance is declared.
- **Vectors** assigned to an instance set its inputs in declaration order (own, then inherited; `_` skips one) as in
  the classic translation; S-32 for arrays.
- **Arrays of instances** work: `ref Two gs[2]` is an array of objects (`"gs": [{...}, {...}]`), each element with
  its own copy of the chart's regions; `gs[0].a = twice(x)`, `gs[1].a = gs[0].s`.
- **Signals** as inputs or outputs of such an instance are refused: `Signals in class declarations not yet
  supported` (KIELER's Signal processor on the class the instance became; a local signal of a chart used as a class
  is refused the same way, S-65).
- **Sharing.** Two regions that both call methods may share an instance (one object). A classic region may not
  share one with anything (S-33). A control-flow region may read and write the object's members (`g.s`, `g.b = 50`).
- An instance of a chart that itself wires instances: with a classic region inside, that region's hidden locals are
  members of the outer object (`g: {__df_t_a, ...}`); with an OO region inside, an object inside the object (`g:
  {a, s, t: {a, b, s}}`), with the name leak of S-18a.
- The simulation interface names the classes KIELER makes: `Two1.a`, the next declaration of the same chart
  `Two2.a`, a class of an inner state `Two11` (and `Two12` for the next copy of a for-region's state), a nested one
  `Mid1.Two1.a` with the instance `Mid1.t`; KIELER numbers them in the order it finishes them (an inner instance
  before the one around it). The inherited inputs and outputs of an instance of an extending chart are still listed
  as inputs and outputs there, and come first among the object's members.
- **A vector after a call's `=`** (`add() = {true}`): the tuple handling, which both translations run on every
  equation whose expression is a vector, takes the call's first name for its target, since the call is its own
  reference. A method is neither a referenced chart nor an array, so nothing is made of it, and the equation is
  removed with the vector: **the call never runs** (`o` stays 0), whatever the vector holds, while the equations
  around it (and a `;` sequence through it) go on as written. When the first name is a chart instance
  (`t.poke() = {3, 4}`), the vector sets the instance's inputs in order as for `t = {3, 4}` (`_` skips one) and
  the call is still dropped. When it is an extern function, KIELER asks the function's declaration for a chart's
  declarations and throws a NullPointerException. Probes `dataflow/probe-dataflow-call-vector-*` (9).
  Source: `Dataflow.xtend:181-228` (`eq.value.reference.valuedObject`, `removeList += eq.value`).
- A `dataflow for` region runs once per tick in this translation too and is rejected only when its counter is still
  named afterwards (S-24).
- In tick 1, a `dataflow once` region of this kind is a straight sequence of entry actions and so subject to B-34
  (KIELER runs the equations that read no input first).

- With the rest of the language: a suspended or aborted state stops and restarts the equations and the instance
  together (`-instance-suspended-state`, `-instance-aborted-state`, `-instance-beside-aborts`); an instance's chart
  may reference other charts, have for-regions, a clock (the chart is then timed, the clock a field of the object)
  or `pre` (`-instance-with-reference`, `-instance-with-for-region`, `-instance-with-clock`, `-instance-pre-of-port`);
  equations may read signals and write inputs as in a classic region (`-oo-reads-signals`, `-oo-writes-input`).
- Evidence: `tests/engine/kieler/dataflow/probe-dataflow-instance-*`, `-instances-*`, `-call-*`, `-class-*`,
  `-oo-*`, `-struct-members`, `-chart-instance-*` (outside dataflow: an array of chart instances, a local signal, a
  field at re-entry). 134 probes in all, 33 of them charts KIELER rejects.
- Source: `processors/dataflow/Dataflow.xtend:113-119` (the choice), `:121-262` (`processDataflowRegionOO`: `:135`
  moves the declarations, `:160-167` the restart test, `:231-243` the call effect and its trigger),
  `processors/Reference.xtend:938-988` (`dataflowBinding`: explicit bindings only, `:959` the crash), `:1179-1193`
  (ports become public members), `:1213-1220` (the restart region that is never made), `:1222-1296` (arrays of
  instances), `processors/Signal.xtend:133-139`, `impl/DataflowReferenceCallImpl.java:227-230` ("Beware! Hidden
  magic."), `text/scoping/SCTXScopeProvider.xtend` (a call without a sub-reference resolves among callable
  declarations only).
- Teaching: calling a method in a dataflow region is fine, but it makes the region's instances objects (visible in
  the pool, never restarted). `c.add(x) = cond` reads like an assignment and is a condition: avoid it in teaching
  material, or explain it.
- Implementation: passes/dataflow.ts `processRegionOO`; passes/reference.ts `expandDeclarations` with the dataflow
  binding mode of `interfaceBindings` and `instantiate` (explicit bindings only, ports kept as members),
  element-wise expansion for arrays (structure/instanceArray.ts), KIELER's class names (`classOf`) and the checks
  (`checkSignals`, `checkRemovedInstances`, the lost port of S-18a).


### S-34 A terminating instance restarts after one tick

The instance region is `ref-state −join→ delay-state −delayed→ ref-state`: when `C` terminates (tick n), it is
re-entered fresh in tick n+1, and its own delayed transitions resume from tick n+2.

- Evidence: `48-dataflow-ref-restarts` (`O = 0, 1, 2, 2, 1, 2`: period 3 for a chart that terminates after two
  ticks).
- Source: `Dataflow.xtend:358-375`.
- Only in a region without method calls. In a region that calls a method the instance is an object and is never
  restarted (S-33a; `dataflow/probe-dataflow-instance-terminates`, `-terminates-local`).
- Teaching: a dataflow instance of a chart that finishes starts over, with one idle tick in between.
- Implementation: wrap the instance as `initial state I is C(...)  join to W;  state W  go to I` (delayed).

---

## 6. Time

### S-35 Clocks, `deltaT` and `sleepT`

`clock t` declares a clock: a variable of the clock type, `float` by default (`int` with `@IntegerClockType`,
S-40), initial value 0 unless given (`clock t = 50`). A chart with a clock gets two generated variables in
its interface:

| Name | Direction | Type | Initial | Interface properties |
| --- | --- | --- | --- | --- |
| `deltaT` | input | clock type | 0 | `sccharts-generated`, `input`, `dynamic-ticks` |
| `sleepT` | output | clock type | 0 | `output`, `sccharts-generated`, `dynamic-ticks` |

Time passes **only** through `deltaT`, the time elapsed since the previous tick, which the environment
provides. In the oracle it is an ordinary input (`{"deltaT": 100}`; inputs persist, so set it in every tick
that should advance time). With `deltaT` never set nothing ever times out (probe: `t = 0` in every tick).
`sleepT` is the chart's request: how long the environment may wait before the next tick (S-38). A clock is an
ordinary variable otherwise: it can be read in effects (`elapsed = t`), assigned, compared. Clocks declared
in the root appear in the pool by name; clocks of nested states are hidden.

- Evidence: `60-clock-timeout`, `65-clock-integer-type`. Probes: no `deltaT` → never fires; `clock t = 50`.
- Source: `processors/TimedAutomata.xtend:179-238` (deltaT, sleepT), `:105` (default sleep 1000).
- Teaching: a tick is logical time; a clock measures physical time, which the environment reports through
  `deltaT`. In the simulator you play the environment: type how much time passed. Plain English: "`deltaT`
  is how long it has been since the last tick."
- Implementation: add `deltaT` (input) and `sleepT` (output) to the interface of a chart with clocks (unless
  the user declared them, S-39); the simulator UI should let the reader set `deltaT` (and could offer
  "advance by sleepT").

### S-36 When a clock advances

In every tick in which a state of the region that uses the clock is active **and was already active at the end
of the previous tick** (not in its entry tick), `t += deltaT` runs **before** that state's transitions are
tested. So a timeout `if t >= 300` fires in the tick in which `t` reaches 300, and a state entered in tick n
first advances its clock in tick n+1.

- Evidence: `60` (deltaT = 100 per tick: fires in tick 4 with `t = 300`), `61-clock-reset-blink`.
- Source: `TimedAutomata.xtend:410-423` (a during action `t += deltaT` in every sub-state of the region; during
  actions are delayed, i.e. skip the entry tick); generated C: `if (_pg...) x += deltaT;` at the top of
  `logic()`.
- Teaching: a clock does not move in the tick its state is entered, and a timeout fires in the tick the time
  is reached (with coarse `deltaT` steps, possibly later than the exact time).
- Implementation: per tick, before evaluating triggers, add `deltaT` to each clock whose owning region's active
  state was not entered in this tick.

### S-37 A clock belongs to its declaring state

A clock is reset only by assigning it (`t = 0`). A clock declared in the root keeps counting across the
states of the root region; without a reset, after the first timeout every later timeout test is already true
(`62-clock-not-reset`: `on` toggles in ticks 3, 4, 5). A clock declared in a superstate is initialised to 0
whenever that state is entered, like any local (`63-clock-local-restarts`). A clock declared in a region is
that region's own (probe: two regions, each `clock t`, time out independently).

- Teaching: reset the clock on the transition that starts a new waiting period (`do t = 0`), or declare it in
  the superstate whose entry should restart it. Forgetting the reset is the classic timed-chart bug (`62`).
- Implementation: clocks are ordinary variables of their scope (initialised on entry of the declaring state);
  only the increment (S-36) is special.

### S-38 How `sleepT` is computed

At the end of every tick:

    sleepT = maxSleep                                    (1000, or @DefaultSleep's value)
    for every state S active in this tick (both a state that was active at the start of the tick,
        with its clock after this tick's increment, even if S is left in this tick, and a state entered in
        this tick, with the clock after the transition's effects):
      for every bound b of S's outgoing timed transitions:
        if clock < b: sleepT = min(sleepT, b - clock)

Bounds: `t >= v` → `v`; `t > v` → `v + 1`; `t <= v` / `t < v` → no bound (source only). A disjunction of exactly two bounds
on the same clock in one transition (`x >= 999 || x >= 1000`, "greedy bounds") contributes only the larger;
otherwise every bound counts. Note the strict `<`: a state whose clock has just reached its bound contributes
nothing.

- Evidence: `60` (`300, 200, 100`, then `1000` in `Done`), `61` (tick 3: Off is left at `t = 500`, contributes
  nothing; On, entered with `t = 0`, asks for 200), `64-clock-greater-and-default-sleep` (`t > 100` → asks for
  `101 - t`; `@DefaultSleep 50` caps), `73-clock-greedy-bound` (tick 3: the S being left with `x = 999` asks
  for 1). Probes: two timed transitions → the minimum; a state entered by an untimed transition contributes
  with the shared clock (`50`); leaving at exactly the bound → 1000.
- Source: `TimedAutomata.xtend:272-275` (`sleepT = maxSleep` as an immediate during action of the root),
  `:439-580` (`handleSleep`; `createLEExpression` generates `<`, see the generated C `d->x < 1000.0`), `:520`
  (`>`), `:557` (greedy).
- Teaching: `sleepT` matters on real hardware with dynamic ticks; in the guide it is an output to watch, not
  something to compute by hand.
- Implementation: compute `sleepT` last in the tick, from the set of states that were active at any point of
  the tick, using for each the clock value at the moment its contribution would run in KIELER: for a state
  that was active at the start, after the increment and before its outgoing transition's effects; for a state
  entered in the tick, after the entering transition's effects.

### S-39 Restrictions on clocks

| Chart | Lab server message | Official KIELER message |
| --- | --- | --- |
| one clock tested in transitions of several concurrent regions | `Clock t is read by several concurrent regions of St67Shared.` | `Cannot handle concurrent timed automata using the same clock. Add @ClocksUseSD annotation for experimental support based on schduling directives.` |
| a clock tested by a state's transitions and inside that state | `Clock t is read both by Outer and inside it.` | `Cannot handle hierarchical timed automata. Add @ClocksUseSD annotation for experimental support based on SDs.` |
| a clock used across concurrent or nested regions in other ways | `Clock t is used across concurrent or nested regions of S.` | `Cannot handle concurrent or hierarchical timed automata using the same clock. ...` |
| a user `deltaT` that is not an input of the clock type | `A variable with name deltaT already exists and is not an input variable of type float` | same |
| a user `sleepT` that is not an output of the clock type | `A variable with name sleepT already exists and is not an output variable of type float` | same (source only) |
| a timing constraint that is not `clock op value` | `Malformed timing constraint.` / `... Operator <op> not supported in clock comparison.` | same (source only) |
| clock arrays | `Cannot yet handle array of clocks.` (source only) | same |

Evidence: `67-err-clock-shared`, `68-err-clock-hierarchical`, `71-err-deltaT-wrong-type`. Source:
`TimedAutomata.xtend:185, 216, 390, 396, 404, 454-546`; official texts from the fork's git history
(commit ffe52fa, which only rewords them).

- Teaching: one clock per region that tests it; nested waiting gets its own clock.
- Implementation: a clock may be tested by the transitions of exactly one region's states (looking through
  chains of single-state wrapper regions) and not also inside one of those states.
- "Tested" means a transition **with a trigger** that mentions the clock anywhere, its effects included: KIELER
  searches the whole transition. A region whose only use is `if a do t = 0` owns the clock (it advances only
  while that region is in a state); two such regions are rejected as several readers; a state with several
  regions and none of them so mentioning the clock is rejected as "used across concurrent or nested regions",
  an inherited region counting as one of them (`parity/probe-clock-region-by-reset`, `-two`, `-inherited`).

### S-40 Timing annotations (on the root chart)

| Annotation | Effect | Evidence |
| --- | --- | --- |
| `@IntegerClockType` (also `@IntegralClockType`, optionally with a host type string) | clocks, `deltaT`, `sleepT` are `int` | `65` |
| `@DefaultSleep v` | `maxSleep = v` instead of 1000 (a bare `@DefaultSleep` is an error in the lab server; KIELER crashes) | `64` |
| `@NoSleep` | no `sleepT` at all | probe (interface without sleepT) |
| `@SimulateSleep` | `deltaT = pre(sleepT)` in every tick after the first (the environment's `deltaT` is overwritten): the chart jumps from timeout to timeout | `66` |
| `@ClocksUseSD` | experimental scheduling-directive expansion for shared clocks | not tested |
| `@Passive` on a clock declaration | the clock is not advanced automatically | source only |
| `@DeviationOutput` | an output `lag` (`lag1`, ... if the chart has a `lag`, KIELER's uniqueName): how far `deltaT` overshot the sleep time asked for, `lag = deltaT > pre(sleepT) ? deltaT - pre(sleepT) : 0`, a delayed during action of the root (0 in tick 1) | `parity/probe-deviation-output`, `-name` |
| `@Logical` on a clock | the same `lag`, as a local unless `@DeviationOutput`; the clock advances by `pre(lag) + (deltaT - lag)` instead of `deltaT` (it ignores the overshoot of the tick it fires in and catches up a tick later) and asks to sleep for `b - (t + lag)`. With `@NoSleep` there is no `lag` and KIELER crashes (`Can't copy valued object. Valued object is null!`); the engine rejects it as `kieler-crash`. A `@Passive @Logical` clock is not advanced, so it is spared. `@Logical` and `@Passive` count only on the declaration (`@Logical clock t`), in any case (`@logical`); on the variable (`clock @Logical t`) KIELER ignores them, also in a referenced or inherited copy of the clock. Chart annotations (`@DeviationOutput`, `@NoSleep`, ...) count anywhere in the chart, in its referenced charts and in the charts it or its states extend: KIELER's Inheritance copies the base charts' annotations, declarations and actions first, and the base regions no `override region` hides: an annotation inside an overridden region is gone, unless `region is super.R` brings the region back; the bases' annotations come after the chart's own, so the chart's `@DefaultSleep` wins (`probe-annotation-own-before-base`, `probe-annotation-super-region`, `probe-deviation-inherited`, `-inner-extends`, `probe-annotation-overridden-region`, `-sleep`, `probe-annotation-inherited-region-sleep`) | `parity/probe-logical-clock`, `-int`, `-reset`, `-nosleep`, `-passive-nosleep`, `-lowercase`, `-on-variable`, `probe-passive-lowercase`, `-on-variable` |

Source: `TimedAutomata.xtend:62-77, 129-172, 241-262, 277-283`.

- Teaching: `@SimulateSleep` is the easiest way to watch a timed chart run without typing `deltaT`.
- Implementation: annotation names are compared case-insensitively; they are searched anywhere in the chart.

### S-40a `ode` actions

`ode x = e` in a state is one Euler step per tick: KIELER's ODE processor (after Timed Automata) replaces it by
an immediate during action `x += e * deltaT`, so it also runs in the tick the state is entered and stops when the
state is left. A chart with an `ode` gets the input `deltaT` (or uses its own) even without clocks; without
clocks it gets no `sleepT`. An int target is truncated as C does (`n += 3 * deltaT`).
The transformation keeps only the target's variable: `ode x[1] = 2` becomes `x += 2 * deltaT` on the whole array
(gcc: `assignment to expression with array type`, the engine's `array-assignment`), and `ode p.x = 2` on a struct
or class member becomes `p += ...` (gcc: `invalid operands to binary +`, the engine's `ode-member`). A member of
an `@UnpackClass` instance is a variable of its own by then and works.
`ode x++` / `ode x--` have no rate: KIELER's ODE processor crashes (`The 'no null' constraint is violated`), the
engine rejects them as `kieler-crash` (`parity/probe-ode-postfix`).

- Evidence: `parity/probe-ode`, `-multi`, `-clock`, `-array-element`, `-struct-member`, `-unpacked-member`.
- Source: `processors/Ode.xtend:45-63`, `TimedAutomata.xtend:175-206` (`hasODEs`).
- Implementation: `passes/ode.ts`; `timedAutomata.ts` declares `deltaT` for it.

### S-41 The "timed transitions" loop warning is advisory

Most timed charts compile with `Potential instantaneous loop through the timed transitions on t.` (the lab
server's wording of KIELER's loop-analyser warning `Potential instantaneous loop.`; for `period` it names the
generated clock, e.g. `_St69Every_local_c`). The chart is accepted and runs; the guide should tell readers
they can ignore it when every timeout is above 0.

- Evidence: `61`, `62`, `63`, `69`. Source: `scg/src/.../scg/diagnostics/Loops.java:56-64` (fork).
- Implementation: the engine need not reproduce this warning; if it does, attach it to timed charts whose
  clock reset and timeout lie on one control-flow cycle.

### S-42 `period`

`period v` (an action of a state or region, or of the root) makes the contents of that state run only in ticks
in which the period has elapsed. KIELER adds a clock `c` and a flag `tick` (initially `false`, `true` for
`immediate period v`) to the state, guards **every** action (entry, during, exit, ...) and transition of every
state inside with `tick &&`, and adds a region with two delayed self-loops:

    if c >= v do c -= v; tick = true    (soft reset, the default)
    if c >= v do c = 0;  tick = true    (with @HardReset on the period)
    otherwise:  tick = false

The clock advances as in S-36. The guarded contents run in the **same** tick in which the period elapses.
Because entry actions are guarded too, a plain `period` suppresses even the initial inner state's entry
action in the entry tick; `immediate period` lets the contents run in the entry tick.

- **The KIELER wiki says `@HardReset` is the default; the code makes soft reset the default**
  (`SOFT_RESET_DEFAULT = true`) and the oracle confirms it.
- Evidence: `69-period` (deltaT 100 → runs in tick 4; deltaT 250 after 100 → 350 keeps 50, so ticks 6 and 7
  both run), `70-period-hard-reset` (tick 7 does not run), `72-period-guards-entry-actions` (`e1 = 0, e2 = 1`
  in tick 1). Probe: `period` as a region action behaves the same.
- Pool: in the root the generated `c` and `tick` are visible; in nested states they are hidden
  (`_<Root>_local_c`, numbered on clashes).
- Source: `processors/Period.xtend:81` (default), `:127` (immediate), `:136-150` (guards), `:160-182`
  (region).
- Teaching: `period` is "do this every v time units"; with soft reset late ticks catch up, with `@HardReset`
  lateness accumulates. Plain English: "the inside of the state only runs once per period."
- Implementation: expand as described before clock handling (`period` is a pre-process of the timed-automata
  step). The `tick` flag is written by the period region and read by the guarded triggers in the same tick
  (initialise–update–read).

### S-42a `period` also guards the state's own outgoing transitions

The guard is added to every state *including the state that declares the period* (`getAllStates` includes
it). Consequences:

- A weak abort (`go to`) out of a state with a period is rejected by both compilers (scheduling cycle:
  `The SCG is NOT asc-schedulable!`; priority `The SCG is not IASC-schedulable!`): `74-err-period-state-weak-abort`.
- A strong abort out of it compiles, but its trigger reads the previous tick's `tick` flag: it fires one tick
  after a period elapsed while its trigger held, and in the tick the period elapses with the trigger true the
  contents do not run (probe: `if A abort to T` with A true from tick 7, period elapsing in ticks 4 and 7:
  `n` counts in tick 4 only, the abort fires in tick 8).
- Fix: put the period into an inner region (`initial state S { region { period 300 ... } } if A go to T`):
  accepted, and `go to T` fires as soon as A holds (probe).
- Teaching: never give a state with `period` its own outgoing transitions.
- Implementation: guard the state's own outgoing transitions with `tick` too; the rejection then follows from
  the cycle analysis.

---

## 7. Methods and code effects

### S-43 Methods

`method [type] name(params) { body }` declares a method in a state or region (in a `class`, methods are written
without the keyword, S-61). Without a type (or with `void`) it returns nothing; the return types are `bool`,
`int`, `float`, `string` and `void`. The body is SCL (S-44a–S-44f): assignments, calls, `if`/`else`,
`for`/`while` loops, labels and `goto`, local declarations, `return e`; it may read and write any variable in
scope. Methods are called in triggers and effects (`if isBig(x) ...`, `do y = sq(x); inc()`), in actions and in
dataflow equations. A call behaves as if the body ran at the call. Calls from concurrent regions to a method
that updates a shared variable (`count++`) are fine (probe: `count = 2, 4`).

- A method with parameters and an **empty body** does not compile: KIELER's C code refers to the parameter as a
  member of the tick data, and gcc fails with `‘TickData’ has no member named ‘k’` (then `Compiler did not return
  success`), for a chart's method and a class's alike; without parameters an empty method compiles (probes
  `tests/engine/kieler/structure/probe-empty-method-toplevel`, `-class`; engine code `empty-method`).
- Evidence: `75-methods` (return values, a `for` loop summing `0..x-1`, a void method, a method as a trigger).
  Compilation warnings `ValuedObject with name ... is contained in the model but not in VariableStore.` appear for
  method locals and parameters; they are harmless.
- Source: wiki "Object Orientation"; grammar `SCTX.xtext` `KeywordMethodDeclarationWOSemicolon`;
  `scg/.../processors/MethodProcessor.xtend`.
- Teaching: methods are for computations that would clutter transitions (a formula, a loop); they run
  instantaneously within the tick. Plain English: "a method is a little function you can call in a transition."
- Implementation: S-44f says which calls KIELER inlines; either way the call's reads and writes are the body's
  for scheduling (S-63).

### S-44 Code effects

`do { stmt; stmt; ... }` is an anonymous method body used as an effect: SCL statements in order, with the same
rules as a method body except that `return` is not allowed (S-44e). It also works in `entry`, `during` and
`exit` actions (`entry do { e++; d = 0 }`), and a block may stand in a list of effects, followed by `;` when
another effect comes after it (`do p++; { q = p * 2 }; x = x + q`, `152-scl-blocks-in-actions`). Two blocks in a
row (`do { a++ } { b = a }`) and a loop written as an effect without a block (`do for (...) { ... }`) are syntax
errors (`no viable alternative at input '{'`, `no viable alternative at input 'for'`; probes).

- Evidence: `76-code-effect`, `152`.
- Source: grammar `SCTX.xtext` `CodeEffect` (`'{' declarations* statements* '}'`, an `Effect`).
- Teaching: a code block reads like C; the statements run one after another in the same tick.
- Implementation: as a parameterless method (`_effect<n>` in KIELER) called at that point.

### S-44a The semicolon rule

Inside a method body or a code block, **an assignment that is followed by another statement must end with `;`**;
nothing else needs one. "Assignment" means `x = e`, `x op= e` and `x++`/`x--`. Calls (`inc()`, `c.inc()`,
`print(...)`), `if`/`else`, loops, blocks `{ ... }`, labels and declarations need no `;` before the next
statement, and the last statement of a block needs none. A `;` where it is not needed is allowed, except after
`return` (S-44e). Without the `;` KIELER reports `Missing Semicolon`, an error located at the assignment (also
for `a++` before an `if`).

| Body (⏎ = new line) | Result |
| --- | --- |
| `y = 1` ⏎ `z = 2` | `Missing Semicolon` (`140-err-scl-missing-semicolon`) |
| `a++` ⏎ `if (a > 1) { b = 1 }` | `Missing Semicolon` (`141-err-scl-missing-semicolon-before-if`) |
| `y = 1;` ⏎ `z = 2` | accepted |
| `if (v > 0) { y = 2 }` ⏎ `z = 3` | accepted |
| `int b = 1` ⏎ `y = b` | accepted |
| `inc()` ⏎ `y = 1`, `print("x")` ⏎ `a = 2` | accepted |
| `for (...) { z++ }` ⏎ `y = 1` | accepted |
| `a++;` as the last statement | accepted |

The transition-level effect list (`do a = 1; b = 2`) is not SCL: there `;` (or `,`) separates effects as before.

- Evidence: `139-scl-semicolons` (all accepted forms in one chart), `140`, `141`; the advanced editor's probes
  `semi-batch2` (10 bodies) and this round's (both servers agree on all).
- Source: `scl/src/.../validation/InternalSyntaxValidation.xtend:43-102` (`createSemicolonErrors`: every
  statement except the last of its list needs `semicolon` unless it is a "meta statement", i.e. a label, block,
  loop, thread or an `if` whose last token is `}`; a call statement escapes the check because none of its tokens
  belongs to the assignment object itself), applied by `SCTXResource.xtend:194`.
- Teaching: "put `;` after an assignment when more statements follow" is the whole rule; writing `;` after
  every assignment (but never after `return`) is the safe habit.
- Implementation: after parsing a block, flag every assignment statement that is not last and has no `;` with
  KIELER's text; calls, `if`, loops, blocks, labels and declarations are exempt.

### S-44b `if`/`else`, blocks and `goto`

- `if (c) { ... }` and `if (c) { ... } else { ... }`; the parentheses are optional (`if x > 5 { ... }` works,
  `143-scl-if-else`). There is no `else if`: `else if (B) { ... }` is a syntax error, `missing '{' at 'if'`
  (`144-err-scl-else-if`); nest the second `if` inside the `else` block. SCL's old `if c then ... end` is not
  available in SCCharts (`missing '{' at 'then'`, probe).
- A block `{ ... }` groups statements and may declare locals (S-44d).
- `label:` and `goto label` work; a forward jump skips statements (`153-scl-goto-forward`). Labels and gotos are
  no SCG nodes and no loop to KIELER (only `for`/`while` get the loop annotation), so a body with a backward jump
  is still "simple" (S-44f) and is **inlined**: the jump is then an instantaneous loop and rejected like a loop of
  immediate transitions, even when a condition ends it (corpus probe `effect-code-goto`: `Circular dependency
  involving O …`; probes `kieler/rare/probe-goto-back-*`: guarded, in a method, `@inline`, 29 nodes). In a body
  KIELER compiles as a C function (30 nodes or more, a loop, a call), the structured C code it generates from the
  graph has no jumps: a jump back leads to code already written out, so it is dropped and the rest of the body
  only runs when the jump is not taken (the method ends there, `probe-goto-back-30`, `-loop`, `-call`,
  `probe-goto-cfunction`). A label that ends a nested block (`if (c) { goto out; ... out: }`) is only mapped when
  the method's exit is made, so a jump to it leaves the whole body (`probe-goto-end-of-branch`). Statements after
  a `goto`, up to the next label, are removed. A `goto` to an unknown label: `Couldn't resolve reference to Label
  'nowhere'.` KIELER resolves a goto's label by name among the labels with the same innermost named container (a
  state, a named region, a class; methods and code blocks have no name) and takes the first in eAllContents order:
  two code blocks or methods of one state (its methods, actions and outgoing transitions; the chart's for the chart's
  methods) with a label of the same name make a later block's goto jump into the earlier block, and the compiler
  crashes on the flow without target (lab: `The compiler failed during compilation setup.`, ThreadAnalyzer NPE;
  official 0.3.0 never answers). Different states, concurrent regions or a state and its inner states do not meet
  (probes `kieler/rare/probe-label-*`).
- Teaching: use nested `if`/`else` for several cases; avoid `goto`.
- Implementation: as in C; `else if` and `then` are syntax errors.

### S-44c Loops

`for (int i = 0; i < n; i++) { ... }` and `while (c) { ... }`; the bound may be any expression, inputs included
(`145-scl-loops`). The counter must be declared in the loop head: `for (i = 0; ...)` with a variable of the chart
is accepted by KIELER's checks but breaks its C code (`‘i’ undeclared (first use in this function)`,
`146-err-scl-for-outer-counter`; the priority compiler accepts it, probe). A loop runs to completion within the
tick, as a C loop (the netlist compiler never inlines it into the tick's code, S-44f). A loop that never ends hangs the simulation (not probed; never record one).

- Evidence: `145`, `146`; corpus probe `effect-code-statements` (`for`, `while` and a block in one code effect).
- Teaching: a loop computes something within one tick (a sum, a search); it is not a way to wait. Waiting is
  what states and ticks are for.
- Implementation: execute loops as C would; reject `for` heads that assign an outer variable as KIELER's C does.

### S-44d Local declarations in blocks

A method body, code block, `if`/`else` body and loop body may start with declarations (`int t = x * 3`), with or
without `;`; they are fresh in every execution of the block and never appear in the data pool (`143`: `t`;
probe: a block local `int t = 4` incremented and added gives the same amount every tick). Declarations must come
**before** the block's statements: one after a statement is a syntax error (`missing '}' at 'int'`,
`149-err-scl-declaration-after-statement`; in a code effect `mismatched input 'int' expecting '}'`, corpus).

- Source: grammar `SCL.xtext` (`declarations+=Declaration* statements+=Statement*` in every block rule).
- Teaching: declare a block's helper variables at its top, like old C.
- Implementation: parse declarations only at the start of a block; scope them to it.

### S-44e `return`

- `return e` ends the method with the value `e`; early returns inside `if` and loops work (`147-scl-early-return`;
  `145`: a `return` inside a `for`).
- **No `;` after `return`:** `return 3;` is a syntax error, `extraneous input ';' expecting '}'`
  (`142-err-scl-return-semicolon`). (`return` has no semicolon in the grammar, so it can only be the last
  statement of its block.)
- `return` needs a value: a bare `return` is a syntax error (`no viable alternative at input '}'`, probe).
- `return` in a method without return type: `Return statement is used but no return type is declared in method
  signature.`; in a code effect: `Return statements can only be used in method bodies.`
  (`148-err-scl-return-in-code-effect`).
- A typed method without any `return`: `The method does not return any value!` (S-62, `119`). A method that
  returns on some paths only compiles, but when it ends without a return KIELER's C simulation breaks: in a
  probe the transition calling it stopped firing and the chart froze from that tick on (both servers). Every
  path of a typed method must end in a `return`.

- Teaching: write `return` last in its block, without `;`, and give every path one.
- Implementation: reject the syntax and validator cases; a typed method that reaches its end without returning
  can be reported as a runtime error.

### S-44f Inlining, parameters and the causality analysis

KIELER's netlist compiler **inlines** a method into the tick's code when its body is short (fewer than 30 SCG
nodes), has no loop and calls no other method, or when it carries `@inline`; every other method, and every code
effect with a loop, stays a C **function** called at that point. The priority compiler inlines all. Either way
the dependency analysis looks into the body: the call reads and writes what the body reads and writes, minus the
body's parameters and locals, so concurrent readers wait for a method's writes as for any other write
(`154-scl-function-dependencies`: the reader region, written first, sees the values a looping method and a
looping code block wrote in the same tick).

The two kinds differ in one way that shows: **a parameter of an inlined method is the argument itself**.
Assigning it writes the caller's variable (`150-scl-parameter-inlined-vs-function`: `k = k * 2` in an inlined
method called as `inlined(a)` turns the input `a` from 4 into 9), and calling such a method with a literal or an
expression as the argument crashes the compiler (`151-err-scl-assign-literal-parameter`: lab `The compiler
failed during compilation setup.`, official KIELER never answers). In a C function the parameter is a copy (`b`
stays 4). `@inline` on a method with a loop inlines the loop and is rejected as an instantaneous loop
(`155-err-scl-inline-loop`: `Can't schedule …`, `The SCG is NOT asc-schedulable!`). An `@inline` method that calls a
C function loses it: KIELER notes the functions the tick and the kept functions call, not the ones a body it copies
into place calls, drops the function as unused and gcc fails on the call (`implicit declaration of function
'inner'`), unless something else calls it too (`kieler/structure/probe-inline-calls-cfn*`). The priority compiler, which
inlines every method and runs loops at run time, differs in both: there `b` becomes 9 too, and `155` is
accepted (probe, `--system priority`).

- Evidence: `150`, `151`, `154`, `155`; probes with the reader before and after the writer (both `seen = 5`);
  official KIELER 0.3.0 agrees on all (it never answers on `151`).
- Source: `MethodProcessor.xtend:152-191` (`inlineCalls`, `isSimpleMethod`: `scg.nodes.size < 30`, no loop
  annotation, no `ReferenceCall`), `:204-345` (inlining substitutes the arguments for the parameters);
  `scg/.../processors/DependencyTransformationV2.xtend:188-230` (the accesses of a called method's SCG, without
  its local variables, are added to the call node).
- The call node keeps its own operator for those accesses: a C function call is a plain assignment (`=`), so an
  update inside a non-inlined body does **not** commute with a concurrent update of the same variable. `do { for
  (int j = 0; j < 2; j++) { y += 1 } }` next to a region doing `y += 1` is rejected (`The SCG is NOT
  asc-schedulable!`), while the same loop updating another variable is accepted (probes
  `tests/engine/kieler/structure/probe-method-inner-update-conflict`, `-other-variable`; engine code
  `update-conflict`).
- **A method called in the index of an assigned member is found only as the whole index and by its name alone.**
  When KIELER builds the SCG it converts an assignment's own indices and its expression properly, but copies the
  indices of the target's **members** as they are and only redirects an index that is itself a plain reference to
  the SCG's variables (`SCGTransformation.xtend:590-597`: `ref.indices += sccSub.indices.map[copy]`, then
  `ref.indices.filter(ValuedObjectReference)...`). Anything deeper still names the chart's objects, so the method
  inliner does not know a call there: it neither copies the method into place nor keeps it, the method is removed
  as unused, and gcc finds no such function (`implicit declaration of function 'ix'`; the statement is also
  emitted twice). So `c.a[ix()] = 7` works (also for a method that stays a function, and at two levels,
  `k.l.a[ix()]`), while `c.a[ix() + 0] = 7`, `c.a[arr[ix()]] = 7` and `c.a[g.one()] = 7` (a method reached
  through an instance) are rejected, in a transition's effect as in a dataflow region, and inside a chart used
  as an instance even the plain `k.a[one()] = 7` (the method is the instance's class's there). On the right-hand
  side, in the index of a plain array and in the index of the instance itself (`ks[ix() + 0].a = 7`) every form
  works. Probes `structure/probe-method-member-index-*`, `-method-index-*` (17: 9 rejected); engine
  `method-in-member-index`. Found while fixing the dataflow pass's own walk over member indices.
- **The dependency analysis does not see what such an index reads either.** For the same reason only a plain
  variable written as the whole index of an assigned member is a read to KIELER (`k.a[x] += 1` waits for a
  concurrent `x = 1`, and `k.a[x] = 1` next to `x = k.a[0]` is a cycle; an array as the whole index is seen too,
  `k.a[arr[1]]` waits for `arr[1] = 0`). A variable inside an operator or inside another index (`k.a[x + 0]`,
  `k.a[arr[x]]`), and a member even as the whole index (`k.a[k.w]`, `cell.v[cell.w % 2]` for an instance's own
  output), is **not** a read: the write is not ordered before it, the regions run in written order (the reading
  region first: the old value is used; the writing region first: the new one), and a cycle through it is none
  (`k.a[x + 0] = 1` next to `x = k.a[0]` is accepted). The indices of the instance itself (`ks[x + 0].w`), of a
  plain array and everything on the right-hand side are seen. Probes `structure/probe-member-index-dependency-*`
  (12), `dataflow/probe-dataflow-index-own-member-oo*`; the engine leaves those reads out of a target's accesses
  (deps.ts `nodeAccesses`). Teaching: compute an index into a variable first when another region writes what it
  reads.
- **A class's method that stays a function reads the class's members through its own `self` parameter**
  (`MethodProcessor` adds it; `SCGMethodExtensions` `ANNOTATION_METHOD_REQUIRES_SELF`). To the dependency analysis
  `self.v` of one method is a variable of its own: it is the same for every instance the method is called on,
  different from every other method's, and never the `c.v` written outside. So, in two concurrent regions:
  `c.big()` (a loop of `v += 1`) next to `c.v += 1` is accepted, with no order between them (the regions' order
  decides); `c.set7()` next to `c.set8()`, or next to `c.v = 8`, is accepted the same way; a reader of `c.v`
  does not wait for the method's write, so `o = c.get()` with `c.v = o + 1` is no cycle; but `c.set7()` next to
  `d.set7()` is **rejected** (both write the `self.v` of `set7`, and the two calls are different expressions), as
  is `cells[0].set7()` next to `cells[1].set7()`. The same call twice is confluent. A method KIELER inlines into
  a kept one reads through the kept one's `self`; a kept one called by a kept one keeps its own. A variable of the
  chart accessed in such a method is the chart's as before. Probes
  `tests/engine/kieler/structure/probe-method-self-*`; engine: `deps.ts` `innerAccesses` (`Access.bucket`).
- **The methods of a chart instance** (`ref C g`, S-65) follow the same `self` rule when KIELER keeps them as
  functions: `c.big()` (a loop) next to `c.v += 1` is accepted without an order; the kept `set7` of two instances
  declared together (`ref KL c, d`: one class) called in two regions is rejected, of two declarations (two classes)
  accepted; and a method that calls a method of an instance declared inside its chart (`g.get()` returning
  `t.get()`) is kept (it calls), so its read of the inner field is not ordered after a concurrent write of it
  (KIELER: `o = g.get() + x` runs before the inner `t.add(2)`). Probes `dataflow/probe-dataflow-instance-kept-method`,
  `-instances-one-declaration-kept-method`, `-instances-two-declarations-kept-method`,
  `-instance-nested-method-read`, `-instance-nested-method-read-dataflow`.
- **A call in the argument of a call** (`acc.add(twice(n))`, both short methods): KIELER collects the calls of the
  chart in a table with a row per method, in the order it first meets the methods (the nodes in order, the calls of
  one node innermost first), and copies the methods into place row by row. Normally `twice` gets its row before
  `add`, is copied first, and the chart runs. When an **earlier** node has called `add` already (`acc.add(1)` and
  then `acc.add(twice(n))`), `add`'s row comes first: `add` is copied into place with a copy of its argument, and the
  `twice` call KIELER turns to next is no longer part of the graph. The compiler crashes (lab `The compiler failed
  during compilation setup.`). The same two calls the other way round are accepted. Probes
  `dataflow/probe-dataflow-call-argument-call`, `-call-argument-call-crash`, `-call-argument-call-control-flow`,
  `-call-argument-call-crash-control-flow` (in equations and in a transition's effects alike; found by the
  `dataflowObjects` fuzz profile). Source: `MethodProcessor.xtend:152-176` (`HashBasedTable`, "TODO check is
  iteration order is really deterministic").
- **Two chart instances declared together are one class** (`ref K c, d`, S-65): `c.get() + d.get()` in one effect
  or trigger are two calls of one method there, which KIELER's C code does not compile (the rule above:
  `implicit declaration of function ‘get’`). With two declarations (`ref K c` and `ref K d`: classes `K1` and `K2`)
  it compiles. Probes `dataflow/probe-dataflow-instances-one-declaration-two-calls`, `-two-calls-control-flow`,
  `-instances-two-declarations`.
- Teaching: treat parameters as read-only; compute into a local (`int r = k * 2`) instead.
- Implementation: inline or not as KIELER does (the choice decides what a parameter assignment means); give every
  call the body's accesses for scheduling.

### S-69 `state(S)` in a method body

`state(S)` (or `state(R.S)` for a state of the named region `R`) is a bool that is true while `S` is active. KIELER
accepts it only inside the body of a method declaration (`State access expressions are only permissible in methods
bodies.` anywhere else, a code block `do { ... }` included). Without a region it names a state of the anonymous
regions of the state that declares the method; several anonymous regions with a state of that name are an error
(`This state access is ambiguous as there are multiple anonymous regions with states with this ID. Use region IDs
access the state via RegionID.StateID.`).

KIELER's MethodSignaling (run at the start of Reference, before every other transformation) turns each accessed
state into a flag `_<region or default>_<S>_active`, a bool declared in the state around `S`'s region with the
initial value false, and gives `S` an entry action `flag = true` and an exit action `flag = false`; the access reads
the flag. So the method sees `S` active from the moment it is entered in a tick (an initial state from tick 1, a
concurrent reader after the transition into `S`), and inactive from the moment it is left (also by an abort of a
superstate around it, whose exit actions run).

- Evidence: probes `tests/engine/kieler/rare/probe-state-access-*` (a named region read concurrently, the top level,
  an initial state, a method of a superstate, a strong abort of the state around the target): every tick agrees.
  Official KIELER 0.3.0 gives the same values on all five. Fuzz campaign 7 (profile `rare`): 58 charts that call such
  a method agree with KIELER tick by tick.
- Source: `processors/MethodSignaling.xtend:118-232` (`transformActiveState`); `text/validation/SCTXValidator.xtend:
  375-397`; `text/scoping/SCTXScopeProvider.xtend:262-285`.
- Implementation: lowering (`lower.ts` `stateFlag`, `attachStateFlags`); the passes then handle the actions as any.

### S-70 Constants of another chart: `scchart(C).X`

`scchart(C).X` reads the constant `X` of the chart `C` (only public `const` variables with a value, enums, classes
and structs are visible through it: a plain variable is `Couldn't resolve reference to ValuedObject 'X'.`). KIELER's
StaticAccess copies `X`'s declaration into the simulated chart as `_C_X`, and Const inlines it, so `scchart(C).X` is
the value. Only the one declaration is copied:

- an initial value that names another constant of `C` (`const int TWICE = BASE * 2`) points out of the model:
  `The valued object reference points to a valued object (BASE) that is not contained in the model!` and
  `References objects are not contained in the resource!` (rejected);
- a subscript is dropped with the access, so `scchart(C).T[1]` of a const array is the whole vector, which gcc
  rejects in an assignment (`expected expression before ‘{’ token`).

It works in triggers, effects, initial values and array sizes (`int k[scchart(C).MAX]`).

- Evidence: probes `tests/engine/kieler/rare/probe-static-access-*` (`const`, an expression of literals, a float and a
  bool, initial value and array size; the chained, array and variable cases rejected). Official KIELER 0.3.0 agrees,
  except that it does not report the plain variable as unresolved and never answers on it (a ClassCastException in its
  compilation thread). Fuzz campaign 7: 74 charts with `scchart(C).K` agree tick by tick.
- Source: `processors/StaticAccess.xtend:58-113`.
- Implementation: lowering (`lower.ts` `staticConst`), code `static-access` for the rejections.

### S-71 Names that reach the C code: primes and `^`

KIELER's grammar takes a valued object's name as a `PrimeID` (an identifier with primes after it, `x'`, `x''`) and
keeps an escaping `^` in it (`int ^max`), while a state's or region's name is an `ID` whose `^` is dropped (`state
^state` is the state `state`; a prime there is a syntax error, `no viable alternative at input '''`). The netlist C
code uses a valued object's name as it is, so gcc fails wherever such a name reaches it:

| What | `x'` | `^x` |
| --- | --- | --- |
| a variable or signal at the top level (input, output, local) | rejected, `missing terminating ' character` | rejected, `expected identifier or ‘(’ before ‘^’ token` |
| a local of a state (KIELER prefixes it) | rejected, as above | rejected, `expected ‘:’, ‘,’, ‘;’, ‘}’ or ‘__attribute__’ before ‘^’ token` |
| a class or struct member, a valued signal | rejected | rejected, `expected identifier or ‘(’ before ‘^’ token` |
| a parameter or local of a method that is called | rejected | rejected (inlined: the prefixed form; a C function's local: `expected identifier ...`) |
| the name of a called method that is not inlined | rejected | compiles |
| a method that is never called, an inlined method's name | compiles | compiles |
| a constant (inlined by Const), a state, a region | compiles | compiles |

- Evidence: probes `tests/engine/kieler/rare/probe-prime-*`, `probe-caret-*` (24 charts), corpus probes
  `lex-primes`, `lex-caret-ids`. Official KIELER 0.3.0 agrees on all but one: it also rejects a called C-function
  method named `^max` (`probe-caret-method-loop`; gcc, `Compiler did not return success`), which KIELER 1.6.1
  (official 0.4.3) and the lab compile; the engine no longer warns about it.
- Teaching: a `^` lets a keyword name a state or a region; give variables and signals names that are not keywords.
- Implementation: `codegen.ts` `cNames` (code `c-name`, gcc's first error in `kieler`).

### S-72 C text that KIELER writes as it is: strings, `%` on floats, `d`

Three more things reach gcc unchanged and make it fail, so KIELER rejects the chart with `Compiler did not return
success (exit value != 0)`:

- **String literals.** The parser resolves a string's escapes (`\n` is a line break, `\"` a quote), and the C code
  generator writes the value between quotes as it is. A line break in the value (`"a\nb"`, `\r`, or a string written
  over two lines) leaves the C literal open: `missing terminating " character`. So does a backslash at the end
  (`"a\\"`), which escapes the closing quote. A quote in the value ends the C literal early: `"a\"b"` gives
  `expected ‘;’ before ‘b’` and `missing terminating " character`, and even a balanced `"\"x\""` gives
  `expected ‘;’ before ‘x’`. It does not matter where the literal is: an assignment, a `print` argument, an initial
  value. A tab (`"a\tb"`) compiles, and the value has the tab.
- **`%` on a float**, in an expression or as `%=`, in a transition, an action or a called method's body: `invalid
  operands to binary % (have ‘double’ and ‘double’)` (‘double’ and ‘int’ for `F % 2`). KIELER's validator warns first,
  for the expression form: `You are using modulo with floats. …`.
- **A variable called `d` in a method that stays a C function** (not inlined, S-44f; code effects with a loop are
  such methods): the function's first parameter is the tick data, `TickData* d`. A parameter `d` gives `conflicting
  types for ‘d’; have ‘int’` (‘double’ for a float), a local declared at the top of the body `‘d’ redeclared as
  different kind of symbol`. An inlined method's `d` gets a prefix and compiles (`r = 6`), and so does a `for (int d
  = 0; …)` counter, which C scopes to the loop.
- **An `extern` function named without parentheses** (`distance = absolute` after `extern "abs" absolute`): the
  validator only warns (`You are using an external reference without call syntax. …`), and the C code then uses the
  SCTX name, which C does not know: `‘absolute’ undeclared (first use in this function)`. These checks run on charts
  with host code too, whose simulation the guide does not run.

- Evidence: probes `tests/engine/kieler/rare/probe-string-*` (7), `probe-float-modulo-*` (4), `probe-d-*` (5),
  `probe-extern-*` (2) and `probe-c-keyword-*` (3, gcc's first error for `char`/`double`, `union` and
  `volatile`/`long`/`short`/`signed`/`unsigned` differs from the other C keywords'). Official KIELER 0.3.0 gives the
  same verdict on all 21.
- Implementation: `codegen.ts` `cText` (codes `c-string`, `c-float-modulo`, `extern-not-called`, and `c-name` for
  `d`; gcc's message in `kieler` where it is certain, else only `Compiler did not return success …`).

---

## 8. Object-oriented data: enums, structs, classes

KIELER's "object orientation" (wiki "Syntax: Object Orientation") is entirely static. An **enum** is a set of
named constants that the compiler turns into ints; a **struct** is a record of variables; a **class** is a
record of variables with methods; and a chart without inputs and outputs can be used as a class through a `ref`
declaration, with inheritance between charts (`extends`, `override`, `super`). There is no `new`, no pointer, no
dynamic object: every instance is declared by name (or as a fixed array), exists while its declaring scope is
active, and is compiled into plain variables. Evidence is in `tests/conformance/structure/` (charts `100`–`138`,
`156`, `157`) and the probes quoted; everything was also run through official KIELER 0.3.0, whose differences are collected
in S-68.

### S-57 Enums: declaration and values

`enum Color { RED, GREEN, BLUE }` declares a **type**, not a variable. A variable of the type is declared with
`ref`: `ref Color c = Color.BLUE` (several names per declaration: `ref Color a = Color.GREEN, b`). A value is
always written with its enum's name, `Color.RED`; a bare `RED` is a link error (`Couldn't resolve reference to
ValuedObject 'RED'.`), so an enum value never clashes with a variable of the same name (probe: `output int RED`
next to `Color.RED` works).

KIELER's Enum transformation replaces every value by its **position** (`RED` = 0, `GREEN` = 1, `BLUE` = 2) and
every enum variable by an `int`; the values cannot be given other numbers (the grammar has no `= value` for
them). Consequences:

- The data pool and the interface show the number: `c = 2`, interface type `int` with the extra property
  `enum` (`input` too for an input enum, S-58). An enum variable without initial value starts at 0, the first
  value.
- Comparisons work on the positions: `c < Color.GREEN` holds for `RED`; comparing with an int also compiles and
  holds when the position matches (`c == 1` for `GREEN`).
- An enum needs at least one value: `enum Nothing { }` is a syntax error, `missing RULE_ID at '}'`.

- Evidence: `100-enum-values` (initial `BLUE` = 2, then `RED` = 0, `GREEN` = 1; a variable without initial
  value is 0; `c == 1`). Probes: bare value, empty enum, name clash (both servers).
- Source: `processors/Enum.xtend` (`transformEnumAccess`: `createIntValue(enumVODecl.valuedObjects.indexOf(enumVO))`,
  `transformEnumVars`: `createIntDeclaration`, `VariableStore.ENUM` property); grammar `KExt.xtext`
  `EnumDeclaration`, `EnumMemberDeclaration`.
- Teaching: an enum gives readable names to the modes of a chart (`Mode.IDLE`, `Mode.RUNNING`) instead of magic
  numbers; the simulator still shows the numbers, in declaration order from 0. Plain English: "an enum is a list
  of names; KIELER numbers them 0, 1, 2, ... behind the scenes."
- Implementation: resolve `E.V` to the int position of `V`; treat `ref E x` as an int variable whose interface
  entry has type `int` and the `enum` property.

### S-58 Where enums live and what an enum variable accepts

- **Where an enum can be declared.** A `ref E` declaration looks for `E` among the root charts, the
  declarations at the top of its own root chart and those it inherits (`extends`). So an enum declared at the
  top of the chart can be used in every state of it (probe: `ref Phase p` inside a nested state works), but an
  enum declared inside a nested state or inside a class cannot be used as a type at all: `Couldn't resolve
  reference to EObject 'Phase'.` (`105-err-enum-in-nested-state`; probe for a class, `'Mode'`).
- **Another chart's enum.** `ref Decl.Bit b = scchart(Decl).Bit.ZERO`, and `scchart(Decl).Bit.ONE` for each
  value (`103-enum-from-other-chart`, the wiki's example). A chart that only holds declarations is fine for this.
- **Inputs and outputs.** `input ref Dir d` and `output ref Dir last` are an input and an output of int type with
  the `enum` property; the environment (the oracle, the simulator) sets an input enum with the number
  (`102-enum-io`: `d = 2` is `Dir.STOP`). Official KIELER 0.3.0 rejects `output ref` (`no viable alternative at
  input 'ref'`) and accepts `input ref` but drops the `input` (the variable is not an input and stays 0), S-68.
- **Assignments are type-checked; nothing else is.** The right-hand side of an assignment to an enum variable
  must be a value of that enum or (current KIELER only) another variable of it (`101-enum-copy`: `b = a`).
  Anything else, an int literal or arithmetic, is rejected: `Cannot assign enum value of an incompatible type.`
  (`104-err-enum-int-assignment` for `c = 2`; probe: `l = l + 1`). An initial value that is not a value of the
  enum is rejected with `An enum typed variable can only be initialized with a value of the correct enum type.`
  (probes: `Color.PURPLE`, bare `GREEN`, each with the link error). Comparisons are not checked (`c == 1`
  compiles, `100`).

- Source: `sccharts/src/.../text/scoping/SCTXScopeProvider.xtend:181-212` (`getScopeForReferenceDeclaration`:
  root states, `rootState.declarations`, inherited declarations, or the declarations of an explicit
  `referenceContainer`); `scl/src/.../validation/SCLValidator.xtend:60-104` (`checkEnumTypeCompatibility`, for
  declarations and assignments only: the right-hand side must be a reference to a value of the same enum or to a
  variable of the same enum).
- Teaching: declare enums at the top of the chart. To step through the values, assign each one explicitly (a
  transition per value), not `mode = mode + 1`.
- Implementation: scope `ref E` as KIELER does (a nested or class-level enum is an error with KIELER's text); type
  check assignments and initial values only.

### S-59 Structs

`struct Point { int x  int y = 5  bool seen } p, q` declares the type `Point` and two **instances** `p` and `q`.
Members are written `p.x`; each instance has its own members. A struct may contain variables of any type (with
initial values, as arrays `int v[3]`, as `const`) and other structs (`struct Line { struct Point { int x  int y }
a, b  int width = 1 } l`, then `l.a.x`). Members are initialised like the declaring scope's locals: in
declaration order when the scope is entered (for the root: tick 1), again on every re-entry of a nested state.

What a struct cannot do:

| Chart | Message |
| --- | --- |
| a `private` (or `protected`) member | `All members of a struct must be publicly accessible.` |
| a method in a struct | parse error `no viable alternative at input '()'`, plus the warning `A class/struct should have at least one variable defined (Type definitions are not supported).` |
| a class inside a struct | `A struct may only contain primitive members or other structs.` |
| a signal member | `Signals in class declarations not yet supported` (official: `Cannot serialize simulation interface. Unsupported type: pure`) |
| no name (`struct { int x } p`) | `A class/struct must have a unique name.` + `Cannot serialize simulation interface. Unsupported type: struct` |
| assigning or reading a whole instance (`q = p`) | `Assignments to class/struct types are not supported. Please specify a member.` and, for each side, `Referencing class/struct types is not supported. Please specify a member.` |
| `ref Point r` (a second instance through `ref`) | gcc: `‘TickData’ has no member named ‘r’` (probe) |
| an initial value for an instance (`} p = …`) | `Composed types (class/struct) cannot be initialized. Please initialize each field individually.` (source; host code excepted) |

A struct without instances (`struct Point { int x }`) compiles with the warning `A class/struct should have at
least one variable defined (Type definitions are not supported).` and gcc's `declaration does not declare
anything`; it declares nothing usable. Arrays of instances work in KIELER (`struct Point { int
x } ps[2]`, then `ps[0].x`; probe, both servers).

For the causality analysis every member is its own variable: two regions may write different members of one
instance in the same tick, and a third reads both after them (`108-struct-concurrent-members`: `sum = 3`); two
regions writing the same member with different values are the usual write-write conflict, named after the
member alone (`109-err-struct-member-conflict`: `Circular dependency involving x prevents scheduling this
tick.`, `The SCG is NOT asc-schedulable!`).

- Evidence: `106-struct-members` (initial values, an array member indexed by another member), `107-struct-nested`,
  `108`, `109`, `110-err-struct-whole-assignment`, `111-err-struct-private-member`, `112-struct-in-nested-state`
  (re-initialised on re-entry, hidden from the pool), `156-err-struct-signal-member`, `157-struct-const-member`.
  Probes for the other rows (official KIELER agrees except where noted).
- Source: `kexpressions/src/.../kext/validation/KExtValidator.xtend:164-181` (`checkStruct`);
  `scl/src/.../validation/SCLValidator.xtend:44-49, 107-136` (names, instances, initial values, whole-instance
  references); grammar `KExt.xtext` `ClassDeclaration` (a struct body holds `Declaration`s only);
  `processors/Signal.xtend:136`.
- Teaching: a struct groups variables that belong together (a position, a reading with its timestamp); the
  chart still works member by member. Plain English: "a struct is a named bundle of variables; `p.x` is the `x`
  inside `p`."
- Implementation: an instance is a set of variables `p.x`, `p.y` of the declaring scope (each a separate
  variable for scheduling), initialised in member order with the scope's other locals; reject the table's cases
  with KIELER's texts.

### S-60 Instances in the data pool and the interface

- An instance declared at the **top of the simulated chart** is one entry of KIELER's data pool: an object of
  its members, `"p": {"x": 1, "y": 5, "seen": false}`; a nested struct or inner class is a nested object
  (`"l": {"a": {"x": 3, "y": 0}, ...}`), an array member an array, an array of instances an array of objects
  (`"ps": [{"x": 1}, {"x": 2}]`). Private fields of a class are included. `const` members are left out
  (`157-struct-const-member`; official 0.3.0 includes them, S-68), and so is every variable of a **host type**
  (`host "int" h`), at the top of the chart and as a member, in the pool and in the interface
  (`probe-pool-host-variable`, `probe-class-pool-host-member`, `probe-struct-pool-host-member`,
  `probe-instance-pool-host-field`).
- The **interface** lists the instance with type `struct` or `class` and one entry per member type,
  `<Type>.<member>` (`Point.x`, type `int`, no properties; nested: `Line.Point.x`, `Line.a` of type `struct`).
- An instance declared in a **nested state** is hidden from the pool, like the state's other locals
  (`112-struct-in-nested-state`; the interface still lists `Point1.x`).
- An enum variable is an int (S-57).
- Chart instances (S-65): `"c": {"counter": 2, "step": 1}` with the chart's fields, including private ones; a
  private or protected field inherited from a base chart appears as `<Base>_<field>` (`St134Base_secret`, S-66);
  the interface names the type entries after the copied chart (`QR01Counter1.counter`; official
  0.3.0: `QR01Counter.counter`).
- **Which objects are in the pool** is decided by what is left of the class. A chart instance (S-65) becomes a class
  in KIELER's Reference processor, with the chart's declarations as its own, and a class **without any declaration**
  is removed there, wherever it is: an instance of a chart that declares nothing (or only inputs and outputs that
  are all bound) is not in the pool, alone, in an array or inside another instance
  (`probe-instance-pool-array-none`, `-nested-none`, `-nested-only-nothing`, `-bound-output-only`). Much later
  the Methods processor removes the methods it copied into place and the ones nobody calls, and then the classes left
  without a declaration, but only at the **top of the chart**. So:
  - at the top, an object is there while its class has something left: a field, a method that is still a C function
    and is called, or an object inside (constants and schedules are gone by then). `{}` for an instance with only a
    called C function, nothing for one whose methods are copied into place or never called, for a class with only
    a constant, for an empty class (`131`, `probe-instance-pool-*`, `probe-reference-empty-instance-*`,
    `probe-instance-pool-constant-only`, `probe-class-pool-nothing`, `-constant-only`; `-method-arguments`: with
    bound arguments too);
  - inside another object, every object whose class was not removed at the start is there, `{}` when it has no
    fields: `"m": {"c": {}, "w": 5}` for an inner instance with only a method (called or not, copied into place or
    not) or only a constant, and for an empty class inside a class (`probe-instance-pool-nested-*`,
    `probe-class-pool-nested-*`);
  - an array of objects follows the same rule and is an array of them: `"c": [{}, {}]`, `"m": {"c": [{}, {}]}`,
    `[{}]` for an array of one (`probe-instance-pool-array-*`, `-array-of-one-*`, `-nested-array-*`,
    `-array-nested-*`);
  - an array **without elements** is `[]`, and its class is still in the interface (`"c": []`, `Cell1.v`:
    `probe-instance-array-zero*`, `probe-class-array-zero`). KIELER's loop over the elements, from 0 to their number
    minus one, counts down in Xtend, so it makes **two** copies of the chart's regions and actions for such an
    array, both for element 0 (`-zero-two-copies`: a bound output grows by 2 a tick). Where they name a field,
    they read and write behind the empty array, in the probes the counter of the taken transition
    (`-zero-entry`, `-zero-region`; the engine reports `unsupported`).
  The interface lists an instance inside a chart instance as a member of the outer class, with or without fields
  (`Mid1.c` of type `class`).

- Evidence: `106`, `107`, `112`, `113-class-fields-methods`, `126-chart-class`, `134-protected-field`.
- Teaching: the simulator's variable table shows an instance as a small table of its members.
- Implementation: report root-level instances as objects of their (non-const) members under the instance name.

### S-60a How class objects are initialised, and when they are not

KIELER's Initialization processor gives a class with a variable or an object inside a method `_init`: one
assignment per variable that has an initial value (after the implicit initialisation every variable has one, except
those whose name starts with `_`), in declaration order, and one call of the `_init` of every class object inside.
The declaring scope's entry action calls it: once for a single object, once per element for an array. A struct is
assigned from outside instead, member by member, two levels deep (S-59). The class of a chart instance (S-65) is a
class like any other here. What follows from it:

- **Initial values are per object and in order.** In an array of instances `int b = a + 2` reads the element's own
  `a`, an initial value that calls a method of the chart runs it on the element, and a field that reads a sibling
  declared after it reads 0 (`probe-instance-array-init-sibling*`, `-init-method`, `-init-sibling-declared-later`).
- **An array of one object, or of none, is never initialised.** `createAllIndices` lists the elements' indices only
  when there is more than one, so no `_init` is called: `class C { int x = 3 } c[1]` and `ref Box g[1]` start at
  0, and so does everything inside (a class object inside the one instance; `[1][1]` is one element too, a
  `const` size of 1 as well). A number bound to an input of such an instance is lost with it: the input becomes a
  field whose initial value is the number, and stays 0 (`probe-instance-array-of-one-literal-input`). In a state that
  is entered again such members keep their values. A class array
  inside a class of several objects behaves the same (`probe-class-array-of-one-*`, `probe-instance-array-of-one-*`,
  `-class-array-of-one-inside-init`, `-reentry` probes; `probe-struct-array-of-one-init`: a struct is not affected).
- **An `_init` without a statement is called but never generated.** KIELER makes `_init` for every class with a
  variable or an object inside, and its C code fails when there is nothing to put in it: `implicit declaration of
  function 'Main_Mid1__init'` (two classes deep: `Main_Main_O_C__init`). That is a class whose only content is an
  object of a class without variables (`ref Mid m` where `Mid` only declares an instance of a chart with methods),
  an array of one object, or variables whose names start with `_` and have no value; the same inside a struct
  member with such a name. It does not fail when the object itself is an array of one (its `_init` is never
  called) or when a value is given (`int _h = 2`). A member of a host type has no value to set either (`class O {
  host "int" h } x` fails the same way). In an inner state KIELER fails earlier (`Cannot serialize
  simulation interface. Unsupported type null for variable _init`). Probes `probe-class-init-*` (28: 20 rejected,
  8 controls); engine code `empty-class-init`.

- Source: `processors/Initialization.xtend:107-141` (implicit initialisation), `233-265` (`_init` and its calls),
  `367-398` (`createAllIndices`).
- Engine: `sim/structure/classInit.ts`.

### S-61 Classes: fields and methods

`class Counter { int count = 10  void add(int k) { count = count + k }  int get() { return count } } c1, c2`
declares a class and two instances. Inside a class:

- **Fields** are declarations like struct members; they may also be `private` (then only the class's own
  methods can use them; `c.v` outside is a link error, `Couldn't resolve reference to ValuedObject 'v'.`,
  `116-err-class-private-field`). Field initial values may read inputs and other variables of the enclosing
  scope; they run when the declaring scope is entered (probe: `int v = I * 2` with `I = 5` gives `v = 10` in
  tick 1).
- **Methods** are written **without** the `method` keyword: `[type] name(params) { body }`, the return type
  optional (`inc() { v++ }` is void). `method inc() { ... }` inside a class is a syntax error (`missing '}' at
  'method'`). Bodies are SCL as in S-43 and S-44a–S-44f. A method may use the class's fields, call the class's
  other methods (also private ones) without a prefix, and read and write the variables visible where the class
  is declared (probe: a method writing the chart's output `O = base + v`).
- **Inner classes** (`class Outer { class Inner { int v } in  int w } o`, then `o.in.v`) and **arrays of
  instances** (`} cs[2]`, then `cs[0].inc()`) compile and run in KIELER (`124-class-inner`,
  `125-class-instance-array`). Structs nest the same way (`107-struct-nested`), also inside arrays
  (`ls[2]` of a struct with a struct `p` and an array `a`: `ls[1].p.x`, `ls[0].a[1]`), in two dimensions
  (`ps[2][2]`, `ps[1][0].x`) and with an index from an input (`ps[i].x`). A method of an inner instance is
  called through it (`ob.in.inc()`, or `in.inc()` in a method of the outer class); a method of an array
  element works on that element (`cs[i].inc()`, also with a loop, which KIELER keeps as a C function taking
  the element). A member's initial value holds for every element (`int v = 1` in `cs[2]`), and in a class one
  that reads a sibling member reads the element's own (`int b = a + 1`).
- **A struct's initial value that names a sibling does not read the sibling.** KIELER copies a struct member's
  value into the chart's initialisation as it is written, and its C code looks the name up in the chart's data:
  `int v = 10  struct O { int v = 3  int w = v + 2 } a` gives `a.w` 12, and without a chart variable `v` gcc fails
  (`'TickData' has no member named 'v'`, engine code `outer-member`). The struct's kind decides, also inside a
  class and for arrays of structs; a const sibling is its value. Probes `probe-struct-init-sibling*`,
  `probe-class-init-sibling*`, `probe-struct-init-const`.
- **Const members are replaced by their values two levels deep.** KIELER's Const processor replaces every
  reference to a const member of a class of the chart, or of a class directly inside one, by its value (by name
  inside the class, through an instance `a.N`, `cs[1].N`, `a.p[1].K`, as an array's size `p[N]`) and removes the
  member (it is not in the data). A const three levels in is not replaced: it stays a member in the data, can
  be assigned through its instance, and as an array's size it is no number (`Cannot initialize array with non
  integer cardinality: v`, engine code `array-cardinality`). Assigning a replaced const through its instance (`a.N = 4`) passes the validation,
  which only refuses the name alone, and crashes the processor (`ClassCastException: IntValueImpl cannot be cast
  to ValuedObjectReference`, engine code `kieler-crash`). The levels are counted with the classes unpacked
  (`@UnpackClass`: a const of a class unpacked into the chart is a constant of the chart, `a_N` is not in the data;
  one of a class three levels in that is unpacked into the second is replaced). The value is put where the const is
  named as the expression it is written as, not as a number: `int w = 2  const int N = w + 1` means the member `w`
  only inside the class itself (an initial value, a method, per element in an array of instances); read through
  the instance (`a.N`) or in a class inside, KIELER's C code looks `w` up in the chart's data (the chart's `w`, or
  gcc fails, engine code `outer-member`); in a struct it is the chart's `w` everywhere. An element of a const array
  needs an index that is an int literal when the array is replaced: a literal or a constant replaced before the
  array (`N[i]`, `N[0 + 1]`, a constant declared after it, an index out of range: `Cannot insert const array
  element. ...`, engine code `const-array-element`). The constants are replaced scope by scope from the root, in
  each scope in the order they are declared: the chart's constant can index an inner state's const array, not the
  other way round; an earlier const array's element (`N[K[1]]`) and a const member of an instance (`N[a[0].K]`)
  are replaced by then. Inside the value of a scope's own constant the index is computed first (`const int M =
  N[0 + 1]` is fine, from the constants declared before `M`); a class's constants are not computed first (`N[c.K +
  0]` in a constant's value stays `1 + 0`: rejected; `N[c.K]` is fine). Replacing substitutes, in order, into the
  values of later constants too: `class C { const int J = K } c` is a number as an index when `K` is replaced
  before the array, whichever of `K` and the class comes first. The engine models the two steps (lower.ts
  `computed`, `literalAt`). Probes `probe-const-member-*`, `probe-const-array-*`; source
  `Const.xtend:60-120`, `KExpressionsDeclarationExtensions.xtend:318`.
- **Initial values reach two levels into a struct, and every level of a class.** A class initialises its
  variables in a generated `_init` method that calls the `_init` of the classes inside it. A struct's values are
  assigned from outside, and KIELER collects them from its members and the members of the structs directly
  inside it only (`getAllNestedValuedObjects`): `struct A { struct B { struct C { int c1 = 3 } c } b } a` leaves
  `a.b.c.c1` at 0. A struct inside a class counts from the struct. Probes `probe-struct-init-depth*`,
  `probe-class-init-depth`, `probe-class-struct-init-depth`; source `Initialization.xtend:204-232`.
- **A whole instance can be assigned only when it is nested**: `q = p` and `ps[1] = ps[0]` are rejected
  (`Assignments to class/struct types are not supported.`), `a.q = a.p` is accepted and copies every member, as
  the C struct assignment it becomes. To the scheduler it writes `a.q`, which every access of a member of `a.q`
  reads (a member access reads each instance on its way): a concurrent `x = a.q.v` or `a.q.v = 9` comes after it.
  Probes `probe-struct-assign-*`.
- **A class inside a class cannot use the outer class's members.** KIELER's C code looks the name up in the
  chart's data: gcc fails with `'TickData' has no member named 'w'` for a member or a method of the outer class
  named in an inner method that is called or in an inner initial value; an inner method never called gets no C
  code and does no harm; and if the chart itself declares a variable of that name, the inner class silently uses
  that one. Probes `probe-class-outer-member*`, `probe-class-outer-method`; engine code `outer-member`.
- For scheduling, a member of one instance is one variable, and a member of an array of instances is one
  array: concurrent writes of different members (`p.x`, `p.y`) or of the same member of two nested instances
  (`l.a.x`, `l.b.x`) are independent, concurrent writes of `ps[0].x` and `ps[1].x` are accepted as writes of
  two elements of one array are, and a read of `ps[1].x` waits for the writes of `ps[..].x` in the same tick. Probes: `tests/engine/kieler/structure/probe-struct-*`, `probe-class-array-*`, `probe-class-nested-*`.
- A class cannot extend another class: `class B extends A { ... }` is a syntax error (`mismatched input
  'extends' expecting '{'`, `137-err-class-extends`). Inheritance is between charts (S-66).
- An enum declared inside a class cannot be used (S-58).

Each instance has its own fields (`113-class-fields-methods`: `c1` and `c2` count independently).

- Evidence: `113`, `114-class-private-helpers`, `116`, `124`, `125`, `137`; probes for the rest (official KIELER
  agrees).
- Source: grammar `SCTX.xtext` `ClassDeclarationWOSemicolon` (members `DeclarationOrMethodWOSemicolon`, whose
  methods are SCL's `MethodDeclarationWOSemicolon`, without the keyword), `KeywordMethodDeclarationWOSemicolon`
  (the `method` keyword form, only directly in states and regions).
- Teaching: a class packs a piece of state with the operations on it, like a counter with `inc()` and `get()`;
  the chart calls the operations instead of touching the fields. Plain English: "a class is a struct that also
  has its own little functions."
- Implementation: fields as for structs (S-59); methods as methods of the declaring scope whose bodies see the
  instance's fields and the class's other methods; private members resolvable only inside the class. An inner
  instance is an instance of its own (`o.in`, fields `o.in.v`); an array of instances keeps one array per member
  (`cs.v` with the instances' dimensions in front of the member's own, as C's `cs[i].v`), and a method of an
  element takes the element's indices as hidden first parameters (`lower.ts` `initialiseInstance`).

### S-62 Calling methods on instances

`c.inc()` is a statement in effects and actions (`do c.inc(); O = c.get()`, `during do c.increment()`), and
`c.get()` an expression anywhere, triggers included (`if c.big() do done = true go to B`,
`115-class-method-trigger`). A call behaves as the body run at that point (S-43): in `do O = c.get(); c.inc()`
the get sees the value before the inc.

| Chart | Result |
| --- | --- |
| a method used without parentheses (`o = c.get`) | `Methods must be used with call syntax using parenthesis.` (plus a gcc error), `117-err-method-without-parentheses` |
| a wrong number of arguments (`c.add(1, 2)` for `add(int k)`) | `Number of arguments does not match required parameters in definition.`, `118-err-method-argument-count` (official 0.3.0 accepts it and ignores the extra argument) |
| two methods with the same name and different numbers of parameters | allowed: `c.add()` and `c.add(10)` call the matching one (`121-class-overload-by-count`; official 0.3.0 runs `add()` both times) |
| two methods with the same name and parameter count | `Multiple definitions of methods with the same signature (add#1). Note that method overloading is currently only supported for parameters of different length, not type.` (source; `#1` is the parameter count) |
| a private method called from outside (`c.helper()`) | `Couldn't resolve reference to ValuedObject 'helper'.` (official 0.3.0 never answers) |
| a typed method without any `return` | `The method does not return any value!`, `119-err-method-missing-return` |
| `return e` in a method without return type | `Return statement is used but no return type is declared in method signature.` |
| a method that calls itself | lab: `The compiler ran out of stack space during Dependency.`; official KIELER never answers |
| a member or method of an **array** of objects named without the array's index (`q.w`, `q.get()` with `class In { ... } q[2]`; the same for an array of structs, an array of chart instances `ref C c[2]`, and an array inside another object, `c.q.w`) | gcc: `'(Main_In *)&d->q' is a pointer; did you mean to use '->'?` (`kieler/structure/probe-object-array-unindexed-*`; engine code `object-array-index`) |

- Source: `SCTXValidator.xtend:342-371` (`checkMethodCall`, `NO_METHOD_REFERENCE`),
  `kexpressions/.../extensions/KExpressionsOverloadingExtensions.xtend:52-58`,
  `SCChartsInheritanceExtensions.xtend:267-280` (same signature: name and parameter count),
  `scg/.../processors/MethodProcessor.xtend:381` (no return value), `kicool/.../CompilationContext.xtend:226`
  (lab: stack overflow).
- Teaching: always write the parentheses, even for `c.get()`; give overloaded methods different names rather
  than relying on the parameter count (official 0.3.0 gets it wrong).
- Implementation: resolve `inst.m(args)` by name and argument count; reject the table's cases with KIELER's
  texts (the lab's text for recursion).

### S-63 Instances and concurrency

A method call is analysed as its body: the fields it reads and writes are reads and writes of the call, whether
KIELER inlines the method or keeps it as a C function (S-44f). So

- `c.inc()` (`v++`) from two concurrent regions is two commuting updates (`120-class-concurrent-calls`: `v = 2, 4`),
- a region calling `c.get()` reads `v` after every region that writes it in that tick (`120`: `seen = 2` in
  tick 2, after both increments),
- two regions calling a setter with different values are a write-write conflict, as for any variable (probe:
  `c.set(1)` and `c.set(2)`: `Circular dependency involving v prevents scheduling this tick.`).

- Evidence: `120`. Probes: a setter in one region and a getter in another (`seen = 7` in tick 2, either region
  order); the conflicting setters.
- Teaching: an instance shared by several regions follows the same rules as a shared variable; methods hide
  the writes from the reader of the chart, not from the compiler.
- Implementation: give a call the reads and writes of the method body (minus its parameters and locals), with
  the body's own write classes (`v++` stays an update).

### S-64 `@UnpackClass`

`@UnpackClass` before a class declaration with exactly one instance makes KIELER's Unpack Classes processor
replace the members by plain variables named `<instance>_<member>`: `acc.sum` becomes `acc_sum`, and that is
the pool's name (`122-unpack-class`: `acc_sum = 1, 3`). Two instances are rejected: `Unpacking multiple
instances of the same class is not yet supported.` (`123-err-unpack-two-instances`); an array instance of a
class with methods: `Unpacking an array instance of a class with methods is not yet supported.` (source).
`@UnpackRenaming "suffix"` on a member names it `<instance><suffix>` instead (probes `probe-unpack-renaming*`; on a declaration of two members both get the one name, and gcc finds a duplicate member). On a `ref` declaration of
a chart class the annotation has no effect (probe). Official KIELER 0.3.0 ignores the annotation altogether:
the instance stays an object in the pool and two instances are accepted (S-68).

The processor also unpacks, innermost first:

| written | result |
| --- | --- |
| on a class with a class inside (`class O { int w  class In { int v } inn } o`) | the chart's `o_w` and the instance `o_inn` (pool `o_inn: { v }`); the inner class's methods may then use `w`, which is the chart's `o_w` |
| on a class inside a class (`class O { @UnpackClass class In { int v } inn } o`) | the members move into the outer class: pool `o: { inn_v }`; a method of `In` is a method of `O` (and may use `O`'s members) |
| on both | `o_inn_v`, `o_w` |
| on an array of instances (`} cs[2]`, at the top or inside a class) | every member gets the instance's dimensions in front: `cs_v[2]`, `cs_arr[2][2]`, `o: { inn_v: [..] }`; `cs[1].v` is `cs_v[1]` |
| on an array of instances with a method | rejected: `Unpacking an array instance of a class with methods is not yet supported.` |
| on a class inside an unpacked array of instances (`@UnpackClass class O { @UnpackClass class P { .. } p } a[2]`) | the inner class is an array too (`a_p_v[2]`): a method or an initial value in it is rejected as above; with only one of the two unpacked both are accepted |
| on an array of instances whose member has an initial value | rejected: the one value is assigned to the member, now an array (gcc: `assignment to expression with array type`; a vector as the value: `Cardinalities do not match. …`) |

- Evidence: probes `tests/engine/kieler/structure/probe-unpack-*`.
- Source: `processors/UnpackClasses.xtend:45-160`.
- Teaching: not needed for simulation; mention only if a reader asks why their pool shows `acc_sum`.
- Implementation: rename as KIELER does; reject the two cases above.

### S-65 Charts used as classes: `ref C x`

A chart without inputs and outputs can be instantiated with a `ref` declaration without bindings: `ref Counter
c` (several: `ref Counter c1, c2`). The chart's declarations are the instance's **fields** and its `method`
declarations (with the keyword, S-43) its methods: `c.increment()`, `c.getValue()`. Fields that are not
`private` or `protected` can be read and written from outside (`c.step = 5`); private and protected fields
cannot (`Couldn't resolve reference to ValuedObject 'hidden'.`), but they are in the pool (S-60). A `private
method` **can** be called from outside (probe: `c.bump()` works in both servers): KIELER does not check the
visibility of chart methods.

The chart's **regions** run as part of the instance: they start when the declaring scope is entered and run
concurrently with that scope's regions for as long as it is active, like S-18's instances
(`127-chart-class-regions`: a counting region next to the declaring state, restarted from 0 when the state is
left and entered again). Instances in nested states are hidden from the pool.

| Chart | Message |
| --- | --- |
| the chart has an input or output and the `ref` binds nothing | `The referencing binding is erroneous!\nValued object in the referenced scope was not bound properly: I` (and `There are binding errors in a state with reference declaration of c!…`), `129-err-chart-class-with-input` |
| assigning an instance (`c = d`) | `Assignments to referenced SCCharts are not supported. Except with dataflow semantics (i.e. in a dataflow region).`, `128-err-assign-chart-instance` |

A chart method can also be called in a dataflow equation (`O = c.twice(I)`, probe; official 0.3.0 never
answers), which makes the region an OO one (S-33a).

More, found with the dataflow probes (`tests/engine/kieler/dataflow/`):

- **Arrays of instances** (`ref Cnt cs[2]`): one object per element in the pool (`"cs": [{...}, {...}]`), the
  chart's regions and actions once per element, methods called on an element (`cs[0].bump(x)`, `cs[n % 2].add(1)`).
  The size must be a number or a constant (`Can only handle reference arrays with constant cardinality`).
  `probe-dataflow-chart-instance-array`, `-instance-array`, `-instance-array-methods`.
- **A chart with a signal cannot be instantiated** this way: `Signals in class declarations not yet supported`
  (KIELER's Signal processor refuses a signal in the class the instance has become; a local signal of the chart, or,
  for an OO dataflow instance, an input or output signal). `-chart-instance-signal`, `-instance-signal-ports`.
- **Class names** (S-65a). KIELER makes one class per `ref` declaration, named after the chart with the next free
  number (`Cnt1`, the next declaration of `Cnt`: `Cnt2`); the instances of one declaration share it (unless one of
  them has bindings: then every further instance gets a class of its own). The simulation interface lists the
  members under these names (`Cnt1.v`), a class of an inner state with a further number (`Cnt11`, `Cnt21`).
  `-instances-two-declarations`, `-instances-inner-states`, `-instances-root-and-inner-state`,
  `-instances-nested-class-names`, `-instances-one-declaration-*`.
- `ref Cnt c, d` with only one of them used in a dataflow region: the validator warns (`This reference declaration
  contains some valued objects that are used in dataflow regions and some not. ...`). `-instances-one-declaration-one-used`.
  When that region calls a method (S-33a), KIELER's mark that an instance keeps its inputs and outputs is on the
  **declaration**: both instances keep them as fields, so `d.a` is the input's own initial value and not the
  chart's `a` (`structure/probe-instance-dataflow-together`, `-three`, `-port-written`, `-inner-state`; two
  declarations are independent, `-two-declarations`). When one of the instances has arguments, the Reference
  processor gives every variable after the first a declaration of its own, without the mark: then only the
  **first** variable keeps its ports, whichever of them the region uses (`-other-arguments`, `-first-arguments`,
  `-used-arguments`: the instance the region names is bound by name and position like one outside dataflow).
- **Entered again.** An instance declared in a state starts again when the state is entered again (with or without
  `history`), and its fields start again too: those with an initial value at that value, those without at 0 (KIELER's
  implicit initialisation of the class's members), as a state's own locals do. For an OO dataflow instance (S-33a)
  that includes the inputs and outputs it keeps. `-chart-instance-reentry-field`, `-instance-reentry`,
  `-instance-reentry-port-initial-value`, `-instance-history-reentry`, `-instance-aborted-state`.
- Instances inside instances: S-18a.

**Arrays of instances.** `ref C g[2]` (also `[2][2]`, a `const int` size, with bindings or generic arguments) is
an array of class objects: the pool has `"g": [{"n": 1}, {"n": 2}]`, `g[i].inc()` and `g[1].n` work with literal
and variable indices, and every element runs its own copy of the chart's regions and actions (named
`g0_R`, `g1_R`; an array of one keeps `g_R`). Bound to one output, all elements write it. An element read or
written in a dataflow region that calls no method does not compile (`subscripted value is neither array nor
pointer nor vector`: the classic dataflow translation makes one instance of the whole array, engine code
`dataflow-instance-array`; where the elements' equations also contradict each other KIELER stops earlier, at the
schedule: `dataflow/probe-dataflow-instance-array-classic`); in a region that calls a method the elements are
objects and are wired one by one (S-33a). A size that is no constant: `Can only handle reference arrays
with constant cardinality` (source, engine code `reference-array-size`). Probes `tests/engine/kieler/structure/probe-reference-instance-array*`
(`-regions`, `-bound`, `-2d`, `-method-calls-method`, `-variable-index`, `-inner-state`, `-const-size`, `-of-one`,
`-member-array`, `-dataflow`), `generics/probe-generic-decl-array*`; source `processors/Reference.xtend:1221-1296`.

**Objects of the chart, from outside.** A class or struct object that the chart declares is reached through the
instance like a field: `c.q.w`, `c.q.get()`, `c.t.x`, also through arrays on either side and two classes deep
(`c[1].q.w = 9`, `c.q[1].get()`, `c.p.q.w`); a `private class` is not visible, and in a dataflow region only the
instance's inputs and outputs are (`probe-instance-object-*`, `probe-instance-struct-member`).

An array of one instance or of none is never initialised (S-60a), an array of none is `[]` in the pool (S-60), a
class object or a chart instance inside the elements belongs to its element (`probe-instance-array-class-field`,
`-array-nested-instance`: `g[1].inc()` writes `g[1].b.x` only), and a field whose name starts with `_` is a field
like any other, in the pool and the interface (`probe-instance-underscore-field*`; without an initial value KIELER
does not initialise it).

- Evidence: `126-chart-class` (methods and a public field), `127`, `128`, `129`, `130-chart-class-inheritance`.
- Source: `processors/Reference.xtend:927-1000` (`handleSCChartsDatatype`), `SCTXValidator.xtend:180-189`
  (`NO_ASSIGNMENTS_TO_REF`).
- Teaching: the wiki's "class modelling": write the class as a chart (fields, methods, even regions), then
  declare instances with `ref`. A `class` declaration is simpler when no behaviour of its own is needed.
- Implementation: expand each instance as a copy of the chart (S-4) whose locals are the instance's fields
  (reported as the object `c` in the pool) and whose methods are callable as `c.m()`; its regions are concurrent
  regions of the declaring state.

### S-65a The names of the classes KIELER makes

kicool keeps one cache of names for a compilation, filled with **every name of the compiled file** (states, regions,
variables, classes, charts, annotations: every named object) and with every name it hands out. Making a name unique
appends the next free number, counted per name. Two places use it for classes:

- The Reference processor names the class of a `ref C g` declaration after the chart: `C` is taken by the chart, so
  it is `C1`, the next declaration's `C2`. Anything in the file that is called `C1` already moves both on: a class
  `Cell1`, a variable `Cell1`, states `Cell1` and `Cell2` (then `Cell3`), an annotation `@Cell1`, a class of another
  chart of the file (`probe-instance-class-name-taken`, `-variable`, `-states`, `-annotation`, `-other-chart`,
  `-taken-nested`: inside a chart used as a class, `Mid1.Cell1.a` next to `Mid1.Cell2.v`).
- A class of an inner state moves to the root under a unique name: `C` becomes `C1`, a chart instance's class
  `Cell1` becomes `Cell11`. Instances declared together are one class and move once (`ref Cell c, d` in an inner
  state: `Cell11.v` only; two declarations: `Cell11.v` and `Cell21.v`; `-together-inner-state`,
  `-two-inner-state`, `-two-inner-states`, `-root-and-inner`, `-array-inner-state`, `-taken-inner-state`). Every
  copy of a for-region's state has its own (`dataflow/probe-dataflow-instance-in-for-region`: `Two11`, `Two12`).

- Source: `annotations/extensions/UniqueNameCache.xtend`, `kicool/.../UniqueNameCachePopulation.xtend`,
  `Reference.xtend:1016` (`classDecl.uniqueName`).
- Engine: `sim/structure/classNames.ts` (one cache for the Reference pass and for the classes that move to the
  root; `@sccharts-lab/trace` reads the names).

### S-66 Inheritance between charts: `extends`, `override`, `super`, `protected`

`scchart A extends B, C` inherits the declarations, actions, regions and methods of `B` and `C` (a chart reached
twice through the hierarchy is inherited once). Then:

- `override region R { ... }` replaces the inherited region `R`; inside, `region is super.R` runs the base
  chart's version (S-17). Only named regions can be overridden.
- `override method int value() { ... }` replaces an inherited method with the same name and number of
  parameters, everywhere: a base method that calls `value()` gets the override (`131-override-method`:
  `twice()` of the base, called on the subclass, returns `2 * 5`; on a base instance `2 * 1`).
- `super.value()` calls the base version: inside the override, and anywhere else in the extending chart (an
  effect, a trigger, a dataflow equation `super.add(x)`). KIELER keeps the base's method whenever a `super` call of it
  is written in the chart's methods, actions or regions (`dataflow/probe-dataflow-call-super`: `super.add(x)` and
  `add(x)` as equations call the base's and the override, although the override does not call `super`;
  `-super-outside-override`: the base's own `twice()` then calls the base's `value()`). **KIELER
  defect:** when the chart calls `super.value()` anywhere (in the override or elsewhere),
  KIELER keeps the base implementation under another name and every call of `value()` written in the base
  chart goes on calling that base version, so the base's `twice()` on the subclass returns `2 * 1`
  (`138-override-super-keeps-base`), whereas the same chart without `super` gives `2 * 5` (`131`). Calls written
  in the extending chart and from outside (`a.value()`) get the override in both cases.
- A `protected` field is visible in the extending charts but not outside (`135-err-protected-outside`); a
  `private` one only in its own chart. Inherited private and protected fields are renamed `<Base>_<field>`
  (`134-protected-field`: `"s": {"St134Base_secret": 21}` in the pool); every inherited field has the interface
  property `inherited`.
- **KIELER defect: an inherited declaration written alone as an index is lost.** The Inheritance processor
  redirects the references to its copies of the bases' declarations, except references directly inside another
  reference (`replaceVOR` skips them, meaning to skip members `a.b`; an index is inside its array's reference too).
  So `x[k]` with `k` declared in a base chart (a variable or a constant; `x` inherited or not, a member's index
  `c.arr[k]`, in a trigger or an effect, in the extending chart or in the base's own regions, at any number of
  levels, also in a referenced chart that extends one) fails: `The valued object reference points to a valued
  object (k) that is not contained in the model!` (engine code `inherited-index`). Inside an operator the name is
  redirected (`x[k + 0]`), and so is the chart's own variable as the index of an inherited array, a literal
  index, and a variable of a region of the base. An overridden region or method of the base is dropped with what
  is written in it (no error); an override that calls `super` keeps the base's method and its error; `region is
  super.R` copies the base's region by another path that redirects every name (accepted). A base chart's const
  array is replaced before the extending chart's own constants, so only a literal indexes it (or an index computed
  inside the value of one of the chart's own constants). Probes `probe-inherited-index*`,
  `probe-inherited-const-array-*`; source `Inheritance.xtend:523-530, 400-430`.
- Class and struct instances are inherited like variables: the extending chart reads and writes their members
  (`c.N`, `l.a.x`, `cs[1].v`, also with its own variable as the index), calls their methods and reads their const
  members; `@UnpackClass` instances too. The trace lists the inherited types' members (`C.v`). What KIELER rejects
  in a base chart's body is rejected in the extending chart as well (the body is the chart's now). Probes
  `probe-inherited-instance-*`, `probe-inherited-base-const-array*`.
- A chart with `extends` can be simulated itself or used as a class (`130-chart-class-inheritance`: the wiki's
  `TwoCounterApplication`, `ControlledCountingCounter extends CountingCounter extends Counter`, with `override
  region`, `region Counting is super.Counting` and methods `start()`/`stop()` called in entry and exit actions).

| Chart | Message |
| --- | --- |
| an inherited method redefined without `override` | `Methods with the same signature is already inherited (value#0). Mark this declaration as override (keyword) to replace previous definitions. Note that method overloading is currently only supported for parameters of different length, not type.` and `Method (value) was redefined in the inheritance hierarchy but not marked as override.` (`132-err-redefined-without-override`) |
| `override` with nothing to override | `No matching or visible method found with this signature to override.` |
| an override with another return type | `Overriding methods must not declare a different return type (int vs. bool).` (`133-err-override-return-type`) |
| an inherited variable or constant alone as an index (`x[k]`) | `The valued object reference points to a valued object (k) that is not contained in the model!` (`probe-inherited-index`) |
| a field with the name of an inherited one | `This variable name is already used in a base state.` (+ `Variable v is declared again along the inheritance hierarchy.`), `136-err-extends-name-reuse` |
| a region with the name of an inherited one, without `override` | `There is an inherited region with the same name, you may use the override keyword.` |
| `override` on an anonymous region / on a region that is not inherited | `Cannot override anonymous region.` / `The is no region to override.` (sic) (source) |
| an inheritance cycle | `Inconsistent inheritance hierarchy! Cycle including base state: B` (source) |
| an inner state `state T extends B` that leaves an input or output of `B` unbound | `The binding of inherited variables is erroneous!` + `Valued object in the referenced scope was not bound properly: o` (`parity/probe-inner-extends-unbound`) |

**Bindings on `extends`.** `scchart X extends Base(i, p)` binds the base chart's inputs and outputs to the
chart's own variables (by the pointer of S-6, `x to y` too, a literal for an input): the base's names are replaced
everywhere and their declarations go, so the pool has `i` and `p` only (`probe-extends-binding`, `-named`,
`-literal`). The argument names are looked up in the chart's own declarations and what the bases written *before*
this one give it, not in what it inherits from this very base (`extends Base(x, o)`: `Couldn't resolve reference
to ValuedObject 'x'.`). **The list must bind every input and output of the base**: an open one has no source, and
KIELER's compiler copies it regardless (`java.lang.NullPointerException ... Inheritance.replaceVOR`; engine
`kieler-crash`; `probe-extends-binding-open*`). `extends Base()` binds nothing and is fine (`-empty`). A literal
bound to an output the base writes crashes the compiler as a written literal parameter does
(`-binding-literal-output`). The validation says nothing about a root chart's parameter list, so such a chart is
only rejected when it is compiled (`-binding-open-unused-chart`). A reference to such a chart binds its own
inputs and outputs only (`-binding-referenced`).

**Inner states.** A state inside a chart can extend a chart (`initial state T extends B(o) { ... }`): it gets
`B`'s declarations (as locals, hidden from the pool), actions (before its own) and regions, can override regions
and use `region is super.R`, add regions and actions of its own, and inherit methods; two states extending the
same chart have a copy each (`probe-extends-inner*`: `-binding`, `-binding-named`, `-binding-literal`,
`-transitions`, `-own-region`, `-override`, `-override-super`, `-actions`, `-method`, `-two`, `-two-levels`,
`-generic`). Its parameter list follows the rule above, and unlike a reference its unbound inputs and outputs are
**not** bound by name to the variables around it: only to the inputs and outputs that an enclosing state (or the
chart) inherits through its own `extends` (`probe-inner-extends-own-name`, rejected;
`probe-inner-extends-inherited-name`). KIELER inherits for the chart it compiles, the states inside it and the
instances of `ref` declarations (`-inner-in-declared`), but **not for the states inside a chart it copies for
`state S is C`**: such a state keeps nothing from its base (`-inner-in-referenced`: accepted, the base's region
never runs), and naming something of the base, or binding with a parameter list, points out of the model
(`-inner-in-referenced-name`, `-inner-in-referenced-binding`).

**Diamonds.** A base chart reached along two paths is rejected as soon as it declares a non-private variable:
`There is a name clash between declared valued object in inheritance hierarchy. Valued object with name k is
declared multiple times (B, B).` (`probe-extends-diamond`; KIELER counts the two base *references*); without one
it is inherited once (`-diamond-empty`). Two base charts with a region of one name: `There is a name clash
between regions IDs in inheritance hierarchy. Region with name R is declared multiple times (L, R).`
(`-region-clash`).

**`state(S)` in a base chart's method** does not work: KIELER makes the flag where `S` is written, in the base
chart, which is not compiled (`The valued object reference points to a valued object (_R_B_active) that is not
contained in the model!`, `probe-extends-state-access`, engine `state-access-copy`).

Evidence: `tests/engine/kieler/parity/probe-extends-*`, `probe-inner-extends*`; source `Inheritance.xtend:95-521`
(bindings 278-447), `SCTXValidator.xtend:208-275` (clashes), `:430-447` (`checkBaseStateBindings`),
`SCChartsReferenceExtensions.xtend:244-271`, `SCTXScopeProvider.xtend:374-390` (what an argument of `extends`
sees), `processors/Reference.xtend:195-204, 288-292` (where inheritance is applied).

**Official KIELER 0.3.0 cannot compile method overrides**: every chart with an `override method` that is called
fails there (no answer at all for `131` and `138`; gcc errors or no answer for the probes; gcc errors for the
return-type case), while
override regions, `super` regions, protected fields and the wiki's two-counter example (`130`) work in both.

- Evidence: `130`–`136`, `138`; probes for the rest.
- Source: `sccharts/src/.../extensions/SCChartsInheritanceExtensions.xtend:267-385` (method inheritance),
  `SCTXValidator.xtend:165-320`, `processors/Inheritance.xtend:122-265` (declarations of the base charts copied,
  non-public ones renamed `<Base>_<name>`; an overridden method whose `super` is called is kept and renamed, and
  the base chart's references keep pointing at it; otherwise they are redirected to the overrider).
- Teaching: inheritance is an advanced topic; show override regions first (they work everywhere), and method
  overriding with a warning that the VS Code extension's KIELER cannot compile it.
- Implementation: merge the base charts' declarations, actions, regions and methods into the extending chart
  before reference expansion; resolve calls to the most derived method; check the table's cases.

### S-67 Host classes and host enums

`host class Counter { void increment()  int getValue() } counter` and `host enum Bit { ZERO, ONE }` declare
types that exist in the target language (with `#resource` and `#hostcode` providing them, S-47); KIELER keeps
the calls and values as they are in the generated code. They need the C or Java host code, so the guide's
simulator cannot run them (corpus probes: a Java-style `host class "List<Integer>"` fails in the C simulation
with `expected specifier-qualifier-list before ‘List’`; a `host class Counter` with a scheduling policy and no C
definition with `unknown type name ‘Counter’`).

- Teaching: mention only as the way to call existing C or Java code; never in exercises.
- Implementation: report as unsupported ("cannot run in the browser").

### S-68 Official KIELER 0.3.0 and the object-oriented features

Official 0.4.3 (KIELER 1.6.1) behaves as the third column on every chart below (official-diff, November 2026).

Every chart of this section and its probes (83 probes and the conformance charts) was run through both servers.
Where both accept a chart, the pools agree except for the rows marked "pool".

| Chart | Official KIELER 0.3.0 | KIELER 1.6.1 (0.4.3) / lab server |
| --- | --- | --- |
| `output ref E x` | `no viable alternative at input 'ref'` | an output enum (`102`) |
| `input ref E x` | accepted, but not an input: the variable stays 0 whatever the environment sets | an input enum (`102`) |
| `b = a` between two variables of one enum | `Cannot assign enum value of an incompatible type.` | accepted (`101`) |
| an unknown enum value (`Color.PURPLE`) | in an initial value: no answer; in an assignment (`speed = Speed.MEDIUM`): the message plus Java exceptions (content probes, October 2026) | link error and S-58's message |
| a bare enum value as an initial value (`ref Speed speed = OFF`) | no answer (a `NullPointerException` in CopyPropagationV2) | the link error (`Couldn't resolve reference to ValuedObject 'OFF'.`) |
| `const` member of a struct or class (pool) | in the pool (`"c": {"MAX": 3, "v": 0}`) | not in the pool |
| wrong number of arguments | accepted, the extra argument ignored | rejected (`118`) |
| overloading by parameter count | the first method runs for every call (`v = 2, 4`) | the matching one (`121`: `v = 11, 22`) |
| `@UnpackClass` (pool) | ignored: `"acc": {"sum": 1}`; two instances accepted | `acc_sum`; two instances rejected (`122`, `123`) |
| calling an `override method` | gcc errors (`Compiler did not return success …`) or no answer (`131`, `138`) | works (`131`, `138`) |
| an override with another return type | gcc errors | `Overriding methods must not declare a different return type (int vs. bool).` (`133`) |
| a method redefined without `override` | `Method (value) was redefined in the inheritance hierachy but not marked as override (keyword).` (sic) and gcc errors | S-66's two messages (`132`) |
| a signal member | `Cannot serialize simulation interface. Unsupported type: pure` | `Signals in class declarations not yet supported` |
| a private class method called from outside | the link error, then no answer | the link error |
| a method that calls itself | no answer | `The compiler ran out of stack space during Dependency.` (lab) |
| a chart-class method in a dataflow equation | no answer | works |
| interface names of chart-class fields | `QR01Counter.counter` | `QR01Counter1.counter` (pools identical) |

Teaching consequence: the guide's examples of this section should stay within what both accept (enums declared
at the top and used in non-input/output variables, enum values assigned explicitly, structs, classes with
fields and methods called with the right arguments, chart classes, override regions); method overriding,
enum inputs/outputs and `@UnpackClass` need a "KIELER 1.6 only, not the old extension 0.3.0" note.

---

## 9. Host code

The behaviour in this section comes from the generated C (or Java) and its compiler. A TypeScript engine cannot
execute it; scenarios that depend on it carry `"needs": ["c-hostcode"]` (or `["c-strings"]`, `["c-random"]`).

### S-45 Backtick host code

`` `text` `` is pasted into the generated code unchanged: as an effect it is a statement (in KIELER's C
simulation the variables are reached as `d->x`), as an expression a value (`` y = `7 * 6` ``). No dependency
analysis sees through it.

- Evidence: `77-hostcode-backticks` (`x = 42, y = 42`).
- Teaching: host code ties a chart to one target language and hides its effects from the compiler's
  causality analysis; use it for I/O at the edges only.
- Implementation: cannot be executed in the browser; report as unsupported (the chart still parses and draws).

### S-46 `extern` functions

- `extern "abs" absf` declares a host function under a local name; call it with parentheses: `absf(a)`.
  Per-language names: `extern @C "twice", @Java "twice" tw`.
- `extern abs(a)` calls a host function without a declaration.
- Without parentheses the editor warns `You are using an external reference without call syntax. If you want to
  generate a call, you must add parentheses.` and C compilation fails (`‘absf’ undeclared`).
- The C compiler must see a declaration: gcc rejects implicit declarations
  (`implicit declaration of function ‘abs’ [-Wimplicit-function-declaration]`, then
  `Compiler did not return success (exit value != 0)...`). Provide it with `#hostcode "#include <stdlib.h>"`.
- Calls from concurrent regions run in region order (probe: a counter function called from two regions gives
  `x = 1, y = 2`).
- Evidence: `78-extern-function`, `79-err-extern-without-include`.
- Teaching: declare host functions with `extern` and include their header with `#hostcode`; an error from gcc
  means the generated C did not compile.
- Implementation: unsupported in the engine (a small table of pure C functions such as `abs` could be
  emulated, but nothing else).

### S-47 `#hostcode` pragmas and host types

| Pragma | Goes into |
| --- | --- |
| `#hostcode "..."` | the generated C **header and** C file (the C file includes the header), **and** the Java file of the Java systems |
| `#hostcode-c "..."` | the C file only |
| `#hostcode-c-header "..."` | the header only |
| `#hostcode-java "..."`, `#hostcode-java-inner "..."` | the Java file (inside the class for `-inner`) |
| `@hostcode "..."` on the root chart | like `#hostcode` (probe) |

`#hostcode` is the only pragma that both back ends read: a C include there breaks the Java simulations
(`97-err-hostcode-in-java`: javac fails on `#include <stdlib.h>`), and Java code there works in Java
(`98-hostcode-java-import`) but would break C. Charts meant for every back end use the language-specific
pragmas. In C, `#hostcode` is for `#include`s and typedefs; a function **definition** there is defined twice
(`redefinition of ‘twice’`); put definitions in `#hostcode-c`. `host "int64" big` declares a variable of a host
type; the type must be known to the C compiler (probe: with `#hostcode "typedef long long int64;"` it works;
without, `unknown type name ‘int64’`). `#resource "file"` copies files into the build and compiles them along
(source only).

- Evidence: `78`, `80-err-hostcode-definition-in-header`, `97`, `98` (both servers agree on 97 and 98).
- Source: `scg/src/.../scg/processors/codegen/c/CCodeGeneratorModule.xtend:160-210`;
  `scg/src/.../scg/processors/codegen/java/JavaCodeGeneratorModule.xtend:109-125` (`HOSTCODE` +
  `HOSTCODE_JAVA`), `JavaCodeGeneratorStructModule.xtend:322-334` (`-inner`).
- Teaching: includes and typedefs in `#hostcode`, function bodies in `#hostcode-c`.
- Implementation: pragmas are parsed and kept; nothing to simulate.

### S-48 `print`

`print(a, b, ...)` writes its arguments to the simulation's console, **separated by single spaces, with no
newline**. It changes no variable, so it is invisible in the data pool. Formats in C: `%s` for string literals
and string variables, `%d` int, `%f` float (6 decimals), `%x` bool (prints `1`/`0`), `%X` for anything else.
KIELER's C simulation prints the text on the same line as that tick's JSON output; the KIELER simulator strips
the JSON and shows the rest. A `\n` inside a print string breaks the generated C (`missing terminating "
character`).

- Evidence: `81-print` (pool unchanged); generated code `printf("%s %d", "x is", d->x)` and console output
  `x is 2` (probe: generated binary run by hand). `print("x is ", x, " ok")` prints `x is  6  ok`.
- Source: `scg/src/.../codegen/c/CCodeSerializeHRExtensions.xtend:267-308` (the "first argument is a string"
  test compares a `Parameter` with `StringValue`, so formats are always generated).
- Teaching: `print` is for debugging in the simulator console; its output does not appear in the trace.
- Implementation: accept `print`, evaluate its arguments, show the joined text in a console pane; never touch
  the pool. Format ints as decimal, bools as `1`/`0`, floats with six decimals (`%f`), strings as is.

### S-49 Strings in the C simulation

String variables are `char*` in C. Assigning literals works (`mode = "running"`), but `==` compares pointers:
an input string never equals a literal (`82-string-equality-c`: `cmd == "go"` is false with `cmd = "go"`;
gcc warns `comparison with string literal results in unspecified behavior [-Waddress]`). The Java
simulations compare contents (probe: `hit = true`). See also basics B-26 (string comparison, null strings).

- Teaching: do not compare strings in charts meant for the C simulation; use an `int` code or an enum.
- Implementation: to match the C oracle, model `==` on strings as pointer identity (an input string is never
  identical to a literal; a variable assigned a literal is identical to the same literal, since gcc pools
  literals); the basics area records the exact cases. Flag the kielerBug in the UI.

### S-50 `random()` and `randomize()`

`random()` (or `random`) is a float in [0, 1]: `((float) rand() / RAND_MAX)` in C. The simulation never seeds
the generator, so every run gives glibc's default sequence: 0.84018772840499878, 0.39438292384147644,
0.78309923410415649, 0.79844003915786743, 0.91164737939834595, 0.19755136966705322, 0.3352227509021759,
0.76822960376739502, ... (float32 values; one per call, in execution order). Assigned to an `int` it truncates
to 0.

`randomize()` (`srand(time(NULL))`, so every run differs afterwards) compiles only where it is not in the netlist
compiler's tick-1 block and when `<stdlib.h>` is included:

- In the tick-1 block (an entry action of the root or of an initial state, or an untriggered immediate
  transition of tick 1) the netlist compiler moves the call into `reset()` and writes it out as `null`:
  `‘null’ undeclared (first use in this function)` (`84-err-randomize`; basics B-34). An input-dependent
  tick-1 transition (`immediate if A do randomize()`) is not in that block and compiles (probe).
- Elsewhere (a delayed transition, a later state's entry action) it compiles (`99-randomize-after-tick-1`),
  provided gcc sees `srand`: current KIELER includes `<stdlib.h>` only when the chart also calls `random()`;
  otherwise `#hostcode "#include <stdlib.h>"` is needed, or gcc reports `implicit declaration of function
  ‘srand’` (probe). Official KIELER 0.3.0 includes nothing for either function (basics.md section 10).
- The priority compiler does not include `<time.h>` either (`implicit declaration of function ‘time’`, probe
  of `99` with `--system priority`).

- Evidence: `83-random-c` (ticks 2 and 3 consume rand() calls 1–3), `84-err-randomize`, `99`; sequence from a C
  program calling `rand()` 8 times.
- Teaching: KIELER's "random" numbers are the same in every run, which makes simulations reproducible but is
  not randomness.
- Source: `CCodeSerializeHRExtensions.xtend:350-373`.
- Implementation: to reproduce KIELER exactly, emulate glibc's default `rand()` (seed 1) and the float
  division. Checked against the C output for the first 8 values:

  ```js
  const r = new Int32Array(344 + N); r[0] = 1
  for (let i = 1; i < 31; i++) { const hi = Math.floor(r[i-1] / 127773), lo = r[i-1] % 127773
      let w = 16807 * lo - 2836 * hi; if (w < 0) w += 2147483647; r[i] = w }
  for (let i = 31; i < 34; i++) r[i] = r[i-31]
  for (let i = 34; i < 344 + N; i++) r[i] = (r[i-31] + r[i-3]) | 0
  // k-th call (k = 0, 1, ...): n = r[344 + k] >>> 1; random() = Math.fround(Math.fround(n) / 2147483648)
  ```

  (`RAND_MAX` becomes the float 2147483648 in `(float) rand() / RAND_MAX`.) One generator per simulation run,
  shared by all `random()` calls in execution order.

---

## 10. `static` and `global`

### S-51 `static` locals keep their value across re-entry

A `static` local of a nested state is initialised once (at the start) and keeps its value when the state is
left and re-entered; a plain local is re-initialised on every entry. KIELER moves the static variable to the
root and renames it `<Root>_<region>_<State>___<name>` (e.g. `St85Visits_region0_A___visits`), so it **is**
in the pool under that name. A static without initial value draws the warning
`Static variables should be initialized.`

- Evidence: `85-static-local` (`kept = 1, 2, 3`, `plain = 1`). Probe: the warning.
- Source: `processors/Static.xtend:86-97`; `SCTXValidator.xtend:934`.
- Teaching: `static` is a local that remembers across visits, like a C `static` local. Plain English: "a static
  variable is set up once and keeps its value even when you leave the state."
- Implementation: initialise statics once at reset, never on entry; expose them in the pool under KIELER's name,
  built by `getHierarchicalName` (`sccharts/src/.../extensions/SCChartsCoreExtensions.xtend:83`: names of the
  enclosing scopes from the root down, an unnamed region as `region<index>`, joined with `_`) plus `__` and the
  variable name: observed `St85Visits_region0_A___visits` for state A in the root's unnamed region.

### S-52 `global`

A `global` declaration is moved to the root and merged by name with a root variable of that name. Uses:

- In a referenced chart, a `global` is shared by all instances (one variable, by its own name in the pool),
  whereas a plain local exists once per instance (`86-global-in-instances`: two instances → `shared = 2, 4`).
- In a nested state of the root chart, `global int g = 5` merges with the root's `int g = 100`: the root's
  initial value wins (probe: `g = 100, 101, 102`).
- In the referenced chart, a `global` whose name is also a parent variable is renamed by reference expansion
  (S-11) before the merge, so it is **not** shared with that parent variable (probe: parent `shared` stays 0).
- `global` in the simulated chart's own root crashes KIELER:
  `java.lang.IllegalArgumentException: Can't copy valued object. Valued object is null!` (`87`).

Source: `processors/Static.xtend:99-120` (the root's own global finds itself as "existing" and is removed).

- Teaching: rarely needed; passing a parent variable to every instance is clearer than `global`.
- Implementation: after reference expansion, move every `global` declaration of a non-root scope to the root,
  merging by name: if the root already has a variable of that name (its own, or one moved there by an earlier
  global), references are redirected to it and its declaration (initial value included) is kept. Reject
  `global` in the root.

---

## 11. Compilation and simulation systems

### S-53 The systems

All systems run the same SCCharts normalisation (`sccharts/system/de.cau.cs.kieler.sccharts.extended.kico`:
references and dataflow, region actions, code effects, for, prTransitions, enum, const, period, timed
automata, init operator, fby, sfby, history, signal, suspend, count delay, pre, weak suspend, deferred,
static, during, final region, complex final state, exit, entry, abort, initialisation, connector, array
assignment, user schedule; then `core`: trigger/effect, surface/depth, valued-object rise). They differ in
the back end. The "tts" variants first add taken-transition signalling (S-15); the oracle uses those.

| System id (`--system`) | Label | Back end |
| --- | --- | --- |
| `de.cau.cs.kieler.sccharts.simulation.tts.netlist.c` (oracle `netlist`, default) | Netlist-based Simulation (C) | SCG → guards → scheduler → sequentialiser, C |
| `de.cau.cs.kieler.sccharts.simulation.tts.priority.c` (oracle `priority`) | Priority-based Simulation (C) | SCG → priorities (SCL_P), C |
| `de.cau.cs.kieler.sccharts.simulation.tts.netlist.java` | Netlist-based Simulation (Java) | as netlist, Java |
| `de.cau.cs.kieler.sccharts.simulation.tts.priority.java` | Priority-based Simulation (Java) | as priority, Java |
| `...tts.statebased.c`, `...tts.statebased.lean.c`, `...lean.cs.c`, `...lean.java` | State-based (Lean) Simulation | SCCharts → state machine code |
| `...tts.priority.c.legacy`, `...priority.java.legacy` | Priority-based (Legacy) | older priority back end |

The oracle accepts any of these ids as `system` (`SYSTEMS[key] ?? key` in `tools/oracle/oracle.mjs`). Java
systems need `javac` on the server's `PATH` (the JDK at
`/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin` has it).

- Teaching: the oracle, and so this guide, use netlist-based C; mention the others only where they differ.
- Implementation: the engine implements netlist semantics; scenarios with `"system": "priority"` document the
  differences of S-54.

### S-54 Netlist and priority differ in what they accept

- **Instantaneous loops.** The netlist compiler rejects any cycle of immediate transitions, even one a guard
  ends at run time (`Can't schedule ...`, `The SCG is NOT asc-schedulable!`, `Circular dependency prevents
  scheduling this tick.`, editor warning `There is an immediate loop. The model is not SASC.`). The priority
  compiler accepts it and runs the loop at run time: `91-priority-runs-guarded-loop` fires S → T → S five
  times in one tick (`taken = [5, 5]`). An unguarded immediate loop compiles too, but its simulation hangs
  (section 12).
- **Write-write conflicts and dataflow cycles** are rejected by both; priority says
  `The SCG is not IASC-schedulable!` (probe).
- **First-tick writes of inputs.** The netlist compiler moves first-tick assignments that do not read inputs
  into `reset()`, where the environment's inputs overwrite them: `92-netlist-first-tick-input-write` loses
  `x = 7` (`y = 1`), `93-priority-first-tick-input-write` keeps it (`x = 7, y = 7`). (KIELER defect,
  `scg/.../processors/optimizer/GOInitOptimizer.xtend`.) Basics B-34 documents the tick-1 reordering in
  general.
- **Termination flag.** Only netlist simulations have `_TERM`; priority recordings have `terminated:
  undefined`.
- Everything else in this area (references, dataflow, clocks, for, methods, period) behaves identically in
  netlist and priority, C and Java (probe: six charts × four systems), except host code in Java (S-47) and two
  details found later: `99-randomize-after-tick-1` fails with priority (`implicit declaration of function
  ‘time’`: that back end does not include `<time.h>`), and `94` crashes with a `NullPointerException` instead
  of `Can't copy valued object` (rejected either way). The other charts added in October 2026 (`38`, `39`, `58`,
  `59`, `89`, `95`, `96`) agree (probe). Of `100`–`165` (probe): the same results except `146` and `155`
  (accepted by priority), `150` (priority inlines both methods, so `b` becomes 9 as well), an instance without
  fields missing from the priority pool instead of `{}` (`131`, `138`), and the referenced charts of S-15a
  (`158`–`165`, see there).
- Teaching: the netlist compiler (the oracle's default) is the strict one; a chart it accepts runs the same in the
  priority compiler, but not always the other way round.
- Implementation: the engine targets netlist semantics; a "priority mode" would need run-time loop iteration
  (with a step limit, since KIELER itself would hang).

### S-55 C and Java

Same results except host code (S-45–S-47 are C-specific) and string equality (S-49: Java compares contents).

- Teaching: charts without host code behave the same in C and Java.
- Implementation: none (the engine is neither); string equality follows the C oracle.

### S-56 State-based systems are unreliable for this area

Probes: `statebased.c` fires a clock timeout one tick late (`t >= 100` with deltaT 100: tick 3 instead of 2),
never runs a `period`, and fails to compile methods; `statebased.lean.c` rejects dataflow, clocks and
periods (`Cannot topologically sort regions due to dependency cycles.`) and crashes on `print` with a string
(`ClassCastException`). The guide should not use them.

- Teaching: if a reader's results differ from the guide, check that they use a netlist or priority system.
- Implementation: none.

---

## 12. What KIELER rejects

Exact texts as reported by the oracle (lab server). "official" marks differences from official KIELER.

| Construct | Message | Rule / evidence |
| --- | --- | --- |
| unknown chart in `is` | `Couldn't resolve reference to NamedObject 'Nope'.` | S-5 |
| unbound formal | `The referencing binding is erroneous!\nValued object in the referenced scope was not bound properly: second` | S-7, `17` |
| too many arguments | `...no free Valued Object left in the referenced scope: extra` | S-6, `18` |
| unknown explicit formal | `Couldn't resolve reference to ValuedObject 'nope'.` | S-6 |
| literal to output | `It is not possible to bind the literal false \n                    to the output beep !` | S-8, `19` |
| expression actual | `A binding for the valued object reference "second" exists, but the type "...OperatorExpressionImpl" is not supported.` (compiler only) | S-8, `20` |
| array to scalar | `It is not possible to bind array a to scalar v!` | S-8, `25` |
| bool variable to signal formal | `O is an output bool variable, not a signal, so it cannot be emitted.` (lab; official crashes) | S-8 |
| recursive reference | `Recursive reference: chart X uses itself (X -> X).` (lab; official never finishes) | S-16, `21` |
| `region R is Chart` | `Couldn't resolve reference to NamedObject 'Chart'.` | S-17, `22` |
| missing, surplus or wrong generic argument | `The referencing binding is erroneous!\n` + `There is no parameter given for generic parameter declaration of N.` / `There is no declaration for the given generic parameter (position: 1).` / `Type mismatch! Generic parameter N of type int cannot take literal of type bool.` | S-73 |
| generic chart first in the file | `A root SCChart cannot have unbound generic parameters.` | S-73 |
| a generic parameter or bound input where KIELER does not replace it | `The valued object reference points to a valued object (N) that is not contained in the model!` | S-9, S-74 |
| a written literal parameter | `java.lang.ClassCastException: ... IntValueImpl cannot be cast to ... ValuedObjectReference` | S-74 |
| wrong generic argument on `extends` | `Errornous generic parameter. Paramter N of Base was not set correcly. ...` | S-76 |
| `extends Base(i)` leaving an output open | `java.lang.NullPointerException ... Inheritance.replaceVOR` | S-66 |
| a base chart with a variable, reached along two paths | `There is a name clash between declared valued object in inheritance hierarchy. ...` | S-66 |
| missing import | warning `Broken Import: There is no SCCharts model with the given name.` + link errors | S-20 |
| link error in another chart | e.g. `Couldn't resolve reference to ValuedObject 'q'.` | S-2, `27` |
| for-region problems | see S-24 | `33`–`37`, `94` |
| dataflow problems | see S-27a, S-30a, S-31, S-32, S-33, S-33a | `38`, `39`, `53`–`56`, `59`, `89`, `tests/engine/kieler/dataflow/` |
| an OO dataflow instance with more arguments than ports | `java.lang.NullPointerException: Cannot invoke "...ValuedObject.eContainer()" because "valuedObject" is null` | S-33a |
| a chart with a signal instantiated with `ref`; signal ports of an OO dataflow instance | `Signals in class declarations not yet supported` | S-65, S-33a |
| a call in the argument of a call whose method an earlier node called | `The compiler failed during compilation setup.` | S-44f |
| clock problems | see S-39 | `67`, `68`, `71` |
| weak abort out of a state with `period` | `The SCG is NOT asc-schedulable!` (priority: `The SCG is not IASC-schedulable!`) | S-42a, `74` |
| extern without declaration | `implicit declaration of function ‘abs’ [-Wimplicit-function-declaration]` | S-46, `79` |
| function defined in `#hostcode` | `redefinition of ‘twice’` | S-47, `80` |
| unknown host type | `unknown type name ‘int64’; did you mean ‘int’?` | S-47 |
| `\n` in a print string | `missing terminating " character` | S-48 |
| `randomize()` in the tick-1 block | `‘null’ undeclared (first use in this function)` | S-50, `84` |
| `randomize()` without `<stdlib.h>` | `implicit declaration of function ‘srand’` | S-50 |
| `#import "file"` | `no viable alternative at input 'import'` | S-20, `96` |
| C code in `#hostcode` in a Java simulation | javac: `Compiler did not return success …` | S-47, `97` |
| `global` in the root chart | `java.lang.IllegalArgumentException: Can't copy valued object. Valued object is null!` | S-52, `87` |
| guarded immediate loop (netlist) | `The SCG is NOT asc-schedulable!` (priority accepts) | S-54, `90` |
| assignment followed by a statement without `;` (SCL) | `Missing Semicolon` | S-44a, `140`, `141` |
| `return e;` | `extraneous input ';' expecting '}'` | S-44e, `142` |
| `else if` | `missing '{' at 'if'` | S-44b, `144` |
| `for (i = 0; ...)` with a chart variable as counter | gcc: `‘i’ undeclared (first use in this function)` | S-44c, `146` |
| `return` in a code effect | `Return statements can only be used in method bodies.` | S-44e, `148` |
| a declaration after a statement in a block | `missing '}' at 'int'` | S-44d, `149` |
| an assigned parameter called with a literal | `The compiler failed during compilation setup.` (official: no answer) | S-44f, `151` |
| `@inline` on a method with a loop | `The SCG is NOT asc-schedulable!` | S-44f, `155` |
| enum problems | see S-57, S-58 | `104`, `105` |
| struct problems | see S-59 | `109`–`111`, `156` |
| method calls (parentheses, arguments, return) | see S-62 | `117`–`119` |
| private and protected members from outside | `Couldn't resolve reference to ValuedObject 'v'.` | S-61, S-65, `116`, `135` |
| `@UnpackClass` with two instances | `Unpacking multiple instances of the same class is not yet supported.` | S-64, `123` |
| chart classes (inputs, assignment) | see S-65 | `128`, `129` |
| method inheritance and name clashes | see S-66 | `132`, `133`, `136` |
| `class B extends A` | `mismatched input 'extends' expecting '{'` | S-61, `137` |
| `state(S)` outside a method body | `State access expressions are only permissible in methods bodies.` | S-69 |
| `scchart(C).X` whose value names another constant of `C` | `The valued object reference points to a valued object (BASE) that is not contained in the model!` | S-70 |
| `scchart(C).T[1]` of a const array | gcc: `expected expression before ‘{’ token` | S-70 |
| a primed name, a kept `^` (variables, signals, members) | gcc: `missing terminating ' character`, `expected identifier or ‘(’ before ‘^’ token` | S-71 |
| a line break or a quote in a string literal (`"a\nb"`, `"a\"b"`) | gcc: `missing terminating " character` | S-72 |
| `%` or `%=` with a float | gcc: `invalid operands to binary % (have ‘double’ and ‘double’)` | S-72 |
| a parameter or top-level local `d` in a method kept as a C function | gcc: `conflicting types for ‘d’; have ‘int’`, `‘d’ redeclared as different kind of symbol` | S-72 |
| an `extern` function used without parentheses | gcc: `‘absolute’ undeclared (first use in this function)` | S-72 |

Warnings worth explaining in the guide: implicit binding (S-7), non-terminating reference with `join to`
(S-13), duplicate chart names (S-3), `Potential instantaneous loop through the timed transitions on t.`
(S-41), `ValuedObject with name ... is contained in the model but not in VariableStore.` (S-27, S-43, also for
class methods' parameters and `self`), static without initial value (S-51), extern without call syntax (S-46),
`A class/struct should have at least one variable defined (Type definitions are not supported).` (a struct or
class declared without instances, S-59).

---

## 13. Notes for the oracle and the engine

- **Chart names must be unique across everything recorded in one oracle run.** The server resolves
  `is C` against all root charts of all files it has loaded, and every scenario's file stays loaded (the
  workspace holds them all). With two scenarios defining `Sub`, a reference may silently resolve to the other
  scenario's `Sub` (seen in probes: "Couldn't resolve reference to ValuedObject 'b'" and "not bound properly:
  c" for a chart that has neither). `pnpm oracle:record` runs every stale scenario of `src/examples` and
  `tests/conformance` in one server, so content authors must use distinctive chart names in charts that
  reference others (this suite prefixes every chart with `St<NN>`; `structure.test.ts` enforces it). A fix in
  `tools/oracle/oracle.mjs` would be to write each scenario outside the workspace root, or delete its files
  after the run.
- **An endless instantaneous loop hangs the priority simulation**, and the oracle then reports the previous
  values with no error (probe: `immediate if A do n++ go to T; T: immediate go to S` with `A = true` reported
  `n = 0`; the generated binary, run by hand, never answers). Never record such a chart.
- To inspect the generated C, run the oracle with `TMPDIR=<dir>`: each scenario's `kieler-gen/` (C sources
  and `bin/simulation.exe`) is kept under `<dir>/sccharts-oracle-*/m<n>/`; the binary reads one JSON object of
  inputs per line on stdin and prints the pool (first line: after `reset()`).
- Error messages may contain the oracle's temporary file path (link errors on generated objects); compare
  messages by substring.
- Engine API: `compile()` must simulate `charts[0]` (S-1), resolve references over the file and `files`
  (S-5, S-20), and expand references, for-regions, dataflow regions, `->`/`fby`/`sfby`, clocks and periods
  as described above before scheduling (all are compile-time expansions in KIELER, in the order given in
  S-53). Host code, `extern`, `#hostcode` and `random()` cannot be reproduced faithfully without C; report
  them as unsupported (or emulate glibc `rand()`, S-50).

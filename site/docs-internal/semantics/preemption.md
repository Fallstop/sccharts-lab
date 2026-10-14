# Semantics: preemption, local actions and the extended transitions

Area **preemption**. Rules are numbered **P-n**. Every rule is backed by a chart in
`tests/conformance/preemption/` (named `NN-…`, cited as **#NN**) whose behaviour was recorded with the real
KIELER compiler and simulator (`*.oracle.json`), or, where marked *probe*, by a throwaway experiment whose
chart is quoted inline. Ticks are numbered from 1 (tick 1 = the first reaction, in which the initial states
are entered).

Verified with the sccharts-lite server (KIELER fork, upstream `kieler/semantics` 5f02d129; the processors cited
here are unchanged from upstream except for tracing) on the netlist-based C simulation, October 2026. The
priority-based compiler (`--system priority`) agrees on every chart except the ones listed in §4.

Source paths are relative to `kieler-server-fork/modules/sccharts/src/de/cau/cs/kieler/sccharts/`.
`processors/X.xtend:N` is a line in that file.

Contents: §0 how KIELER implements this area (read first) · §1 summary tables · §2 rules (P-1 … P-65, plus P-38a) ·
§3 everything KIELER rejects or warns about here · §4 netlist vs priority · §5 notes for the simulator,
with KIELER's own expansions of the constructs · §6 where the KIELER wiki is wrong · §7 open points.

---

## 0. How KIELER implements this area

None of these constructs exist in the simulated model. KIELER rewrites an extended SCChart into a *core*
SCChart (only simple states, superstates with regions, delayed/immediate weak-abort transitions and
terminations) through a fixed chain of processors, then compiles the core chart with the sequentially
constructive (SC) scheduler. The chain, from `system/de.cau.cs.kieler.sccharts.extended.kico` (lines 18-52), in
the order it runs:

| # | processor | what it removes |
|---|---|---|
| 1 | `History` | `history`, `shallow history` (P-47) |
| 2 | `Signal` | signals |
| 3 | `Suspend` | `suspend`, `immediate suspend` (P-37) |
| 4 | `CountDelay` | `if n T` on transitions (P-28) |
| 5 | `Pre` | `pre(...)` |
| 6 | `WeakSuspend` | `weak suspend` (P-46) |
| 7 | `Deferred` | `deferred`, `deep deferred` (P-53) |
| 8 | `During` | `during`, `immediate during` (P-6) |
| 9 | `FinalRegion` | `final region` (P-61) |
| 10 | `ComplexFinalState` | final states with actions or inner states (P-10) |
| 11 | `Exit` (weak) | `weak exit` (P-12) |
| 12 | `Entry` (weak) | `weak entry` (P-11) |
| 13 | `AbortRegion` (pre-process, off by default) | — |
| 14 | `Abort` | `abort to`, aborts on superstates (P-14 …) |
| 15 | `Exit` (strong) | `exit`, `strong exit` |
| 16 | `Initialization` | initial values of declarations (become the first entry action) |
| 17 | `Entry` (strong) | `entry`, `strong entry` |
| 18 | `Connector` | `connector` states (P-57) |

Most surprises in this area follow from that order:

- `entry` and `exit` without a keyword have preemption type **strong** (metamodel defaults:
  `impl/EntryActionImpl.java:55`, `impl/ExitActionImpl.java:55`). They are expanded *after* `Abort`, so they wrap
  the abort machinery and run whenever the state is entered or left, even by a strong abort. `weak entry` and
  `weak exit` are expanded *before* `Abort` and so become inner behaviour that aborts can cut off.
- `Suspend` runs before `CountDelay`, `During`, `Entry` and `Exit`: it guards every action and transition in and
  on the suspended state, including the state's own entry and exit actions and its outgoing transitions, with a
  flag that is computed by a during action. Several quirks follow (P-38, P-38a, P-42 … P-44).
- `CountDelay` turns a count into an entry action, a during action and `pre`, so count delays inherit the
  timing of those (P-36).
- `History` is the very first processor and only walks the top level (P-51).

Terminology used below:

- **entry tick** of a state: the tick in which it is entered. **Delayed** behaviour (default transitions,
  `during`, `suspend`) is not checked in the entry tick; **immediate** behaviour is.
- **inner behaviour** of a state in a tick: its inner regions' transitions and actions, its own during
  actions and its `weak entry`/`weak exit` actions. Entry and exit actions without `weak` are not inner
  behaviour.
- **abort tick**: the tick in which a state is left by one of its outgoing transitions.
- A transition `go to` is a **weak abort**, `abort to` a **strong abort**, `join to` a **termination**. On a
  simple state, "abort" just means "outgoing transition".

---

## 1. Summary tables

**What runs in the tick a state is left** (all verified; see the rules):

| | weak abort `go to` | strong abort `abort to` | termination `join to` |
|---|---|---|---|
| inner transitions, immediate chains (superstate) | yes, to completion (#17) | no (#18) | yes |
| the state's own `during` / `immediate during` | yes (#01, #11) | no (#02, #11, #33) | yes (#13) |
| inner states' `during` | yes (#11) | no (#11) | yes |
| `exit` / `strong exit` (state and active inner states, innermost first) | yes (#01, #04) | yes (#02, #20) | yes (#15, #16) |
| `weak exit` on a superstate | **no** (#15) | no (#15) | yes (#15) |
| `weak exit` on a simple state | yes | yes (#81) | — |
| transition effect, then target's entry actions | yes | yes | yes |

**What runs in the tick a state is entered**:

| | normal entry | entry + immediate strong abort | entry by `deferred` | entry while `immediate suspend` holds |
|---|---|---|---|---|
| `entry` / `strong entry` | yes | yes (#20) | **never** (#63) | **never** (#46) |
| `weak entry` | yes | no (#14) | never | never |
| entry actions of inner initial states | yes | yes (#20) | shallow: yes (#66) or one tick later (#65); deep: never (#67) | never (#46) |
| `immediate during` | yes (#10) | no (#33) | next tick (#63) | when resumed (#46) |
| immediate outgoing transitions | yes | — | next tick (#63, #64) | when resumed (#46) |
| delayed `during`, delayed transitions | no | no | from the next tick | when resumed |

**Order within one transition** (P-1): *during of source (weak only) → exit actions, innermost first, each
state's in declaration order → transition effects in order → entry actions of the target, outermost first, each
state's in declaration order → the target's immediate behaviour*. Each step sees the values written by the
steps before it (#05).

---

## 2. Rules

### A. Entry, during and exit actions

#### P-1 Order of the actions when a transition is taken
**Rule.** When a state A is left by a transition t to B in some tick, the following happen in this order:
(1) if t is a weak abort or termination: A's inner behaviour of the tick, including A's during actions;
(2) the exit actions of A's active descendants, innermost first, then A's own exit actions;
(3) t's effects, left to right; (4) B's entry actions, then the entry actions of B's initial inner states,
outermost first; (5) B's immediate behaviour (immediate transitions, immediate during actions). Each step reads
the values the earlier steps wrote.
**Evidence.** #01 tick 3 (during 2, exit 3, effect 4, entry 5); #02 tick 3 (strong: no during);
#04 ticks 1-2 (outer entry 1, inner entry 2; inner exit 3, outer exit 4, effect 5); #05 tick 2 (x = 5 → y = 10
→ z = 11 → w = 1); #06 tick 1.
**Source.** `processors/Exit.xtend:152-232` (exit actions become transitions between the inner termination and
the outgoing transitions, which `Abort` has already moved onto a connector, `processors/Abort.xtend:400-449`);
`processors/Entry.xtend:98-160` (entry actions become an immediate chain in front of the initial state or the
inner regions).
**Teaching.** One-liner: *leave inside out, enter outside in, and the transition's own effect sits in the
middle.* Beginners often expect the target's entry to run before the source's exit, or think a transition
effect cannot see what an exit action just wrote.
**Implementation.** All steps are sequential within the thread of the region that contains A and B, so plain
sequential execution is correct. Inner regions of A that are aborted run their exits concurrently with each
other; order them only by data dependencies.

#### P-2 Entry actions run on every entry
**Rule.** A state's `entry` actions run every time it is entered: initially, by any transition, by a self-loop,
by a history transition (P-47) and even in the entry tick of an immediate strong abort (P-17). They run before
the state's immediate outgoing transitions are checked. The entry actions of the root state (`entry` written
directly in the `scchart`) run first in tick 1, after the declarations' initial values.
**Evidence.** #03 ticks 2 and 4 (self-loop re-entry); #06 tick 1 (entry sets `ready`, the immediate transition
sees it); #09 tick 1 (root entry 1, A's entry 2); #20 tick 1; #34; #57 tick 4. *Probe:*
`output int x = 5` with root `entry do x = x * 2` gives x = 10 in tick 1.
**Source.** `processors/Entry.xtend:105-160`; initial values: `processors/Initialization.xtend:165-191`
(inserted as entry action number 0 of the declaring state).
**Teaching.** *Entering a state always runs its entry actions, even if you leave it again at once.* Exceptions:
deferred entry (P-53) and suspension (P-39, P-42).
**Implementation.** Initial values of variables declared in a state are re-applied on every entry of that state,
before its entry actions (#61, and `basics/14-superstate-reinitialises-locals`).

#### P-3 Exit actions run on every exit
**Rule.** A state's `exit` actions run every time it is left: by a weak abort, by a strong abort, by
termination, by a self-loop, and when an ancestor is left (active descendants exit first). The root's exit
actions run when the chart terminates. A final state's exit actions run when its parent terminates. Exceptions:
`weak exit` (P-12), a suspended state (P-43), and a simple state that has no outgoing transitions and no
ancestor that can be left (its exit is dropped, `processors/Exit.xtend:127-132`).
**Evidence.** #02 tick 3 (strong abort on a simple state); #03 (self-loop); #04 tick 2 (ancestor left);
#09 tick 2 (final state exit 4, root exit 5, chart terminates); #15 (exit runs on strong, weak and
termination); #16 tick 2; #20 tick 1 (strong abort in the entry tick).
**Source.** `processors/Exit.xtend:105-243` running as pass 15, after `Abort`.
**Teaching.** *An exit action is a "finally" block: it runs however the state is left.* The KIELER wiki says
exit actions are suppressed by strong aborts; that is wrong for the current compiler (§6).
**Implementation.** The exit of a state nested in a strongly aborted superstate also runs (#20 `innerExit`):
the strong abort reaches it as a strong abort of its own.

#### P-4 Several actions of one kind run in declaration order
**Rule.** Several `entry` actions of a state run in the order written, as do several `exit` actions.
**Evidence.** #08 (entry1At = 1, entry2At = 2; exit1At = 3, exit2At = 4).
**Source.** `processors/Entry.xtend:138-160`, `processors/Exit.xtend:209-236`.
**Teaching.** *Top to bottom.*
**Implementation.** Several `during` actions of one state are separate concurrent regions: they have no
order other than data dependencies (P-8).

#### P-5 Triggers on entry and exit actions
**Rule.** `entry if c do …` evaluates c when the state is entered (after the transition effect that led in);
`exit if c do …` evaluates c when the state is left (before the transition effect). Count delays are not
allowed on entry or exit actions (syntax error).
**Evidence.** #07 (guards evaluated per entry/exit); #86 (`entry if 2 A` → `no viable alternative at input 'A'`).
**Source.** `processors/Entry.xtend:151-156`, `processors/Exit.xtend:226-231` (guarded transition plus an
untriggered default); grammar `text/SCTX.xtext` rules `EntryAction`/`ExitAction` (no `triggerDelay`).
**Teaching.** *A guarded entry/exit action is an "if" inside the action, checked at that moment.*
**Implementation.** Straightforward.

#### P-6 `during` runs in every active tick except the entry tick
**Rule.** A delayed `during` action of state S runs in every tick in which S is active at the start of the
tick, including the tick in which S is left by a weak abort or terminates, and excluding S's entry tick and
any tick in which S is strongly aborted or suspended. This holds for simple states too: on a simple state the
during action is the only inner behaviour, so `go to` and `abort to` differ there (P-21).
**Evidence.** #01 ticks 2-3; #02 tick 3 (strong: skipped); #11 (weak: runs; strong: skipped; entry tick: no);
#13 tick 2 (runs in the termination tick); #44 (suspended: no).
**Source.** `processors/During.xtend:99-148`: each during action becomes a region `_During` with a delayed self-
loop carrying the effects. A state with no inner behaviour and an untriggered immediate outgoing transition
drops its delayed during actions (they could never run) and turns immediate ones into weak entry actions
(lines 101-108).
**Teaching.** *`during` = "on every tick after the first, while I'm here".* A common mistake is to expect
it in the entry tick (use `immediate during`) or to be surprised that it still runs in the tick the state is
left with `go to`.
**Implementation.** Model a during action as an extra region of S with one state and a delayed self-loop
(`if c do effects`); then all abort rules apply to it unchanged.

#### P-7 `immediate during` also runs in the entry tick
**Rule.** `immediate during` additionally runs in the entry tick, even if the state is left again in that same
tick by an immediate weak abort or immediate transition; not if it is left by an immediate strong abort.
**Evidence.** #10 tick 1 (countA = 1) and tick 3 (B entered and left in one tick, countB = 1); #33 ticks 1-2.
**Source.** `processors/During.xtend:120-127` (two-state loop `_I →imm _S → _I`).
**Teaching.** *Add `immediate` to include the first tick.*
**Implementation.** As P-6 with an immediate first step.

#### P-8 During actions are concurrent with the inner regions
**Rule.** A superstate's during actions behave like an extra concurrent region: in one tick, whichever of the
during action and an inner transition writes a variable that the other reads goes first (SC "write before
read"), regardless of nesting.
**Evidence.** #12 tick 2 (during writes, inner reads) and tick 3 (inner writes, during reads).
**Source.** `processors/During.xtend:111` (a new `_During` region per action).
**Teaching.** *Outer `during` actions don't run "before" or "after" the inner states; they run alongside them.*
Concurrent writes of the same variable by a during action and an inner region are subject to the usual SC
rules (see the concurrency spec).
**Implementation.** Schedule during-regions with the regular SC scheduler.

#### P-9 Root-level actions
**Rule.** `entry`, `during` and `exit` written directly in the `scchart` belong to the root state: the root
entry runs first in tick 1; a root `during` runs from tick 2 (or from tick 1 if `immediate`), also in a chart
without states; the root exit runs in the tick the chart terminates, after the exits of the final states.
**Evidence.** #09; *probes:* `scchart P { output int x = 0  during do x = x + 1 }` gives x = 0, 1, 2;
with `immediate during` and a state, x = 1, 2, 3.
**Source.** `processors/During.xtend:99` (`activeDuringAction` for a root without inner behaviour);
`processors/ComplexFinalState.xtend:184-193` (explicit termination region for the root).
**Teaching.** *Chart-level actions are the actions of an invisible outermost state.*
**Implementation.** Treat the root like any superstate whose termination ends the run.

#### P-10 Final states with actions ("complex final states")
**Rule.** A final state that has during or exit actions, outgoing transitions or inner states is a *complex
final state*. Its region still counts as terminated while it is active, so its parent can terminate in the
tick it is reached; the final state's exit actions then run as part of leaving the parent; its delayed during
actions run only in ticks in which the parent stays (it never gets one if the parent terminates immediately).
A region whose final state is left again by an outgoing transition is no longer terminated: termination needs
every region to be in a final state at the end of the tick.
**Evidence.** #16 tick 2; #09 tick 2. *Probe:* R1 `I →A F`, `F →B I`; R2 `J →B G (final)`; `join to Done`:
at the tick with B, R1 leaves F and R2 reaches G, so the parent does not terminate.
**Source.** `processors/ComplexFinalState.xtend:157-160` (definition), `:195-250` (term flags; terminations become
weak aborts).
**Teaching.** *A final state can still have exit actions; they run when the parent finishes.*
**Implementation.** Track "terminated" per region as "currently in a final state"; evaluate termination after
all regions have reacted.

#### P-11 `weak entry`
**Rule.** `weak entry` is an entry action that counts as inner behaviour: it runs whenever the state is
entered, except when the state (or an ancestor) is strongly aborted in its entry tick, in which case it is
skipped (plain and `strong` entry actions still run). The same holds for `weak entry` of inner initial states.
**Evidence.** #14 tick 3 (plainEntry runs, weakEntry and innerWeakEntry skipped) and ticks 1, 4 (all run);
*probe:* with an immediate *weak* abort in the entry tick, weak entry runs.
**Source.** `system/…extended.kico:40-42` (weak pass before `Abort`); `processors/Entry.xtend:80-90`.
**Teaching.** *Rarely needed.* Use it for set-up work that is pointless if the state is immediately aborted.
**Implementation.** Expand weak entry actions before aborts, i.e. as the first step of the state's inner
behaviour.

#### P-12 `weak exit` runs only on normal termination of a superstate
**Rule.** On a superstate, `weak exit` runs only when the state is left by termination (`join to`); it is
skipped on weak **and** strong aborts. On a simple state it behaves exactly like a plain exit. `strong exit`
is the same as plain `exit`.
**Evidence.** #15 (strong: weakExit 0; weak: 0; termination: 1); #81 (simple state, strong abort: 1).
**Source.** `processors/Exit.xtend:152-159` (weak pass: wraps the regions into `_Main`, exit actions on the
termination `_Main → _Done`); `Abort` then adds abort transitions from `_Main` that bypass `_Done`.
`processors/Exit.xtend:134-138,162-195` (simple states: the outgoing transitions are moved inside, so every exit
passes the action).
**Teaching.** *`weak exit` = "on normal completion only".* The name suggests "skipped only by strong aborts";
that is not what KIELER does.
**Implementation.** Reproduce via the expansion or with the rule as stated.

#### P-13 Count delays on during actions are ignored
**Rule.** `during if n T` (n ≥ 2) compiles with a warning and behaves exactly like `during if T`.
**Evidence.** #42.
**Source.** `text/validation/SCTXValidator.xtend:1159-1163` (warning); `processors/During.xtend:137-142` copies
the trigger but not `triggerDelay`.
**Teaching.** *Don't count in a during action; count with a transition or a counter variable.*
**Implementation.** Ignore `triggerDelay` on during actions; emit KIELER's warning.

### B. Aborts and termination

#### P-14 Weak abort: the inner behaviour of the tick runs first
**Rule.** In a tick in which a weak abort of superstate M fires, every inner region first completes its
reaction for the tick (transitions, immediate chains, entry/exit/during actions of inner states, M's during
actions), then M is left. A region that is in a final state simply counts as finished.
**Evidence.** #17 tick 2 (I1 → I2 → I3, then effect); #11 tick 3; #22.
**Source.** `processors/Abort.xtend:318-356`: every non-final inner state gets an immediate transition of lowest
priority to `_Aaborted`, guarded by the abort trigger, so it fires exactly when the region would otherwise come
to rest.
**Teaching.** *`go to` from a superstate grants a "last wish": the inside finishes its tick.*
**Implementation.** See §5. The weak abort is checked in each region at the point where the region would pause.

#### P-15 Strong abort: nothing inside runs
**Rule.** In a tick in which a strong abort of M fires, no inner behaviour of M runs (no inner transitions,
no during actions of M or of inner states, no `weak entry`/`weak exit`), but the exit actions of M's active
inner states and of M run (P-3), followed by the effect and the target's entry.
**Evidence.** #18 tick 2; #11 tick 5; #02 tick 3; #20.
**Source.** `processors/Abort.xtend:299-317`: strong aborts become the *highest-priority* transitions of every
inner state (recursively strong for inner superstates).
**Teaching.** *`abort to` stops the inside before it moves.* Beginners expect `abort to` to also skip exit
actions (the wiki says so); it does not.
**Implementation.** Check strong aborts at the start of each inner region's reaction (P-19 for timing).

#### P-16 Delayed and immediate aborts
**Rule.** An abort without `immediate` is not checked in the tick its superstate is entered; from the next tick
on it is checked every tick. An `immediate` abort is checked in the entry tick too, and in every later tick.
**Evidence.** #21 (tick 1 both triggers true, nothing fires); #19, #20 (fire in tick 1); #35 (immediate abort
fires in tick 3).
**Source.** `processors/Abort.xtend:250-284` (delayed strong aborts are delayed inner transitions; delayed weak
aborts go through a delayed transition in the control region `_ACtrl`, lines 230-239, 367-396).
**Teaching.** *Same rule as for any transition: delayed means "not in the first tick".*
**Implementation.** Standard delay handling relative to the superstate's entry tick.

#### P-17 Immediate abort in the entry tick
**Rule.** If an immediate abort fires in the superstate's entry tick: all `entry` actions still run (the
superstate's and its inner initial states'); for a weak abort the inner immediate behaviour then runs (immediate
transitions, immediate during actions); for a strong abort it does not; then exits, effect and target entry.
**Evidence.** #19 (weak: entries, chain I1 → I2, effect); #20 (strong: entries run, chain skipped, both exits
run); #33 tick 1 (strong skips a simple state's immediate during), tick 2 (weak runs it).
**Source.** `processors/Entry.xtend` strong pass runs after `Abort` (§0), so entry actions sit in front of the
abort machinery.
**Teaching.** *You always pay the entry actions, even for a state you leave at once.*
**Implementation.** Run entry actions as part of entering, before any abort check of the entered state.

#### P-18 Priority among a superstate's outgoing transitions
**Rule.** Transitions are prioritised in the order written. Strong aborts must all come first (P-27). When
several transitions can fire in the same tick, the one written first wins; in particular, a weak abort and a
termination that are both enabled in the same tick are decided by their order. If a strong and a weak abort
both hold, the strong one wins and the inner behaviour is skipped.
**Evidence.** #24 (weak abort written first beats termination), #25 (termination written first wins), #26
(strong beats weak), *probe* (two weak aborts both true: the first one's effect only). Same finding as
`concurrency.md` T-5.
**Source.** `processors/Abort.xtend:407-434` (connector with the original order; the last transition is the
untriggered default).
**Teaching.** *Order = priority, top to bottom.*
**Implementation.** Decide the winning transition after all regions have reacted (see P-23).

#### P-19 When abort triggers are read
**Rule.** A strong abort's trigger is read by each inner region *before* that region's own reaction in the tick;
a weak abort's trigger is read *after* the inner behaviour of the tick. So a value written by the inner
behaviour in the abort tick is seen by a weak abort in the same tick but by a strong abort only in the next tick.
Exception (the "mixed" case): if the superstate has a delayed strong abort *and* an immediate way out (see the
implementation note), KIELER reads the strong trigger in a separate control region and hands it to the inner
regions through a flag; a strong trigger written by the inner behaviour is then a causality cycle and the chart is
rejected.
**Evidence.** #22 tick 2 (weak abort sees `flag` written inside, leaves at once); #23 ticks 2-3 (strong abort
reads the old value, leaves one tick later); #87 (the same with an extra `immediate if W go to Other`: rejected,
*Circular dependency involving flag, inner prevents scheduling this tick.*); *probe:* the same with an extra
`join to Other` and an inner final state that cannot be reached in the entry tick behaves like #23.
**Source.** `processors/Abort.xtend:305,314` (strong: highest priority) and `:343-347` (weak: lowest priority,
immediate); delayed weak triggers are read in `_ACtrl` (`:367-396`), which the SC scheduler runs after the inner
writes.
**Teaching.** *Strong looks before the inside moves; weak looks after.*
**Implementation.** Both reads take part in SC scheduling (write-before-read); see P-20. The mixed case is
`processors/Abort.xtend:188-198`: some strong abort is delayed, some outgoing transition is implicitly immediate,
and either some abort (strong or weak) is immediate or every region can reach a final state in the entry tick
(`extensions/SCChartsTransformationExtension.xtend:55-80`). A `join to` counts as an immediate weak abort here
when `handleTermination` has rewritten it (`processors/Abort.xtend:139-161`: whenever the state also has weak
aborts, several or conditional terminations, or a delayed strong abort while the inside can finish immediately).
In the mixed case each delayed strong abort gets a flag `_Atrig`, reset on entry, set by the control region
`_ACtrl` when the trigger holds, and read by the inner regions at highest priority.

#### P-20 A strong abort whose trigger is written inside aborts region by region
**Rule.** The strong abort is checked separately by each inner region. If one inner region writes the trigger in
the tick, the other regions (which read it after that write) can be aborted while the writing region (which read
it before writing) is not; the superstate is then left only in a later tick, when every region has been aborted
or finished. (In the mixed case of P-19 such a chart is rejected instead.)
**Evidence.** #31 tick 2 (R2 aborted, countR2 stays 0; R1 moves on; M stays) and tick 3 (R1 aborted, M left).
**Source.** `processors/Abort.xtend:298-317` (one abort transition per inner state, each with a copy of the
trigger).
**Count delay on the writer.** When the transition inside the superstate that writes the trigger has a count
delay (`if 3 true do expired go to …`), KIELER rejects the chart (`The SCG is NOT asc-schedulable!`), for a weak
abort as for a strong one; without the count delay both are accepted, and so is an abort that reads
`pre(expired)` (probes `tests/engine/kieler/preemption/probe-abort-trigger-inside-{weak,strong}-{count,plain}`,
`-pre`; the guide's `patterns/watchdog` WatchdogInside, and WatchdogInsideCounter for the accepted shape: with a
pure signal as trigger the writing region is never aborted, so the superstate is never left).
**Teaching.** *Never make a strong abort depend on something the aborted state itself writes in that tick;* use a
weak abort or a termination. (In Esterel this would be a causality error; KIELER accepts it.)
**Implementation.** A faithful implementation falls out of the expansion; a direct interpreter must evaluate the
strong trigger per region inside the SC schedule, not once per superstate.

#### P-21 Aborts on simple states
**Rule.** On a simple state without actions, `abort to` and `go to` behave identically (KIELER turns strong
aborts of such states into weak ones). With actions, the difference is only the state's during actions: they run
in the leaving tick of a weak abort and not of a strong one. Entry and exit actions run in both cases.
**Evidence.** #01 vs #02 (tick 3), #33.
**Source.** `processors/Abort.xtend:451-460`; a simple state with a during action has become a superstate
(During runs first), so it gets the superstate treatment.
**Teaching.** *For a plain state the abort type does not matter, unless it has during actions.*
**Implementation.** Same mechanism as superstates once during actions are regions.

#### P-22 Aborts without a trigger
**Rule.** A weak or strong abort without trigger on a superstate compiles with the warning *Abort transitions
should have a trigger.* and is always enabled: delayed, it fires in the superstate's second tick; immediate, it
fires in the entry tick (after the inner immediate behaviour, if weak).
**Evidence.** #30; *probe:* `immediate do y = 1 go to T` on a superstate with an inner immediate chain: both run
in tick 1.
**Source.** `text/validation/SCTXValidator.xtend:916-923`.
**Teaching.** *To leave when the inside is done, use `join to`, not an untriggered `go to`.*
**Implementation.** Treat the missing trigger as `true`.

#### P-23 Which transition is taken is decided after the exit actions
**Rule.** When an abort fires, KIELER lets every inner region end (aborted or final), runs the superstate's exit
actions, and only then chooses the transition, in priority order: a delayed weak abort is chosen if its trigger
was true when it was checked; a termination if all regions finished; any other abort if its trigger is true
*now*; and the lowest-priority transition is taken without checking its trigger if none of the others is chosen.
So an exit action that changes an abort's trigger can change the target, even to a transition whose trigger is
false. For a simple state the choice is made before the exit actions and kept.
**Evidence.** #32 tick 2 (exit sets `y`, `A && !y` is re-read as false, the untriggered fallback goes to C
although X is false); #82 (same chart with a simple state: B); #88 (mixed case: the strong abort's choice is
remembered, B); *probes:* with immediate weak aborts the trigger is
re-read in the same way (`immediate if A && !y go to B`, `immediate if X go to C`, A and X true, exit sets y: C);
with delayed weak aborts the choice is kept (`if x go to B`, `if true go to C`, exit sets x = false: B).
**Source.** `processors/Abort.xtend:409-434` (connector: trigger variables `_Atrig` only for delayed weak
aborts and, in the mixed case of P-19, for delayed strong aborts, `:254-262, 275-284`; the last transition's
trigger set to `null`, `:430`; a single outgoing transition needs no connector, `:436-449`). Simple states:
`processors/Exit.xtend:162-195` (`_exit` memory variable).
**Teaching.** *Don't let exit actions write what the state's own outgoing triggers read.* This is a KIELER quirk,
not intended language design.
**Implementation.** A direct interpreter must re-evaluate after the exits exactly as described to match.

#### P-24 Self-loops on superstates restart them
**Rule.** A transition from a superstate to itself (weak or strong) leaves it (exits) and enters it again from its
initial states (entries); inner progress is lost.
**Evidence.** #34 (strong self-loop: inner reset to I, exits and entries counted).
**Source.** Normal leaving and entering; nothing special.
**Teaching.** *To keep inner progress, use `history`.*
**Implementation.** None.

#### P-25 Termination (`join to`) and its delay
**Rule.** A termination without trigger fires as soon as every inner region is in a final state, also in the
superstate's entry tick. `delayed join to` and a termination with a trigger (`if c join to`) are delayed: never
in the entry tick; `immediate if c join to` is checked in the entry tick too. A superstate whose regions all reach
final states but which has no termination transition stays until an abort fires. (Termination in general is
specified in `concurrency.md`, T-1 … T-6; this rule only records what matters next to aborts.)
**Evidence.** #74 (plainAt = 1, delayedAt = 2, guardedAt = 2); #13; *probes:* `immediate if !A join to Done` with
an immediately finishing inside fires in tick 1; inner `I →A F` with only `if S abort to Done`: reaching F changes
nothing, S later leaves.
**Source.** `extensions/SCChartsTransitionExtensions.xtend:132-135` (`isImplicitlyImmediate`: a termination is
immediate iff it has no trigger and is not marked `delayed`); `processors/Termination.xtend:211-226`;
`processors/Abort.xtend:214-239` (control region prevents termination without `join to`).
**Teaching.** *`join to` = "as soon as everything inside is finished".* Adding a condition makes it wait a tick.
**Implementation.** Note the surprising consequence in P-44 (a suspend adds a condition).

#### P-26 Termination loops
**Rule.** A termination that re-enters its own superstate, whose inside finishes in the entry tick, is an
instantaneous loop: the netlist compiler rejects it. With a delayed inside it simply restarts every tick.
**Evidence.** #75 (rejected); *probe:* `M { I go to F; final F } join to M` gives entries 1, 2, 3 ….
**Source.** SCG scheduling (*Can't schedule …*, *The SCG is NOT asc-schedulable!*).
**Teaching.** *Something must take time.*
**Implementation.** Detect via the instantaneous-loop check. The priority compiler accepts it (§4).

#### P-27 Strong aborts must have the highest priorities
**Rule.** KIELER rejects any state, simple or not, in which a strong abort is written after a weak abort or a
termination.
**Evidence.** #27 (after weak), #28 (after termination), #29 (simple state).
**Source.** `text/validation/SCTXValidator.xtend:899-910`.
**Teaching.** *Write `abort to` transitions first.* The reason: a strong abort must be decided before the inner
behaviour runs, but a higher-priority weak abort or termination can only be decided after it.
**Implementation.** Validation error on the offending transition: `Causality problem!\nStrong abort transitions
must have a higher priority than weak abort or termination transitions.`

### C. Count delays

#### P-28 `if n T` counts the ticks in which T holds
**Rule.** A transition `if n T` (n ≥ 2) fires in the n-th tick in which T holds while its source state is active,
counted since the state was entered. The ticks need not be consecutive. For a delayed transition the entry tick
does not count; for an `immediate` one it does.
**Evidence.** #36 (fires in tick 5 after A in ticks 2, 4, 5); #37 (immediate: ticks 1-3).
**Source.** `processors/CountDelay.xtend:101-150`.
**Teaching.** *"The third time A happens (while I'm here)".*
**Implementation.** See P-36 for the exact formula.

#### P-29 The count restarts on every entry
**Rule.** Every entry of the source state restarts the count at 0, including re-entry by a self-loop and by any
other transition into it. A count can therefore never complete if another transition keeps re-entering the
state.
**Evidence.** #38 (count restarts after leaving and returning); #40 (self-loop with `if 2 A` fires every second
tick); *probe:* `if 2 A do … go to S` plus `if A go to S` never fires.
**Source.** `processors/CountDelay.xtend:121-124` (entry action `counter = 0`).
**Teaching.** *Leaving the state forgets the count.*
**Implementation.** Counter per count-delay transition, reset by the source state's entry.

#### P-30 Quirk: an immediate count delay can fire at once on re-entry
**Rule.** For `immediate if n T`, the transition can fire in the tick its source state is entered again if the
state was left with n−1 counted, **however long ago**: the counter keeps its value while the state is inactive
(P-36), and the reset on entry only shows in `pre(counter)` from the next tick. So the first `T` of the new visit
completes the old count.
**Evidence.** #39 tick 4 (left one tick before); #97 (left three ticks before: `Shut` is entered again in tick 6
and opens in that tick with one knock). Official KIELER agrees.
**Source.** `processors/CountDelay.xtend:136-149` (trigger becomes `pre(counter) == n-1 && T`).
**Teaching.** *Surprising, and almost certainly unintended. Avoid relying on it.*
**Implementation.** Falls out of P-36; must be reproduced.

#### P-31 Count delays on aborts of superstates
**Rule.** A count-delayed abort of a superstate counts the ticks in which its trigger holds while the superstate is
active (not the entry tick unless immediate); a count-delayed strong abort then fires before the inner behaviour.
**Evidence.** #41.
**Source.** As P-28, then `Abort`.
**Teaching.** As P-28.
**Implementation.** As P-36, with the counter's during action as an extra region of the superstate.

#### P-32 Count delays elsewhere
**Rule.** On `during`: ignored with a warning (P-13). On `suspend`: accepted and silently ignored. On `entry`/
`exit`: syntax error. A count of 0 is rejected; a count of 1 is the same as no count.
**Evidence.** #42, #51, #86, #43.
**Source.** `processors/CountDelay.xtend:102` (`<= 1` returns); `processors/Suspend.xtend:121-137` (ignores
`triggerDelay`); `text/validation/SCTXValidator.xtend:889-893`.
**Teaching.** *Counting is for transitions.*
**Implementation.** As stated.

#### P-33 Count delays and suspension
**Rule.** While the source state (or an ancestor) is suspended, ticks are not counted.
**Evidence.** #50.
**Source.** `Suspend` runs before `CountDelay`, so the count's trigger already contains the suspend flag.
**Teaching.** *Suspension freezes counting too.*
**Implementation.** As P-36 with the suspended guard in T.

#### P-34 Count delays and deferred entry
**Rule.** Entering the source state by a deferred transition does not change a delayed count delay; an immediate
count delay does not count the entry tick (counting is immediate behaviour).
**Evidence.** #84 (fires one tick later than after a normal entry); *probe:* delayed `if 2 B` fires at the same
tick with and without `deferred`.
**Source.** `processors/Deferred.xtend` (the counter reset is tagged `DoNotDefer`, `processors/CountDelay.xtend:124`).
**Teaching.** Rarely relevant.
**Implementation.** As P-36 with P-53.

#### P-35 Count delays and priority
**Rule.** Each count-delay transition has its own counter and takes part in priority like any transition: in each
tick the enabled transitions are tried in priority order, so the count that completes first wins (if two complete in
the same tick, the one written first); once the state is left or re-entered, all counts restart.
**Evidence.** *Probe:* S with `if 3 A do f1 += 1 go to S` and `if 2 A do f2 += 1 go to T` (A always): T is
entered in tick 3 (f2 = 1, f1 = 0).
**Teaching.** As P-29.
**Implementation.** None.

#### P-36 The exact count-delay formula (for implementers)
**Rule.** KIELER compiles `[immediate] if n T go to X` from state S into: a counter c declared in S's parent;
`entry do c = 0` on S; `[immediate] during if T do c = c + 1` on S (immediate iff the transition is); and the
transition trigger `pre(c) == n-1 && T`. `pre(c)` is the value of c at the end of the previous tick (0 before
tick 1).
**Evidence.** All of #36-#41, #50, #84, #94, #96, #97 follow from it; #39 and #97 show the `pre` effect.
**Source.** `processors/CountDelay.xtend:113-149`.
**Implementation.** Implement it literally. Note that the during action runs in the tick the transition fires
(weak semantics), and that the counter keeps its value when S is not active.

#### P-36a Count delays inside a state with a self-loop are rejected
**Rule.** A count delay (`if n T`, n ≥ 2, weak or strong, delayed or immediate) on any transition whose source
state lies inside a state P that has a self-loop (`if R abort to P` or `if R go to P`, the usual reset of ABRO-style
charts) is rejected: `Can't schedule from _gN to _gM` (several), `The SCG is NOT asc-schedulable!` (lab: also
`Circular dependency prevents scheduling this tick.`), warnings `Potential instantaneous loop.` (official
`Instantaneous loop detected!`). It does not matter whether the source is a superstate or a simple state, whether
the count's transition comes before or after a `join to`, or how deep below P the source is. The same chart
without the self-loop compiles and counts as P-28 says (#94: the `if 4 true` on `WaitAB` fires in tick 5), and so
does one in which P is left for another state and entered again later (#96).
**Evidence.** #93 (the guide's `patterns/abro/ab-then-c-starter` with `if 4 true do late go to Done` on
`WaitAB`), #95 (a simple state), #94, #96; *probes:* the count after the join, a strong count abort, a weak reset
`if R go to ABO`, a count with a signal trigger, a single region, no join, two levels deep: all rejected. Official
KIELER agrees on every one.
**Source.** The counter of P-36 is a local of the source's parent and `pre(c)` adds a register written by an
immediate during action of the state declaring c (`processors/Pre.xtend:140-191`); when P is left and entered in the
same tick, the netlist schedule finds a cycle through c's re-initialisation, its increment and its register. The
same shape written by hand is rejected too (*probe:* a local `k` of P, `entry do k = 0` and `during do k++` on
the inner state, `if pre(k) >= 3` on its transition), while it compiles when `k` is declared outside P, written by a
transition instead of a during action, or tested without `pre` (*probes*).
**Teaching.** *Count delays and a reset self-loop around them do not mix in KIELER.* Count with an explicit
variable (`int n`, `n++`, `if n >= 4`), or leave the reset loop out of the state that holds the count.
**Implementation.** Falls out of the cycle analysis if count delays and `pre` are expanded as KIELER does (the
engine agrees on all the charts above). The engine gives the cycle its own code and message, `count-delay-reset`
("KIELER cannot compile the count delay `if 3 knock` on `Shut`'s transition to `Open`: `Door`, around it, has the
self-loop `if restart abort to Door`"), whenever the cycle runs through a count delay's counter and a state around
the count delay's source has a transition to itself (compile.ts `countDelayResetLoop`; probes
`tests/engine/kieler/preemption/probe-count-reset-*`: a weak reset, two levels deep, a count-delayed strong abort, a
signal trigger in one of two regions).

### D. Suspension

#### P-37 `suspend if c` freezes the whole state
**Rule.** In a tick in which a suspend trigger c of state S holds (not checked in S's entry tick unless
`immediate`), nothing of S runs: no inner transitions, no during actions (S's or inner states'), no entry or exit
actions of inner states, no counting. The inner states are kept and resume in the next unsuspended tick.
**Evidence.** #44 ticks 3-5.
**Source.** `processors/Suspend.xtend:93-140`: a flag `_enabled` (set true by an immediate during action, and
`&= !c` by a delayed or immediate during action per suspend), conjoined into the trigger of every action and
transition contained in S (`state.allContainedActions`, line 108).
**Teaching.** *`suspend` = pause button: the inside freezes in place.*
**Implementation.** See P-38 and P-42 … P-44 for the consequences of KIELER's flag; a correct direct interpreter must
reproduce them.

#### P-38 Suspension also freezes the state's own outgoing transitions
**Rule.** While S is suspended, S's own outgoing transitions cannot fire either (they are among the actions
`allContainedActions` guards). Transitions of S's ancestors are not affected.
**Evidence.** #45 tick 3 (G holds, M not left), tick 4 (left after resuming); #79 (an ancestor's abort still
fires).
**Source.** `processors/Suspend.xtend:108-111`.
**Teaching.** *A suspended state cannot be left by its own transitions; put the escape on an enclosing state.*
In Esterel terms, the outgoing transitions sit inside the `suspend`.
**Implementation.** Guard S's outgoing transitions with "not suspended".

#### P-38a A state with its own `suspend` cannot have a strong abort
**Rule.** KIELER rejects a chart in which a state S with a (non-weak) `suspend` has an outgoing `abort to`, delayed
or `immediate`, alone or next to weak aborts: the netlist scheduler finds a cycle. Weak aborts (`go to`) and
terminations out of S compile (P-38 freezes them while S is suspended); so does a strong abort on an *enclosing*
state, and a strong abort out of a state with a `weak suspend`.
**Errors.** `Can't schedule from … to …` (several), `The SCG is NOT asc-schedulable!` (lab server adds `Circular
dependency prevents scheduling this tick.`), warning `Instantaneous loop detected!` (lab: `Potential
instantaneous loop.`); priority compiler: `The SCG is not IASC-schedulable!`. No editor diagnostic.
**Evidence.** #90 (rejected); *probes*: a simple-bodied S, `immediate if A abort to X`, and the strong abort
followed by a weak one are rejected the same way, by official KIELER as well; `if A go to X` out of S compiles
(the weak abort fires once S is no longer suspended); #79 and *probe* (strong abort on an enclosing state:
fires, also while S is suspended); #92 (weak suspend + strong abort: compiles, the abort fires in a weakly
suspended tick).
**Source.** `processors/Suspend.xtend:108-111` conjoins the flag `_enabled` into the trigger of S's own outgoing
transitions; `_enabled` is written by S's during actions (`:113-138`), which are inner behaviour of S, whereas a
strong abort is the highest-priority transition of every inner state (`processors/Abort.xtend:299-317`) and so
must read its trigger, `_enabled` included, before that inner behaviour runs (P-19). `WeakSuspend` guards
nothing on S itself (P-46), so it creates no such cycle.
**Teaching.** *To stop a suspendable state for good, use `go to`, or put the `abort to` on a state around it.*
**Implementation.** Reject with a causality error; the general cycle check finds it once suspend is expanded as
in §5.

#### P-39 `immediate suspend`
**Rule.** `immediate suspend if c` is also checked in S's entry tick. If c holds then, S's entry actions and the
entry actions of its inner initial states are skipped for good; immediate inner transitions and immediate during
actions wait until S resumes.
**Evidence.** #46 (all 0 while suspended; after resuming, chained = 1 and during actions run; entry1 = innerEntry
= 0 for ever).
**Source.** `processors/Suspend.xtend:128-137` (the during action is immediate).
**Teaching.** *Immediate suspension can swallow entry actions.*
**Implementation.** As P-37 with the immediate check.

#### P-40 `pre` is not frozen
**Rule.** `pre(x)` inside a suspended state is the value of x in the previous tick, whether or not that tick was
suspended.
**Evidence.** #49 tick 5 (pre(X) = 4, the value from a suspended tick).
**Source.** `Pre` runs after `Suspend` and records registers in a root-level region every tick.
**Teaching.** *Suspension stops behaviour, not time.*
**Implementation.** `pre` is global.

#### P-41 Several suspends
**Rule.** A state with several suspend actions is suspended in a tick if any of them holds.
**Evidence.** *Probe:* `suspend if S` and `suspend if T`: suspended in the ticks with S and with T.
**Source.** `processors/Suspend.xtend:136` (`_enabled &= !c` per suspend).
**Teaching.** *Any trigger pauses it.*
**Implementation.** Disjunction.

#### P-42 Quirk: a state with `suspend` skips its own entry actions on its first entry
**Rule.** The entry actions of a state that has a `suspend` (of any trigger, even `if false`) do not run on the
first entry of that state; on later entries they run if the state was not suspended in the tick it was last
left. The same holds for the root state: a chart-level `suspend` means the chart's own entry actions never run.
Only the state's **own** entry actions are affected: the entry actions of its inner initial states, at any depth,
run in the entry tick as usual (unless an `immediate suspend` holds then, P-39).
**Evidence.** #47 (tick 1: entries 0; tick 4: entries 1); #80 (root entry never runs); #91 (tick 1: outer = 0
but inner = deeper = 1; tick 3, after re-entry: all three run).
**Source.** `processors/Suspend.xtend:108-118`: the entry action is guarded by `_enabled`, which is only set to
true by the during action that runs *after* the entry actions (strong entry wraps everything, §0). `_enabled` has
no initial value and starts as false in the generated code. The inner states' entry actions are guarded by
`_enabled` too, but they run inside S's fork, concurrently with the immediate during action `_enabled = true`, and
the SC schedule puts that absolute write before their reads (initialise before read), so they see `true`.
**Teaching.** *Put set-up code for a suspendable state in the transition that enters it, or in an inner state.*
**Implementation.** Model `_enabled` as a variable of S, initially false, keeping its value while S is inactive.

#### P-43 Quirk: a suspended state's exit actions are skipped when an ancestor removes it
**Rule.** If an ancestor of S is left while S is suspended, S's exit actions do not run.
**Evidence.** #79 tick 3 (exits = 0).
**Source.** Same guard as P-42.
**Teaching.** Rare; worth one sentence.
**Implementation.** As P-42.

#### P-44 Quirk: a suspend delays an immediate termination by one tick
**Rule.** A superstate with a `suspend` whose inner regions finish in its entry tick terminates one tick later than
without the suspend: the suspend guard makes its termination conditional, and conditional terminations are
delayed (P-25).
**Evidence.** #48 (done = 1 in tick 2; without the `suspend` line, in tick 1: *probe*).
**Source.** `processors/Suspend.xtend:108-111` adds `_enabled` as the termination's trigger;
`extensions/SCChartsTransitionExtensions.xtend:132-135`.
**Teaching.** *Adding a suspend can change termination timing.*
**Implementation.** Reproduce: treat terminations of states with suspends as delayed.

#### P-45 A suspend needs a trigger
**Rule.** `suspend` without `if` is rejected. (Official KIELER fails with an internal error in code generation;
the SCCharts Lab server reports *This suspend has no trigger. KIELER cannot compile a suspend without an if
condition.*) The same holds for `weak suspend` without `if` (*This weak suspend has no trigger. …*, probe).
**Evidence.** #52.
**Source.** `processors/Suspend.xtend:123-127` (lab tracing only); message from
`kicool/.../codegen/AbstractCodeGenerator.xtend:139`.
**Implementation.** Reject with that message.

#### P-46 Weak suspend: the tick runs, the state is not kept
**Rule.** In a tick in which `weak suspend if c` holds (not checked in the entry tick unless `immediate`), the inner
behaviour of the tick runs normally (transitions fire, entry and during actions run, data changes persist), but at
the end of the tick each inner region is put back into the state it was last in at the end of a tick without weak
suspension; the states entered meanwhile are forgotten, and the return does not run entry actions or immediate
behaviour (it is a deferred re-entry). The state's own outgoing transitions are not blocked. Exit actions of inner
states are rewritten by `WeakSuspend` into extra states (`processors/WeakSuspend.xtend:146-166`); not tested. The
wiki flags weak suspend as not fully supported.
**Evidence.** #53 (tick 3: I → J runs, entersJ = 1, but the region is back in I; tick 6: I → J again); #54 (during
actions and self-loops keep running); #55 (own transition fires); #56 (immediate weak suspend in the entry tick:
the immediate transition runs, the region stays in I); wiki example (*probe*) behaves accordingly.
**Source.** `processors/WeakSuspend.xtend:93-213`: per region a bookmark set by entry actions only when the flag is
off, a `_WS` state reached by a lowest-priority immediate transition when the flag is on, and deferred re-entry of
the bookmarked state.
**Teaching.** *Weak suspend lets the outputs of the tick happen but rewinds the control state.* Rarely what you want;
mention as advanced.
**Implementation.** Easiest via the expansion. Directly: snapshot each inner region's active state at the start of
the first weakly suspended tick (bookmarks are updated by entries in unsuspended ticks only), run the tick, then
restore without running entry actions or immediate behaviour (deferred re-entry, P-53).

### E. History

#### P-47 `history` (deep) resumes all levels
**Rule.** `go to S history` enters S in the states that were active in all of S's regions, at every depth, when S
was last left (on S's first entry: the initial states). The resumed states are *entered* again: their entry actions
run and their immediate transitions are checked; local variables of S and of the resumed states are initialised
again.
**Evidence.** #57 (J resumed, entry runs); #60 (J/Y resumed); #61 (entries = 2, local n restarts from 0).
**Source.** `processors/History.xtend:91-160`: an int per region records the last entered state (set by entry
actions), a new initial dispatcher `_HInit` with immediate transitions `if _H == k go to S_k`; non-history
transitions into S reset the record.
**Teaching.** *History restores where you were, not what your variables held.*
**Implementation.** The record is updated on *entry*, so a state entered in a weak abort tick is the one resumed
(#83). A state entered with `deferred` is **not** recorded: its entry actions, the record's among them, are removed
(P-53), so `go to S history` resumes the state recorded before it (probe
`tests/engine/kieler/preemption/history-skips-deferred-entry`: `J` entered deferred in tick 2, history resumes `I`
in tick 5; the guide's `advanced/history/history-deferred`).

#### P-48 `shallow history`
**Rule.** `go to S shallow history` resumes only S's own regions; superstates inside them start from their initial
states.
**Evidence.** #59.
**Source.** `processors/History.xtend:150-158` (nested records reset on shallow history transitions).
**Teaching.** *Shallow = one level.*
**Implementation.** As stated.

#### P-49 Default: no history (`reset`)
**Rule.** Without a history keyword (which may be written explicitly as `reset`) S starts from its initial
states.
**Evidence.** #58; *probe:* `go to M reset` parses and behaves the same.
**Source.** Metamodel default `HistoryType.RESET` (`impl/TransitionImpl.java:88`).

#### P-50 History remembers the state entered in the abort tick
**Rule.** Because the record is updated on entry, a state entered during the last-wish behaviour of a weak abort
is the one that history resumes.
**Evidence.** #83.
**Source.** As P-47.

#### P-51 Quirk: history only works at the top level
**Rule.** KIELER processes history transitions only into states of the chart's top-level regions, and, recursively,
inside states that are themselves targets of a history transition (shallow or deep). Any other history transition
is silently treated as a normal transition (restart). No warning.
**Evidence.** #62 (nested `history` ignored); #85 (same chart, works once the enclosing state is a history target);
*probe:* top-level history with several named root regions works.
**Source.** `processors/History.xtend:81-88` (only `rootState.regions…states`), `:146-148` (recursion only from
history-transformed states).
**Teaching.** *Keep history transitions at the top level of a chart* (or make the enclosing state a history target
too). A real gotcha for nested mode switches.
**Implementation.** Reproduce: decide which history transitions are effective by this static rule.

#### P-52 History warnings
**Rule.** Charts with history compile with warnings of the form *ValuedObject with name _HM is contained in the model
but not in VariableStore.*, one for every state whose history KIELER keeps, named `_H<state>`: the target of a
shallow `history` transition; with (deep) `history` the target **and every superstate inside it** (#98: `_HOuter`,
`_HMid`, `_HInner` for a three-level target; #60: `_HM`, `_HJ`). They are harmless.
**Evidence.** #57, #59-#61, #83, #85, #98 (`warnings` in the recordings).
**Implementation.** The guide should mention that this warning is expected; the simulator need not emit it.

### F. Deferred transitions

#### P-53 `deferred`: no immediate behaviour in the entry tick
**Rule.** When S is entered by `go to S deferred`, none of S's immediate behaviour happens in that tick: its entry
actions do not run (and never will for this visit), its immediate during actions and immediate outgoing transitions
do not run. From the next tick on S behaves as if it had been entered normally one tick earlier: delayed during
actions and delayed transitions can already run, and immediate ones run too.
**Evidence.** #63 (tick 3: both durings and the immediate transition; entry never); #64 (tick 3; normal entry in
tick 5 runs everything at once); *probe:* a delayed `during` counts from the tick after the deferred entry.
**Source.** `processors/Deferred.xtend:86-115` (strategy choice), `:518-608` (simple delay: an intermediate state
`_deferred_entry` with a delayed transition into S, S's delayed transitions and during actions made immediate,
entry actions removed), `:361-475` (simple guard: a flag that disables entry actions, immediate during actions and
immediate transitions in the entry tick).
**Teaching.** *`deferred` = "arrive quietly": skip the arrival behaviour this tick.* Typical use: return to a state
without immediately re-triggering its immediate transitions.
**Implementation.** See P-54: the strategy matters for superstates.

#### P-54 Quirk: deferred entry into a superstate depends on its other incoming transitions
**Rule.** For a superstate S entered by a shallow `deferred` transition:
(a) if **all** transitions into S are deferred, of the same kind, and S cannot come back to itself through one of
its outgoing transitions followed only by immediate transitions, KIELER really enters S one tick later: in the
deferred tick nothing of S happens; in the next tick S's inner initial states are entered (their entry actions run)
and the inner behaviour starts, so inner delayed transitions fire one tick later than after a normal entry; S's own
entry actions never run;
(b) otherwise S is entered in the deferred tick: only S's own immediate behaviour is suppressed (its entry
actions never run), the inner initial states' entry actions do run and inner timing is normal.
**Evidence.** #65 (case a: innerEntry in tick 3, step1 in tick 4); #66 (case b: innerEntry in tick 2, step1 in
tick 3).
**Source.** `processors/Deferred.xtend:94-99` (`isSimpleDelayTransformable`, `:494-516`; otherwise
`isSimpleGuardTransformable`, `:335-356`, which fails if a deferred incoming transition lies on an immediate loop;
otherwise `transformComplex`, a copy of the state, `:139-243`, untested).
**Teaching.** *Deferred entry into a superstate can shift its inner timing by a tick.* State it plainly; the wiki
calls deferred "not fully supported".
**Implementation.** Decide the strategy statically per target state exactly as KIELER does.

#### P-55 `deep deferred`
**Rule.** `deep deferred` also suppresses the immediate behaviour of the inner initial states, recursively: their
entry actions never run for this visit and their immediate transitions wait a tick.
**Evidence.** #67 (both entry actions 0, the inner immediate transition fires in tick 3).
**Source.** `processors/Deferred.xtend:520-533` (`handleBehavior` includes initial states recursively).
**Teaching.** *Deep = all the way down.*
**Implementation.** As P-54 with the inner initial states included.

#### P-56 Deferred into an initial state
**Rule.** The initial entry in tick 1 is normal (entry actions run); later deferred entries are quiet.
**Evidence.** *Probe:* initial B with `immediate if G … go to C`, C `go to B deferred`, G always: the immediate
transition fires in ticks 1, 3, 5 and B's entry action only in tick 1.
**Source.** `processors/Deferred.xtend:545-560` (`_deferred_initial` flag).

### G. Connectors

#### P-57 Connector states are transient
**Rule.** A `connector state` is passed through within the tick: its outgoing transitions are immediate whether or
not they are written with `immediate` (KIELER warns *Outgoing transitions of connector states should be marked as
immediate.*), they are tried in priority order, and their effects see the effects of the transition that led into
the connector. A connector may be initial and may have entry actions (they run when passing through).
**Evidence.** #68 (S → C → X in one tick, second = first + 1); #69 (no `immediate`, still the same tick); *probes:*
initial connector; connector with `entry do x = 1` then `immediate do y = x + 1` (y = 2).
**Source.** `processors/Connector.xtend:62-77` (connectors become normal states with immediate transitions);
`extensions/SCChartsTransitionExtensions.xtend:133`; warning `text/validation/SCTXValidator.xtend:733-752`.
**Teaching.** *A connector is a junction, not a place to wait.*
**Implementation.** Treat a connector as a state all of whose outgoing transitions are immediate.

#### P-58 Without a default, control can rest in a connector
**Rule.** If no outgoing transition of a connector is enabled, control stays in it like in a normal state (KIELER
warns *Connector states should have an outgoing transition without trigger.*); its (immediate) transitions are
checked again in the next ticks.
**Evidence.** #70 (tick 2 rests in C, tick 3 leaves).
**Source.** As P-57.
**Teaching.** *Always give a connector an untriggered last transition.*
**Implementation.** No special case needed once P-57 is implemented.

#### P-59 Rejected connectors
**Rule.** A connector with no outgoing transition is rejected (*Connector states must have an outgoing
transition.*). A cycle of connectors is an instantaneous loop and is rejected by the netlist compiler.
**Evidence.** #71; #72 (*There is an immediate loop. The model is not SASC. Involved states: [C2, C1]* warning, then
*Can't schedule …*, *The SCG is NOT asc-schedulable!*).
**Source.** `text/validation/SCTXValidator.xtend:733-752`, `:503-530`.

### H. Delay keywords

#### P-60 `auto` and `undefined` mean "default"
**Rule.** The delay keywords `auto` and `undefined` parse; KIELER treats both like no keyword: delayed, except that
transitions out of connectors are always immediate and a termination without trigger is immediate unless marked
`delayed`.
**Evidence.** #73.
**Source.** Grammar `enum DelayType` (`text/SCTX.xtext`); `extensions/SCChartsTransitionExtensions.xtend:132-135`;
`extensions/SCChartsActionExtensions.xtend:61-65` (only `IMMEDIATE` counts as immediate). Nothing else reads
`AUTOMATIC`.
**Teaching.** *Ignore `auto`; it is a leftover.* (The wiki's first example uses it.)
**Implementation.** Map `auto` and `undefined` to "not specified".

### I. Final regions, abort regions

#### P-61 `final region`
**Rule.** A region marked `final` never blocks its parent's termination: KIELER marks all of its states final. When
the other regions finish, the parent terminates in that tick after the final region has reacted once more. The
validator does not know this and still warns *Every region should have a final state whenever its parent state has
a termination transition.* and *All or none concurrent regions should have final states.*
**Evidence.** #76 (background = 2 at termination in tick 3).
**Source.** `processors/FinalRegion.xtend:52-66` (both netlist and priority systems set
`finalRegion.supported = false`, so this rewriting always applies).
**Teaching.** *A `final region` is "background work that may be cut off".*
**Implementation.** Treat every state of a final region as final.

#### P-62 `abort region` (netlist only)
**Rule.** A region marked `abort` terminates its parent as soon as it reaches a final state. More precisely,
KIELER's SCGAbortRegionProcessor turns the state's regions into a **sequential preemptive fork**: the leading abort
regions, then the other regions (several of them nested together as one thread), then the trailing abort regions
run one after the other in that order, and the join becomes "any region finished" (par-or: a regular region that
finishes ends the state too, #105 tick 5). In detail:
- **Data flows forwards only.** The regions are not concurrent: a region reads what the regions before it wrote in
  the tick, never what later ones write, and there is no causality check between them (#104: `Lead` reads `x` and
  `S` before `Main` writes them, `Trail` after; no cycle).
- **Depth guard, off by one.** In the tick an abort region finishes, the threads after it do not react, **except
  the one directly after it**: KIELER's depth guard skips only the threads two or more places later. So a single
  leading abort region still lets the other region react in its finishing tick (a "weak" effect, as for a trailing
  one, #77), and with two leading abort regions the first one stops the content at once while the second does not
  (#99: `work` stays 1 when `W1` finishes, goes to 3 when `W2` does).
- **Entry guard.** In the tick the state is entered, an abort region that finishes at once keeps every thread
  after it from starting, the next one included (#100: in `M` the content's entry action does not run; with the
  abort region last, in `N`, it does).
- **Order constraints** (rejected): abort regions must be the first or the last regions (*Illegal order of abort and
  non-abort regions. Abort regions are only allowed as first or last regions and cannot be mixed with regular
  regions.*), there must be at least one other region (*Found abort regions but there are no regions to abort.*),
  and a state with a **trailing** abort region may not have abort transitions of its own (the control region the
  Abort transformation appends then sits after the abort region: the order error). With **leading** abort regions
  an outgoing weak abort is accepted, and when an abort region finishes, the state terminates and takes that
  transition without checking its trigger, because the Abort transformation made it the termination (#103, tick 3).
- **The order is checked on the compiled graph only**, which has no nodes for states that cannot be reached: an
  illegal order inside an unreachable state is not reported (#101).
- **Re-entry in the finishing tick.** A state whose own transition re-enters it in the tick it finishes is an
  instantaneous loop of the sequential fork if a region can finish in its entry tick: rejected, lab *A sequential
  region is re-entered in the tick it is left.*, official *Sequential forks must not be schizophrenic!* (#102).
  Otherwise KIELER compiles it with its thread reincarnation guards and the state restarts correctly (#105:
  `entries` 1, 2, 3). The guide's simulator does not run this shape (it reports it as unsupported).
- **A state with abort regions that is never entered crashes the compiler** when its fork has a second thread
  (another region, or the region the Abort transformation adds for the state's own weak abort): entered only by
  a join from a region that never finishes, it has no live code, and SimpleGuardTransformation throws
  `java.lang.NullPointerException: Cannot invoke "…Linkable.getOutgoingLinks()"` (probes
  `tests/engine/kieler/preemption/probe-abort-region-dead-crash`, `-content`). Once the state can be entered, the
  chart compiles (`-alive`).
- The priority-based compiler rejects abort regions (*Support for abort regions is not enabled in this compilation
  chain!*).
- **Official KIELER 0.3.0 differs:** it rejects #103 and #104 (`Can't schedule …`, `The SCG is NOT
  asc-schedulable!`), and in #99 the chart stops reacting for good once `W1` finishes (`done` stays 0); #77, #100,
  #101, #102 and #105 agree.
**Evidence.** #77, #78 (priority), #99-#105; *probes:* abort region alone (rejected), in the middle (rejected), with an
outgoing `if A go to Done` after a trailing one (rejected with the order error), and the engine's probes in
`tests/engine/kieler/preemption/abort-region-*` (content that finishes, two content regions, a `during` action,
the top level).
**Source.** `processors/scg/SCGAbortRegionProcessor.xtend:66-160` (the sequential preemptive fork, the par-or join);
`scg/.../processors/SimpleGuardExpressions.xtend:381-385` (the depth guard of a thread looks at
`entries.take(entries.indexOf(ownEntryInFork) - 1)`: the threads before it except the one just before it);
`processors/AbortRegion.xtend:62-79`; `scg/.../processors/analyzer/LoopAnalyzerV2.xtend:125` (the
schizophrenic fork; the lab's wording).
**Teaching.** *Experimental; the guide should mention it at most in a footnote,* and say that the two KIELER versions
disagree.
**Implementation.** As above (the engine follows KIELER's processor, including both guards; re-entry in the finishing
tick is `unsupported`).

#### P-63 Final states and termination
**Rule.** Reaching a final state in every region terminates the superstate in that tick (P-25) only if it has a
termination transition; a final state left again by its own outgoing transition no longer counts (P-10).
**Evidence.** #13, #16, #24, #25, #74; P-10 probe.

#### P-64 Validator warnings about final states (for the guide)
**Rule.** A state with `join to` whose regions lack final states gets *Every region should have a final state
whenever its parent state has a termination transition.* (only if the state has no actions); regions with final
states next to regions without get *All or none concurrent regions should have final states.*
**Source.** `text/validation/SCTXValidator.xtend:834-882`.

#### P-65 What the transformation chain implies for combinations
**Rule.** Combinations behave as the composition of the expansions in the order of §0. Verified combinations:
suspend + count delay (#50), suspend + pre (#49), suspend + termination (#48), suspend + outer abort (#79), history
+ weak abort last wish (#83), deferred + count delay (#84), count delay + strong abort (#41), deep deferred +
history (#89: the resumption happens one tick late, the resumed inner state's entry action runs, the superstate's
own entry action does not). The wiki warns that history and deferred "may result in unexpected behavior when
combined"; #89 records what KIELER does.

---

## 3. Rejections and warnings in this area

Errors (chart rejected; the guide's error page should use these exact texts):

| Situation | Message | Chart |
|---|---|---|
| strong abort after a weak abort or termination (any state) | `Causality problem!` + newline + `Strong abort transitions must have a higher priority than weak abort or termination transitions.` | #27, #28, #29 |
| count delay 0 | `A count delay of 0 is not allowed on a trigger.` | #43 |
| count delay on `entry`/`exit` | parse error `no viable alternative at input 'A'` | #86 |
| connector without outgoing transition | `Connector states must have an outgoing transition.` | #71 |
| strong abort whose trigger the inner behaviour writes, in the mixed case of P-19 | `Circular dependency involving flag, inner prevents scheduling this tick.`, `The SCG is NOT asc-schedulable!` (netlist); `The SCG is not IASC-schedulable!` (priority) | #87 |
| cycle of connectors, termination loop | warning `There is an immediate loop. The model is not SASC. Involved states: [...]` (connectors) + errors `Can't schedule from _gN to _gN`, `The SCG is NOT asc-schedulable!`, `Circular dependency prevents scheduling this tick.` | #72, #75 |
| `suspend` without trigger | official KIELER: internal error; lab: `This suspend has no trigger. KIELER cannot compile a suspend without an if condition.` | #52 |
| `weak suspend` without trigger | official KIELER: internal error in the SCG transformation; lab: `This weak suspend has no trigger. KIELER cannot compile a weak suspend without an if condition.` | probe |
| `abort to` out of a state with its own `suspend` (P-38a) | `Can't schedule from _gN to _gM` (several), `The SCG is NOT asc-schedulable!` (+ lab: `Circular dependency prevents scheduling this tick.`), warning `Instantaneous loop detected!` (lab: `Potential instantaneous loop.`); priority: `The SCG is not IASC-schedulable!` | #90 |
| abort region, priority compiler | `Support for abort regions is not enabled in this compilation chain!` | #78 |
| abort region in the middle, or a trailing one with abort transitions on the state | `Illegal order of abort and non-abort regions. Abort regions are only allowed as first or last regions and cannot be mixed with regular regions.` | probe |
| only abort regions | `Found abort regions but there are no regions to abort.` | probe |
| state with abort regions re-entered in its finishing tick, a region finishing at once | lab `A sequential region is re-entered in the tick it is left.`; official `Sequential forks must not be schizophrenic!` | #102 |
| count delay inside a state with a self-loop (P-36a) | `Can't schedule from _gN to _gM`, `The SCG is NOT asc-schedulable!` (+ lab: `Circular dependency prevents scheduling this tick.`) | #93, #95 |

Warnings (chart compiles):

| Situation | Message | Chart |
|---|---|---|
| abort without trigger on a superstate | `Abort transitions should have a trigger.` | #30 |
| count delay on `during` | `Count Delays on During Actions are not supported yet. The valued will be ignored by the transformation.` (sic) | #42 |
| connector transition without `immediate` | `Outgoing transitions of connector states should be marked as immediate.` | #69 |
| connector without untriggered transition | `Connector states should have an outgoing transition without trigger.` | #70 |
| history | `ValuedObject with name _HM is contained in the model but not in VariableStore.` (compile result, not editor), one per remembered state (P-52) | #57, #98 |
| final region / abort region | `Every region should have a final state whenever its parent state has a termination transition.`, `All or none concurrent regions should have final states.` | #76, #77 |
| count-delay self-loop (netlist) | `Potential instantaneous loop.` (harmless) | #40 |

Accepted silently although it does nothing: count delay on `suspend` (#51), nested `history` (#62), `auto`/`undefined`
(#73).

---

## 4. Netlist vs priority-based compilation

All charts up to #89 give identical results with `--system priority` (values per tick, or the same rejection),
and so do #90 and #92 (*probe*), except:

1. **#11** (superstate with during actions on itself *and* on an inner state): after a strong abort and re-entry, the
   priority compiler stops running both during actions for good (tick 7: 2/2 instead of 3/3). Netlist is correct.
2. **Suspend + during + own outgoing transition** (*probe*): `M { suspend if S; during do d += 1; initial state I … }
   if G go to Done`: with the priority compiler M is never left, even with S false. Without the during action both
   agree (#45).
3. **#72, #75** (instantaneous loops): the priority compiler accepts them and produces wrong values (#75: the entry
   action never shows). Netlist rejects. (#87 is rejected by both, with different messages.)
4. **#77, #78**: abort regions are netlist-only.
5. **#91** (suspend `if false`, entry actions on the state and on two levels of inner initial states, `if G go to
   N`): with the priority compiler M is never left (`taken` stays 0 in ticks 2-3), so `outer` stays 0 *(probe)*.
   Like item 2, a suspended state's own outgoing transition is lost; #47, without the inner entry actions,
   agrees.

The simulator should follow the netlist results (as the conformance suite does).

---

## 5. Notes for the simulator

**Recommended approach.** The quirks in P-20, P-23, P-30, P-38, P-42 … P-44, P-46, P-51 and P-54 are artefacts of
KIELER's expansions, not of any clean semantics. The most reliable way to match KIELER is to implement the same expansions
(in the order of §0) as AST-to-AST rewrites into a core chart and simulate only core constructs (simple and
hierarchical states, regions, delayed/immediate weak transitions, terminations, connectors-as-immediate), with SC
scheduling. The per-construct expansions below were dumped from KIELER itself.

The harness used to produce them (`Dump.java`, compiles a chart with any KiCo system and serialises the model after
any processor) is in this session's scratchpad: `…/scratchpad/pre/harness/Dump.java` with `…/scratchpad/pre/dump.sh`
(`dump.sh chart.sctx de.cau.cs.kieler.sccharts.extended last|all|<processor-id-substring>`). It needs only the JDK on
/mnt and the server jar. The coordinator may want it under `tools/oracle/`.

**Direct interpretation, if you don't expand.** For a superstate M with regions R1…Rk and outgoing transitions
T1…Tn (priority order) in a tick in which M is active:

1. Each Ti is *enabled* if it is immediate or M was entered before this tick.
2. Each region Rj (and each during action of M, as its own region) starts its reaction by evaluating the
   disjunction of the enabled strong aborts' triggers (inside the SC schedule, so after concurrent writes, P-20;
   in the mixed case of P-19 the delayed strong triggers are evaluated by the control thread of step 3 and read
   here as flags). If true, Rj is aborted: the exit actions of its active states run innermost first (each as a
   strong abort of that state, so nothing else inside runs), and Rj is finished.
3. Otherwise Rj reacts normally. Whenever Rj would come to rest in a non-final state Y, it checks the enabled weak
   aborts: immediate weak aborts by evaluating their triggers there (in Rj's thread), delayed weak aborts via a flag
   that a concurrent "control" thread sets when their trigger holds (P-19). If one holds, Rj leaves Y (exits) and is
   finished. A region in a final state is finished.
4. When every region is finished and M has a reason to end (an abort fired, or all regions are in final states and M
   has a termination), M is left: M's exit actions run; then the transition is chosen as in P-23 (memorised for
   delayed weak aborts, and for delayed strong aborts when M also has an immediate outgoing transition; re-evaluated
   for other aborts; Tn as the unconditional fallback); its effects run; its target is entered.
5. A superstate whose regions are all in final states but which has no termination waits (P-25).

Add the action rules (P-1 … P-12), count delays as in P-36, suspension as a flag exactly as P-37 … P-44, weak
suspend as P-46, history as P-47 … P-51 and deferred as P-53 … P-56. The conformance suite exercises all of these.

**Reference expansions** (KIELER's `de.cau.cs.kieler.sccharts.extended` output, abridged; the serialiser drops the
`connector` keyword, restored here by hand, and some annotations).

Superstate with a strong, a weak abort and a termination (`if S abort to X`, `if W go to Y`, `join to Z`; inner
`I →A F`):

```
state M {
  region __EA_Entry {
    state __EA_Main {
      region {
        initial state I
        if _Atrig go to F1                         // strong: highest priority, delayed; read through a flag
                                                   //   because this is the mixed case of P-19
        if A do _Tterm = true go to F1             // the original inner transition
        immediate if _Atrig1 || _Tterm go to F1    // weak abort + termination: lowest priority, immediate
        final state F1
      }
      region _ACtrl {
        initial state _ARun
        if S do _Atrig = true go to _ADone
        if W do _Atrig1 = true go to _ADone
        if _Tterm go to _ADone
        final state _ADone
      }
    }
    join to __EA_Done
    initial state __EA_Init                        // entry actions (generated resets) before everything
    immediate do _Tterm = false go to __EA_C
    state __EA_C
    immediate do _Atrig = false go to __EA_C1
    state __EA_C1
    immediate do _Atrig1 = false go to __EA_Main
    final state __EA_Done
  }
}
join to _AC
connector state _AC
immediate if _Atrig go to X
immediate if _Atrig1 go to Y
immediate go to Z                                  // last transition: no trigger (P-23)
```

Immediate aborts only (`immediate if S abort to X`, `immediate if W go to Y`; trigger re-read in the connector):

```
initial state M {
  initial state I
  immediate if S go to _Aaborted     // strong first
  immediate if W go to _Aaborted     // weak last
  final state _Aaborted
}
join to _AC
connector state _AC
immediate if S go to X
immediate go to Y
```

Simple state with entry, during, exit and two transitions (`if G go to B`, `if H abort to C`): the during action is a
region, so the state is a superstate; exit actions sit on the termination of `_Main`:

```
state A {
  region _Entry {
    state _Main {
      region _During {
        initial state _I
        if H go to _Aaborted              // strong abort skips the during action
        do x = 2 go to _I                 // during
        immediate if _Atrig go to _Aaborted
        final state _Aaborted
      }
      region _ACtrl {
        initial state _ARun
        if G do _Atrig = true go to _ADone
        if H go to _ADone
        final state _ADone
      }
    }
    immediate do x = 3 join to _Done      // exit action
    final state _Done
    initial state __EA_Init1
    immediate do x = 1 go to __EA_C       // entry action
    state __EA_C
    immediate do _Atrig = false go to _Main
  }
}
join to _AC
connector state _AC
immediate if _Atrig go to B
immediate go to C
```

Count delay `if 3 A go to T` from S: counter in the parent, `entry do _cdcounter = 0` on S, `during if A do
_cdcounter = _cdcounter + 1` on S, trigger `_pre__cdcounter == 2 && A` (`pre` is implemented with registers updated
by an immediate during action of the root).

History (`if R go to M history`): `int _HM` (initially 0); every inner state of M gets `entry do _HM = k`; M's region
gets a new initial state `_HInit` with `immediate if _HM == 0 go to I`, `immediate if _HM == 1 go to J`, …; the
`history` flag is then removed. Non-history transitions into M get `_HM = 0` as an extra effect.

Suspend (`suspend if S` on M): `bool _enabled` in M; `immediate during do _enabled = true`; `during do _enabled &=
!S`; every transition and action inside M and on M (including M's entry, exit and outgoing transitions) gets
`&& _enabled` in its trigger.

Deferred, simple-delay strategy (all incoming transitions of B deferred): `A → _deferred_entry` (instead of B),
`_deferred_entry` with a delayed transition to B; B's delayed transitions and delayed during actions become immediate;
B's entry actions are removed (if B is also initial, they are guarded by a flag that is true only in tick 1).

---

## 6. Where the KIELER wiki (Syntax.md) is wrong or incomplete

- *"Exit actions are considered inner behavior and are consequently suppressed if the state is strongly aborted."*
  Wrong: plain exit actions run on strong aborts (#02, #20). Only `weak exit` is suppressed, and by weak aborts too
  (#15).
- Entry action: nothing says entry actions run even when the state is strongly aborted in its entry tick (#20).
- Shallow/deep history: works only at the top level (#62); the remembered state is re-entered, but local variables are
  reset (#61).
- Deferred: "it preempts all immediate behavior in the target state, this includes entry actions" is right for the
  state itself; for a superstate the inner entry actions still run with `deferred` (#66) and the inner timing can
  shift (#65).
- Suspend: the wiki does not say that the state's own outgoing transitions are frozen (#45), that its entry actions are
  lost on first entry (#47, while the inner states' entry actions run, #91), that the termination becomes delayed
  (#48), or that the state cannot have a strong abort (#90).
- Count delay: the wiki does not say the entry tick is excluded for delayed count delays (#36), that the count
  restarts on entry (#38) or that it is ignored on `during` and `suspend` (#42, #51).
- The wiki's first example uses `auto`; it means nothing (#73).

---

## 7. Open points and limits

- Weak suspend combined with exit actions or history, and shallow `deferred history` into a superstate that also
  has normal incoming transitions, were not tested.
- `Deferred.transformComplex` (used when a deferred target is part of an immediate loop) was not exercised by any
  chart; its behaviour is unverified.
- The initial value of the suspend flag (false) relies on the generated C code zero-initialising variables without an
  initial value; both compilers behave the same.
- Signals in abort triggers were not tested separately; they follow the same rules (emission = write).

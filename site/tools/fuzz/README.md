# Differential fuzzer (engine vs KIELER)

Random charts are compiled and simulated by the guide's engine (`packages/engine/src`) and by real KIELER (the oracle,
`tools/oracle/oracle.mjs`), and compared tick by tick: acceptance, KIELER's data pool, the taken-transition counters
and the termination tick (exactly what `tests/conformance/engine.test.ts` compares for recorded charts). A
disagreement is shrunk to a small chart, which becomes a recorded probe in `tests/engine/kieler/<area>/`.

| File | |
| --- | --- |
| `gen.ts` | the generator: `generate(seed, profile, index)` gives `{ name, model, inputs }`; profiles below |
| `compare.ts` | `compareWithOracle(model, inputs, oracleResult)`: the outcome (`match`, `both-reject`, `engine-accepts`, `engine-rejects`, `behaviour`, `nondeterministic`, `unsupported`, ...) |
| `oracle.ts` | one oracle JVM for many charts, with a time limit per chart (the JVM is killed and restarted after a timeout) |
| `run.ts` | the campaign runner |
| `reduce.ts` | the reducer |
| `recheck.ts` | re-compares saved disagreements with the current engine (KIELER's saved results, no Java) |
| `register.mjs`, `hooks.mjs` | let Node run the engine's TypeScript directly (extensionless imports) |

Run everything from `site/`. The oracle needs Java and the server jar (docs-internal/ARCHITECTURE.md). Run one
oracle at a time on a shared machine: each is a 1.5 GB JVM.

```sh
TS="node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs"

# A campaign: 100 charts of each of two profiles, seed 1 (deterministic), results in /tmp/fuzz-1
$TS tools/fuzz/run.ts --profiles mix,refAborts --count 100 --seed 1 --out /tmp/fuzz-1

# Only the engine's verdicts (no Java): how many charts each profile gets accepted, rejected, unsupported
$TS tools/fuzz/run.ts --count 100 --engine-only

# Shrink a disagreement the campaign found (writes mix-1-3.reduced.sctx and .json next to it)
$TS tools/fuzz/reduce.ts /tmp/fuzz-1/mismatches/mix-1-3.json

# Re-run saved jobs ([{ name, model, inputs }]) instead of generating
$TS tools/fuzz/run.ts --jobs jobs.json --out /tmp/fuzz-again

# After a fix: which saved disagreements remain (no Java)
$TS tools/fuzz/recheck.ts /tmp/fuzz-1/mismatches
```

`run.ts` options: `--profiles a,b` (default: all), `--count N` per profile, `--seed S`, `--ticks T` (14),
`--timeout` seconds per chart (40), `--out dir`. It writes `results.jsonl` (one line per chart: outcome, KIELER's
first errors), `report.json` (counts per profile and outcome) and `mismatches/<name>.sctx|.json` for every
disagreement (`.json` has the inputs, the outcome with all differences and KIELER's full result). It prints
`MISMATCH <name> [<kind>] <first difference>` as it goes.

## Profiles

Every chart starts from a random region tree (states, superstates with up to three regions, connectors, final
states) and draws from the features its profile switches on. `mix` takes a random subset of all features per chart.
The others focus on one area, or stack the features whose interplay matters:

| Profile | Features |
| --- | --- |
| `basics` | hierarchy, connectors, immediate transitions, `pre`, data, locals |
| `signals` | pure and valued signals with combine functions, `pre`, `val` |
| `preemption` | entry/during/exit actions (weak, strong, triggered), aborts, terminations, count delays, suspend, weak suspend, history, deferred, final regions |
| `structure` | references to generated charts, for-regions, dataflow regions, signals |
| `abortRegions` | abort regions first or last, at the top level too |
| `refAborts` | strong and weak aborts inside regions inside referenced charts, references in concurrent regions |
| `historySuspend` | history entries into suspended (and weakly suspended) superstates |
| `rare` | the cheat sheet's rare forms among ordinary behaviour: a method reading `state(R0.R0s1)` in triggers, constants of another chart (`scchart(FK).K` in triggers and effects), a primed constant, and now and then a primed or `^` output that gcc rejects (round 4) |
| `polish` | the final polish's forms among ordinary behaviour (not in `mix`): conditionals without else in triggers and effects, `pre(n, a)` next to `pre(n)`, code blocks with gotos (forward, now and then backward), `ov[2]` (which is `ovz`) and `ov[n % 3]` in triggers and effects |
| `timed` | timed annotations and ode actions (not in `mix`): @Logical / @Passive on the clock's declaration or its variable and in any case, @NoSleep, @DeviationOutput, @IntegerClockType, @SimulateSleep, a chart's own `lag`, `ode f = ...` on a float and an int, in shallow charts so most reach a tick-by-tick comparison; referenced charts get a clock of their own and a chart sometimes extends a base with a clock and annotations (copies must keep KIELER's reading). Against the code before the @Logical fixes it finds 24 disagreements in 150 charts (seed 1); after them none |
| `nested` | nested instances (not in `mix`): a struct inside a struct, a class inside a class, arrays of class and struct instances with methods (short ones, which KIELER copies into place, and ones with a loop, which it keeps as functions and whose accesses go through their own `self`), an array member of an array of structs, nested struct assignment, an initial value reading a sibling member, and triggers with an element before or after a plain variable (KIELER's partial evaluation loses the index in the first case). Seed 1 found the member identifier rule (5 disagreements in 200 charts), seed 3 the lost index of an array of instances in a join's trigger; seeds 2 and 4: none |
| `reincarnation` | a template of its own (not in `mix`): a state with abort regions entered again in the tick it finishes (its own `join to`, with an effect, `deferred`, through a second state, or as the inside of a state that restarts), leading and trailing abort regions, one that never ends, self-loops and entry actions in the regions, a second content region, a signal between the regions. About 85 % of the charts compile in both tools and are compared tick by tick |
| `schedules` | written schedules (not in `mix`): `schedule s`, `{conflicting, commuting}` protocol lists and the `global` form, `schedule s N` on absolute and relative writes of `w` in two or three concurrent regions, mostly with a priority of their own (KIELER accepts the total order) and sometimes a shared one (a conflict); clauses on calls (a short method, a call with one argument, which loses its clause, a C function), inside a method body and in code blocks (on statements, an `if` condition, in a loop); a class `Tk` whose methods have contracts (priorities of its schedule `q`, mostly commuting, sometimes a C function), a region that calls them all (now and then left out: a contract nobody calls), and `schedule tk.q N`. 400 charts, seed 1: 47 match, 347 rejected by both, 6 that KIELER never finishes compiling (the engine rejects them), no disagreement |
| `dataflowObjects` | a template of its own (not in `mix`): dataflow regions KIELER translates in its OO way (an equation calls a method) and in its classic way, next to a control-flow region that reads their outputs. Chart instances wired by equations (`g.p = ...`, `g = {e, _}`, `o1 = g.r`) of a gate chart with a dataflow region or states of its own (initial values, a local, now and then a final state), declared in the chart or in the region, singly, as two of one declaration or as an array; a chart used as a class and a class instance called in equations (`k.add(n)`, `k.add(1) = a`, `o2 = k.get()`, `cells[n % 2].add(1)`); vectors assigned to arrays; `;` sequences; `dataflow once` in a state entered late; schedules on equations and regions against a transition's scheduled write; explicit and positional bindings; a transition that writes an instance's input. About 64 % of the charts compile in both tools and are compared tick by tick; the rest are KIELER's own rejections (an instance shared by a classic region, a lost schedule clause, a binding on a classic instance, conflicts). Seed 1 found 3 disagreements in 200 charts, seed 2 one; seeds 1 to 5 after the fixes: none in 1000. Since the review fixes a third region now and then: an array or an instance's array port indexed by an instance's output or a call (the classic translation's single variable for an array port, the call KIELER does not find in an assigned member's index), a `dataflow for` region with and without its counter in an equation, a vector after a call equation |
| `generics` | generic charts (not in `mix`): referenced charts with value, primitive type and chart type parameters (`G0<2, int>(a, b, x)`) given literals, inputs, outputs, a constant, an array element, types and charts; the parameters at work in regions of their own; instances declared with `ref G0<2> gi(...)` and `ref G0 gi<2>(...)`; a base chart with a parameter (`extends GB<3>`), also with bindings (`extends GBB<n>(a, gy)`); a superstate that extends a generic chart (`state S extends GI<2>(gz) { ... }`); `region RQ is GBQ`; a nested chart whose local has the enclosing parameter's name. Now and then a form both tools must reject: a missing, surplus or wrong argument, a parameter handed on in `is G1<N0>`, a written parameter, a parameter list that leaves an output open, a region copy that names the base chart's parameter. Aborts and immediate transitions are optional, so about a third of the charts reach the tick-by-tick comparison. Seed 1 of the first version found the constant argument rule (a constant passed as an argument is still its name when KIELER binds it). Since the review fixes the base chart now and then has a method whose body declares the parameter's name again (in a `for` loop, in a block) or takes the parameter as a local's initial value, and `extends` now and then has one argument too many |
| `countFor` | count delays inside for-region copies |
| `signalStrong` | valued signals with combine functions read by strong aborts of the superstates they are emitted in |
| `dataflowControl` | dataflow regions next to control-flow regions that read and write the same variables |
| `immediateChains` | immediate transitions across hierarchy levels: into superstates, out by immediate aborts and terminations |
| `timedClasses` | a clock (half of the charts with @ClocksUseSD, so it may be shared) and a class instance with methods, next to aborts and joins |
| `beginner` | what beginners write: two or three top-level regions with signals, aborts, `pre` and (more) count delays, superstates one level deep, labels now and then |
| `objects` | a class with methods whose bodies use `if`, `for` and `while`, a struct, an enum (`ref Mode m`), code blocks `do { ... }`, labels |
| `abortObjects` | abort regions with actions and labels, sometimes with the objects of `objects` |

Effects and triggers are drawn so that a good part of the charts is accepted: inside concurrent regions, writes are
commuting updates (`x += 1`) and emissions; reads of concurrently written variables are rarer. Every tick gives
every input (`a`..`d` bool, `n` int, `deltaT` for timed charts), so KIELER's input persistence plays no role.

## Outcomes

- `match`, `both-reject`: agreement. A `match` also has the same warnings and infos of KIELER's front end
  (validator and linker, by position) as the engine; otherwise it is `diagnostics`.
- `engine-accepts`, `engine-rejects`, `behaviour`, `engine-crash`, `diagnostics`: disagreements (written to
  `mismatches/`).
- `nondeterministic`: the engine rejects with `kieler-nondeterministic` (KIELER's verdict changes from run to
  run, packages/engine/src/sim/README.md "Chance"); not counted as a disagreement.
- `unsupported`: the engine cannot simulate the chart (info `unsupported`).
- `syntax`: the engine's front end rejects the chart with a syntax error (a generator bug, or a parser difference).
- `oracle-failure`: KIELER did not finish (timeout) or its server failed.

## Reducing

`reduce.ts` keeps the kind of disagreement (and, for `behaviour`, the ticks up to the first that differs) while it
deletes blocks, collapses superstates into simple states, deletes lines, and simplifies transitions and actions
(drops effects, triggers, `immediate`, count delays, history, deferred, weak/strong, turns aborts and joins into
`go to`, abort and final regions into regions) and the generated referenced charts. Each candidate is checked by
the engine first (it must still accept, or still reject) and only then by KIELER. Expect 50 to 300 KIELER runs.

A reduced chart becomes a probe: copy it to `tests/engine/kieler/<area>/<name>.sctx` with a comment saying what it
shows, add `<name>.scenario.json` with the inputs (`{ "ticks": [{ "inputs": {...} }], "expect": "ok" | "error" }`)
and record it with `pnpm oracle:record tests/engine/kieler/<area>`. The conformance test then checks it.

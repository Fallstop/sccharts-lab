# Differential fuzzer (engine vs KIELER)

Random charts are compiled and simulated by the guide's engine (`src/engine`) and by real KIELER (the oracle,
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
  run, src/engine/sim/README.md "Chance"); not counted as a disagreement.
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

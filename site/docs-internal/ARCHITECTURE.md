# SCCharts Guide: architecture

The site at sccharts.jmw.nz is a beginner-friendly, comprehensive and interactive introduction to the
SCCharts language. Its examples run in the browser: a TypeScript engine parses SCTX, draws the chart the way
KIELER does and simulates it tick by tick. Every example is checked against the real KIELER compiler (the
"oracle"), so what a reader sees in the guide is what the official tools do.

Everything lives in `site/` of the `site` branch (worktree `../sccharts-lab-site`). Astro 7 with Starlight
for the shell, Svelte 5 for the interactive islands, vitest for the tests.

## Ground rules

- **Package manager: pnpm, inside `site/` only.** Never run npm/yarn/pnpm in the repository root (a
  yarn/lerna workspace for the VS Code extension). Add a dependency only when needed, with
  `pnpm add <pkg>@<exact version>` from `site/`. Never create a directory named `lib` (the root `.gitignore`
  ignores every `lib/`).
- **Don't commit.** Several agents share this worktree; the coordinator commits.
- **Don't build.** Concurrent `astro build` / `astro preview` runs overwrite each other's `dist/` and caches.
  Look at pages through the shared dev server (below) unless a task explicitly allows a build.
- **Don't edit files another workstream owns** (table below). If you need a change there, write it in your
  final report instead.
- **Fidelity over invention.** SCCharts semantics are KIELER's. When unsure what KIELER does, ask the oracle
  (below) or read the KIELER source in `../kieler-server-fork/modules`. Never document or implement behaviour
  from intuition. The numbered rules in `docs-internal/semantics/*.md` are the ground truth.
- British/NZ spelling in prose (behaviour, initialise, colour); code keeps KIELER's spelling.
- No traffic lights or pedestrian crossings in examples (COMPSYS 303 assignments).

## Layout

| Path | Owner | What |
| --- | --- | --- |
| `src/engine/` | engine | Parser (`parser/`), simulator (`sim/`), KIELER's label serialisers (`format.ts`), data contract (`types.ts`), public API (`index.ts`) |
| `src/diagram/` | playground + diagram | ELK layout and SVG rendering in KIELER's notation (`README.md`) |
| `src/components/` (except `playground/`) | widgets | `Chart`, `Sim`, `Compare`, `Predict`, `Quiz`, `TryIt`, `KeyIdeas`, `Playground` (Astro), the simulation panel (`sim/`, Svelte), the widget frame (`frame/`), landing and Starlight overrides |
| `src/components/playground/`, `src/pages/playground.astro` | playground + diagram | The playground IDE and the inline `<Playground>` (`README.md`) |
| `src/styles/`, `astro.config.mjs`, `ec.config.mjs`, `src/content/docs/design/**`, `404.mdx` | widgets | Site shell, theme, code blocks, design specimen and widget test bench |
| `src/content/docs/**` | content editors | Guide pages (MDX) |
| `src/examples/**` | content editors | Example charts (`.sctx`), scenarios (`.scenario.json`) and their KIELER recordings (`.oracle.json`) |
| `docs-internal/semantics/`, this file | semantics-docs | The semantics specs (numbered rules) |
| `tests/conformance/<area>/` | semantics-docs | Probe charts, scenarios and oracle recordings that define correct behaviour |
| `tests/conformance/engine*`, `tests/engine/`, `tests/corpus/`, `tools/fuzz/`, `tools/oracle/` | engine | Engine vs KIELER, engine unit tests, parser corpus, differential fuzzer, the oracle harness |
| `tests/diagram/`, `tests/playground/`, `tools/diagram-*.mjs` | playground + diagram | Diagram and playground tests and tools |
| `tests/widgets/`, `tests/design/`, `tools/screenshot.mjs`, `tools/contrast.mjs` | widgets | Widget and design tests and tools |
| `tools/qa/`, `docs-internal/QA.md` | QA | Production checks of the built site (links, axe, console, keyboard walks, phone width, no-JS, performance, meta, search) |
| `docs-internal/CONTENT-PLAN.md`, `DESIGN.md` | coordinator / widgets | Audience, voice, page anatomy, component props (widgets own the component section); visual design and writing conventions |

## Working on the site

- **Dev server.** `tools/dev-server.sh` makes sure one shared Astro dev server runs on
  http://127.0.0.1:4321/ (it starts it if needed, under a lock, and waits until it answers);
  `tools/dev-server.sh log` shows its log. Pages hot-reload on save. If a page errors while another agent is
  mid-edit, wait a minute and retry.
- **Screenshots.** `node tools/screenshot.mjs --url http://127.0.0.1:4321 --out <dir> /learn/ticks/ /playground/`
  (`--widths 390,1280`, `--themes light,dark`, `--viewport` for the first screen only), then look at the PNGs.
  For interaction checks write small Playwright scripts; `tools/chromium.mjs` (`launchChromium`) finds the
  installed Chromium.
- **Tests.** `pnpm exec vitest run <paths>` (not `pnpm test -- <path>`); the whole suite is
  `pnpm exec vitest run`. Don't run several full suites at once.
- **Vite's dependency cache.** Tools that start their own Vite server rooted at `site/` (`tools/diagram-gallery.mjs`,
  vitest with a custom root) share `node_modules/.vite` with the dev server and can leave it serving outdated
  dependencies (every page answers 504 "Outdated Optimize Dep"). Restart the dev server then.
- **QA.** `tools/qa/*.mjs` check the site as readers get it: `links.mjs` (every internal link and anchor of
  `dist/`, playground example links, `--external` for the outside ones), `pages.mjs` (console errors, axe in both
  themes before and after engaging a widget, sideways scroll, bytes, layout shift, hydration), `keyboard.mjs`
  (a keyboard-only walk through a widget or the playground), `phone.mjs` (tables and code blocks that scroll
  inside themselves at 390 px), `nojs.mjs` (diagrams and tours without JavaScript), `interactive.mjs` (time to
  the first tick on a throttled phone), `meta.mjs` and `links.mjs` (read `dist/`), `search.mjs` (Pagefind). The
  browser ones start their own `astro preview` of `dist/` unless given `--url` (the dev server works for most);
  procedure, thresholds and the last results: `docs-internal/QA.md`.

## The oracle (real KIELER)

`tools/oracle/oracle.mjs` starts the sccharts-lite language server (the KIELER server fork: current KIELER
sources, kieler/semantics 5f02d129, with the same compiler and simulator; it adds diagnostics and fixes some
crashes, which it flags with `kieler-divergence` warnings) on Java 21, compiles a chart with the netlist-based C
simulation and steps it. About half a second per chart once the JVM runs.

```sh
cd site
node tools/oracle/oracle.mjs chart.sctx --ticks 4 --inputs '[{"A":true},{},{"A":false,"B":true},{}]'
node tools/oracle/oracle.mjs --batch scenarios.json        # [{file|model, inputs, ticks, system}], one JVM
node tools/oracle/oracle.mjs chart.sctx --system priority    # priority-based compiler instead of netlist
pnpm oracle:record src/examples/learn/signals                # record every stale scenario under these paths
tools/oracle/dump/dump.sh chart.sctx de.cau.cs.kieler.sccharts.extended last   # KIELER's model after a processor
```

From a script: `const o = await startOracle(); await o.run(scenario); await o.stop()` (`o.kill()` when a
compilation never answers); `tools/fuzz/oracle.ts` (`OracleRunner`) adds a time limit per chart and restarts the
JVM after a timeout, which is the way to run probes that may hang (official KIELER never answers on some crashes).

Result: `{ ok, errors, warnings, diagnostics, interface, ticks: [{ step, inputs, values, taken, terminated }] }`,
plus `issues` (the lab server's structured compiler issues: severity, code, message, hint, location, processor)
and `internalErrors` (KIELER's crashes, with the exception and stack trace in `details`).
`ok: false` with `errors` means KIELER rejects the chart (scheduling failures as e.g. `Can't schedule from _g2
to _cg2` plus a `Potential instantaneous loop` warning). `values` is the data pool after the tick: inputs,
outputs and root-level locals (names starting with `_` are dropped); a valued signal `V` appears as `V`
(presence), `V_val` (value) and `V_curval`. `taken[i]` counts how often transition `i` fired in that tick, in
Taken Transition Signaling order (`basics.md` B-32). Inputs persist in KIELER's simulator: a value set at tick
n holds until changed, so scenarios set every input in tick 1. `terminated` is KIELER's `_TERM`, true only in
the tick of termination. Tick 1 is the first reaction: the initial states are entered and immediate behaviour
runs; delayed transitions out of the initial states can fire from tick 2.

`pnpm oracle:record` (`tools/oracle/record.mjs`) writes `<name>.oracle.json` next to each
`<name>.scenario.json` whose chart, inputs, system or imports changed (a hash), in one server, and fails when a
chart's outcome contradicts its scenario's `expect`. Chart names must be distinctive: every scenario of one run
stays loaded in the server, and `is C` resolves against all of them (`structure.md` section 13). Recordings are
committed, so tests run without Java.

Java: `/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin/java`
(override with `SCCHARTS_JAVA`). JAR: `../kieler-server-fork/server/target/sccharts-lite-server.jar`
(override with `SCCHARTS_SERVER_JAR`). `gcc` is on PATH. Memory is limited: run at most one oracle process at
a time (prefer `--batch` and `oracle:record`, which reuse one JVM) and never leave one running.

**Official KIELER.** The KIELER VS Code extension 0.3.0 ships an older compiler (May 2024). Its jar can be
driven by the same oracle (`SCCHARTS_SERVER_JAR=<official jar>`); where it is, how to run it, and how its
behaviour and messages differ from current KIELER: `basics.md` section 10.1. Use it to check wording and to
avoid presenting version-dependent behaviour as universal.

## The semantics specs (`docs-internal/semantics/`)

Four specs with numbered rules, each backed by a conformance chart in `tests/conformance/<area>/`
(`NN-name.sctx`, `.scenario.json` with a note per tick, `.oracle.json`) or a quoted probe:

| Spec | Rule ids | Area |
| --- | --- | --- |
| `basics.md` | B-n | ticks, variables, transitions, final states, expressions, `taken`, netlist bugs; section 10.1: official KIELER 0.3.0 vs current |
| `concurrency.md` | H-, T-, C-, SIG-, V-, PRE-, A-, K-n | hierarchy, termination, concurrency and causality, signals, valued signals, `pre`, ABRO, KIELER defects |
| `preemption.md` | P-n | actions, aborts, count delays, suspend, history, deferred, connectors, final/abort regions |
| `structure.md` | S-n | several charts, references, imports, for-regions, dataflow, time, methods and SCL code blocks, enums/structs/classes and chart classes with inheritance, host code, `static`/`global`, systems |

A bare S-n means `structure.md` and a bare P-n `preemption.md` (concurrency's signal and `pre` families are SIG
and PRE). Rule ids belong in internal docs, tests and code comments, not on guide pages. Each area's
`*.test.ts` in `tests/conformance/<area>/` checks the suite's integrity (current recordings, `expect`, notes,
tick-1 inputs) and, for basics and structure, the tick values the spec claims.

## Engine API (`src/engine/index.ts`)

```ts
parse(source: string): ParseResult        // syntax (plus name resolution, for diagrams); never throws
compile(source: string, options?: { chart?: string; files?: Record<string, string> }): CompileResult
interface CompileResult {
  ok: boolean                    // false exactly when KIELER would reject the chart (errors in diagnostics)
  program?: Program              // whenever parsing produced a model, even if !ok (for diagrams)
  chart?: State                  // the simulated root: the FIRST scchart, as KIELER (or options.chart)
  diagnostics: Diagnostic[]
  interface: VariableInfo[]      // KIELER's simulation interface (inherited declarations; deltaT/sleepT of timed charts)
  index?: ModelIndex             // resolved model (declarations, parents, transition targets, other files)
  sim?: CompiledChart            // the simulator's compiled chart
  forCopies?: ForCopies[]        // each for-region and its counter's values, one per copy (lanes, "×n" badges)
}
createSimulation(result: CompileResult): Simulation
interface Simulation {
  readonly interface: VariableInfo[]
  readonly tick: number                         // completed ticks
  readonly history: SimTickResult[]
  step(inputs?: Record<string, Value>): SimTickResult   // missing inputs keep their previous value (as KIELER)
  reset(): void
  rewind(toTick: number): void                  // back to the state after tick n (snapshots)
  takenCounts(result: TickResult): number[]     // KIELER's taken[] for that tick (TTS order)
}
interface SimTickResult extends TickResult {
  pool: Record<string, Value>                   // KIELER's data pool, KIELER's names
  trace: Record<string, Value>                  // locals of inner states and members, by traceableVariables' key
}
traceableVariables(result): TraceableVariable[] // what a trace may show: interface, inner locals (one per for-region copy), members, clocks
describeTick(tick: TickResult, program: Program, previous?: TickResult, options?: { markdown?: boolean }): string[]
                                              // plain-English sentences (inline Markdown with markdown: true)
elementName(id, program, { markdown? }): { name: string; within?: string } | undefined   // any state, transition,
                                              // region or action id, inside reference and for-region copies too
SIMULATOR_CODES: ReadonlySet<string>            // diagnostic codes added by the simulator's compilation stage
parseExpression(source, { as?: 'auto' | 'expression' | 'effect' }): ExpressionParseResult   // one expression or effect
formatExpressionParenthesised(expression, options?): string   // how KIELER grouped it (the operators page)
```

- **Lazy compilation.** `compile()` runs the front end (parse, resolve, validate) at once; the simulator's
  compilation (KIELER's transformations, the causality and instantaneous-loop analysis, the code-generation
  checks) runs on the **first read** of `ok`, `diagnostics` or `sim`, once. Reading only `program` and `chart`
  (diagrams) stays cheap.
- `TickResult` (`types.ts`) is keyed by interface names: `values`, `present`, `active`/`entered`/`exited` state
  ids, `taken` transition ids in firing order, `actions`, `terminated` (sticky) and `terminatedNow` (KIELER's
  `_TERM`), `log` (micro-steps for "Explain this tick"), `printed`, and `error` for a runtime failure (its `tick`
  is the tick in which the simulation stopped; every later `step()` returns the same error with the values frozen,
  as KIELER's dead process does). `inputs` holds the inputs at the end of the tick, `ranWith` every input as the
  tick read it (sending these to `step()` again gives the same run), `copies` the states of each for-region copy. `pool` is what the oracle's `values` contain; the conformance test compares
  it key by key.
- `createSimulation` works for any `CompileResult`; for a rejected chart, or one the simulator cannot run, every
  `step()` returns a result whose `error` is the first error.
- **Diagnostics** carry a beginner's `message` and `hint`, a stable `code`, KIELER's own text in `kieler`,
  `related` element ids (for highlighting), a `span` and, for a "did you mean", the `suggestion`. Policy:
  - error: KIELER rejects the chart (`causality-cycle`, `instantaneous-loop`, `kieler-crash` for KIELER's own
    crashes, `kieler-nondeterministic` for charts KIELER accepts in some runs and rejects in others, and the
    other codes of the front end and of `SIMULATOR_CODES`);
  - `unsupported` is an **info**: KIELER accepts the chart but the guide's simulator cannot run it (host code,
    a transformation not implemented). `ok` stays true; the widgets show the diagram and no simulation;
  - `kieler-quirk` (info or warning): KIELER behaviour the guide reproduces although it looks wrong (preemption
    quirks, a chart with signals never terminating); `kieler-bug` (warning): KIELER computes something else and
    the guide shows the intended result (netlist bugs B-34, B-35); `kieler-divergence` (warning): official KIELER
    fails on the chart, SCCharts Lab and the guide compile it; `kieler-loop-warning` (info): KIELER's
    "Instantaneous loop detected!" on a chart that works.
- The engine is pure TypeScript with no DOM access: it runs in Node (tests, build-time rendering) and in the
  browser. Internals: `src/engine/sim/README.md` (pipeline, adding a pass, reproduced KIELER defects) and
  `src/engine/sim/STATUS.md` (coverage, API details).

## Diagrams (`src/diagram/`)

```ts
layoutChart(chart: State, options?): Promise<DiagramLayout>     // elkjs; Node or browser
renderSvg(layout: DiagramLayout, options?): string                // pure, deterministic
chartToSvg(chart: State, options?): Promise<string>               // both
applyClasses(svg, classes), tickClasses(tick)                     // ~diagram/highlight: no layout, no elkjs
```

Every rendered state, region and transition carries `data-id="<element id>"` (ids in `types.ts`), so a
simulation highlights by toggling classes (`HIGHLIGHT_CLASSES`: `is-active`, `is-entered`, `is-exited`,
`is-taken`, `is-focus`, `is-error`, `is-dimmed`) without re-layout. Colours come from CSS custom properties (`--sc-*`), so the theme controls light
and dark mode. Fidelity to KIELER's synthesis is tested against KIELER's own diagrams (`src/diagram/README.md`).

## Widgets and pages

- **Build-time diagrams.** Guide pages use the Astro components (`<Chart>`, `<Sim>`, `<Compare>`, `<Predict>`,
  `<TryIt>`, ...; props in `CONTENT-PLAN.md`). In the page's frontmatter `src/components/frame/prepare.ts`
  compiles the example with the engine, lays out and renders its diagram, and decides what to show from the
  example's oracle recording (KIELER's verdict wins: rejected, accepted, or accepted but `cannotRun`). Pages ship
  finished SVG: no layout flash, works without JavaScript, no elkjs in the browser.
- **Islands.** `<Sim>`, `<Compare>` and `<Predict>` hydrate Svelte islands (`src/components/sim/`): `SimPanel`
  (inputs, controls, timing diagram, "What happened", guided tour from the scenario) drives a `Simulation` and
  reports highlight classes, which `link.ts` applies to the pre-rendered SVG and the code lines. The islands
  import the engine (one shared chunk) and `~diagram/highlight`, never `~diagram/index`. They hydrate with
  `client:engage` (`src/components/sim/engage.ts`): when the reader first points at, touches, focuses or types
  in a widget, not when it scrolls into view. Before that a guide page loads about 10 kB of its own JS (plus
  Starlight's search UI on idle); the shared engine chunk (about 120 kB gzipped) loads on first engagement.
  Diagrams, code lines and the timing diagram are keyboard-accessible, and the trace has a screen-reader
  table. Details and the props of `SimPanel`: `src/components/sim/README.md`.
- **Keyboard.** Every widget can be used without a mouse: the widget frame and the stage are tab stops, the
  diagram's states, regions and transitions are one more (arrow keys, Home/End, each named with its simulation
  marks: `enableDiagramKeys` in `src/components/sim/link.ts`), Space and Enter step, and the trace has a
  screen-reader table. `tools/qa/keyboard.mjs` walks them.
- **Playground.** `/playground` and the inline `<Playground example="…">` are the only places that lay out in
  the browser: `layoutChart` runs with ELK in a Web Worker (`layout-service.ts`, elk-api + elk-worker), latest
  request wins. CodeMirror 6 editor, live diagnostics (for a guide example opened as it is, paired with KIELER's
  recorded words), the same `SimPanel` with a variables strip, share links for the chart and for a whole run
  (`&run=`, replayed as a tour; a link pasted into an open tab, and Back and Forward, open their chart too), the
  comparison with model solutions and, for an exercise link (`&solution=`), a banner with the exercise's task,
  a Watch expression and Run until, every example in its menu (`src/components/playground/README.md`).
- **Examples.** `src/examples/<section>/<page>/<name>.sctx` with `<name>.scenario.json` (per-tick inputs and
  notes, `expect`, `errorIncludes`, `imports`) and the recording `<name>.oracle.json`; format in
  `CONTENT-PLAN.md`. The first `scchart` in a file is the one simulated, everywhere.

## Tests

| Path | What |
| --- | --- |
| `tests/conformance/engine.test.ts` | Every oracle recording under `tests/conformance`, `src/examples` and `tests/engine/kieler` replayed in the engine and compared tick by tick (pool, `taken`, termination tick); rejected charts must be rejected. Skips other systems, `needs` the engine does not emulate, `kieler-bug` scenarios and `unsupported` charts; known failures in `engine-expected-failures.json` (remove entries as they pass) |
| `tests/conformance/<area>/*.test.ts` | Integrity of each conformance suite and the spec's claimed values |
| `tests/engine/` | Engine unit tests (API, diagnostics, describe, semantics, preemption, structure, performance); `kieler/`: probe charts of KIELER defects with recordings (part of the conformance run) |
| `src/engine/**/*.test.ts` | Parser, resolver and validator unit tests |
| `tests/corpus/` | Parser corpus (wiki, lab fixtures, probes) against KIELER's recorded diagnostics; `kieler-diff.test.ts` is an opt-in differential run against the live server |
| `tests/diagram/` | Layout and rendering, highlight, KIELER label and diagram comparisons |
| `tests/widgets/`, `tests/design/` | Widget models (timeline, inputs, trace), `prepare`, frame helpers, contrast; `browser.test.ts` drives the dev server's widget test bench in Chromium (skipped without the dev server) |
| `tests/playground/` | Playground language, features, share links; `e2e.test.ts` (opt-in) against the dev server |
| `tools/fuzz/` | Differential fuzzer: random charts through the engine and the oracle, a reducer for disagreements and a re-checker (not part of vitest; `tools/fuzz/README.md`); its findings become probes in `tests/engine/kieler/` |
| `tools/qa/` | Production QA of the built site (not part of vitest; `docs-internal/QA.md`) |

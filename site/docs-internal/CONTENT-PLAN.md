# SCCharts Guide: content plan

## Who it is for

Readers who can program a little (C, Java or Python) but have never met a synchronous language or a
statechart. Many are university students in an embedded or reactive-systems course (for example
COMPSYS 303 at the University of Auckland, which uses SCCharts with the SCCharts Lab VS Code extension);
others are engineers evaluating SCCharts. They want to write correct charts quickly, understand what the
compiler tells them, and stop being surprised by ticks.

The existing reference is KIELER's wiki (`Syntax.md` and friends; a copy is in
`/tmp/claude-1000/-home-fallstop-Documents-projects-sccharts-lab/5f5ba5d5-ee8a-425d-bfbe-e62926bcef1b/scratchpad/wiki/semantics.wiki/`).
It lists syntax with little explanation, few examples of *behaviour*, and no exercises. This guide teaches.

## Voice and style

- Second person, friendly and exact. Short paragraphs. Concrete before abstract: show a tiny chart,
  run it, *then* state the rule, then the pitfalls.
- Every new construct gets a runnable example (a `<Sim>`), small enough to read at a glance
  (usually 5–20 lines). Build examples up across a chapter rather than introducing many unrelated ones.
- Explain behaviour tick by tick. Use tables "tick | inputs | state after | outputs" freely, and scripted
  scenarios whose per-tick notes say *why* something happened.
- Name things consistently: tick (define "reaction" and "instant" once as synonyms), state, superstate,
  region, transition, trigger, effect, delayed / immediate, weak abort / strong abort / termination,
  signal present / absent, emit, entry / during / exit action, initial / final state.
- British/NZ spelling (behaviour, initialise, colour, recognise). Code keeps KIELER's spelling.
- No marketing, no filler, no emoji. Don't say "simply" or "just" about things beginners find hard.
- When KIELER's behaviour is surprising, say so plainly and show it. When the guide simplifies, say what
  is being simplified and link to where the full story is.
- **Every behavioural claim is verified with the oracle** (`tools/oracle/oracle.mjs`, see
  ARCHITECTURE.md). If you can't verify something, leave it out or mark it clearly as unverified.
- Link to the KIELER wiki and the papers for depth (see the reference list at the end).

## Page anatomy

Each Learn chapter, roughly:

1. Opening: what problem this construct solves, in one or two sentences, often with a real-world device.
2. The construct introduced through a running example (`<Sim>` with a scenario).
3. The rule, stated precisely, with the diagram notation.
4. Variations and details (more examples).
5. `<Aside type="caution">` for common mistakes, with the compiler message the reader will actually see.
6. "Try it": one or two exercises (`<TryIt>`), with a starter chart and a hidden solution.
7. "Check your understanding": one to three `<Quiz>` / `<Predict>` questions.
8. `<KeyIdeas>`: three to six bullet summary.

## Site map

Slugs are under `src/content/docs/`. Each page's frontmatter sets `title`, `description`, and
`sidebar.order`.

### Start here (`start/`)
1. `welcome` — What SCCharts is (statecharts + synchronous languages + sequential constructiveness), where
   it comes from (Kiel University's KIELER project; Harel's statecharts; Esterel), what it is used for,
   how this guide works (the widgets), and a first live chart to poke.
2. `in-a-hurry` — Short on time?: setup in three steps, one microwave chart built up in five simulations,
   the eight surprises, what to do when it fails, and every Learn chapter's key ideas (`<KeyIdeasDigest>`).
3. `tools` — Getting SCCharts: the SCCharts Lab VS Code extension (recommended; diagrams, simulation,
   live diagnostics), official KIELER, and this site's playground. What each is good for.

### Learn (`learn/`), the core tutorial, read in order
1. `ticks` — Thinking in ticks: reactive systems, the synchronous hypothesis, a tick as the unit of
   logical time, inputs sampled → reaction in zero time → outputs. Why this makes programs deterministic.
2. `first-chart` — Your first SCChart: anatomy of a `.sctx` file (`scchart`, interface declarations,
   states, `initial`, transitions), reading the diagram, running it.
3. `transitions` — Triggers, effects and priority: `if … do … go to`, effect lists with `;`, several
   outgoing transitions and their priority numbers, self-loops, transitions without trigger.
4. `immediate` — Delayed and immediate transitions: the entry tick, `immediate`, chains of immediate
   transitions within one tick, why a cycle of immediate transitions is rejected, `final` states.
5. `variables` — Variables, types and expressions: `bool`/`int`/`float`/`string`, `input`/`output`/local,
   initial values, `const`, operators, assignment operators and `++`, arrays; how inputs behave in the
   simulator (they keep their value until changed).
6. `signals` — Signals: pure signals, presence per tick, emitting, input and output signals, signals vs
   boolean variables; valued signals, `val()`/value access and combine functions.
7. `hierarchy` — Superstates: nesting, scope of declarations, final states and termination (`join to`).
8. `concurrency` — Concurrent regions: regions run in the same tick, communication between regions in the
   same tick, termination when all regions finish; ABRO.
9. `preemption` — Aborts: weak abort (`go to`, the default), strong abort (`abort to`), immediate aborts,
   termination; exactly what runs in the tick an abort happens.
10. `actions` — Entry, during and exit actions; `immediate during`; triggers on actions; how they relate to
    transitions; labels.
11. `pre` — The previous tick: `pre()`, edge detection, count delays (`if 3 A`).
12. `causality` — Why the compiler says no: the sequentially constructive model of computation, the
    initialise–update–read protocol between concurrent regions, causality cycles, write–write conflicts,
    instantaneous loops; reading KIELER's error messages and fixing them.

### Going further (`advanced/`)
13. `suspend` — Suspension: `suspend`, `immediate suspend`, `weak suspend`.
14. `history` — History and deferred transitions: `history`, `shallow history`, `deferred`.
15. `connectors` — Connector states.
16. `references` — Reusing charts: `state S is Other(...)`, `import`, bindings (explicit, by order,
    implicit), several charts per file, `region is`.
17. `for-regions` — Arrays and `for` regions.
18. `dataflow` — Dataflow regions.
19. `time` — Time: clocks (`clock`), Timed SCCharts, `period`, dynamic ticks (`deltaT`, `sleepT`), and
    counting an external timer input instead.
20. `methods` — Methods and code effects: SCL statements (`if`/`else`, loops, local variables, the
    semicolon rule), methods and what KIELER makes of them, `print`, `random()`.
21. `data-types` — Enums, structs and classes: enum values, struct and class instances, methods of a
    class, what KIELER rejects, and the differences in KIELER 0.3.0.
22. `annotations` — Comments in diagrams, labels, annotations and pragmas.
23. `host-code` — Host code: backticks, `extern`, `#hostcode`, host types and strings.
24. `code-generation` — From chart to C or Java: what the compiler generates (`reset`, `tick`, the
    `TickData` struct), a main loop on a microcontroller, netlist vs priority-based compilation.

### Patterns (`patterns/`), a cookbook of complete, explained charts
`abro`, `edges` (rising/falling edge, one-shot pulse), `debounce`, `counters` (counting ticks,
timeouts, frequency division), `latch` (remember a request until it's served), `modes` (switching modes
safely), `handshake` (request/acknowledge between regions), `watchdog`, `arbiter` (sharing a resource: fixed
priority and round robin, with a printer), `level-crossing` (a railway level crossing: the capstone that
uses almost everything; don't reproduce any course's assignment solution, so no traffic lights).

### Reference (`reference/`)
`cheatsheet` (all syntax on one page), `notation` (how every construct is drawn), `operators`
(expressions, precedence, assignment operators), `errors` (KIELER compiler messages explained, each with
a chart that triggers it and the fix), `troubleshooting` (from a symptom to its cause, and setup
problems), `glossary`, `further-reading`, `about` (how the guide is checked against KIELER).

### Playground (`/playground`)
Editor + live diagram + simulator, example library, shareable links (`#run=` links replay a run), a
Variables strip for the trace, KIELER's recorded words with "About this message" links, keyboard access to
the diagram (`src/components/playground/README.md`).

## Examples and scenarios

- One file per chart: `src/examples/<section>/<page>/<name>.sctx` (for instance
  `src/examples/learn/signals/emit.sctx`). Use descriptive chart names; keep them self-contained (no
  imports unless the page is about imports).
- A scenario next to it, `<name>.scenario.json`, drives the scripted walkthrough and the oracle check:

  ```json
  {
    "ticks": [
      { "inputs": { "A": false, "B": false }, "note": "Tick 1 enters the initial states. Nothing else can happen yet: the transitions are delayed." },
      { "inputs": { "A": true }, "note": "**A** is present, so ..." }
    ],
    "expect": "ok"
  }
  ```

  Notes are Markdown (inline only: `code`, **bold**, *italic*, [links](/x/), and backslash escapes such as
  `\*` for a literal asterisk; short code such as `->` never breaks across lines). Inputs persist (as in KIELER and SCCharts Lab): list an input again
  only when it changes, but always set every input in tick 1. `"expect": "error"` marks a chart that must
  be rejected, with `"errorIncludes": "<substring of KIELER's message>"`. A chart that imports other files
  lists them: `"imports": ["push-switch.sctx"]` (relative to the chart); the oracle and the widgets compile
  the chart with them. A file's first `scchart` is the one KIELER (and every widget) simulates.
- `pnpm oracle:record` runs every scenario through KIELER and writes `<name>.oracle.json` (values per
  tick). Commit the recordings. The engine tests compare against them.

## Components for MDX

Import what a page uses:

```mdx
import { Chart, Sim, Compare, Quiz, Predict, TryIt, KeyIdeas } from '~components/guide'
import Playground from '~components/Playground.astro'   // only on pages that use it (its CSS)
import HowKielerReads from '~components/HowKielerReads.astro'   // likewise
import { Aside, Tabs, TabItem, Steps } from '@astrojs/starlight/components'
```

- `<Chart example="learn/first-chart/toggle" />` — the diagram (pre-rendered SVG) with the source.
  Props: `code` (default `true`), `caption`, `highlight` (states or transitions to emphasise: ids such as
  `Toggle.On` and `Toggle.Off->1`, ids without the chart's name such as `Off->1`, or a unique state name
  such as `On`; a typo is a build error), `view` (`'diagram'`, `'code'` or `'both'`: the view shown first),
  `references` (`'collapsed'`, the default, KIELER's initial view; or `'expanded'`: each reference state
  `state S is Other(...)` is drawn with the referenced chart inside, and `highlight` can name its elements
  as `<reference state>/<id in the referenced chart>`, e.g. `Left/PushSwitch.On`).
  A chart KIELER rejects is drawn with the problem marked and the messages under it: the errors that make
  KIELER reject it first, each with the guide's explanation, **KIELER's exact wording** (from the oracle
  recording or the engine) and a hint; then KIELER's warnings, collapsed. An accepted chart lists KIELER's
  warnings (validation and compiler, e.g. "The transition is not reachable.") collapsed in the foot, and,
  prominently, what official KIELER does differently (`kieler-divergence`) or a verdict that changes from run
  to run (`kieler-nondeterministic`). "KIELER rejects this chart" appears only when KIELER does (its
  recording says so). Every error and warning that `reference/errors` explains gets an *About this message*
  link to its section (`src/components/frame/error-links.ts`; a test fails when a heading it links to is
  renamed, so tell the widgets workstream when you rename or add a message heading there). The elements a
  message is about are drawn with a solid red-orange outline and a small "!" marker.
- `<Sim example="learn/first-chart/toggle" />` — runnable chart: diagram, source, inputs, step /
  back / reset / run, and a waveform trace. Uses `<example>.scenario.json` when present (the reader can
  play the scripted tour or take over; during the tour the input switches show the inputs of the tick shown,
  the one its note is about). Props: `scenario` (another scenario file), `show` (variables to trace,
  default: inputs and outputs; name top-level locals here to trace them, what the compiler adds to the
  interface: `deltaT` and `sleepT` of a timed chart, the locals of inner states and regions, and members of
  instances: `show={['press', 'count', 'Outer.count', 'home.count']}`. An inner local is named
  `<state>.<name>` (the state path as the trace writes it, `Run.Cook.n`), or by its name alone when no other
  variable has it; a member as `instance.member`. A top-level name always means the top-level variable, so
  `count` is the output and `Outer.count` the local of `Outer` that shadows it; the lane is named `Outer.count`
  only when two lanes would share a name. A name that resolves to nothing, or to several inner locals, is a
  build error listing what is known), `caption`, `regions` (default `true`: one trace lane per
  region with its active state), `view` (as for `Chart`), `references` (as for `Chart`: with `'expanded'` the
  simulation highlights the referenced chart's states inside each reference state).
  A chart with `"expect": "error"` (or that KIELER's recording rejects) shows KIELER's messages instead of the
  controls; KIELER's warnings for an accepted chart are listed under the simulation, collapsed. A chart KIELER
  accepts that the guide's engine cannot run (host code, the priority-based compiler, a construct not
  implemented yet) shows a notice instead of the controls, never "rejected". A timed chart (`deltaT` input,
  `sleepT` output) gets **Advance by sleepT** next to the `deltaT` field: it sets `deltaT` to the `sleepT` of the
  tick shown and steps. A chart that imports others is compiled with them (the scenario's `"imports"`, else
  the `import "name"` lines that have a file next to the example).
- `<Compare a="…" b="…" caption="…" />` — two charts side by side, stepped together with the same inputs
  (the union of both charts' inputs; each chart gets the ones it declares); outputs both have are marked where
  they differ. **Guided tour**: `scenario` is `'a'` (the default: a's scenario, when it has one), `'b'` (b's),
  an example-style id of another scenario file, or `{false}` (free play from the start). The tour plays the
  scenario's inputs on both charts, with its per-tick notes, Previous / Next / Take over and "Restart the
  guided tour", as in `<Sim>`; write the notes about both charts (the foot also says which outputs differ in
  the tick shown, and which chart terminated: "`OnceBool` terminated in tick 2; `Once` did not."; the trace
  marks each chart's termination with a triangle in its own caption row). Also `references` (as for `Chart`) and
  `show` (as for `Sim`: the variables to trace, inner locals and members included; each chart traces the names it
  declares, and a local both charts have, at the same place, is compared like an output; a name neither declares
  is a build error). KIELER's warnings for either chart
  are listed under the simulation; timed charts get **Advance by sleepT** (the earlier deadline of the two).
- `<Playground example="…" />` — editable chart with live diagram and simulation (also `/playground`).
- `<Quiz question="…" options={["…", "…"]} answer={1}>Explanation (Markdown)</Quiz>`
- `<Predict example="…" ask={[{ tick: 3, value: "O" }, { tick: 3, state: "Done" }]} />` — the reader
  predicts, then the simulation runs the scenario and checks the answers. `value` asks for a variable's
  value after the tick (a pure signal: present or absent; a valued signal: its value); `state` asks whether
  a state is active (an id or a unique state name). Needs a scenario with at least that many ticks. `caption`
  is shown first in the widget's foot, above the inputs and the questions (it sets the question up: "`hold` is
  true in ticks 3 and 4. In tick 5, does …?"), not under the frame. `view` (`'code'`, the default,
  `'diagram'` or `'both'`) picks the view shown first: use it when the caption or the question is about the
  diagram (*Run and check* switches to the diagram unless the view shown has it). A chart
  KIELER rejects (its recording says so) is a build error; a chart KIELER accepts that the guide's engine
  cannot run is not: the `value` answers are checked against KIELER's recorded run (a `state` question then
  cannot be checked, and says so), with a notice.
- `<TryIt example="…" solution="…" title="…" hint="…">Task description</TryIt>` — exercise; opens the
  starter in a playground (with a solution, the link carries `&solution=<solution id>`, so the playground can
  compare the reader's chart with the model solution). Under the button, each in its own closed box: the starter's
  source, the hint, the solution. `title` names the exercise (the box's heading; default "Try it"). `hint` is
  optional, short inline Markdown (`code`, **bold**, *italic*, links; a blank line starts a new paragraph): a nudge
  towards the idea, not the answer ("Which state should remember that `A` was seen?"). Write identifiers in code
  spans, as in tour notes; inside a JSX attribute use `hint={'…'}` or `hint="…"` with `&quot;` for a double quote.
- `<KeyIdeas>` — bullet list summary at the end of a chapter.
- `<HowKielerReads />` — "How KIELER reads it": the reader types an expression, an effect or a trigger
  and sees KIELER's grouping fully parenthesised (`A > 2 ? A : 0` is `A > (2 ? A : 0)`) and as a tree, or
  the syntax error with a link to `reference/errors`. Buttons load the traps of `reference/operators` (the
  ternary, `->`, `fby`, `!`, `&`, a count delay, an `==` chain). Props: `initial` (the text shown first,
  server-rendered; default the first trap), `mode` (`'auto'`: an expression, else an effect; `'trigger'`:
  the text after `if`, where a leading number is a count delay), `seeds` (the buttons:
  `[{ label: '`->`', text: '0 -> I + 1', mode: 'trigger' }]`, `mode` optional; `[]` for none), `caption`.
  Import it on its own (see above). It belongs on `reference/operators`, near the precedence table.
- Fenced code blocks with the language `sctx` get SCCharts highlighting (for snippets that are not
  complete charts).

Every widget works with the keyboard and a screen reader without anything from the page (diagram elements,
code lines, the trace and "What happened" are reachable and named), and prints: diagram and code, and a
guided tour as its list of inputs and notes. So write captions and tour notes that make sense without
colour ("the active state", "the transition that fired", not "the red one"), and without the live panel (a
note says what happens in its tick, not "click Next"). `<Sim>`, `<Compare>` and `<Predict>` load their code
when the reader first points at, touches or tabs into them, so many widgets on a page cost nothing until
used.

## References

- KIELER wiki: https://github.com/kieler/semantics/wiki (Syntax, Timed Automata, Dataflow, Hostcode,
  Annotations and Pragmas, Object Orientation)
- von Hanxleden et al., *SCCharts: Sequentially Constructive Statecharts for Safety-Critical
  Applications*, PLDI 2014 — https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/pldi14.pdf
- von Hanxleden et al., *Sequentially Constructive Concurrency: A Conservative Extension of the
  Synchronous Model of Computation*, ACM TECS 2014 (DATE 2013).
- Motika, *SCCharts: Language and Interactive Incremental Implementation*, PhD thesis 2017, §3.1–3.2 —
  https://www.uni-kiel.de/journals/servlets/MCRFileNodeServlet/jportal_derivate_00001270/kcss_2017_02.pdf
- Smyth, Schulz-Rosengarten, von Hanxleden, *Practical Causality Handling for Synchronous Languages*,
  DATE 2019.
- Schulz-Rosengarten et al., *Polyglot Modal Models through Lingua Franca* / *Time in SCCharts*, FDL 2018 —
  https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/fdl18.pdf
- Berry, *The Esterel v5 Language Primer*; Harel, *Statecharts: A Visual Formalism for Complex Systems*, 1987.

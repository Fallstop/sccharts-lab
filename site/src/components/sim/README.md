# `src/components/sim`: the simulation panel

The guide's simulation UI as reusable parts. `<Sim>`, `<Compare>`, `<Predict>`, the landing chart and the
playground all use them. Owner: the widgets workstream.

```
SimPanel.svelte     inputs + controls + timing diagram + "What happened": one simulation, no diagram
Inputs.svelte       the input controls alone (used by SimPanel and CompareSim)
Sim.svelte          the <Sim> island: a SimPanel wired to the pre-rendered diagram and code of its frame
CompareSim.svelte   the <Compare> island: two charts stepped together (optionally a guided tour on both)
PredictSim.svelte   the <Predict> island: predictions, then "Run and check"
timeline.ts         pure: the history / cursor / branch / guided-tour model behind the controls
pair.ts             pure: two simulations as one Stepper (each chart gets its own inputs; the pool of both)
inputs.ts           pure: input controls from the interface (sticky levels, one-tick pulses, parsing)
trace.ts            pure: timing-diagram rows (inputs, outputs, valued signals, inner locals and members, one lane per region)
describe.ts         pure: "What happened" and "Explain this tick" text from a TickResult
lines.ts            pure: source lines of model elements, from the AST spans
link.ts             DOM: diagram highlight (with the firing pulse), code-line highlight, hover linking, keyboard access
engine.ts           the seam to src/engine (compile + createSimulation)
engage.ts           the `client:engage` directive: an island hydrates when the reader first engages with its widget
```

Nothing here imports `elkjs` or `~diagram/index` (layout): islands only toggle classes on SVG that was laid
out at build time. Import `~diagram/highlight` for `applyClasses` and `tickClasses`; never `~diagram/index`.

### Page weight and hydration

`<Sim>`, `<Compare>` and `<Predict>` hydrate with `client:engage` (`engage.ts`, registered in `astro.config.mjs`,
typed in `src/components/client-directives.d.ts`): when the pointer moves over the widget's frame, a touch,
focus inside it or a key, not when it scrolls into view. Until then a guide page loads only its page scripts
(Starlight's, Expressive Code's, and the diagrams' zoom, hover linking and keyboard access: about 16 kB gzipped,
inline scripts included); everything the reader sees first is server-rendered (diagram, controls, timing
diagram, the tour's first note). The controls are not disabled before hydration: a click made before the island
is live (a tap on Step, a submitted Predict form) is held and replayed on the same element once it is, so the
first tap is never lost; links are left alone. Hydration reuses the server-rendered nodes, so it moves nothing
(`tests/widgets/browser.test.ts` measures the layout shift: none). The landing chart keeps `client:visible`
(its opening replays when it comes into view).

Measured with a throwaway Vite production build of the islands (gzip, October 2026): the engine (parser,
validator, simulator, describe) and the trace code are one chunk of about 114 kB that every island shares (an
ES module: loaded once per page however many widgets it has), Svelte's runtime 16.5 kB, SimPanel with `<Sim>`
6.3 kB, Inputs and "What happened" 4.3 kB, `<Compare>` 5.3 kB, `<Predict>` 3.6 kB, the DOM helpers (`link.ts`)
2.9 kB. So the first widget a reader engages with costs about 145 kB, every further kind a few kB.

## `SimPanel`

```svelte
<script lang="ts">
  import SimPanel from '~components/sim/SimPanel.svelte'
  import { compile } from '~engine/index'
  import { markDiagram } from '~components/sim/link'   // applyClasses, leaving is-focus alone

  let source = $state('scchart Toggle { ... }')
  let svg: SVGSVGElement
  const compiled = $derived(compile(source))
</script>

<SimPanel {compiled} {source} recompile="replay" onhighlight={(classes) => markDiagram(svg, classes)} />
```

### Props

| prop | type | default | |
| --- | --- | --- | --- |
| `compiled` | `CompileResult` | required | from `compile()` in `~engine/index`. A new object restarts the simulation (see `recompile`). When `ok` is false the panel shows the diagnostics instead of the controls, and `onhighlight` receives `is-error` for every id in the diagnostics' `related`. |
| `source` | `string` | `''` | the chart's source text: needed for `view.lines` (source lines to mark), hover linking and the transitions' text in "What happened". Pass it. |
| `onhighlight` | `(classes: ClassMap, view: SimView) => void` | none | called whenever the shown tick changes (step, back, reset, a click in the trace, a new `compiled`) and once on mount. `classes` is `{ [elementId]: ('is-active' \| 'is-entered' \| 'is-exited' \| 'is-taken' \| 'is-error')[] }`; pass it to `applyClasses(svg, classes)`. |
| `onfire` | `(transitionIds: string[]) => void` | none | called after a *forward* step with the transitions that fired, for a one-shot pulse along them (`pulseTransitions` in `link.ts` does it). Not called on back / rewind / reset, nor under `prefers-reduced-motion`. |
| `onfocus` | `(ids: string[]) => void` | none | the reader points at something in the panel that names model elements (a line of "Explain this tick", a state in the trace): highlight them with `is-focus`. Called with `[]` when the pointer leaves. |
| `scenario` | `Scenario` (`src/components/frame/examples.ts`) | none | a guided tour: per-tick inputs and notes. The panel starts in tour mode (Next / Previous through the scripted ticks, the note of the current tick in the foot) until the reader takes over. During the tour the input controls show the inputs of the tick shown (the one its note is about; legend "Inputs of tick n of the guided tour"); Take over keeps them (inputs persist). A scenario with `"expect": "error"` is ignored. |
| `show` | `string[]` | interface | variables to trace. Default: inputs, then outputs; locals only when named here. Region lanes are always added. A name of KIELER's data pool (the interface) is that variable; anything else is looked up in the engine's `traceableVariables(compiled)` (`resolveShow` in `trace.ts`): an inner local by its key (`Chart.Outer$count`, what the playground's Variables strip passes), by `<state path>.<name>` (`Outer.count`) or by its name alone when no other variable has it, a member by `instance.member` (`home.count`). Their lanes read `SimTickResult.trace` and follow the top-level locals, in the order named; a lane takes the qualified name when two would share one. Names that resolve to nothing are left out (`<Sim>` and `<Compare>` fail the build instead: `frame/show.ts`). |
| `regions` | `boolean` | `true` | one timing-diagram lane per region with its active state |
| `recompile` | `'reset' \| 'replay'` | `'reset'` | what a new `compiled` does: `'reset'` starts again at tick 0 and keeps the input controls' values; `'replay'` replays the recorded inputs on the new chart up to the same tick (live editing) |
| `keys` | `HTMLElement \| null` | the panel's own controls | the element that gets the keyboard shortcuts while focus is inside it (Space / Enter / Right step, which replays a later tick after Back; Backspace / Left back; R reset). `<Sim>` passes its frame. Keys typed into a text or number field are left alone, and Space / Enter on a button keep their usual meaning. |
| `variant` | `'full' \| 'compact'` | `'full'` | `'compact'` drops Run and the speed control and shortens the foot (the landing chart) |
| `autoplay` | `number` | none | replay the scenario automatically, this many ms per tick, the first time the panel is visible (skipped under reduced motion; any reader action stops it) |
| `initialTicks` | `number` | `0` | run this many scripted ticks at once (also during server rendering, so the page shows them without JavaScript) |
| `intro` | `string` | | inline Markdown shown in the foot before the first tick |
| `handover` | `string` | | inline Markdown shown in the foot once the reader has control (after the tour or the autoplay) |
| `label` | `string` | chart name | accessible name of the control group ("Simulation of Toggle") |
| `id` | `string` | `$props.id()` | prefix for element ids inside the panel (unique per panel, stable between server and client) |
| `verdict` | `'recorded' \| 'engine'` | `'engine'` | who says a chart that does not compile is wrong. `'recorded'`: KIELER's recording of this very chart rejects it (an example as written): "KIELER rejects this chart, so it cannot run", "KIELER says:". `'engine'`: only the guide's checker has seen it (the reader's own or edited chart): "The guide's checker found a problem in this chart, so it cannot run", "KIELER rejects charts with this problem too.", "KIELER's wording:". Never claim KIELER saw a chart it did not. |
| `tourName` | `string` | `'Guided tour'` | what the tour is called: its label ("Test run, tick 3 of 7"), the inputs' legend ("Inputs of tick 3 of the test run"), "Restart the test run" and the end-of-tour sentence. The playground names its comparison replay "Test run" and a shared run "Shared run". |

`SimView` (the second argument of `onhighlight`):

```ts
interface SimView {
  cursor: number             // the tick shown (0 = before the first tick)
  tick?: TickResult          // the shown tick's result (undefined at 0)
  history: TickResult[]      // every tick computed, including ticks after the cursor (after Back)
  tour: boolean              // the guided tour is in control
  lines: { active: number[]; taken: number[]; error: number[] }   // 1-based source lines to mark
}
```

`lines` is what `<Sim>` marks in its Code view (the header line of each active state, every line of each
transition that fired, the lines of diagnostics). The playground can feed it to CodeMirror decorations.

### Methods (`bind:this`)

`step()`, `back()`, `forward()`, `reset()`, `goto(tick: number)`, `run()` / `pause()`, `takeOver()`
(leave the tour, keep the current tick), `restartTour()`, `advance()` (a timed chart: set `deltaT` to the
`sleepT` of the tick shown and step). All are no-ops while the chart is rejected; `step()`, `run()` and `advance()`
also while the simulation is stopped at a run-time error (below).

A timed chart (an input `deltaT` and an output `sleepT` in `compiled.interface`, structure.md S-35) gets an
*Advance by sleepT* button after the `deltaT` field (`Inputs`' `advance` prop).

Behaviour worth knowing: Back never throws ticks away. The later ticks stay in the trace (dimmed) and Step
replays them as they were; changing an input while behind the end makes the next Step branch (the engine
rewinds to the shown tick and runs the new inputs). The model is `timeline.ts` (unit-tested in
`tests/widgets/timeline.test.ts`). Run stops at termination, at a run-time error, at the end of the tour, and
when the panel scrolls out of view. The run speed is the only thing persisted (`localStorage`
`sc-sim-speed`).

A run-time error (`TickResult.error`: division by zero, an index out of range, ...) stops the simulation, as it
stops KIELER's: the engine repeats the error in every later step (`Diagnostic.tick` names the tick it happened in).
So while the last tick computed failed and is shown (`halted`), Step, Run, the tour's Next and the inputs are off,
and the foot (`div.sc-sim__halted`) says so and offers *Restart* (`button.sc-sim__restart`, `reset()`); Back still
goes back, and an input changed at an earlier tick runs a new tick from there (the engine rewinds to before the
error). Focus that was on Step, Run or Next moves to *Restart* (`keepFocus` with a target), and from *Restart*, which
goes with the error, to Step. The announcement adds "Step and Run are off: ...". `CompareSim` does the same once a
chart has stopped at an error and the other has stopped too (an error or termination).

### What it renders

Three blocks in a wrapper (a plain block), so in a `WidgetFrame` they sit like the frame's own `controls`,
`trace` and `foot` sections (put the panel in the frame's `panel` slot):

```
div.sc-sim                                  role=group; data-state="ready" | "rejected"
  div.sc-sim__controls                      the control bar (.sc-simctl ...)
    .sc-simctl__buttons                     Reset, Back, Step (.sc-btn--initial), Run / Pause, speed
    output.sc-simctl__tick                  "Tick 3" (+ "of 7" in the tour)
    fieldset.sc-simctl__inputs              one control per input (below)
  div.sc-sim__trace                         the timing diagram (renderWave); click a column to go to that tick
  div.sc-sim__foot                          tour note + Previous / Next / Take over, or "What happened",
                                            details "Explain this tick" (the log, in order)
  div.sc-visually-hidden[aria-live=polite]  one sentence per tick for screen readers
```

When `compiled.ok` is false the controls and trace are replaced by `div.sc-sim__errors` (each diagnostic:
line, message and hint with inline code rendered (`inlineCode`: code spans only, never literal backticks),
KIELER's wording when it differs, and *About this message*, `a.sc-diag__about`, from `errorLink`; the head
depends on `verdict`).

Under the trace, `p.sc-trace-legend` explains hatched (suspended) spans when the run has one. Region lanes come
one per for-region copy when the ticks report copies (`TickResult.copies`, or `CompileResult.forCopies` ahead of
the first tick); `trace.ts` documents the lanes.

The trace (`div.sc-sim__trace`, a region) is one tab stop: Left and Right go back and step, Home and End to
the first and last tick (the panel's keys). For screen readers it holds the values as a visually hidden table
(`table.wv-table` in a hidden `div.wv-table-wrap`: a row per tick, "Tick 3, shown", a column per lane, headed by its title) and hides the drawing
(`renderWave`'s `table` option, set by `traceSvg` and `compareSvg`). The "What happened" and "Explain this tick"
lines that name elements are one tab stop per list (Up and Down move, `roving` from `link.ts`); focusing a line
marks its elements, as pointing at it does.

Inputs, from `compiled.interface` (`input` variables; `const` ones are skipped):

| interface | control |
| --- | --- |
| `bool`, pure `signal` | `.sc-input--bool`: a switch that keeps its level (inputs persist, as in KIELER and SCCharts Lab) and a pulse button: *present for the next tick only* |
| `int`, `float` | `.sc-input--value`: a number field (`int` rounds towards zero, as C) |
| `string` | `.sc-input--value.sc-input--string`: a text field |
| valued `signal` | presence switch + value field (`V` and its value) |
| arrays | a text field, `1, 2, 3` (a shorter list sets the leading elements, as KIELER) |

### Inputs and KIELER

Inputs behave as in KIELER's simulator (`docs-internal/semantics/basics.md` B-9, B-10): an input keeps its
value until the environment changes it, including a value the chart itself wrote to it. So after each tick
the controls show the inputs' values in the data pool (the engine's `pool`; a pulsed input goes back to its
level), and a Step sends the engine only the inputs the reader changed. The guided tour sends exactly what
each scenario tick names. `tests/widgets/drive.test.ts` checks, on every example and conformance chart, that
the tour, a replay after Back, and a reader setting the same inputs by hand all give the run that feeding the
scenario straight to the engine gives.

Charts the engine cannot run (a diagnostic with code `unsupported`: an info on an accepted chart, or an error
in older engines) are not "rejected": the panel says the guide's simulator cannot run them, with the
engine's message and hint, without `is-error` marks.

## `CompareSim`

Props: `a`, `b` (`{ source, link, files? }`: the chart's source, the key of its pre-rendered diagram and code in
the frame, its imported files), `scenario` (a guided tour: the same scripted inputs on both charts, each getting
the ones it declares; notes, Previous / Next / Take over and "Restart the guided tour" as in SimPanel), `show`
(the variables to trace, as SimPanel's: each chart traces the names it declares; a local both charts have is
compared like an output). The difference line also says how the charts' termination differs
(`terminationText` in `trace.ts`), and each chart's termination is a triangle in its caption row of the trace. The
two simulations are one `Stepper` (`pair.ts`); after a tick the controls read each chart's own inputs from its
own data pool, so an input only one chart has keeps the value the reader set. `tests/widgets/drive.test.ts`
checks every `<Compare>` of the guide: the tour, and a reader setting the same inputs by hand, run each chart
exactly as the scenario's inputs fed to it alone.

## Classes for the diagram and code (`link.ts`)

`markDiagram(svg, classes, tick?, copies?)` applies a `ClassMap` (wraps `applyClasses`), puts the error markers on
(`markErrors`: a small disc with "!" beside each `is-error` state, region and transition) and, given the tick,
the for-region copy badges (`markCopies`: "×3" on each state of a for-region that is active in several copies,
from `TickResult.copies`), and updates the elements' accessible names. A for-region's state is named per copy
rather than with the union the diagram draws ("initial state Open, active in 3 of 4 copies (i = 1, 2 and 3), left in
this tick in the copy i = 0"; `copyMarks` and `copyPhrase` in `trace.ts`). `copies` (`CopyOptions`) gives the tick
before (`prev`, `null` before tick 1: the states left in each copy are worked out from it, since the engine reports
only each copy's active and entered states; without it the name keeps "left in this tick" for the union) and the
counters' names (`counters`, `copyCounters(compiled)` from `CompileResult.forCopies`). Pass the same to a diagram you
mark yourself (the playground: call `markErrors(svg)` and `markCopies(svg, tick, { prev, counters })` after
`applyClasses`).
`keepTickInView(trace)` scrolls a timing diagram only when the tick shown is out of view beside the sticky lane
names. `pulseTransitions(svg, ids)` runs a one-shot pulse along the given transitions (a clone of `.sc-edge`
with class `sc-edge-pulse`, removed when its animation ends; nothing under reduced motion). `markCode(container,
lines)` puts `is-active`, `is-taken`, `is-error` on Expressive Code's `.ec-line` rows, each with its mark as
visually hidden text for screen readers (`span.sc-line-status`, "(active state)"). `linkHover(view, code, map,
root)` links pointing and keyboard focus between diagram elements and code lines (`is-focus` on both sides).
`focusElements(svg, code, map, ids)` sets `is-focus` by hand (Sim's and Compare's "What happened" lines).

## Keyboard and screen readers (`link.ts`)

`DiagramView` calls these on every pre-rendered diagram, so `<Chart>`, `<Sim>`, `<Compare>`, `<Predict>` and the
landing chart all have them:

- `enableDiagramKeys(svg, map, root, hintId)`: the SVG becomes a `graphics-document` (labelled by its title,
  described by its `desc` and a hint, "Use the arrow keys ..."); its states, named regions and transitions get
  `role` `graphics-object` (containers) or `graphics-symbol`, `data-sc-nav` (their order: as written in the
  source) and an accessible name from `map.names` ("initial state Off", "transition Off to On: if button go to
  On"; else from the text drawn, for an expanded reference's elements) followed by the simulation's marks ("active",
  "entered in this tick", "left in this tick", "fired in this tick", "has an error"; `elementLabel`,
  `refreshNames`). They form one tab stop (a roving tabindex): the arrow keys move to the next / previous one
  (the simulation's Left and Right do not apply in a diagram), Home and End to the first and last; focus links
  like hover, and a ring (`rect.sc-focus-ring`, drawn around the element's geometry, since Chrome draws CSS
  outlines of SVG groups around a rough estimate of their strokes) shows where the keyboard is. Space and Enter
  still step. Listeners sit on the SVG's parent: Chrome makes an SVG element with focus listeners a tab stop.
- `enableCodeKeys(code)`: the source lines that have text are one tab stop, Up and Down move, Home and End;
  focusing a line marks the element written there.
- `rovingFocus(container, items, keys)` and the Svelte action `roving` (`use:roving={'li[data-linked]'}`): one
  tab stop over changing items, Up and Down (or all arrows), Home and End.
- The Svelte action `keepFocus` (`use:keepFocus` or `use:keepFocus={() => target}`): when a button turns itself off
  while it has focus (or just after it was used, focus having dropped to the page), focus goes to the target when
  that is an enabled button, else to the nearest enabled button beside it. Back and Previous at tick 0; Step, Run and
  Next at a run-time error, with *Restart* as the target.

Names come from `lineMap()` (`LineMap.names`, `lines.ts`), which DiagramView serialises with the map.

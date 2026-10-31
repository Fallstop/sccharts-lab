# `src/components/playground`: the playground

The in-browser SCCharts IDE at `/playground` (`src/pages/playground.astro`) and the inline `<Playground example="…" />`
of guide pages (`src/components/Playground.astro` renders `PlaygroundInline.astro`). Owner: the playground workstream.

## What it does

- **Editor** (CodeMirror 6, `editor.ts`): SCTX highlighting in the guide's code colours (`sctx-tokens.ts`, a line
  tokenizer that follows the engine's lexer and KIELER's comment quirks; colours from `src/highlight/code-themes.mjs`
  via `code-colours.ts`), indentation that knows SCTX (braces, transitions under their state), brace folding, bracket
  matching and closing, comment toggling, search, lint squiggles and gutter marks, a problems list, completion and
  hover cards (`editor-features.ts`, `analysis.ts`, `keyword-docs.ts`), go to declaration (F12, Ctrl/⌘-click).
- **Diagram** (`diagram-view.ts`, `layout-service.ts`): `layoutChart` (from `src/diagram/layout`, never the bundled
  ELK) with ELK in a Web Worker (elk-api + elk-worker), latest request wins; pan (drag, wheel, arrows), zoom (Ctrl/⌘ +
  wheel, pinch, + and −). A chart opens whole, fitted to the stage in both dimensions, as long as that is at least
  50 % (KIELER's names at about 7 px; every chart of the guide up to ABRO's size fits at 1280 × 900); one that would
  fit at 40 % opens at 50 % from its top left, nearly whole, and a larger one at 70 % from its top left, readable (the
  reader pans; Fit, the button or 0, shows the whole chart however small). The
  view is sticky until the reader pans or zooms. While the source has a syntax error the last good diagram stays,
  dimmed, with a badge; but a diagram of another chart goes (a chart loaded from a link, a file or the menu that has
  not parsed yet, or a new chart typed over the old one: the `scchart` names of the text no longer include it), and the
  stage says that the diagram appears once the chart parses. Validation errors draw the new diagram with `is-error` on
  the elements named, each with the widgets' "!" marker (`markErrors`); a for-region's states active in several copies
  get the widgets' "×n" badge and "active in 3 of 4 copies" in their names (`markCopies`). Click an element: its source
  is selected (a comment box: its doc comment). The element under the editor's cursor gets `is-focus`; hovering an
  element marks its source. On a phone the diagram's head is the chart's name and its six tools at full size (the
  "Diagram" heading is said to screen readers only: the tab names it; below 24rem the zoom read-out goes).
- **The diagram from the keyboard** (both the page and the inline playground, as the widgets: `enableDiagramKeys`
  and `refreshNames` from `src/components/sim/link.ts`): after the stage's own tab stop (pan and zoom), the chart's
  states, named regions and transitions are one more, the arrow keys move between them in source order, Home and
  End; each is named ("transition Off to On: if button go to On") with the simulation's marks ("active", "fired in
  this tick"). Focusing one marks it and its source; on /playground Enter selects its source (on a guide page Space
  and Enter step, as in the widgets). A new layout keeps the focused element.
- **Outline** (the list button in the diagram's head): the chart as nested buttons (regions, states, transitions
  with their labels), for the keyboard and screen readers, as the widgets' `<svg>` has a title and a description:
  focusing one marks it in the diagram and its source (as hovering does), Enter selects its source, the arrow keys,
  Home and End move, Escape closes. States the simulation marks active and transitions it marks taken are marked
  there too (and named in the buttons' labels), and a for-region's state with the number of copies it is active in.
- **Simulation**: the widgets' `SimPanel` (`src/components/sim`), mounted by `sim-host.svelte.ts`. Live until the first
  step; after that an edit shows **Rebuild**, which replays the recorded inputs on the edited chart when its inputs and
  outputs are unchanged (and starts again otherwise). Active states and fired transitions are marked in the editor too.
  On wide screens the editor and the diagram open with 62 % of the first screen below the toolbar (at least 18rem;
  `MAIN_SHARE`, and the same in playground.css before the app loads), so that the chart shows whole; the panel is as
  tall as its controls and timing diagram (every lane in view, up to 36rem; more scrolls inside), and the page grows
  when both do not fit. The splitter above the panel (drag, arrow keys) sets a height of the reader's own (the editor
  and the diagram may then shrink to 18rem), remembered in local storage, and a double click or Enter on it fits the
  content again. On phones the Simulate tab shows the diagram above the whole
  panel and the page scrolls.
- **Guided tour / Free play**: an example with a scenario (`<example>.scenario.json`) offers its guided tour (SimPanel's
  `scenario`) with a switch in the panel's head. The guide's examples open in the tour; the showcase charts, exercise
  starters and charts without a scenario open in free play (the tour one click away). The switch follows the panel
  (Take over and "Restart the guided tour" in it count). The switch says what the panel says: "Guided tour"
  ("Guided tour, tick 3 of 7"), "Test run" when the tour replays the comparison's test run, "Shared run" for a shared
  run; the name is passed as SimPanel's `tourName`, and the switch's title and the panel's intro say what it replays.
- **Variables** (in the simulation's head): a strip of check boxes under it, one per variable of the chart
  (`variables.ts`: inputs, outputs, the chart's locals, time: clocks and the `deltaT` / `sleepT` KIELER adds),
  passed to SimPanel as `show`; the trace follows each change at once. The locals of inner states and the members of
  class and struct instances are offered too (their key, which SimPanel resolves with `traceableVariables`). The
  default is KIELER's data pool: inputs, outputs and top-level locals (also on the inline playground).
- **Watch and Run until** (under the check boxes, `watch.ts`): the value, in the tick shown, of an expression over the
  data pool (`count >= 3 && !done`, `pre(x) != x`, `val(level) / 2`), remembered per chart. The guide's engine
  evaluates it, so it means what it would in the chart (C's integer division, int and float mixing, `pre`): the
  expression becomes a chart of its own, with the names it reads as inputs and one output set by a chart-level
  `immediate during`, run on the pool of the tick (and of the ticks before it, for `pre`; no value before then).
  It reads the data pool by name and, from the engine's trace (`SimTickResult.trace`, by `traceableVariables`' key),
  the locals of inner states (`Outer.count` as the widgets' `show` writes them, or the name alone when no other
  variable has it; a valued one as `val(Outer.v)`) and the members of instances (`home.count`); an enum value
  (`Speed.HIGH`) is its position, as KIELER's Enum processor makes it. Not strings (KIELER's C compares them as
  pointers, B-26). **Run until**
  steps, as Step does with the inputs as they are set, until the watch holds or a chosen state is active (at most
  1000 ticks; the button stops it), and stops where the chart terminates, fails, or the guided tour ends; a toast
  says where and why. It steps the panel with `SimHost.stepNow` (step, then Svelte's `flushSync`). The choice is remembered per chart name in local
  storage (guarded; the default is not stored; a variable added since gets its default). Escape closes the strip.
- **Copy link to this run** (in the simulation's head): the link carries the inputs of every tick computed
  (`share.ts`, `&run=`, lz-compressed, only the changes per tick) and the tick shown, next to the chart (the example
  as it is: `?example=<id>#run=`; else `#code=...&run=`). The inputs are the engine's `TickResult.ranWith` (what
  each tick read, before the chart wrote any of its own inputs), found by `runInputs` (`run-tour.ts`), which replays
  them to check and the toast says from which tick a replay would differ. Opening the link replays the run as a
  tour through it (the machinery of the comparison's "Show tick N"), at the tick shown, each note saying which
  inputs changed and, for a chart with up to six inputs, where the others stand ("In this tick `A` is absent and `B`
  is present; `R` stays absent."); a toast with **Take over** says so. A damaged run is reported and the chart opens
  without it.
- **Trust**: a line under the page's description (and the first section of the help popover, the `?` button):
  the playground runs the guide's own reimplementation of KIELER; for work you hand in, confirm the result in
  SCCharts Lab or KIELER; links /reference/about/. On a phone it is one line ("The guide's own simulator, not KIELER.
  How it is checked"). The help popover also points to Troubleshooting and Compiler messages ("When a chart
  misbehaves").
- **Site menu**: the page has Starlight's sidebar, for its menu button on phones (the guide's navigation, from the
  playground too); from 50rem on the sidebar is hidden and the app takes the whole width (playground.css). SimPanel's `verdict` is `'recorded'` for an example as written
  whose recording agrees with what the panel shows ("KIELER rejects this chart" is then KIELER's word), else
  `'engine'`.
- **Exercises** (`compare.ts`): TryIt links open `?example=<starter>&solution=<solution id>`. When the solution has a
  scenario and an oracle recording, the toolbar offers **Compare with the model solution**: the reader's chart (as it
  is now) runs on the scenario's inputs and every output the solution declares is compared, tick by tick, with KIELER's
  recording (a valued signal's value only in the ticks it is emitted). The panel names interface mismatches (missing
  inputs or outputs, wrong types or kinds), compile errors, the ticks that match, the first difference in plain words
  ("In tick 3 your `elapsed` is 0; the model solution has 1.") with a table of that tick's outputs, and offers to show
  that tick in the simulator (the test run's inputs as a tour). A chart the guide's simulator cannot run (KIELER can:
  host code, a construct not implemented, an `unsupported` diagnostic or a tick that reaches one) is not compared:
  "Your chart cannot run in the browser, so it cannot be compared here.", a caution with the reason and its line. It
  is worded as a comparison, not a grade. The
  solution's source is shown only on request ("Show the model solution"). Edits keep `?solution=` in the address bar.
- **The exercise's task** (`exercises.ts`): with `&solution=`, a banner under the toolbar shows the TryIt's title and
  task, as on its page, with a link back to the section of the page it is in. `findExercises` collects every
  `<TryIt>` at build time (playground.astro, from the docs collection: the MDX source and the anchors Astro gave the
  headings, `render(entry).headings`), as JSON in `[data-pg-exercises]`; `exerciseFor` finds the link's exercise by
  starter and solution, or by the solution alone (an edited exercise's address keeps only `?solution=`). The banner
  folds to its title row (the choice remembered; folded at first on a phone). An exercise whose starter already
  behaves as its model solution on the test run, with the same interface (it asks for a new structure: comments and
  labels, an enum, a for-region), says "This is still the starter" while the chart is unchanged, in the banner and as
  the comparison's result instead of a "match".
- **Examples** (`catalogue.ts`, `sources.ts`, `showcase/`): every chart in `src/examples` (not `design/`), grouped by
  section and page in the order the page uses them, with the page's title; exercise solutions are left out of the
  menu (`?example=` still opens them). The showcase charts are verified with KIELER (`*.oracle.json`; re-record with
  `pnpm oracle:record src/components/playground/showcase`).
- **Sharing** (`share.ts`): `#code=<lz-string>` links, Copy link, Download (`<Chart>.sctx`), Open (and drop) a file,
  autosave of the scratch buffer in local storage (wrapped; the playground works without storage). Edits keep the
  address bar up to date (`history.replaceState`), so a reload never loses work. The scratch buffer holds the reader's
  own last edits: loading a chart (the menu, a file, a link, New) saves the edits not yet saved first and does not
  overwrite them with the loaded text.
- **Links followed in an open tab**: a `#code=` or `#run=` pasted into the address bar of an open playground, and
  Back and Forward between such addresses, change only the hash, so the page does not load again; boot.ts listens to
  `hashchange` and `popstate` and opens the address's chart (and run) as the page does on load (`linkTarget`, then
  `Playground.openLink`), with Undo. An address without a chart (Back to the bare /playground/) opens the reader's
  last chart. The edits of the chart before are in the scratch buffer and in its entry of the history, so the toast
  says that Back or Undo returns to them.

- **KIELER's words** (`recorded.ts`): every problem shows the engine's message, its hint and KIELER's wording
  ("KIELER's wording": `Diagnostic.kieler`). For a guide example opened as it is, KIELER's recording
  (`<example>.oracle.json`) is paired with the engine's problems (the same text, else the same line and severity:
  "KIELER says", what KIELER said about this very chart), and what only KIELER reports is listed too, in KIELER's
  words (recorded severities are LSP numbers: 1 error, 2 warning), without EMF's noise. Edited, the chart is the
  reader's: the engine's diagnostics alone. Each problem links to its section of /reference/errors/ ("About this
  message", `errorLink` from `src/components/frame/error-links.ts`), in the problems list and the editor's lint card.

## Start-up

`playground.astro` renders, at build time, the default chart's source with the editor's tokenizer
(`static-highlight.ts`, the same metrics as CodeMirror), its diagram (`chartToSvg`) and the example menu as links, so
the page paints at once and works without JavaScript. `boot.ts` (small, eager) picks the chart (hash, `?example=`,
scratch buffer, default), wires the popovers and phone tabs, fits the build-time diagram, then imports `app.ts`
(CodeMirror, the engine, the diagram client). The inline playground boots the same way when the reader first engages
with its frame (a click, a touch, a key or focus inside it, as `client:engage` does for the widgets; the pointer over it
fetches the code ahead), so a reader who only scrolls past loads none of it. `PlaygroundInline.astro` renders every
part at its final size, so nothing moves when it starts: the code with every line CodeMirror shows, the diagram where
DiagramView's first fit puts it (the stage as tall as the chart drawn as wide as it allows, at most 100 %, below the
zoom buttons), and the simulation panel itself (SimPanel with the props the app mounts it with). A click on that
panel's controls before the app is live is held and made again on the same control of the live panel, and keyboard
focus moves with it (`bootOneInline` in boot.ts). Without JavaScript a note ("Turn on JavaScript to edit this chart
and run it here.") takes the place of the editor's status and the panel. A reader tabbing through the page is not
caught in the inline editor: focused other than by a pointer (Tab, or the build-time code's focus handed over when the
app starts), its Tab and Shift+Tab move on until the reader presses another key or clicks into the code (CodeMirror's
tab-focus mode, `app.ts`); /playground keeps the editor's own Tab (Escape, then Tab, leaves it).

## Markup contract (`app.ts` looks these up inside its root)

`[data-pg-editor]` (editor host; holds `[data-pg-static]` before load), `[data-pg-problems]` with
`[data-pg-problems-toggle]`, `[data-pg-problems-summary]`, `[data-pg-problems-list]`; `[data-pg-diagram]` (gets
`is-stale`), `[data-pg-stage]` (with `[data-pg-static-diagram]`, `[data-pg-badge]`, `[data-pg-busy]`,
`[data-pg-empty]`, `[data-pg-diagram-keys]`: the hidden keyboard hint the diagram is described by); `[data-pg-sim]`
(SimPanel mount), `[data-pg-sim-note]`, `[data-action="rebuild"]`; buttons `[data-action]` = `new | open | download |
share | share-run | restore | zoom-in | zoom-out | zoom-reset | fit | outline | export-svg`; page only:
`[data-pg-title]`, `[data-pg-tabs]`, `[data-pg-split]`, `[data-pg-hsplit]`, `[data-pg-chart]`, `[data-pg-toast]`,
`[data-pg-mode]` (tour switch), `[data-pg-vars-toggle]` with `[data-pg-vars-count]` and the strip `[data-pg-vars]`
(the check boxes in `[data-pg-vars-list]`; `[data-pg-watch-input]`, `[data-pg-watch-value]`, `[data-pg-until]`,
`[data-pg-until-run]`),
`[data-pg-compare]` with `[data-pg-compare-panel]`, `[data-pg-outline]`, `[data-pg-help]`, the exercise's task
`[data-pg-task]` (`[data-pg-task-toggle]`, `[data-pg-task-title]`, `[data-pg-task-starter]`, `[data-pg-task-back]` with
`[data-pg-task-page]`, `[data-pg-task-text]`) and its data `[data-pg-exercises]`.
`root.playground` is the `Playground` instance (for tests and the console).

## Tests

```sh
pnpm exec vitest run tests/playground                       # tokenizer, language, share links, queries, catalogue,
                                                            # the comparison with model solutions, shared runs
                                                            # (every example's run replays the same), variables,
                                                            # KIELER's recorded words, the exercises' tasks,
                                                            # the watch
PLAYGROUND_E2E=1 pnpm exec vitest run tests/playground/e2e.test.ts   # Chromium against the dev server
```

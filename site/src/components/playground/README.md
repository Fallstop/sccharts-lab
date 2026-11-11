# `src/components/playground`: the playground

SCCharts Lab's in-browser IDE for SCCharts at `/playground` (`src/pages/playground.astro`), and the inline
`<Playground example="…" />` of guide pages (`src/components/Playground.astro` renders `PlaygroundInline.astro`, a
compact single-file widget). Owner: the playground workstream.

## The page

`/playground` is a full-window app (no page scroll; `styles/shell.css` fixes it to the viewport):

```
┌ app bar ── mark (home) · Guide · Project ▾ · page link ……… Compare · Examples ▾ · Copy link · search · ? ┐
├ the exercise's task (a TryIt link only; folds) ────────────────────────────────────────────────────────┤
├ files ┊ ┌ tabs: a.sctx  b.sctx ─┐ ┊ ┌ Diagram  Chart  − 64 % + ⤢ ≣ ▣ ┐                                      │
│ a     ┊ │ editor                │ ┊ │ stage                          │                                      │
│ lib/  ┊ │ ● No problems  Ln 3   │ ┊ └────────────────────────────────┘                                      │
│   b   ┊ ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┴┄┴┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│       ┊ │ Simulation · Problems 2 · Console 3           (the tab's tools: Guided tour | Free play, …)  │
│       ┊ │ the tab's panel                                                                              │
└───────┴─┴──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **App bar**: the SCCharts Lab mark (the home page); **Guide**, the guide's menu: Starlight's sidebar, as a popover
  drawer at every width (`setupGuide` in boot.ts keeps its `popover` attribute on wide screens too; Starlight's
  header is hidden on this page and its search, `<site-search>`, is moved into the app bar while the page is parsed,
  with Ctrl+K); the **project** (its name, "edited", the menu: rename, New chart, New file, Open files, Open folder,
  Download, Download as .zip, Revert, the recent projects in this browser; `page/ProjectMenu.astro`,
  `project-menu.ts`); the example's guide page; **Compare with the model solution** (exercises); **Examples**;
  **Embed** (a dialog that writes the code to put the chart on another page, `src/components/embed/dialog.ts`);
  **Copy link** (the whole project); search; **help** (`?`, `page/HelpMenu.astro`: shortcuts, projects, the diagram,
  the panel, where to go when a chart misbehaves, About the simulator, Report a mistake). On phones the bar keeps its
  icons (the labels stay for screen readers).
- **Workspace** (from 60rem): the files sidebar (open by default for a project of several files; the reader's
  choice is remembered; its width too), the editor with its tabs and status bar | the diagram (a splitter, its
  fraction remembered), and under both the bottom panel (a splitter: it fits the simulation, every lane of the timing
  diagram in view, up to 55 % of the workspace; dragging or the arrow keys set a height of the reader's own,
  remembered; a double click or Enter fits again). `workspace.ts`. The simulation is in view at 1280 × 800.
- **Phones** (below 60rem): one pane at a time, with tabs: Code (the editor, its tabs; the files are a sheet opened
  from the button before the tabs), Diagram, Simulate (the diagram above, the bottom panel below, its tools on a row
  of their own).
- **No JavaScript**: the build-time code, its diagram, the example links, the Guide drawer and help (popovers and
  `<details>` work without scripts) and a note in the panel; on phones the page then scrolls, one part after another.

## What it does

- **Editor** (CodeMirror 6, `editor.ts`): SCTX highlighting in the guide's code colours (`sctx-tokens.ts`, a line
  tokenizer that follows the engine's lexer and KIELER's comment quirks; colours from `src/highlight/code-themes.mjs`
  via `code-colours.ts`), indentation that knows SCTX (braces, transitions under their state), brace folding, bracket
  matching and closing, comment toggling, search, lint squiggles and gutter marks, a problems list, completion and
  hover cards (`editor-features.ts`, `analysis.ts`, `keyword-docs.ts`), go to declaration (F12, Ctrl/⌘-click).
- **Diagram** (`diagram-view.ts`, `layout-service.ts`): `layoutChart` (from `packages/diagram/src/layout`, never the bundled
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
  "Diagram" heading is said to screen readers only: the tab names it; below 24rem, and in the Simulate tab, the zoom
  read-out goes, so that the name stays whole).
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
  It is the bottom panel's Simulation tab; its tools (the tour switch, the "source changed" note, Rebuild, Variables,
  Copy link to this run) sit in the panel's head. Stepping from the keyboard (Ctrl/⌘+Enter) shows the tab. It
  simulates the active file; once a run has started, showing another file keeps the run (the note says "This run is
  of a.sctx", and Rebuild starts the file in the editor).
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
  says where and why. It steps with `SimHost.stepQuietly`, which runs a tick without
  re-rendering, and draws with `SimHost.settle` every 100 ms and at the end (1000 ticks take about 0.1 s). The choice is remembered per chart name in local
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
- **The help** (`?`) ends with Troubleshooting, Compiler messages and "About the simulator" (/reference/about/); the
  page carries no caveat of its own. SimPanel's `verdict` is `'recorded'` for an example as written whose recording
  agrees with what the panel shows ("KIELER rejects this chart" is then KIELER's word), else `'engine'`.
- **Problems**: a status bar under the editor (a coloured mark, the counts and the first problem; a click opens the
  Problems tab) and the list in the bottom panel's Problems tab, its count as the tab's badge (coloured by the worst
  severity). The inline playground keeps its folding list under the editor. `problems.ts`.
- **Console** (the bottom panel's Console tab, `Console.svelte`, `console-tab.ts`): what the simulated chart prints
  with `print(...)` (`TickResult.printed`), each line with its tick; it follows the run (the tick shown in view, later
  ticks dimmed after Back), Clear hides the lines so far, Copy copies the lines shown with their ticks; the badge
  counts the lines up to the tick shown.
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
- **Projects** (`project.ts`, the model; `project-control.ts`, the open project): a set of `.sctx` files by path
  (`main.sctx`, `lib/beep.sctx`), the active one in the editor (each file keeps its own editor state while the project
  is open: undo history, selection), open in tabs (`FileTabs.svelte`; closing a tab keeps the file), listed in the
  files sidebar (`FileTree.svelte`, folders as rows: new file, rename in place (double click, F2), delete with Undo;
  names checked as typed, `checkName`). The active file is compiled with the files it imports, transitively
  (`importedFiles`: KIELER's `import` rules, `structure.md` S-20; a chart of a file that is not imported stays
  invisible, as in KIELER, because the engine makes every file it is given visible), keyed relative to its folder.
  The diagram and the simulation follow the active file (the chart select picks another chart of it). An example that
  imports files (`loadImports`) opens as a project of its file and those. A project keeps at least one file; an
  empty folder starts with `main.sctx`.
- **Saving** (`project-control.ts`, `project-store.ts`): every edit is saved after a pause in typing: in the browser
  (IndexedDB, guarded: the playground works the same without it; the 40 most recent projects), in the scratch buffer
  of local storage (the active file's text; boot falls back to it without IndexedDB), and in the address bar
  (`#code=` for one file, `#project=` for several; `history.replaceState`), so a reload never loses work. A project
  is saved under an id only once the reader edits it: loading an example, a link or a file saves nothing, so it never
  overwrites the reader's work, and the project before it stays in the recent list. Loading saves the edits not yet
  saved first, and the toast offers Undo.
- **Files on disk** (`folder.ts`): **Open folder** (the File System Access API, Chromium) reads a folder's `.sctx`
  files (two levels down, at most 200, none over 2 MB) into a project backed by it; Ctrl/⌘+S (or Save in the
  sidebar's folder bar) writes the files that differ from the disk and removes those deleted or renamed since; unsaved
  files have a dot. The handle is stored with the project, so after a reload the folder bar offers Reconnect (the
  browser asks again). Elsewhere: **Open files** (several `.sctx` files, or a `.zip` of a project), **Download** (the
  `.sctx`, or the project as a `.zip`, fflate loaded on demand), drop files on the editor.
- **Sharing** (`share.ts`): `#code=<lz-string>` links (one file), `#project=<lz-string>` (several: name, active file,
  every file), Copy link (Ctrl/⌘+Shift+S); a shared run of a project carries the project (`#project=…&run=…`).
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
(`static-highlight.ts`, the same metrics as CodeMirror), its diagram (`chartToSvg`), the bottom panel's strip and the
simulation's placeholder, and the example menu as links, so the page paints at once and works without JavaScript.
`boot.ts` (small, eager) picks the project (`#project=`, `#code=`, `?example=` with its imports, else the reader's
last project in IndexedDB, else the scratch buffer, else the default), shows its active file in the build-time code,
tabs and files, wires the popovers, the phone tabs and the Guide drawer, fits the build-time diagram, then imports
`app.ts` (CodeMirror, the engine, the diagram client). The inline playground boots the same way when the reader first engages
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

## Code

| File | What |
| --- | --- |
| `boot.ts` | the first script: which project to open, the static first paint, popovers, phone tabs, the Guide drawer, links followed in the tab; the inline playground's engage-on-interaction start |
| `app.ts` | `Playground`, the hub: the editor, the compile loop, loading (`loadProject`, `openLink`, `loadExample`, Undo), the title; owns the parts below |
| `app-types.ts` | `Origin`, `ProjectSpec`, `PlaygroundInit`, `LinkTarget`, `Analysed`, small helpers |
| `project.ts`, `project-control.ts`, `project-store.ts`, `project-menu.ts`, `folder.ts` | projects: the model, the open project (files, editor states, tabs, saving), IndexedDB, the project menu, files on disk |
| `diagram-control.ts`, `outline.ts`, `diagram-view.ts`, `layout-service.ts` | the diagram: layout, stale state, classes, keyboard, the link with the source; the outline; the stage; ELK's worker |
| `problems.ts` | squiggles, the status, the list, KIELER's recorded words, the verdict |
| `sim-control.ts`, `variables-strip.ts`, `watch-strip.ts`, `sim-host.svelte.ts` | the simulation: SimPanel, tours, Rebuild, sharing a run; the variables; Watch and Run until |
| `exercise.ts` | the task banner and Compare with the model solution |
| `panel.ts`, `panel-tabs.ts`, `console-tab.ts`, `Console.svelte` | the bottom panel and its tabs |
| `model.svelte.ts` | `PlaygroundModel`: what the Svelte parts and the panel's tabs read |
| `FileTree.svelte`, `FileTabs.svelte` | the files sidebar, the editor's tabs |
| `workspace.ts`, `tabs.ts`, `file-actions.ts`, `toast.ts` | splitters and heights; the phone tabs; actions and keys; the toast |
| `page/*.astro` | the page's parts: app bar menus, the task banner, the bottom panel |
| `../embed/` | the embed (`/embed/`, `src/pages/embed.astro`): these parts in 'embed' mode in an iframe, its postMessage API, and the app bar's Embed dialog (`packages/embed/README.md`) |
| `styles/page.css`, `styles/embed.css` | the two entry points (/playground, the inline playground), importing `styles/*.css` by area; `tokens.css` holds the playground's own tokens (surfaces, lines, sizes), so a dark theme is one more set of values |

## The bottom panel's tabs: adding one

The tabs are a registry, `PANEL_TABS` in `panel-tabs.ts`. `page/BottomPanel.astro` renders a tab button, a tools slot
(in the panel's head) and an empty panel for each entry at build time; `panel.ts` mounts a tab's content the first
time it is shown (or at start, `eager: true`). A "Trace" or a "C code" tab is one entry and one module:

```ts
// panel-tabs.ts
{ id: 'c', label: 'C code', mount: (host, ctx) => import('./c-code-tab').then(m => m.mount(host, ctx)) },

// c-code-tab.ts
import { mount as mountSvelte } from 'svelte'
import CCode from './CCode.svelte'
import type { PanelTabContext } from './panel-tabs'
export function mount(host: HTMLElement, ctx: PanelTabContext) {
    const app = mountSvelte(CCode, { target: host, props: { model: ctx.model } })   // reads ctx.model.compiled
    return () => unmount(app)
}
```

The tab's context (`PanelTabContext`): `model` (below, reactive), `tools` (an element in the panel's head for the
tab's buttons, shown with the tab), `setBadge(value, words, state)`, `reveal(path, from, to)` (select a range of a file
in the editor), `toast(message)`, `visible` and `onShow(listener)`. Keep `panel-tabs.ts` free of browser code at its
top level (the page imports it at build time).

## What a tab can read: `PlaygroundModel` (`model.svelte.ts`)

Svelte 5 state (`$state.raw`), written by the controller only. A Svelte component reads the fields directly; plain
code subscribes with `watch(() => model.compiled, c => …)`.

| Field | What |
| --- | --- |
| `project` | `{ name, files, active, open, unsaved, folder?, disconnected? }`: the files sorted as listed, the active one, the tabs |
| `compiled` | `{ file, source, result }`: the newest compile of the active file (`result` is `compile(source, { files })`, with the files it imports) |
| `problems` | its problems (the engine's diagnostics, with KIELER's recorded words for an example as written) |
| `simulation` | `{ file, source, result }`: what the simulation runs (another file than the active one while a run of it lasts) |
| `simView` | `{ cursor, tick, history, tour, lines }`: the tick shown and every tick computed (`TickResult`s with `printed`, `ranWith`, `values`, the engine's `pool` and `trace`) |

The controller (`root.playground`, for tests and the console) also has `project.texts()` (every file's text now),
`project.imports()` (what the active file's compile gets) and `sim.host` (the panel's `SimHost`).

## Markup contract (`app.ts` and its parts look these up inside their root)

Both: `[data-pg-editor]` (editor host; holds `[data-pg-static]` before load), `[data-pg-problems]` (gets
`data-state`) with `[data-pg-problems-toggle]`, `[data-pg-problems-summary]`, and `[data-pg-problems-list]` (the
page: in the Problems tab, with `[data-pg-problems-empty]`); `[data-pg-diagram]` (gets `is-stale`), `[data-pg-stage]`
(with `[data-pg-static-diagram]`, `[data-pg-badge]`, `[data-pg-busy]`, `[data-pg-empty]`, `[data-pg-diagram-keys]`:
the hidden keyboard hint the diagram is described by); `[data-pg-sim]` (SimPanel mount), `[data-pg-sim-note]`,
`[data-action="rebuild"]`; buttons `[data-action]` = `zoom-in | zoom-out | zoom-reset | fit | outline | export-svg |
restore | rebuild` and, on the page, `new | new-file | open | open-folder | download | download-zip | save | share |
share-run | toggle-files`.

The page only: the app bar's `[data-pg-guide]` (popovertarget of Starlight's `#starlight__sidebar`),
`[data-pg-search]` (Starlight's search moves in), `[data-pg-project]` (the project menu: `[data-pg-title]` its
summary with `[data-pg-title-name]`, `[data-pg-title-edited]`; `[data-pg-project-name]`, `[data-pg-file]` the file
input, `[data-pg-recent]` and `[data-pg-recent-head]`), `[data-pg-title-page]`, `[data-pg-examples]` (with
`[data-pg-filter]`, `[data-pg-none]`, links `a[data-example]`), `[data-pg-help]`, `[data-pg-compare]` with
`[data-pg-compare-panel]`; the exercise's task `[data-pg-task]` (`[data-pg-task-toggle]`, `[data-pg-task-title]`,
`[data-pg-task-starter]`, `[data-pg-task-back]` with `[data-pg-task-page]`, `[data-pg-task-text]`) and its data
`[data-pg-exercises]`; `[data-pg-tabs]` (phone tabs; the root's `data-tab`); `[data-pg-work]` (the workspace; the
root's `data-files` = `open | closed`), `[data-pg-files]` (the sidebar) with `[data-pg-files-tree]` (FileTree mounts),
`[data-pg-fsplit]`, `[data-pg-grid]` (`--pg-sim-h`), `[data-pg-top]` (`--pg-split`), `[data-pg-split]`,
`[data-pg-hsplit]`, `[data-pg-file-tabs]` (FileTabs mounts), `[data-pg-static-file]` (the build-time file name),
`[data-pg-cursor]`, `[data-pg-chart]`, `[data-pg-chart-name]`, `[data-pg-zoom]`, `[data-pg-outline]`; the bottom panel
`[data-pg-panel]` (`data-current`: the tab shown) with `[data-pg-panel-tabs]` (buttons `[data-panel-tab=<id>]` with
`[data-pg-badge-count]`, `[data-pg-badge-words]`), `[data-pg-panel-tools=<id>]`, `[data-pg-panel-body=<id>]`
(`[data-pg-sim-panel]` on the simulation's: SimPanel's keyboard area); in the Simulation tab `[data-pg-mode]` (tour
switch), `[data-pg-vars-toggle]` with `[data-pg-vars-count]` and the strip `[data-pg-vars]` (`[data-pg-vars-list]`,
`[data-pg-watch-input]`, `[data-pg-watch-value]`, `[data-pg-until]`, `[data-pg-until-run]`); `[data-pg-toast]`;
`[data-pg-data]` (the default chart). `root.playground` is the `Playground` instance (for tests and the console).

## Tests

```sh
pnpm exec vitest run tests/playground                       # tokenizer, language, share links, projects (names,
                                                            # KIELER's imports), queries, catalogue,
                                                            # the comparison with model solutions, shared runs
                                                            # (every example's run replays the same), variables,
                                                            # KIELER's recorded words, the exercises' tasks,
                                                            # the watch
PLAYGROUND_E2E=1 pnpm exec vitest run tests/playground/e2e.test.ts   # Chromium against the dev server
                                                            # (PLAYGROUND_URL=http://127.0.0.1:4341 for another one)
```

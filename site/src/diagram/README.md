# Diagram renderer

Lays out and draws SCCharts in KIELER's notation, for pre-rendered diagrams at build time and for the live
playground. Pure TypeScript: the layout runs ELK (elkjs) and works in Node, the browser main thread or a Web
Worker; rendering is a pure function from a JSON layout to SVG markup.

```ts
import { layoutChart, renderSvg } from '~diagram/index'
import '~diagram/diagram.css'            // once per page (Astro: import in the component)

const layout = await layoutChart(chart)  // chart: a root State from parse()/compile()
const svg = renderSvg(layout, { idPrefix: `d${n}` })
```

## Fidelity to KIELER

The ELK graph is the one KIELER's synthesis builds (`sccharts.ui/.../synthesis/`), with the same options:
regions inside a state are packed with `rectpacking` (expanded, 5 apart); a control-flow region lays out its
states with ELK Layered, spline edges, inline ("on edge") labels, model order respected and the first initial
state in the first layer; directions alternate with depth (KIELER's "HV" default: the top level left to right,
the next level top to bottom, and so on). Sizes and paddings are KIELER's (simple states at least 34 px with
10/8 px text padding and 17 px corners, final states with a second border 3 px inside (4 for initial ones),
initial states with a 3 px border, superstate title rows and declaration blocks, 20 px region headers,
connectors 10 px, ...). Labels are KIELER's: `src/engine/format.ts` reproduces its serialisers, including
quirks (a valued emission prints its value with the plain serialiser, `V((x + 1))`; `x - (y - z)` prints as
`x - y - z`; host code prints without its backticks, so `` do `a = 1;`; x = 2 `` reads `/ a = 1;; x = 2`; a code effect ends
every statement with `;` but a declaration with nothing, so one that declares `int t = a` and then runs
`a = b; b = t` reads `/ {int t = aa = b; b = t;}`, as in KIELER's own diagram), and
transition labels use the semantic line breaks of its label manager (trigger, then one line per effect,
soft-wrapped at 200 px). Doc comments are drawn as KIELER draws them by default (its "Comment Nodes" option is
on): those of the chart, its states and regions as comment boxes (a state's joined to it by a line and placed
by ELK, above it in a left-to-right region; the chart's above the root; a region's as a box of its own), and
those of transitions as extra labels in front of the main label, in the transition label's style (KIELER's
synthesis asks for small text on a yellow background, but KLighD's label decoration overrides it, and its
diagrams show bold labels).

This is checked against KIELER itself: `tools/diagram-kieler-labels.mjs` records the texts, line styles,
decorators, region directions and state positions of KIELER's diagrams, and the tests compare: every text
identical (state names and titles, declaration and action rows, region labels and region-level declarations,
transition labels and their semantic line breaks), the same dashed lines and decorators, the same region
directions, and states in the same arrangement. `tests/diagram/kieler-labels.test.ts` covers the charts in
`tests/diagram/{kieler,charts}`; `tests/diagram/kieler-corpus.test.ts` covers the parser corpus (the wiki
examples, the lab fixtures and some 230 parser probes; about 1100 checks), with the few known differences
listed in the test.

Deliberate differences: text is measured and drawn in the site's diagram font (Atkinson Hyperlegible Next)
rather than KIELER's Overpass, so boxes are a little narrower; line heights are 1.42 em instead of AWT's 1.69;
transition label lines are left-aligned (so the indentation of continued effects lines up); the region
"collapse" corner is drawn but does nothing; dataflow regions are a simplified circuit (inputs, operators,
referenced instances as actor boxes, outputs) instead of KIELER's full actor synthesis; methods are collapsed
method regions as in KIELER, but cannot be expanded into their SCG; `@foreground`/`@background` colour
annotations are ignored so diagrams follow the theme; comment text is 9 pt instead of KIELER's 7 (legible at
the guide's scale) and the doc comments of dataflow regions are not drawn; a state with several self-loops gets
them spread over its sides (ELK's self-loop distribution: above and below, across the flow, for a state with other
transitions; all four sides for a state by itself, and two when the labels on four sides would collide) instead of
nested on one side, because KIELER's nested loops run through the labels of the loops inside them; inheritance (`extends`: inherited declarations and regions) and policies are not
drawn. Where KIELER draws no diagram at
all (a chart with unresolved names), this renderer still draws what it can.

## API

`layoutChart(chart: State, options?: LayoutOptions): Promise<DiagramLayout>`

| option | default | |
| --- | --- | --- |
| `elk` | from `src/diagram/index`: a shared `elkjs/lib/elk.bundled.js` instance, loaded on first use; `src/diagram/layout` needs it | any `{ layout(graph) }`, e.g. `new ELK({ workerFactory })` from `elkjs/lib/elk-api.js` to lay out off the main thread. Browser code imports `layoutChart` from `./layout` (and `renderSvg` from `./render`), so its bundle never contains the 1.4 MB bundled build |
| `measure` | generated width table (`font-metrics.ts`) | `(text, { size, bold, mono }) => width`; the table makes Node and browser layouts identical, a canvas measurer would not |
| `program` | none | the parsed program: other charts give referenced instances (dataflow) their ports and can be expanded inside reference states; its declarations and pragmas feed the formatter |
| `format` | built from `program`, else the chart | an explicit `createFormatContext(...)` |
| `references` | `'collapsed'` | `'expanded'` (or a list of reference state ids) draws the referenced chart inside the reference state, as KIELER's expand action does; its elements get ids `<reference state id>/<id in the referenced chart>`, exactly the ids the simulator reports for an instance (`tests/diagram/references.test.ts` checks every reference chart of the examples and probes) |
| `charts` | none | charts of other files (`import`), for references to them: `compile(src, { files }).index.programs.flatMap(p => p.charts)` |
| `direction` | `'HV'` | `'VH'`, `'down'`, `'right'`; `@layout[elk.direction] UP`, `@HVLayout`, `@VHLayout` annotations win |
| `userLabels` | `true` | KIELER's "User Labels": `label "..."` replaces trigger and effects |
| `comments` | `true` | KIELER's "Comment Nodes": doc comments `/** ... */` of the chart, states and regions as comment boxes, of transitions as extra labels |
| `declarations`, `actions` | `true` | show declarations / entry, during, exit and suspend actions |
| `labelWidth` | `200` | soft-wrap width of label lines, `0` disables |
| `collapsed` | none | region ids to draw collapsed (as `@collapse` does) |
| `dataflowCircuit` | `true` | `false` lists a dataflow region's equations instead |

`@hide` hides states, regions, transitions, declarations and actions, and `@collapse` / `@expand` collapse or
expand a region, as in KIELER. `@diagram[<option>] <value>` on the chart sets KIELER synthesis options and wins
over the options passed in (prefix match, case and spaces ignored): `commentNodes`, `userLabels`,
`declarations`, `stateActions`, `initiallyCollapseRegions`, `direction` (HV, VH, Down, Right), `shadows`.

`renderSvg(layout: DiagramLayout, options?: RenderOptions): string`

| option | default | |
| --- | --- | --- |
| `fit` | `'natural'` | `'natural'`: `width="100%"`, `max-width` = natural width; `'width'`: always the container's width; `'none'`: fixed natural size (for a scrolling frame) |
| `scale` | `1.25` | natural size per layout unit (KIELER's 11 px names show at about 14 px) |
| `minScale` | none | with `natural`/`width`: `min-width` = natural × minScale, so a wide chart scrolls in an `overflow-x: auto` frame on a phone instead of shrinking |
| `idPrefix` | from chart name and content | prefix of the one `<mask>` id; pass a unique value per diagram on a page (identical diagrams in a hidden tab otherwise share it) |
| `classes` | none | initial highlight classes per element id, e.g. `{ 'ABRO.ABO': ['is-active'] }` |
| `title` | `SCChart <name>` | accessible name; a `<desc>` lists states and transitions |
| `shadows`, `regionCorner` | `true` | KIELER's state shadows and the region corner |

Off the main thread (playground): either run `layoutChart` itself in a Web Worker (it is pure; the layout is
JSON, and `renderSvg` is cheap enough for the main thread), or keep it on the main thread and give it a
worker-backed ELK:

```ts
import ELK from 'elkjs/lib/elk-api.js'
const elk = new ELK({ workerFactory: () => new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url)) })
const layout = await layoutChart(chart, { elk, program })
```

`chartToSvg(chart, options)` does both. The SVG carries `data-natural-width` and `data-natural-height`.

Highlight helpers (`highlight.ts`): `tickClasses(tick)` turns a `TickResult` into
`{ id: ['is-active' | 'is-entered' | 'is-exited' | 'is-taken'] }`; `mergeClasses(...)` combines maps;
`applyClasses(svgElement, classes)` sets them on a rendered diagram without re-rendering (it removes the
managed classes first); `elementsAt(layout, offset)` gives the ids of the elements whose source span contains a
cursor offset, innermost first (for `is-focus`); `spanOf(layout, id)` the span of an element (diagram → source).

## DOM contract

Every model element is an element with `data-id="<id>"` (ids as in `src/engine/types.ts`):

| element | markup | classes |
| --- | --- | --- |
| root state | `<g data-id="ABRO">` | `sc-state sc-root sc-superstate` |
| superstate | `<g data-id="ABRO.ABO">` | `sc-state sc-superstate` (+ `sc-initial`, `sc-final`, `sc-reference`, `sc-violation`) |
| simple state | `<g data-id="ABRO.ABO.Done">` | `sc-state sc-simple` (+ `sc-initial`, `sc-final`, `sc-violation`) |
| connector | `<g data-id="...">` | `sc-state sc-connector` |
| region | `<g data-id="ABRO.ABO:0">` | `sc-region` (+ `sc-dataflow`, `sc-collapsed`, `sc-final-region`, `sc-abort-region`, `sc-override-region`, `sc-reference-region`) |
| method | `<g data-id="<scope>$<method name>">` | `sc-region sc-collapsed sc-method sc-method-implemented|abstract` |
| transition | `<g data-id="ABRO.ABO->1">` | `sc-transition` (+ `sc-immediate`, `sc-strong`, `sc-termination`, `sc-history sc-history-shallow|deep`, `sc-deferred`, `sc-nondeterministic`, `sc-probabilistic`) |
| transition label | `<g class="sc-label">` inside the transition | |
| transition doc comment | `<g class="sc-label sc-label-comment">` inside the transition, before its label | |
| action line | `<text data-id="ABRO.ABO!entry0" class="sc-text sc-action">` | |
| declaration line | `<text data-id="ABRO$A" data-ids="ABRO$A ABRO$B" class="sc-text sc-declaration">` | |
| comment box | `<g data-id="<element id>#doc" class="sc-comment">` (`#doc1`, `#doc2`, ... for further ones) | |

Groups nest like the chart (a state's `<g>` contains its regions, a region's its states and transitions), so
highlight rules use child combinators (`.sc-state.is-active > .sc-shape`). Inside a state group: `sc-shadow`,
`sc-fill` + `sc-fill-top` (KIELER's gradient: the end colour under the top colour faded by a mask),
`sc-shape` (the border; final states: `sc-final-outer` and `sc-final-inner`), then the text lines (`sc-title`,
`sc-state-label`, `sc-declaration`, `sc-action`). Inside a transition: `sc-edge-hit` (wide transparent stroke
for pointer events), `sc-edge` (a highlight never changes its dash pattern: dashed is KIELER's notation for an
immediate transition), `sc-arrow`, decorators
(`sc-strong-marker`, `sc-termination-marker`, `sc-history-marker`, `sc-deferred-marker`) and the label
(`sc-label-bg`, `sc-label-bars`, `sc-label-arrow`, text). Keyword runs are `<tspan class="sc-kw">`.

Highlight classes a simulation or editor toggles on `[data-id]` elements (styled in `diagram.css`, never by
colour alone):

| class | meaning | look |
| --- | --- | --- |
| `is-active` | state active after the tick | thick border in `--sc-active-stroke` with a glow; simple states filled with `--sc-active-fill` (the root stays calm) |
| `is-entered` | entered this tick | a pulse of `--sc-entered` in the shadow |
| `is-exited` | left this tick (and not active) | solid `--sc-entered` border and a fading tint of it |
| `is-taken` | transition fired this tick | `--sc-taken`, 4 px, glow, label outlined (its own dash pattern: solid when delayed, dashed when immediate); a one-off pulse along it when it fires (`pulseTransitions`, src/components/sim/link.ts) |
| `is-focus` | linked with the cursor | dashed outline / thick edge in `--sc-keyword`; text lines bold and underlined |
| `is-error` | named by a diagnostic | solid `--sc-error` with a glow and a marker (a disc with "!", `markErrors` in link.ts); text lines wavy-underlined |
| `is-dimmed` | de-emphasised | 35 % opacity |

No highlight adds dashes to an edge: in KIELER's notation a dashed transition is an immediate one. Animations stop
under `prefers-reduced-motion`. The styles are in `diagram.css` (the widgets workstream's).

## Theme

`diagram.css` uses only the `--sc-*` custom properties of `src/styles/tokens.css` (`--sc-font`,
`--sc-font-mono`, `--sc-root-fill`, `--sc-root-stroke`, `--sc-state-fill`, `--sc-state-fill-end`,
`--sc-state-stroke`, `--sc-state-text`, `--sc-superstate-fill`, `--sc-superstate-fill-end`, `--sc-region-fill`,
`--sc-region-stroke`, `--sc-region-label`, `--sc-keyword`, `--sc-decl-text`, `--sc-action-text`, `--sc-edge`,
`--sc-edge-label`, `--sc-edge-label-bg`, `--sc-strong-abort`, `--sc-termination`, `--sc-history`,
`--sc-comment-fill`, `--sc-comment-stroke`, `--sc-comment-text`, `--sc-active-stroke`, `--sc-active-fill`,
`--sc-active-glow`, `--sc-taken`, `--sc-entered`, `--sc-error`), each with KIELER's light colour as fallback.
Following KIELER, ordinary states have a `--sc-region-stroke` (grey) border and initial and final states a
`--sc-state-stroke` one. The markup has no colours, so one SVG works in both themes.

## Text

Text is real SVG `<text>` (selectable, crisp at any zoom). The layout measures it with a table of advance
widths generated from the font files (`node tools/diagram-metrics.mjs` regenerates `font-metrics.ts`), and the
CSS turns kerning, ligatures and contextual alternates off, so the rendered width is exactly the measured one
(the gallery checks this in chromium: within 0.02 px). If `--sc-font` changes to another family, regenerate
the table for it.

## Tools and tests

- `node tools/diagram-gallery.mjs [files] [--only substr] [--no-shots]`: renders `tests/diagram/charts`, the
  wiki corpus and the lab fixtures into `tests/diagram-gallery/index.html` (light and dark theme with the
  site's tokens, highlight samples, a 390 px column) and screenshots every chart into
  `tests/diagram-gallery/screenshots/`.
- `node tools/diagram-kieler-labels.mjs`: re-records KIELER's references (needs Java and the server jar, see
  `tools/oracle`).
- `pnpm exec vitest run tests/diagram`: format unit tests, KIELER comparison, layout and DOM-contract tests,
  geometry checks (labels apart, edges clear of other labels, nesting) and the speed budget (a dense 30-state
  chart in about 150 ms in Node; ELK takes almost all of it).

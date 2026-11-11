# @sccharts-lab/diagram

SCCharts diagrams in KIELER's notation, for charts compiled with
[@sccharts-lab/engine](https://www.npmjs.com/package/@sccharts-lab/engine): the layout KIELER's diagram synthesis builds
(ELK Layered and rectpacking through [elkjs](https://github.com/kieler/elkjs), KIELER's sizes, labels and line breaks),
drawn as SVG. Layout and rendering run in Node, in a browser and in a Web Worker; the result is plain SVG markup with a
`data-id` on every state, region and transition, so a simulation highlights it by toggling classes, without drawing it
again. It draws every diagram of the [SCCharts Lab](https://sccharts.jmw.nz) guide and IDE.

```sh
npm install @sccharts-lab/engine @sccharts-lab/diagram
```

## Quick start

A standalone `.svg` file from Node:

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { chartToSvg } from '@sccharts-lab/diagram'

const result = compile(`
scchart Blink {
  input bool button
  output bool led = false

  initial state Off
    if button do led = true go to On
  state On
    if button do led = false go to Off
}`)

// The diagram's stylesheet and its fonts go inside the file, so it looks the same in any viewer.
const fontsCss = new URL(import.meta.resolve('@sccharts-lab/diagram/fonts.css'))
const fonts = readFileSync(fontsCss, 'utf8').replace(/url\(\.\/([^)]+)\)/g,
  (_, file) => `url(data:font/woff2;base64,${readFileSync(new URL(file, fontsCss)).toString('base64')})`)
const css = readFileSync(new URL(import.meta.resolve('@sccharts-lab/diagram/diagram.css')), 'utf8')

const svg = await chartToSvg(result.chart, { program: result.program, fit: 'none', stylesheet: fonts + css })
writeFileSync('Blink.svg', svg)
```

In a web page, load the stylesheets once and insert the markup; a simulation then highlights the diagram in place:

```ts
import { compile, createSimulation } from '@sccharts-lab/engine'
import { applyClasses, chartToSvg, tickClasses } from '@sccharts-lab/diagram'
import '@sccharts-lab/diagram/fonts.css'
import '@sccharts-lab/diagram/diagram.css'

const result = compile(source)
const host = document.querySelector('#diagram')!
host.innerHTML = await chartToSvg(result.chart!, { program: result.program })

const simulation = createSimulation(result)
const tick = simulation.step({ button: true })
applyClasses(host, tickClasses(tick))   // is-active, is-entered, is-exited, is-taken
```

## Fonts

The layout measures text with a width table of Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (the same in
Node and every browser, so a diagram laid out on a server fits in the browser), and `diagram.css` draws the text in
those fonts with kerning and ligatures off. A page must therefore have the fonts, or the text will not fit its boxes:

- `@sccharts-lab/diagram/fonts.css` brings them: the variable fonts' Latin and Latin Extended subsets (about 80 kB of
  WOFF2, loaded only when used), shipped in this package under the SIL Open Font License 1.1.
- A page that already loads them from `@fontsource-variable/atkinson-hyperlegible-next` and
  `@fontsource-variable/atkinson-hyperlegible-mono` needs only `diagram.css`: the families have the same names.
- Another font needs another width table: pass `measure` (`(text, { size, bold, mono }) => width`) to `layoutChart`
  and set `--sc-font` and `--sc-font-mono`.

## Theme

`diagram.css` takes every colour from a CSS custom property with KIELER's light colours as the default, so a diagram
looks right without any theme. Set them on the diagram or any ancestor; the SVG has no colours of its own, so one
rendering serves light and dark pages. A dark theme (the guide's):

```css
.dark .sc-diagram {
  --sc-root-fill: #141a26;          --sc-root-stroke: #4a5873;
  --sc-state-fill: #3a4760;         --sc-state-fill-end: #4f5d7a;
  --sc-state-stroke: #dfe5ef;       --sc-state-outline: #8592a8;     --sc-state-text: #f3f6fa;
  --sc-superstate-fill: #1d2536;    --sc-superstate-fill-end: #26314a;
  --sc-region-fill: #121822;        --sc-region-stroke: #3f4b62;     --sc-region-label: #a3aec0;
  --sc-keyword: #f0b2df;            --sc-decl-text: #dfe5ef;         --sc-action-text: #dfe5ef;
  --sc-edge: #d4dbe7;               --sc-edge-label: #eef2f8;        --sc-edge-label-bg: rgb(15 20 30 / 0.86);
  --sc-strong-abort: #ff5c6c;       --sc-termination: #48d17c;       --sc-history: #c9d1dd;
  --sc-comment-fill: #353222;       --sc-comment-stroke: #8f866a;    --sc-comment-text: #ede6d2;
  --sc-active-stroke: #ff6b7d;      --sc-active-fill: #4a2232;       --sc-active-glow: rgb(255 107 125 / 0.42);
  --sc-taken: #5aa9ff;              --sc-entered: #5aa9ff;           --sc-error: #ff8a65;
}
```

`--sc-font` and `--sc-font-mono` set the font stacks.

## ELK

`layoutChart` hands the graph to ELK. Without an `elk` option it loads elkjs's bundled build on first use (1.4 MB,
435 kB gzipped; a bundler splits it into a chunk of its own) and runs it on the calling thread: right for Node and for
build-time rendering, fine for an occasional diagram in a browser. To keep a page responsive, run ELK in a Web Worker
with elkjs's `elk-api` (add `elkjs` to your own dependencies, at the version this package uses). With Vite:

```ts
import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import { layoutChart } from '@sccharts-lab/diagram/layout'
import { renderSvg } from '@sccharts-lab/diagram/render'

const elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) })
const layout = await layoutChart(result.chart, { program: result.program, elk })
host.innerHTML = renderSvg(layout)
```

Other bundlers: copy `node_modules/elkjs/lib/elk-worker.min.js` to your static files and pass its URL. Importing
`layoutChart` from `@sccharts-lab/diagram/layout` (which requires `elk`) instead of the main entry keeps the bundled
build out of the bundle altogether. The layout is the same either way. It is plain JSON, so `layoutChart` itself can
also run in a worker and post the layout back.

## API

| Export | |
| --- | --- |
| `layoutChart(chart, options?)` | `Promise<DiagramLayout>`. Options: `elk`, `program` (the parsed file: referenced charts, formatter context), `charts` (other files' charts, for `import`), `references` (`'collapsed'`, `'expanded'` or reference state ids), `direction` (`'HV'`, KIELER's default, `'VH'`, `'down'`, `'right'`), `userLabels`, `comments`, `declarations`, `actions`, `labelWidth`, `collapsed`, `dataflowCircuit`, `measure`. The chart's `@layout`, `@HVLayout`, `@VHLayout`, `@diagram[...]`, `@hide` and `@collapse` annotations apply as in KIELER |
| `renderSvg(layout, options?)` | SVG markup. Options: `fit` (`'natural'`: 100 % wide up to the natural size; `'width'`; `'none'`: fixed size), `scale` (1.25), `minScale`, `idPrefix` (unique per diagram on a page), `title`, `className`, `classes` (initial highlights by id), `shadows`, `regionCorner`, `stylesheet` |
| `chartToSvg(chart, options?)` | both in one call |
| `tickClasses(tick)`, `mergeClasses(...maps)`, `applyClasses(root, classes)` | highlight classes from a simulation tick, set on a rendered diagram |
| `elementsAt(layout, offset)`, `spanOf(layout, id)` | from a source offset to the elements drawn for it, and back |
| `measureWithTable`, `lineMetrics` | the text measurement the layout uses |

| Import | What |
| --- | --- |
| `@sccharts-lab/diagram` | everything above, and the layout's types |
| `@sccharts-lab/diagram/layout` | `layoutChart` without the bundled ELK (`elk` required) |
| `@sccharts-lab/diagram/render` | `renderSvg` alone: no layout, no ELK |
| `@sccharts-lab/diagram/highlight` | the highlight helpers alone, for pages with pre-rendered SVG |
| `@sccharts-lab/diagram/types` | the layout's types |
| `@sccharts-lab/diagram/diagram.css`, `@sccharts-lab/diagram/fonts.css` | the stylesheet and the fonts |

### Markup

Every element of the chart is a `<g>` (or, for declarations and actions, a `<text>`) with `data-id="<element id>"`,
ids as the engine reports them in a tick (`ABRO.ABO`, `ABRO.ABO.WaitAB:HandleA`, `ABRO.ABO.WaitAB.WaitA->1`), and
classes saying what it is: `sc-state` with `sc-root`, `sc-superstate`, `sc-simple`, `sc-initial`, `sc-final`,
`sc-connector`; `sc-region`; `sc-transition` with `sc-immediate`, `sc-strong`, `sc-termination`, `sc-history`, ...
The highlight classes `is-active`, `is-entered`, `is-exited`, `is-taken`, `is-focus`, `is-error` and `is-dimmed` are
styled in `diagram.css`, never by colour alone, and a highlight never dashes an edge (dashed means immediate in
KIELER's notation). Animations stop under `prefers-reduced-motion`.

## Verification

The diagrams are compared with KIELER's own: every text (state names, declarations, actions, region labels,
transition labels and their line breaks), line style, decorator, region direction and the arrangement of the states,
for the KIELER wiki's examples, lab exercises and some 230 parser probes (about 1,100 checks), with the few deliberate
differences listed in the repository. Text is drawn in Atkinson Hyperlegible rather than KIELER's Overpass, so boxes
are a little narrower.

## License and credit

SCCharts, KIELER and ELK are developed by the [Real-Time and Embedded Systems group](https://rtsys.informatik.uni-kiel.de)
at Kiel University. The layout follows KIELER's SCCharts diagram synthesis (EPL-2.0), and this package is licensed
under the [Eclipse Public License 2.0](./LICENSE). The fonts in `dist/fonts` are Atkinson Hyperlegible Next and Mono,
© The Atkinson Hyperlegible Next and Mono Project Authors, under the SIL Open Font License 1.1 (license files beside
them). SCCharts Lab is an
independent project, not affiliated with or endorsed by Kiel University.

Source: [github.com/Fallstop/sccharts-lab](https://github.com/Fallstop/sccharts-lab/tree/main/site/packages/diagram).

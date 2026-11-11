# @sccharts-lab/embed

SCCharts Lab's embeds: a live SCCharts chart (the diagram, the simulation, the editor) on any page. The site serves
the embed itself at `/embed/` (an iframe; `src/pages/embed.astro`) and this package's element as one script,
`/embed.js`. Readers' documentation: <https://sccharts.jmw.nz/reference/embed/>.

No dependencies, no Node APIs. `options.ts` and `protocol.ts` are pure and shared by both sides; `element.ts` needs a
DOM to run (it can be imported without one).

## Use

```html
<script src="https://sccharts.jmw.nz/embed.js" async></script>
<sccharts-lab-chart example="learn/concurrency/abro" view="sim"></sccharts-lab-chart>
<sccharts-lab-chart view="full"><pre>scchart Toggle { ... }</pre></sccharts-lab-chart>
```

```ts
import { define } from '@sccharts-lab/embed'
define('https://sccharts.jmw.nz/')          // registers <sccharts-lab-chart>, its embeds from that site
const chart = document.querySelector('sccharts-lab-chart')!
await chart.ready
const tick = await chart.step({ A: true })  // also setInputs, reset, rewind, setSource, setFiles, selectChart, getState
chart.addEventListener('tick', e => console.log(e.detail.values))   // ready, compiled, tick, resize, error
```

## Modules

| File | What |
| --- | --- |
| `options.ts` | The embed's options: `parseEmbedQuery` (the address of `/embed/`), `targetFromAttributes` (the element's attributes), `embedUrl` / `embedQuery` (the other way), `estimateHeight` |
| `protocol.ts` | The postMessage protocol: the envelope `{ type: 'sccharts-lab', version: 1 }`, the commands and events (types), `parseCommand` (what the embed accepts: everything else is ignored or answered with an error), `parseEvent` |
| `element.ts` | `<sccharts-lab-chart>`: makes the iframe, sends it the chart written inside the element (`inlineFiles`, `dedent`) or fetched (`src`), sizes it from `resize`, and turns the protocol into methods and DOM events |
| `loader.ts` | The entry point of `/embed.js` (`src/pages/embed.js.ts` builds it with Vite: an IIFE, about 10 kB, 4 kB gzipped): `define()` with the site the script came from |

The embed's side (the page in the iframe) is in the site: `src/components/embed/` (`boot.ts`: options and chart;
`bridge.ts`: the commands run on the playground, its events; `sizing.ts`: the auto height) and the playground's
modules it reuses (`src/components/playground`, 'embed' mode). Tests: `tests/embed/` (unit) and
`EMBED_E2E=1 pnpm exec vitest run tests/embed/e2e.test.ts` (Chromium, a host page on another origin).

License: EPL-2.0.

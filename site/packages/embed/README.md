# @sccharts-lab/embed

A live SCCharts chart on any page: its diagram, its simulation (inputs, step, timing diagram) and, if you like, its
editor, from [SCCharts Lab](https://sccharts.jmw.nz). The `<sccharts-lab-chart>` element makes an iframe of SCCharts
Lab's embed, sizes it to its content, and turns its postMessage protocol into methods and DOM events. This package
holds the element, the embed's options and the protocol, as typed ES modules and as one script for a script tag. No
dependencies. Full guide: <https://sccharts.jmw.nz/reference/embed/>.

## Quick start

One script tag, then the element wherever a chart goes: a guide example, a `.sctx` file (`src`), or the chart written
inside the element (a `<pre>` also shows the code to readers without JavaScript).

```html
<script src="https://cdn.jsdelivr.net/npm/@sccharts-lab/embed@0.1/dist/embed.min.js" async></script>

<sccharts-lab-chart example="learn/concurrency/abro" view="sim"></sccharts-lab-chart>

<sccharts-lab-chart view="full">
<pre>
scchart Toggle {
  input bool press
  output bool on = false
  initial state Off
    if press do on = true go to On
  state On
    if press do on = false go to Off
}
</pre>
</sccharts-lab-chart>
```

The site serves the same script at `https://sccharts.jmw.nz/embed.js`. Attributes: `view` (`diagram`, `sim`,
`editor`, `full`), `height` (`auto`, the default, or pixels), `tour`, `tick`, `controls="false"`, `chart`, `src`,
`run`, `label`, `loading`, and `base` (another site serving the embed; the script tag's `data-base` sets it for every
element).

From a bundler, register the element yourself and drive it from your code:

```ts
import { define } from '@sccharts-lab/embed'   // or: import '@sccharts-lab/embed/loader'

define()                                        // registers <sccharts-lab-chart> (embeds from sccharts.jmw.nz)
const chart = document.querySelector('sccharts-lab-chart')!
await chart.ready
const tick = await chart.step({ A: true })      // also setInputs, reset, rewind, setSource, setFiles, selectChart, getState
console.log(tick.values, tick.active)
chart.addEventListener('tick', event => console.log(event.detail.values))   // ready, compiled, tick, resize, error (typed: SCChartsLabChartEventMap)
```

## An iframe of your own

The embed is a page, `https://sccharts.jmw.nz/embed/?<options>`; `options` and `protocol` give its address and its
messages, typed, for a page (or a server) that writes the iframe itself:

```js
import { embedUrl, envelope, parseCommand, parseEvent } from '@sccharts-lab/embed'

const src = embedUrl('https://sccharts.jmw.nz/', { example: 'learn/concurrency/abro', view: 'diagram', controls: false })
console.log(`<iframe src="${src}" title="ABRO" style="width: 100%; height: 420px; border: 0"></iframe>`)
// <iframe src="https://sccharts.jmw.nz/embed/?example=learn/concurrency/abro&view=diagram&controls=0" ...>

// Commands go to the frame: frame.contentWindow.postMessage(step, 'https://sccharts.jmw.nz')
const step = envelope({ command: 'step', inputs: { A: true }, id: 1 })
console.log(parseCommand(step).kind)   // 'command': the embed accepts it

// Events come back: window.addEventListener('message', e => { const event = parseEvent(e.data); ... })
console.log(parseEvent({ type: 'sccharts-lab', version: 1, event: 'resize', height: 320 }))
// { type: 'sccharts-lab', version: 1, event: 'resize', height: 320 }
```

## Entry points

| Import | What |
| --- | --- |
| `@sccharts-lab/embed` | everything: the element (`SCChartsLabChart`, `define`, `TAG`), the options and the protocol. Importable without a DOM |
| `@sccharts-lab/embed/options` | the embed's options and address: `embedUrl`, `embedQuery`, `parseEmbedQuery`, `targetFromAttributes`, `estimateHeight` |
| `@sccharts-lab/embed/protocol` | the messages: `envelope`, `parseCommand`, `parseEvent`, the command and event types, `LIMITS` |
| `@sccharts-lab/embed/loader` | side effect only: registers the element |
| `dist/embed.min.js` (`@sccharts-lab/embed/embed.min.js`) | the element as one minified script (about 10 kB, 4 kB gzipped), the same file as the site's `/embed.js` |

The element and the embed speak version 1 of the protocol; the embed ignores messages it does not understand and
answers a malformed command with an error, so a page cannot break it.

## License and credit

SCCharts and KIELER are developed by the [Real-Time and Embedded Systems group](https://rtsys.informatik.uni-kiel.de)
at Kiel University. The embedded page runs SCCharts Lab's engine, a port of KIELER's SCCharts compiler (EPL-2.0).
This package is licensed under the [Eclipse Public License 2.0](./LICENSE). SCCharts Lab is an independent project,
not affiliated with or endorsed by Kiel University.

Source: [github.com/Fallstop/sccharts-lab](https://github.com/Fallstop/sccharts-lab/tree/main/site/packages/embed).
The embed's own page is part of the site (`src/components/embed/`, `src/pages/embed.astro`); tests: `tests/embed/`.

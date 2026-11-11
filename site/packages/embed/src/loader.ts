// The entry point of /embed.js and of the npm package's dist/embed.min.js (both built by
// tools/packages/embed-bundle.mjs): registers <sccharts-lab-chart>. Its embeds come from the site that served this
// script as `<site>/embed.js`; a copy under another name (a CDN serving dist/embed.min.js, an ES module import) uses
// sccharts.jmw.nz, unless the script tag says otherwise with `data-base`.
import { define } from './element'

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null
const src = script?.src ? new URL(script.src) : undefined
define(script?.dataset.base || (src?.pathname.endsWith('/embed.js') ? new URL('.', src).href : undefined))

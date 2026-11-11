// The entry point of /embed.js (built on its own, src/pages/embed.js.ts): registers <sccharts-lab-chart>, whose
// embeds come from the site that served this script.
import { define } from './element'

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null
define(script?.src ? new URL('/', script.src).href : undefined)

import { define } from '@sccharts-lab/embed'

// Registers <sccharts-lab-chart>. Call it once, before or after the
// elements are on the page.
define()

const chart = document.querySelector('sccharts-lab-chart')!

// Wait until the chart is live, then run two ticks from the page.
await chart.ready
await chart.step()
const tick = await chart.step({ A: true })
console.log(tick.tick, tick.values, tick.active)

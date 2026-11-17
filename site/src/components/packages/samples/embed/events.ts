import { define, type SCChartsLabChart } from '@sccharts-lab/embed'

define()
const chart: SCChartsLabChart =
  document.querySelector('sccharts-lab-chart')!
const status = document.querySelector<HTMLElement>('#status')!

// Each event's `detail` is typed: no casts.
chart.addEventListener('compiled', (event) => {
  const { ok, diagnostics } = event.detail
  status.textContent = ok ? 'Compiles' : diagnostics[0].message
})

chart.addEventListener('tick', (event) => {
  const { tick, values, terminated } = event.detail
  console.log(`tick ${tick}`, values, terminated ? '(terminated)' : '')
})

chart.addEventListener('error', (event) => {
  console.warn(event.detail.message)
})

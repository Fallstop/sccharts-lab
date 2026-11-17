import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import { compile } from '@sccharts-lab/engine'
import { layoutChart, workerElk } from '@sccharts-lab/diagram/layout'
import { renderSvg } from '@sccharts-lab/diagram/render'

declare const source: string
declare const host: HTMLElement

// One worker for the page: make it once and reuse it.
const elk = workerElk(elkWorkerUrl)

const result = compile(source)
if (result.chart) {
  const layout = await layoutChart(result.chart, {
    program: result.program,
    elk,
  })
  host.innerHTML = renderSvg(layout)
}

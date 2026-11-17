import { compile } from '@sccharts-lab/engine'
import { applyClasses, chartToSvg } from '@sccharts-lab/diagram'

declare const source: string
declare const host: HTMLElement

// A chart that does not compile still has a diagram: mark what is wrong.
const result = compile(source)
if (result.chart) {
  host.innerHTML = await chartToSvg(result.chart, {
    program: result.program,
  })
  const classes: Record<string, string[]> = {}
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity !== 'error') continue
    for (const id of diagnostic.related ?? []) classes[id] = ['is-error']
  }
  applyClasses(host, classes)
}

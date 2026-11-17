import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { elementsAt, layoutChart, spanOf } from '@sccharts-lab/diagram'

const source = readFileSync('turnstile.sctx', 'utf8')
const result = compile(source)
const layout = await layoutChart(result.chart, {
  program: result.program,
})

// From the text to the diagram: what is drawn for the cursor's place?
const cursor = source.indexOf('if push')
console.log(elementsAt(layout, cursor))

// From the diagram to the text: where is this element written?
const span = spanOf(layout, 'Turnstile.Locked->1')
console.log(span.line, source.slice(span.start, span.end))

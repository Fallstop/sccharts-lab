import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { layoutChart } from '@sccharts-lab/diagram'

const result = compile(readFileSync('panel.sctx', 'utf8'), {
  files: { 'blinker.sctx': readFileSync('blinker.sctx', 'utf8') },
})

// The charts of the imported files, for the diagram to draw inside `Run`.
const charts = result.index.programs.flatMap((program) => program.charts)

const layout = await layoutChart(result.chart, {
  program: result.program,
  charts,
  references: 'expanded',
})
const blinker = layout.root.regions[0].states[0].regions[0].states[0]
console.log(blinker.id)
console.log(blinker.regions[0].states.map((state) => state.id))

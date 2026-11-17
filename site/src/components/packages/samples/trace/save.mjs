import { readFileSync, writeFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import {
  TRACE_FORMATS, traceFromRun, writeTrace,
} from '@sccharts-lab/trace'

const result = compile(readFileSync('beeper.sctx', 'utf8'))
const simulation = createSimulation(result)
for (const press of [false, true, true, false]) simulation.step({ press })

// The run so far, as a trace.
const trace = traceFromRun(result, simulation, { model: 'beeper.sctx' })
console.log(trace.variables.map((v) => `${v.role} ${v.name}`).join(', '))

// The same trace in each format.
for (const { format, extension } of TRACE_FORMATS) {
  writeFileSync(`run.${extension}`, writeTrace(trace, format))
}
console.log(writeTrace(trace, 'ktrace'))

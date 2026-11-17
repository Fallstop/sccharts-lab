import { readFileSync, writeFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import {
  readTrace, replayTrace, traceFromRun, writeTrace,
} from '@sccharts-lab/trace'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result)
const run = [{}, { coin: true }, { coin: false, push: true }, {}]
for (const inputs of run) simulation.step(inputs)

// Save the run.
const trace = traceFromRun(result, simulation)
const csv = writeTrace(trace, 'csv')
writeFileSync('run.csv', csv)
console.log(csv)

// Later, or in a test: replay the file into the chart.
// Every output the file holds is checked.
const saved = readTrace(readFileSync('run.csv', 'utf8'), 'run.csv')
const outcome = replayTrace(result, saved)
console.log('checked:', outcome.state.checked.join(', '))
console.log('mismatches:', outcome.mismatches.length)

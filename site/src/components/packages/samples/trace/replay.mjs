import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import {
  readTrace, replayTrace, traceFromRun, writeTrace,
} from '@sccharts-lab/trace'

// A run of the turnstile, saved.
const turnstile = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(turnstile)
const run = [{}, { coin: true }, { coin: false, push: true }, {}]
for (const inputs of run) simulation.step(inputs)
const file = writeTrace(traceFromRun(turnstile, simulation), 'csv')

// #region replay
// Replay it into the chart it came from: nothing differs.
const saved = readTrace(file, 'run.csv')
const same = replayTrace(turnstile, saved, { label: 'run.csv' })
console.log(same.mismatches)

// Replay it into another chart: one that counts at the coin.
const early = compile(readFileSync('early-turnstile.sctx', 'utf8'))
const outcome = replayTrace(early, saved, { label: 'run.csv' })
console.log(outcome.mismatches)
console.log(outcome.state.firstMismatch)
// #endregion replay

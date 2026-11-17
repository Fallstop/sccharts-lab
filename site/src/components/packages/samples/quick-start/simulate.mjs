import { readFileSync } from 'node:fs'
import {
  compile, createSimulation, describeTick,
} from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result)

// One object of inputs per tick. An input you leave out keeps its value.
const run = [{}, { coin: true }, { coin: false, push: true }, {}]

for (const inputs of run) {
  const tick = simulation.step(inputs)
  console.log(`tick ${tick.tick}:`, tick.values)
  console.log(' ', describeTick(tick, result.program).join(' '))
}

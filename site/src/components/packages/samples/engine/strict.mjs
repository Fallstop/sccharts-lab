import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result, { strict: true })

try {
  simulation.step({ coins: true })
} catch (error) {
  console.log(error.message)
}

import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const result = compile(readFileSync('beeper.sctx', 'utf8'))
const simulation = createSimulation(result)

simulation.step()
// A pure signal is present when its input is true.
const tick = simulation.step({ press: true })

console.log(tick.present)   // which signals were present
console.log(tick.values)    // a valued signal: its value
console.log(tick.pool)      // KIELER's names: beep, beep_val

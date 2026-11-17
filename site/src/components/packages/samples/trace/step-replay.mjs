import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import { SimulationReplay, readTrace } from '@sccharts-lab/trace'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const file = readTrace(`tick,coin,push,unlocked
1,false,false,false
2,true,false,true
3,false,true,false
`, 'csv')

const simulation = createSimulation(result)
const replay = new SimulationReplay(result, simulation, file)

// One tick of the file at a time, as a Step button would.
while (!replay.done) {
  const step = replay.step()
  console.log(step.tick.tick, step.inputs, step.mismatches.length)
}
const { checked, unset } = replay.state()
console.log('checked:', checked, 'not in the file:', unset)

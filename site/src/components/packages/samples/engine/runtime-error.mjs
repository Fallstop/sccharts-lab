import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const result = compile(readFileSync('divide.sctx', 'utf8'))
const simulation = createSimulation(result)

simulation.step({ by: 4 })
console.log(simulation.step().values)

const failed = simulation.step({ by: 0 })
console.log(failed.error.code, 'in tick', failed.error.tick)
console.log(failed.error.message)

// The simulation stays stopped: later ticks repeat the error.
console.log(simulation.step({ by: 5 }).error.tick)

// Rewind to before the failing tick to go on.
simulation.rewind(2)
console.log(simulation.step({ by: 5 }).values)

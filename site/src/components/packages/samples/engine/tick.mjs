import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result)

simulation.step()
const tick = simulation.step({ coin: true })

// #region fields
console.log(tick.tick)      // the tick's number, from 1
console.log(tick.values)    // every variable after the tick
console.log(tick.active)    // the states the chart is in now
console.log(tick.entered)   // states entered in this tick
console.log(tick.exited)    // states left in this tick
console.log(tick.taken)     // transitions that fired, in order
// #endregion fields

// #region history
simulation.step({ coin: false, push: true })
console.log(simulation.tick, simulation.history.length)

// Go back to the state after tick 2 and take another path.
simulation.rewind(2)
console.log(simulation.step({ coin: false }).active)

// Start again from before the first tick.
simulation.reset()
console.log(simulation.tick)
// #endregion history

import { readFileSync } from 'node:fs'
import {
  compile, createSimulation, describeTick, elementName,
} from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result)
simulation.step()
const tick = simulation.step({ coin: true })

// #region describe
console.log(describeTick(tick, result.program))
const options = { markdown: true }
console.log(describeTick(tick, result.program, undefined, options))
// #endregion describe

// #region names
for (const id of tick.taken) {
  console.log(id, elementName(id, result.program))
}
// #endregion names

// #region log
for (const event of tick.log) console.log(event)
// #endregion log

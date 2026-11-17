import { readFileSync } from 'node:fs'
import {
  compile, createSimulation, replaySeeds,
} from '@sccharts-lab/engine'

const result = compile(readFileSync('dice.sctx', 'utf8'))
const shakes = [false, true, false, false, true, false]

// randomize() takes the clock: a run's faces are its own.
const run = createSimulation(result)
for (const shake of shakes) run.step({ shake })

// The same run again, from the seeds its ticks used.
const seed = replaySeeds(run.history)
const again = createSimulation(result, { seed })
const faces = shakes.map((shake) => again.step({ shake }).values.face)
const same = faces.every((face, i) => face === run.history[i].values.face)
console.log('the same faces again:', same)

// A seed of your own, for a test that expects certain faces.
const fixed = createSimulation(result, { seed: 42 })
for (const shake of shakes) fixed.step({ shake })
console.log(fixed.history.map((tick) => tick.values.face).join(' '))
console.log('seeds of tick 2:', fixed.history[1].seeds)

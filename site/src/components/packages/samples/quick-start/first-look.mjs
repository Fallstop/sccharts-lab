import { compile, createSimulation } from '@sccharts-lab/engine'

const result = compile(`
scchart Turnstile {
  input bool coin, push
  output bool unlocked = false

  initial state Locked
    if coin do unlocked = true go to Unlocked

  state Unlocked
    if push do unlocked = false go to Locked
}`)

const simulation = createSimulation(result)
console.log(simulation.step().values)
console.log(simulation.step({ coin: true }).values)
console.log(simulation.step({ coin: false, push: true }).values)

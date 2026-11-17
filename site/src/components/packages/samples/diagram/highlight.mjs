import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import { mergeClasses, tickClasses } from '@sccharts-lab/diagram'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const simulation = createSimulation(result)
simulation.step()
const tick = simulation.step({ coin: true })

// Classes by element id, for the tick.
console.log(tickClasses(tick))

// Add your own on top, for example to mark what a diagnostic names.
const classes = mergeClasses(tickClasses(tick), {
  'Turnstile.Locked': ['is-dimmed'],
})
console.log(classes['Turnstile.Locked'])

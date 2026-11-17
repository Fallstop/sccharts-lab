import { readFileSync } from 'node:fs'
import { parse } from '@sccharts-lab/engine'
import {
  formatDeclaration, formatTransition, transitionLabelLines,
} from '@sccharts-lab/engine/format'

const { program } = parse(readFileSync('turnstile.sctx', 'utf8'))
const chart = program.charts[0]

for (const declaration of chart.declarations) {
  console.log(formatDeclaration(declaration))
}
const unlocked = chart.regions[0].states[1]
const [transition] = unlocked.transitions
console.log(formatTransition(transition))
console.log(transitionLabelLines(transition, unlocked.transitions.length))

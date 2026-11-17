import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const source = readFileSync('two-charts.sctx', 'utf8')

const first = compile(source)
const second = compile(source, { chart: 'Down' })
console.log(first.chart.name, second.chart.name)
console.log(second.program.charts.map((chart) => chart.name))

const simulation = createSimulation(second)
simulation.step()
console.log(simulation.step().values)

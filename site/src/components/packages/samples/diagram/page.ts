import { compile, createSimulation } from '@sccharts-lab/engine'
import {
  applyClasses, chartToSvg, tickClasses,
} from '@sccharts-lab/diagram'
import '@sccharts-lab/diagram/fonts.css'
import '@sccharts-lab/diagram/diagram.css'

declare const source: string

const result = compile(source)
if (!result.chart) throw new Error('The text is not a chart')

// #region draw
const host = document.querySelector<HTMLElement>('#diagram')!
host.innerHTML = await chartToSvg(result.chart, {
  program: result.program,
})
// #endregion draw

// #region highlight
const simulation = createSimulation(result)
const tick = simulation.step({ coin: true })
applyClasses(host, tickClasses(tick))
// #endregion highlight

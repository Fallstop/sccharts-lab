import { compile, createSimulation } from '@sccharts-lab/engine'
import {
  applyClasses, chartToSvg, tickClasses,
} from '@sccharts-lab/diagram'
import '@sccharts-lab/diagram/fonts.css'
import '@sccharts-lab/diagram/diagram.css'
import source from './turnstile.sctx?raw'

const result = compile(source)
if (!result.ok || !result.chart) throw new Error('It does not compile')

// Draw the chart once.
const host = document.querySelector<HTMLElement>('#diagram')!
host.innerHTML = await chartToSvg(result.chart, {
  program: result.program,
})

// Each button runs one tick with its input true: the diagram follows.
const simulation = createSimulation(result)
applyClasses(host, tickClasses(simulation.step()))

const buttons = document.querySelectorAll<HTMLButtonElement>(
  'button[data-input]',
)
for (const button of buttons) {
  button.addEventListener('click', () => {
    const inputs = { coin: false, push: false }
    const pressed = { [button.dataset.input!]: true }
    const tick = simulation.step({ ...inputs, ...pressed })
    applyClasses(host, tickClasses(tick))
  })
}

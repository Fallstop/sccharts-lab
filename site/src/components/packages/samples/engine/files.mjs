import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'

const panel = readFileSync('panel.sctx', 'utf8')

// #region missing
// On its own, the file's import cannot be followed.
const alone = compile(panel)
console.log(alone.ok, alone.diagnostics[0].message)
// #endregion missing

// #region files
// Give the other files by name, as they are beside the chart.
const result = compile(panel, {
  files: { 'blinker.sctx': readFileSync('blinker.sctx', 'utf8') },
})
console.log(result.ok)

const simulation = createSimulation(result)
simulation.step()
console.log(simulation.step({ button: true }).active)
// #endregion files

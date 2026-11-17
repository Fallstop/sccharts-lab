import { readFileSync } from 'node:fs'
import { compile, createSimulation } from '@sccharts-lab/engine'
import { compareRuns, comparisonMarkdown } from '@sccharts-lab/trace'

// Two charts, the same inputs.
const inputs = [{}, { coin: true }, { coin: false, push: true }, {}]
const runOf = (file) => {
  const result = compile(readFileSync(file, 'utf8'))
  const run = createSimulation(result)
  for (const tick of inputs) run.step(tick)
  return { label: file, result, run }
}

const comparison = compareRuns([
  runOf('turnstile.sctx'),          // the first is the reference
  runOf('early-turnstile.sctx'),
])

for (const v of comparison.variables) {
  const verdict = v.differing.length
    ? `differs in tick ${v.differing.join(', ')}`
    : 'the same'
  console.log(v.name.padEnd(9), verdict, `(shift ${v.worstTickShift})`)
}

// The report the VS Code extension shows, as Markdown.
const report = comparisonMarkdown(comparison)
console.log(report.split('\n').length, 'lines of Markdown')

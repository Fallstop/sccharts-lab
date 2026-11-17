import { readFileSync } from 'node:fs'
import { parse } from '@sccharts-lab/engine'

const source = readFileSync('turnstile.sctx', 'utf8')
const { program, diagnostics } = parse(source)
console.log('syntax errors:', diagnostics.length)

const chart = program.charts[0]
for (const region of chart.regions) {
  for (const state of region.states) {
    console.log(state.id, state.initial ? '(initial)' : '')
    for (const t of state.transitions) {
      console.log('  ', t.id, 'to', t.target, `line ${t.span.line}`)
    }
  }
}

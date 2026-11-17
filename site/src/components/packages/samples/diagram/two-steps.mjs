import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { layoutChart, renderSvg } from '@sccharts-lab/diagram'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))

// 1. Lay out: where everything goes. Plain data, and the slow part.
const layout = await layoutChart(result.chart, {
  program: result.program,
})
const size = [layout.width, layout.height].map(Math.round).join(' x ')
console.log(layout.chart, size)
for (const state of layout.root.regions[0].states) {
  console.log(state.id, 'at', Math.round(state.x), Math.round(state.y))
}

// 2. Render: the layout as SVG markup. Fast, and as often as you like.
const plain = renderSvg(layout)
const marked = renderSvg(layout, {
  classes: { 'Turnstile.Unlocked': ['is-active'] },
})
console.log(plain.startsWith('<svg'), marked.includes('is-active'))

import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { chartToSvg } from '@sccharts-lab/diagram'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const svg = await chartToSvg(result.chart, { program: result.program })

// Every element of the chart carries its id.
for (const [, tag, classes, id] of svg.matchAll(
  /<(\w+) class="([^"]*)"[^>]*? data-id="([^"]*)"/g,
)) {
  const name = id.replace('&gt;', '>')
  console.log(`<${tag}>`.padEnd(7), name.padEnd(22), classes)
}

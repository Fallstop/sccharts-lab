import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'

const source = readFileSync('turnstile.sctx', 'utf8')
const result = compile(source)

console.log('compiles:', result.ok)
for (const v of result.interface) {
  console.log(v.input ? 'input ' : 'output', v.type, v.name)
}

import { readFileSync, writeFileSync } from 'node:fs'
import { compile, generateC } from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const c = generateC(result)

for (const [name, text] of Object.entries(c.files)) {
  writeFileSync(name, text)
}
console.log('wrote', Object.keys(c.files).join(' and '))
console.log('functions:', c.names.reset, c.names.tick)
console.log('struct:', c.names.struct)
for (const v of c.variables) console.log(' ', v.ctype, v.member)

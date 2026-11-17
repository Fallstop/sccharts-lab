import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'

const source = readFileSync('turnstile.sctx', 'utf8')
const result = compile(source.replace('go to Unlocked', 'go to Unlockd'))

const [first] = result.diagnostics
console.log(first)

// The span is in UTF-16 offsets, ready for an editor.
console.log(JSON.stringify(result.diagnostics.map((d) => d.code)))

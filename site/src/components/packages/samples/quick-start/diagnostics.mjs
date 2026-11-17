import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'

// The same chart with a slip of the keyboard: "Unlockd".
const source = readFileSync('turnstile.sctx', 'utf8')
const result = compile(source.replace('go to Unlocked', 'go to Unlockd'))

console.log('compiles:', result.ok)
for (const d of result.diagnostics) {
  const where = `line ${d.span?.line}, column ${d.span?.col}`
  console.log(`${d.severity} at ${where}: ${d.message}`)
  if (d.hint) console.log(`  hint: ${d.hint}`)
}

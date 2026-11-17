import { readFileSync } from 'node:fs'
import { compile, generateC } from '@sccharts-lab/engine'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))

// #region default
const c = generateC(result)
console.log(c.ok, Object.keys(c.files))
console.log(c.files[c.header])
// #endregion default

// #region naming
const prefixed = generateC(result, { naming: 'prefix', fileName: 'gate' })
console.log(Object.keys(prefixed.files), prefixed.names)
// #endregion naming

// #region variables
for (const v of c.variables) {
  console.log(v.name, '->', `d->${v.member}`, `(${v.ctype})`)
}
// #endregion variables

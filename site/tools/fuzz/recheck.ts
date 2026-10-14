// Re-compares saved disagreements (run.ts mismatches/*.json, reduce.ts *.reduced.sctx.json) with the current engine,
// using KIELER's saved results: no Java needed. Prints one line per file: the outcome now.
//
//   node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs tools/fuzz/recheck.ts /tmp/fuzz-1/mismatches

import fs from 'node:fs'
import path from 'node:path'
import { compareWithOracle, MISMATCH } from './compare'

const dir = process.argv[2]
let open = 0
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (!m.model || !m.kieler) continue
    const o = compareWithOracle(m.model, m.inputs, m.kieler, m.imports)
    if (MISMATCH.has(o.kind)) open++
    console.log(`${f.replace(/\.json$/, '')}: ${o.kind} ${o.detail.slice(0, 160)}`)
}
console.log(open ? `${open} still disagree` : 'none disagrees any more')

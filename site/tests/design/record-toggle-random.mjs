// Regenerates tests/design/toggle-random.oracle.json: KIELER's behaviour for the landing page's chart
// (src/examples/landing/toggle.sctx) on 12 pseudo-random input sequences of 14 ticks.
//
//   node tests/design/record-toggle-random.mjs      (from site/; needs Java, see ARCHITECTURE.md)
import { writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const cases = []
for (let c = 0; c < 12; c++) {
    const inputs = Array.from({ length: 14 }, (_, i) => (i === 0 ? { button: rnd() < 0.5 } : rnd() < 0.5 ? { button: rnd() < 0.5 } : {}))
    cases.push({ file: path.join(site, 'src/examples/landing/toggle.sctx'), inputs, ticks: 14 })
}
const batch = path.join(mkdtempSync(path.join(tmpdir(), 'toggle-')), 'batch.json')
writeFileSync(batch, JSON.stringify(cases))
const res = JSON.parse(execFileSync('node', [path.join(site, 'tools/oracle/oracle.mjs'), '--batch', batch], { cwd: site, maxBuffer: 1e8 }).toString())
writeFileSync(
    path.join(site, 'tests/design/toggle-random.oracle.json'),
    JSON.stringify(
        {
            note: 'KIELER (tools/oracle, netlist simulation) on src/examples/landing/toggle.sctx with 12 random input sequences. Regenerate: node tests/design/record-toggle-random.mjs (checked by tests/design/landing-chart.test.ts).',
            cases: res.map((r, c) => ({ inputs: cases[c].inputs, ticks: r.ticks.map((t) => ({ light: t.values.light, taken: t.taken })) })),
        },
        null,
        1
    ) + '\n'
)
console.log(`recorded ${res.length} cases`)

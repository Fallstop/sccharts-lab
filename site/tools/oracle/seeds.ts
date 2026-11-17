// The seeds of recorded runs that call randomize(): KIELER's C code seeds with `srand(time(NULL))`, so its recording
// (`<name>.oracle.json`, which keeps each tick's clock for such charts) is one run of many. This finds the clock
// seconds that make the engine's run the recorded one and writes them into the scenario's ticks (`"seeds": [n]`),
// where the engine's tests, the C code check and the guide's widgets read them. No Java.
//
//   node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs tools/oracle/seeds.ts chart.sctx ...
//
// `pnpm oracle:record` runs it for what it records. Exit code 1 when no seeds give a recording (the engine and
// KIELER then differ in something else too).

import fs from 'node:fs'
import path from 'node:path'
import { resolveSeeds, type OracleResult } from '../fuzz/compare'

let failures = 0
for (const chart of process.argv.slice(2)) {
    const base = chart.replace(/\.sctx$/, '')
    const scenarioFile = `${base}.scenario.json`
    const text = fs.readFileSync(scenarioFile, 'utf8')
    const scenario = JSON.parse(text) as { ticks: { inputs?: Record<string, never>; seeds?: number[] }[]; imports?: string[] }
    const rec = JSON.parse(fs.readFileSync(`${base}.oracle.json`, 'utf8')) as OracleResult
    if (!rec.ok || !rec.ticks.some(t => t.clock)) continue
    const files = Object.fromEntries((scenario.imports ?? []).map(f => [f, fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')]))
    const seeds = resolveSeeds(fs.readFileSync(chart, 'utf8'), scenario.ticks.map(t => t.inputs ?? {}), rec, files)
    if (!seeds) {
        failures++
        console.error(`✗ seeds    ${chart}: no clock seconds give KIELER's recorded run`)
        continue
    }
    scenario.ticks.forEach((t, i) => {
        if (seeds[i]) t.seeds = seeds[i]
        else delete t.seeds
    })
    // The file's own indentation.
    const indent = /^( +)"/m.exec(text)?.[1].length ?? 2
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, indent) + '\n')
    console.error(`✓ seeds    ${chart}: ${seeds.flatMap(s => s ?? []).join(', ') || 'no randomize() ran'}`)
}
process.exit(failures ? 1 : 0)

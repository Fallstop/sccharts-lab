// The seeds of recorded runs that call randomize(): KIELER's C code seeds with `srand(time(NULL))`, so its recording
// (`<name>.oracle.json`, which keeps each tick's clock for such charts) is one run of many. This finds the clock
// seconds that make the engine's run the recorded one and writes them into the scenario's ticks (`"seeds": [n]`),
// where the engine's tests, the C code check and the guide's widgets read them. No Java.
//
//   node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs tools/oracle/seeds.ts chart.sctx ...
//
// `pnpm oracle:record` runs it for every recording under its paths that keeps the clock (it changes a scenario only
// when its seeds change). Exit code 1 when no seeds give a recording (the engine and KIELER then differ in something
// else too).
//
// The same for the address of a recorded run: a chart that makes a number of an array's address (the engine's
// `c-address-value` warning) shows where KIELER's struct lay in that run, which changes with every start of its
// simulation. The scenario gets it as `"address"` (`createSimulation`'s option of that name).

import fs from 'node:fs'
import path from 'node:path'
import { compile } from '@sccharts-lab/engine'
import { resolveAddress, resolveSeeds, type OracleResult } from '../fuzz/compare'

let failures = 0
for (const chart of process.argv.slice(2)) {
    const base = chart.replace(/\.sctx$/, '')
    const scenarioFile = `${base}.scenario.json`
    const text = fs.readFileSync(scenarioFile, 'utf8')
    const scenario = JSON.parse(text) as { ticks: { inputs?: Record<string, never>; seeds?: number[] }[]; imports?: string[] }
    const rec = JSON.parse(fs.readFileSync(`${base}.oracle.json`, 'utf8')) as OracleResult
    if (!rec.ok) continue
    const files = Object.fromEntries((scenario.imports ?? []).map(f => [f, fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')]))
    const model = fs.readFileSync(chart, 'utf8')
    // A chart the engine does not run (host code, say) has no run to give seeds to.
    const compiled = compile(model, { files })
    if (!compiled.ok || compiled.diagnostics.some(d => d.code === 'unsupported')) continue
    if (compiled.diagnostics.some(d => d.code === 'c-address-value')) {
        const address = resolveAddress(model, scenario.ticks.map(t => t.inputs ?? {}), rec, files)
        if (address === undefined) {
            failures++
            console.error(`✗ address  ${chart}: no address of KIELER's struct gives its recorded run`)
        } else if (((scenario as { address?: number }).address ?? null) !== address) {
            if (address === null) delete (scenario as { address?: number }).address
            else (scenario as { address?: number }).address = address
            const indent = /^( +)"/m.exec(text)?.[1].length ?? 2
            fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, indent) + '\n')
            console.error(`✓ address  ${chart}: ${address === null ? 'none shows' : `0x${address.toString(16)}`}`)
        }
    }
    if (!rec.ticks.some(t => t.clock)) continue
    const seeds = resolveSeeds(model, scenario.ticks.map(t => t.inputs ?? {}), rec, files)
    if (!seeds) {
        failures++
        console.error(`✗ seeds    ${chart}: no clock seconds give KIELER's recorded run`)
        continue
    }
    const before = JSON.stringify(scenario.ticks.map(t => t.seeds ?? null))
    scenario.ticks.forEach((t, i) => {
        if (seeds[i]) t.seeds = seeds[i]
        else delete t.seeds
    })
    if (JSON.stringify(scenario.ticks.map(t => t.seeds ?? null)) === before) continue
    // The file's own indentation.
    const indent = /^( +)"/m.exec(text)?.[1].length ?? 2
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, indent) + '\n')
    console.error(`✓ seeds    ${chart}: ${seeds.flatMap(s => s ?? []).join(', ') || 'no randomize() ran'}`)
}
process.exit(failures ? 1 : 0)

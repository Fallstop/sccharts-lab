#!/usr/bin/env node
// Records what KIELER does for every scenario: for each `<name>.scenario.json` next to a `<name>.sctx`
// (under src/examples and tests/conformance, or the paths given), runs the chart through the oracle and
// writes `<name>.oracle.json`. Recordings whose chart and inputs are unchanged are skipped (by hash).
//
//   pnpm oracle:record                     # everything that is stale
//   pnpm oracle:record src/examples/learn  # only under these paths
//   pnpm oracle:record --force             # re-run everything
//
// Exit code 1 when a chart's outcome contradicts its scenario's "expect" ("ok" by default, or "error"
// with an optional "errorIncludes" substring).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startOracle } from './oracle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const force = args.includes('--force')
const targets = args.filter(a => !a.startsWith('--')).map(a => path.resolve(a))
const roots = targets.length ? targets : [path.join(root, 'src/examples'), path.join(root, 'tests/conformance')]

function* walk(dir) {
    if (!fs.existsSync(dir)) return
    if (fs.statSync(dir).isFile()) { yield dir; return }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

export function scenarioHash(model, scenario) {
    const ticks = (scenario.ticks ?? []).map(t => t.inputs ?? {})
    return crypto.createHash('sha1').update(JSON.stringify([model, ticks, scenario.system ?? 'netlist', scenario.imports ?? null])).digest('hex')
}

const jobs = []
for (const r of roots) {
    for (const file of walk(r)) {
        if (!file.endsWith('.scenario.json')) continue
        const base = file.slice(0, -'.scenario.json'.length)
        const chart = `${base}.sctx`
        if (!fs.existsSync(chart)) { console.error(`! no chart for ${path.relative(root, file)}`); continue }
        const scenario = JSON.parse(fs.readFileSync(file, 'utf8'))
        const model = fs.readFileSync(chart, 'utf8')
        // Imported charts: "imports": ["other.sctx"] relative to the chart.
        const imports = Object.fromEntries((scenario.imports ?? []).map(f => [path.basename(f), fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')]))
        const hash = scenarioHash(model, { ...scenario, imports: scenario.imports ? imports : undefined })
        const out = `${base}.oracle.json`
        const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined
        jobs.push({ chart, out, scenario, model, imports, hash, stale: force || previous?.hash !== hash, previous })
    }
}

const stale = jobs.filter(j => j.stale)
console.error(`${jobs.length} scenarios, ${stale.length} to record`)
let failures = 0
const oracle = stale.length ? await startOracle() : undefined
try {
    for (const job of jobs) {
        let result = job.previous
        if (job.stale) {
            const inputs = (job.scenario.ticks ?? []).map(t => t.inputs ?? {})
            const raw = await oracle.run({ name: path.relative(root, job.chart), model: job.model, inputs, ticks: inputs.length, system: job.scenario.system, imports: job.imports, fileName: path.basename(job.chart) })
            result = {
                hash: job.hash,
                chart: path.relative(root, job.chart),
                system: raw.system,
                ok: raw.ok,
                errors: raw.errors,
                warnings: raw.warnings,
                diagnostics: raw.diagnostics,
                interface: raw.interface,
                ticks: raw.ticks.map(({ takenTotal, ...t }) => t),
            }
            fs.writeFileSync(job.out, JSON.stringify(result, null, 2) + '\n')
        }
        const expect = job.scenario.expect ?? 'ok'
        let problem
        if (expect === 'ok' && !result.ok) problem = `expected to compile, KIELER rejects it: ${result.errors.join(' | ').slice(0, 400)}`
        if (expect === 'error' && result.ok) problem = 'expected KIELER to reject it, but it compiles'
        if (expect === 'error' && !result.ok && job.scenario.errorIncludes && !result.errors.some(e => e.includes(job.scenario.errorIncludes)))
            problem = `rejected, but no error includes "${job.scenario.errorIncludes}": ${result.errors.join(' | ').slice(0, 400)}`
        const tag = job.stale ? 'recorded' : 'cached  '
        if (problem) { failures++; console.error(`✗ ${tag} ${path.relative(root, job.chart)}: ${problem}`) }
        else console.error(`✓ ${tag} ${path.relative(root, job.chart)}${result.ok ? ` (${result.ticks.length} ticks)` : ' (rejected, as expected)'}`)
    }
} finally {
    await oracle?.stop()
}
process.exit(failures ? 1 : 0)

#!/usr/bin/env node
// Runs every recorded scenario (src/examples, tests/conformance, tests/engine) through another KIELER server jar,
// usually the official KIELER VS Code extension's, and compares it with the recording (made with the lab server).
//
//   node tools/oracle/official-diff.mjs <jar> <out.jsonl> [path filter]
//   SHARD=0/4 node tools/oracle/official-diff.mjs ...   (one of four processes; run each with its own out file)
//
// One JSON line per scenario: { chart, hang, recOk, offOk, sameValues, recErrors?, offErrors?, rec?, off? }.
// `hang`: no answer within 60 s (the server is restarted). Scenarios already in any out*.jsonl next to <out.jsonl>
// are skipped, so an interrupted run resumes. The official jar is extension/server/kieler-language-server.jar in
// the extension's vsix from Open VSX (a zip): https://open-vsx.org/api/kieler/keith-vscode/<version>/file/kieler.keith-vscode-<version>.vsix
// Four shards (four JVMs, -Xmx1500m each) took about 25 minutes for the 1,244 scenarios in November 2026.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOracle } from './oracle.mjs'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [jar, outFile, filter] = process.argv.slice(2)
if (!jar || !outFile) { console.error('usage: official-diff.mjs <jar> <out.jsonl> [path filter]'); process.exit(2) }

function* walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) yield* walk(f)
        else if (f.endsWith('.scenario.json')) yield f
    }
}
const jobs = []
for (const r of ['src/examples', 'tests/conformance', 'tests/engine']) for (const f of walk(path.join(site, r))) {
    const base = f.slice(0, -'.scenario.json'.length)
    if (!fs.existsSync(base + '.sctx') || !fs.existsSync(base + '.oracle.json')) continue
    if (filter && !base.includes(filter)) continue
    jobs.push(base)
}
const outDir = path.dirname(path.resolve(outFile))
const done = new Set(fs.readdirSync(outDir).filter(f => /^out.*\.jsonl$/.test(f)).flatMap(f =>
    fs.readFileSync(path.join(outDir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).chart)))
const [shard, shards] = (process.env.SHARD ?? '0/1').split('/').map(Number)
console.error(`${jobs.length} scenarios, ${done.size} done`)

const TIMEOUT = 60000
let oracle = await startOracle({ jar })
const values = r => JSON.stringify((r.ticks ?? []).map(t => t.values))
for (const [index, base] of jobs.entries()) {
    if (index % shards !== shard) continue
    const chart = path.relative(site, base + '.sctx')
    if (done.has(chart)) continue
    const scenario = JSON.parse(fs.readFileSync(base + '.scenario.json', 'utf8'))
    const rec = JSON.parse(fs.readFileSync(base + '.oracle.json', 'utf8'))
    const model = fs.readFileSync(base + '.sctx', 'utf8')
    const imports = Object.fromEntries((scenario.imports ?? []).map(f => [path.basename(f), fs.readFileSync(path.join(path.dirname(base), f), 'utf8')]))
    const inputs = (scenario.ticks ?? []).map(t => t.inputs ?? {})
    let raw, hang = false
    try {
        raw = await Promise.race([
            oracle.run({ name: chart, model, inputs, ticks: inputs.length, system: scenario.system, imports, fileName: path.basename(base + '.sctx') }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
        ])
    } catch (e) {
        hang = true
        raw = { ok: false, errors: [String(e.message).slice(0, 300)], ticks: [] }
        oracle.kill()
        oracle = await startOracle({ jar })
    }
    const row = {
        chart, hang,
        recOk: rec.ok, offOk: raw.ok,
        sameValues: rec.ok && raw.ok ? values(rec) === values(raw) : null,
        recErrors: rec.ok ? undefined : rec.errors.slice(0, 3).map(s => s.slice(0, 200)),
        offErrors: raw.ok ? undefined : (raw.errors ?? []).slice(0, 3).map(s => s.slice(0, 200)),
    }
    if (row.sameValues === false) { row.rec = values(rec).slice(0, 600); row.off = values(raw).slice(0, 600) }
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n')
    console.error(`${hang ? 'HANG' : row.recOk !== row.offOk ? 'VERDICT' : row.sameValues === false ? 'VALUES' : 'same'} ${chart}`)
}
await oracle.stop()

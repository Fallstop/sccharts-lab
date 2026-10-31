// The differential fuzzer: random charts (gen.ts) compiled and simulated by the guide's engine and by KIELER (one
// oracle JVM, charts one after the other), compared tick by tick (compare.ts). See README.md.
//
//   node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs tools/fuzz/run.ts \
//       --profiles mix,refAborts --count 100 --seed 1 --out /tmp/fuzz-1
//
// Options: --profiles a,b (gen.ts PROFILES; default: all), --count N per profile, --seed S, --ticks T (14),
// --timeout seconds per chart (40), --out dir (results.jsonl, report.json, mismatches/), --jobs file.json (re-run
// saved jobs instead of generating: [{ name, model, inputs }]), --engine-only (front-end and verdict statistics only).

import fs from 'node:fs'
import path from 'node:path'
import { compareWithOracle, engineVerdict, MISMATCH, type Outcome, type OutcomeKind } from './compare'
import { generate, PROFILES } from './gen'
import { OracleRunner, type OracleJob } from './oracle'

interface Args {
    profiles: string[]
    count: number
    seed: number
    ticks: number
    timeout: number
    out: string
    jobs?: string
    engineOnly: boolean
}

function parseArgs(argv: string[]): Args {
    const a: Args = { profiles: Object.keys(PROFILES), count: 20, seed: 1, ticks: 14, timeout: 40, out: 'fuzz-out', engineOnly: false }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        const v = () => argv[++i]
        if (k === '--profiles') a.profiles = v().split(',')
        else if (k === '--count') a.count = Number(v())
        else if (k === '--seed') a.seed = Number(v())
        else if (k === '--ticks') a.ticks = Number(v())
        else if (k === '--timeout') a.timeout = Number(v())
        else if (k === '--out') a.out = v()
        else if (k === '--jobs') a.jobs = v()
        else if (k === '--engine-only') a.engineOnly = true
        else throw new Error(`unknown option ${k}`)
    }
    return a
}

interface Row extends OracleJob {
    profile?: string
    features?: string[]
    verdict?: string
    outcome?: Outcome
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    fs.mkdirSync(path.join(args.out, 'mismatches'), { recursive: true })
    const jobs: Row[] = args.jobs
        ? (JSON.parse(fs.readFileSync(args.jobs, 'utf8')) as Row[])
        : args.profiles.flatMap(p => Array.from({ length: args.count }, (_, i) => generate(args.seed, p, i, args.ticks)))
    for (const j of jobs) j.verdict = engineVerdict(j.model, j.imports)
    const syntax = jobs.filter(j => j.verdict === 'syntax')
    if (syntax.length) console.error(`${syntax.length} charts with syntax errors (generator bugs?), e.g. ${syntax[0].name}`)
    if (args.engineOnly) {
        const counts = new Map<string, number>()
        for (const j of jobs) counts.set(j.verdict!, (counts.get(j.verdict!) ?? 0) + 1)
        console.log(JSON.stringify(Object.fromEntries(counts), null, 2))
        return
    }
    const oracle = new OracleRunner(args.timeout * 1000)
    const results = fs.createWriteStream(path.join(args.out, 'results.jsonl'))
    const stats = new Map<string, Map<OutcomeKind | 'timeout', number>>()
    const t0 = Date.now()
    let done = 0
    try {
        for (const job of jobs) {
            done++
            if (job.verdict === 'syntax') {
                job.outcome = { kind: 'syntax', detail: 'engine syntax error' }
            } else {
                const rec = await oracle.run(job)
                job.outcome = rec.timedOut ? { kind: 'oracle-failure', detail: rec.errors[0] } : compareWithOracle(job.model, job.inputs as never, rec, job.imports)
                results.write(JSON.stringify({ name: job.name, profile: job.profile, features: job.features, outcome: job.outcome, kieler: { ok: rec.ok, errors: rec.errors.slice(0, 2) } }) + '\n')
                if (MISMATCH.has(job.outcome.kind)) {
                    const base = path.join(args.out, 'mismatches', job.name)
                    fs.writeFileSync(`${base}.sctx`, job.model)
                    fs.writeFileSync(`${base}.json`, JSON.stringify({ name: job.name, profile: job.profile, model: job.model, inputs: job.inputs, imports: job.imports, outcome: job.outcome, kieler: rec }, null, 1))
                    console.log(`MISMATCH ${job.name} [${job.outcome.kind}] ${job.outcome.detail}`)
                }
            }
            const kind: OutcomeKind | 'timeout' = job.outcome.kind === 'oracle-failure' && /^Timeout/.test(job.outcome.detail) ? 'timeout' : job.outcome.kind
            const profile = job.profile ?? 'jobs'
            const m = stats.get(profile) ?? new Map()
            stats.set(profile, m)
            m.set(kind, (m.get(kind) ?? 0) + 1)
            if (done % 25 === 0) console.error(`${done}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`)
        }
    } finally {
        results.end()
        await oracle.close()
    }
    const table = Object.fromEntries([...stats].map(([p, m]) => [p, Object.fromEntries(m)]))
    const total = new Map<string, number>()
    for (const m of stats.values()) for (const [k, n] of m) total.set(k, (total.get(k) ?? 0) + n)
    const report = { charts: jobs.length, seconds: Math.round((Date.now() - t0) / 1000), restarts: oracle.restarts, total: Object.fromEntries(total), profiles: table }
    fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })

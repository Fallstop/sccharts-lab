// The proof that generated C behaves like the simulator and like KIELER: every recorded scenario (and, with --fuzz,
// random charts of the differential fuzzer) goes through generateC, gcc and a harness that feeds the scenario's inputs
// tick by tick; the data pool, the printed text, the taken-transition counters and the termination of every tick are
// compared with the engine's simulation and with KIELER's recording. No JVM: the recordings are committed.
//
//   pnpm cgen:check                                   every recorded scenario
//   pnpm cgen:check --fuzz 300 --seed 1               also 300 random charts of each fuzz profile (engine only)
//   pnpm cgen:check --filter preemption --verbose     some scenarios, every problem printed
//
// Options: --filter text (ids containing it), --fuzz N (charts per profile), --profiles a,b, --seed S, --ticks T (14),
// --jobs N (parallel gcc runs, default 20), --keep dir (keep the files of mismatches there), --out file.json
// (every result), --no-corpus, --verbose. Exit code 1 on any mismatch.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate as generateChart, PROFILES } from '../fuzz/gen'
import { checkCase, type Case, type CaseResult } from './compare'
import { collectCases } from './corpus'
import { hasGcc, pool } from './gcc'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

interface Args {
    filter?: string
    fuzz: number
    profiles: string[]
    seed: number
    ticks: number
    jobs: number
    keep?: string
    out?: string
    corpus: boolean
    verbose: boolean
}

function parseArgs(argv: string[]): Args {
    const a: Args = { fuzz: 0, profiles: Object.keys(PROFILES), seed: 1, ticks: 14, jobs: 20, corpus: true, verbose: false }
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i + 1]
        switch (argv[i]) {
            case '--filter': a.filter = v; i++; break
            case '--fuzz': a.fuzz = Number(v); i++; break
            case '--profiles': a.profiles = v.split(','); i++; break
            case '--seed': a.seed = Number(v); i++; break
            case '--ticks': a.ticks = Number(v); i++; break
            case '--jobs': a.jobs = Number(v); i++; break
            case '--keep': a.keep = v; i++; break
            case '--out': a.out = v; i++; break
            case '--no-corpus': a.corpus = false; break
            case '--verbose': a.verbose = true; break
            default: throw new Error(`Unknown option ${argv[i]}`)
        }
    }
    return a
}

function fuzzCases(a: Args): Case[] {
    const out: Case[] = []
    for (const profile of a.profiles) {
        for (let i = 0; i < a.fuzz; i++) {
            const job = generateChart(a.seed, profile, i, a.ticks)
            if (a.filter && !job.name.includes(a.filter)) continue
            out.push({ id: `fuzz/${job.name}`, source: job.model, inputs: job.inputs })
        }
    }
    return out
}

/** Runs the cases and prints the summary; returns the results. */
export async function runCheck(cases: Case[], a: Pick<Args, 'jobs' | 'keep' | 'verbose'>, label: string): Promise<CaseResult[]> {
    let done = 0
    const started = Date.now()
    const results = await pool(cases, a.jobs, async c => {
        let r: CaseResult
        try {
            r = await checkCase(c)
        } catch (e) {
            r = { id: c.id, verdict: 'mismatch', problems: [`crash: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`], engineTicks: 0, kielerTicks: 0 }
        }
        if (r.verdict === 'mismatch' && a.keep) {
            const dir = path.join(a.keep, c.id.replace(/[^\w.-]+/g, '_'))
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'chart.sctx'), c.source)
            fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ inputs: c.inputs, problems: r.problems }, null, 1))
            await checkCase(c, { keep: dir }).catch(() => undefined)
        }
        if (r.verdict === 'mismatch') console.log(`MISMATCH ${r.id}\n  ${r.problems.slice(0, a.verbose ? 50 : 4).join('\n  ')}`)
        if (++done % 200 === 0) console.log(`  ${label}: ${done}/${cases.length} (${Math.round((Date.now() - started) / 1000)} s)`)
        return r
    })
    summary(results, label, a.verbose)
    return results
}

function summary(results: CaseResult[], label: string, verbose: boolean) {
    const count = (v: string) => results.filter(r => r.verdict === v).length
    const reasons = new Map<string, number>()
    for (const r of results) {
        if (r.verdict !== 'skipped' && r.verdict !== 'rejected') continue
        const key = `${r.verdict}: ${(r.reason ?? '').replace(/: .*/s, '')}`
        reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    const explained = results.filter(r => r.explained)
    const warned = results.filter(r => r.warnings)
    const ticks = results.reduce((s, r) => s + r.engineTicks, 0)
    const kticks = results.reduce((s, r) => s + r.kielerTicks, 0)
    console.log(`\n${label}: ${results.length} charts`)
    console.log(`  match ${count('match')}  (${ticks} ticks compared with the engine, ${kticks} with KIELER; host code ${results.filter(r => r.hostCode && r.verdict === 'match').length})`)
    console.log(`  mismatch ${count('mismatch')}`)
    for (const [k, n] of [...reasons].sort()) console.log(`  ${k}: ${n}`)
    if (explained.length) {
        console.log(`  differ from KIELER as the engine does (explained): ${explained.length}`)
        for (const r of explained) console.log(`    ${r.id}: ${r.explained}`)
    }
    if (warned.length) {
        console.log(`  gcc -Wall warnings in generated code: ${warned.length} charts`)
        const kinds = new Map<string, number>()
        for (const r of warned) for (const l of r.warnings!.split('\n')) {
            const k = /\[(-W[^\]]+)\]/.exec(l)?.[1] ?? l.replace(/^.*warning: /, '').slice(0, 60)
            kinds.set(k, (kinds.get(k) ?? 0) + 1)
        }
        for (const [k, n] of kinds) console.log(`    ${k}: ${n}`)
        if (verbose) for (const r of warned) console.log(`    ${r.id}:\n      ${r.warnings!.split('\n').join('\n      ')}`)
    }
    if (verbose) for (const r of results) if (r.verdict === 'skipped') console.log(`  skipped ${r.id}: ${r.reason}`)
}

async function main() {
    const a = parseArgs(process.argv.slice(2))
    if (!(await hasGcc())) {
        console.error('gcc is not on PATH')
        process.exit(2)
    }
    const all: CaseResult[] = []
    if (a.corpus) {
        const cases = collectCases(site, a.filter ? id => id.includes(a.filter!) : undefined)
        all.push(...await runCheck(cases, a, 'recorded scenarios'))
    }
    if (a.fuzz > 0) all.push(...await runCheck(fuzzCases(a), a, `fuzz (seed ${a.seed}, ${a.fuzz} per profile)`))
    if (a.out) fs.writeFileSync(a.out, JSON.stringify(all, null, 1))
    process.exit(all.some(r => r.verdict === 'mismatch') ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main()

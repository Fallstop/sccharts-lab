// Differential test against the real KIELER parser (opt-in, needs Java and the server JAR):
//
//   KIELER_DIFF=500 pnpm test -- tests/corpus/kieler-diff.test.ts
//
// Mutates the corpus (and the syntax probes), asks KIELER's language server for its syntax diagnostics, and
// compares accept/reject with parse(). Disagreements are printed and written to KIELER_DIFF_OUT (default: a file
// in the OS temp directory). With KIELER_DIFF_SAVE=1, new cases (all disagreements and a sample of agreements)
// are added to tests/corpus/syntax-probes.json, which syntax-probes.test.ts checks on every run without Java.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compile, parse } from '../../src/engine'
import { mutate, randomExpressionCase, randomSnippet, rng } from './mutate'
// @ts-ignore plain JS module (typed by inference under allowJs, untyped elsewhere)
import { checkAll } from './kieler-check.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const COUNT = Number(process.env.KIELER_DIFF ?? 0)
const SEED = Number(process.env.KIELER_SEED ?? 1)
const PROBES = path.join(here, 'syntax-probes.json')

interface Probe { text: string; kieler: 'accept' | 'reject'; first?: string; source?: string }

export function kielerRejects(diagnostics: { kind: string; message: string }[]): boolean {
    return diagnostics.some(d => d.kind === 'syntax' || d.message === 'Missing Semicolon')
}

export function engineRejects(text: string): boolean {
    return parse(text).diagnostics.some(d => d.severity === 'error' && (d.code === 'parse' || d.code === 'missing-semicolon'))
}

function bases(): { name: string; text: string; saveable: boolean }[] {
    const out: { name: string; text: string; saveable: boolean }[] = []
    for (const dir of ['wiki', 'lab', 'probes']) {
        for (const f of fs.readdirSync(path.join(here, dir)).sort()) {
            if (f.endsWith('.sctx')) out.push({ name: `${dir}/${f}`, text: fs.readFileSync(path.join(here, dir, f), 'utf8'), saveable: true })
        }
    }
    if (fs.existsSync(PROBES)) {
        const probes: Probe[] = JSON.parse(fs.readFileSync(PROBES, 'utf8'))
        probes.filter(p => p.kieler === 'accept').forEach((p, i) => out.push({ name: `probe${i}`, text: p.text, saveable: true }))
    }
    return out
}

const ENGINE_ONLY = new Set(['swallowed-line', 'ternary-grouping'])

/** Differences in error and warning positions between KIELER and compile(), or undefined. */
function semanticDifference(text: string, kieler: { kind: string; severity: string; line: number; col: number; message: string; code: string }[]): string | undefined {
    const ours = compile(text).diagnostics
    const k = kieler.filter(d => !d.code.startsWith('org.eclipse.emf') && d.message !== 'Missing Semicolon' && d.severity !== 'info')
    const fmt = (l: { line?: number; col?: number }[]) => l.map(d => `${d.line}:${d.col}`).sort().join(' ')
    const kErr = fmt(k.filter(d => d.severity === 'error'))
    const kWarn = fmt(k.filter(d => d.severity === 'warning'))
    const oErr = fmt(ours.filter(d => d.severity === 'error' && !['non-signal-emission', 'for-range', 'this-parameter', 'no-chart'].includes(d.code ?? '')).map(d => ({ line: d.span?.line, col: d.span?.col })))
    const oWarn = fmt(ours.filter(d => (d.severity === 'warning' && !ENGINE_ONLY.has(d.code ?? '')) || (d.severity === 'error' && d.code === 'non-signal-emission')).map(d => ({ line: d.span?.line, col: d.span?.col })))
    if (kErr === oErr && kWarn === oWarn) return undefined
    return `errors KIELER [${kErr}] engine [${oErr}]; warnings KIELER [${kWarn}] engine [${oWarn}]\n  KIELER: ${k.map(d => `${d.line}:${d.col} ${d.message.split('\n')[0]}`).join(' | ')}\n  engine: ${ours.map(d => `${d.span?.line}:${d.span?.col} ${(d.kieler ?? d.message).split('\n')[0]}`).join(' | ')}`
}

describe.skipIf(!COUNT)('differential syntax check against KIELER', () => {
    it(`agrees with KIELER on ${COUNT} mutants`, async () => {
        const r = rng(SEED)
        const all = bases()
        const seen = new Set<string>()
        const cases: { name: string; text: string; saveable: boolean }[] = []
        const snippetShare = Number(process.env.KIELER_SNIPPETS ?? 0.5)
        for (let tries = 0; cases.length < COUNT && tries < COUNT * 20; tries++) {
            if (r.next() < snippetShare) {
                const s = r.next() < 0.5 ? randomSnippet(r) : randomExpressionCase(r)
                if (seen.has(s.text)) continue
                seen.add(s.text)
                cases.push({ name: s.name, text: s.text, saveable: true })
                continue
            }
            const base = r.pick(all)
            const m = mutate(base.text, r, 1 + r.int(2))
            if (seen.has(m.text) || m.text.length > 6000) continue
            seen.add(m.text)
            cases.push({ name: `${base.name}:${m.ops.join('+')}`, text: m.text, saveable: base.saveable })
        }
        const results = await checkAll(cases.map((c, i) => ({ name: `m${i}`, text: c.text })), { jobs: 3 })
        const mismatches: (Probe & { engine: string; name: string })[] = []
        const agreements: Probe[] = []
        cases.forEach((c, i) => {
            const res = results[i]
            if (!Array.isArray(res)) return
            const k = kielerRejects(res)
            const e = engineRejects(c.text)
            const first = res.find((d: { kind: string }) => d.kind === 'syntax')
            const probe: Probe = { text: c.text, kieler: k ? 'reject' : 'accept', source: c.name }
            if (first) probe.first = `${first.line}:${first.col} ${first.message}`
            if (k !== e) mismatches.push({ ...probe, name: c.name, engine: e ? 'reject' : 'accept' })
            else if (c.saveable) agreements.push(probe)
            // Optionally also compare linking and validation diagnostics of charts both parse. Charts that refer to
            // other charts are skipped: in one language server they can see the charts of earlier documents.
            if (process.env.KIELER_DIFF_SEMANTIC && !k && !e && !/\b(is|extends|ref|import|calls)\b/.test(c.text)) {
                const diff = semanticDifference(c.text, res)
                if (diff) mismatches.push({ ...probe, name: `${c.name} [semantic]`, engine: diff })
            }
        })
        const out = process.env.KIELER_DIFF_OUT ?? path.join(os.tmpdir(), `kieler-diff-${SEED}.json`)
        const compared = cases.filter((_, i) => Array.isArray(results[i])).length
        const rejected = cases.filter((c, i) => Array.isArray(results[i]) && kielerRejects(results[i])).length
        fs.writeFileSync(out, JSON.stringify({ compared, kielerRejected: rejected, mismatches }, null, 1))
        for (const m of mismatches.slice(0, 30)) {
            console.log(`--- ${m.name}: KIELER ${m.kieler}${m.first ? ` (${m.first})` : ''}, engine ${m.engine}\n${m.text}`)
        }
        console.log(`${mismatches.length} disagreements out of ${cases.length}; written to ${out}`)
        if (process.env.KIELER_DIFF_SAVE) {
            const existing: Probe[] = fs.existsSync(PROBES) ? JSON.parse(fs.readFileSync(PROBES, 'utf8')) : []
            const known = new Set(existing.map(p => p.text))
            const sample = agreements.filter(() => r.next() < 0.15)
            for (const p of [...mismatches.map(({ engine: _e, name: _n, ...p }) => p), ...sample]) {
                if (!known.has(p.text) && p.text.length <= 1500) { existing.push(p); known.add(p.text) }
            }
            fs.writeFileSync(PROBES, JSON.stringify(existing, null, 1) + '\n')
        }
        expect(mismatches.length).toBe(0)
    }, 3_600_000)
})

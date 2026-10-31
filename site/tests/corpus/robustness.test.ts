// The playground parses on every keystroke, so parse() and compile() must never throw, must return a program for
// any input, and must be fast: truncated prefixes and random mutations of the corpus, deep nesting, long lines,
// and a 1000-line chart (< 20 ms for parse + resolve + validate in Node).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SIMULATOR_CODES, compile, parse } from '../../src/engine'
import { mutate, randomExpressionCase, randomSnippet, rng } from './mutate'

const here = path.dirname(new URL(import.meta.url).pathname)

function corpus(): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = []
    for (const dir of ['wiki', 'lab', 'probes']) {
        for (const f of fs.readdirSync(path.join(here, dir)).sort()) if (f.endsWith('.sctx')) out.push({ name: `${dir}/${f}`, text: fs.readFileSync(path.join(here, dir, f), 'utf8') })
    }
    return out
}

function check(text: string, label: string, budgetMs: number) {
    const t0 = performance.now()
    let r: ReturnType<typeof compile>
    try {
        const p = parse(text)
        expect(p.program, `${label}: parse returned no program`).toBeDefined()
        r = compile(text)
    } catch (error) {
        throw new Error(`${label}: threw ${(error as Error).stack}\n--- input ---\n${text}`)
    }
    const ms = performance.now() - t0
    expect(r.program, `${label}: compile returned no program`).toBeDefined()
    expect(r.diagnostics.some(d => d.code === 'internal'), `${label}: internal error ${r.diagnostics.find(d => d.code === 'internal')?.message}\n${text}`).toBe(false)
    expect(ms, `${label}: took ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs)
    for (const d of r.diagnostics) {
        if (d.span) {
            expect(d.span.start, `${label}: span start`).toBeGreaterThanOrEqual(0)
            expect(d.span.end, `${label}: span end`).toBeLessThanOrEqual(text.length)
            expect(d.span.start, `${label}: span order`).toBeLessThanOrEqual(d.span.end)
        }
    }
}

describe('robustness', () => {
    const files = corpus()

    it('never throws on truncated prefixes of the corpus', () => {
        for (const { name, text } of files) {
            const step = text.length > 1500 ? 13 : text.length > 400 ? 3 : 1
            for (let i = 0; i <= text.length; i += step) check(text.slice(0, i), `${name}[0:${i}]`, 200)
        }
    }, 120_000)

    it('never throws on random mutations', () => {
        const r = rng(7)
        for (let i = 0; i < 3000; i++) {
            const base = r.pick(files)
            const m = mutate(base.text, r, 1 + r.int(4))
            check(m.text, `${base.name} ${m.ops.join('+')}`, 200)
        }
        for (let i = 0; i < 2000; i++) {
            const s = r.next() < 0.5 ? randomSnippet(r) : randomExpressionCase(r)
            check(s.text, s.name, 200)
        }
    }, 120_000)

    it('handles pathological inputs', () => {
        check('('.repeat(2000), 'open parens', 500)
        check(`scchart A {\n  initial state S\n  do x = ${'('.repeat(300)}1${')'.repeat(300)} go to S\n}`, 'deep parens', 500)
        check(`scchart A {\n  int x\n  initial state S\n  do x = ${Array.from({ length: 2000 }, (_, i) => i).join(' + ')} go to S\n}`, 'long sum', 500)
        check(`scchart A {\n  int x\n  initial state S\n  do x = ${'-'.repeat(1000)}1 go to S\n}`, 'many minus', 500)
        check(`scchart A {\n  input bool b\n  int x\n  initial state S\n  do x = ${'b ? '.repeat(200)}1 go to S\n}`, 'ternary chain', 500)
        check('scchart A {\n' + '  state S {\n'.repeat(400) + '  }\n'.repeat(400) + '}', 'deep states', 2000)
        check('scchart A {\n' + '  initial state S {\n'.repeat(200), 'unclosed states', 2000)
        check('}'.repeat(1000), 'closing braces', 500)
        check('"'.repeat(999), 'quotes', 500)
        check('/**'.repeat(300), 'doc comments', 500)
        check('\u0000\u0001￿\ud800', 'odd characters', 500)
        check('scchart A { initial state S\n' + '  if a go to S\n'.repeat(3000) + '}', 'many transitions', 2000)
    })
})

/** A chart of about 1000 lines with many states, regions, transitions, actions and expressions. */
export function bigChart(lines = 1000): string {
    const out: string[] = ['scchart Big {', '  input bool a, b, c', '  input int x, y', '  output int o = 0, p = 0', '  output bool done = false', '  signal S', '  signal int V = 0 combine +', '  const int N = 4', '  int arr[N] = {0, 0, 0, 0}']
    let k = 0
    while (out.length < lines - 20) {
        const r = k++
        out.push(`  region R${r} {`)
        out.push('    int local = 0')
        out.push(`    entry do local = ${r}`)
        for (let s = 0; s < 6; s++) {
            out.push(`    ${s === 0 ? 'initial ' : s === 5 ? 'final ' : ''}state S${s} {`)
            out.push(`      during if a && !b || x > ${s} do o += 1; arr[${s % 4}] = arr[${(s + 1) % 4}] + local`)
            out.push(`      exit do p = p * 2 + 1`)
            out.push('    }')
            out.push(`    if pre(a) && (x + y * 2 - ${s} >= 3 || c) do V(x); S; local++ go to S${(s + 1) % 6}`)
            out.push(`    if 2 b go to S${(s + 2) % 6}`)
            out.push(`    immediate if val(V) == ${s} && y < N go to S${(s + 3) % 6}`)
        }
        out.push('  }')
    }
    out.push('}')
    return out.join('\n') + '\n'
}

describe('performance', () => {
    it('parses and resolves a 1000-line chart in under 20 ms', () => {
        const text = bigChart(1000)
        expect(text.split('\n').length).toBeGreaterThanOrEqual(990)
        // compile() is lazy: this measures the front end. KIELER's compiler itself rejects this generated chart
        // (complex final states, concurrent array writes), so only front-end errors must be absent.
        const first = compile(text)
        const frontEndErrors = first.program ? first.diagnostics.filter(d => d.severity === 'error' && !SIMULATOR_CODES.has(d.code ?? '')) : []
        expect(first.program).toBeDefined()
        expect(frontEndErrors.map(d => `${d.span?.line}:${d.span?.col} ${d.message}`).join('\n')).toBe('')
        // Warm up, then take the median of several runs.
        for (let i = 0; i < 10; i++) compile(text)
        const times: number[] = []
        for (let i = 0; i < 15; i++) {
            const t0 = performance.now()
            compile(text)
            times.push(performance.now() - t0)
        }
        times.sort((a, b) => a - b)
        const median = times[Math.floor(times.length / 2)]
        console.log(`1000-line chart: compile median ${median.toFixed(2)} ms (min ${times[0].toFixed(2)} ms)`)
        expect(median).toBeLessThan(20)
    })
})

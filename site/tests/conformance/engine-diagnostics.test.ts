// The engine's front-end diagnostics against KIELER's: every oracle recording under tests/conformance, src/examples
// and tests/engine/kieler keeps the LSP diagnostics KIELER's language server published for the chart (parser,
// linker, validator: `diagnostics` in the .oracle.json). For every chart that parses in both, the engine reports
// the same errors, warnings and infos at the same positions (line and column), with KIELER's words in `kieler`.
//
// Not compared: charts with a syntax error (the two parsers recover differently; tests/corpus/corpus.test.ts compares
// their linking errors), EMF's follow-up errors ("The required feature ... must be set"), the simulator's codes (the
// compile stage, compared by engine.test.ts) and the guide's own notes. Emitting a variable is KIELER's validator
// warning at the same place as the engine's error (its compiler then fails), so the two count as one.

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, SIMULATOR_CODES } from '../../src/engine/index'

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, '../..')
const SEVERITY = ['', 'error', 'warning', 'info', 'hint']
/** The guide's own diagnostics, and compile-stage errors the front end reports early. */
const ENGINE_ONLY = new Set(['swallowed-line', 'ternary-grouping', 'for-range', 'unsupported'])

interface LspDiagnostic { severity: number; message: string; line: number; column: number; code?: string }

function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) yield* walk(f)
        else if (f.endsWith('.oracle.json')) yield f
    }
}

const cases: { id: string; chart: string; files: Record<string, string>; diagnostics: LspDiagnostic[] }[] = []
for (const root of ['tests/conformance', 'src/examples', 'tests/engine/kieler']) {
    for (const file of walk(path.join(site, root))) {
        const base = file.slice(0, -'.oracle.json'.length)
        const chart = `${base}.sctx`
        if (!fs.existsSync(chart)) continue
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!rec.diagnostics) continue
        const scenarioFile = `${base}.scenario.json`
        const scenario = fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {}
        const files: Record<string, string> = {}
        for (const f of scenario.imports ?? []) files[path.basename(f)] = fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')
        cases.push({ id: path.relative(site, base), chart, files, diagnostics: rec.diagnostics })
    }
}

describe('front-end diagnostics agree with KIELER', () => {
    it('finds recordings with diagnostics', () => {
        expect(cases.length).toBeGreaterThan(50)
    })

    for (const c of cases) {
        const kieler = c.diagnostics.filter(d => !String(d.code ?? '').startsWith('org.eclipse.emf') && !/^The required feature '/.test(d.message))
        if (kieler.some(d => String(d.code ?? '').endsWith('Diagnostic.Syntax') || (d.severity === 1 && /^(no viable alternative|mismatched|extraneous|missing) /.test(d.message)))) continue
        it(c.id, () => {
            const result = compile(fs.readFileSync(c.chart, 'utf8'), { files: c.files })
            const ours = result.diagnostics.filter(d => d.span && !SIMULATOR_CODES.has(d.code ?? '') && !ENGINE_ONLY.has(d.code ?? '') && d.code !== 'internal')
            if (ours.some(d => d.code === 'parse' || d.code === 'missing-semicolon')) return
            const key = (severity: string, line: number, col: number) => `${severity} ${line}:${col}`
            const theirs = kieler.map(d => key(SEVERITY[d.severity], d.line, d.column)).sort()
            const mine = ours.map(d => key(d.code === 'non-signal-emission' ? 'warning' : d.severity, d.span!.line, d.span!.col)).sort()
            const show = `KIELER: ${kieler.map(d => `${d.line}:${d.column} ${d.message.split('\n')[0]}`).join(' | ') || 'none'}\nengine: ${ours.map(d => `${d.span!.line}:${d.span!.col} ${d.code} ${(d.kieler ?? d.message).split('\n')[0]}`).join(' | ') || 'none'}`
            expect(mine, show).toEqual(theirs)
            // Where the engine quotes KIELER, it quotes the message KIELER gave there.
            for (const d of ours) {
                if (!d.kieler || d.code === 'non-signal-emission') continue
                const there = kieler.filter(x => x.line === d.span!.line && x.column === d.span!.col).map(x => x.message)
                // KIELER lists the states of an immediate loop from a hash set: their order changes from run to run.
                const words = (m: string) => (d.code === 'immediate-loop' ? m.split('\n')[0] : m)
                if (there.length) expect(there.map(words), `${d.code} at ${d.span!.line}:${d.span!.col}`).toContain(words(d.kieler))
            }
        })
    }
})

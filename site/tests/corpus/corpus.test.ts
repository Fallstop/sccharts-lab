// The engine's front end must agree with KIELER on every corpus file (tests/corpus/expectations.json, recorded with
// record.mjs from the real language server):
//
// - parse acceptance: KIELER reports a syntax error (or "Missing Semicolon") exactly when parse() reports one;
// - for files that both reject for their syntax: the same linking errors ("Couldn't resolve reference to ..."), at the
//   same positions, as far as the error recovery allows (RECOVERY_DIFFERENCES);
// - for files that parse: the same linking errors, validation errors and warnings, at the same positions;
// - compile().ok is true for every file KIELER compiles and simulates (no false rejections), and false for every
//   file KIELER rejects before compiling. Files KIELER rejects only while compiling (scheduling, code generation)
//   are the simulator's business; the few such rejections the front end already makes must agree with KIELER.
//
// The wiki and lab files and the probes live here; the CS303 course files are read from their folder when present.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compile, parse, SIMULATOR_CODES } from '../../src/engine'
import type { Diagnostic } from '../../src/engine/types'

const here = path.dirname(new URL(import.meta.url).pathname)
const CS303 = '/home/fallstop/Documents/projects/CS303'

interface Item { line: number; col: number; message: string }
interface Expectation { syntax: Item[]; linking: Item[]; errors: Item[]; warnings: Item[]; compileErrors: string[]; ok: boolean }

// The CS303 verdicts live in a git-ignored file next to it (they quote the course files' code).
const readExpectations = (name: string): Record<string, Expectation> => fs.existsSync(path.join(here, name)) ? JSON.parse(fs.readFileSync(path.join(here, name), 'utf8')) : {}
const expectations: Record<string, Expectation> = { ...readExpectations('expectations.json'), ...readExpectations('expectations.cs303.json') }

/** Diagnostics the engine adds that KIELER's front end does not report. */
const ENGINE_ONLY_WARNINGS = new Set(['swallowed-line', 'ternary-grouping'])
/** Rejections KIELER makes while compiling, which the front end already reports (only allowed when KIELER's ok is false). */
const COMPILE_LEVEL_ERRORS = new Set(['non-signal-emission', 'for-range', 'this-parameter', 'no-chart'])
const SYNTAX_CODES = new Set(['parse', 'missing-semicolon'])
/** Engine codes of KIELER's linking errors. */
const LINKING_CODES = new Set(['unknown-variable', 'unknown-state', 'unknown-chart', 'unknown-region', 'unknown-binding', 'unknown-label', 'not-callable'])
/**
 * Syntax-broken files where KIELER's error recovery keeps a partial element whose reference it then cannot resolve,
 * and the engine's recovery drops it: `input A` (A taken as a type, "EObject 'A'"), `f (x)` with a space, `pre(f())`,
 * `state S is Sub {` (a body after a reference), a transition target read as a name (`Rgo`).
 */
const RECOVERY_DIFFERENCES = new Set([
    'probes/decl-missing-type.sctx', 'probes/decl-misspelt-type.sctx', 'probes/expr-call-space.sctx', 'probes/expr-pre-call.sctx',
    'probes/state-is-with-body.sctx', 'wiki/syntax-12.sctx',
])

function fileOf(key: string): string {
    return key.startsWith('cs303:') ? path.join(CS303, key.slice('cs303:'.length)) : path.join(here, key)
}

const pos = (line: number | undefined, col: number | undefined) => `${line}:${col}`
const positions = (list: { line: number; col: number }[]) => list.map(d => pos(d.line, d.col)).sort()
const spanPositions = (list: Diagnostic[]) => list.map(d => pos(d.span?.line, d.span?.col)).sort()

const keys = Object.keys(expectations).filter(k => fs.existsSync(fileOf(k)))

describe('corpus agrees with KIELER', () => {
    it('has a recorded verdict for every corpus file', () => {
        for (const dir of ['wiki', 'lab', 'probes']) {
            for (const f of fs.readdirSync(path.join(here, dir)).filter(f => f.endsWith('.sctx'))) {
                expect(expectations[`${dir}/${f}`], `${dir}/${f} has no recording (run node tests/corpus/record.mjs ${dir}/${f})`).toBeDefined()
            }
        }
    })

    for (const key of keys) {
        it(key, () => {
            const e = expectations[key]
            const source = fs.readFileSync(fileOf(key), 'utf8')
            const parsed = parse(source)
            const kielerSyntax = e.syntax.length > 0 || e.errors.some(d => d.message === 'Missing Semicolon')
            const engineSyntax = parsed.diagnostics.filter(d => d.severity === 'error' && SYNTAX_CODES.has(d.code ?? ''))
            expect(engineSyntax.length > 0, `parse acceptance (KIELER: ${e.syntax.map(d => `${d.line}:${d.col} ${d.message}`).join('; ') || 'accepts'}; engine: ${engineSyntax.map(d => `${d.span?.line}:${d.span?.col} ${d.message}`).join('; ') || 'accepts'})`).toBe(kielerSyntax)

            const result = compile(source)
            if (kielerSyntax && engineSyntax.length && !RECOVERY_DIFFERENCES.has(key)) {
                // After a syntax error both still link the partial model.
                const linking = result.diagnostics.filter(d => d.severity === 'error' && LINKING_CODES.has(d.code ?? ''))
                expect(spanPositions(linking), `linking errors after the syntax error (KIELER: ${e.linking.map(d => `${d.line}:${d.col} ${d.message}`).join('; ') || 'none'}; engine: ${linking.map(d => `${d.span?.line}:${d.span?.col} ${d.kieler ?? d.message}`).join('; ') || 'none'})`).toEqual(positions(e.linking))
                for (const d of linking) {
                    const theirs = e.linking.filter(x => x.line === d.span?.line && x.col === d.span?.col).map(x => x.message)
                    if (theirs.length && d.kieler) expect(theirs).toContain(d.kieler)
                }
                // Of the validation, only broken imports are reported despite the syntax error (index.ts): KIELER's.
                for (const d of result.diagnostics.filter(x => x.code === 'broken-import')) {
                    expect(e.warnings.some(x => x.line === d.span?.line && x.col === d.span?.col), `broken import ${pos(d.span?.line, d.span?.col)}`).toBe(true)
                }
                // Nothing else of the validation is reported on a syntax-broken file.
                expect(result.diagnostics.filter(x => x.severity !== 'info' && !SYNTAX_CODES.has(x.code ?? '') && !LINKING_CODES.has(x.code ?? '') && x.code !== 'broken-import' && x.code !== 'swallowed-line').map(x => x.code)).toEqual([])
            }
            if (!kielerSyntax) {
                // Compile-stage rejections (scheduling, KIELER's compiler checks) are the conformance suite's business.
                const errors = result.diagnostics.filter(d => d.severity === 'error' && !SYNTAX_CODES.has(d.code ?? '') && !COMPILE_LEVEL_ERRORS.has(d.code ?? '') && !SIMULATOR_CODES.has(d.code ?? ''))
                const kielerErrors = [...e.linking, ...e.errors].filter(d => d.message !== 'Missing Semicolon')
                expect(spanPositions(errors), `errors (KIELER: ${kielerErrors.map(d => `${d.line}:${d.col} ${d.message.split('\n')[0]}`).join('; ')}; engine: ${errors.map(d => `${d.span?.line}:${d.span?.col} ${d.kieler ?? d.message}`).join('; ')})`).toEqual(positions(kielerErrors))
                // KIELER's validator warns about emitting a variable; the engine reports the compiler's error instead.
                const warnings = result.diagnostics.filter(d => (d.severity === 'warning' && !ENGINE_ONLY_WARNINGS.has(d.code ?? '') && !SIMULATOR_CODES.has(d.code ?? '')) || (d.severity === 'error' && d.code === 'non-signal-emission'))
                expect(spanPositions(warnings), `warnings (KIELER: ${e.warnings.map(d => `${d.line}:${d.col} ${d.message.split('\n')[0]}`).join('; ')}; engine: ${warnings.map(d => `${d.span?.line}:${d.span?.col} ${(d.kieler ?? d.message).split('\n')[0]}`).join('; ')})`).toEqual(positions(e.warnings))
                // Where KIELER has a message, the engine keeps it verbatim.
                for (const [ours, theirs] of [[errors, kielerErrors], [warnings, e.warnings]] as const) {
                    for (const d of ours) {
                        if (d.code === 'non-signal-emission' && d.severity === 'error') continue
                        const candidates = theirs.filter(x => x.line === d.span?.line && x.col === d.span?.col).map(x => x.message)
                        if (candidates.length && d.kieler) expect(candidates).toContain(d.kieler)
                    }
                }
            }
            const kielerFrontEndRejects = kielerSyntax || e.linking.length > 0 || e.errors.length > 0
            if (e.ok) expect(result.ok, `KIELER compiles this chart: ${result.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; ')}`).toBe(true)
            if (kielerFrontEndRejects) expect(result.ok).toBe(false)
            for (const d of result.diagnostics) {
                if (d.severity === 'error' && COMPILE_LEVEL_ERRORS.has(d.code ?? '')) expect(e.ok, `${d.code} only when KIELER rejects the chart`).toBe(false)
            }
        })
    }
})

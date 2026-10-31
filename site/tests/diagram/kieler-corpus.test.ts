// The same comparison with KIELER over the parser corpus (tests/corpus: KIELER wiki examples, lab fixtures and
// the parser's probes), recorded with `node tools/diagram-kieler-labels.mjs --corpus`.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareWithKieler, type KielerLabels } from './kieler-compare'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = path.join(here, 'kieler-corpus')
const corpus = path.join(here, '../corpus')
const cases = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.kieler-labels.json')).sort() : []

/** Known, deliberate or out-of-scope differences, with the reason. Everything else must match. */
const KNOWN: Record<string, string> = {
    'probes/state-duplicate-names.sctx': 'invalid chart: two states with one name',
    'probes/region-duplicate-names.sctx': 'invalid chart: two regions with one name',
    'probes/adv-policy.sctx': 'policies (PolicySynthesis) are not drawn',
    'probes/adv-schedule-clauses.sctx': 'schedule clauses are not in the AST',
    'probes/state-extends-cycle.sctx': 'inheritance (extends) is not drawn',
    'lab/inherited-clash.sctx': 'inheritance (extends): KIELER also shows inherited declarations and regions',
    'wiki/syntax-object-orientation-10.sctx': 'policies (PolicySynthesis) are not drawn',
    'wiki/syntax-object-orientation-11.sctx': 'method schedules ("order 0") are not in the AST',
    'probes/decl-schedule.sctx': 'the AST does not separate a schedule declaration\'s name and global protocol',
}

/** Whole families of out-of-scope constructs. */
const KNOWN_PATTERNS: [RegExp, string][] = [
    [/^probes\/(adv-)?polic(y|ies)/, 'policies (PolicySynthesis) are not drawn'],
]
const known = (key: string) => KNOWN[key] ?? KNOWN_PATTERNS.find(([re]) => re.test(key))?.[1]

describe('the diagram matches KIELER (parser corpus)', () => {
    for (const file of cases) {
        const key = file.replace('.kieler-labels.json', '').replace(/__/g, '/') + '.sctx'
        const source = path.join(corpus, key)
        if (!fs.existsSync(source)) continue
        const reference = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as KielerLabels
        const text = fs.readFileSync(source, 'utf8')
        const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
        if (reference.sourceHash && reference.sourceHash !== hash) {
            // The parser corpus changed this file since the recording.
            it.skip(`${key}: stale recording, run node tools/diagram-kieler-labels.mjs --corpus`, () => {})
            continue
        }
        if (known(key)) {
            it.skip(`${key}: ${known(key)}`, () => {})
            continue
        }
        if (!/\bscchart\b/.test(text)) {
            // No chart at all: KIELER shows a placeholder node.
            it(`${key} has no chart, and KIELER shows none either`, () => {
                expect(reference.states.map(s => s.rows.flat().join(' '))).toEqual(['No model in resource'])
                expect(reference.edges).toEqual([])
            })
            continue
        }
        compareWithKieler(key, text, reference)
    }
})

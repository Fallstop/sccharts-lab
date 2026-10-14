// Regression cases from differential testing against KIELER's parser (kieler-diff.test.ts): mutated corpus files
// and random snippets, each with KIELER's recorded verdict. parse() must accept exactly the ones KIELER accepts.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '../../src/engine'

const here = path.dirname(new URL(import.meta.url).pathname)
const probes: { text: string; kieler: 'accept' | 'reject'; first?: string; source?: string }[] = JSON.parse(fs.readFileSync(path.join(here, 'syntax-probes.json'), 'utf8'))

describe('syntax probes agree with KIELER', () => {
    it(`${probes.length} recorded verdicts`, () => {
        const wrong: string[] = []
        for (const p of probes) {
            const errors = parse(p.text).diagnostics.filter(d => d.severity === 'error' && (d.code === 'parse' || d.code === 'missing-semicolon'))
            const engine = errors.length ? 'reject' : 'accept'
            if (engine !== p.kieler) wrong.push(`KIELER ${p.kieler}${p.first ? ` (${p.first})` : ''}, engine ${engine}${errors[0] ? ` (${errors[0].span?.line}:${errors[0].span?.col} ${errors[0].message})` : ''}\n${p.text}`)
        }
        expect(wrong, wrong.slice(0, 5).join('\n-----\n')).toEqual([])
    })
})

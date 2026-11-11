// A quick slice of tools/cgen (`pnpm cgen:check` runs everything): generated C compiled with gcc and run on recorded
// scenarios and random charts must match the engine's simulation and KIELER's recordings tick by tick. Skipped when
// gcc is not on PATH.

import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCase, type Case } from '../../tools/cgen/compare'
import { collectCases } from '../../tools/cgen/corpus'
import { hasGcc, pool } from '../../tools/cgen/gcc'
import { generate as randomChart, PROFILES } from '../../tools/fuzz/gen'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gcc = await hasGcc()

/** Every chart with host code or print, and every 12th of the others: all areas, about 120 charts. */
function sample(): Case[] {
    const all = collectCases(site)
    return all.filter((c, i) => i % 12 === 0 || /host-code|print|showcase|abort-region|history|methods/.test(c.id) || /print\(/.test(c.source))
}

describe.skipIf(!gcc)('generated C behaves like the engine and KIELER (gcc)', () => {
    it('recorded scenarios', async () => {
        const cases = sample()
        expect(cases.length).toBeGreaterThan(80)
        const results = await pool(cases, 16, c => checkCase(c))
        const bad = results.filter(r => r.verdict === 'mismatch').map(r => `${r.id}\n  ${r.problems.slice(0, 4).join('\n  ')}`)
        expect(bad).toEqual([])
        expect(results.filter(r => r.verdict === 'match').length).toBeGreaterThan(60)
        expect(results.some(r => r.hostCode && r.verdict === 'match')).toBe(true)
    }, 180_000)

    it('random charts', async () => {
        const cases: Case[] = Object.keys(PROFILES).flatMap(profile => [0, 1, 2, 3].map(i => {
            const job = randomChart(5, profile, i)
            return { id: job.name, source: job.model, inputs: job.inputs }
        }))
        const results = await pool(cases, 16, c => checkCase(c))
        const bad = results.filter(r => r.verdict === 'mismatch').map(r => `${r.id}\n  ${r.problems.slice(0, 4).join('\n  ')}`)
        expect(bad).toEqual([])
        expect(results.filter(r => r.verdict === 'match').length).toBeGreaterThan(10)
    }, 180_000)
})

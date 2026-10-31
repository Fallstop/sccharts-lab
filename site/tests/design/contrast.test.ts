// Every colour pair the guide relies on meets WCAG AA in both themes (tools/contrast.mjs reads
// src/styles/tokens.css).
import { describe, expect, it } from 'vitest'
import { checkContrast } from '../../tools/contrast.mjs'

describe('colour tokens', () => {
    const results = checkContrast() as { theme: string; label: string; ratio: number; min: number; ok: boolean }[]
    it('checks both themes', () => {
        expect(new Set(results.map((r) => r.theme))).toEqual(new Set(['light', 'dark']))
    })
    for (const r of results) {
        it(`${r.theme}: ${r.label} (${r.ratio.toFixed(2)} >= ${r.min})`, () => {
            expect(r.ok).toBe(true)
        })
    }
})

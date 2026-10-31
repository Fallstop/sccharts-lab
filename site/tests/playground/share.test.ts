// Share links (lz-string in the URL hash) and the guarded local storage of the playground.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { decodeSource, encodeSource, fileNameFor, hashForSource, shareUrl, sourceFromHash, storageGet, storageSet } from '../../src/components/playground/share'

const chart = `scchart Toggle {
  input bool button
  output bool light = false

  initial state Off
    if button do light = true go to On

  state On
    if button do light = false go to Off
}
`

describe('share encoding', () => {
    test('round trip, including non-ASCII text and line endings', () => {
        for (const src of [chart, 'scchart A {\r\n  initial state Ä "Größe ≥ 3 → ✓"\r\n}', 'x', '/* 😀 */\n'.repeat(50)]) {
            expect(decodeSource(encodeSource(src))).toBe(src)
            expect(sourceFromHash(hashForSource(src))).toBe(src)
        }
    })

    test('the encoding needs no escaping in a URL fragment and is shorter than the source', () => {
        const enc = encodeSource(chart)
        expect(enc).toMatch(/^[A-Za-z0-9+\-$]+$/)
        expect(enc.length).toBeLessThan(chart.length)
        expect(encodeURIComponent(enc).replace(/%2B/g, '+')).toBe(enc)
    })

    test('a link with spaces for pluses still decodes', () => {
        const enc = encodeSource(chart)
        expect(enc).toContain('+')
        expect(decodeSource(enc.replace(/\+/g, ' '))).toBe(chart)
    })

    test('invalid or missing hashes give null', () => {
        expect(sourceFromHash('')).toBeNull()
        expect(sourceFromHash('#')).toBeNull()
        expect(sourceFromHash('#other=1')).toBeNull()
        expect(sourceFromHash('#code=')).toBeNull()
        expect(sourceFromHash('#code=%%%')).toBeNull()
        expect(decodeSource('not lz')).toBeNull()
    })

    test('the hash may carry other parameters', () => {
        expect(sourceFromHash(`#x=1&${hashForSource(chart).slice(1)}`)).toBe(chart)
    })

    test('share URLs drop the query and keep the path', () => {
        const url = shareUrl('https://sccharts.jmw.nz/playground/?example=learn/x/y#code=old', chart)
        expect(url.startsWith('https://sccharts.jmw.nz/playground/#code=')).toBe(true)
        expect(sourceFromHash(new URL(url).hash)).toBe(chart)
    })

    test('download file names', () => {
        expect(fileNameFor('Toggle')).toBe('Toggle.sctx')
        expect(fileNameFor(undefined)).toBe('chart.sctx')
        expect(fileNameFor('a/b c')).toBe('abc.sctx')
    })
})

describe('storage', () => {
    afterEach(() => vi.unstubAllGlobals())

    test('works when storage works', () => {
        const map = new Map<string, string>()
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => void map.set(k, v),
            removeItem: (k: string) => void map.delete(k),
        })
        expect(storageSet('k', 'v')).toBe(true)
        expect(storageGet('k')).toBe('v')
        expect(storageSet('k', null)).toBe(true)
        expect(storageGet('k')).toBeNull()
    })

    test('never throws when storage is blocked', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError') },
            setItem: () => { throw new Error('QuotaExceededError') },
            removeItem: () => { throw new Error('SecurityError') },
        })
        expect(storageGet('k')).toBeNull()
        expect(storageSet('k', 'v')).toBe(false)
        expect(storageSet('k', null)).toBe(false)
    })
})

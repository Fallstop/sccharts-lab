import { describe, expect, it } from 'vitest'
import { labelWidthFor, renderWave } from '../../src/components/frame/wave'

describe('renderWave, simulation extensions', () => {
    it('draws a valued signal as a bus that is filled while present, a new segment per emission', () => {
        const svg = renderWave([{ name: 'V', kind: 'signal', values: [{ present: false, value: 0 }, { present: true, value: 4 }, { present: true, value: 4 }, { present: false, value: 4 }] }], { columns: 4 })
        expect((svg.match(/wv-bus is-present/g) ?? []).length).toBe(2)
        expect((svg.match(/wv-bus is-absent/g) ?? []).length).toBe(2)
        expect(svg).toContain('class="wv-value is-held"')
    })

    it('draws "no value" (null) as a mid-level line, and breaks a segment where asked', () => {
        const svg = renderWave([{ name: 'R', kind: 'value', role: 'state', values: ['A', null, 'B', 'B'], breaks: [false, false, false, true] }], { columns: 4 })
        expect(svg).toContain('class="wv-none"')
        expect((svg.match(/class="wv-bus"/g) ?? []).length).toBe(3)
    })

    it('marks differences, group captions and termination', () => {
        const svg = renderWave(
            [{ name: 'O', kind: 'bool', group: 'Chart A', values: [false, true], marks: [false, true] }],
            { columns: 2, marks: { 1: 'term' } }
        )
        expect((svg.match(/class="wv-diff"/g) ?? []).length).toBe(1)
        expect(svg).toContain('>Chart A</text>')
        expect(svg).toContain('class="wv-term"')
    })

    it('says presence, held values, "not active" and differences in the screen-reader table', () => {
        const html = renderWave(
            [
                { name: 'S', kind: 'bool', presence: true, values: [false, true] },
                { name: 'V', kind: 'signal', values: [{ present: false, value: 0 }, { present: true, value: 4 }] },
                { name: 'R', kind: 'value', role: 'state', values: ['A', null] },
                { name: 'O', kind: 'bool', group: 'B', values: [false, true], marks: [false, true] },
            ],
            { columns: 4, table: true, cursor: 1 }
        )
        expect(html).toContain('<th scope="col">B: O</th>')
        expect(html).toContain('<tr><th scope="row">Tick 1</th><td>absent</td><td>absent, 0</td><td>A</td><td>false</td></tr>')
        expect(html).toContain('<tr aria-current="true"><th scope="row">Tick 2, shown</th><td>present</td><td>present, 4</td><td>not active</td><td>true, differs</td></tr>')
        expect((html.match(/<tr/g) ?? []).length).toBe(3)
    })

    it('sizes the label column for the names', () => {
        expect(labelWidthFor(['a'])).toBe(48)
        expect(labelWidthFor(['HandleA'])).toBe(72)
        expect(labelWidthFor(['x'.repeat(40)])).toBe(150)
    })
})

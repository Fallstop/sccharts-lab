// The wording of the widgets' compiler messages: the warnings box's summary and items (frame/diagnostics.ts), links
// in hints (inlineCode, withoutLinkTo), and the error mark of a transition KIELER cannot draw (errorClasses).
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/engine/index'
import { allSame, diagnosticKind, groupWarnings, itemHead, warningSummary, type ListedDiagnostic } from '../../src/components/frame/diagnostics'
import { inlineCode, withoutLinkTo } from '../../src/components/frame/inline-md'
import { errorClasses, lineMap } from '../../src/components/sim/lines'

const loop: ListedDiagnostic = {
    severity: 'info',
    code: 'kieler-loop-warning',
    message: 'KIELER warns about a potential instantaneous loop here, but compiles and runs the chart correctly',
    kieler: 'Instantaneous loop detected!',
    hint: 'The circle runs through `Off` and `On`. The chart works as written. See [Instantaneous loop detected!](/reference/errors/#instantaneous-loop-detected).',
    line: 5,
    col: 17,
}
const unreachable: ListedDiagnostic = { severity: 'warning', message: 'The transition is not reachable.', line: 7, col: 5 }
const quirk: ListedDiagnostic = { severity: 'info', code: 'kieler-quirk', message: 'KIELER never terminates a chart with signals' }

describe('the warnings summary', () => {
    it('says one warning in full, and counts mixed ones', () => {
        expect(diagnosticKind(loop)).toBe('Warning')
        expect(diagnosticKind(quirk)).toBe('Note')
        expect(warningSummary([loop])).toBe(`Warning: ${loop.message}`)
        expect(warningSummary([loop, unreachable, quirk])).toBe('2 warnings and 1 note')
        expect(warningSummary([loop], { name: 'Blink' })).toBe(`Warning: ${loop.message} (\`Blink\`)`)
    })

    it('says a message that several warnings share once, with their count', () => {
        const twice = [unreachable, { ...unreachable, line: 9 }]
        expect(allSame(twice)).toBe(true)
        expect(warningSummary(twice)).toBe('2 warnings: The transition is not reachable.')
    })

    it('names the charts of a Compare, without counting a warning each chart gets once', () => {
        const both = [{ ...loop, chart: 'Blink' }, { ...loop, chart: 'BlinkForgetful' }]
        expect(warningSummary(both)).toBe(`Warning: ${loop.message} (\`Blink\` and \`BlinkForgetful\`)`)
        expect(warningSummary([{ ...loop, chart: 'A' }, { ...unreachable, chart: 'B' }])).toBe('2 warnings (`A` and `B`)')
    })

    it('reads on after a rejected chart\'s errors', () => {
        expect(warningSummary([unreachable], { rejected: true })).toBe('Also a warning: The transition is not reachable.')
        expect(warningSummary([loop, quirk], { rejected: true })).toBe('Also 1 warning and 1 note')
    })
})

describe('the warnings box\'s items', () => {
    it('lists the same warning of two charts once, naming both', () => {
        const groups = groupWarnings([{ ...loop, chart: 'Blink' }, { ...loop, chart: 'BlinkForgetful' }, { ...unreachable, chart: 'Blink' }])
        expect(groups.map((g) => itemHead(g.d, g.charts))).toEqual([
            'Warning in `Blink` and `BlinkForgetful`, line 5, column 17',
            'Warning in `Blink`, line 7, column 5',
        ])
        // At different places they stay apart.
        expect(groupWarnings([loop, { ...loop, line: 6 }]).length).toBe(2)
        expect(itemHead(quirk)).toBe('Note')
    })
})

describe('links in compiler messages and hints', () => {
    it('renders code and links, everything else as written', () => {
        expect(inlineCode('Set `x *= 3`, see [the `pre` section](/learn/pre/#count) or [KIELER](https://example.org/a?b=1&c=2).')).toBe(
            'Set <code class="sc-nobr">x *= 3</code>, see <a href="/learn/pre/#count">the <code class="sc-nobr">pre</code> section</a> or <a href="https://example.org/a?b=1&amp;c=2">KIELER</a>.'
        )
        // Not a link: an array index, or a target that is neither a path nor a web address.
        expect(inlineCode('a[3] (x) and [y](javascript:alert)')).toBe('a[3] (x) and [y](javascript:alert)')
        expect(inlineCode("It's \"quoted\" <b>")).toBe('It&#39;s &quot;quoted&quot; &lt;b&gt;'.replace('&#39;', "'"))
    })

    it('drops a hint\'s pointer to the section that About this message links already', () => {
        const about = '/reference/errors/#instantaneous-loop-detected'
        expect(withoutLinkTo(loop.hint!, about)).toBe('The circle runs through `Off` and `On`. The chart works as written.')
        expect(withoutLinkTo(loop.hint!, '/reference/errors/#other')).toBe(loop.hint)
        expect(withoutLinkTo(loop.hint!, undefined)).toBe(loop.hint)
        expect(withoutLinkTo('Rename it (see [Names](/x/#names)).', '/x/#names')).toBe('Rename it.')
    })
})

describe('error marks', () => {
    it('marks the state a transition with an unknown target leaves (KIELER does not draw the transition)', () => {
        const source = fs.readFileSync(new URL('../../src/examples/reference/errors/unknown-state.sctx', import.meta.url), 'utf8')
        const c = compile(source)
        const errors = c.diagnostics.filter((d) => d.severity === 'error')
        expect(errors.map((d) => d.code)).toEqual(['unknown-state'])
        const map = lineMap(c.chart!, source)
        expect(errorClasses(errors, map, c.chart!.id)).toEqual({ 'UnknownState.Outer.Inner': ['is-error'] })
        // The same when the engine names the transition, or the state, itself.
        expect(errorClasses([{ ...errors[0], related: ['UnknownState.Outer.Inner->0'] }], map, c.chart!.id)).toEqual({ 'UnknownState.Outer.Inner': ['is-error'] })
        expect(errorClasses([{ ...errors[0], related: ['UnknownState.Outer.Inner'] }], map, c.chart!.id)).toEqual({ 'UnknownState.Outer.Inner': ['is-error'] })
    })
})

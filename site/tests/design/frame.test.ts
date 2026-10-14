// The widget layer's pure helpers: example loading (and its build errors), the regex-level interface
// reader the placeholders use, inline Markdown, and the timing-diagram renderer.
import { describe, expect, it } from 'vitest'
import { chartNameOf, exampleIds, interfaceOf, loadExample, playgroundHref } from '../../src/components/frame/examples'
import { inlineMd } from '../../src/components/frame/inline-md'
import { renderWave } from '../../src/components/frame/wave'

describe('loadExample', () => {
    it('loads an example by path without the extension', () => {
        const ex = loadExample('landing/toggle', 'test')
        expect(ex.file).toBe('src/examples/landing/toggle.sctx')
        expect(ex.chartName).toBe('Toggle')
        expect(ex.source).toContain('initial state Off')
        expect(ex.scenario?.ticks.length).toBe(7)
    })

    it('accepts a .sctx suffix and a src/examples/ prefix', () => {
        expect(loadExample('src/examples/landing/toggle.sctx', 'test').id).toBe('landing/toggle')
    })

    it('fails with a message that names the missing file and the widget', () => {
        expect(() => loadExample('landing/nope', '<Sim example="landing/nope">')).toThrow(
            /<Sim example="landing\/nope">: no example file at src\/examples\/landing\/nope\.sctx.*landing\/toggle/
        )
        expect(() => loadExample('', '<Chart>')).toThrow(/the "example" prop is missing/)
    })

    it('lists the examples', () => {
        expect(exampleIds()).toContain('landing/toggle')
    })

    it('builds playground links', () => {
        expect(playgroundHref('learn/a b')).toBe('/playground/?example=learn%2Fa%20b')
        expect(playgroundHref('learn/x/starter', 'learn/x/solution')).toBe('/playground/?example=learn%2Fx%2Fstarter&solution=learn%2Fx%2Fsolution')
    })
})

describe('interfaceOf and chartNameOf', () => {
    // KIELER simulates the first chart of a file: so do these.
    const src = `
// scchart Commented
scchart Main {
  input bool A, B
  input signal S
  output int count = 0, other
  input output float level
  output signal int V combine +
  bool local
  /* output bool hidden */
  initial state I
}
scchart Helper { input bool x output bool y }`
    it('reads the first chart', () => {
        expect(chartNameOf(src)).toBe('Main')
        expect(chartNameOf('scchart A {}\nscchart B {}')).toBe('A')
    })
    it('reads inputs and outputs of the first chart, with types', () => {
        expect(interfaceOf(src)).toEqual([
            { name: 'A', direction: 'input', type: 'bool' },
            { name: 'B', direction: 'input', type: 'bool' },
            { name: 'S', direction: 'input', type: 'signal' },
            { name: 'count', direction: 'output', type: 'int' },
            { name: 'other', direction: 'output', type: 'int' },
            { name: 'level', direction: 'inout', type: 'float' },
            { name: 'V', direction: 'output', type: 'int' },
        ])
    })
})

describe('loadExample: imports', () => {
    it('passes the files a scenario imports', () => {
        const ex = loadExample('advanced/references/import-main', 'test')
        expect(Object.keys(ex.files)).toEqual(['push-switch.sctx'])
        expect(ex.files['push-switch.sctx']).toContain('scchart')
    })
    it('has no files for a chart that imports nothing', () => {
        expect(loadExample('landing/toggle', 'test').files).toEqual({})
    })
})

describe('inlineMd', () => {
    it('renders code, bold, italics and links, escaping everything else', () => {
        expect(inlineMd('`a < b` is **bold**, *it* and [x](/y) <script>')).toBe(
            '<code class="sc-nobr">a &lt; b</code> is <strong>bold</strong>, <em>it</em> and <a href="/y">x</a> &lt;script&gt;'
        )
    })
    it('does not format inside code spans', () => {
        expect(inlineMd('`**not bold** here`')).toBe('<code>**not bold** here</code>')
    })
    it('takes backslash escapes literally', () => {
        expect(inlineMd('2 \\* 3 \\* 4')).toBe('2 * 3 * 4')
        expect(inlineMd('\\*not italic\\*')).toBe('*not italic*')
        expect(inlineMd('\\_x\\_ and \\`y\\`')).toBe('_x_ and `y`')
        expect(inlineMd('a \\\\ b')).toBe('a \\ b')
        // Inside code a backslash is literal (CommonMark).
        expect(inlineMd('`a\\*b`')).toBe('<code class="sc-nobr">a\\*b</code>')
    })
    it('keeps short code spans in one piece (`->` must not break after the hyphen)', () => {
        expect(inlineMd('`->`')).toBe('<code class="sc-nobr">-&gt;</code>')
        expect(inlineMd('`Speed.MEDIUM`')).toBe('<code class="sc-nobr">Speed.MEDIUM</code>')
        // Up to 12 characters stay together with their spaces too: words (`go to`) and short expressions.
        expect(inlineMd('`go to`')).toBe('<code class="sc-nobr">go to</code>')
        expect(inlineMd('`abort to`')).toBe('<code class="sc-nobr">abort to</code>')
        expect(inlineMd('`x += 1`')).toBe('<code class="sc-nobr">x += 1</code>')
        expect(inlineMd('`if d != 0`')).toBe('<code class="sc-nobr">if d != 0</code>')
        expect(inlineMd('`if A go to B`')).toBe('<code class="sc-nobr">if A go to B</code>')
        // Longer code may break at its spaces (it would overflow a phone otherwise).
        expect(inlineMd('`if A go to Done`')).toBe('<code>if A go to Done</code>')
        expect(inlineMd('`averyveryverylongidentifier`')).toBe('<code>averyveryverylongidentifier</code>')
    })
    it('formats around code spans in one piece: code inside links, bold and italics', () => {
        expect(inlineMd('see [the `pre` chapter](/learn/pre/).')).toBe(
            'see <a href="/learn/pre/">the <code class="sc-nobr">pre</code> chapter</a>.'
        )
        expect(inlineMd('**`A` wins** and *`B`*')).toBe(
            '<strong><code class="sc-nobr">A</code> wins</strong> and <em><code class="sc-nobr">B</code></em>'
        )
        // A code span's own text is never formatted, also when it looks like a link.
        expect(inlineMd('`[x](/y)` and `**`')).toBe('<code class="sc-nobr">[x](/y)</code> and <code class="sc-nobr">**</code>')
    })
    it('curls quotes and apostrophes outside code, as the pages do', () => {
        expect(inlineMd("the region's \"main\" state")).toBe('the region\u2019s \u201cmain\u201d state')
        expect(inlineMd("'quoted' and (\"bracketed\")")).toBe('\u2018quoted\u2019 and (\u201cbracketed\u201d)')
        // A quote right after code closes: an apostrophe, or the end of a quotation.
        expect(inlineMd("`Off`'s outline")).toBe('<code class="sc-nobr">Off</code>\u2019s outline')
        expect(inlineMd('he wrote "`go to`" here')).toBe('he wrote \u201c<code class="sc-nobr">go to</code>\u201d here')
        // Quotes inside code stay straight.
        expect(inlineMd("`'a'` and `\"b\"`")).toBe('<code class="sc-nobr">\'a\'</code> and <code class="sc-nobr">&quot;b&quot;</code>')
    })
})

describe('renderWave', () => {
    it('draws bool lanes as a line with filled highs, and buses with values', () => {
        const svg = renderWave(
            [
                { name: 'A', kind: 'bool', role: 'input', values: [false, true, true] },
                { name: 'n', kind: 'value', role: 'output', values: [0, 1, 1] },
            ],
            { columns: 4 }
        )
        expect((svg.match(/class="wv-fill"/g) ?? []).length).toBe(2)
        expect(svg).toContain('class="wv-line"')
        // Two bus segments: 0, then 1 for two ticks.
        expect((svg.match(/class="wv-bus"/g) ?? []).length).toBe(2)
        // The cursor is on the last tick that ran (column 3 of 4).
        expect(svg).toMatch(/class="wv-tick is-cursor"[^>]*>3</)
    })
    it('escapes names and values', () => {
        const svg = renderWave([{ name: '<x>', kind: 'value', values: ['"q"'] }], { columns: 1 })
        expect(svg).not.toContain('<x>')
        expect(svg).toContain('&lt;x&gt;')
    })
})

// <sccharts-lab-chart> without a browser: the module loads where there is no DOM (the site's build), the code written
// inside the element becomes files, and the attributes become the embed's address (options.test.ts has the rest).
import { describe, expect, test } from 'vitest'
import { dedent, inlineFiles, SCChartsLabChart, TAG } from '@sccharts-lab/embed/element'
import { embedUrl, targetFromAttributes } from '@sccharts-lab/embed/options'

/** Just enough of an element for inlineFiles: its children, each with a tag, attributes and text. */
function host(children: { tag: string; text: string; attrs?: Record<string, string>; type?: string }[]) {
    const kids = children.map(c => ({
        tagName: c.tag.toUpperCase(),
        textContent: c.text,
        value: c.text,
        getAttribute: (n: string) => c.attrs?.[n] ?? (n === 'type' ? c.type ?? null : null),
        hasAttribute: (n: string) => !!c.attrs && n in c.attrs,
        matches: (sel: string) =>
            sel.split(',').some(s => {
                const t = s.trim()
                if (t === 'script[type="text/sctx"]') return c.tag === 'script' && c.type === 'text/sctx'
                return t === c.tag
            }),
    }))
    return { children: kids } as unknown as Element
}

describe('the element module', () => {
    test('loads without a DOM', () => {
        expect(TAG).toBe('sccharts-lab-chart')
        expect(typeof SCChartsLabChart).toBe('function')
        expect(SCChartsLabChart.observedAttributes).toEqual(expect.arrayContaining(['example', 'src', 'view', 'height', 'tick', 'tour', 'controls', 'chart', 'run', 'label']))
    })
})

describe('code written inside the element', () => {
    test('loses the indentation of the HTML around it', () => {
        expect(dedent('\n    scchart A {\n      initial state S\n    }\n  ')).toBe('scchart A {\n  initial state S\n}\n')
        expect(dedent('scchart A {}')).toBe('scchart A {}\n')
        expect(dedent('\r\n\tscchart A {\r\n\t}\r\n')).toBe('scchart A {\n}\n')
    })

    test('a <pre>, a <textarea> or a <script type="text/sctx"> is a file; other children are not', () => {
        expect(inlineFiles(host([{ tag: 'p', text: 'hello' }]))).toBeUndefined()
        expect(inlineFiles(host([{ tag: 'pre', text: '\n  scchart A {}\n' }]))).toEqual({ files: { 'main.sctx': 'scchart A {}\n' }, active: 'main.sctx' })
        expect(inlineFiles(host([{ tag: 'script', type: 'text/sctx', text: 'scchart B {}' }]))).toEqual({ files: { 'main.sctx': 'scchart B {}\n' }, active: 'main.sctx' })
        expect(inlineFiles(host([{ tag: 'script', type: 'module', text: 'alert(1)' }]))).toBeUndefined()
        expect(inlineFiles(host([{ tag: 'textarea', text: 'scchart C {}' }]))?.files['main.sctx']).toBe('scchart C {}\n')
    })

    test('several make a project, named by data-file; the first is shown unless one says data-active', () => {
        const two = host([
            { tag: 'pre', text: 'import "beep"\nscchart Main {}', attrs: { 'data-file': 'main.sctx' } },
            { tag: 'pre', text: 'scchart Beep {}', attrs: { 'data-file': 'beep' } },
        ])
        expect(inlineFiles(two)).toEqual({ files: { 'main.sctx': 'import "beep"\nscchart Main {}\n', 'beep.sctx': 'scchart Beep {}\n' }, active: 'main.sctx' })
        const chosen = host([
            { tag: 'pre', text: 'scchart A {}' },
            { tag: 'pre', text: 'scchart B {}', attrs: { 'data-active': '' } },
        ])
        expect(inlineFiles(chosen)).toEqual({ files: { 'main.sctx': 'scchart A {}\n', 'main-2.sctx': 'scchart B {}\n' }, active: 'main-2.sctx' })
        // A data-file that is not a file name falls back to a numbered one.
        expect(Object.keys(inlineFiles(host([{ tag: 'pre', text: 'x', attrs: { 'data-file': '../../etc/passwd"' } }]))!.files)).toEqual(['main.sctx'])
    })
})

describe('the frame the element makes', () => {
    const attrs = (a: Record<string, string>) => (n: string) => a[n] ?? null
    test('an example, a view and the auto height', () => {
        expect(embedUrl('https://sccharts.jmw.nz/', targetFromAttributes(attrs({ example: 'learn/concurrency/abro', view: 'full' })))).toBe(
            'https://sccharts.jmw.nz/embed/?example=learn/concurrency/abro&view=full&height=auto',
        )
    })
    test('code of its own: the page sends it', () => {
        expect(embedUrl('https://sccharts.jmw.nz/', { ...targetFromAttributes(attrs({ height: '300', tour: '' })), source: 'parent' })).toBe(
            'https://sccharts.jmw.nz/embed/?source=parent&height=300&tour',
        )
    })
})

// The playground's model queries (scope, targets, what is under the mouse), completion, offsets between edited and
// compiled text, diagnostics in the editor, the example catalogue and the showcase charts.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState, Text } from '@codemirror/state'
import { compile } from '../../src/engine/index'
import { hitAt, namesInScope, scopeChain, targetRegionAt } from '../../src/components/playground/analysis'
import { completionSource, suggestionOf, toLintDiagnostics, type AnalysisView } from '../../src/components/playground/editor-features'
import { DocTracker } from '../../src/components/playground/editor'
import { sctx } from '../../src/components/playground/sctx-language'
import { buildCatalogue, examplesInPage, firstChartName, allItems } from '../../src/components/playground/catalogue'
import { keywordDoc, KEYWORD_DOCS } from '../../src/components/playground/keyword-docs'

const ABRO = fs.readFileSync(path.resolve('src/components/playground/showcase/abro.sctx'), 'utf8')
const at = (src: string, needle: string, k = 0) => {
    const i = src.indexOf(needle)
    if (i < 0) throw new Error(`no ${needle}`)
    return i + k
}

function analysisOf(source: string): AnalysisView {
    const result = compile(source)
    return { result, toSource: p => p, fromSource: p => p, lineOf: p => source.slice(0, p).split('\n').length }
}

describe('model queries', () => {
    const r = compile(ABRO)
    const program = r.program!

    test('scope chain and names in scope', () => {
        const chain = scopeChain(program, at(ABRO, 'if A go to'))
        expect(chain.map(n => (n.kind === 'state' ? n.name : `region ${n.name ?? ''}`))).toEqual(['ABRO', 'region ', 'ABO', 'region ', 'WaitAB', 'region HandleA', 'WaitA'])
        expect(namesInScope(program, at(ABRO, 'if A go to')).map(n => n.vo.name)).toEqual(['A', 'B', 'R', 'O'])
        expect(namesInScope(program, ABRO.length + 10)).toEqual([])
    })

    test('the region a transition can target', () => {
        expect(targetRegionAt(program, at(ABRO, 'if A go to'))?.states.map(s => s.name)).toEqual(['WaitA', 'DoneA'])
        // A transition written after a superstate's closing brace belongs to the superstate: its siblings.
        expect(targetRegionAt(program, at(ABRO, 'if R abort to'))?.states.map(s => s.name)).toEqual(['ABO'])
        expect(targetRegionAt(program, at(ABRO, 'do O join to'))?.states.map(s => s.name)).toEqual(['WaitAB', 'Done'])
    })

    test('what is under the mouse', () => {
        const ref = hitAt(r, at(ABRO, 'if R abort', 3))
        expect(ref?.kind).toBe('variable')
        if (ref?.kind === 'variable') {
            expect(ref.entry.vo.name).toBe('R')
            expect(ref.isDeclaration).toBe(false)
            expect(ref.entry.decl?.input).toBe(true)
        }
        const decl = hitAt(r, at(ABRO, 'output signal O', 14))
        expect(decl?.kind === 'variable' && decl.isDeclaration && decl.entry.vo.name).toBe('O')
        const target = hitAt(r, at(ABRO, 'go to DoneA', 7))
        expect(target?.kind === 'state' && !target.isDeclaration && target.state.id).toBe('ABRO.ABO.WaitAB.DoneA')
        const name = hitAt(r, at(ABRO, 'state WaitB', 7))
        expect(name?.kind === 'state' && name.isDeclaration && name.state.name).toBe('WaitB')
        expect(hitAt(r, at(ABRO, 'scchart ABRO', 9))?.kind).toBe('chart')
        expect(hitAt(r, at(ABRO, 'initial state', 2))).toBeUndefined()
    })
})

describe('completion', () => {
    const complete = (source: string, pos: number, explicit = false) => {
        const state = EditorState.create({ doc: source, extensions: [sctx()] })
        return completionSource(() => analysisOf(source))(new CompletionContext(state, pos, explicit))
    }

    test('after go to: the states of the region', () => {
        const src = ABRO.replace('if A go to DoneA', 'if A go to ')
        const res = complete(src, at(src, 'if A go to ', 11))
        expect(res?.options.map(o => o.label).sort()).toEqual(['DoneA', 'WaitA'])
        expect(res?.options.every(o => o.type === 'state')).toBe(true)
    })

    test('names in scope first, then keywords; snippets at the start of a line', () => {
        const src = ABRO.replace('if A go to DoneA', 'if  go to DoneA')
        const res = complete(src, at(src, 'if  go', 3), true)!
        const vars = res.options.filter(o => o.type === 'signal').map(o => o.label)
        expect(vars).toEqual(['A', 'B', 'R', 'O'])
        expect(res.options.find(o => o.label === 'A')?.detail).toBe('input signal')
        expect(res.options.some(o => o.label === 'pre( )')).toBe(true)
        expect(res.options.some(o => o.type === 'snippet' && o.label === 'initial state')).toBe(false)
        const line = complete(ABRO, at(ABRO, '    state Done') + 4, true)!
        expect(line.options.some(o => o.label === 'initial state')).toBe(true)
        expect(line.options.some(o => o.label === 'state' && o.type === 'keyword')).toBe(true)
    })

    test('nothing in comments, and not unasked between words', () => {
        expect(complete(ABRO, at(ABRO, 'hello world', 2))).toBeNull()
        expect(complete(ABRO, at(ABRO, 'if A go', 3), false)).toBeNull()
    })
})

describe('keyword docs', () => {
    test('two-word keywords and context', () => {
        expect(keywordDoc('to', 'if A abort ', '')?.syntax).toBe('abort to Target')
        expect(keywordDoc('to', 'if A go ', '')?.syntax).toBe('go to Target')
        expect(keywordDoc('final', '', ' region R:')?.syntax).toBe('final region R:')
        expect(keywordDoc('history', 'go to S shallow ', '')?.syntax).toContain('shallow history')
        expect(keywordDoc('constructor', '', '')).toBeUndefined()
        for (const d of Object.values(KEYWORD_DOCS)) expect(d.text).not.toMatch(/\([A-Z]-\d+/)
    })
})

describe('offsets and diagnostics', () => {
    test('DocTracker maps between the compiled text and the edited text', () => {
        const doc = Text.of(['scchart A {', '  initial state B', '}'])
        const t = new DocTracker(doc)
        const state = EditorState.create({ doc })
        // Insert a line at the top.
        const tr = state.update({ changes: { from: 0, insert: '// note\n' } })
        t.add(tr.changes)
        expect(t.changed).toBe(true)
        expect(t.fromSnapshot(12)).toBe(20)
        expect(t.toSnapshot(20)).toBe(12)
        // Text typed after the snapshot has no exact counterpart.
        expect(t.toSnapshot(3, true)).toBeNull()
        expect(t.toSnapshot(3)).toBe(0)
    })

    test('lint diagnostics keep their place and carry KIELER\'s wording', () => {
        const src = ABRO.replace('go to DoneA', 'go to Donea')
        const r = compile(src)
        expect(r.ok).toBe(false)
        const lint = toLintDiagnostics(r.diagnostics, { fromSource: p => p + 5 }, src.length + 5)
        const d = r.diagnostics.find(x => x.severity === 'error')!
        const l = lint.find(x => x.severity === 'error')!
        expect(l.from).toBe(d.span!.start + 5)
        expect(l.message).toBe(d.message)
        // "Did you mean" becomes a quick fix.
        expect(suggestionOf(d)).toBe('DoneA')
        expect(l.actions?.map(a => a.name)).toEqual(['Change to DoneA'])
        // An empty or out-of-range span still gets a visible range.
        const [e] = toLintDiagnostics([{ severity: 'error', message: 'x' }], { fromSource: p => p }, 10)
        expect(e.to - e.from).toBe(1)
    })
})

describe('catalogue', () => {
    test('the examples a page uses, in order; exercise starters and solutions', () => {
        const body = `<Sim example="learn/x/a" />\n<Chart example="learn/x/b" code={false} />\n<TryIt example="learn/x/c" solution="learn/x/c-solution" title="T">x</TryIt>\n<Compare a="learn/x/d" b="learn/x/a" />`
        const found = examplesInPage(body)
        expect(found.order).toEqual(['learn/x/a', 'learn/x/b', 'learn/x/c', 'learn/x/c-solution', 'learn/x/d'])
        expect([...found.starters]).toEqual(['learn/x/c'])
        expect([...found.solutions]).toEqual(['learn/x/c-solution'])
    })

    test('groups by section and page, hides solutions, keeps the page order', () => {
        const sources = {
            'learn/x/b': 'scchart Bee {}',
            'learn/x/a': '/* scchart Not */ scchart Ay {}',
            'learn/x/c': 'scchart Cee {}',
            'learn/x/c-solution': 'scchart CeeDone {}',
            'learn/y/z': 'scchart Zed {}',
            'start/w/q': 'scchart Q {}',
            'landing/toggle': 'scchart Toggle {}',
        }
        const docs = [
            { id: 'learn/x', title: 'Chapter X', order: 2, body: '<Sim example="learn/x/b" /><Sim example="learn/x/a" /><TryIt example="learn/x/c" solution="learn/x/c-solution" />' },
            { id: 'learn/y', title: 'Chapter Y', order: 1, body: '' },
            { id: 'start/w', title: 'Welcome', order: 1, body: '' },
        ]
        const groups = buildCatalogue(sources, docs, [{ id: 'showcase/abro', title: 'ABRO', file: 'abro', blurb: 'b' }], new Set(['learn/y/z']))
        expect(groups.map(g => g.label)).toEqual(['Showcase', 'Start here', 'Learn', 'Landing'])
        const learn = groups.find(g => g.id === 'learn')!
        expect(learn.pages.map(p => p.title)).toEqual(['Chapter Y', 'Chapter X'])
        expect(learn.pages[1].items.map(i => i.title)).toEqual(['Bee', 'Ay', 'Cee'])
        expect(learn.pages[1].items[2].starter).toBe(true)
        expect(learn.pages[0].items[0].rejected).toBe(true)
        expect(learn.pages[1].href).toBe('/learn/x/')
        expect(allItems(groups).some(i => i.id === 'learn/x/c-solution')).toBe(false)
        expect(firstChartName('// scchart X\nscchart ^Real {}')).toBe('Real')
    })
})

describe('showcase charts', () => {
    const dir = path.resolve('src/components/playground/showcase')
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sctx'))) {
        test(`${file}: the engine accepts it, as KIELER does (oracle recording)`, () => {
            const src = fs.readFileSync(path.join(dir, file), 'utf8')
            const r = compile(src)
            // 'unsupported': a feature the guide's simulator does not implement yet (count delays, at the time of
            // writing); KIELER runs the chart, as its recording shows.
            expect(r.diagnostics.filter(d => d.severity !== 'info' && d.code !== 'unsupported')).toEqual([])
            const oracle = JSON.parse(fs.readFileSync(path.join(dir, file.replace(/\.sctx$/, '.oracle.json')), 'utf8'))
            expect(oracle.ok).toBe(true)
            expect(oracle.errors).toEqual([])
            // Short enough to read in the editor without scrolling sideways (comments).
            for (const line of src.split('\n').filter(l => l.trim().startsWith('*'))) expect(line.length).toBeLessThanOrEqual(44)
        })
    }
})

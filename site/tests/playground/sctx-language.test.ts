// The playground's SCTX tokenizer (highlighting) and its CodeMirror language (indentation, folding, comments).
import { describe, expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldable, getIndentation, indentUnit } from '@codemirror/language'
import { tokenizeLines, type TokenType } from '../../src/components/playground/sctx-tokens'
import { highlightLines } from '../../src/components/playground/static-highlight'
import { sctx, openBraces } from '../../src/components/playground/sctx-language'
import { lex } from '../../src/engine/parser/lexer'

/** Non-blank tokens of a source as [type, text] pairs. */
const toks = (src: string): [TokenType | null, string][] =>
    tokenizeLines(src)
        .flat()
        .filter(t => t.text.trim())
        .map(t => [t.type, t.text.trim()])

const typeOf = (src: string, text: string) => toks(src).find(([, s]) => s === text)?.[0]

describe('tokenizer', () => {
    test('keywords, names, numbers, booleans', () => {
        expect(toks('initial state A\n  if x > 1.5 go to B')).toEqual([
            ['keyword', 'initial'], [null, ''], ['keyword', 'state'], [null, ''], ['identifier', 'A'],
            ['keyword', 'if'], ['identifier', 'x'], ['operator', '>'], ['number', '1.5'], ['keyword', 'go'], ['keyword', 'to'], ['identifier', 'B'],
        ].filter(([, s]) => s) as [TokenType, string][])
        expect(typeOf('output bool light = false', 'false')).toBe('bool')
        expect(typeOf('int x = 42', '42')).toBe('number')
        expect(typeOf('float y = 2f', '2f')).toBe('number')
        expect(typeOf('float y = 1.5e3', '1.5e3')).toBe('number')
    })

    test('the keyword set is the engine lexer\'s (scope, label and json cannot be names)', () => {
        for (const kw of ['scope', 'label', 'json', 'expression', 'module', 'pure', 'clock', 'max']) {
            expect(typeOf(`int ${kw}`, kw)).toBe('keyword')
            expect(lex(kw).tokens[0].kind).toBe(kw)
        }
        expect(typeOf('int states', 'states')).toBe('identifier')
        expect(typeOf('int ^state', '^state')).toBe('identifier')
    })

    test('multi-word keywords', () => {
        expect(typeOf('go to A deep deferred', 'deep deferred')).toBe('keyword')
        expect(typeOf('go to A shallow history', 'shallow history')).toBe('keyword')
        expect(typeOf('clock-time c', 'clock-time')).toBe('keyword')
        expect(typeOf('_', '_')).toBe('keyword')
        expect(typeOf('int _x', '_x')).toBe('identifier')
    })

    test('strings and host code may span lines', () => {
        const lines = tokenizeLines('label "one\ntwo" state\n`a\nb` x')
        expect(lines[0].at(-1)).toEqual({ type: 'string', text: '"one' })
        expect(lines[1][0]).toEqual({ type: 'string', text: 'two"' })
        expect(lines[1].at(-1)).toEqual({ type: 'keyword', text: 'state' })
        expect(lines[2].at(-1)).toEqual({ type: 'hostcode', text: '`a' })
        expect(lines[3][0]).toEqual({ type: 'hostcode', text: 'b`' })
        expect(typeOf('print("a \\" b")', '"a \\" b"')).toBe('string')
    })

    test('comments, doc comments and KIELER\'s comment quirks', () => {
        expect(typeOf('state A // note', '// note')).toBe('comment')
        expect(typeOf('/** doc */ state A', '/** doc */')).toBe('doc')
        expect(typeOf('//* comment annotation', '//* comment annotation')).toBe('doc')
        // A block comment continues over lines.
        const block = tokenizeLines('/* a\nb */ state')
        expect(block[1][0]).toEqual({ type: 'comment', text: 'b */' })
        expect(block[1].at(-1)).toEqual({ type: 'keyword', text: 'state' })
        // `/**/` opens a doc comment that runs to the next `*/` (KIELER's COMMENT_ANNOTATION).
        const open = tokenizeLines('/**/ state A\nstate B */ state')
        expect(open[0]).toEqual([{ type: 'doc', text: '/**/ state A' }])
        expect(open[1].at(-1)).toEqual({ type: 'keyword', text: 'state' })
        // An empty // at the end of a line comments out the next line too, as in KIELER.
        const swallowed = tokenizeLines('state A //\nstate B\nstate C')
        expect(swallowed[1]).toEqual([{ type: 'comment', text: 'state B' }])
        expect(swallowed[2][0]).toEqual({ type: 'keyword', text: 'state' })
        // ... but a blank line ends it.
        expect(tokenizeLines('//\n\nstate B')[2][0]).toEqual({ type: 'keyword', text: 'state' })
    })

    test('annotations, pragmas, invalid characters', () => {
        expect(typeOf('@layout[elk.direction] UP', '@layout')).toBe('annotation')
        expect(typeOf('#resource "x"', '#resource')).toBe('pragma')
        expect(typeOf('if A do x = “true”', '“')).toBe('invalid')
    })

    test('static highlighting escapes HTML and uses the editor classes', () => {
        expect(highlightLines('state A // <b>\n')).toEqual(['<span class="sc-tok-kw">state</span> A <span class="sc-tok-com">// &lt;b&gt;</span>'])
    })
})

describe('language', () => {
    const state = (doc: string) => EditorState.create({ doc, extensions: [sctx(), indentUnit.of('  ')] })
    /** Indentation CodeMirror computes for a new line inserted at the end of `before`. */
    const indentAfter = (before: string) => {
        const doc = before + '\n'
        return getIndentation(state(doc), doc.length)
    }

    test('indentation', () => {
        expect(indentAfter('scchart A {')).toBe(2)
        expect(indentAfter('scchart A {\n  initial state Off')).toBe(4)
        expect(indentAfter('scchart A {\n  initial state Off "waiting"')).toBe(4)
        expect(indentAfter('scchart A {\n  initial state Off\n    if a go to On')).toBe(4)
        expect(indentAfter('scchart A {\n  state S {\n    initial state B\n  }')).toBe(2)
        expect(indentAfter('scchart A {\n  input bool a')).toBe(2)
        // A closing brace goes back to its opener's indentation.
        const doc = 'scchart A {\n  state S {\n    initial state B\n    }'
        expect(getIndentation(state(doc), doc.lastIndexOf('    }'))).toBe(2)
        // Braces in comments and strings do not count.
        expect(openBraces(state('a { // {\n"{" /* { */').doc, 20)).toEqual([1])
    })

    test('folding braces', () => {
        const s = state('scchart A {\n  initial state B\n}\n')
        const line = s.doc.line(1)
        expect(foldable(s, line.from, line.to)).toEqual({ from: 11, to: s.doc.toString().lastIndexOf('}') })
        expect(foldable(s, s.doc.line(2).from, s.doc.line(2).to)).toBeNull()
    })

    test('comment tokens', () => {
        expect(state('').languageDataAt('commentTokens', 0)[0]).toEqual({ line: '//', block: { open: '/*', close: '*/' } })
    })
})

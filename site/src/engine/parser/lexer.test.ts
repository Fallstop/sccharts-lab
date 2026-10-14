import { describe, expect, it } from 'vitest'
import { lex } from './lexer'

const kinds = (text: string) => lex(text).tokens.filter(t => t.kind !== 'EOF').map(t => t.kind)
const texts = (text: string) => lex(text).tokens.filter(t => t.kind !== 'EOF').map(t => t.text)
const errors = (text: string) => lex(text).diagnostics.filter(d => d.severity === 'error')

describe('lexer: keywords and identifiers', () => {
    it('tells keywords from identifiers (longest match, keywords win ties)', () => {
        expect(kinds('state states initial initially go goto')).toEqual(['state', 'ID', 'initial', 'ID', 'go', 'goto'])
        expect(kinds('true false True')).toEqual(['BOOLEAN', 'BOOLEAN', 'ID'])
        expect(kinds('Pr Pr= Pressure')).toEqual(['Pr', 'Pr=', 'ID'])
    })

    it('reads keywords that contain a space, dot, hyphen or bracket as one token', () => {
        expect(kinds('deep deferred')).toEqual(['deep deferred'])
        expect(kinds('shallow history')).toEqual(['shallow history'])
        expect(kinds('clock-time clock')).toEqual(['clock-time', 'clock'])
        expect(kinds('super.x')).toEqual(['super.', 'ID'])
        expect(kinds('annotated( annotated (')).toEqual(['annotated(', 'ID', '('])
        expect(kinds('min= max= min max')).toEqual(['min=', 'max=', 'min', 'max'])
    })

    it("reproduces KIELER's commitment to 'deep deferred', 'shallow history' and 'clock-time'", () => {
        expect(errors('deep = 1')).toHaveLength(1)
        expect(errors('deep = 1')[0].message).toContain("'deep deferred'")
        expect(errors('deep= 1')).toEqual([])
        expect(errors('deep\n= 1')).toEqual([])
        expect(errors('shallow x')).toHaveLength(1)
        expect(errors('clock-x')).toHaveLength(1)
        expect(errors('clock - x')).toEqual([])
        expect(errors('deep  deferred')).toHaveLength(1)
    })

    it('follows the ID terminal: carets, underscores, primes are separate tokens', () => {
        expect(kinds('^state _a _1 __ _')).toEqual(['ID', 'ID', 'ID', 'ID', '_'])
        expect(texts("x'' y")).toEqual(['x', "'", "'", 'y'])
        expect(kinds('a ^b')).toEqual(['ID', 'ID'])
        expect(kinds('a ^ b')).toEqual(['ID', '^', 'ID'])
        expect(kinds('ü')).toEqual(['ANY_OTHER'])
    })
})

describe('lexer: numbers and strings', () => {
    it('reads INT and the FLOAT forms', () => {
        expect(kinds('1 007 1.5 1. 1.e5 2.5E-3 1f 1.5f 3.f')).toEqual(['INT', 'INT', 'FLOAT', 'FLOAT', 'FLOAT', 'FLOAT', 'FLOAT', 'FLOAT', 'FLOAT'])
        expect(kinds('1e5')).toEqual(['INT', 'ID'])
        expect(kinds('.5')).toEqual(['.', 'INT'])
        expect(kinds('0x10')).toEqual(['INT', 'ID'])
    })

    it('rejects an exponent without digits and integers above 2^31 - 1', () => {
        expect(errors('1.5e')).toHaveLength(1)
        expect(errors('1.ex')).toHaveLength(1)
        expect(errors('2147483647')).toEqual([])
        expect(errors('2147483648')[0].message).toContain('too large')
    })

    it('reads strings with the escapes KIELER allows, across lines', () => {
        expect(kinds('"a \\"b\\" \\\\ \\n \\t \\\' "')).toEqual(['STRING'])
        expect(kinds('"two\nlines"')).toEqual(['STRING'])
        expect(errors('"bad \\d"')[0].message).toContain('escape')
        expect(errors('"open')[0].message).toContain('never closed')
    })

    it('reads host code in backticks', () => {
        expect(kinds('`printf("x");` 1')).toEqual(['HOSTCODE', 'INT'])
        expect(errors('`open')).toHaveLength(1)
    })
})

describe('lexer: comments', () => {
    it('hides ordinary comments and keeps them in comments', () => {
        const r = lex('a // line\nb /* block */ c')
        expect(r.tokens.map(t => t.text)).toEqual(['a', 'b', 'c', ''])
        expect(r.comments.map(c => c.kind)).toEqual(['line', 'block'])
    })

    it('makes /** */ and //* real tokens', () => {
        expect(kinds('/** doc */ x //* note\ny')).toEqual(['COMMENT_ANNOTATION', 'ID', 'SL_COMMENT_ANNOTATION', 'ID'])
        expect(kinds('//***** banner')).toEqual(['SL_COMMENT_ANNOTATION'])
    })

    it("swallows the next line after an empty // comment, as KIELER's lexer does", () => {
        const r = lex('a //\nb\nc')
        expect(r.tokens.map(t => t.text)).toEqual(['a', 'c', ''])
        expect(r.diagnostics.map(d => d.code)).toEqual(['swallowed-line'])
        expect(r.diagnostics[0].severity).toBe('warning')
        // With CRLF line ends the next line survives.
        expect(lex('a //\r\nb').tokens.map(t => t.text)).toEqual(['a', 'b', ''])
    })

    it('treats /**/ as the start of a doc comment that runs to the next */', () => {
        expect(kinds('/**/ a */ b')).toEqual(['COMMENT_ANNOTATION', 'ID'])
        expect(errors('/**/ a')).toHaveLength(1)
    })

    it('rejects // at the very end of the file and unclosed block comments', () => {
        expect(errors('a //')).toHaveLength(1)
        expect(errors('/* open')).toHaveLength(1)
    })
})

describe('lexer: punctuation and spans', () => {
    it('takes the longest operator', () => {
        expect(kinds('>>>= >>> >>= >> >= > <<= << <= < == = != !& ! && & || | ++ += + -- -= -> -')).toEqual(
            ['>>>=', '>>>', '>>=', '>>', '>=', '>', '<<=', '<<', '<=', '<', '==', '=', '!=', '!&', '!', '&&', '&', '||', '|', '++', '+=', '+', '--', '-=', '->', '-'])
        expect(kinds('f() f( )')).toEqual(['ID', '()', 'ID', '(', ')'])
        expect(kinds('-->')).toEqual(['--', '>'])
    })

    it('treats non-ASCII whitespace as an unknown character', () => {
        expect(kinds('a b')).toEqual(['ID', 'ANY_OTHER', 'ID'])
        expect(kinds('a\fb')).toEqual(['ID', 'ANY_OTHER', 'ID'])
        expect(kinds('a\tb')).toEqual(['ID', 'ID'])
    })

    it('records offsets', () => {
        const t = lex('  state  S').tokens
        expect(t.map(x => [x.start, x.end])).toEqual([[2, 7], [9, 10], [10, 10]])
    })
})

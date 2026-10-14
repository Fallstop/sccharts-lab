// A line-by-line SCTX tokenizer for highlighting: the playground's CodeMirror mode (sctx-language.ts) and the
// static, build-time rendering of the playground's starter source (static-highlight.ts) both use it, so the page
// looks the same before and after the editor loads.
//
// It follows the terminals of the engine's lexer (src/engine/parser/lexer.ts, which reproduces KIELER's), including
// the quirks a reader should *see*: strings and host code may span lines, `/**` starts a doc comment even in
// `/**/`, and an empty `//` at the end of a line also comments out the next line (KIELER's SL_COMMENT consumes the
// line break as the "first character" of the comment). Keywords are the engine's keyword set, so `scope` or
// `label` show as keywords: they cannot name a variable.
//
// The interface is the subset of CodeMirror's StringStream the tokenizer needs, so it runs without CodeMirror.

import { KEYWORDS } from '../../engine/parser/lexer'

export type TokenType =
    | 'keyword'
    | 'string'
    | 'hostcode'
    | 'number'
    | 'bool'
    | 'comment'
    | 'doc'
    | 'annotation'
    | 'pragma'
    | 'operator'
    | 'bracket'
    | 'punctuation'
    | 'identifier'
    | 'invalid'

/** CSS classes of the token types, shared by the editor and the static rendering (playground.css colours them). */
export const TOKEN_CLASS: Record<TokenType, string> = {
    keyword: 'sc-tok-kw',
    string: 'sc-tok-str',
    hostcode: 'sc-tok-host',
    number: 'sc-tok-num',
    bool: 'sc-tok-num',
    comment: 'sc-tok-com',
    doc: 'sc-tok-com',
    annotation: 'sc-tok-ann',
    pragma: 'sc-tok-ann',
    operator: 'sc-tok-op',
    bracket: 'sc-tok-op',
    punctuation: 'sc-tok-op',
    identifier: 'sc-tok-id',
    invalid: 'sc-tok-bad',
}

export interface TokenizerState {
    /** Inside a block comment (`/* ... *\/` or a doc comment) that continues on the next line. */
    block: null | 'comment' | 'doc'
    /** Inside a string or host code that continues on the next line. */
    quote: null | '"' | '`'
    /** The previous line ended with an empty `//`: KIELER's lexer treats this whole line as part of that comment. */
    swallow: boolean
}

/** The part of CodeMirror's StringStream the tokenizer uses. */
export interface StreamLike {
    pos: number
    string: string
    sol(): boolean
    eol(): boolean
    peek(): string | undefined
    next(): string | void
    match(pattern: string | RegExp, consume?: boolean): boolean | RegExpMatchArray | null
    skipToEnd(): void
    eatSpace(): boolean
}

export function startState(): TokenizerState {
    return { block: null, quote: null, swallow: false }
}

export function copyState(s: TokenizerState): TokenizerState {
    return { block: s.block, quote: s.quote, swallow: s.swallow }
}

/** Word keywords of the SCTX grammar (`state`, `go`, `to`, ...), from the engine's lexer. */
export const WORD_KEYWORDS: ReadonlySet<string> = new Set([...KEYWORDS].filter(k => /^[A-Za-z]+$/.test(k)))

const ID = /^\^?(?:_?[A-Za-z]|_[0-9_])[A-Za-z0-9_]*/
const NUMBER = /^[0-9]+(?:\.[0-9]*(?:[eE][+-]?[0-9]*)?f?|f)?/
// Multi-character punctuation of the lexer, longest first, then single characters.
const OPERATOR = /^(?:>>>=|>>>|<<=|>>=|!&|&&|\|\||==|!=|<=|>=|<<|>>|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|->|[-+*/%<>=!~^&|?:])/

/** Finishes a quoted terminal that may continue on later lines; returns true when it closed on this line. */
function quoted(stream: StreamLike, quote: '"' | '`'): boolean {
    while (!stream.eol()) {
        const c = stream.next()
        if (c === '\\') {
            if (!stream.eol()) stream.next()
        } else if (c === quote) {
            return true
        }
    }
    return false
}

/** Finishes a block comment; returns true when it closed on this line. */
function blockComment(stream: StreamLike): boolean {
    while (!stream.eol()) {
        if (stream.match('*/')) return true
        stream.next()
    }
    return false
}

/** An empty line ends a comment that swallowed it. */
export function blankLine(state: TokenizerState): void {
    state.swallow = false
}

export function token(stream: StreamLike, state: TokenizerState): TokenType | null {
    if (stream.sol() && state.swallow) {
        state.swallow = false
        stream.skipToEnd()
        return 'comment'
    }
    if (state.block) {
        const kind = state.block
        if (blockComment(stream)) state.block = null
        return kind
    }
    if (state.quote) {
        const q = state.quote
        if (quoted(stream, q)) state.quote = null
        return q === '"' ? 'string' : 'hostcode'
    }
    if (stream.eatSpace()) return null

    const c = stream.peek()!
    if (c === '/') {
        if (stream.match('/**')) {
            // COMMENT_ANNOTATION: '/**' -> '*/', searched from after the third character (so `/**/` stays open).
            if (!blockComment(stream)) state.block = 'doc'
            return 'doc'
        }
        if (stream.match('/*')) {
            // ML_COMMENT: the character after `/*` is part of the comment whatever it is.
            if (!stream.eol()) stream.next()
            if (!blockComment(stream)) state.block = 'comment'
            return 'comment'
        }
        if (stream.match('//*')) {
            stream.skipToEnd()
            return 'doc'
        }
        if (stream.match('//')) {
            if (stream.eol()) state.swallow = true
            stream.skipToEnd()
            return 'comment'
        }
    }
    if (c === '"' || c === '`') {
        stream.next()
        if (!quoted(stream, c)) state.quote = c
        return c === '"' ? 'string' : 'hostcode'
    }
    if (c === '@') {
        stream.next()
        stream.match(/^[A-Za-z_][\w.]*/)
        return 'annotation'
    }
    if (c === '#') {
        stream.next()
        stream.match(/^[A-Za-z_]\w*/)
        return 'pragma'
    }
    if (/[0-9]/.test(c)) {
        stream.match(NUMBER)
        return 'number'
    }
    const id = stream.match(ID, false) as RegExpMatchArray | null
    if (id) {
        const word = id[0]
        // Keywords made of two words, or with a dot or hyphen (the lexer's longest match).
        if (word === 'deep' && stream.match('deep deferred')) return 'keyword'
        if (word === 'shallow' && stream.match('shallow history')) return 'keyword'
        if (word === 'clock' && stream.match('clock-time')) return 'keyword'
        if (word === 'super' && stream.match('super.')) return 'keyword'
        stream.match(ID)
        if (word === 'true' || word === 'false') return 'bool'
        if (WORD_KEYWORDS.has(word)) return 'keyword'
        return 'identifier'
    }
    if (c === '_') {
        // `_` alone is the "ignore" keyword (vector patterns); `_x`, `_1` and `__` are names (caught above).
        stream.next()
        return 'keyword'
    }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']') {
        stream.next()
        return 'bracket'
    }
    if (stream.match(OPERATOR)) return 'operator'
    if (c === ',' || c === ';' || c === '.' || c === "'") {
        stream.next()
        return 'punctuation'
    }
    stream.next()
    return 'invalid'
}

/** A minimal StringStream over one line, for tokenizing without CodeMirror. */
export class LineStream implements StreamLike {
    pos = 0
    start = 0
    constructor(readonly string: string) {}
    sol() {
        return this.pos === 0
    }
    eol() {
        return this.pos >= this.string.length
    }
    peek() {
        return this.string.charAt(this.pos) || undefined
    }
    next() {
        if (this.pos < this.string.length) return this.string.charAt(this.pos++)
    }
    match(pattern: string | RegExp, consume = true) {
        if (typeof pattern === 'string') {
            if (this.string.startsWith(pattern, this.pos)) {
                if (consume) this.pos += pattern.length
                return true
            }
            return null
        }
        const m = this.string.slice(this.pos).match(pattern)
        if (m && m.index === 0) {
            if (consume) this.pos += m[0].length
            return m
        }
        return null
    }
    skipToEnd() {
        this.pos = this.string.length
    }
    eatSpace() {
        const start = this.pos
        while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos++
        return this.pos > start
    }
}

export interface Token {
    type: TokenType | null
    text: string
}

/** Tokenizes a whole source, line by line (each line ends after its last token; line breaks are not tokens). */
export function tokenizeLines(source: string): Token[][] {
    const state = startState()
    return source.split(/\r?\n/).map(line => {
        if (line === '') {
            blankLine(state)
            return []
        }
        const stream = new LineStream(line)
        const tokens: Token[] = []
        while (!stream.eol()) {
            const start = stream.pos
            const type = token(stream, state)
            if (stream.pos === start) stream.next() // never loop
            const text = line.slice(start, stream.pos)
            const last = tokens[tokens.length - 1]
            if (last && last.type === type) last.text += text
            else tokens.push({ type, text })
        }
        return tokens
    })
}

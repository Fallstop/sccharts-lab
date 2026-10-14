// The SCTX lexer. It reproduces the terminals of KIELER's Xtext grammars (Annotations.xtext, KExpressions.xtext,
// Terminals) and the keyword set of the generated InternalSCTX lexer, with ANTLR's longest-match rule: the longest
// token wins, and on a tie a keyword beats a terminal (so `state` is a keyword and `states` an ID).
//
// Hidden tokens: whitespace (space, tab, CR, LF only), `/* ... */` and `// ...` comments. Doc comments `/** ... */`
// and `//* ...` comment annotations are real tokens: the grammar only allows them in certain places.

import type { Diagnostic } from '../types'
import { LineMap } from './source'

export type TokenKind =
    | 'ID' | 'INT' | 'FLOAT' | 'BOOLEAN' | 'STRING' | 'HOSTCODE'
    | 'COMMENT_ANNOTATION' | 'SL_COMMENT_ANNOTATION'
    | 'ANY_OTHER' | 'EOF'
    | string // keywords and punctuation: the literal text, e.g. 'state', '{', 'deep deferred'

export interface Token {
    kind: TokenKind
    start: number
    end: number
    text: string
}

export interface Comment {
    kind: 'line' | 'block'
    start: number
    end: number
    text: string
}

/** Every keyword and punctuation token of the generated SCTX lexer (InternalSCTX.tokens). */
export const KEYWORDS: ReadonlySet<string> = new Set([
    '!&', '!', '!=', '#', '%', '%=', '&&', '&', '&=', '(', '()', ')', '*', '*=', '+', '++', '+=', ',', '-', '--', '-=', '->',
    '.', '/', '/=', ':', ';', '<', '<<', '<<=', '<=', '=', '==', '>', '>=', '>>', '>>=', '>>>', '>>>=', '?', '@', 'Pr', 'Pr=',
    '[', "'", ']', '^', '^=', '_', 'abort', 'annotated(', 'auto', 'bool', 'calls', 'class', 'clock', 'clock-time', 'combine',
    'commuting', 'conflicting', 'connector', 'const', 'dataflow', 'deep deferred', 'deferred', 'delayed', 'do', 'during',
    'else', 'entry', 'enum', 'exit', 'expression', 'extends', 'extern', 'fby', 'final', 'float', 'for', 'global', 'go',
    'goto', 'history', 'host', 'if', 'immediate', 'import', 'initial', 'input', 'int', 'is', 'join', 'json', 'label', 'max',
    'max=', 'method', 'min', 'min=', 'module', 'nondeterministic', 'none', 'null', 'ode', 'once', 'output', 'override',
    'period', 'policy', 'pre', 'primitive', 'print', 'private', 'protected', 'public', 'pure', 'random', 'randomize', 'ref',
    'region', 'reset', 'return', 'scchart', 'schedule', 'scope', 'seq', 'sfby', 'shallow history', 'signal', 'state',
    'static', 'string', 'strong', 'struct', 'super.', 'suspend', 'this', 'to', 'undefined', 'val', 'violation', 'void',
    'weak', 'while', '{', '|', '|=', '||', '}', '~',
])

/** Keywords made of letters (and the few with a space, dot, hyphen or bracket), for matching at an identifier. */
const WORD_KEYWORDS = [...KEYWORDS].filter(k => /^[A-Za-z]/.test(k))
/** Multi-character keywords that extend past an identifier: `clock-time`, `deep deferred`, `super.`, `Pr=` ... */
const LONG_WORD_KEYWORDS = WORD_KEYWORDS.filter(k => !/^[A-Za-z]+$/.test(k)).sort((a, b) => b.length - a.length)
const PUNCTUATION = [...KEYWORDS].filter(k => !/^[A-Za-z]/.test(k)).sort((a, b) => b.length - a.length)
const PUNCTUATION_BY_CHAR = new Map<string, string[]>()
for (const p of PUNCTUATION) {
    const list = PUNCTUATION_BY_CHAR.get(p[0]) ?? []
    list.push(p)
    PUNCTUATION_BY_CHAR.set(p[0], list)
}

const isDigit = (c: number) => c >= 48 && c <= 57
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isIdPart = (c: number) => isLetter(c) || isDigit(c) || c === 95
const ESCAPABLE = new Set(['b', 't', 'n', 'f', 'r', '"', "'", '\\'])

export interface LexResult {
    tokens: Token[]
    comments: Comment[]
    diagnostics: Diagnostic[]
}

export function lex(text: string, lines: LineMap = new LineMap(text)): LexResult {
    const tokens: Token[] = []
    const comments: Comment[] = []
    const diagnostics: Diagnostic[] = []
    const n = text.length
    let i = 0

    const error = (start: number, end: number, message: string, hint?: string, kieler?: string) => {
        const d: Diagnostic = { severity: 'error', message, hint, code: 'parse', span: lines.span(start, Math.max(end, start)) }
        if (kieler) d.kieler = kieler
        diagnostics.push(d)
    }
    const push = (kind: TokenKind, start: number, end: number) => tokens.push({ kind, start, end, text: text.slice(start, end) })

    /** ID per Annotations.xtext: '^'? (('_'? 'a'..'z'|'_'? 'A'..'Z') | '_' '0'..'9' | '__') ('a'..'z'|'A'..'Z'|'_'|'0'..'9')* */
    const idLength = (at: number): number => {
        let j = at
        if (text.charCodeAt(j) === 94 /* ^ */) j++
        const c = text.charCodeAt(j)
        if (isLetter(c)) j++
        else if (c === 95 /* _ */) {
            const d = text.charCodeAt(j + 1)
            if (isLetter(d) || isDigit(d) || d === 95) j += 2
            else return 0
        } else return 0
        while (j < n && isIdPart(text.charCodeAt(j))) j++
        return j - at
    }

    /** A quoted terminal (STRING with '"', HOSTCODE with '`'): escapes \b \t \n \f \r \" \' \\ only. */
    const quoted = (quote: number, kind: 'STRING' | 'HOSTCODE') => {
        const start = i
        let j = i + 1
        let ok = true
        while (j < n) {
            const c = text.charCodeAt(j)
            if (c === quote) {
                j++
                push(kind, start, j)
                i = j
                return
            }
            if (c === 92 /* \ */) {
                const next = text[j + 1]
                if (next === undefined) break
                if (!ESCAPABLE.has(next)) {
                    if (ok) error(j, j + 2, `'\\${next}' is not an escape sequence SCTX knows`, kind === 'STRING'
                        ? 'Inside a string, a backslash can only start \\n, \\t, \\r, \\b, \\f, \\", \\\' or \\\\. Write \\\\ for a backslash.'
                        : 'Inside host code, a backslash can only start \\n, \\t, \\r, \\b, \\f, \\", \\\' or \\\\.')
                    ok = false
                }
                j += 2
                continue
            }
            j++
        }
        const what = kind === 'STRING' ? 'string' : 'host code'
        error(start, Math.min(n, start + 1), `This ${what} is never closed`, kind === 'STRING'
            ? 'Add the closing `"` (strings can span several lines, so everything after the opening quote became part of the string).'
            : 'Add the closing backtick.', kind === 'STRING' ? `mismatched character '<EOF>' expecting '"'` : undefined)
        push(kind, start, n)
        i = n
    }

    while (i < n) {
        const c = text.charCodeAt(i)
        // WS: ' ' | '\t' | '\r' | '\n'
        if (c === 32 || c === 9 || c === 13 || c === 10) { i++; continue }
        const start = i

        if (c === 47 /* / */) {
            const c1 = text.charCodeAt(i + 1)
            if (c1 === 42 /* * */) {
                if (text.charCodeAt(i + 2) === 42) {
                    // COMMENT_ANNOTATION: '/**' -> '*/'
                    const close = text.indexOf('*/', i + 3)
                    if (close < 0) {
                        error(start, start + 3, 'This /** comment is never closed', 'Add `*/` to end the comment.')
                        push('COMMENT_ANNOTATION', start, n)
                        i = n
                    } else {
                        push('COMMENT_ANNOTATION', start, close + 2)
                        i = close + 2
                    }
                    continue
                }
                // ML_COMMENT: '/*' !'*' -> '*/'
                if (i + 2 >= n) {
                    error(start, n, 'This /* comment is never closed', 'Add `*/` to end the comment.', "mismatched character '<EOF>' expecting '*'")
                    i = n
                    continue
                }
                const close = text.indexOf('*/', i + 3)
                if (close < 0) {
                    error(start, start + 2, 'This /* comment is never closed', 'Add `*/` to end the comment.')
                    comments.push({ kind: 'block', start, end: n, text: text.slice(start) })
                    i = n
                } else {
                    comments.push({ kind: 'block', start, end: close + 2, text: text.slice(start, close + 2) })
                    i = close + 2
                }
                continue
            }
            if (c1 === 47 /* / */) {
                if (text.charCodeAt(i + 2) === 42) {
                    // SL_COMMENT_ANNOTATION: '//*' !('\n'|'\r')* ('\r'? '\n')?
                    let j = i + 3
                    while (j < n && text[j] !== '\n' && text[j] !== '\r') j++
                    if (text[j] === '\r' && text[j + 1] === '\n') j += 2
                    else if (text[j] === '\n') j++
                    push('SL_COMMENT_ANNOTATION', start, j)
                    i = j
                    continue
                }
                // SL_COMMENT: '//' !'*' !('\n'|'\r')* ('\r'? '\n')? -- the first character after // is consumed whatever
                // it is (even a line break), exactly as KIELER's lexer does.
                if (i + 2 >= n) {
                    error(start, n, 'A // comment cannot be the very last thing in the file', 'Add a line break after the comment, or remove the //.')
                    i = n
                    continue
                }
                let j = i + 3
                while (j < n && text[j] !== '\n' && text[j] !== '\r') j++
                if (text[j] === '\r' && text[j + 1] === '\n') j += 2
                else if (text[j] === '\n') j++
                if (text[i + 2] === '\n' && text.slice(i + 3, j).trim()) {
                    const lineStart = i + 3
                    const lineEnd = text.slice(lineStart, j).replace(/\r?\n$/, '').length + lineStart
                    diagnostics.push({
                        severity: 'warning', code: 'swallowed-line', span: lines.span(lineStart, lineEnd),
                        message: 'KIELER treats this line as part of the empty // comment on the line above',
                        hint: 'An empty // comment at the end of a line also comments out the whole next line in KIELER. Write something after the //, or delete it.',
                    })
                }
                comments.push({ kind: 'line', start, end: j, text: text.slice(start, j).replace(/\r?\n$/, '') })
                i = j
                continue
            }
        }

        if (c === 34 /* " */) { quoted(34, 'STRING'); continue }
        if (c === 96 /* ` */) { quoted(96, 'HOSTCODE'); continue }

        if (isDigit(c)) {
            let j = i
            while (j < n && isDigit(text.charCodeAt(j))) j++
            let kind: TokenKind = 'INT'
            if (text.charCodeAt(j) === 46 /* . */) {
                kind = 'FLOAT'
                j++
                while (j < n && isDigit(text.charCodeAt(j))) j++
                const e = text.charCodeAt(j)
                if (e === 101 || e === 69 /* e E */) {
                    // KIELER's lexer commits to an exponent as soon as it sees the 'e': `1.e5` is a number, `1.ex`
                    // is a lexical error (not `1.` followed by `ex`).
                    let k = j + 1
                    const s = text.charCodeAt(k)
                    if (s === 43 || s === 45 /* + - */) k++
                    if (isDigit(text.charCodeAt(k))) {
                        while (k < n && isDigit(text.charCodeAt(k))) k++
                    } else {
                        error(start, k, `The number ${text.slice(start, k)} has an exponent without digits`,
                            'After the `e` of a floating-point number, SCTX expects the exponent digits, as in `1.5e3`. Put a space or an operator after the number if the `e` belongs to a name.')
                    }
                    j = k
                }
                if (text.charCodeAt(j) === 102 /* f */) j++
            } else if (text.charCodeAt(j) === 102 /* f */) {
                kind = 'FLOAT'
                j++
            }
            push(kind, start, j)
            if (kind === 'INT' && (j - start > 10 || Number(text.slice(start, j)) > 2147483647)) {
                // KIELER converts INT with Java's Integer.valueOf.
                error(start, j, `The number ${text.slice(start, j)} is too large`, 'SCTX integers are 32-bit: the largest is 2147483647. Use a float (with a decimal point) for larger values.', `For input string: "${text.slice(start, j)}"`)
            }
            i = j
            continue
        }

        const idLen = idLength(i)
        if (idLen > 0) {
            // Longest match: a keyword with a space, dot, hyphen or bracket (`deep deferred`, `super.`, `clock-time`,
            // `Pr=`, `annotated(`) can be longer than the identifier at the same place.
            let best = idLen
            let kind: TokenKind = 'ID'
            for (const k of LONG_WORD_KEYWORDS) {
                if (k.length > best && text.startsWith(k, i)) { best = k.length; kind = k; break }
            }
            if (kind === 'ID') {
                // KIELER's lexer commits to `deep deferred`, `shallow history` and `clock-time` as soon as it has read
                // `deep `, `shallow ` or `clock-`, so a variable called deep or shallow followed by a space is a
                // lexical error there. Reproduce the rejection (and explain it), then carry on with the plain name.
                const word = text.slice(i, i + idLen)
                const committed = word === 'deep' || word === 'shallow' ? ' ' : word === 'clock' ? '-' : undefined
                if (committed && text[i + idLen] === committed) {
                    const keyword = word === 'deep' ? 'deep deferred' : word === 'shallow' ? 'shallow history' : 'clock-time'
                    error(start, i + idLen + 1, `KIELER reads '${word}${committed}' as the start of the keyword '${keyword}'`,
                        word === 'clock'
                            ? `Write clock-time without spaces for the type, or put spaces around the minus ("clock - x"). clock is a keyword, so it cannot name a variable.`
                            : `A name '${word}' followed by a space confuses KIELER's lexer. Rename it, or write the next symbol without a space (${word}= 1).`)
                }
            }
            if (kind === 'ID') {
                const word = text.slice(i, i + idLen)
                if (word === 'true' || word === 'false') kind = 'BOOLEAN'
                else if (KEYWORDS.has(word)) kind = word
            }
            push(kind, start, i + best)
            i += best
            continue
        }

        const candidates = PUNCTUATION_BY_CHAR.get(text[i])
        if (candidates) {
            const p = candidates.find(k => text.startsWith(k, i))
            if (p) {
                push(p, start, i + p.length)
                i += p.length
                continue
            }
        }

        // RULE_ANY_OTHER: any other character is a token of its own that no grammar rule accepts.
        const cp = text.codePointAt(i)!
        const len = cp > 0xffff ? 2 : 1
        push('ANY_OTHER', start, i + len)
        i += len
    }
    tokens.push({ kind: 'EOF', start: n, end: n, text: '' })
    return { tokens, comments, diagnostics }
}

/** Human-readable name of a token for messages: `'state'`, `the name 'foo'`, `the end of the file`. */
export function describeToken(t: Token): string {
    switch (t.kind) {
        case 'EOF': return 'the end of the file'
        case 'ID': return `the name '${t.text}'`
        case 'INT': case 'FLOAT': return `the number ${t.text}`
        case 'BOOLEAN': return `'${t.text}'`
        case 'STRING': return `the string ${t.text.length > 30 ? t.text.slice(0, 27) + '..."' : t.text}`
        case 'HOSTCODE': return 'host code `...`'
        case 'COMMENT_ANNOTATION': return 'a /** comment */'
        case 'SL_COMMENT_ANNOTATION': return 'a //* comment'
        case 'ANY_OTHER': return describeChar(t.text)
        default: return `'${t.kind}'`
    }
}

function describeChar(ch: string): string {
    const cp = ch.codePointAt(0)!
    const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
    if (cp === 0xa0) return `a non-breaking space (${hex})`
    if (cp === 0x0c) return `a form feed (${hex})`
    if (cp === 0x0b) return `a vertical tab (${hex})`
    if (cp === 0xfeff) return `an invisible byte order mark (${hex})`
    if (cp >= 0x2000 && cp <= 0x200b) return `an unusual space character (${hex})`
    if (cp === 0x2018 || cp === 0x2019) return `a curly quote ${ch} (${hex})`
    if (cp === 0x201c || cp === 0x201d) return `a curly double quote ${ch} (${hex})`
    if (cp < 32) return `the control character ${hex}`
    return `'${ch}'`
}

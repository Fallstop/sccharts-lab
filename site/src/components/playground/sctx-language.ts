// SCTX for CodeMirror 6: the stream tokenizer of sctx-tokens.ts, highlight classes that follow the guide's code
// theme (src/highlight/code-themes.mjs; the colours are CSS custom properties in playground.css, so both site
// themes work), indentation that knows SCTX's layout (braces, and transitions indented under their state),
// brace folding, comment toggling and bracket closing.

import { HighlightStyle, LanguageSupport, StreamLanguage, foldService, indentService, matchBrackets, syntaxHighlighting, type IndentContext } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { TOKEN_CLASS, blankLine, copyState, startState, token, LineStream, type TokenType, type TokenizerState } from './sctx-tokens'

export { TOKEN_CLASS }

/** CodeMirror token names (tag names of @lezer/highlight) for the tokenizer's token types. */
const TAG_NAME: Record<TokenType, string> = {
    keyword: 'keyword',
    string: 'string',
    hostcode: 'string.special',
    number: 'number',
    bool: 'bool',
    comment: 'comment',
    doc: 'docComment',
    annotation: 'annotation',
    pragma: 'processingInstruction',
    operator: 'operator',
    bracket: 'bracket',
    punctuation: 'punctuation',
    identifier: 'variableName',
    invalid: 'invalid',
}

export const sctxLanguage = StreamLanguage.define<TokenizerState>({
    name: 'sctx',
    startState,
    copyState,
    blankLine,
    token(stream, state) {
        const type = token(stream, state)
        return type ? TAG_NAME[type] : null
    },
    languageData: {
        commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
        closeBrackets: { brackets: ['(', '[', '{', '"', '`'] },
        indentOnInput: /^\s*\}$/,
    },
})

export const sctxHighlightStyle = HighlightStyle.define([
    { tag: t.keyword, class: TOKEN_CLASS.keyword },
    { tag: t.string, class: TOKEN_CLASS.string },
    { tag: t.special(t.string), class: TOKEN_CLASS.hostcode },
    { tag: [t.number, t.bool], class: TOKEN_CLASS.number },
    { tag: [t.comment, t.docComment], class: TOKEN_CLASS.comment },
    { tag: [t.annotation, t.processingInstruction], class: TOKEN_CLASS.annotation },
    { tag: [t.operator, t.bracket, t.punctuation], class: TOKEN_CLASS.operator },
    { tag: t.invalid, class: TOKEN_CLASS.invalid },
])

// ----- Indentation -----------------------------------------------------------------------------------------------

/** A line that is only a state header (`initial state A "label"`), whose transitions and actions follow indented. */
const STATE_HEADER = /^\s*(?:@[\w.]+(?:\[[^\]]*\])?(?:\s+\S+)?\s+)*(?:(?:initial|final|connector|violation)\s+)*state\s+\^?[A-Za-z_]\w*(?:\s+"[^"]*")?\s*$/

/** Open braces before `pos` (outside comments and strings), innermost last, each as the line number it is on. */
export function openBraces(doc: Text, pos: number): number[] {
    const stack: number[] = []
    const state = startState()
    const last = doc.lineAt(pos).number
    for (let n = 1; n <= last; n++) {
        const line = doc.line(n)
        const text = n === last ? line.text.slice(0, pos - line.from) : line.text
        if (text === '') {
            blankLine(state)
            continue
        }
        const stream = new LineStream(text)
        while (!stream.eol()) {
            const start = stream.pos
            const type = token(stream, state)
            if (stream.pos === start) stream.next()
            if (type === 'bracket') {
                const c = text[start]
                if (c === '{') stack.push(n)
                else if (c === '}') stack.pop()
            }
        }
    }
    return stack
}

function stripLineComment(text: string): string {
    // Good enough for the indentation heuristics: a // outside a string.
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '"') inString = !inString
        else if (c === '\\' && inString) i++
        else if (!inString && c === '/' && text[i + 1] === '/') return text.slice(0, i)
    }
    return text
}

const indentOf = (text: string, tabSize: number) => {
    let col = 0
    for (const c of text) {
        if (c === ' ') col++
        else if (c === '\t') col += tabSize - (col % tabSize)
        else break
    }
    return col
}

/** The indentation (in columns) for the line starting at `pos`. */
export function sctxIndentation(cx: IndentContext, pos: number): number | null {
    const doc = cx.state.doc
    const line = doc.lineAt(pos)
    const textAfter = cx.textAfterPos(pos)
    const tabSize = cx.state.tabSize
    const braces = openBraces(doc, pos)
    if (/^\s*\}/.test(textAfter)) {
        const opener = braces.at(-1)
        return opener ? indentOf(doc.line(opener).text, tabSize) : 0
    }
    // The previous non-blank line.
    let prev = line.number - 1
    while (prev >= 1 && !doc.line(prev).text.trim()) prev--
    if (prev < 1) return 0
    const prevText = doc.line(prev).text
    const prevIndent = indentOf(prevText, tabSize)
    const opener = braces.at(-1)
    if (opener === prev) return prevIndent + cx.unit
    if (STATE_HEADER.test(stripLineComment(prevText))) return prevIndent + cx.unit
    // Never less than one level inside the innermost open brace.
    const floor = opener ? indentOf(doc.line(opener).text, tabSize) + cx.unit : 0
    return Math.max(prevIndent, floor)
}

// ----- Folding ---------------------------------------------------------------------------------------------------

/** Folds a `{ ... }` block that opens on the line and closes on a later one. */
function foldBraces(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
    const text = state.doc.sliceString(lineStart, lineEnd)
    for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
        const match = matchBrackets(state, lineStart + i, 1)
        if (!match || !match.matched || !match.end) continue
        if (match.end.from <= lineEnd) continue
        return { from: lineStart + i + 1, to: match.end.from }
    }
    return null
}

export function sctx(): LanguageSupport {
    return new LanguageSupport(sctxLanguage, [
        syntaxHighlighting(sctxHighlightStyle),
        indentService.of(sctxIndentation),
        foldService.of(foldBraces),
    ])
}

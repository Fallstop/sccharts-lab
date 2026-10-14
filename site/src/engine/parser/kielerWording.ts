// KIELER's own words for a syntax error in one expression or effect (parseExpression, index.ts): what KIELER's
// parser says when the text is written as a trigger (`if <text> go to S`) or as an effect (`do <text> go to S`).
//
// KIELER's parser is ANTLR 3 with backtracking: where a decision needs a syntactic predicate and every alternative
// fails, it reports "no viable alternative at input 'X'" at the token where the decision started, which is not
// always the token the guide's parser stops at. The rules below were fitted to KIELER on 920 broken expressions and
// effects and checked on another 600 (tests/engine/expression.test.ts, tools/oracle recordings in
// tests/engine/kieler/expressions/): each says something only for a shape where it agreed with KIELER every time,
// and nothing otherwise (the guide's message stands alone then).

import { lex, type Token } from './lexer'
import { parseStandalone } from './parser'

const BINARY = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '&', '|', '^', '<<', '>>', '>>>', '->', 'fby', 'sfby'])
const COMPARISON = new Set(['==', '!=', '<', '<=', '>', '>='])
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', 'min=', 'max='])
/** Tokens that can start a value: where the text starts with one, KIELER's error lies deeper. */
const OPERAND = new Set(['ID', 'INT', 'FLOAT', 'BOOLEAN', 'STRING', 'HOSTCODE', '(', '()', '!', '-', '~', 'pre', 'val', 'random', 'print', 'randomize', '{'])

/** Tokens the transition around the text continues with (`if A do ...`, `if A go to ...`). */
const CONTEXT = new Set(['do', 'go', 'abort', 'join', 'to', 'if', 'Pr=', 'nondeterministic'])

/** At most this many tokens are looked at (the prefix search parses every prefix). */
const LIMIT = 80

const noViable = (text: string, t: Token | undefined) => `no viable alternative at input '${t ? text.slice(t.start, t.end) : 'go'}'`

/** KIELER's message for the first syntax error of `text` read as `as`, when the shape is one whose message is known. */
export function kielerSyntaxWording(text: string, as: 'expression' | 'effect'): string | undefined {
    const toks = lex(text).tokens.filter(t => t.kind !== 'EOF')
    if (!toks.length || toks.length > LIMIT || toks.some(t => t.kind === 'ANY_OTHER')) return undefined
    // The longest prefix that is a whole expression (effect): where KIELER's reading ends.
    let p = 0
    for (let n = toks.length - 1; n >= 1; n--) {
        const r = parseStandalone(text.slice(0, toks[n - 1].end), as)
        if (!r.diagnostics.some(d => d.severity === 'error')) { p = n; break }
    }
    const next = toks[p]
    if (p === 0) {
        if (!next || OPERAND.has(next.kind)) return undefined
        return noViable(text, next)
    }
    // Words that go on the transition around the text: what KIELER says next depends on that transition.
    if (!next || CONTEXT.has(next.kind)) return undefined
    // `!a + b`: `!` takes one value, so KIELER stops at the operator, but only if what follows it reads.
    if ((toks[0].kind === '!' || toks[0].kind === '~') && BINARY.has(next.kind)) {
        const rest = parseStandalone(text.slice(next.end), 'expression')
        if (rest.diagnostics.some(d => d.severity === 'error')) return undefined
    }
    let depth = 0
    let binary = 0
    let comparisons = 0
    let assign: Token | undefined
    let ternary = 0
    for (const [i, t] of toks.slice(0, p).entries()) {
        if (t.kind === '(' || t.kind === '[') depth++
        else if (t.kind === ')' || t.kind === ']') depth--
        else if (depth > 0) continue
        else if (t.kind === '?' || t.kind === ':') {
            // Only a whole `c ? a : b` at the end of what was read (KIELER's three atoms).
            if (t.kind === ':' && i === p - 2 && toks[i - 2]?.kind === '?') ternary++
            else if (!(t.kind === '?' && i === p - 4 && toks[p - 2]?.kind === ':')) return undefined
        } else if (t.kind === ';' || t.kind === ',') return undefined
        else if (ASSIGN.has(t.kind)) assign ??= t
        else if (BINARY.has(t.kind)) { binary++; if (COMPARISON.has(t.kind)) comparisons++ }
    }
    if (depth !== 0 || next.kind === '[' || next.kind === ';') return undefined
    if (ternary) return binary === 0 && !assign === (as === 'expression') && (next.kind === '?' || next.kind === ':') ? noViable(text, next) : undefined
    // A comparison chain: `a < b < c` stops at the second comparison; a stray `)` after a whole expression.
    if (binary === 1 && comparisons === 1 && COMPARISON.has(next.kind)) return noViable(text, next)
    if (next.kind === ')') return noViable(text, next)
    if (as === 'expression') return binary === 0 ? noViable(text, next) : undefined
    if (binary > 0) return undefined
    // `x = 1 +`: the right-hand side goes on but breaks further on; KIELER names the assignment operator.
    if (assign && (BINARY.has(next.kind) || next.kind === '?')) return undefined
    return noViable(text, next)
}

// KIELER's own words for a syntax error in one expression or effect (parseExpression, index.ts): what KIELER's
// parser says when the text is written as a trigger (`if <text> go to S`) or as an effect (`do <text> go to S`).
//
// KIELER's parser is ANTLR 3 with backtracking: where a decision needs a syntactic predicate and every alternative
// fails, it reports "no viable alternative at input 'X'" at the token where the decision started, which is not
// always the token the guide's parser stops at. The first rules (afterPrefix) were fitted to KIELER on 920 broken
// expressions and effects and checked on another 600; the second (recovered) were fitted on the texts the first left
// open and checked on 1500 fresh ones (tests/engine/expression.test.ts, tools/oracle recordings in
// tests/engine/kieler/expressions/wording.json). Each says something only for a shape where it agreed with KIELER
// every time, and nothing otherwise (the guide's message stands alone then).

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

const ARITHMETIC = new Set(['+', '-', '*', '/', '%'])
const LOGICAL = new Set(['&', '|', '^', '&&', '||', '==', '!=', '<', '<=', '>', '>='])
const VALUE_END = new Set(['ID', 'INT', 'FLOAT', 'BOOLEAN', 'STRING', ')', ']'])
const LITERAL = new Set(['ID', 'INT', 'FLOAT', 'BOOLEAN'])

const reads = (text: string, as: 'expression' | 'effect') => !parseStandalone(text, as).diagnostics.some(d => d.severity === 'error')

/** KIELER's message for the first syntax error of `text` read as `as`, when the shape is one whose message is known. */
export function kielerSyntaxWording(text: string, as: 'expression' | 'effect'): string | undefined {
    const toks = lex(text).tokens.filter(t => t.kind !== 'EOF')
    if (!toks.length || toks.length > LIMIT || toks.some(t => t.kind === 'ANY_OTHER')) return undefined
    // The longest prefix that is a whole expression (effect): where KIELER's reading ends.
    let p = 0
    for (let n = toks.length - 1; n >= 1; n--) {
        if (reads(text.slice(0, toks[n - 1].end), as)) { p = n; break }
    }
    return afterPrefix(text, as, toks, p) ?? recovered(text, as, toks, p)
}

/** The first rules (fitted on 920 texts): what KIELER says about the token after the prefix that reads. */
function afterPrefix(text: string, as: 'expression' | 'effect', toks: Token[], p: number): string | undefined {
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

/**
 * The second rules (fitted on the texts the first leave open, checked on 1500 more): ANTLR's single-token recovery
 * at the start (`print x`, `pre - (a)`), one unclosed parenthesis, and the decision KIELER backtracks to for an
 * index, a stray value or a call after a whole expression.
 */
function recovered(text: string, as: 'expression' | 'effect', toks: Token[], p: number): string | undefined {
    const first = toks[0]
    const second = toks[1]
    // `print x` (an effect) and `pre - (a)` (an expression): a missing `(` is inserted before a value, an extra
    // token before `(` is skipped.
    if (((first.kind === 'print' && as === 'effect') || (first.kind === 'pre' && as === 'expression')) && second && second.kind !== '(' && second.kind !== '()') {
        if (toks[2]?.kind === '(') return `extraneous input '${text.slice(second.start, second.end)}' expecting '('`
        if (OPERAND.has(second.kind)) return `missing '(' at '${text.slice(second.start, second.end)}'`
        return undefined
    }
    // A prefix operator (or, in an expression, `(`) followed by something that cannot start a value.
    if ((first.kind === '(' || (as === 'expression' && (first.kind === '!' || first.kind === '~' || first.kind === '-'))) && second && !OPERAND.has(second.kind)) {
        return noViable(text, second)
    }
    // `(a + b` and `print(x`: one parenthesis left open where the text starts; KIELER finds `go` in its place.
    let depth = 0
    let outer = -1
    for (const [i, t] of toks.entries()) {
        if (t.kind === '(') { if (depth === 0) outer = i; depth++ } else if (t.kind === ')') depth--
        if (depth < 0) break
    }
    if (depth === 1 && (outer === 0 || (outer === 1 && first.kind === 'print')) && reads(text + ')', as)) return "missing ')' at 'go'"
    if (p === 0) return undefined

    const next = toks[p]
    const ops = operatorsBefore(toks, p)
    // `a[` after a lone value: KIELER names the bracket.
    if (as === 'expression' && next.kind === '[') return ops.length === 0 && !['-', '!', '~'].includes(first.kind) ? noViable(text, next) : undefined
    // A value right after a whole expression (`a b`, `x = 1 2`): KIELER names it, unless arithmetic or a
    // conditional came first (it may then backtrack to those).
    if (LITERAL.has(next.kind)) return ops.some(o => ARITHMETIC.has(o.kind) || o.kind === '?' || o.kind === ':') ? undefined : noViable(text, next)
    // A call after a whole expression (`b | f ( / x )`): after a comparison or a logical operator KIELER names the
    // `(`; after `?` the `?`; after arithmetic the first operator of that arithmetic.
    if (next.kind === '(') {
        const binary = ops.filter(o => !ASSIGN.has(o.kind))
        const last = binary.at(-1)
        if (!last) return undefined
        if (last.kind === '?') return noViable(text, last)
        // Inside a conditional KIELER may backtrack to its `?`.
        if (binary.some(o => o.kind === '?' || o.kind === ':')) return undefined
        if (LOGICAL.has(last.kind)) return noViable(text, next)
        if (ARITHMETIC.has(last.kind)) {
            let i = binary.length - 1
            while (i > 0 && ARITHMETIC.has(binary[i - 1].kind)) i--
            return noViable(text, binary[i])
        }
    }
    return undefined
}

/** The binary and assignment operators outside brackets in toks[0, p) (prefix `-`, `!` and `~` left out). */
function operatorsBefore(toks: Token[], p: number): Token[] {
    const out: Token[] = []
    let depth = 0
    for (let i = 0; i < p; i++) {
        const t = toks[i]
        if (t.kind === '(' || t.kind === '[') depth++
        else if (t.kind === ')' || t.kind === ']') depth--
        else if (depth === 0) {
            const prefix = ['-', '!', '~'].includes(t.kind) && !VALUE_END.has(toks[i - 1]?.kind ?? '')
            if (!prefix && (ASSIGN.has(t.kind) || ARITHMETIC.has(t.kind) || LOGICAL.has(t.kind) || ['?', ':', '<<', '>>', '>>>', '->', 'fby', 'sfby'].includes(t.kind))) out.push(t)
        }
    }
    return out
}

// "How KIELER reads it" (HowKielerReads.svelte): an expression, effect or trigger as KIELER's grammar groups it,
// fully parenthesised and as a tree, or the syntax error. Pure: the engine's parser does the reading
// (parseExpression, formatExpressionParenthesised; the chart parser for a trigger with a count delay).
import { compile, formatEffectParenthesised, formatExpressionParenthesised, parseExpression } from '~engine/index'
import type { Diagnostic, Effect, Expression, OperatorType } from '~engine/types'

/** 'auto': an expression (as in a trigger without count delay, or an initial value) or else an effect (after
 *  `do`); 'trigger': the text after `if`, where a leading number is a count delay. */
export type ReadMode = 'auto' | 'trigger'

/** A button of HowKielerReads: it loads `text` (read with `mode`). */
export interface Seed {
    /** The button's text, inline code allowed (`->`). */
    label: string
    text: string
    mode?: ReadMode
}

export interface TreeNode {
    /** What the node shows: an operator (`?:`, `&&`), or a whole atom (`a[i]`, `pre(x)`, `3`). */
    label: string
    /** The operator in words ("conditional", "and"), for operators; undefined for atoms. */
    name?: string
    children: TreeNode[]
}

export interface Problem {
    message: string
    hint?: string
    /** KIELER's own wording, when the engine knows it. */
    kieler?: string
    code?: string
    /** 1-based column in the text read, when known. */
    col?: number
}

export interface Reading {
    /** What the text was read as. */
    as: 'expression' | 'effect' | 'trigger'
    /** Fully parenthesised (KIELER's grouping), when it was read. */
    text?: string
    /** A trigger's count delay (`3 A`: 3). */
    delay?: number
    tree?: TreeNode
    /** A syntax error (the text was not read). */
    error?: Problem
    /** KIELER's warnings about what it read (a count delay in front of a minus sign). */
    warnings: Problem[]
}

const NAMES: Record<OperatorType, string> = {
    '||': 'or', '&&': 'and', '|': 'bitwise or', '^': 'bitwise exclusive or', '&': 'bitwise and',
    '==': 'equal to', '!=': 'not equal to', '<': 'less than', '<=': 'at most', '>': 'greater than', '>=': 'at least',
    '<<': 'shift left', '>>': 'shift right', '>>>': 'unsigned shift right',
    '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by', '%': 'remainder',
    '!': 'not', '~': 'bitwise not', neg: 'negative', '?:': 'conditional', pre: 'previous tick', val: 'value of',
    '->': 'first, then', fby: 'followed by', sfby: 'strictly followed by',
}

/** The expression as a tree: one node per operation (a run of the same operator is one node with all its
 *  operands, as in KIELER's model), atoms as leaves. */
export function expressionTree(e: Expression): TreeNode {
    if (e.kind === 'op' && e.op !== 'pre' && e.op !== 'val') {
        const label = e.op === 'neg' ? '-' : e.op
        return { label, name: NAMES[e.op], children: e.args.map(expressionTree) }
    }
    return { label: formatExpressionParenthesised(e), children: [] }
}

function effectTree(effect: Effect): TreeNode {
    switch (effect.kind) {
        case 'assign':
            return {
                label: effect.operator,
                name: effect.operator === '=' ? 'assignment' : `assignment (${effect.operator})`,
                children: [{ label: formatExpressionParenthesised(effect.target), children: [] }, expressionTree(effect.expression)],
            }
        case 'emit':
            return effect.value
                ? { label: formatExpressionParenthesised(effect.target), name: 'emit with a value', children: [expressionTree(effect.value)] }
                : { label: formatEffectParenthesised(effect), name: 'emit', children: [] }
        case 'print':
            return { label: 'print', name: 'print', children: effect.args.map(expressionTree) }
        default:
            return { label: formatEffectParenthesised(effect), children: [] }
    }
}

// The parser speaks of a file; here the text is one line.
const words = (s: string | undefined) => s?.replace(/the end of the file/g, 'the end of the text')
const problem = (d: Diagnostic, col?: number): Problem => ({ message: words(d.message)!, hint: words(d.hint), kieler: d.kieler, code: d.code, col: col ?? d.span?.col })

/** Reads one line of text as KIELER would. */
export function readExpression(input: string, mode: ReadMode = 'auto'): Reading {
    const text = input.replace(/\s+/g, ' ').trim()
    if (mode === 'trigger') return readTrigger(text)
    const r = parseExpression(text)
    const error = r.diagnostics.find((d) => d.severity === 'error')
    const warnings = r.diagnostics.filter((d) => d.severity === 'warning').map((d) => problem(d))
    if (error || (!r.expression && !r.effect)) return { as: r.as, error: error ? problem(error) : { message: 'This could not be read.' }, warnings }
    if (r.expression) return { as: 'expression', text: formatExpressionParenthesised(r.expression), tree: expressionTree(r.expression), warnings }
    return { as: 'effect', text: formatEffectParenthesised(r.effect!), tree: effectTree(r.effect!), warnings }
}

// A trigger is read inside a chart, by the chart parser (count delays are part of the transition, not of the
// expression). The text starts at this column of line 3.
const PREFIX = 'scchart T {\n  initial state A\n    if '
const COL = 8

function readTrigger(text: string): Reading {
    if (!text) return readExpression('', 'auto')
    const result = compile(`${PREFIX}${text} go to A\n}\n`)
    const syntax = result.diagnostics.filter((d) => d.code === 'parse' && d.severity === 'error')
    if (syntax.length) {
        const d = syntax[0]
        const col = d.span && d.span.line === 3 ? d.span.col - COL + 1 : undefined
        // An error at the words the chart around the text adds (`go to A`): the text ended too early. Say it about
        // the text alone.
        if (col === undefined || col > text.length) {
            const alone = parseExpression(text, { as: 'expression' })
            const e = alone.diagnostics.find((x) => x.severity === 'error')
            if (e) return { as: 'trigger', error: problem(e), warnings: [] }
        }
        return { as: 'trigger', error: problem(d, col), warnings: [] }
    }
    // Validation problems point into the chart around the text: columns of line 3 are moved to the text.
    const inText = (d: Diagnostic) => problem(d, d.span && d.span.line === 3 ? Math.max(1, d.span.col - COL + 1) : undefined)
    const t = result.program?.charts[0]?.regions[0]?.states[0]?.transitions[0]
    const zero = result.diagnostics.find((d) => d.code === 'count-delay-zero')
    if (zero || !t?.trigger) return { as: 'trigger', error: zero ? inText(zero) : { message: 'This is not a trigger.' }, warnings: [] }
    const warnings = result.diagnostics.filter((d) => d.code === 'count-delay-unary').map(inText)
    return { as: 'trigger', text: formatExpressionParenthesised(t.trigger), delay: t.triggerDelay, tree: expressionTree(t.trigger), warnings }
}

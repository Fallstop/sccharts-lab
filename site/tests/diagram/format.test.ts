// Unit tests of the pretty-printer (src/engine/format.ts) on hand-built ASTs, independent of the parser.
// The KIELER-recorded comparisons are in kieler-labels.test.ts.

import { describe, expect, it } from 'vitest'
import {
    actionSegments, createFormatContext, declarationLines, declarationSegments, displayName, formatAction,
    formatDeclaration, formatEffect, formatEffects, formatEquation, formatExpression, formatExpressionPlain,
    formatFloat, formatTransition, isImplicitlyImmediate, mergeComponents, regionLabelSegments, stateTitleSegments,
    transitionLabel, transitionLabelLines,
} from '../../src/engine/format'
import type {
    Declaration, Effect, Expression, LocalAction, OperatorType, Reference, Region, Span, State, Transition,
} from '../../src/engine/types'

const span: Span = { start: 0, end: 0, line: 1, col: 1, endLine: 1, endCol: 1 }
const ref = (name: string, ...indices: Expression[]): Reference => ({ kind: 'ref', name, indices, span })
const int = (value: number): Expression => ({ kind: 'int', value, span })
const float = (value: number): Expression => ({ kind: 'float', value, span })
const bool = (value: boolean): Expression => ({ kind: 'bool', value, span })
const str = (value: string): Expression => ({ kind: 'string', value, span })
const op = (o: OperatorType, ...args: Expression[]): Expression => ({ kind: 'op', op: o, args, span })
const [a, b, c, x, y, z] = ['a', 'b', 'c', 'x', 'y', 'z'].map(n => ref(n))

function transition(over: Partial<Transition> = {}): Transition {
    return {
        kind: 'transition', id: 'S->1', source: 'S', targetName: 'T', target: 'T', targetSpan: span, priority: 1,
        preemption: 'weak', effects: [], annotations: [], span, ...over,
    }
}

function decl(over: Partial<Declaration>, ...names: (string | { name: string; init?: Expression; card?: Expression[]; combine?: 'none' | '+' | '*' | 'max' | 'min' | '|' | '&' })[]): Declaration {
    return {
        kind: 'declaration', declKind: 'variable', signal: false, input: false, output: false, const: false, global: false,
        static: false, annotations: [], span, ...over,
        valuedObjects: names.map(n => {
            const v = typeof n === 'string' ? { name: n } : n
            return { kind: 'valuedObject' as const, id: `C$${v.name}`, name: v.name, cardinalities: v.card ?? [], initialValue: v.init, combine: v.combine, span }
        }),
    }
}

function action(kind: LocalAction['kind'], over: Partial<LocalAction> = {}): LocalAction {
    return { kind, id: `S!${kind}0`, effects: [], annotations: [], span, ...over }
}

describe('expressions (serializeHR)', () => {
    it('prints literals like KIELER', () => {
        expect(formatExpression(bool(true))).toBe('true')
        expect(formatExpression(int(42))).toBe('42')
        expect(formatExpression(str('hi'))).toBe('"hi"')
        expect(formatExpression({ kind: 'hostcode', text: 'f(x)', span })).toBe('f(x)')
        expect(formatExpressionPlain({ kind: 'hostcode', text: 'f(x)', span })).toBe('`f(x)`')
        expect(formatExpression({ kind: 'vector', values: [int(1), int(2)], span })).toBe('{1, 2}')
        expect(formatExpression({ kind: 'vector', values: [int(1), int(5)], range: true, span })).toBe('{1 to 5}')
        expect(formatExpression(ref('arr', op('+', x, int(1))))).toBe('arr[x + 1]')
    })
    it('prints floats as Java doubles', () => {
        expect(formatFloat(1)).toBe('1.0')
        expect(formatFloat(1.5)).toBe('1.5')
        expect(formatFloat(0.1)).toBe('0.1')
        expect(formatFloat(0.001)).toBe('0.001')
        expect(formatFloat(0.0001)).toBe('1.0E-4')
        expect(formatFloat(1e6)).toBe('1000000.0')
        expect(formatFloat(1e7)).toBe('1.0E7')
        expect(formatFloat(12345678.9)).toBe('1.23456789E7')
        expect(formatFloat(-2.5)).toBe('-2.5')
        expect(formatExpression(float(2))).toBe('2.0')
    })
    it('keeps only the parentheses precedence needs', () => {
        expect(formatExpression(op('||', op('&&', a, b), c))).toBe('a && b || c')
        expect(formatExpression(op('&&', op('||', a, b), c))).toBe('(a || b) && c')
        expect(formatExpression(op('!', op('&&', a, b)))).toBe('!(a && b)')
        expect(formatExpression(op('&&', op('!', a), op('!', b)))).toBe('!a && !b')
        expect(formatExpression(op('*', op('+', x, y), z))).toBe('(x + y) * z')
        expect(formatExpression(op('==', a, op('==', b, c)))).toBe('a == (b == c)')
        expect(formatExpression(op('-', x, op('+', y, z)))).toBe('x - (y + z)')
        expect(formatExpression(op('neg', op('+', x, y)))).toBe('-(x + y)')
        expect(formatExpression(op('==', op('&', x, int(3)), int(1)))).toBe('(x & 3) == 1')
        expect(formatExpression(op('>', op('+', op('pre', x), int(1)), x))).toBe('pre(x) + 1 > x')
        expect(formatExpression(op('?:', a, x, y))).toBe('a ? x : y')
        expect(formatExpression(op('+', op('?:', a, x, y), int(1)))).toBe('(a ? x : y) + 1')
    })
    it('reproduces KIELER\'s associativity shortcuts', () => {
        // KIELER drops the parentheses of a right-nested operand of the same associative-looking operator.
        expect(formatExpression(op('-', x, op('-', y, z)))).toBe('x - y - z')
        expect(formatExpression(op('neg', op('-', x, y)))).toBe('-x - y')
        expect(formatExpression(op('/', x, op('/', y, z)))).toBe('x / (y / z)')
    })
    it('combines shift operands with the plain serialiser', () => {
        expect(formatExpression(op('<<', x, int(2)))).toBe('x << 2')
        expect(formatExpression(op('<<', op('+', x, int(1)), int(2)))).toBe('(x + 1) << 2')
        expect(formatExpression(op('>', op('<<', x, int(2)), y))).toBe('x << 2 > y')
    })
    it('plain serialiser parenthesises every operator except !, ~, pre and val', () => {
        expect(formatExpressionPlain(op('+', x, op('*', y, z)))).toBe('(x + (y * z))')
        expect(formatExpressionPlain(op('!', op('pre', a)))).toBe('!pre(a)')
    })
    it('prints calls', () => {
        expect(formatExpression({ kind: 'call', name: 'f', args: [x, int(1)], span })).toBe('f(x, 1)')
        expect(formatExpression({ kind: 'call', name: 'rand', args: [], extern: true, span })).toBe('extern rand()')
        expect(formatExpression({ kind: 'call', name: 'f', args: [x, y], paramAccess: ['&', '!&'], span })).toBe('f(&x, !&y)')
    })
})

describe('effects', () => {
    const lookup = createFormatContext({
        pragmas: [],
        charts: [{
            kind: 'state', id: 'C', name: 'C', isRoot: true, initial: false, final: false, connector: false, violation: false,
            annotations: [], actions: [], regions: [], transitions: [], span, nameSpan: span,
            declarations: [decl({ signal: true, type: 'int', output: true }, 'V'), decl({ signal: true }, 'S')],
        } as State],
    })
    const sRef = { ...ref('S'), decl: 'C$S' }
    const vRef = { ...ref('V'), decl: 'C$V' }
    it('prints assignments, postfix and emissions', () => {
        const assign = (o: string, e: Expression): Effect => ({ kind: 'assign', target: ref('o'), operator: o as '=', expression: e, span })
        expect(formatEffect(assign('=', op('+', x, int(1))))).toBe('o = x + 1')
        expect(formatEffect(assign('+=', int(2)))).toBe('o += 2')
        expect(formatEffect(assign('min=', x))).toBe('o min= x')
        expect(formatEffect({ kind: 'postfix', target: ref('o'), operator: '++', span })).toBe('o++')
        expect(formatEffect({ kind: 'emit', target: sRef, span }, lookup)).toBe('S')
        expect(formatEffect({ kind: 'emit', target: vRef, value: int(3), span }, lookup)).toBe('V(3)')
        // The value of a valued emission is printed with the plain serialiser.
        expect(formatEffect({ kind: 'emit', target: vRef, value: op('+', x, int(1)), span }, lookup)).toBe('V((x + 1))')
        // An emission of a pure signal drops its value.
        expect(formatEffect({ kind: 'emit', target: sRef, value: int(1), span }, lookup)).toBe('S')
        expect(formatEffect({ kind: 'print', args: [x, str('a')], span })).toBe('print(x, "a")')
        expect(formatEffect({ kind: 'hostcode', text: 'foo(x)', span })).toBe('foo(x)')
        expect(formatEffects([assign('=', int(1)), { kind: 'postfix', target: ref('o'), operator: '--', span }])).toBe('o = 1; o--')
    })
})

describe('transition labels', () => {
    const effects: Effect[] = [
        { kind: 'assign', target: ref('O'), operator: '=', expression: bool(true), span },
        { kind: 'postfix', target: ref('x'), operator: '++', span },
    ]
    it('builds the semantic lines', () => {
        const t = transition({ trigger: op('&&', ref('A'), ref('B')), effects, priority: 1 })
        expect(transitionLabelLines(t, 2)).toEqual(['1: A && B', '/ O = true;', '  x++'])
        expect(transitionLabel(t, 2)).toBe('1: A && B / O = true; x++')
    })
    it('shows the priority only with more than one outgoing transition', () => {
        const t = transition({ trigger: ref('A') })
        expect(transitionLabel(t, 1)).toBe('A')
        expect(transitionLabel(transition({ priority: 2 }), 2)).toBe('2:')
        expect(transitionLabel(transition(), 1)).toBe('')
    })
    it('indents effects under a priority without trigger', () => {
        const t = transition({ effects, priority: 3 })
        expect(transitionLabelLines(t, 3)).toEqual(['3: / O = true;', '     x++'])
    })
    it('prints count delays, probabilities and user labels', () => {
        expect(transitionLabel(transition({ trigger: ref('A'), triggerDelay: 3 }), 1)).toBe('3 A')
        expect(transitionLabel(transition({ trigger: ref('A'), triggerDelay: 1 }), 1)).toBe('A')
        expect(transitionLabel(transition({ trigger: ref('A'), probability: 0.5 }), 1)).toBe('Pr=0.5: A')
        expect(transitionLabel(transition({ trigger: ref('A'), label: 'mine' }), 2)).toBe('mine')
        expect(transitionLabel(transition({ trigger: ref('A'), label: 'mine' }), 2, { userLabels: false })).toBe('1: A')
        expect(formatTransition(transition({ trigger: ref('A'), triggerDelay: 2, effects }))).toBe('2 A / O = true; x++')
    })
    it('knows which transitions KIELER draws dashed', () => {
        const plain = { connector: false }
        expect(isImplicitlyImmediate(transition({ delay: 'immediate' }), plain)).toBe(true)
        expect(isImplicitlyImmediate(transition(), { connector: true })).toBe(true)
        expect(isImplicitlyImmediate(transition({ preemption: 'termination' }), plain)).toBe(true)
        expect(isImplicitlyImmediate(transition({ preemption: 'termination', trigger: a }), plain)).toBe(false)
        expect(isImplicitlyImmediate(transition({ preemption: 'termination', delay: 'delayed' }), plain)).toBe(false)
        expect(isImplicitlyImmediate(transition({ delay: 'auto' }), plain)).toBe(false)
        expect(isImplicitlyImmediate(transition(), plain)).toBe(false)
    })
})

describe('declarations', () => {
    it('merges keywords and names as KIELER does', () => {
        expect(declarationSegments(decl({ input: true, type: 'bool' }, 'A', 'B'))).toEqual([
            { text: 'input bool ', format: 'keyword' }, { text: 'A, B', format: 'text' },
        ])
        expect(formatDeclaration(decl({ output: true, type: 'int' }, { name: 'F', init: int(0) }))).toBe('output int F = 0')
        expect(formatDeclaration(decl({ signal: true }, 'S'))).toBe('signal S')
        expect(formatDeclaration(decl({ input: true, output: true, type: 'int' }, 'io'))).toBe('input output int io')
        expect(formatDeclaration(decl({ const: true, input: true, type: 'int' }, 'K'))).toBe('input const int K')
        expect(formatDeclaration(decl({ type: 'int' }, { name: 'arr', card: [int(3), int(2)] }))).toBe('int arr[3][2]')
        expect(declarationSegments(decl({ signal: true, type: 'int' }, { name: 'L', init: int(0), combine: '+' }))).toEqual([
            { text: 'signal int ', format: 'keyword' }, { text: 'L = 0 ', format: 'text' }, { text: 'combine ', format: 'keyword' }, { text: '+', format: 'text' },
        ])
        expect(formatDeclaration(decl({ signal: true, type: 'bool' }, { name: 'W', combine: '|' }))).toBe('signal bool W combine or')
        expect(formatDeclaration(decl({ type: 'host', hostType: 'unsigned char' }, 'hc'))).toBe('unsigned char hc')
        expect(formatDeclaration(decl({ declKind: 'reference', extern: true, externs: [{ code: 'rand', annotations: [] }] }, 'rnd'))).toBe('extern rand rnd')
        expect(formatDeclaration(decl({ declKind: 'reference', referenceTarget: 'Other' }, 'o'))).toBe('ref Other o')
    })
    it('shows classes over several indented lines', () => {
        const member = decl({ type: 'int' }, 'count')
        const lines = declarationLines(decl({ declKind: 'class', className: 'Counter', members: [member] }, 'c'))
        expect(lines.map(l => [l.indent, mergeComponents(l.components).map(s => s.text).join('')])).toEqual([
            [0, 'class Counter {'], [1, 'int count'], [0, '} c'],
        ])
    })
})

describe('actions, titles and region labels', () => {
    it('prints actions as KIELER rows', () => {
        expect(actionSegments(action('entry', { effects: [{ kind: 'assign', target: ref('x'), operator: '=', expression: int(0), span }] })).map(s => s.text))
            .toEqual(['entry ', '/ x = 0'])
        expect(actionSegments(action('during', { delay: 'immediate', trigger: a, effects: [{ kind: 'postfix', target: x, operator: '++', span }] })).map(s => s.text))
            .toEqual(['immediate during ', 'a ', '/ x++'])
        expect(formatAction(action('suspend', { trigger: a }))).toBe('suspend a')
        expect(formatAction(action('suspend', { trigger: a, weak: true }))).toBe('weak suspend a')
        expect(formatAction(action('exit', { trigger: a, label: 'tidy up' }))).toBe('exit tidy up')
        // KIELER does not show an action's count delay.
        expect(formatAction(action('during', { trigger: a, triggerDelay: 3 }))).toBe('during a')
    })
    it('titles reference states with @', () => {
        const s = {
            kind: 'state', id: 'R', name: 'R', isRoot: false, initial: false, final: false, connector: false, violation: false,
            annotations: [], declarations: [], actions: [], regions: [], transitions: [], span, nameSpan: span,
            reference: { kind: 'scopeCall', target: 'Inner', parameters: [{ expression: a, span }, { expression: b, span }], span },
        } as State
        expect(stateTitleSegments(s)).toEqual([{ text: 'R ', format: 'text' }, { text: '@ ', format: 'keyword' }, { text: 'Inner (a, b)', format: 'text' }])
        expect(stateTitleSegments({ ...s, label: 'Shown' }).map(t => t.text)).toEqual(['Shown ', '@ ', 'Inner (a, b)'])
    })
    it('labels regions with their label or name', () => {
        const region = (over: Partial<Region>): Region => ({
            kind: 'region', id: 'S:0', regionType: 'controlflow', implicit: false, annotations: [], declarations: [], actions: [],
            states: [], equations: [], span, ...over,
        })
        expect(regionLabelSegments(region({ name: 'R1' }))).toEqual([{ text: 'R1', format: 'text' }])
        expect(regionLabelSegments(region({ name: 'R1', label: 'First' }))).toEqual([{ text: 'First', format: 'text' }])
        expect(regionLabelSegments(region({}))).toEqual([])
        expect(regionLabelSegments(region({ name: 'R', override: true })).map(s => s.text)).toEqual(['override ', 'R'])
        expect(formatEquation({ kind: 'equation', target: ref('O'), operator: '=', expression: op('&&', a, op('!', op('pre', a))), span }))
            .toBe('O = a && !pre(a)')
    })
    it('applies pragma symbol tables', () => {
        const ctx = createFormatContext({ charts: [], pragmas: [{ kind: 'pragma', name: 'symbols', values: ['greek'], span }, { kind: 'pragma', name: 'symbol', values: ['ON', '●'], span }] })
        expect(displayName('alpha1', ctx)).toBe('α1')
        expect(displayName('Omega', ctx)).toBe('Ω')
        expect(displayName('ON', ctx)).toBe('●')
        expect(displayName('^go')).toBe('go')
        const sub = createFormatContext({ charts: [], pragmas: [{ kind: 'pragma', name: 'symbols', values: ['subscript', '_'], span }] })
        expect(displayName('x_12', sub)).toBe('x₁₂')
    })
})

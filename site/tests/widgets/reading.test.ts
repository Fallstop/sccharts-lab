// "How KIELER reads it" (src/components/reads/reading.ts) on the traps of reference/operators, and the report
// link's template (src/components/site.ts).
import { describe, expect, it } from 'vitest'
import { expressionTree, readExpression, type TreeNode } from '../../src/components/reads/reading'
import { reportHref, REPORT_URL } from '../../src/components/site'

const shape = (n: TreeNode): unknown => (n.children.length ? [n.label, ...n.children.map(shape)] : n.label)

describe('How KIELER reads it', () => {
    it('shows the grouping of the traps, fully parenthesised', () => {
        expect(readExpression('A > 2 ? A : 0').text).toBe('A > (2 ? A : 0)')
        expect(readExpression('0 -> I + 1').text).toBe('(0 -> I) + 1')
        expect(readExpression('0 fby N + 1').text).toBe('(0 fby N) + 1')
        expect(readExpression('!A == B').text).toBe('(!A) == B')
        expect(readExpression('A & 3 == 2').text).toBe('A & (3 == 2)')
        expect(readExpression('A || B && C').text).toBe('A || (B && C)')
    })

    it('draws the same grouping as a tree, operators with their names', () => {
        const r = readExpression('A > 2 ? A : 0')
        expect(shape(r.tree!)).toEqual(['>', 'A', ['?:', '2', 'A', '0']])
        expect(r.tree!.name).toBe('greater than')
        // A run of one operator is one node, as in KIELER's model.
        expect(shape(readExpression('a - b - c').tree!)).toEqual(['-', 'a', 'b', 'c'])
        // Atoms stay whole: indices, calls, pre().
        expect(shape(readExpression('pre(x) + a[i + 1]').tree!)).toEqual(['+', 'pre(x)', 'a[i + 1]'])
    })

    it('reads an effect when the text is not an expression', () => {
        const r = readExpression('x = a + b * c')
        expect(r.as).toBe('effect')
        expect(r.text).toBe('x = a + (b * c)')
        expect(shape(r.tree!)).toEqual(['=', 'x', ['+', 'a', ['*', 'b', 'c']]])
    })

    it('reports a syntax error with its column and hint', () => {
        const r = readExpression('A == B == C')
        expect(r.error?.message).toMatch(/cannot be chained/)
        expect(r.error?.col).toBe(8)
        expect(r.error?.hint).toBeTruthy()
        expect(readExpression('!A + 1').error?.col).toBe(4)
        expect(readExpression('A ? 1 + 2 : 3').error).toBeDefined()
        expect(readExpression('').error).toBeDefined()
    })

    it('reads a trigger with its count delay, and KIELER\'s warning about a minus after it', () => {
        const r = readExpression('3 -I > 0', 'trigger')
        expect(r.delay).toBe(3)
        expect(r.text).toBe('(-I) > 0')
        expect(r.warnings[0]?.kieler).toMatch(/^A count delay was recognized in front of an unary operation/)
        expect(readExpression('3 A', 'trigger')).toMatchObject({ delay: 3, text: 'A' })
        expect(readExpression('A && B', 'trigger')).toMatchObject({ text: 'A && B' })
        expect(readExpression('A && B', 'trigger').delay).toBeUndefined()
    })

    it('rejects what KIELER rejects after if, with columns in the text', () => {
        expect(readExpression('3 == level', 'trigger').error?.col).toBe(3)
        expect(readExpression('0 A', 'trigger').error?.message).toMatch(/count delay of 0/i)
        // Text that ends too early is described without the words around it (go to ...).
        const early = readExpression('A &&', 'trigger').error!
        expect(early.message).not.toMatch(/'go'/)
        expect(early.message).toMatch(/end of the text/)
    })

    it('builds trees for single atoms', () => {
        const r = readExpression('S(3)')
        expect(shape(r.tree!)).toBe('S(3)')
        expect(expressionTree({ kind: 'int', value: 4, span: { start: 0, end: 1, line: 1, col: 1, endLine: 1, endCol: 2 } })).toEqual({ label: '4', children: [] })
    })
})

describe('the report link', () => {
    it('is off by default', () => {
        expect(REPORT_URL).toBeUndefined()
        expect(reportHref(undefined, 'https://sccharts.jmw.nz/learn/ticks/', 'Thinking in ticks')).toBeUndefined()
    })

    it('fills in the page, URL-encoded, or appends it', () => {
        expect(reportHref('https://example.org/new?title={title}&body={url}', 'https://sccharts.jmw.nz/learn/ticks/', 'Thinking in ticks')).toBe(
            'https://example.org/new?title=Thinking%20in%20ticks&body=https%3A%2F%2Fsccharts.jmw.nz%2Flearn%2Fticks%2F',
        )
        expect(reportHref('mailto:a@example.org', 'https://x.nz/a/', 'A')).toBe('mailto:a@example.org?page=https%3A%2F%2Fx.nz%2Fa%2F')
        expect(reportHref('https://example.org/report?site=guide', 'https://x.nz/a/', 'A')).toBe('https://example.org/report?site=guide&page=https%3A%2F%2Fx.nz%2Fa%2F')
    })
})

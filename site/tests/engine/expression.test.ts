// parseExpression and formatExpressionParenthesised: one expression or effect on its own, read with KIELER's
// grammar, and printed with the grouping made visible (for the operators page's "How KIELER reads it").
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, createSimulation, formatEffectParenthesised, formatExpressionParenthesised, parseExpression } from '../../src/engine/index'

function grouped(source: string, nary?: 'flat' | 'left'): string {
    const r = parseExpression(source)
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    if (r.expression) return formatExpressionParenthesised(r.expression, { nary })
    return formatEffectParenthesised(r.effect!, { nary })
}

describe('parseExpression', () => {
    it('groups by KIELER precedence', () => {
        expect(grouped('a + b * c')).toBe('a + (b * c)')
        expect(grouped('a && b || c && d')).toBe('(a && b) || (c && d)')
        expect(grouped('a | b ^ c & d')).toBe('a | (b ^ (c & d))')
        expect(grouped('a & b == c')).toBe('a & (b == c)')
        expect(grouped('1 + 2 << 3')).toBe('(1 + 2) << 3')
        expect(grouped('!a && b')).toBe('(!a) && b')
        expect(grouped('~a & b')).toBe('(~a) & b')
        expect(grouped('-x * y')).toBe('(-x) * y')
        expect(grouped('pre(x) + 1')).toBe('pre(x) + 1')
        expect(grouped('f(a + b * c, d)')).toBe('f(a + (b * c), d)')
        expect(grouped('a[i + 1] * 2')).toBe('a[i + 1] * 2')
    })

    it('keeps runs of one operator as one node, or nests them as C evaluates them', () => {
        expect(grouped('a - b - c')).toBe('a - b - c')
        expect(grouped('a - b - c', 'left')).toBe('(a - b) - c')
        expect(grouped('a - b + c')).toBe('(a - b) + c')
        expect(grouped('(a + b) + c')).toBe('(a + b) + c')
    })

    it('reads the conditional with single values only, as KIELER does', () => {
        expect(grouped('x > 0 ? 1 : 2')).toBe('x > (0 ? 1 : 2)')
        expect(grouped('(x > 0) ? 1 : 2')).toBe('(x > 0) ? 1 : 2')
        const nested = parseExpression('a ? b : c ? d : e')
        expect(nested.expression).toBeUndefined()
        expect(nested.diagnostics[0].hint).toContain('a ? b : (c ? d : e)')
    })

    it('reads effects when the text is not an expression', () => {
        expect(parseExpression('x = a + b * c').as).toBe('effect')
        expect(grouped('x = a + b * c')).toBe('x = a + (b * c)')
        expect(grouped('x++')).toBe('x++')
        expect(grouped('x += 1')).toBe('x += 1')
        expect(parseExpression('S(3)').as).toBe('expression')
        expect(parseExpression('S(a + b * c)', { as: 'effect' }).effect?.kind).toBe('emit')
        expect(formatEffectParenthesised(parseExpression('S(a + b * c)', { as: 'effect' }).effect!)).toBe('S(a + (b * c))')
    })

    it('explains what does not parse, with spans in the text', () => {
        const not = parseExpression('!a + b')
        expect(not.diagnostics[0].span?.start).toBe(3)
        expect(not.diagnostics[0].message).toContain("'!' applies only to the value right after it")
        expect(parseExpression('a < b < c').diagnostics[0].message).toContain('cannot be chained')
        expect(parseExpression('x + 1 = 3').diagnostics[0].hint).toContain('`==`')
        expect(parseExpression('x = = 1').as).toBe('effect')
        expect(parseExpression('').diagnostics[0].message).toContain('nothing to read')
        expect(parseExpression('a ==').diagnostics[0].message).toContain("after '=='")
    })

    // The grouping is the one the simulator (and KIELER, tests/conformance) computes with.
    it('agrees with the simulator', () => {
        const chart = `scchart G {
  input int x = 2
  output int r1, r2
  output bool b
  initial state A {
    entry do r1 = x > 0 ? 7 : 9; r2 = 10 - 3 - 2; b = !x == 1
  }
}`
        const result = compile(chart)
        expect(result.ok).toBe(true)
        const tick = createSimulation(result).step({})
        // KIELER (oracle): x > (0 ? 7 : 9) is 2 > 9; 10 - 3 - 2 is (10 - 3) - 2; !x == 1 is (!x) == 1
        expect(tick.values).toMatchObject({ r1: 0, r2: 5, b: false })
    })

    // KIELER's words for a syntax error (parser/kielerWording.ts), against 1619 texts KIELER read as a trigger or an
    // effect (tests/engine/kieler/expressions/wording.json): whenever the engine gives KIELER's words, they are
    // KIELER's, and it does for most texts.
    it('gives KIELER\'s words for a syntax error where they are known, and only then', () => {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kieler/expressions/wording.json')
        const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: { text: string; as: 'expression' | 'effect'; kieler: string | null }[] }
        let said = 0
        let broken = 0
        const wrong: string[] = []
        for (const c of cases) {
            if (c.as === 'expression' && /^[0-9.]/.test(c.text)) continue // a count delay in KIELER's trigger
            const r = parseExpression(c.text, { as: c.as })
            const error = r.diagnostics.find(d => d.severity === 'error')
            if (!error || c.kieler === null) continue
            broken++
            if (error.kieler === undefined) continue
            said++
            if (error.kieler !== c.kieler) wrong.push(`${c.as} ${c.text}: ${error.kieler} (KIELER: ${c.kieler})`)
        }
        expect(wrong).toEqual([])
        expect(broken).toBeGreaterThan(1300)
        expect(said / broken).toBeGreaterThan(0.6)
        // The operators page's traps.
        expect(parseExpression('A == B == C').diagnostics[0].kieler).toBe("no viable alternative at input '=='")
        expect(parseExpression('B ? -1 : 2').diagnostics[0].kieler).toBe("no viable alternative at input '?'")
        expect(parseExpression('!a + b').diagnostics[0].kieler).toBe("no viable alternative at input '+'")
        expect(parseExpression('x = = 1').diagnostics[0].kieler).toBe("no viable alternative at input '='")
    })
})

// Error messages, spans and recovery for a live editor: the parser never throws, reports several problems at once,
// and still returns as much of the model as it can.
import { describe, expect, it } from 'vitest'
import { compile, parse } from '../index'
import type { Diagnostic, State } from '../types'

const errorsOf = (source: string): Diagnostic[] => parse(source).diagnostics.filter(d => d.severity === 'error')
const first = (source: string): Diagnostic => {
    const e = errorsOf(source)
    expect(e.length, 'expected a syntax error').toBeGreaterThan(0)
    return e[0]
}
const at = (d: Diagnostic) => `${d.span?.line}:${d.span?.col}`
const chart = (body: string) => `scchart A {\n  input bool b\n  input int x\n  output int o\n${body}\n}\n`

function stateNames(source: string): string[] {
    const out: string[] = []
    const walk = (s: State) => { for (const r of s.regions) for (const t of r.states) { out.push(t.name); walk(t) } }
    parse(source).program?.charts.forEach(walk)
    return out
}

describe('messages for common mistakes', () => {
    const cases: [string, string, RegExp, RegExp?][] = [
        ['missing to', chart('  initial state S\n  if b go T\n  state T'), /Expected 'to' after 'go'/, /go to Target/],
        ['missing go', chart('  initial state S\n  if b to T\n  state T'), /'to' alone/, /`go`/],
        ['old arrow syntax', chart('  initial state S\n  --> T\n  state T'), /Unexpected '--'/, /go to Target/],
        ['semicolon after declaration', chart('  int y;\n  initial state S'), /';' after the declaration/, /do not end with a semicolon/],
        ['semicolon after state', chart('  initial state S;'), /Unexpected ';'/, /semicolon/],
        ['trailing semicolon in effects', chart('  initial state S\n  do o = 1; go to S'), /';' before 'go'/],
        ['misspelt keyword', chart('  intial state S'), /did you mean 'initial'/],
        ['misspelt type', chart('  input boolean c\n  initial state S'), /type before the name 'boolean'/],
        ['= instead of ==', chart('  initial state S\n  if x = 3 go to S'), /use '==' to compare/],
        ['== instead of =', chart('  initial state S\n  do o == 3 go to S'), /use '=' to assign/],
        ['count delay trap', chart('  initial state S\n  if 3 == x go to S'), /Expected a value/, /count delay/],
        ['count delay without trigger', chart('  initial state S\n  if 3 go to S'), /count delay and needs a trigger/],
        ['chained comparison', chart('  initial state S\n  if x < 1 < 3 go to S'), /cannot be chained/, /&&/],
        ['pre of an expression', chart('  initial state S\n  if pre(x + 1) > 0 go to S'), /pre\(\.\.\.\) takes a variable/, /pre\(x\) \+ 1/],
        ['keyword as state name', chart('  initial state go'), /'go' is a keyword/, /\^go/],
        ['modifier order', chart('  final initial state S'), /Write 'initial' before 'final'/, /initial final violation connector/],
        ['declaration after action', chart('  entry do o = 1\n  int late\n  initial state S'), /Declarations must come before/],
        ['declaration after state', chart('  initial state S\n  int late'), /Declarations must come before the states/],
        ['states mixed with regions', chart('  initial state S\n  region R:\n  initial state T'), /region cannot follow states/],
        ['transition before any state', chart('  go to S\n  initial state S'), /does not follow a state/],
        ['empty braces region', chart('  region R { }'), /has no states/],
        ['//* comment', chart('  initial state S\n  //***** section\n  state T'), /\/\/\* comment is not allowed/, /`\/\/ \*`/],
        ['dangling doc comment', chart('  initial state S {\n    /** doc */\n  }'), /must be followed by the element/],
        ['states outside a chart', 'initial state S\n', /must be inside an scchart/],
        ['print()', chart('  initial state S\n  do print() go to S'), /print needs something/],
        ['f( )', chart('  initial state S\n  do o = f( ) go to S'), /without a space/],
        ['missing value after operator', chart('  initial state S\n  if b && go to S'), /Expected a value after '&&'/],
        ['incomplete do', chart('  initial state S\n  if b do\n  state T'), /Expected an effect after 'do'/, /incomplete/],
        ['incomplete target', chart('  initial state S\n  if b go to\n  state T'), /name of the target state/, /incomplete/],
        ['number too large', chart('  initial state S\n  do o = 99999999999 go to S'), /too large/],
        ['unclosed string', chart('  initial state S "open'), /never closed/],
        ['non-breaking space', chart('  initial\u00a0state S'), /non-breaking space/],
        ['deep followed by a space', chart('  int deep\n  initial state S\n  do deep = 1 go to S'), /'deep deferred'/],
        ['conditional with nested parts', chart('  initial state S\n  do o = b ? b ? 1 : 2 : 3 go to S'), /Unexpected '\?'/, /parentheses/],
        ['missing semicolon in code', chart('  initial state S\n  do { o = 1 o = 2 } go to S'), /Missing semicolon/, /needs a `;` after it/],
        ['code: declaration after statement', chart('  initial state S\n  do { o = 1; int i = 0 } go to S'), /Declarations must come before the statements/],
        ['keyword as a class method name', 'scchart A {\n  class Counter {\n    int n = 0\n    void reset() { n = 0 }\n  } c\n  initial state S\n}\n', /'reset' is a keyword/, /`reset1`/],
        ['semicolon after return',chart('  method int f(int v) {\n    return v;\n  }\n  initial state S\n  do o = f(1) go to S'), /';' after the return statement/, /takes no `;`/],
    ]
    for (const [name, source, message, hint] of cases) {
        it(name, () => {
            const d = first(source)
            expect(d.message).toMatch(message)
            if (hint) expect(d.hint ?? '').toMatch(hint)
            expect(['parse', 'missing-semicolon']).toContain(d.code)
            expect(d.span).toBeDefined()
        })
    }

    it('points at the token that is wrong', () => {
        expect(at(first(chart('  initial state S\n  if b go T\n  state T')))).toBe('6:11')
        expect(at(first(chart('  initial state S\n  if b && go to S')))).toBe('6:11')
        expect(at(first(chart('  int y;\n  initial state S')))).toBe('5:8')
    })

    it('blames the inner block whose } was taken by an outer one', () => {
        const d = first('scchart A {\n  initial state S {\n    initial state I\n\n  state T\n}\n')
        expect(d.message).toMatch(/missing its closing '}'/)
        expect(d.hint).toMatch(/state `S` \(opened on line 2\) is probably missing its '}'/)
    })

    it('warns when an empty // comment swallows the next line', () => {
        const r = parse('scchart A {\n  input bool b //\n  initial state S\n}')
        expect(r.diagnostics.map(d => [d.severity, d.code])).toEqual([['warning', 'swallowed-line']])
    })
})

describe('recovery', () => {
    it('keeps the transition when only "to" is missing', () => {
        const r = parse(chart('  initial state S\n  if b go T\n  state T'))
        const s = r.program!.charts[0].regions[0].states[0]
        expect(s.transitions.map(t => [t.targetName, t.target])).toEqual([['T', 'A.T']])
    })

    it('reports several problems and keeps the states after them', () => {
        const source = chart('  int y;\n  initial state S;\n  if b go T\n  state T\n  if b go to\n  state U\n  --> S\n  state V')
        expect(errorsOf(source).length).toBeGreaterThanOrEqual(4)
        expect(stateNames(source)).toEqual(['S', 'T', 'U', 'V'])
    })

    it('recovers inside nested states and keeps the outer structure', () => {
        const source = 'scchart A {\n  initial state S {\n    initial state I\n    if ??? go to J\n    state J\n  }\n  go to T\n  state T\n}'
        expect(stateNames(source)).toEqual(['S', 'I', 'J', 'T'])
        expect(errorsOf(source)).toHaveLength(1)
    })

    it('keeps out-of-order actions in the model; a late declaration is left out of the scope, as KIELER drops it', () => {
        const r = parse(chart('  initial state S\n  int late\n  entry do o = 1'))
        const c = r.program!.charts[0]
        expect(c.declarations.map(d => d.valuedObjects[0].name)).not.toContain('late')
        expect(c.lateDeclarations?.map(d => d.valuedObjects[0].name)).toEqual(['late'])
        expect(c.actions).toHaveLength(1)
        const late = r.diagnostics.find(d => d.message === 'Declarations must come before the states and regions')
        expect(late?.kieler).toBe("no viable alternative at input 'int'")
        // Its uses do not resolve, and the hint says why.
        const u = compile(chart('  initial state S\n  if b do late = 1 go to S\n  int late')).diagnostics.find(d => d.code === 'unknown-variable')
        expect(u?.hint).toContain('`late` is declared on line')
    })

    it('returns a program for every prefix of a chart while typing', () => {
        const full = chart('  initial state Idle\n  if b do o = x + 1 go to Busy\n  state Busy {\n    entry do o = 0\n    initial state I\n    go to D\n    final state D\n  }\n  join to Idle')
        for (let i = 0; i <= full.length; i++) {
            const r = parse(full.slice(0, i))
            expect(r.program, `prefix ${i}`).toBeDefined()
        }
    })

    it('reports a missing closing brace at the end of the file', () => {
        const d = first('scchart A {\n  initial state S\n')
        expect(d.message).toMatch(/scchart `A` is missing its closing '}'/)
        expect(stateNames('scchart A {\n  initial state S\n')).toEqual(['S'])
    })

    it('skips garbage between charts', () => {
        const source = 'scchart A {\n  initial state S\n}\n}}} garbage\nscchart B {\n  initial state T\n}'
        expect(parse(source).program!.charts.map(c => c.name)).toEqual(['A', 'B'])
    })

    it('limits the number of diagnostics', () => {
        expect(parse(';'.repeat(5000)).diagnostics.length).toBeLessThanOrEqual(100)
    })
})

describe('compile after syntax errors', () => {
    it('reports the syntax errors and the names KIELER cannot resolve; validation waits until the syntax is fixed', () => {
        const r = compile(chart('  initial state S\n  if undeclared go T\n  state T'))
        expect(r.ok).toBe(false)
        expect(r.diagnostics.map(d => d.code)).toEqual(['unknown-variable', 'parse'])
        expect(r.program).toBeDefined()
        // A state that cannot be reached is not reported while the syntax is broken.
        const s = compile(chart('  initial state S\n  if b go T\n  state T\n  state U'))
        expect(s.diagnostics.map(d => d.code)).toEqual(['parse'])
    })
})

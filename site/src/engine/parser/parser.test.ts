import { describe, expect, it } from 'vitest'
import { parse } from '../index'
import type { Declaration, Effect, Expression, LocalAction, Program, Region, State, Transition } from '../types'

function ok(source: string): Program {
    const r = parse(source)
    const errors = r.diagnostics.filter(d => d.severity === 'error')
    expect(errors.map(d => `${d.span?.line}:${d.span?.col} ${d.message}`)).toEqual([])
    return r.program!
}

const wrap = (body: string, decls = 'input bool a, b, c\n  input int x, y, z\n  output int o\n  signal S\n  signal int V') =>
    `scchart A {\n  ${decls}\n${body}\n}\n`

function chart(source: string): State { return ok(source).charts[0] }
function firstState(source: string): State { return chart(source).regions[0].states[0] }
function firstTransition(body: string, decls?: string): Transition { return firstState(wrap(body, decls)).transitions[0] }
function trigger(t: string): Expression { return firstTransition(`  initial state S\n  if ${t} go to S`).trigger! }
function effects(e: string, decls?: string): Effect[] { return firstTransition(`  initial state S\n  do ${e} go to S`, decls).effects }
function decls(d: string): Declaration[] { return chart(`scchart A {\n  ${d}\n  initial state S\n}`).declarations }

/** Compact prefix notation of an expression tree. */
function show(e: Expression | undefined): string {
    if (!e) return '?'
    switch (e.kind) {
        case 'op': return `(${e.op} ${e.args.map(show).join(' ')})`
        case 'ref': return e.name + e.indices.map(i => `[${show(i)}]`).join('') + (e.sub ? `.${show(e.sub)}` : '')
        case 'int': case 'float': case 'bool': return String(e.value)
        case 'string': return JSON.stringify(e.value)
        case 'call': return `${e.extern ? 'extern ' : ''}${e.name}(${e.args.map(show).join(', ')})`
        case 'vector': return `{${e.values.map(show).join(', ')}${e.range ? ' range' : ''}}`
        case 'hostcode': return '`' + e.text + '`'
        case 'special': return `${e.access}(${e.container ? e.container + '.' : ''}${e.target})${e.sub ? '.' + show(e.sub) : ''}`
        default: return e.kind
    }
}

describe('expressions: precedence and associativity exactly as KExpressions', () => {
    const cases: [string, string][] = [
        ['a || b && c', '(|| a (&& b c))'],
        ['a || b || c', '(|| a b c)'],
        ['a && b || c', '(|| (&& a b) c)'],
        ['a | b & c', '(| a (& b c))'],
        ['x & y | z ^ x', '(| (& x y) (^ z x))'],
        ['x + y - z', '(- (+ x y) z)'],
        ['x - y + z', '(+ (- x y) z)'],
        ['x - y - z', '(- x y z)'],
        ['x * y + z * 2', '(+ (* x y) (* z 2))'],
        ['x / y * z', '(* (/ x y) z)'],
        ['x << 1 >> 2 << 3', '(<< (>> (<< x 1) 2) 3)'],
        ['x + 1 > y * 2 && b', '(&& (> (+ x 1) (* y 2)) b)'],
        ['-x * y', '(* (neg x) y)'],
        ['-x - y', '(- (neg x) y)'],
        ['- - x', '(neg (neg x))'],
        ['!a == b', '(== (! a) b)'],
        ['a == !b', '(== a (! b))'],
        ['!!a', '(! (! a))'],
        ['~x', '(~ x)'],
        ['a ? 1 : 2', '(?: a 1 2)'],
        ['a ? 3', '(?: a 3)'],
        ['x > 0 ? 1 : 2', '(> x (?: 0 1 2))'],
        ['(x > 0) ? 1 : 2', '(?: (> x 0) 1 2)'],
        ['-x -> y', '(neg (-> x y))'],
        ['x -> y -> z', '(-> x y z)'],
        ['x fby y fby z', '(fby x y z)'],
        ['x sfby y', '(sfby x y)'],
        ['x -> y fby z', '(-> x (fby y z))'],
        ['pre(x) + 1 > 0', '(> (+ (pre x) 1) 0)'],
        ['pre(pre(x), y) > 0', '(> (pre (pre x) y) 0)'],
        ['val(V) == 3', '(== (val V) 3)'],
        ['pre(val(V)) > 1', '(> (pre (val V)) 1)'],
        ['(a && b) == c', '(== (&& a b) c)'],
        ['(a && b) + 1 > 0', '(> (+ (&& a b) 1) 0)'],
        ['(x + y) * z > 0', '(> (* (+ x y) z) 0)'],
        ['x[1][y + 1] > 0', '(> x[1][(+ y 1)] 0)'],
        ['{1, 2} == x', '(== {1, 2} x)'],
        ['random', 'random'],
        ['extern f(x, y) > 0', '(> extern f(x, y) 0)'],
        ['`h` + 1 > 0', '(> (+ `h` 1) 0)'],
        ['1.5e3 > x', '(> 1500 x)'],
        ['"s" == "t"', '(== "s" "t")'],
    ]
    for (const [src, tree] of cases) it(src, () => expect(show(trigger(src))).toBe(tree))

    it('reads a number right after if as the count delay (always)', () => {
        const t = firstTransition('  initial state S\n  if 3 a go to S')
        expect(t.triggerDelay).toBe(3)
        expect(show(t.trigger)).toBe('a')
        const t2 = firstTransition('  initial state S\n  if 3 -x > 0 go to S')
        expect(t2.triggerDelay).toBe(3)
        expect(show(t2.trigger)).toBe('(> (neg x) 0)')
        const t3 = firstTransition('  initial state S\n  if 3 4 go to S')
        expect([t3.triggerDelay, show(t3.trigger)]).toEqual([3, '4'])
    })

    it('rejects what KIELER rejects', () => {
        for (const bad of ['a == b == c', '1 < x < 3', '!x + 1', '~x + 1', 'pre(x + 1)', 'pre(f())', 'a ? b ? 1 : 2 : 3', '3 == x', '3', '{}', 'f( )', '-!a', '_']) {
            const r = parse(wrap(`  initial state S\n  if ${bad} go to S`))
            expect(r.diagnostics.some(d => d.severity === 'error'), bad).toBe(true)
        }
    })

    it('reads vectors, ranges and ignored values', () => {
        const e = effects('arr = {1, _, x + 1}; arr = {0 to 2}; m = {{1, 2}, {3, 4}}', 'int arr[3]\n  int m[2][2]\n  input int x')
        expect(e.map(x => x.kind === 'assign' ? show(x.expression) : '')).toEqual(['{1, ignore, (+ x 1)}', '{0, 2 range}', '{{1, 2}, {3, 4}}'])
    })

    it('reads special access and calls', () => {
        const p = ok('scchart C {\n  const int MAX = 3\n  initial state S\n}\nscchart D {\n  output int o\n  initial state S\n  do o = scchart(C).MAX go to S\n}')
        const t = p.charts[1].regions[0].states[0].transitions[0]
        expect(t.effects[0].kind === 'assign' && show(t.effects[0].expression)).toBe('scchart(C).MAX')
    })
})

describe('declarations', () => {
    it('reads types, signals and flags', () => {
        const d = decls('input output bool io\n  output const int OC = 3\n  signal S\n  signal int V = 0 combine +\n  input signal float F combine max\n  host "unsigned char" h\n  clock c\n  global int g\n  static int st = 1')
        expect(d.map(x => [x.declKind, x.type, x.signal, x.input, x.output, x.const])).toEqual([
            ['variable', 'bool', false, true, true, false],
            ['variable', 'int', false, false, true, true],
            ['variable', undefined, true, false, false, false],
            ['variable', 'int', true, false, false, false],
            ['variable', 'float', true, true, false, false],
            ['variable', 'host', false, false, false, false],
            ['variable', 'clock', false, false, false, false],
            ['variable', 'int', false, false, false, false],
            ['variable', 'int', false, false, false, false],
        ])
        expect(d[3].valuedObjects[0].combine).toBe('+')
        expect(d[4].valuedObjects[0].combine).toBe('max')
        expect(d[5].hostType).toBe('unsigned char')
        expect(d[7].global).toBe(true)
        expect(d[8].static).toBe(true)
    })

    it('reads several valued objects, arrays, initial values and labels', () => {
        const [d1, d2] = decls('int a = 1, b, c[3] = {1, 2, 3}\n  bool m[2][2] label "matrix"')
        expect(d1.valuedObjects.map(v => [v.name, v.cardinalities.length, v.initialValue ? show(v.initialValue) : undefined])).toEqual([['a', 0, '1'], ['b', 0, undefined], ['c', 1, '{1, 2, 3}']])
        expect(d2.valuedObjects[0].cardinalities.map(show)).toEqual(['2', '2'])
        expect(d2.valuedObjects[0].label).toBe('matrix')
    })

    it('keeps primes in names', () => {
        expect(decls("int x', y''")[0].valuedObjects.map(v => v.name)).toEqual(["x'", "y''"])
    })

    it('reads extern, ref, class, struct, enum and method declarations', () => {
        const d = decls('extern @C "rand", @Java "Math.random" rand\n  class Counter {\n    private int c\n    void inc() { c++ }\n    int get() { return c }\n  } counter\n  struct P { int x\n int y } p\n  enum Bit { ZERO, ONE }\n  ref Bit b = Bit.ZERO\n  method int twice(int v) { return v * 2 }\n  schedule {conflicting, commuting} s')
        expect(d.map(x => x.declKind)).toEqual(['reference', 'class', 'struct', 'enum', 'reference', 'method', 'schedule'])
        expect(d[0].extern).toBe(true)
        expect(d[0].externs).toEqual([{ code: 'rand', annotations: [expect.objectContaining({ name: 'C' })] }, { code: 'Math.random', annotations: [expect.objectContaining({ name: 'Java' })] }])
        expect(d[1].className).toBe('Counter')
        expect(d[1].members!.map(m => [m.declKind, m.valuedObjects[0].name, m.access])).toEqual([['variable', 'c', 'private'], ['method', 'inc', undefined], ['method', 'get', undefined]])
        expect(d[1].valuedObjects[0].name).toBe('counter')
        expect(d[3].members![0].valuedObjects.map(v => v.name)).toEqual(['ZERO', 'ONE'])
        expect(d[4].referenceTarget).toBe('Bit')
        expect(d[5].returnType).toBe('int')
        expect(d[5].parameters![0].valuedObjects[0].name).toBe('v')
        expect(d[5].body!.statements[0].kind).toBe('return')
        expect(d[6].priorities).toEqual(['conflicting', 'commuting'])
    })

    it('splits method parameters at a comma followed by a type, as ANTLR does', () => {
        const [m] = decls('method int f(int a, b, bool c, int d) { return a }')
        expect(m.parameters!.map(p => [p.type, p.valuedObjects.map(v => v.name)])).toEqual([['int', ['a', 'b']], ['bool', ['c']], ['int', ['d']]])
    })

    it('attaches doc comments and //* comment annotations', () => {
        const [d1, d2] = decls('/** The trigger. */\n  input bool a //* also here\n  int b')
        expect(d1.doc).toBe('The trigger.\nalso here')
        expect(d1.annotations.map(a => a.name)).toEqual(['comment', 'comment'])
        expect(d2.doc).toBeUndefined()
    })
})

describe('states and regions', () => {
    it('reads modifiers, labels, bodies and nested states', () => {
        const c = chart('scchart A {\n  initial state S "Start" {\n    initial state I\n    go to F\n    final state F\n  }\n  join to C\n  connector state C\n  immediate go to V\n  final violation state V\n}')
        const [s, conn, v] = c.regions[0].states
        expect([s.initial, s.label, s.regions.length, s.regions[0].implicit]).toEqual([true, 'Start', 1, true])
        expect(s.regions[0].states.map(x => [x.name, x.initial, x.final])).toEqual([['I', true, false], ['F', false, true]])
        expect(conn.connector).toBe(true)
        expect([v.final, v.violation]).toEqual([true, true])
        expect(c.isRoot).toBe(true)
        expect(s.isRoot).toBe(false)
    })

    it('reads colon and brace regions, names, labels and modifiers', () => {
        const c = chart('scchart A {\n  region R1:\n  initial state A\n  region R2 "Two" {\n    initial state B\n  }\n  region:\n  initial state C\n}')
        expect(c.regions.map(r => [r.name, r.label, r.implicit, r.states.map(s => s.name)])).toEqual([
            ['R1', undefined, false, ['A']], ['R2', 'Two', false, ['B']], [undefined, undefined, false, ['C']],
        ])
        const s = firstState('scchart A {\n  initial state S {\n    final region F {\n      initial state X\n    }\n    abort region B:\n    initial state Y\n    override region O:\n    initial state Z\n  }\n}')
        expect(s.regions.map(r => [r.name, r.final, r.abort, r.override])).toEqual([['F', true, undefined, undefined], ['B', undefined, true, undefined], ['O', undefined, undefined, true]])
    })

    it('reads for regions and region references', () => {
        const c = chart('scchart A {\n  input bool arr[3]\n  region R for i : 0 to 2 {\n    initial state S\n  }\n  region Q for j : arr {\n    initial state T\n  }\n}')
        expect(c.regions.map(r => [r.forLoop?.variable, show(r.forLoop!.from), r.forLoop?.to ? show(r.forLoop.to) : undefined])).toEqual([['i', '0', '2'], ['j', 'arr', undefined]])
    })

    it('reads dataflow regions', () => {
        const c = chart(wrap('  dataflow:\n  o = x + 1\n  dataflow D {\n    int t\n    t = 2;\n    o = t seq\n  }'))
        expect(c.regions.map(r => [r.regionType, r.name, r.equations.length, r.declarations.length])).toEqual([['dataflow', undefined, 1, 0], ['dataflow', 'D', 2, 1]])
        expect(c.regions[1].equations.map(e => e.sequential)).toEqual([true, true])
        expect(show(c.regions[0].equations[0].expression)).toBe('(+ x 1)')
    })

    it('reads the implicit state of a region that holds regions', () => {
        const c = chart('scchart A {\n  region R {\n    region X:\n    initial state A\n    region Y:\n    initial state B\n  }\n}')
        const holder = c.regions[0].states[0]
        expect([holder.name, holder.regions.map(r => r.name)]).toEqual(['', ['X', 'Y']])
        expect(holder.id).toBe('A:R._')
    })

    it('reads references to other charts with bindings', () => {
        const p = ok('scchart A {\n  input bool a\n  output bool x\n  initial state R is Sub(a to i, x to o)\n  state Q is Sub(a, &x)\n  state P calls Sub()\n}\nscchart Sub {\n  input bool i\n  output bool o\n  initial state S\n}')
        const [r, q, pp] = p.charts[0].regions[0].states
        expect(r.reference!.target).toBe('Sub')
        expect(r.reference!.parameters.map(x => [show(x.expression), x.binding])).toEqual([['a', 'i'], ['x', 'o']])
        expect(q.reference!.parameters.map(x => [show(x.expression), x.byReference])).toEqual([['a', undefined], ['x', true]])
        expect(pp.callsReference).toBe(true)
        expect(pp.reference!.parameters).toEqual([])
    })

    it('reads inheritance and generics on charts', () => {
        const p = ok('scchart Base {\n  output int o\n  region Main {\n    initial state S\n  }\n}\nscchart D extends Base {\n  override region Main {\n    initial state T\n  }\n}\nscchart G<T is int> {\n  initial state S\n}')
        expect(p.charts[1].baseStates!.map(b => b.target)).toEqual(['Base'])
        expect(p.charts[2].genericParameters).toEqual(['T is int'])
    })
})

describe('transitions', () => {
    it('reads every part of a transition', () => {
        const t = firstTransition('  initial state S {\n    initial state I\n  }\n  @foo /** Leave. */ immediate if 2 a && b Pr=0.5 nondeterministic do o = 1; S; V(3) abort to S deep deferred history label "go"')
        expect(t.delay).toBe('immediate')
        expect(t.triggerDelay).toBe(2)
        expect(show(t.trigger)).toBe('(&& a b)')
        expect(t.probability).toBe(0.5)
        expect(t.nondeterministic).toBe(true)
        expect(t.effects.map(e => e.kind)).toEqual(['assign', 'emit', 'emit'])
        expect(t.preemption).toBe('strong')
        expect(t.targetName).toBe('S')
        expect(t.deferred).toBe('deep')
        expect(t.history).toBe('deep')
        expect(t.label).toBe('go')
        expect(t.annotations.map(a => a.name)).toEqual(['foo', 'comment'])
        expect(t.doc).toBe('Leave.')
    })

    it('reads preemption types, history and deferred forms', () => {
        const s = firstState(wrap('  initial state S\n  go to S\n  abort to S\n  join to S\n  go to S shallow history\n  go to S reset\n  go to S deferred'))
        expect(s.transitions.map(t => [t.preemption, t.history, t.deferred])).toEqual([
            ['weak', undefined, undefined], ['strong', undefined, undefined], ['termination', undefined, undefined],
            ['weak', 'shallow', undefined], ['weak', 'reset', undefined], ['weak', undefined, 'shallow'],
        ])
    })

    it('keeps the delay as written, with undefined for none', () => {
        const s = firstState(wrap('  initial state S\n  go to S\n  delayed go to S\n  auto go to S\n  undefined go to S'))
        expect(s.transitions.map(t => t.delay)).toEqual([undefined, 'delayed', 'auto', 'undefined'])
        expect(s.transitions.map(t => t.priority)).toEqual([1, 2, 3, 4])
    })

    it('accepts a transition right after the closing brace of the body', () => {
        const s = firstState(wrap('  initial state S {\n    initial state I\n  } if a go to S'))
        expect(s.transitions).toHaveLength(1)
    })
})

describe('effects', () => {
    it('reads assignments with every operator and postfix effects', () => {
        const e = effects('o = 1; o += 1; o -= 1; o *= 2; o /= 2; o %= 3; o &= 1; o |= 1; o ^= 1; o <<= 1; o >>= 1; o >>>= 1; o min= 1; o max= 2; o++; o--')
        expect(e.map(x => (x.kind === 'assign' || x.kind === 'postfix') ? x.operator : x.kind)).toEqual(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', 'min=', 'max=', '++', '--'])
    })

    it('reads emissions, calls, print, randomize, host code and code blocks', () => {
        const e = effects('S; V(x + 1); f(1, 2); g(); extern h(x); print("v", x); randomize(); `x = 1;`; { o = 1; o++ }')
        expect(e.map(x => x.kind)).toEqual(['emit', 'emit', 'call', 'call', 'call', 'print', 'randomize', 'hostcode', 'code'])
        const code = e[8]
        expect(code.kind === 'code' && code.text).toBe('{ o = 1; o++ }')
        expect(code.kind === 'code' && code.statements!.map(s => s.kind)).toEqual(['assign', 'postfix'])
        expect(e[4].kind === 'call' && e[4].extern).toBe(true)
    })

    it('reads SCL statements in code blocks', () => {
        const [code] = effects('{\n    int i = 0;\n    for (int k = 0; k < 3; k++) { o += k; }\n    while (i < 2) { i++ }\n    if (o > 3) { o = 4 } else { o = 0 }\n    l: o = 1;\n    goto l\n  }')
        expect(code.kind === 'code' && code.declarations!.length).toBe(1)
        expect(code.kind === 'code' && code.statements!.map(s => s.kind)).toEqual(['for', 'while', 'if', 'label', 'assign', 'goto'])
    })
})

describe('local actions', () => {
    it('reads every kind with its modifiers', () => {
        const s = firstState(wrap('  initial state S {\n    entry do o = 1\n    immediate during if a do o++\n    during if 2 b do o = 0\n    exit do o = 2 label "x"\n    suspend if a\n    immediate weak suspend if b\n    weak entry do o = 3\n    strong exit\n    period 2.5\n    ode o = 1\n    entry if a Pr 0.5\n  }'))
        const a = s.actions
        const summary = (x: LocalAction) => [x.kind, x.delay, x.preemption, x.weak, x.triggerDelay]
        expect(a.map(summary)).toEqual([
            ['entry', undefined, undefined, undefined, undefined],
            ['during', 'immediate', undefined, undefined, undefined],
            ['during', undefined, undefined, undefined, 2],
            ['exit', undefined, undefined, undefined, undefined],
            ['suspend', undefined, undefined, undefined, undefined],
            ['suspend', 'immediate', undefined, true, undefined],
            ['entry', undefined, 'weak', undefined, undefined],
            ['exit', undefined, 'strong', undefined, undefined],
            ['period', undefined, undefined, undefined, undefined],
            ['ode', undefined, undefined, undefined, undefined],
            ['entry', undefined, undefined, undefined, undefined],
        ])
        expect(a[3].label).toBe('x')
        expect(show(a[8].trigger)).toBe('2.5')
        expect(a[10].probability).toBe(0.5)
    })
})

describe('program level', () => {
    it('reads imports, pragmas and several charts', () => {
        const p = ok('#hostcode "int x;"\n#resource "a.c", "b.c"\n#tag\n#meta {"a": [1, {"b": null}]}\nimport "Other"\nimport "dir/*"\nscchart A {\n  initial state S\n}\nscchart B {\n  initial state S\n}')
        expect(p.pragmas.map(x => [x.name, x.values, x.json])).toEqual([
            ['hostcode', ['int x;'], undefined], ['resource', ['a.c', 'b.c'], undefined], ['tag', [], undefined], ['meta', [], '{"a": [1, {"b": null}]}'],
        ])
        expect(p.imports).toEqual(["Other", "dir/*"])
        expect(p.charts.map(c => c.name)).toEqual(['A', 'B'])
    })

    it('reads annotations: tags, values, typed, JSON and doc comments with @@ lines', () => {
        const s = firstState('scchart A {\n  /**\n   * Start here.\n   * @@foreground f00\n   */\n  @collapse\n  @layout[elk.direction] RIGHT\n  @size 3, -1, 2.5, true, "x"\n  @meta {"k": [1, 2]}\n  initial state S\n}')
        expect(s.doc).toBe('Start here.')
        expect(s.annotations.map(a => [a.name, a.values, a.type])).toEqual([
            ['comment', ['Start here.'], undefined], ['foreground', ['f00'], undefined], ['collapse', [], undefined],
            ['layout', ['RIGHT'], 'elk.direction'], ['size', ['3', '-1', '2.5', 'true', 'x'], undefined], ['meta', [], undefined],
        ])
        expect(s.annotations[5].json).toBe('{"k": [1, 2]}')
    })

    it('reads extended IDs and labels on charts', () => {
        const c = chart('scchart df#0007 "Data" {\n  initial state S\n}')
        expect([c.name, c.label]).toEqual(['df#0007', 'Data'])
    })

    it('keeps ordinary comments', () => {
        const p = ok('// top\nscchart A { /* inner */\n  initial state S\n}')
        expect(p.comments!.map(c => c.text)).toEqual(['// top', '/* inner */'])
    })
})

describe('spans', () => {
    const src = 'scchart Spans {\n  input bool go1\n  initial state Waiting\n  if go1 && !go1 do go1 = true go to Done\n  final state Done\n}\n'
    const p = ok(src)
    const c = p.charts[0]
    const text = (span: { start: number; end: number }) => src.slice(span.start, span.end)

    it('covers names, states and transitions exactly', () => {
        const [w, d] = c.regions[0].states
        expect(text(c.nameSpan)).toBe('Spans')
        expect(text(w.nameSpan)).toBe('Waiting')
        expect(text(w.span)).toBe('initial state Waiting')
        expect(text(d.span)).toBe('final state Done')
        const t = w.transitions[0]
        expect(text(t.span)).toBe('if go1 && !go1 do go1 = true go to Done')
        expect(text(t.targetSpan)).toBe('Done')
        expect(text(t.trigger!.span)).toBe('go1 && !go1')
        expect(text(t.effects[0].span)).toBe('go1 = true')
        expect(text(c.declarations[0].span)).toBe('input bool go1')
        expect(text(c.declarations[0].valuedObjects[0].nameSpan!)).toBe('go1')
    })

    it('uses 1-based lines and columns', () => {
        const t = c.regions[0].states[0].transitions[0]
        expect([t.span.line, t.span.col, t.span.endLine, t.span.endCol]).toEqual([4, 3, 4, 42])
        expect(p.span).toMatchObject({ start: 0, end: src.length, line: 1, col: 1 })
    })

    it('keeps the inner span for parenthesised expressions', () => {
        const s = 'scchart P {\n  input int x\n  initial state S\n  if (x > 1) go to S\n}'
        const t = ok(s).charts[0].regions[0].states[0].transitions[0]
        expect(s.slice(t.trigger!.span.start, t.trigger!.span.end)).toBe('x > 1')
    })
})

describe('regions written in order', () => {
    it('puts directly written states into one implicit region', () => {
        const c = chart('scchart A {\n  initial state S\n  state T\n}')
        expect(c.regions.map((r: Region) => [r.implicit, r.states.length])).toEqual([[true, 2]])
    })
})

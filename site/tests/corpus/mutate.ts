// Deterministic mutations of SCTX texts, for robustness tests (parse must never throw) and for differential
// testing against KIELER (accept/reject must agree).
import { lex } from '../../src/engine/parser/lexer'

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number) {
    let a = seed >>> 0
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return {
        next,
        int: (n: number) => Math.floor(next() * n),
        pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
    }
}

export const TOKEN_POOL = [
    'state', 'initial', 'final', 'connector', 'region', 'dataflow', 'scchart', 'if', 'do', 'go', 'to', 'abort', 'join', 'immediate',
    'delayed', 'entry', 'during', 'exit', 'suspend', 'weak', 'strong', 'period', 'label', 'is', 'for', 'input', 'output', 'signal',
    'bool', 'int', 'float', 'string', 'pure', 'const', 'ref', 'extern', 'host', 'clock', 'combine', 'pre', 'val', 'print', 'random',
    'history', 'shallow history', 'deferred', 'deep deferred', 'reset', 'override', 'method', 'class', 'struct', 'enum', 'return',
    'true', 'false', 'null', 'this', 'super.', 'x', 'A', 'B', 'S', 'foo', '1', '3', '0.5', '1f', '"s"', '`h`', '@foo', '@bar "v"',
    '/** d */', '{', '}', '(', ')', '()', '[', ']', ',', ';', ':', '.', '=', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%',
    '&&', '||', '!', '&', '|', '^', '~', '<<', '>>', '++', '--', '+=', '-=', '?', '->', 'fby', '_', '#p', "'", 'max', 'min',
]

export type Mutation = (text: string, r: ReturnType<typeof rng>) => string

function tokens(text: string) {
    return lex(text).tokens.filter(t => t.kind !== 'EOF')
}

export const MUTATIONS: Record<string, Mutation> = {
    deleteToken(text, r) {
        const ts = tokens(text)
        if (!ts.length) return text
        const t = r.pick(ts)
        return text.slice(0, t.start) + text.slice(t.end)
    },
    duplicateToken(text, r) {
        const ts = tokens(text)
        if (!ts.length) return text
        const t = r.pick(ts)
        return text.slice(0, t.end) + ' ' + t.text + text.slice(t.end)
    },
    swapTokens(text, r) {
        const ts = tokens(text)
        if (ts.length < 2) return text
        const i = r.int(ts.length - 1)
        const a = ts[i]
        const b = ts[i + 1]
        return text.slice(0, a.start) + b.text + text.slice(a.end, b.start) + a.text + text.slice(b.end)
    },
    replaceToken(text, r) {
        const ts = tokens(text)
        if (!ts.length) return text
        const t = r.pick(ts)
        return text.slice(0, t.start) + r.pick(TOKEN_POOL) + text.slice(t.end)
    },
    insertToken(text, r) {
        const ts = tokens(text)
        if (!ts.length) return text
        const t = r.pick(ts)
        return text.slice(0, t.start) + r.pick(TOKEN_POOL) + ' ' + text.slice(t.start)
    },
    deleteLine(text, r) {
        const lines = text.split('\n')
        lines.splice(r.int(lines.length), 1)
        return lines.join('\n')
    },
    duplicateLine(text, r) {
        const lines = text.split('\n')
        const i = r.int(lines.length)
        lines.splice(i, 0, lines[i])
        return lines.join('\n')
    },
    truncate(text, r) {
        return text.slice(0, r.int(text.length + 1))
    },
}

export function mutate(text: string, r: ReturnType<typeof rng>, count = 1): { text: string; ops: string[] } {
    const names = Object.keys(MUTATIONS)
    const ops: string[] = []
    let out = text
    for (let i = 0; i < count; i++) {
        const name = r.pick(names.filter(n => n !== 'truncate'))
        ops.push(name)
        out = MUTATIONS[name](out, r)
    }
    return { text: out, ops }
}

// ----- grammar-directed random snippets: short random token runs in the places where the grammar decides -----

const HEAD = 'input bool a, b\n  input int x, y\n  output int o\n  output bool z\n  signal S\n  signal int V combine +\n  method int f() { return 1 }\n  int arr[3]\n'

export const SNIPPET_POOLS: Record<string, { pool: string[]; make: (hole: string) => string }> = {
    trigger: {
        pool: ['a', 'b', 'x', 'y', 'arr', '1', '3', '2.5', 'true', '(', ')', '!', '~', '-', '+', '*', '/', '%', '==', '!=', '<', '<=', '>',
            '&&', '||', '&', '|', '^', '<<', '?', ':', '->', 'fby', 'pre', 'val', ',', '[', ']', '{', '}', '_', 'random', '"s"', '`h`', 'S',
            'V', '@n', 'f', '()', '.', 'null', 'extern', 'schedule'],
        make: h => `scchart F {\n  ${HEAD}  initial state S0\n  if ${h} go to S0\n}\n`,
    },
    effect: {
        pool: ['o', 'S', 'V', 'x', 'z', 'arr', '[', ']', '=', '+=', '++', '--', '(', ')', ';', '1', 'print', '"s"', '{', '}', 'f', '()', ',', '&',
            'extern', 'randomize', '`h`', '@n', 'min=', '-', '+', 'true', 'if', 'else', 'int', 'i', 'return', 'for', 'while', '<', 'super.', '.'],
        make: h => `scchart F {\n  ${HEAD}  initial state S0\n  do ${h} go to S0\n}\n`,
    },
    declaration: {
        pool: ['input', 'output', 'const', 'signal', 'bool', 'int', 'float', 'pure', 'host', '"t"', 'ref', 'extern', 'c', 'd', ',', '=', '1',
            '[', ']', 'combine', '+', 'max', 'label', '"l"', 'static', 'global', 'private', '//* c\n', '@n', 'clock', 'enum', '{', '}', 'method', '()',
            'class', 'struct', 'schedule', 'commuting', 'string', '-'],
        make: h => `scchart F {\n  ${h}\n  initial state S0\n}\n`,
    },
    transition: {
        pool: ['immediate', 'delayed', 'auto', 'if', 'do', 'a', '3', 'Pr=', '0.5', 'nondeterministic', ';', 'o', '=', '1', '@n', '/** d */',
            'go', 'to', 'abort', 'join', 'S0', 'S1', 'deferred', 'history', 'label', '"l"', 'reset', 'shallow history', 'deep deferred', 'state'],
        make: h => `scchart F {\n  ${HEAD}  initial state S0 {\n    initial state I\n    go to E\n    final state E\n  }\n  ${h}\n  state S1\n}\n`,
    },
    structure: {
        pool: ['initial', 'final', 'connector', 'violation', 'state', 'region', 'dataflow', 'R', 'A', 'B', ':', '{', '}', '"l"', 'is', 'Sub', '(', ')',
            'for', 'i', '0', 'to', '2', 'abort', 'override', 'extends', 'go', 'join', '@n', '/** d */', 'o', '=', 'a'],
        make: h => `scchart F {\n  ${HEAD}  ${h}\n}\nscchart Sub {\n  initial state W\n}\n`,
    },
    action: {
        pool: ['entry', 'during', 'exit', 'suspend', 'period', 'ode', 'immediate', 'weak', 'strong', 'if', 'do', 'a', '2', 'o', '=', '1', ';',
            'label', '"l"', 'Pr', 'Pr=', '0.5', '++', '@n'],
        make: h => `scchart F {\n  ${HEAD}  initial state S0 {\n    ${h}\n    initial state I\n  }\n}\n`,
    },
    annotation: {
        pool: ['@n', '@m', 'v', '"s"', '3', '-', '2.5', 'true', ',', '[', ']', 'x.y', '{', '}', '"k"', ':', 'null', '/** d */', '#p'],
        make: h => `scchart F {\n  ${HEAD}  ${h} initial state S0\n  ${h} go to S0\n}\n`,
    },
}

export function randomSnippet(r: ReturnType<typeof rng>): { name: string; text: string } {
    const kinds = Object.keys(SNIPPET_POOLS)
    const kind = r.pick(kinds)
    const { pool, make } = SNIPPET_POOLS[kind]
    const length = 1 + r.int(6)
    const tokens = Array.from({ length }, () => r.pick(pool))
    return { name: `snippet:${kind}`, text: make(tokens.join(' ')) }
}

// ----- random expressions from a superset of the KExpressions grammar (valid and near-valid) -----

const BINARY = ['||', '&&', '|', '^', '&', '==', '!=', '<', '<=', '>', '>=', '<<', '>>', '>>>', '+', '-', '*', '/', '%', '->', 'fby', 'sfby']

export function randomExpression(r: ReturnType<typeof rng>, depth = 0): string {
    const leaf = () => r.pick(['a', 'b', 'x', 'y', 'o', 'V', 'S', '1', '0', '3', '2.5', 'true', 'false', '"s"', 'null', 'random', 'f()', '`h`', 'arr[1]', 'arr[x]'])
    if (depth > 3) return leaf()
    const k = r.int(14)
    const sub = () => randomExpression(r, depth + 1)
    switch (k) {
        case 0: case 1: case 2: return leaf()
        case 3: return `(${sub()})`
        case 4: return `${r.pick(['!', '-', '~'])}${r.next() < 0.3 ? ' ' : ''}${sub()}`
        case 5: case 6: case 7: return `${sub()} ${r.pick(BINARY)} ${sub()}`
        case 8: return `${sub()} ? ${sub()}${r.next() < 0.7 ? ` : ${sub()}` : ''}`
        case 9: return `${r.pick(['pre', 'val'])}(${r.next() < 0.6 ? r.pick(['a', 'x', 'V', 'S', 'pre(a)', 'val(V)']) : sub()}${r.next() < 0.2 ? ', x' : ''})`
        case 10: return `{${sub()}, ${r.next() < 0.3 ? '_' : sub()}}`
        case 11: return `f(${sub()})`
        case 12: return `extern g(${sub()})`
        default: return `${sub()} ${r.pick(BINARY)} ${sub()} ${r.pick(BINARY)} ${sub()}`
    }
}

export function randomExpressionCase(r: ReturnType<typeof rng>): { name: string; text: string } {
    const e = randomExpression(r)
    const where = r.int(5)
    const body = [
        `initial state S0\n  if ${e} go to S0`,
        `initial state S0\n  do o = ${e} go to S0`,
        `dataflow:\n  o = ${e}`,
        `initial state S0 {\n    during if ${e} do o = 1\n  }`,
        `initial state S0\n  if ${r.int(4)} ${e} go to S0`,
    ][where]
    return { name: `expression:${where}`, text: `scchart F {\n  ${HEAD}  ${body}\n}\n` }
}

// Recursive-descent parser for SCTX, following KIELER's Xtext grammars (SCTX.xtext with SCL, KExt, KEffects,
// KExpressions and Annotations) rule by rule. KIELER's generated ANTLR 3 parser runs with backtracking: where its
// LL(*) lookahead cannot decide, it tries the alternatives in order and takes the first that parses ("PEG" style),
// and where the lookahead is regular it looks as far ahead as it needs. This parser does the same: fixed lookahead
// for the structure (states, regions, declarations), ordered speculation for expressions and effects. Comments
// marked "KIELER:" describe a surprising behaviour of the official parser that is reproduced on purpose.
//
// The parser never throws. Errors become diagnostics with spans; it recovers at the next state, region,
// transition, declaration or closing brace, so a partial Program is available while the user is typing.

import type {
    Annotation, AssignOperator, CombineOperator, Declaration, DelayType, Diagnostic, Effect, Equation, Expression,
    LocalAction, LocalActionKind, OperatorType, ParamAccess, Pragma, Program, Reference, Region, ScopeCall,
    ScopeParameter, SclStatement, Span, State, Transition, ValuedObject, ValueType,
} from '../types'
import { describeToken, KEYWORDS, lex, type Token } from './lexer'
import { LineMap } from './source'

// ---------------------------------------------------------------------------------------------------------------
// Failures and helpers
// ---------------------------------------------------------------------------------------------------------------

/** A parse failure at a token. Thrown inside the parser; turned into a diagnostic at a recovery point. */
class Failure {
    /** `kieler`: KIELER's own message for this mistake, where the guide knows it (checked against recordings). */
    constructor(readonly at: number, readonly message: string, readonly hint?: string, readonly endAt?: number, readonly kieler?: string) {}
}

const ASSIGN_OPS = new Set<string>(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', 'min=', 'max='])
const COMPARE_OPS = new Set<string>(['==', '<', '<=', '>', '>=', '!='])
const VALUE_TYPES = new Set<string>(['pure', 'bool', 'int', 'float', 'string', 'clock', 'clock-time'])
const METHOD_RETURN_TYPES = new Set<string>(['void', 'bool', 'int', 'float', 'string', 'clock-time'])
const DELAYS = new Set<string>(['immediate', 'delayed', 'auto', 'undefined'])
const ACCESS = new Set<string>(['public', 'protected', 'private'])
const COMBINE: Record<string, CombineOperator> = { none: 'none', '+': '+', '*': '*', max: 'max', min: 'min', '|': '|', '&': '&', host: 'host' }
const ACTION_KEYWORDS = new Set<string>(['entry', 'during', 'exit', 'suspend', 'period', 'ode'])
const DECLARATION_STARTS = new Set<string>([
    'public', 'protected', 'private', 'input', 'output', 'const', 'global', 'static', 'signal', 'pure', 'bool', 'int', 'float',
    'string', 'clock', 'clock-time', 'host', 'ref', 'extern', 'schedule', 'class', 'struct', 'enum', 'method', 'primitive',
])
const STATE_MODIFIERS = ['initial', 'final', 'violation', 'connector'] as const
/** Tokens that start the next element of a body: an expression or effect cut short by them is incomplete. */
const STRUCTURAL = new Set<string>(['state', 'initial', 'final', 'connector', 'violation', 'region', 'dataflow', '}', 'EOF', 'scchart', 'entry', 'during', 'exit'])

/** Words a beginner might mistype, for "did you mean" hints. */
const SUGGESTABLE = [...KEYWORDS].filter(k => /^[a-z]+$/.test(k) && k.length > 2)

function editDistance(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const row = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i++) {
        let prev = row[0]
        row[0] = i
        for (let j = 1; j <= n; j++) {
            const tmp = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
            prev = tmp
        }
    }
    return row[n]
}

function suggestKeyword(word: string, among: Iterable<string> = SUGGESTABLE): string | undefined {
    const lower = word.toLowerCase()
    let best: string | undefined
    let bestDistance = Infinity
    for (const k of among) {
        if (k === word) continue
        const d = k === lower ? 0.5 : editDistance(lower, k)
        if (d < bestDistance) { bestDistance = d; best = k }
    }
    return best !== undefined && bestDistance <= (word.length <= 4 ? 1 : 2) ? best : undefined
}

/** Value of an Xtext STRING token (STRINGValueConverter: Java escapes). */
function stringValue(text: string): string {
    const body = text.length >= 2 && text.endsWith('"') ? text.slice(1, -1) : text.slice(1)
    return body.replace(/\\(.)/g, (_, c: string) => ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' } as Record<string, string>)[c] ?? c)
}

/** Value of a STRING used as an annotation or pragma value (AnnotationsValueConverter: only \" and \\). */
function annotationStringValue(text: string): string {
    const body = text.length >= 2 && text.endsWith('"') ? text.slice(1, -1) : text.slice(1)
    return body.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/** IDValueConverter: strips the escape caret. */
const idValue = (text: string) => (text.startsWith('^') ? text.slice(1) : text)

/** Text of a /** comment *\/ as KIELER's CommentAnnotation converter produces it, plus its @@ annotation lines. */
function commentAnnotationText(raw: string): { text: string; inner: string[] } {
    const lines = raw.replace(/\/\*\*/g, '').replace(/\*\//g, '').replace(/\r/g, '').trim().split('\n')
    const kept: string[] = []
    const inner: string[] = []
    for (const line of lines) {
        const l = line.replace(/^\s*\*\s*/, '')
        if (l.startsWith('@@')) inner.push(l.slice(1))
        else kept.push(l)
    }
    return { text: kept.join('\n'), inner }
}

// ---------------------------------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------------------------------

export interface ParseOutput {
    program: Program
    diagnostics: Diagnostic[]
}

type AnnotationMode = 'full' | 'restricted' | 'quoted'

interface PendingAnnotations {
    annotations: Annotation[]
    doc?: string
}

const MAX_DIAGNOSTICS = 100

export function parseProgram(source: string, lines: LineMap = new LineMap(source)): ParseOutput {
    return new Parser(source, lines).parseProgram()
}

/** What `parseStandalone` reads the text as: KIELER's `Expression` rule, its `Effect` rule, or whichever fits. */
export type StandaloneMode = 'expression' | 'effect' | 'auto'

export interface StandaloneOutput {
    /** The rule the text was read with ('auto' tries the expression first, then the effect). */
    as: 'expression' | 'effect'
    expression?: Expression
    effect?: Effect
    diagnostics: Diagnostic[]
}

/**
 * Parses one expression (KIELER's `Expression` rule, as in a trigger or an initial value) or one effect (its
 * `Effect` rule, as after `do`) on its own, with the same grammar and the same messages as in a chart.
 */
export function parseStandalone(source: string, mode: StandaloneMode = 'auto', lines: LineMap = new LineMap(source)): StandaloneOutput {
    return new Parser(source, lines).parseStandalone(mode)
}

class Parser {
    private readonly toks: Token[]
    private pos = 0
    private spec = 0
    private readonly diagnostics: Diagnostic[] = []
    private readonly comments
    /** Packrat memo for expression rules: rule -> token index -> result. */
    private memo = new Map<string, Map<number, { node: Expression; end: number } | Failure>>()
    /** Annotations with unquoted values (not allowed where the grammar uses QuotedStringAnnotation). */
    private readonly unquoted = new WeakSet<Annotation>()
    /** Braces whose closing '}' is indented differently from the line that opened them (for "missing }" hints). */
    private readonly braceMismatches: { open: number; close: number; what: string }[] = []
    /** Inside a { ... } code block or method body (affects what a ';' after a declaration means). */
    private inCodeBlock = 0
    /** SCL statements written with a trailing ';' (for KIELER's "Missing Semicolon" check). */
    private readonly withSemicolon = new WeakSet<SclStatement>()

    constructor(private readonly src: string, private readonly lines: LineMap) {
        const lexed = lex(src, lines)
        this.toks = lexed.tokens
        this.comments = lexed.comments
        this.diagnostics.push(...lexed.diagnostics)
    }

    // ----- token access -----

    private la(k = 0): Token { return this.toks[Math.min(this.pos + k, this.toks.length - 1)] }
    private kind(k = 0): string { return this.la(k).kind }
    private at(kind: string): boolean { return this.la().kind === kind }
    private atAny(kinds: ReadonlySet<string> | readonly string[]): boolean {
        const k = this.la().kind
        return Array.isArray(kinds) ? kinds.includes(k) : (kinds as ReadonlySet<string>).has(k)
    }
    private next(): Token {
        const t = this.toks[this.pos]
        if (t.kind !== 'EOF') this.pos++
        return t
    }
    private accept(kind: string): Token | undefined {
        if (this.la().kind === kind) return this.next()
        return undefined
    }

    private span(fromTok: number, toTokExclusive = this.pos): Span {
        const a = this.toks[Math.min(fromTok, this.toks.length - 1)]
        const lastIndex = Math.max(fromTok, toTokExclusive - 1)
        const b = this.toks[Math.min(lastIndex, this.toks.length - 1)]
        return this.lines.span(a.start, Math.max(a.start, b.end))
    }
    private tokSpan(t: Token): Span { return this.lines.span(t.start, t.end) }

    private fail(message: string, hint?: string, at = this.pos, kieler?: string): never {
        throw new Failure(at, message, hint, undefined, kieler)
    }

    private expect(kind: string, message?: string, hint?: string): Token {
        if (this.la().kind === kind) return this.next()
        this.fail(message ?? `Expected '${kind}' but found ${describeToken(this.la())}`, hint)
    }

    /** Like expect, but outside speculation a missing token is reported and assumed (single-token insertion). */
    private expectOrInsert(kind: string, canInsert: boolean, message: string, hint?: string): Token | undefined {
        if (this.la().kind === kind) return this.next()
        if (this.spec === 0 && canInsert) {
            this.report(new Failure(this.pos, message, hint))
            return undefined
        }
        this.fail(message, hint)
    }

    private report(f: Failure) {
        if (this.spec > 0) return
        if (this.diagnostics.length >= MAX_DIAGNOSTICS) return
        const t = this.toks[Math.min(f.at, this.toks.length - 1)]
        const end = f.endAt !== undefined ? this.toks[Math.min(f.endAt, this.toks.length - 1)].end : t.end
        // One error per position: later errors at the same token are usually consequences.
        if (this.diagnostics.some(d => d.severity === 'error' && d.code === 'parse' && d.span?.start === t.start)) return
        const d: Diagnostic = {
            severity: 'error', code: 'parse', message: f.message, hint: f.hint,
            span: this.lines.span(t.start, Math.max(t.start, end)),
        }
        // `1e3`: the lexer reads `1` and the name `e3`, wherever the number stands.
        const prev = f.at > 0 ? this.toks[f.at - 1] : undefined
        if (t.kind === 'ID' && /^[eE]\d+$/.test(t.text) && prev?.kind === 'INT' && prev.end === t.start) {
            d.message = `${prev.text}${t.text} is not a number in SCTX`
            d.hint = `A float exponent needs a decimal point: write \`${prev.text}.0${t.text}\`, not \`${prev.text}${t.text}\`.`
            d.kieler = `no viable alternative at input '${t.text}'`
            d.span = this.lines.span(prev.start, t.end)
        } else if (f.kieler) d.kieler = f.kieler
        this.diagnostics.push(d)
    }

    /** Speculative parse: returns the result, or the Failure (and restores the position). */
    private attempt<T>(fn: () => T): T | Failure {
        const save = this.pos
        this.spec++
        try {
            return fn()
        } catch (e) {
            if (e instanceof Failure) {
                this.pos = save
                return e
            }
            throw e
        } finally {
            this.spec--
        }
    }

    /** Runs fn speculatively and returns the index after it (or -1), without consuming anything. */
    private scan(fn: () => void): number {
        const save = this.pos
        this.spec++
        try {
            fn()
            return this.pos
        } catch (e) {
            if (e instanceof Failure) return -1
            throw e
        } finally {
            this.pos = save
            this.spec--
        }
    }

    private kindAt(index: number): string { return this.toks[Math.min(index, this.toks.length - 1)].kind }

    /** Leading whitespace of the line containing offset, or undefined if offset is not the first thing on its line. */
    private indentOf(offset: number, requireFirst: boolean): number | undefined {
        const lineStart = this.src.lastIndexOf('\n', offset - 1) + 1
        const lead = /^[ \t]*/.exec(this.src.slice(lineStart, offset + 1))![0].length
        if (requireFirst && lineStart + lead !== offset) return undefined
        return lead
    }

    /** Consumes a closing '}' and remembers it when its indentation does not match the opening line. */
    private closeBrace(openTok: number, what: string) {
        const close = this.pos
        this.next()
        if (this.spec > 0) return
        const a = this.indentOf(this.toks[openTok].start, false)
        const b = this.indentOf(this.toks[close].start, true)
        if (a !== undefined && b !== undefined && a !== b) this.braceMismatches.push({ open: openTok, close, what })
    }

    /** "Missing }" at the end of the file: point at the block whose } was probably taken by an outer block. */
    private missingBraceHint(what: string, openTok: number): string {
        const line = (t: number) => this.lines.position(this.toks[t].start).line
        const m = this.braceMismatches.find(x => x.open > openTok)
        if (m) return `Check the braces above: ${m.what} (opened on line ${line(m.open)}) is probably missing its '}': the } on line ${line(m.close)} is indented like an outer block, so it closed ${m.what} instead.`
        return `Add '}' at the end of ${what} (opened on line ${line(openTok)}).`
    }

    // ----- program -----

    parseProgram(): ParseOutput {
        const pragmas: Pragma[] = []
        const imports: string[] = []
        const importSpans: Span[] = []
        const charts: State[] = []
        while (this.at('#') || this.at('import')) {
            const start = this.pos
            try {
                if (this.at('#')) pragmas.push(this.parsePragma())
                else {
                    this.next()
                    const at = this.pos
                    imports.push(this.parseEString('Expected the name of the file to import after \'import\', e.g. import "Other"'))
                    importSpans.push(this.span(at))
                }
            } catch (e) {
                this.recoverTopLevel(e, start)
            }
        }
        while (!this.at('EOF')) {
            const start = this.pos
            try {
                if (this.at('#') || this.at('import')) {
                    this.fail(this.at('#') ? 'Pragmas (#...) must come before the first scchart' : 'Imports must come before the first scchart',
                        'Move it to the top of the file, above every scchart.')
                }
                if (!this.isRootStateStart()) this.failUnexpectedTopLevel()
                charts.push(this.parseRootState())
            } catch (e) {
                this.recoverTopLevel(e, start)
            }
        }
        const program: Program = {
            kind: 'program',
            span: this.lines.span(0, this.src.length),
            imports, pragmas, charts,
        }
        if (importSpans.length) program.importSpans = importSpans
        if (this.comments.length) program.comments = this.comments.map(c => ({ kind: c.kind, text: c.text, span: this.lines.span(c.start, c.end) }))
        this.checkSemicolons(program)
        return { program, diagnostics: this.diagnostics }
    }

    parseStandalone(mode: StandaloneMode): StandaloneOutput {
        if (this.at('EOF')) {
            const what = mode === 'effect' ? 'an effect, such as `x = a + 1`' : mode === 'expression' ? 'an expression, such as `a + b * c`' : 'an expression or an effect, such as `a + b * c` or `x = a + 1`'
            this.report(new Failure(0, `There is nothing to read: type ${what}`))
            return { as: mode === 'effect' ? 'effect' : 'expression', diagnostics: this.diagnostics }
        }
        const rules: ('expression' | 'effect')[] = mode === 'auto' ? ['expression', 'effect'] : [mode]
        let best: { rule: 'expression' | 'effect'; failure: Failure } | undefined
        for (const rule of rules) {
            this.pos = 0
            this.memo.clear()
            const result = this.attempt(() => {
                const node = rule === 'expression' ? this.parseExpression() : this.parseEffect()
                if (!this.at('EOF')) this.failTrailing(rule, node)
                return node
            })
            if (!(result instanceof Failure)) {
                return rule === 'expression'
                    ? { as: rule, expression: result as Expression, diagnostics: this.diagnostics }
                    : { as: rule, effect: result as Effect, diagnostics: this.diagnostics }
            }
            // The rule that got further explains the problem better ('x = = 1' is a broken effect, not expression).
            if (!best || result.at > best.failure.at) best = { rule, failure: result }
        }
        this.report(best!.failure)
        return { as: best!.rule, diagnostics: this.diagnostics }
    }

    /** Text left over after a complete expression or effect. */
    private failTrailing(rule: 'expression' | 'effect', node: Expression | Effect): never {
        const t = this.la()
        if (rule === 'expression' && node.kind === 'op' && (node.op === '!' || node.op === '~')) {
            this.fail(`Unexpected ${describeUnexpected(t)}: '${node.op}' applies only to the value right after it`,
                `KIELER reads \`${node.op}\` with one name, call or parenthesised expression after it: put everything it should apply to in parentheses, as in \`${node.op}(a + b)\`, or write \`(${node.op}a) + b\` to use its result.`)
        }
        if (rule === 'expression' && (t.kind === '?' || t.kind === ':')) {
            this.fail(`Unexpected '${t.kind}' after the expression`,
                'The three parts of `c ? a : b` must each be a single value (a name, a number, a call or a parenthesised expression): write `(x > 0) ? 1 : 2`, and `a ? b : (c ? d : e)` for a nested conditional.')
        }
        if (rule === 'expression' && ASSIGN_OPS.has(t.kind)) {
            this.fail(`Unexpected '${t.kind}' in an expression`, `\`${t.kind}\` assigns, which only an effect can do. To compare, write \`==\`.`)
        }
        this.fail(`Unexpected ${describeUnexpected(t)} after the ${rule}`)
    }

    private isRootStateStart(): boolean {
        if (this.at('scchart')) return true
        if (this.at('@') || this.at('COMMENT_ANNOTATION')) {
            const after = this.scan(() => this.parseAnnotations('full'))
            return after >= 0 && this.kindAt(after) === 'scchart'
        }
        return false
    }

    private failUnexpectedTopLevel(): never {
        const t = this.la()
        if (t.kind === 'state' || STATE_MODIFIERS.includes(t.kind as typeof STATE_MODIFIERS[number])) {
            this.fail('States must be inside an scchart', 'Wrap the states in a chart: scchart Name { ... }.')
        }
        if (t.kind === 'ID') {
            const s = suggestKeyword(t.text, ['scchart', 'import'])
            if (s) this.fail(`Unknown word '${t.text}': did you mean '${s}'?`, 'A file starts with optional imports and pragmas, followed by one or more charts: scchart Name { ... }.')
        }
        if (t.kind === '}') this.fail("This '}' has no matching '{'", 'Remove it, or check the braces above: every `{` needs exactly one `}`.', this.pos, "extraneous input '}' expecting EOF")
        this.fail(`Expected an scchart but found ${describeToken(t)}`, 'A file contains imports, pragmas and charts written as scchart Name { ... }.')
    }

    private recoverTopLevel(e: unknown, start: number) {
        if (!(e instanceof Failure)) throw e
        this.report(e)
        if (this.pos === start) this.next()
        // Skip to the next chart (or EOF), keeping brace balance.
        let depth = 0
        while (!this.at('EOF')) {
            const k = this.kind()
            if (depth === 0 && (k === 'scchart' || ((k === '@' || k === 'COMMENT_ANNOTATION') && this.isRootStateStart()))) break
            if (k === '{') depth++
            else if (k === '}') depth = Math.max(0, depth - 1)
            this.next()
        }
    }

    // ----- pragmas, annotations -----

    private parsePragma(): Pragma {
        const start = this.pos
        this.expect('#')
        const name = this.parseExtendedID('Expected the pragma name after #, as in #hostcode "..."')
        if (this.at('{')) {
            const jsonStart = this.pos
            this.parseJsonObject()
            return { kind: 'pragma', name, values: [], json: this.src.slice(this.toks[jsonStart].start, this.toks[this.pos - 1].end), span: this.span(start) }
        }
        const values: string[] = []
        if (this.isAnnotationValueStart('full')) {
            values.push(this.parseAnnotationValue('full'))
            while (this.at(',')) {
                this.next()
                values.push(this.parseAnnotationValue('full'))
            }
        }
        return { kind: 'pragma', name, values, span: this.span(start) }
    }

    /** ExtendedID: ID (('.'|'-') ID)* ('#' INT)? */
    private parseExtendedID(message?: string): string {
        const first = this.expect('ID', message ?? `Expected a name but found ${describeToken(this.la())}`)
        let value = idValue(first.text)
        while ((this.at('.') || this.at('-')) && this.kind(1) === 'ID') {
            value += this.next().text
            value += idValue(this.next().text)
        }
        if (this.at('#') && this.kind(1) === 'INT') {
            value += this.next().text
            value += this.next().text
        }
        return value
    }

    /** EString: STRING | ExtendedID */
    private parseEString(message: string): string {
        if (this.at('STRING')) return annotationStringValue(this.next().text)
        if (this.at('ID')) return this.parseExtendedID()
        this.fail(message)
    }

    private isAnnotationValueStart(mode: AnnotationMode, k = 0): boolean {
        const kind = this.kind(k)
        if (kind === 'STRING') return true
        if (mode === 'quoted') return false
        if (kind === 'ID' || kind === 'BOOLEAN') return true
        if (mode === 'restricted') return false
        if (kind === 'INT' || kind === 'FLOAT') return true
        return kind === '-' && (this.kind(k + 1) === 'INT' || this.kind(k + 1) === 'FLOAT')
    }

    /** EStringAllTypes / EStringBoolean / STRING, depending on the annotation rule. */
    private parseAnnotationValue(mode: AnnotationMode, owner?: Annotation): string {
        const t = this.la()
        if (t.kind === 'STRING') { this.next(); return annotationStringValue(t.text) }
        if (owner) this.unquoted.add(owner)
        if (mode !== 'quoted') {
            if (t.kind === 'ID') return this.parseExtendedID()
            if (t.kind === 'BOOLEAN') { this.next(); return t.text }
            if (mode === 'full') {
                if (t.kind === 'INT' || t.kind === 'FLOAT') { this.next(); return t.text }
                if (t.kind === '-' && (this.kind(1) === 'INT' || this.kind(1) === 'FLOAT')) {
                    this.next()
                    return '-' + this.next().text
                }
            }
        }
        this.fail(`Expected an annotation value but found ${describeToken(t)}`,
            mode === 'quoted' ? 'Here annotation values must be quoted strings: @name "value".' : 'Annotation values are names, strings, numbers or true/false: @name value.')
    }

    private parseJsonObject() {
        this.expect('{')
        if (!this.at('}')) {
            this.parseJsonMember()
            while (this.accept(',')) this.parseJsonMember()
        }
        this.expect('}', `Expected '}' to close the JSON object but found ${describeToken(this.la())}`)
    }
    private parseJsonMember() {
        this.expect('STRING', `Expected a quoted key in the JSON object but found ${describeToken(this.la())}`)
        this.expect(':', `Expected ':' after the JSON key but found ${describeToken(this.la())}`)
        this.parseJsonValue()
    }
    private parseJsonValue() {
        const k = this.kind()
        if (k === '{') return this.parseJsonObject()
        if (k === '[') {
            this.next()
            if (!this.at(']')) {
                this.parseJsonValue()
                while (this.accept(',')) this.parseJsonValue()
            }
            this.expect(']', `Expected ']' to close the JSON array but found ${describeToken(this.la())}`)
            return
        }
        if (k === 'null' || k === 'INT' || k === 'FLOAT' || k === 'BOOLEAN' || k === 'STRING') { this.next(); return }
        this.fail(`Expected a JSON value but found ${describeToken(this.la())}`)
    }

    private isAnnotationStart(): boolean { return this.at('@') || this.at('COMMENT_ANNOTATION') }

    /**
     * Annotation* in one of the grammar's flavours. `demoteLast`: read a final `@name value` as the tag `@name`
     * followed by the value (KIELER's lookahead does this when the value is the start of the annotated element).
     */
    private parseAnnotations(mode: AnnotationMode, demoteLast = false): PendingAnnotations {
        const out: PendingAnnotations = { annotations: [] }
        const docs: string[] = []
        while (this.isAnnotationStart()) {
            const t = this.la()
            if (t.kind === 'COMMENT_ANNOTATION') {
                this.next()
                const { text, inner } = commentAnnotationText(t.text)
                docs.push(text)
                out.annotations.push({ kind: 'annotation', name: 'comment', values: [text], span: this.tokSpan(t) })
                for (const line of inner) {
                    const a = parseInnerAnnotation(line, this.tokSpan(t))
                    if (a) out.annotations.push(a)
                }
                continue
            }
            const start = this.pos
            this.next() // '@'
            const name = this.parseExtendedID(`Expected an annotation name after @, as in @layout or @collapse`)
            const annotation: Annotation = { kind: 'annotation', name, values: [], span: this.span(start) }
            if (this.at('[')) {
                this.next()
                annotation.type = this.parseExtendedID(`Expected the annotation type inside [ ], as in @layout[elk.direction] UP`)
                this.expect(']', `Expected ']' after the annotation type but found ${describeToken(this.la())}`)
                annotation.values.push(this.parseAnnotationValue(mode, annotation))
                while (this.at(',') && this.isAnnotationValueStart(mode, 1)) {
                    this.next()
                    annotation.values.push(this.parseAnnotationValue(mode, annotation))
                }
            } else if (this.isAnnotationValueStart(mode) && !(demoteLast && !this.isAnnotationStartAfterValue(mode))) {
                annotation.values.push(this.parseAnnotationValue(mode, annotation))
                while (this.at(',') && this.isAnnotationValueStart(mode, 1)) {
                    this.next()
                    annotation.values.push(this.parseAnnotationValue(mode, annotation))
                }
            } else if (mode !== 'restricted' && this.at('{') && this.kind(1) === 'STRING') {
                // KIELER: `@name {"key": ...}` is a JSON annotation; `@name {}` is a tag followed by a '{'.
                const jsonStart = this.pos
                this.parseJsonObject()
                annotation.json = this.src.slice(this.toks[jsonStart].start, this.toks[this.pos - 1].end)
            }
            annotation.span = this.span(start)
            out.annotations.push(annotation)
        }
        if (docs.length) out.doc = docs.join('\n')
        return out
    }

    /** For demotion: is there another annotation after the value at the current position? Then keep it a value. */
    private isAnnotationStartAfterValue(mode: AnnotationMode): boolean {
        const after = this.scan(() => this.parseAnnotationValue(mode))
        const k = this.kindAt(after)
        return after >= 0 && (k === '@' || k === 'COMMENT_ANNOTATION' || k === ',')
    }

    /** `//* comment` after a declaration (CommentAnnotatonSL). */
    private parseOptionalSlComment(target: { annotations: Annotation[]; doc?: string }) {
        if (!this.at('SL_COMMENT_ANNOTATION')) return
        const t = this.next()
        const text = t.text.replace(/^\/\/\*/, '').replace(/\r?\n$/, '').trim()
        target.annotations.push({ kind: 'annotation', name: 'comment', values: [text], span: this.tokSpan(t) })
        target.doc = target.doc ? `${target.doc}\n${text}` : text
    }

    // ----- root state -----

    private parseRootState(): State {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        this.expect('scchart', `Expected 'scchart' but found ${describeToken(this.la())}`)
        const nameIdx = this.pos
        const name = this.parseExtendedID(`Expected the chart's name after 'scchart', as in scchart Blinker { ... }`)
        const state = this.newState(start, name, this.span(nameIdx), pending, true)
        if (this.at('STRING')) state.label = stringValue(this.next().text)
        if (this.at('<')) state.genericParameters = this.parseGenericParameterDeclarations()
        if (this.accept('extends')) {
            state.baseStates = [this.parseBaseStateReference()]
            while (this.accept(',')) state.baseStates.push(this.parseBaseStateReference())
        }
        const open = this.expectOrInsert('{', false, `Expected '{' to start the body of scchart ${name} but found ${describeToken(this.la())}`,
            'A chart is written scchart Name { declarations, actions, states }.')
        void open
        this.parseScopeBody(state, 'root', start)
        state.span = this.span(start)
        return state
    }

    private newState(start: number, name: string, nameSpan: Span, pending: PendingAnnotations, isRoot: boolean): State {
        const state: State = {
            kind: 'state', id: '', name, isRoot, initial: false, final: false, connector: false, violation: false,
            annotations: pending.annotations, declarations: [], actions: [], regions: [], transitions: [],
            nameSpan, span: this.span(start),
        }
        if (pending.doc !== undefined) state.doc = pending.doc
        return state
    }

    private parseGenericParameterDeclarations(): string[] {
        this.expect('<')
        const out: string[] = []
        const one = () => {
            const s = this.pos
            this.parseAnnotations('quoted')
            this.parsePrimeID()
            if (this.accept('is')) {
                if (this.atAny(VALUE_TYPES) || this.at('primitive')) this.next()
                else {
                    this.accept('ref')
                    this.parsePrimeID()
                }
            }
            out.push(this.src.slice(this.toks[s].start, this.toks[this.pos - 1].end))
        }
        one()
        while (this.accept(',')) one()
        this.expect('>', `Expected '>' to close the generic parameters but found ${describeToken(this.la())}`)
        return out
    }

    private parseGenericParameters(): string[] {
        this.expect('<')
        const out: string[] = []
        const one = () => {
            const s = this.pos
            this.parseGenericParameter()
            out.push(this.src.slice(this.toks[s].start, this.toks[this.pos - 1].end))
        }
        one()
        while (this.accept(',')) one()
        this.expect('>', `Expected '>' to close the generic arguments but found ${describeToken(this.la())}`)
        return out
    }

    /** GenericParameter: value type | literal | Type<...> | a[i].b | a.b | Type | a */
    private parseGenericParameter() {
        if (this.atAny(['pure', 'bool', 'int', 'float', 'string', 'clock', 'clock-time'])) { this.next(); return }
        if (this.atAny(['INT', 'FLOAT', 'BOOLEAN', 'STRING'])) { this.next(); return }
        this.parsePrimeID()
        if (this.at('<')) { this.parseGenericParameters(); return }
        while (this.at('[')) {
            this.next()
            this.parseExpression()
            this.expect(']')
        }
        if (this.accept('.')) this.parseValuedObjectReference()
    }

    private parseBaseStateReference(): ScopeCall {
        const start = this.pos
        const targetTok = this.expect('ID', `Expected the name of the base chart after 'extends'`)
        const call: ScopeCall = { kind: 'scopeCall', target: idValue(targetTok.text), parameters: [], span: this.span(start), targetSpan: this.tokSpan(targetTok) }
        if (this.at('<')) call.genericParameters = this.parseGenericParameters()
        this.parseScopeParameters(call)
        call.span = this.span(start)
        return call
    }

    // ----- scope bodies (charts and superstates) -----

    /**
     * Body of an scchart or superstate after '{':
     *   declarations* actions* (states (one implicit region) | regions*) '}'
     * Items written out of this order are errors in KIELER; they are still parsed here (and kept) so the partial
     * model stays useful.
     */
    private parseScopeBody(owner: State, where: 'root' | 'state', start: number) {
        let phase = 0 // 0 declarations, 1 actions, 2 states/regions
        let mode: 'none' | 'states' | 'regions' = 'none'
        let implicit: Region | undefined
        const ownerName = where === 'root' ? `scchart \`${owner.name}\`` : `state \`${owner.name}\``
        for (;;) {
            if (this.at('}')) { this.closeBrace(start, ownerName); return }
            if (this.at('EOF')) {
                this.report(new Failure(this.pos, `The ${ownerName} is missing its closing '}'`, this.missingBraceHint(ownerName, start)))
                return
            }
            const itemStart = this.pos
            try {
                const item = this.classifyBodyItem(where)
                switch (item) {
                    case 'declaration': {
                        if (phase > 0) this.report(new Failure(this.pos, phase === 1
                            ? 'Declarations must come before the entry, during and exit actions'
                            : 'Declarations must come before the states and regions',
                        `In ${ownerName}, write the variables and signals first, then the actions, then the states or regions.`,
                        undefined, phase === 2 && !this.isAnnotationStart() ? `no viable alternative at input '${this.la().text}'` : undefined))
                        // KIELER's parser drops a declaration it does not expect here: its names do not resolve.
                        if (phase > 0) (owner.lateDeclarations ??= []).push(...this.parseDeclaration())
                        else owner.declarations.push(...this.parseDeclaration())
                        break
                    }
                    case 'action': {
                        if (phase > 1) this.report(new Failure(this.pos, 'Actions (entry, during, exit, suspend, ...) must come before the states and regions',
                            `In ${ownerName}, write the declarations first, then the actions, then the states or regions.`))
                        phase = Math.max(phase, 1)
                        owner.actions.push(this.parseLocalAction())
                        break
                    }
                    case 'state': {
                        phase = 2
                        if (mode === 'regions') this.report(new Failure(this.pos, 'States cannot follow a region directly',
                            `In ${ownerName}, either write states directly (one region) or put every state into a region: write \`region Main:\` above these states.`))
                        if (!implicit) {
                            implicit = {
                                kind: 'region', id: '', regionType: 'controlflow', implicit: true, annotations: [], declarations: [], actions: [],
                                states: [], equations: [], span: this.span(this.pos, this.pos + 1),
                            }
                            owner.regions.push(implicit)
                        }
                        if (mode === 'none') mode = 'states'
                        implicit.states.push(this.parseState())
                        implicit.span = this.spanOfNodes(implicit.states)
                        break
                    }
                    case 'region': {
                        phase = 2
                        if (mode === 'states') this.report(new Failure(this.pos, 'A region cannot follow states that are not in a region',
                            `In ${ownerName}, states written directly form one region of their own, and a region cannot follow them. To have several regions, put the states above into a region too: write \`region Main:\` before the first state${implicit?.states[0]?.name ? ` (\`${implicit.states[0].initial ? 'initial ' : ''}state ${implicit.states[0].name}\`)` : ''}.`,
                            undefined, `mismatched input '${this.la().text}' expecting '}'`))
                        mode = mode === 'none' ? 'regions' : mode
                        owner.regions.push(this.parseRegion())
                        break
                    }
                    case 'policy': {
                        if (where !== 'root') this.fail(`Policy regions are only allowed directly in an scchart or a host class`)
                        if (mode === 'states') this.fail('A policy region cannot follow states that are not in a region', `Put the states of ${ownerName} into a region ('region:' line) to add a policy region.`)
                        phase = 2
                        ;(owner.policies ??= []).push(this.parsePolicyRegion())
                        break
                    }
                    case 'transition': {
                        // A transition with no state in front of it (or after a region).
                        this.report(new Failure(this.pos, 'This transition does not follow a state',
                            'Transitions are written directly below the state they leave, after its body: `state A ... if x go to B`.'))
                        this.parseTransition(owner)
                        break
                    }
                    case 'dangling':
                        this.failDangling()
                    default:
                        this.failUnexpectedInBody(ownerName, phase)
                }
            } catch (e) {
                this.recoverInBody(e, itemStart)
            }
        }
    }

    /** Annotations or a doc comment with nothing after them before the closing brace. */
    private failDangling(): never {
        if (this.at('COMMENT_ANNOTATION')) {
            this.fail('A /** doc comment */ must be followed by the element it describes', 'Doc comments belong directly in front of a state, region, transition, declaration or action. Use `/* ... */` or `//` for other comments.')
        }
        this.fail('An annotation must be followed by the element it belongs to', 'Write the annotation directly in front of a state, region, transition, declaration or action.')
    }

    private spanOfNodes(nodes: { span: Span }[]): Span {
        const a = nodes[0].span
        const b = nodes[nodes.length - 1].span
        return { start: a.start, end: b.end, line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol }
    }

    /** What the next item in a scope body is, from fixed lookahead (past annotations and modifiers). */
    private classifyBodyItem(where: 'root' | 'state' | 'region'): 'declaration' | 'action' | 'state' | 'region' | 'policy' | 'transition' | 'dangling' | 'unknown' {
        let i = this.pos
        if (this.isAnnotationStart()) {
            const after = this.scan(() => this.parseAnnotations('full'))
            if (after < 0) {
                // Malformed annotation: let the state parser report it.
                return 'state'
            }
            i = after
        }
        const k = this.kindAt(i)
        const k1 = this.kindAt(i + 1)
        if (ACTION_KEYWORDS.has(k) || k === 'weak' || k === 'strong') return 'action'
        if (DELAYS.has(k)) return k1 === 'during' || k1 === 'suspend' || k1 === 'period' || k1 === 'weak' ? 'action' : 'transition'
        if (k === 'override') return k1 === 'method' ? 'declaration' : 'region'
        if (k === 'region' || k === 'dataflow') return 'region'
        if (k === 'abort') return k1 === 'to' ? 'transition' : 'region'
        if (k === 'final') {
            let j = i + 1
            while (['violation', 'connector'].includes(this.kindAt(j))) j++
            return this.kindAt(j) === 'region' || this.kindAt(j) === 'dataflow' ? 'region' : 'state'
        }
        if (k === 'state' || k === 'initial' || k === 'violation' || k === 'connector') return 'state'
        if (k === 'policy') return 'policy'
        if (DECLARATION_STARTS.has(k)) return 'declaration'
        if (k === 'if' || k === 'do' || k === 'go' || k === 'join') return 'transition'
        if (i !== this.pos && (k === '}' || k === 'EOF')) return 'dangling'
        if (i !== this.pos) return 'state' // annotations followed by something odd: report it as a state
        return 'unknown'
    }

    private failUnexpectedInBody(ownerName: string, phase: number): never {
        const t = this.la()
        switch (t.kind) {
            case ';':
                this.fail(`Unexpected ';' in ${ownerName}`, 'SCTX does not end declarations, states or transitions with semicolons. A semicolon only separates the effects of one transition or action: `do x = 1; y = 2`.')
            case '--':
            case '->':
                this.fail(`Unexpected '${t.kind}' in ${ownerName}`, 'SCTX writes transitions as words: `go to Target` (weak abort), `abort to Target` (strong abort), `join to Target` (termination). The `-->` arrow is the old SCT syntax.')
            case 'SL_COMMENT_ANNOTATION':
                this.fail(`A //* comment is not allowed here`, "`//*` starts a comment annotation, which SCTX only accepts at the end of a declaration line. Write `// *` (with a space) or `/* ... */` for an ordinary comment.")
            case 'COMMENT_ANNOTATION':
                this.fail(`A /** doc comment */ must be followed by the element it describes`, 'Doc comments belong directly in front of a state, region, transition, declaration or action. Use `/* ... */` or `//` for other comments.')
            case 'ID': {
                const s = suggestKeyword(t.text)
                if (s) this.fail(`Unknown word '${t.text}' in ${ownerName}: did you mean '${s}'?`)
                if (this.kind(1) === '=' || this.kind(1) === '++' || ASSIGN_OPS.has(this.kind(1))) {
                    this.fail(`An assignment cannot stand on its own in ${ownerName}`, 'Effects belong to a transition or an action: `entry do x = 1`, or `if A do x = 1 go to B`.')
                }
                this.fail(`Unexpected name '${t.text}' in ${ownerName}`,
                    phase === 0 ? 'Declarations start with their type, as in `input bool A` or `int counter = 0`.' : 'Expected a state (`state Name`), a region, a transition or the closing `}`.')
            }
            case 'to':
                this.fail(`Unexpected 'to' in ${ownerName}`, "Transitions start with `go to`, `abort to` or `join to`.")
            case 'scchart':
                this.fail(`Unexpected 'scchart' inside ${ownerName}`, 'Charts cannot be nested. Is a closing } missing above?')
            case '{':
                this.fail(`Unexpected '{' in ${ownerName}`, 'A { opens the body of a state or region: state Name { ... } or region Name { ... }.')
            default:
                this.fail(`Unexpected ${describeUnexpected(t)} in ${ownerName}`, 'Expected a declaration, an action, a state, a region, a transition or the closing }.')
        }
    }

    /** After a failed item in a body: report and skip to the next plausible item at this brace depth. */
    private recoverInBody(e: unknown, itemStart: number) {
        if (!(e instanceof Failure)) throw e
        this.report(e)
        if (this.pos === itemStart && !this.at('EOF') && !this.at('}')) this.next()
        this.skipToSync()
    }

    private static readonly SYNC = new Set<string>([
        'state', 'initial', 'final', 'connector', 'violation', 'region', 'dataflow', 'if', 'go', 'join', 'do', 'immediate',
        'delayed', 'auto', 'entry', 'during', 'exit', 'suspend', 'period', 'input', 'output', 'signal', 'bool', 'int', 'float',
        'string', 'const', 'ref', 'extern', 'host', 'clock', 'scchart', 'COMMENT_ANNOTATION', '@', 'override', 'method', 'weak',
    ])

    private skipToSync() {
        let depth = 0
        while (!this.at('EOF')) {
            const k = this.kind()
            if (depth === 0) {
                if (k === '}') return
                if (Parser.SYNC.has(k)) {
                    // 'abort to' is a transition, 'abort region' a region; 'final' is a state or a region.
                    return
                }
                if (k === 'abort' && (this.kind(1) === 'to' || this.kind(1) === 'region')) return
            }
            if (k === '{') depth++
            else if (k === '}') depth--
            this.next()
        }
    }

    // ----- states -----

    private parseState(): State {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        const flags = { initial: false, final: false, violation: false, connector: false }
        // KIELER: the modifiers must be in exactly this order: initial final violation connector.
        let order = 0
        while (STATE_MODIFIERS.includes(this.kind() as typeof STATE_MODIFIERS[number])) {
            const k = this.kind() as typeof STATE_MODIFIERS[number]
            const index = STATE_MODIFIERS.indexOf(k)
            if (flags[k]) this.fail(`'${k}' is written twice`)
            if (index < order) {
                this.fail(`Write '${k}' before '${STATE_MODIFIERS[order - 1]}'`, 'State modifiers must appear in the order initial final violation connector, as in initial final state Done.')
            }
            order = index + 1
            flags[k] = true
            this.next()
        }
        if (!this.at('state')) {
            const t = this.la()
            if (t.kind === 'ID') {
                const s = suggestKeyword(t.text, ['state', 'region'])
                if (s) this.fail(`Unknown word '${t.text}': did you mean '${s}'?`)
            }
            this.fail(`Expected 'state' but found ${describeToken(t)}`, order > 0 ? `After '${STATE_MODIFIERS[order - 1]}' comes the keyword \`state\`, as in \`initial state Idle\`.` : undefined)
        }
        this.next()
        const nameTok = this.la()
        if (nameTok.kind !== 'ID') {
            if (KEYWORDS.has(nameTok.kind) && /^[a-z]/.test(nameTok.kind)) {
                this.fail(`'${nameTok.kind}' is a keyword and cannot be used as a state name`, `Choose another name, or write \`^${nameTok.kind}\` to use the keyword as a name.`)
            }
            this.fail(`Expected the state's name after 'state' but found ${describeToken(nameTok)}`, 'States are written `state Name`, for example `initial state Idle`.')
        }
        this.next()
        const state = this.newState(start, idValue(nameTok.text), this.tokSpan(nameTok), pending, false)
        Object.assign(state, flags)
        if (this.at('STRING')) state.label = stringValue(this.next().text)
        if (this.at('is')) {
            this.next()
            state.reference = this.parseScopeCall()
            this.parseOptionalSchedule()
        } else if (this.at('calls')) {
            this.next()
            state.reference = this.parseModuleScopeCall()
            state.callsReference = true
            this.parseOptionalSchedule()
        } else {
            let needsBody = false
            if (this.accept('extends')) {
                state.baseStates = [this.parseBaseStateReference()]
                while (this.accept(',')) state.baseStates.push(this.parseBaseStateReference())
                needsBody = true
            }
            if (this.parseOptionalSchedule()) needsBody = true
            if (this.at('{')) {
                const open = this.pos
                this.next()
                this.nested(() => this.parseScopeBody(state, 'state', open), 250)
            } else if (needsBody) {
                this.fail(`Expected '{' to start the body of state ${state.name} but found ${describeToken(this.la())}`)
            }
        }
        state.span = this.span(start)
        // Outgoing transitions, in priority order.
        while (this.isTransitionStart()) {
            const tStart = this.pos
            try {
                state.transitions.push(this.parseTransition(state))
            } catch (e) {
                if (!(e instanceof Failure)) throw e
                this.report(e)
                if (this.pos === tStart) this.next()
                this.skipToSync()
            }
        }
        return state
    }

    private isTransitionStart(): boolean {
        let i = this.pos
        if (this.isAnnotationStart()) {
            const after = this.scan(() => this.parseAnnotations('restricted'))
            if (after < 0) return false
            i = after
        }
        const k = this.kindAt(i)
        const k1 = this.kindAt(i + 1)
        if (DELAYS.has(k)) return !(k1 === 'during' || k1 === 'suspend' || k1 === 'period' || k1 === 'weak')
        if (k === 'if' || k === 'do' || k === 'go' || k === 'join') return true
        if (k === 'abort') return k1 === 'to'
        return false
    }

    private parseOptionalSchedule(): boolean {
        if (!this.at('schedule')) return false
        // KIELER's lookahead only enters the clause when a schedule reference (name ... number) follows; otherwise the
        // 'schedule' starts the next element (a schedule declaration).
        if (this.scan(() => { this.next(); this.parseScheduleObjectReference() }) < 0) {
            if (this.isScheduleDeclarationNext()) return false
        }
        this.next()
        this.parseScheduleObjectReference()
        while (this.at('ID')) {
            const r = this.attempt(() => this.parseScheduleObjectReference())
            if (r instanceof Failure) break
        }
        return true
    }

    private isScheduleDeclarationNext(): boolean {
        return this.scan(() => this.parseScheduleDeclaration(this.pos, { annotations: [] }, false)) >= 0
    }

    /** ScheduleObjectReference: PrimeID ('.' VOR)? INT ('annotated(' QuotedStringAnnotation+ ')')? */
    private parseScheduleObjectReference() {
        this.parsePrimeID()
        if (this.accept('.')) this.parseValuedObjectReference()
        this.expect('INT', `Expected the schedule priority (a number) but found ${describeToken(this.la())}`)
        if (this.accept('annotated(')) {
            const a = this.parseAnnotations('quoted')
            if (!a.annotations.length) this.fail('Expected an annotation inside annotated( )')
            this.expect(')')
        }
    }

    private parseScopeCall(): ScopeCall {
        const start = this.pos
        const isSuper = !!this.accept('super.')
        const nameTok = this.expect('ID', `Expected the name of the referenced chart after 'is', as in state S is Other(x to y)`)
        const call: ScopeCall = { kind: 'scopeCall', target: idValue(nameTok.text), parameters: [], span: this.span(start), targetSpan: this.tokSpan(nameTok) }
        if (isSuper) call.super = true
        if (this.at('<')) call.genericParameters = this.parseGenericParameters()
        this.parseScopeParameters(call)
        call.span = this.span(start)
        return call
    }

    private parseModuleScopeCall(): ScopeCall {
        const start = this.pos
        const nameTok = this.expect('ID', `Expected the name of the called chart after 'calls'`)
        const call: ScopeCall = { kind: 'scopeCall', target: idValue(nameTok.text), parameters: [], span: this.span(start), targetSpan: this.tokSpan(nameTok) }
        this.parseScopeParameters(call)
        call.span = this.span(start)
        return call
    }

    /** (('(' ScopeParameter (',' ScopeParameter)* ')') | '()')? */
    private parseScopeParameters(call: { parameters: ScopeParameter[] }) {
        if (this.accept('()')) return
        if (!this.at('(')) return
        this.next()
        if (this.at(')')) this.fail("Write '()' without a space for an empty parameter list", 'KIELER only accepts an empty list written as `()`, without spaces.')
        call.parameters.push(this.parseScopeParameter())
        while (this.accept(',')) call.parameters.push(this.parseScopeParameter())
        this.expect(')', `Expected ',' or ')' in the parameter list but found ${describeToken(this.la())}`)
    }

    /** ScopeParameter: ((& | !&) VOR | this | Expression) ('to' ID ('[' Expression ']')*)? */
    private parseScopeParameter(): ScopeParameter {
        const start = this.pos
        let p: ScopeParameter
        if (this.at('&') || this.at('!&')) {
            const access = this.next().kind
            const ref = this.parseValuedObjectReference()
            p = { expression: ref, span: this.span(start) }
            if (access === '&') p.byReference = true
            else p.pureOutput = true
        } else if (this.at('this')) {
            const t = this.next()
            p = { expression: { kind: 'this', span: this.tokSpan(t) }, span: this.span(start) }
        } else {
            p = { expression: this.parseExpression(), span: this.span(start) }
        }
        if (this.accept('to')) {
            const b = this.expect('ID', `Expected the name of the referenced chart's variable after 'to'`)
            p.binding = idValue(b.text)
            p.bindingSpan = this.tokSpan(b)
            while (this.at('[')) {
                this.next()
                ;(p.bindingIndices ??= []).push(this.parseExpression())
                this.expect(']')
            }
        }
        p.span = this.span(start)
        return p
    }

    // ----- transitions -----

    private parseTransition(source: State): Transition {
        const start = this.pos
        const pending = this.parseAnnotations('restricted')
        const t: Transition = {
            kind: 'transition', id: '', source: '', targetName: '', targetSpan: this.tokSpan(this.la()), priority: source.transitions.length + 1,
            preemption: 'weak', effects: [], annotations: pending.annotations, span: this.span(start),
        }
        if (pending.doc !== undefined) t.doc = pending.doc
        if (this.atAny(DELAYS)) t.delay = this.next().kind as DelayType
        if (this.at('if')) {
            this.next()
            // KIELER: a number right after 'if' is always the count delay (if 3 A: the third tick in which A holds).
            if (this.at('INT')) {
                const n = this.next()
                t.triggerDelay = this.intValue(n)
            }
            if (this.atAny(['do', 'go', 'abort', 'join'])) {
                if (t.triggerDelay !== undefined) {
                    this.fail(`A number right after 'if' is a count delay and needs a trigger after it`,
                        `KIELER reads 'if ${t.triggerDelay}' as "the ${t.triggerDelay}. time ..." and expects a condition next, as in \`if ${t.triggerDelay} A\`. To compare a number, put the variable first: \`if x == ${t.triggerDelay}\`.`)
                }
                this.fail(`Expected a trigger condition after 'if' but found ${describeToken(this.la())}`, 'For example `if A go to B`, or `if x > 3 go to B`. Leave out the `if` for a transition that always fires.')
            }
            t.trigger = this.parseBoolScheduleExpression(t.triggerDelay !== undefined
                ? `KIELER reads a number right after 'if' as a count delay, so 'if ${t.triggerDelay} ...' needs a condition after the number. To compare a number, put the variable first: \`if x == ${t.triggerDelay}\`.`
                : undefined)
            if (this.at('Pr=')) {
                this.next()
                t.probability = this.floatValue(this.expect('FLOAT', `Expected a probability such as 0.5 after 'Pr='`))
            }
            if (this.accept('nondeterministic')) t.nondeterministic = true
        }
        if (this.at('do')) {
            this.next()
            t.effects.push(this.parseEffect())
            while (this.at(';')) {
                this.next()
                if (this.atAny(['go', 'abort', 'join'])) {
                    this.fail(`Unexpected ';' before '${this.kind()}'`, "A semicolon separates two effects. Remove the last one: `do x = 1 go to B`.", this.pos - 1)
                }
                t.effects.push(this.parseEffect())
            }
        }
        const pre = this.la()
        if (pre.kind === 'go' || pre.kind === 'abort' || pre.kind === 'join') {
            this.next()
            t.preemption = pre.kind === 'go' ? 'weak' : pre.kind === 'abort' ? 'strong' : 'termination'
        } else {
            this.failMissingPreemption(t)
        }
        this.expectOrInsert('to', this.at('ID'), `Expected 'to' after '${pre.kind}'`, `Transitions are written \`${pre.kind} to Target\`, for example \`${pre.kind} to Done\`.`)
        const target = this.la()
        if (target.kind !== 'ID') {
            if (STRUCTURAL.has(target.kind)) {
                this.fail(`Expected the name of the target state after 'to' but found ${describeToken(target)}`, `The transition is incomplete: write the state it leads to, as in \`${pre.kind} to Done\`.`)
            }
            if (KEYWORDS.has(target.kind) && /^[a-z]/.test(target.kind)) {
                this.fail(`'${target.kind}' is a keyword and cannot be the name of a target state`, `Write the name of the state the transition goes to, as in \`${pre.kind} to Done\`.`)
            }
            this.fail(`Expected the name of the target state after 'to' but found ${describeToken(target)}`, `Write the state the transition leads to, as in ${pre.kind} to Done.`)
        }
        this.next()
        t.targetName = idValue(target.text)
        t.targetSpan = this.tokSpan(target)
        if (this.at('deferred')) { this.next(); t.deferred = 'shallow' }
        else if (this.at('deep deferred')) { this.next(); t.deferred = 'deep' }
        if (this.at('reset')) { this.next(); t.history = 'reset' }
        else if (this.at('shallow history')) { this.next(); t.history = 'shallow' }
        else if (this.at('history')) { this.next(); t.history = 'deep' }
        if (this.accept('label')) t.label = stringValue(this.expect('STRING', `Expected a quoted label after 'label', as in label "Say hello"`).text)
        t.span = this.span(start)
        return t
    }

    private failMissingPreemption(t: Transition): never {
        const k = this.la()
        if (k.kind === 'to') this.fail(`Expected 'go to', 'abort to' or 'join to' but found 'to' alone`, "Write `go to Target`: the word `go` (or `abort`, `join`) is missing.")
        if (k.kind === 'ID' && /^go?$|^goto$/i.test(k.text)) this.fail(`Unknown word '${k.text}': transitions are written 'go to Target'`)
        if (k.kind === 'goto') this.fail(`Write 'go to' as two words`, "Transitions are written `go to Target` (`goto` is an SCL statement).", this.pos, "no viable alternative at input 'goto'")
        if (k.kind === 'ID' && t.trigger) {
            this.fail(`Unexpected name '${k.text}' after the trigger`, "The trigger ends here. Combine conditions with `&&` or `||`, add effects with `do`, and finish with `go to Target`.")
        }
        if (k.kind === ';') this.fail(`Unexpected ';'`, "Transitions do not end with a semicolon. A semicolon only separates two effects: `do x = 1; y = 2 go to B`.")
        if (k.kind === '=' && t.trigger) this.fail(`'=' assigns; use '==' to compare`, 'In a trigger, write `if x == 3 go to B`. A single `=` is only for effects (`do x = 3`).')
        if (k.kind === '?' || k.kind === ':') this.fail(`Unexpected '${k.kind}'`, 'The parts of a conditional c ? a : b must be single values; put parentheses around nested or computed parts: a ? (b ? 1 : 2) : 3.')
        if (k.kind === 'if' && t.effects.length) this.fail(`The trigger must come before 'do'`, 'Transitions are written `if Trigger do Effects go to Target`.')
        if (k.kind === 'do' && t.effects.length) this.fail(`A transition has only one 'do'`, 'Separate several effects with semicolons: `do x = 1; y = 2 go to B`.')
        this.fail(`Expected 'go to', 'abort to' or 'join to' to finish the transition but found ${describeToken(k)}`,
            t.trigger || t.effects.length ? 'A transition ends with `go to Target` (weak abort), `abort to Target` (strong abort) or `join to Target` (termination).' : undefined)
    }

    /** INT value (the lexer reports numbers above 2^31 - 1, which KIELER's Integer.valueOf rejects). */
    private intValue(t: Token): number { return Number(t.text) }
    private floatValue(t: Token): number { return Number(t.text.replace(/f$/, '')) }

    // ----- regions -----

    private parseRegion(): Region {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        let isAbort = false
        let isOverride = false
        let isFinal = false
        if (this.at('abort')) { this.next(); isAbort = true }
        else {
            if (this.accept('override')) isOverride = true
            if (this.at('final') && this.kind(1) === 'region') { this.next(); isFinal = true }
        }
        if (this.at('dataflow')) {
            if (isAbort || isFinal) this.fail(`A dataflow region cannot be '${isAbort ? 'abort' : 'final'}'`)
            return this.parseDataflowRegion(start, pending, isOverride)
        }
        this.expect('region', `Expected 'region' but found ${describeToken(this.la())}`)
        const region: Region = {
            kind: 'region', id: '', regionType: 'controlflow', implicit: false, annotations: pending.annotations,
            declarations: [], actions: [], states: [], equations: [], span: this.span(start),
        }
        if (pending.doc !== undefined) region.doc = pending.doc
        if (isAbort) region.abort = true
        if (isOverride) region.override = true
        if (isFinal) region.final = true
        if (this.at('ID')) {
            const at = this.pos
            region.name = this.parseExtendedID()
            region.nameSpan = this.span(at)
        }
        if (this.at('STRING')) region.label = stringValue(this.next().text)
        if (this.at('is')) {
            this.next()
            region.reference = this.parseScopeCall()
            if (this.at('for')) region.forLoop = this.parseForLoop()
            this.parseOptionalSchedule()
            region.span = this.span(start)
            return region
        }
        if (this.at('for')) region.forLoop = this.parseForLoop()
        this.parseOptionalSchedule()
        if (this.at('{')) {
            const open = this.pos
            this.next()
            this.parseRegionBody(region, 'brace', open)
        } else if (this.at(':')) {
            const open = this.pos
            this.next()
            this.parseRegionBody(region, 'colon', open)
        } else {
            this.fail(`Expected '{' or ':' after the region header but found ${describeToken(this.la())}`,
                "A region is written region Name { states } or region Name: followed by its states.")
        }
        region.span = this.span(start)
        return region
    }

    /** for counter : start (to end)? */
    private parseForLoop(): NonNullable<Region['forLoop']> {
        const start = this.pos
        this.expect('for')
        const variable = this.parsePrimeID()
        this.expect(':', `Expected ':' after the counter variable, as in for i : 0 to 3`)
        const from = this.parseIntOrReference()
        const loop: NonNullable<Region['forLoop']> = { variable, from, span: this.span(start) }
        if (this.accept('to')) loop.to = this.parseIntOrReference()
        loop.span = this.span(start)
        return loop
    }

    private parseIntOrReference(): Expression {
        if (this.at('INT')) {
            const t = this.next()
            return { kind: 'int', value: this.intValue(t), span: this.tokSpan(t) }
        }
        if (this.at('ID')) return this.parseValuedObjectReference()
        this.fail(`Expected a number or a constant here but found ${describeToken(this.la())}`, 'The range of a for region is written for i : 0 to 3, or for i : ARRAY to loop over an array.')
    }

    /**
     * Body of a control-flow region. Brace form: declarations* actions* (ImplicitState | State+) '}'.
     * Colon form: declarations* actions* State* (ends at the next region or the closing brace of the parent).
     */
    private parseRegionBody(region: Region, form: 'brace' | 'colon', open: number) {
        let phase = 0
        const name = region.name ? `region ${region.name}` : 'this region'
        let innerRegions: Region[] | undefined
        for (;;) {
            if (form === 'brace' && this.at('}')) {
                this.closeBrace(open, name)
                if (!region.states.length && !innerRegions) {
                    this.report(new Failure(this.pos - 1, `${region.name ? `Region ${region.name}` : 'This region'} has no states`,
                        "A region in braces needs at least one state. Add one, such as `initial state Start`, or delete the empty region."))
                }
                return
            }
            if (this.at('EOF')) {
                if (form === 'brace') this.report(new Failure(this.pos, `The ${name} is missing its closing '}'`, this.missingBraceHint(name, open)))
                return
            }
            if (form === 'colon' && this.at('}')) return
            const itemStart = this.pos
            const item = this.classifyBodyItem('region')
            if (form === 'colon' && (item === 'region' || item === 'policy')) return
            try {
                switch (item) {
                    case 'declaration':
                        if (phase > 0) this.report(new Failure(this.pos, 'Declarations must come first in a region', `In ${name}, write the declarations first, then the actions, then the states.`))
                        region.declarations.push(...this.parseDeclaration())
                        break
                    case 'action':
                        if (phase > 1) this.report(new Failure(this.pos, 'Actions must come before the states of a region', `In ${name}, write the declarations first, then the actions, then the states.`))
                        phase = Math.max(phase, 1)
                        region.actions.push(this.parseLocalAction())
                        break
                    case 'state':
                        phase = 2
                        if (innerRegions) this.report(new Failure(this.pos, 'States cannot follow inner regions here'))
                        region.states.push(this.parseState())
                        break
                    case 'region': {
                        // Brace form only: `region R { region A: ... region B: ... }` is a region with one implicit
                        // state that holds the inner regions (ImplicitState).
                        phase = 2
                        if (region.states.length && !innerRegions) this.report(new Failure(this.pos, 'A region cannot mix states and inner regions'))
                        if (!innerRegions) {
                            innerRegions = []
                            const holder: State = {
                                kind: 'state', id: '', name: '', isRoot: false, initial: true, final: false, connector: false, violation: false,
                                annotations: [], declarations: [], actions: [], regions: innerRegions, transitions: [],
                                nameSpan: this.tokSpan(this.la()), span: this.tokSpan(this.la()),
                            }
                            ;(holder as State & { implicit?: boolean }).implicit = true
                            region.states.push(holder)
                        }
                        innerRegions.push(this.parseRegion())
                        const holder = region.states[region.states.length - 1]
                        holder.span = this.spanOfNodes(innerRegions)
                        holder.nameSpan = holder.span
                        break
                    }
                    case 'transition':
                        this.report(new Failure(this.pos, 'This transition does not follow a state',
                            'Transitions are written directly below the state they leave: `state A ... if x go to B`.'))
                        this.parseTransition(region.states[region.states.length - 1] ?? this.dummyState())
                        break
                    case 'dangling':
                        this.failDangling()
                    default:
                        this.failUnexpectedInBody(name, phase)
                }
            } catch (e) {
                this.recoverInBody(e, itemStart)
            }
        }
    }

    private dummyState(): State {
        return {
            kind: 'state', id: '', name: '', isRoot: false, initial: false, final: false, connector: false, violation: false, annotations: [],
            declarations: [], actions: [], regions: [], transitions: [], nameSpan: this.tokSpan(this.la()), span: this.tokSpan(this.la()),
        }
    }

    private parseDataflowRegion(start: number, pending: PendingAnnotations, isOverride: boolean): Region {
        this.expect('dataflow')
        const region: Region = {
            kind: 'region', id: '', regionType: 'dataflow', implicit: false, annotations: pending.annotations,
            declarations: [], actions: [], states: [], equations: [], span: this.span(start),
        }
        if (pending.doc !== undefined) region.doc = pending.doc
        if (isOverride) region.override = true
        if (this.at('ID')) {
            const at = this.pos
            region.name = this.parseExtendedID()
            region.nameSpan = this.span(at)
        }
        if (this.at('STRING')) region.label = stringValue(this.next().text)
        if (this.at('for')) region.forLoop = this.parseForLoop()
        this.parseOptionalSchedule()
        if (this.accept('once')) region.once = true
        let form: 'brace' | 'colon'
        const open = this.pos
        if (this.accept('{')) form = 'brace'
        else if (this.accept(':')) form = 'colon'
        else this.fail(`Expected '{' or ':' after the dataflow header but found ${describeToken(this.la())}`, 'A dataflow region is written dataflow { O = A && B } or dataflow: followed by equations.')
        // Declarations (DeclarationWOSemicolon only) then equations.
        let equations = false
        for (;;) {
            if (form === 'brace' && this.at('}')) { this.next(); break }
            if (this.at('EOF')) {
                if (form === 'brace') this.report(new Failure(this.pos, `The dataflow region is missing its closing '}'`, `Add '}' at the end of the region (opened on line ${this.lines.position(this.toks[open].start).line}).`))
                break
            }
            if (form === 'colon' && this.at('}')) break
            const itemStart = this.pos
            const item = this.classifyDataflowItem()
            if (item === 'end') {
                if (form === 'colon') break
            }
            try {
                if (item === 'declaration') {
                    if (equations) this.report(new Failure(this.pos, 'Declarations must come before the equations of a dataflow region'))
                    region.declarations.push(...this.parseDeclaration(true))
                } else if (item === 'equation') {
                    equations = true
                    region.equations.push(this.parseEquation())
                } else {
                    this.fail(`Unexpected ${describeUnexpected(this.la())} in the dataflow region`, 'A dataflow region holds equations such as O = A && B, one per line.')
                }
            } catch (e) {
                if (!(e instanceof Failure)) throw e
                this.report(e)
                if (this.pos === itemStart) this.next()
                // Skip to the next line that looks like an equation start or the end.
                this.skipToSync()
                if (form === 'colon' && this.classifyDataflowItem() !== 'equation' && this.classifyDataflowItem() !== 'declaration') break
            }
        }
        region.span = this.span(start)
        return region
    }

    private classifyDataflowItem(): 'declaration' | 'equation' | 'end' {
        let i = this.pos
        if (this.isAnnotationStart()) {
            const after = this.scan(() => this.parseAnnotations('full'))
            if (after >= 0) i = after
        }
        const k = this.kindAt(i)
        if (k === 'ID' || k === 'super.') return 'equation'
        if (DECLARATION_STARTS.has(k) && k !== 'method' && k !== 'enum' && k !== 'primitive') return 'declaration'
        return 'end'
    }

    /** Equations: DataflowAssignment | Assignment | DataflowReferenceCall */
    private parseEquation(): Equation {
        const start = this.pos
        const tryAssignment = (demote: boolean) => this.attempt(() => {
            const pending = this.parseAnnotations('full', demote)
            const target = this.parseValuedObjectReference()
            if (!ASSIGN_OPS.has(this.kind())) this.fail(`Expected '=' in the equation but found ${describeToken(this.la())}`, 'Equations are written Output = expression, for example O = A && B.')
            const operator = this.next().kind as AssignOperator
            const expression = this.parseExpression()
            this.parseOptionalSchedule()
            const eq: Equation = { kind: 'equation', target, operator, expression, span: this.span(start) }
            if (this.at(';') || this.at('seq')) { this.next(); eq.sequential = true }
            if (pending.annotations.length) eq.annotations = pending.annotations
            eq.span = this.span(start)
            return eq
        })
        const first = tryAssignment(false)
        if (!(first instanceof Failure)) return first
        const demoted = this.isAnnotationStart() ? tryAssignment(true) : first
        if (!(demoted instanceof Failure)) return demoted
        // DataflowReferenceCall: super.? PrimeID [i]* (.VOR)? ( '(' params ')' | '()' ) ('=' Expression)? schedule? (';'|'seq')?
        const call = this.attempt(() => {
            const pending = this.parseAnnotations('full')
            const isSuper = !!this.accept('super.')
            const target = this.parseValuedObjectReference()
            const args: Expression[] = []
            const access: ParamAccess[] = []
            this.parseCallArguments(args, access)
            const callExpr: Expression = { kind: 'call', name: referenceName(target), args, target, span: this.span(start) }
            if (isSuper) callExpr.super = true
            if (access.some(a => a !== null)) callExpr.paramAccess = access
            const eq: Equation = { kind: 'equation', target, operator: '=', expression: callExpr, callArgs: args, span: this.span(start) }
            if (this.accept('=')) eq.expression = this.parseExpression()
            this.parseOptionalSchedule()
            if (this.at(';') || this.at('seq')) { this.next(); eq.sequential = true }
            if (pending.annotations.length) eq.annotations = pending.annotations
            eq.span = this.span(start)
            return eq
        })
        if (!(call instanceof Failure)) return call
        throw this.furthestOf(first, demoted, call)
    }

    private furthestOf(...failures: Failure[]): Failure {
        return failures.reduce((a, b) => (b.at > a.at ? b : a))
    }

    /** PolicyRegion: 'policy' ID STRING? '{' DeclarationWOSemicolon* PolicyState+ '}' */
    private parsePolicyRegion(): Region {
        const start = this.pos
        this.expect('policy')
        const nameStart = this.pos
        const name = idValue(this.expect('ID', `Expected the policy's name after 'policy'`).text)
        const region: Region = {
            kind: 'region', id: '', regionType: 'controlflow', implicit: false, policy: true, name, nameSpan: this.span(nameStart),
            annotations: [], declarations: [], actions: [], states: [], equations: [], span: this.span(start),
        }
        if (this.at('STRING')) region.label = stringValue(this.next().text)
        this.expect('{', `Expected '{' to start the policy region`)
        while (this.classifyBodyItem('state') === 'declaration') region.declarations.push(...this.parseDeclaration(true))
        if (!this.isPolicyStateStart()) this.fail(`Expected a state in the policy region but found ${describeToken(this.la())}`)
        while (this.isPolicyStateStart()) region.states.push(this.parsePolicyState())
        this.expect('}', `Expected '}' to close the policy region but found ${describeToken(this.la())}`)
        region.span = this.span(start)
        return region
    }

    private isPolicyStateStart(): boolean {
        const after = this.isAnnotationStart() ? this.scan(() => this.parseAnnotations('full')) : this.pos
        if (after < 0) return false
        const k = this.kindAt(after)
        return k === 'state' || (k === 'initial' && this.kindAt(after + 1) === 'state')
    }

    /** PolicyState: Annotation* 'initial'? 'state' ID STRING? PolicyTransition* */
    private parsePolicyState(): State {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        const initial = !!this.accept('initial')
        this.expect('state')
        const nameTok = this.expect('ID', `Expected the state's name after 'state'`)
        const state = this.newState(start, idValue(nameTok.text), this.tokSpan(nameTok), pending, false)
        state.initial = initial
        if (this.at('STRING')) state.label = stringValue(this.next().text)
        state.span = this.span(start)
        // PolicyTransition: RTA* ('if' (LogicalOr | VOR) (':' PureEmission (',' PureEmission)*)?)? 'go' 'to' ID ('label' STRING)?
        for (;;) {
            const after = this.isAnnotationStart() ? this.scan(() => this.parseAnnotations('restricted')) : this.pos
            if (after < 0) break
            const k = this.kindAt(after)
            if (k !== 'if' && k !== 'go') break
            const tStart = this.pos
            const tp = this.parseAnnotations('restricted')
            const t: Transition = {
                kind: 'transition', id: '', source: '', targetName: '', targetSpan: this.tokSpan(this.la()), priority: state.transitions.length + 1,
                preemption: 'weak', effects: [], annotations: tp.annotations, span: this.span(tStart),
            }
            if (tp.doc !== undefined) t.doc = tp.doc
            if (this.accept('if')) {
                t.trigger = this.parseLogicalOr()
                if (this.accept(':')) {
                    t.effects.push(this.parsePureEmission())
                    while (this.accept(',')) t.effects.push(this.parsePureEmission())
                }
            }
            this.expect('go', `Expected 'go to' in the policy transition`)
            this.expect('to')
            const target = this.expect('ID', `Expected the name of the target state after 'to'`)
            t.targetName = idValue(target.text)
            t.targetSpan = this.tokSpan(target)
            if (this.accept('label')) t.label = stringValue(this.expect('STRING').text)
            t.span = this.span(tStart)
            state.transitions.push(t)
        }
        return state
    }

    private parsePureEmission(): Effect {
        const start = this.pos
        const pending = this.parseAnnotations('quoted')
        const target = this.parseValuedObjectReference()
        this.parseOptionalSchedule()
        const e: Effect = { kind: 'emit', target, span: this.span(start) }
        if (pending.annotations.length) e.annotations = pending.annotations
        return e
    }

    // ----- local actions -----

    private parseLocalAction(): LocalAction {
        const start = this.pos
        const pending = this.parseAnnotations('restricted')
        let delay: DelayType | undefined
        let preemption: 'weak' | 'strong' | undefined
        let weak = false
        if (this.atAny(DELAYS)) delay = this.next().kind as DelayType
        if (delay === undefined && (this.at('weak') || this.at('strong')) && (this.kind(1) === 'entry' || this.kind(1) === 'exit')) {
            preemption = this.next().kind as 'weak' | 'strong'
        } else if (this.at('weak') && this.kind(1) === 'suspend') {
            this.next()
            weak = true
        }
        const kwTok = this.la()
        if (!ACTION_KEYWORDS.has(kwTok.kind)) {
            if (kwTok.kind === 'weak' || kwTok.kind === 'strong') this.fail(`'${kwTok.kind}' must be followed by ${kwTok.kind === 'weak' ? "'entry', 'exit' or 'suspend'" : "'entry' or 'exit'"}`)
            this.fail(`Expected 'entry', 'during', 'exit', 'suspend', 'period' or 'ode' but found ${describeToken(kwTok)}`)
        }
        const kind = kwTok.kind as LocalActionKind
        this.next()
        if (delay !== undefined && (kind === 'entry' || kind === 'exit' || kind === 'ode')) {
            this.fail(`'${delay}' cannot be used with '${kind}'`, `Only \`during\`, \`suspend\` and \`period\` actions take a delay keyword: \`immediate during do ...\``, start)
        }
        if (preemption && kind !== 'entry' && kind !== 'exit') this.fail(`'${preemption}' cannot be used with '${kind}'`)
        if (weak && kind !== 'suspend') this.fail(`'weak' cannot be used with '${kind}'`)
        const action: LocalAction = { kind, id: '', effects: [], annotations: pending.annotations, span: this.span(start) }
        if (pending.doc !== undefined) action.doc = pending.doc
        if (delay !== undefined) action.delay = delay
        if (preemption) action.preemption = preemption
        if (weak) action.weak = true
        if (kind === 'period') {
            action.trigger = this.parseValued()
        } else if (kind === 'ode') {
            action.effects.push(this.parseEffect())
        } else {
            if (this.at('if')) {
                this.next()
                if ((kind === 'during' || kind === 'suspend') && this.at('INT')) action.triggerDelay = this.intValue(this.next())
                if (this.atAny(['do', 'label']) || this.at('}') || this.at('EOF')) this.fail(`Expected a condition after 'if' but found ${describeToken(this.la())}`)
                action.trigger = this.parseBoolScheduleExpression()
                if (kind === 'entry' || kind === 'exit') {
                    if (this.at('Pr')) { this.next(); action.probability = this.floatValue(this.expect('FLOAT')) }
                } else if (this.at('Pr=')) {
                    this.next()
                    action.probability = this.floatValue(this.expect('FLOAT'))
                }
            }
            if (kind !== 'suspend' && this.at('do')) {
                this.next()
                action.effects.push(this.parseEffect())
                while (this.at(';')) {
                    this.next()
                    action.effects.push(this.parseEffect())
                }
            }
        }
        if (this.accept('label')) action.label = stringValue(this.expect('STRING', `Expected a quoted label after 'label'`).text)
        action.span = this.span(start)
        return action
    }

    // ----- declarations -----

    /**
     * DeclarationOrMethodWithKeywordWOSemicolon (and, with `inBlock`, the declarations of SCL code blocks and
     * method bodies, which may end with ';'). Returns one declaration.
     */
    private parseDeclaration(restricted = false, inBlock = false): Declaration[] {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        // Decide the declaration kind by looking past the access modifier and the input/output/const flags.
        let i = this.pos
        if (ACCESS.has(this.kindAt(i))) i++
        const k = this.kindAt(i)
        if (!restricted && (k === 'override' || k === 'method')) return [this.parseKeywordMethod(start, pending)]
        if (!restricted && k === 'enum') return [this.parseEnum(start, pending)]
        if (k === 'host') {
            const k1 = this.kindAt(i + 1)
            if (!restricted && k1 === 'enum') return [this.parseEnum(start, pending)]
            if (k1 === 'class' || k1 === 'struct') return [this.parseClass(start, pending, inBlock)]
        }
        if (k === 'class' || k === 'struct') return [this.parseClass(start, pending, inBlock)]
        if (k === 'schedule') return [this.parseScheduleDeclaration(start, pending, inBlock)]
        if (k === 'extern' || k === 'ref') return [this.parseReferenceDeclaration(start, pending, inBlock)]
        let j = i
        while (['input', 'output', 'const'].includes(this.kindAt(j))) j++
        if (this.kindAt(j) === 'ref') return [this.parseReferenceDeclaration(start, pending, inBlock)]
        if (!restricted && this.kindAt(j) === 'primitive') return [this.parsePrimitiveDeclaration(start, pending)]
        return [this.parseVariableDeclaration(start, pending, inBlock)]
    }

    private newDeclaration(start: number, pending: PendingAnnotations, declKind: Declaration['declKind']): Declaration {
        const d: Declaration = {
            kind: 'declaration', declKind, signal: false, input: false, output: false, const: false, global: false, static: false,
            annotations: pending.annotations, valuedObjects: [], span: this.span(start),
        }
        if (pending.doc !== undefined) d.doc = pending.doc
        return d
    }

    private parseAccess(d: Declaration) {
        if (this.atAny(ACCESS)) d.access = this.next().kind as Declaration['access']
    }

    /**
     * VariableDeclarationWOSemicolon: access? input? output? const? global? static? ((signal? ValueType) | signal | host STRING) VO (, VO)* //*?
     * In code blocks KIELER also accepts VariableDeclaration with ';', whose flags are ordered const input output.
     */
    private parseVariableDeclaration(start: number, pending: PendingAnnotations, inBlock: boolean): Declaration {
        if (inBlock) {
            // Code blocks try KExt's VariableDeclaration first: flags ordered const input output global static, and a
            // mandatory ';'. Then the SCTX form without ';'.
            const save = this.pos
            const withSemicolon = this.attempt(() => this.parseVariableDeclarationWith(start, pending, ['const', 'input', 'output', 'global', 'static'], true))
            if (!(withSemicolon instanceof Failure)) return withSemicolon
            this.pos = save
        }
        return this.parseVariableDeclarationWith(start, pending, ['input', 'output', 'const', 'global', 'static'], false)
    }

    /** `parameter`: in a method's parameter list, a ',' followed by a type starts the next parameter (ANTLR's lookahead). */
    private parseVariableDeclarationWith(start: number, pending: PendingAnnotations, order: readonly string[], semicolon: boolean, parameter = false): Declaration {
        const d = this.newDeclaration(start, pending, 'variable')
        this.parseAccess(d)
        let idx = 0
        for (;;) {
            const k = this.kind()
            const at = order.indexOf(k)
            if (at < 0) break
            if (at < idx) {
                this.fail(`Write '${k}' before '${order[idx - 1]}'`, `Declaration flags must appear in the order ${order.join(' ')}, as in \`output const int MAX = 3\`.`)
            }
            idx = at + 1
            ;(d as unknown as Record<string, boolean>)[k] = true
            this.next()
        }
        if (this.at('signal')) {
            this.next()
            d.signal = true
            if (this.atAny(VALUE_TYPES)) d.type = this.next().kind as ValueType
        } else if (this.atAny(VALUE_TYPES)) {
            d.type = this.next().kind as ValueType
        } else if (this.at('host')) {
            this.next()
            d.type = 'host'
            d.hostType = stringValue(this.expect('STRING', `Expected the host type in quotes after 'host', as in host "unsigned char" x`).text)
        } else {
            this.failMissingType()
        }
        d.valuedObjects.push(this.parseValuedObject())
        while (this.at(',') && !(parameter && this.startsParameter(this.pos + 1))) {
            this.next()
            d.valuedObjects.push(this.parseValuedObject())
        }
        if (semicolon) this.expect(';')
        else if (this.at(';') && this.spec === 0 && !this.inCodeBlock) {
            // KIELER rejects this; report it and skip the ';' so the declaration is kept.
            this.report(new Failure(this.pos, `Unexpected ';' after the declaration`, 'SCTX declarations do not end with a semicolon: write `input bool A`, not `input bool A;`.', undefined, "no viable alternative at input ';'"))
            this.next()
        }
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        return d
    }

    private failMissingType(): never {
        const t = this.la()
        if (t.kind === 'ID') {
            const s = suggestKeyword(t.text, ['bool', 'int', 'float', 'string', 'signal', 'pure', 'clock', 'input', 'output', 'const'])
            if (s) this.fail(`Unknown type '${t.text}': did you mean '${s}'?`, 'The types are bool, int, float, string, pure (signals only), clock and host "Type".')
            this.fail(`Expected a type before the name '${t.text}'`, 'Declarations name the type first: `input bool A`, `output int count = 0`, `signal S`.')
        }
        if (t.kind === 'ref' || t.kind === 'primitive') this.fail(`'${t.kind}' must come right after input / output / const`)
        this.fail(`Expected a type (bool, int, float, string, signal, ...) but found ${describeToken(t)}`)
    }

    /** ValuedObject: QuotedStringAnnotation* PrimeID ('[' Expression ']')* ('=' Expression)? ('combine' op)? ('label' STRING)? */
    private parseValuedObject(): ValuedObject {
        const start = this.pos
        const pending = this.parseAnnotations('quoted')
        const nameStart = this.pos
        const name = this.parseVOName()
        const vo: ValuedObject = { kind: 'valuedObject', id: '', name, cardinalities: [], span: this.span(start), nameSpan: this.span(nameStart) }
        if (pending.annotations.length) vo.annotations = pending.annotations
        while (this.at('[')) {
            this.next()
            vo.cardinalities.push(this.parseExpression())
            this.expect(']', `Expected ']' after the array size but found ${describeToken(this.la())}`)
        }
        if (this.accept('=')) vo.initialValue = this.parseExpression()
        if (this.accept('combine')) {
            const op = COMBINE[this.kind()]
            if (!op) this.fail(`Expected a combine function (+, *, max, min, |, &, none or host) but found ${describeToken(this.la())}`)
            this.next()
            vo.combine = op
        }
        if (this.accept('label')) vo.label = stringValue(this.expect('STRING', `Expected a quoted label after 'label'`).text)
        vo.span = this.span(start)
        return vo
    }

    private parseVOName(): string {
        const t = this.la()
        if (t.kind !== 'ID') {
            if (KEYWORDS.has(t.kind) && /^[a-zA-Z]/.test(t.kind)) {
                // `^go` would parse, but KIELER's C code keeps the `^` of a variable or signal name and gcc fails on it.
                this.fail(`'${t.kind}' is a keyword and cannot be used as a name`, `Choose another name, for example \`${t.kind}1\`.`)
            }
            this.fail(`Expected a name but found ${describeToken(t)}`)
        }
        return this.parsePrimeID()
    }

    /** PrimeID: ID ("'")*, kept as written (KIELER compares these names textually). */
    private parsePrimeID(): string {
        const t = this.expect('ID', `Expected a name but found ${describeToken(this.la())}`)
        let end = t.end
        while (this.at("'")) end = this.next().end
        return this.src.slice(t.start, end)
    }

    /** ReferenceDeclarationWOSemicolon: (input? output? const? 'ref' (ID '.')? ID generics? RVO (, RVO)*) | ('extern' ExternString (, ExternString)* VO (, VO)*) */
    private parseReferenceDeclaration(start: number, pending: PendingAnnotations, inBlock: boolean): Declaration {
        const d = this.newDeclaration(start, pending, 'reference')
        this.parseAccess(d)
        if (this.at('extern')) {
            this.next()
            d.extern = true
            d.externs = [this.parseExternString()]
            while (this.at(',')) {
                this.next()
                d.externs.push(this.parseExternString())
            }
            d.valuedObjects.push(this.parseValuedObject())
            while (this.accept(',')) d.valuedObjects.push(this.parseValuedObject())
        } else {
            if (this.accept('input')) d.input = true
            if (this.accept('output')) d.output = true
            if (this.accept('const')) d.const = true
            this.expect('ref')
            let at = this.pos
            let target = this.parsePrimeID()
            if (this.at('.')) {
                this.next()
                d.referenceContainer = target
                at = this.pos
                target = this.parsePrimeID()
            }
            d.referenceTarget = target
            d.referenceSpan = this.span(at)
            if (this.at('<')) d.genericParameters = this.parseGenericParameters()
            d.valuedObjects.push(this.parseReferenceValuedObject())
            while (this.accept(',')) d.valuedObjects.push(this.parseReferenceValuedObject())
        }
        if (inBlock) this.accept(';')
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        return d
    }

    private parseExternString(): { code: string; annotations: Annotation[] } {
        const annotations: Annotation[] = []
        while (this.at('@')) {
            const s = this.pos
            this.next()
            const name = this.parseExtendedID()
            annotations.push({ kind: 'annotation', name, values: [], span: this.span(s) })
        }
        const code = stringValue(this.expect('STRING', `Expected the host function name in quotes after 'extern', as in extern "rand" rand`).text)
        return { code, annotations }
    }

    /** ReferenceValuedObject (SCTX): QSA* PrimeID [card]* generics? (('(' ScopeParameter, ... ')') | '()')? ('=' Expr)? ('label' STRING)? */
    private parseReferenceValuedObject(): ValuedObject {
        const start = this.pos
        const pending = this.parseAnnotations('quoted')
        const nameStart = this.pos
        const name = this.parseVOName()
        const vo: ValuedObject = { kind: 'valuedObject', id: '', name, cardinalities: [], span: this.span(start), nameSpan: this.span(nameStart) }
        if (pending.annotations.length) vo.annotations = pending.annotations
        while (this.at('[')) {
            this.next()
            vo.cardinalities.push(this.parseExpression())
            this.expect(']')
        }
        if (this.at('<')) vo.genericParameters = this.parseGenericParameters()
        if (this.at('(') || this.at('()')) {
            const holder: { parameters: ScopeParameter[] } = { parameters: [] }
            this.parseScopeParameters(holder)
            vo.parameters = holder.parameters
        }
        if (this.accept('=')) vo.initialValue = this.parseExpression()
        if (this.accept('label')) vo.label = stringValue(this.expect('STRING').text)
        vo.span = this.span(start)
        return vo
    }

    private parsePrimitiveDeclaration(start: number, pending: PendingAnnotations): Declaration {
        const d = this.newDeclaration(start, pending, 'primitive')
        this.parseAccess(d)
        if (this.accept('input')) d.input = true
        if (this.accept('output')) d.output = true
        if (this.accept('const')) d.const = true
        this.expect('primitive')
        const at = this.pos
        d.referenceTarget = this.parsePrimeID()
        d.referenceSpan = this.span(at)
        d.valuedObjects.push(this.parseReferenceValuedObject())
        while (this.accept(',')) d.valuedObjects.push(this.parseReferenceValuedObject())
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        return d
    }

    /** ScheduleDeclarationWOSemicolon: access? 'schedule' STRING? ('global' PP)? ('{' PP (, PP)* '}')? VO (, VO)* */
    private parseScheduleDeclaration(start: number, pending: PendingAnnotations, inBlock: boolean): Declaration {
        const d = this.newDeclaration(start, pending, 'schedule')
        this.parseAccess(d)
        this.expect('schedule')
        this.accept('STRING')
        const protocol = () => {
            if (!this.at('conflicting') && !this.at('commuting')) this.fail(`Expected 'conflicting' or 'commuting' but found ${describeToken(this.la())}`)
            return this.next().kind
        }
        if (this.accept('global')) {
            d.global = true
            d.priorities = [protocol()]
        }
        if (this.accept('{')) {
            const list = [protocol()]
            while (this.accept(',')) list.push(protocol())
            this.expect('}')
            d.priorities = [...(d.priorities ?? []), ...list]
        }
        d.valuedObjects.push(this.parseValuedObject())
        while (this.accept(',')) d.valuedObjects.push(this.parseValuedObject())
        if (inBlock) this.accept(';')
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        return d
    }

    /** ClassDeclarationWOSemicolon (SCTX's PolicyClassDeclaration): access? host? (class EString? { (PolicyRegion | DeclOrMethod)* } | struct EString? { Decl* }) (VO, ...)? */
    private parseClass(start: number, pending: PendingAnnotations, inBlock: boolean): Declaration {
        const accessTok = this.atAny(ACCESS) ? this.next().kind : undefined
        const host = !!this.accept('host')
        const isStruct = this.at('struct')
        const d = this.newDeclaration(start, pending, isStruct ? 'struct' : 'class')
        if (accessTok) d.access = accessTok as Declaration['access']
        if (host) d.host = true
        this.next()
        if (this.at('STRING') || this.at('ID')) d.className = this.parseEString('')
        this.expect('{', `Expected '{' to start the ${isStruct ? 'struct' : 'class'} body`)
        d.members = []
        while (!this.at('}')) {
            if (this.at('EOF')) this.fail(`The ${isStruct ? 'struct' : 'class'} is missing its closing '}'`)
            if (!isStruct && this.at('policy')) { (d.policies ??= []).push(this.parsePolicyRegion()); continue }
            d.members.push(...this.parseMember(isStruct))
        }
        this.next()
        if (this.at('ID') || this.at('@') || this.at('COMMENT_ANNOTATION')) {
            const vo = this.attempt(() => this.parseValuedObject())
            if (!(vo instanceof Failure)) {
                d.valuedObjects.push(vo)
                while (this.accept(',')) d.valuedObjects.push(this.parseValuedObject())
            }
        }
        if (inBlock) this.accept(';')
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        d.text = this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end)
        return d
    }

    /** DeclarationOrMethodWOSemicolon (class members) / DeclarationWOSemicolon (struct members). */
    private parseMember(isStruct: boolean): Declaration[] {
        const start = this.pos
        if (!isStruct) {
            // A method without the 'method' keyword: access? (returnType | host STRING)? name ( '(' ... ')' | '()' )
            const after = this.scan(() => {
                this.parseAnnotations('full')
                if (this.atAny(ACCESS)) this.next()
                if (this.atAny(METHOD_RETURN_TYPES)) this.next()
                else if (this.at('host') && this.kind(1) === 'STRING') { this.next(); this.next() }
                this.parseAnnotations('quoted')
                this.parsePrimeID()
            })
            if (after >= 0 && (this.kindAt(after) === '(' || this.kindAt(after) === '()')) return [this.parseClassMethod(start)]
            let i = this.pos
            const pre = this.scan(() => { this.parseAnnotations('full'); if (this.atAny(ACCESS)) this.next() })
            if (pre >= 0) i = pre
            if (this.kindAt(i) === 'enum' || (this.kindAt(i) === 'host' && this.kindAt(i + 1) === 'enum')) {
                return [this.parseEnum(start, this.parseAnnotations('full'))]
            }
            // `void reset() { … }`: a keyword as the method's name (KIELER: mismatched input 'reset' expecting RULE_ID).
            const name = this.kindAt(i + 1)
            if (METHOD_RETURN_TYPES.has(this.kindAt(i)) && KEYWORDS.has(name) && /^[a-zA-Z]/.test(name) && ['(', '()'].includes(this.kindAt(i + 2))) {
                this.fail(`'${name}' is a keyword and cannot be used as a name`, `Choose another name, for example \`${name}1\`.`, i + 1)
            }
        }
        const k = this.kind()
        if (!this.isAnnotationStart() && !DECLARATION_STARTS.has(k)) {
            this.fail(`Unexpected ${describeUnexpected(this.la())} in the ${isStruct ? 'struct' : 'class'}`, isStruct ? 'A struct contains declarations, such as `int x`.' : 'A class contains declarations and methods, such as `int count` or `void increment() { count++ }`.')
        }
        return this.parseDeclaration(true)
    }

    /** MethodDeclarationWOSemicolon (SCL): access? (MethodReturnType | host STRING)? name params schedule? ('{' body '}')? */
    private parseClassMethod(start: number): Declaration {
        const pending = this.parseAnnotations('full')
        const d = this.newDeclaration(start, pending, 'method')
        this.parseAccess(d)
        if (this.atAny(METHOD_RETURN_TYPES)) d.returnType = this.next().kind
        else if (this.at('host')) {
            this.next()
            d.returnType = 'host'
            d.returnHostType = stringValue(this.expect('STRING').text)
        }
        this.parseMethodRest(d, false)
        d.span = this.span(start)
        d.text = this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end)
        return d
    }

    /** KeywordMethodDeclarationWOSemicolon: (access? | 'override') 'method' (type | host STRING | primitive ID)? name params schedule? body? */
    private parseKeywordMethod(start: number, pending: PendingAnnotations): Declaration {
        const d = this.newDeclaration(start, pending, 'method')
        if (this.atAny(ACCESS)) d.access = this.next().kind as Declaration['access']
        else if (this.accept('override')) d.override = true
        this.expect('method', `Expected 'method' but found ${describeToken(this.la())}`)
        if (this.atAny(METHOD_RETURN_TYPES)) d.returnType = this.next().kind
        else if (this.at('host') && this.kind(1) === 'STRING') {
            this.next()
            d.returnType = 'host'
            d.returnHostType = stringValue(this.next().text)
        } else if (this.at('primitive')) {
            this.next()
            d.returnType = 'primitive'
            d.returnHostType = this.parsePrimeID()
        }
        this.parseMethodRest(d, true)
        d.span = this.span(start)
        d.text = this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end)
        return d
    }

    private parseMethodRest(d: Declaration, keyword: boolean) {
        const nameStart = this.pos
        const pending = this.parseAnnotations('quoted')
        const name = this.parseVOName()
        const vo: ValuedObject = { kind: 'valuedObject', id: '', name, cardinalities: [], span: this.span(nameStart), nameSpan: this.span(this.pos - 1) }
        if (pending.annotations.length) vo.annotations = pending.annotations
        d.valuedObjects.push(vo)
        d.parameters = []
        if (!this.accept('()')) {
            this.expect('(', `Expected '(' after the method name but found ${describeToken(this.la())}`, 'Methods are written `method name(int a, bool b) { ... }` or `method name() { ... }`.')
            if (this.at(')')) this.fail("Write '()' without a space for a method without parameters")
            d.parameters.push(this.parseMethodParameter(keyword))
            while (this.accept(',')) d.parameters.push(this.parseMethodParameter(keyword))
            this.expect(')', `Expected ',' or ')' after the method parameter but found ${describeToken(this.la())}`)
        }
        this.parseOptionalSchedule()
        if (this.at('{')) {
            const open = this.pos
            this.next()
            const body = { declarations: [] as Declaration[], statements: [] as SclStatement[], span: this.span(open) }
            this.parseOptionalSlComment({ annotations: d.annotations })
            this.parseBlockContents(body, open)
            body.span = this.span(open)
            d.body = body
        }
        this.parseOptionalSlComment(d)
    }

    /** Whether the token at `index` starts a new method parameter rather than another name of the same one. */
    private startsParameter(index: number): boolean {
        const k = this.kindAt(index)
        return k !== 'ID' && k !== '@' && (VALUE_TYPES.has(k) || ACCESS.has(k) || ['input', 'output', 'const', 'global', 'static', 'signal', 'host', 'primitive'].includes(k))
    }

    /** Method parameters: VariableDeclarationWOSemicolon (or PrimitiveDeclaration for 'method' methods). */
    private parseMethodParameter(keyword: boolean): Declaration {
        const start = this.pos
        const pending = this.parseAnnotations('full')
        let i = this.pos
        if (ACCESS.has(this.kindAt(i))) i++
        while (['input', 'output', 'const'].includes(this.kindAt(i))) i++
        if (keyword && this.kindAt(i) === 'primitive') return this.parsePrimitiveDeclaration(start, pending)
        return this.parseVariableDeclarationWith(start, pending, ['input', 'output', 'const', 'global', 'static'], false, true)
    }

    /** EnumDeclarationWOSemicolon: access? host? 'enum' SVO STRING? '{' EnumMember '}' //*? */
    private parseEnum(start: number, pending: PendingAnnotations): Declaration {
        const d = this.newDeclaration(start, pending, 'enum')
        this.parseAccess(d)
        if (this.accept('host')) d.host = true
        this.expect('enum')
        const nameStart = this.pos
        this.parseAnnotations('quoted')
        const name = this.parseVOName()
        d.className = name
        d.valuedObjects.push({ kind: 'valuedObject', id: '', name, cardinalities: [], span: this.span(nameStart), nameSpan: this.span(this.pos - 1) })
        if (this.at('STRING')) d.hostType = stringValue(this.next().text)
        this.expect('{', `Expected '{' with the enum's values, as in enum Bit { ZERO, ONE }`)
        const mStart = this.pos
        const member = this.newDeclaration(mStart, this.parseAnnotations('quoted'), 'variable')
        const one = () => {
            const s = this.pos
            const a = this.parseAnnotations('quoted')
            const n = this.parseVOName()
            const vo: ValuedObject = { kind: 'valuedObject', id: '', name: n, cardinalities: [], span: this.span(s), nameSpan: this.span(this.pos - 1) }
            if (a.annotations.length) vo.annotations = a.annotations
            member.valuedObjects.push(vo)
        }
        one()
        while (this.accept(',')) one()
        this.parseOptionalSlComment(member)
        member.span = this.span(mStart)
        d.members = [member]
        this.expect('}', `Expected ',' or '}' in the enum but found ${describeToken(this.la())}`)
        this.parseOptionalSlComment(d)
        d.span = this.span(start)
        d.text = this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end)
        return d
    }

    // ----- SCL blocks (code effects, method bodies) -----

    /** Declaration* Statement* '}' (the '{' is already consumed). */
    private parseBlockContents(block: { declarations: Declaration[]; statements: SclStatement[] }, open: number) {
        this.inCodeBlock++
        try {
            this.nested(() => this.parseBlockContentsInner(block, open))
        } finally {
            this.inCodeBlock--
        }
    }

    private parseBlockContentsInner(block: { declarations: Declaration[]; statements: SclStatement[] }, open: number) {
        while (this.isBlockDeclarationStart()) block.declarations.push(...this.parseDeclaration(true, true))
        while (!this.at('}')) {
            if (this.at('EOF')) this.fail(`This { ... } block is missing its closing '}'`, `Add '}' (the block opened on line ${this.lines.position(this.toks[open].start).line}).`)
            if (this.isBlockDeclarationStart()) this.fail('Declarations must come before the statements of a block', 'Move the declaration to the top of the { ... } block.')
            const { statement, semicolon } = this.parseStatement()
            block.statements.push(statement)
            if (semicolon) this.withSemicolon.add(statement)
        }
        this.next()
    }

    /**
     * KIELER (InternalSyntaxValidation): in a statement list every statement but the last needs a ';', except labels,
     * blocks, loops and conditionals. Checked on the final tree, since code blocks are parsed speculatively.
     */
    private checkSemicolons(program: Program) {
        const visitBlock = (statements: SclStatement[]) => {
            statements.forEach((s, i) => {
                // KIELER (InternalSyntaxValidation.createSemicolonErrors) checks a statement only through a token of its
                // own rule: the operator of an assignment or `x++`, the keyword of `return` and `goto`. A call or a
                // print belongs to its expression, so it needs no ';' (conformance structure/139).
                if (i < statements.length - 1 && !this.withSemicolon.has(s) && ['assign', 'postfix', 'return', 'goto'].includes(s.kind)) {
                    this.diagnostics.push({
                        severity: 'error', code: 'missing-semicolon', message: 'Missing semicolon', kieler: 'Missing Semicolon',
                        hint: 'In a code block, an assignment that another statement follows needs a `;` after it: `{ x = 1; y = 2 }`. Calls, declarations and blocks need none.',
                        span: s.span,
                    })
                }
                if (s.kind === 'block' || s.kind === 'while' || s.kind === 'for') visitBlock(s.statements)
                if (s.kind === 'if') {
                    visitBlock(s.statements)
                    if (s.else) visitBlock(s.else.statements)
                }
            })
        }
        const visitEffects = (effects: Effect[]) => {
            for (const e of effects) if (e.kind === 'code' && e.statements) visitBlock(e.statements)
        }
        const visitDeclarations = (decls: Declaration[]) => {
            for (const d of decls) {
                if (d.body) visitBlock(d.body.statements)
                if (d.members) visitDeclarations(d.members)
            }
        }
        const visitState = (s: State) => {
            visitDeclarations(s.declarations)
            for (const a of s.actions) visitEffects(a.effects)
            for (const t of s.transitions) visitEffects(t.effects)
            for (const r of s.regions) {
                visitDeclarations(r.declarations)
                for (const a of r.actions) visitEffects(a.effects)
                r.states.forEach(visitState)
            }
        }
        program.charts.forEach(visitState)
    }

    private isBlockDeclarationStart(): boolean {
        let i = this.pos
        if (this.isAnnotationStart()) {
            const after = this.scan(() => this.parseAnnotations('full'))
            if (after < 0) return false
            i = after
        }
        const k = this.kindAt(i)
        if (k === 'extern') return this.kindAt(i + 1) === 'STRING' || this.kindAt(i + 1) === '@'
        return DECLARATION_STARTS.has(k) && k !== 'method' && k !== 'enum' && k !== 'primitive'
    }

    private parseStatement(): { statement: SclStatement; semicolon: boolean } {
        const start = this.pos
        const semi = () => !!this.accept(';')
        // Statement: SclAssignment | SclPostfixAssignment | Label | SclEffectAssignment | Conditional | Goto | ScopeStatement | Return | ForLoop | WhileLoop
        const pre = this.scan(() => this.parseAnnotations('full'))
        const k = this.kindAt(pre)
        if (k === 'if') {
            this.parseAnnotations('full')
            this.next()
            const condition = this.parseBoolScheduleExpression()
            const open = this.pos
            this.expect('{', `Expected '{' after the condition of 'if' but found ${describeToken(this.la())}`, 'In code blocks, conditionals are written if (x > 0) { ... } else { ... }.')
            const block = { declarations: [] as Declaration[], statements: [] as SclStatement[] }
            this.parseBlockContents(block, open)
            const st: Extract<SclStatement, { kind: 'if' }> = { kind: 'if', condition, ...block, span: this.span(start) }
            let semicolon = false
            const elseAt = this.scan(() => this.parseAnnotations('full'))
            if (this.kindAt(elseAt) === 'else') {
                const es = this.pos
                this.parseAnnotations('full')
                this.next()
                const eo = this.pos
                this.expect('{', `Expected '{' after 'else'`, "SCL has no 'else if': write else { if (...) { ... } }.")
                const eb = { declarations: [] as Declaration[], statements: [] as SclStatement[], span: this.span(es) }
                this.parseBlockContents(eb, eo)
                eb.span = this.span(es)
                st.else = eb
                semicolon = semi()
            } else semicolon = semi()
            st.span = this.span(start)
            return { statement: st, semicolon }
        }
        if (k === 'goto') {
            this.parseAnnotations('full')
            this.next()
            const target = this.expect('ID', `Expected a label after 'goto'`).text
            const statement: SclStatement = { kind: 'goto', target, span: this.span(start) }
            return { statement, semicolon: semi() }
        }
        if (k === '{') {
            this.parseAnnotations('full')
            const open = this.pos
            this.next()
            const block = { declarations: [] as Declaration[], statements: [] as SclStatement[] }
            this.parseBlockContents(block, open)
            return { statement: { kind: 'block', ...block, span: this.span(start) }, semicolon: false }
        }
        if (k === 'return') {
            this.parseAnnotations('full')
            this.next()
            const expression = this.parseExpression()
            const span = this.span(start)
            if (this.at(';') && this.spec === 0) {
                // KIELER rejects this (`extraneous input ';' expecting '}'`); report it and skip the ';' so the body is kept.
                this.report(new Failure(this.pos, `Unexpected ';' after the return statement`, 'A `return` ends the method body and takes no `;`: write `return v`, not `return v;`.'))
                this.next()
            }
            return { statement: { kind: 'return', expression, span }, semicolon: false }
        }
        if (k === 'for') return { statement: this.parseForStatement(), semicolon: false }
        if (k === 'while') {
            this.next()
            this.expect('(', `Expected '(' after 'while'`)
            const condition = this.parseLogicalOr()
            this.expect(')', `Expected ')' after the loop condition`)
            const open = this.pos
            this.expect('{', `Expected '{' to start the loop body`)
            const block = { declarations: [] as Declaration[], statements: [] as SclStatement[] }
            this.parseBlockContents(block, open)
            this.accept(';')
            return { statement: { kind: 'while', condition, ...block, span: this.span(start) }, semicolon: false }
        }
        // Label: Annotation* ID ':'
        if (k === 'ID' && this.kindAt(pre + 1) === ':') {
            this.parseAnnotations('full')
            const name = this.next().text
            this.next()
            return { statement: { kind: 'label', name, span: this.span(start) }, semicolon: false }
        }
        // Assignments and effect statements.
        const tryAssign = (demote: boolean) => this.attempt(() => {
            const pending = this.parseAnnotations('full', demote)
            if (this.at('ID')) {
                const target = this.parseValuedObjectReference()
                if (ASSIGN_OPS.has(this.kind())) {
                    const operator = this.next().kind as AssignOperator
                    const expression = this.parseExpression()
                    this.parseOptionalSchedule()
                    const st: SclStatement = { kind: 'assign', target, operator, expression, span: this.span(start) }
                    if (pending.annotations.length) st.annotations = pending.annotations
                    return st
                }
                if (this.at('++') || this.at('--')) {
                    const operator = this.next().kind as '++' | '--'
                    this.parseOptionalSchedule()
                    const st: SclStatement = { kind: 'postfix', target, operator, span: this.span(start) }
                    if (pending.annotations.length) st.annotations = pending.annotations
                    return st
                }
                this.fail('not an assignment')
            }
            this.fail('not an assignment')
        })
        let r = tryAssign(false)
        if (r instanceof Failure && this.isAnnotationStart()) {
            const r2 = tryAssign(true)
            if (!(r2 instanceof Failure)) r = r2
        }
        if (!(r instanceof Failure)) return { statement: r, semicolon: semi() }
        // SclEffectAssignment: ReferenceCall | TextExpression | PrintCall | RandomizeCall | FunctionCall
        const effect = this.attempt(() => {
            const pending = this.parseAnnotations('full')
            const st = this.parseEffectStatement(start)
            if (pending.annotations.length) (st as { annotations?: Annotation[] }).annotations = pending.annotations
            this.parseOptionalSchedule()
            return st
        })
        if (!(effect instanceof Failure)) return { statement: effect, semicolon: semi() }
        const t = this.la()
        if (t.kind === 'ID' && this.kind(1) === '(') throw effect
        this.fail(`Unexpected ${describeUnexpected(t)} in the code block`, 'Code blocks contain assignments (`x = 1`), calls (`f(x)`), `if`, `for`, `while` and `return` statements, separated by semicolons.')
    }

    private parseEffectStatement(start: number): SclStatement {
        const k = this.kind()
        if (k === 'HOSTCODE') {
            const t = this.next()
            return { kind: 'hostcode', text: t.text.slice(1, -1), span: this.tokSpan(t) }
        }
        if (k === 'print') {
            this.next()
            const args: Expression[] = []
            this.parseCallArguments(args, [])
            return { kind: 'print', args, span: this.span(start) }
        }
        if (k === 'randomize') {
            this.next()
            this.accept('()')
            return { kind: 'randomize', args: [], span: this.span(start) }
        }
        if (k === 'extern') {
            this.next()
            const name = this.expect('ID').text
            const args: Expression[] = []
            const access: ParamAccess[] = []
            this.parseCallArguments(args, access)
            const st: SclStatement = { kind: 'call', name, args, extern: true, span: this.span(start) }
            if (access.some(a => a !== null)) st.paramAccess = access
            return st
        }
        const isSuper = !!this.accept('super.')
        const target = this.parseValuedObjectReference()
        const args: Expression[] = []
        const access: ParamAccess[] = []
        this.parseCallArguments(args, access)
        const st: SclStatement = { kind: 'call', name: referenceName(target), args, target, span: this.span(start) }
        if (isSuper) st.super = true
        if (access.some(a => a !== null)) st.paramAccess = access
        return st
    }

    /** ForLoop: 'for' '(' (LoopDeclaration | EffectOrAssignment)? ';' BoolExpression ';' EffectOrAssignment? ')' '{' ... '}' ';'? */
    private parseForStatement(): SclStatement {
        const start = this.pos
        this.expect('for')
        this.expect('(', `Expected '(' after 'for', as in for (int i = 0; i < 3; i++) { ... }`)
        let init: Declaration | SclStatement | undefined
        if (!this.at(';')) {
            const decl = this.attempt(() => {
                const s = this.pos
                const pending = this.parseAnnotations('full')
                const d = this.newDeclaration(s, pending, 'variable')
                if (this.atAny(VALUE_TYPES)) d.type = this.next().kind as ValueType
                else if (this.at('host')) {
                    this.next()
                    d.type = 'host'
                    d.hostType = stringValue(this.expect('STRING').text)
                } else this.fail('no loop declaration')
                d.valuedObjects.push(this.parseValuedObject())
                d.span = this.span(s)
                return d
            })
            init = decl instanceof Failure ? this.parseEffectOrAssignment() : decl
        }
        this.expect(';', `Expected ';' after the loop's initialisation`)
        const condition = this.parseLogicalOr()
        this.expect(';', `Expected ';' after the loop condition`)
        let update: SclStatement | undefined
        if (!this.at(')')) update = this.parseEffectOrAssignment()
        this.expect(')', `Expected ')' to close the loop header`)
        const open = this.pos
        this.expect('{', `Expected '{' to start the loop body`)
        const block = { declarations: [] as Declaration[], statements: [] as SclStatement[] }
        this.parseBlockContents(block, open)
        this.accept(';')
        const st: SclStatement = { kind: 'for', condition, ...block, span: this.span(start) }
        if (init) st.init = init
        if (update) st.update = update
        return st
    }

    /** EffectOrAssignment: Annotation* (VOR PostfixOp | VOR AssignOp Expression | Expression) */
    private parseEffectOrAssignment(): SclStatement {
        const start = this.pos
        const r = this.attempt(() => {
            this.parseAnnotations('full')
            const target = this.parseValuedObjectReference()
            if (this.at('++') || this.at('--')) return { kind: 'postfix', target, operator: this.next().kind as '++' | '--', span: this.span(start) } as SclStatement
            if (ASSIGN_OPS.has(this.kind())) {
                const operator = this.next().kind as AssignOperator
                return { kind: 'assign', target, operator, expression: this.parseExpression(), span: this.span(start) } as SclStatement
            }
            this.fail('not an assignment')
        })
        if (!(r instanceof Failure)) return r
        this.parseAnnotations('full')
        return { kind: 'expression', expression: this.parseExpression(), span: this.span(start) }
    }

    // ----- effects -----

    /**
     * Effect (KEffects, in order): Assignment | PostfixEffect | ValuedEmission | HostcodeEffect | ReferenceCallEffect |
     * FunctionCallEffect | PrintCallEffect | RandomizeCallEffect | PureEmission | CodeEffect (SCTX).
     */
    private parseEffect(): Effect {
        const start = this.pos
        const plain = this.attempt(() => this.parseEffectWith(start, false))
        if (!(plain instanceof Failure)) return plain
        if (this.isAnnotationStart()) {
            const demoted = this.attempt(() => this.parseEffectWith(start, true))
            if (!(demoted instanceof Failure)) return demoted
        }
        throw plain
    }

    private parseEffectWith(start: number, demote: boolean): Effect {
        const isSuperFirst = !!this.accept('super.')
        const pending = this.parseAnnotations('full', demote)
        const withAnnotations = <T extends Effect>(e: T): T => {
            if (pending.annotations.length) e.annotations = pending.annotations
            return e
        }
        const k = this.kind()
        if (isSuperFirst && k !== 'ID') this.fail(`Expected a method name after 'super.'`)
        if (k === 'HOSTCODE') {
            const t = this.next()
            return withAnnotations({ kind: 'hostcode', text: t.text.slice(1, -1), span: this.span(start) })
        }
        if (k === 'extern') {
            this.next()
            const name = this.expect('ID', `Expected the function name after 'extern'`).text
            const args: Expression[] = []
            const access: ParamAccess[] = []
            this.parseCallArguments(args, access)
            const e: Effect = { kind: 'call', name, args, extern: true, span: this.span(start) }
            if (access.some(a => a !== null)) e.paramAccess = access
            return withAnnotations(e)
        }
        if (k === 'print') {
            this.next()
            // KIELER: print in an effect needs at least one argument: print() is a syntax error.
            if (this.at('()')) this.fail('print needs something to print', 'Write `print("text")` or `print("x = %d", x)`.')
            this.expect('(', `Expected '(' after print`)
            const args = [this.parseParameter().expression]
            while (this.accept(',')) args.push(this.parseParameter().expression)
            this.expect(')', `Expected ',' or ')' in print( ... ) but found ${describeToken(this.la())}`)
            this.parseOptionalSchedule()
            return withAnnotations({ kind: 'print', args, span: this.span(start) })
        }
        if (k === 'randomize') {
            this.next()
            const args: Expression[] = []
            if (!this.at('(') && !this.at('()')) this.fail("Write `randomize()` with parentheses in an effect")
            this.parseCallArguments(args, [])
            return withAnnotations({ kind: 'randomize', args, span: this.span(start) })
        }
        if (k === '{') {
            if (isSuperFirst) this.fail('Unexpected {')
            const open = this.pos
            this.next()
            const block = { declarations: [] as Declaration[], statements: [] as SclStatement[] }
            this.parseBlockContents(block, open)
            return withAnnotations({ kind: 'code', text: this.src.slice(this.toks[open].start, this.toks[this.pos - 1].end), ...block, span: this.span(start) })
        }
        if (k === 'super.') {
            this.next()
            return withAnnotations(this.parseReferenceCallEffectRest(start, true))
        }
        if (k !== 'ID') this.failExpectedEffect()
        const target = this.parseValuedObjectReference()
        const op = this.kind()
        if (!isSuperFirst && ASSIGN_OPS.has(op)) {
            this.next()
            const expression = this.parseExpression()
            this.parseOptionalSchedule()
            return withAnnotations({ kind: 'assign', target, operator: op as AssignOperator, expression, span: this.span(start) })
        }
        if (!isSuperFirst && (op === '++' || op === '--')) {
            this.next()
            this.parseOptionalSchedule()
            return withAnnotations({ kind: 'postfix', target, operator: op, span: this.span(start) })
        }
        if (op === '==' && !isSuperFirst) {
            this.fail(`'==' compares; use '=' to assign`, `In an effect, write \`${referenceName(target)} = value\`. Use \`==\` only in conditions (\`if x == 3\`).`, this.pos, "no viable alternative at input '=='")
        }
        if (op === '(' && !isSuperFirst) {
            // ValuedEmission: emission annotations must be quoted (QuotedStringAnnotation).
            const afterOpen = this.pos
            const emission = this.attempt(() => {
                this.next()
                const value = this.parseExpression()
                this.expect(')')
                this.parseOptionalSchedule()
                return value
            })
            if (!(emission instanceof Failure) && this.quotedCompatible(pending.annotations)) {
                return withAnnotations({ kind: 'emit', target, value: emission, span: this.span(start) })
            }
            this.pos = afterOpen
        }
        if (op === '(' || op === '()') {
            const args: Expression[] = []
            const access: ParamAccess[] = []
            this.parseCallArguments(args, access)
            this.parseOptionalSchedule()
            const e: Effect = { kind: 'call', name: referenceName(target), args, target, span: this.span(start) }
            if (isSuperFirst) e.super = true
            if (access.some(a => a !== null)) e.paramAccess = access
            return withAnnotations(e)
        }
        if (isSuperFirst) this.fail(`Expected '(' after the method name`)
        // PureEmission
        if (!this.quotedCompatible(pending.annotations)) this.fail('Annotations on an emission can only have quoted values', 'Write @name "value" (with quotes) in front of an emitted signal.')
        this.parseOptionalSchedule()
        return withAnnotations({ kind: 'emit', target, span: this.span(start) })
    }

    private quotedCompatible(annotations: Annotation[]): boolean {
        return annotations.every(a => !this.unquoted.has(a))
    }

    private parseReferenceCallEffectRest(start: number, isSuper: boolean): Effect {
        const target = this.parseValuedObjectReference()
        const args: Expression[] = []
        const access: ParamAccess[] = []
        this.parseCallArguments(args, access)
        this.parseOptionalSchedule()
        const e: Effect = { kind: 'call', name: referenceName(target), args, target, span: this.span(start) }
        if (isSuper) e.super = true
        if (access.some(a => a !== null)) e.paramAccess = access
        return e
    }

    private failExpectedEffect(): never {
        const t = this.la()
        if (STRUCTURAL.has(t.kind)) this.fail(`Expected an effect after 'do' but found ${describeToken(t)}`, "The transition is incomplete: write the effect (`do x = 1`) and finish with `go to Target`, or remove the `do`.")
        if (t.kind === 'go' || t.kind === 'abort' || t.kind === 'join') this.fail(`Expected an effect after 'do' but found '${t.kind}'`, "Write the effect after `do` (`do x = 1 go to B`), or remove the `do`.")
        if (KEYWORDS.has(t.kind) && /^[a-z]/.test(t.kind)) this.fail(`'${t.kind}' is a keyword and cannot be assigned or emitted`, 'An effect is an assignment (`x = 1`), an emission (`S`), a call (`f(x)`) or `print(...)`.')
        this.fail(`Expected an effect but found ${describeToken(t)}`, 'An effect is an assignment (`x = 1`, `x++`), a signal emission (`S` or `S(3)`), a call (`f(x)`), `print("...")` or host code in backticks.')
    }

    /** (('(' Parameter (',' Parameter)* ')') | '()') */
    private parseCallArguments(args: Expression[], access: ParamAccess[]) {
        if (this.accept('()')) return
        if (!this.at('(')) this.fail(`Expected '(' but found ${describeToken(this.la())}`)
        this.next()
        if (this.at(')')) this.fail("Write '()' without a space for an empty argument list", 'KIELER only accepts an empty argument list written as `()`, without spaces.')
        const p = this.parseParameter()
        args.push(p.expression)
        access.push(p.access)
        while (this.accept(',')) {
            const q = this.parseParameter()
            args.push(q.expression)
            access.push(q.access)
        }
        this.expect(')', `Expected ',' or ')' in the argument list but found ${describeToken(this.la())}`)
    }

    /** Parameter: (('&' | '!&') ValuedObjectReference) | Expression */
    private parseParameter(): { expression: Expression; access: ParamAccess } {
        if (this.at('&') || this.at('!&')) {
            const a = this.next().kind as '&' | '!&'
            return { expression: this.parseValuedObjectReference(), access: a }
        }
        return { expression: this.parseExpression(), access: null }
    }

    // ----- expressions -----

    /** Nesting depth of expressions and states, to fail cleanly instead of overflowing the stack. */
    private depth = 0

    private nested<T>(fn: () => T, limit = 100): T {
        if (++this.depth > limit) {
            this.depth--
            this.fail('This is nested too deeply', 'Expressions, blocks and states can only be nested about a hundred levels deep.')
        }
        try {
            return fn()
        } finally {
            this.depth--
        }
    }

    private memoized(rule: string, fn: () => Expression): Expression {
        let table = this.memo.get(rule)
        if (!table) { table = new Map(); this.memo.set(rule, table) }
        const at = this.pos
        const hit = table.get(at)
        if (hit) {
            if (hit instanceof Failure) throw hit
            this.pos = hit.end
            return hit.node
        }
        try {
            const node = fn()
            table.set(at, { node, end: this.pos })
            return node
        } catch (e) {
            if (e instanceof Failure) {
                table.set(at, e)
                this.pos = at
            }
            throw e
        }
    }

    parseExpression(): Expression {
        // Expression: BoolExpression | ValuedExpression. BoolExpression (LogicalOr) covers every valued expression.
        return this.parseLogicalOr()
    }

    /** BoolScheduleExpression: LogicalOrExpression ('schedule' ScheduleObjectReference)? */
    private parseBoolScheduleExpression(hint?: string): Expression {
        let e: Expression
        const start = this.pos
        try {
            e = this.parseLogicalOr()
        } catch (f) {
            // The hint is about the start of the expression (`if 3 == x`), not about a mistake further on.
            if (f instanceof Failure && hint && !f.hint && f.at === start) throw new Failure(f.at, f.message, hint)
            throw f
        }
        if (this.accept('schedule')) this.parseScheduleObjectReference()
        return e
    }

    private parseLogicalOr(): Expression {
        return this.memoized('or', () => this.nary(['||'], () => this.parseLogicalAnd()))
    }
    private parseLogicalAnd(): Expression { return this.nary(['&&'], () => this.parseBitwiseOr()) }
    private parseBitwiseOr(): Expression { return this.nary(['|'], () => this.parseBitwiseXor()) }
    private parseBitwiseXor(): Expression { return this.nary(['^'], () => this.parseBitwiseAnd()) }
    private parseBitwiseAnd(): Expression { return this.nary(['&'], () => this.parseCompare()) }

    /** X (op X (op X)*)? with one flat n-ary operator (KIELER's LogicalOrExpression etc.). */
    private nary(ops: string[], operand: () => Expression): Expression {
        const start = this.pos
        const first = operand()
        if (!ops.includes(this.kind())) return first
        const op = this.kind()
        const args = [first]
        while (this.at(op)) {
            this.next()
            args.push(this.operandAfter(op, operand))
        }
        return { kind: 'op', op: op as OperatorType, args, span: this.span(start) }
    }

    /** After an operator token KIELER's parser is committed: a missing operand is an error at that point. */
    private operandAfter(op: string, operand: () => Expression): Expression {
        const t = this.la()
        if (t.kind === 'go' || t.kind === 'do' || t.kind === 'abort' || t.kind === 'join' || t.kind === ')' || t.kind === ';' || t.kind === 'EOF' || t.kind === '}') {
            this.fail(`Expected a value after '${op}' but found ${describeToken(t)}`)
        }
        return operand()
    }

    /** CompareOperation: NotOrValuedExpression (CompareOperator NotOrValuedExpression)? -- not associative. */
    private parseCompare(): Expression {
        const start = this.pos
        const left = this.parseNotOrValued()
        if (!COMPARE_OPS.has(this.kind())) return left
        const op = this.next().kind
        const right = this.operandAfter(op, () => this.parseNotOrValued())
        if (COMPARE_OPS.has(this.kind())) {
            this.fail(`Comparisons cannot be chained: '${op}' is followed by '${this.kind()}'`,
                'Write `&&` between two comparisons, as in `x > 0 && x < 10`, or add parentheses: `(a == b) == c`.')
        }
        return { kind: 'op', op: op as OperatorType, args: [left, right], span: this.span(start) }
    }

    /** NotOrValuedExpression: ValuedExpression | NotExpression (in this order). */
    private parseNotOrValued(): Expression {
        // A valued expression never starts with ! or ~, and every AtomicExpression is also a valued expression, so
        // the ordered choice reduces to the first token.
        const t = this.kind()
        if (t === '!' || t === '~') return this.parseNot()
        return this.parseValued()
    }

    /** NotExpression: '!' NotExpression | BitwiseNotExpression; BitwiseNot: '~' BitwiseNot | AtomicExpression */
    private parseNot(): Expression {
        const start = this.pos
        if (this.at('!')) {
            this.next()
            const arg = this.nested(() => this.parseNot())
            return { kind: 'op', op: '!', args: [arg], span: this.span(start) }
        }
        if (this.at('~')) {
            this.next()
            const arg = this.parseBitwiseNotOnly()
            return { kind: 'op', op: '~', args: [arg], span: this.span(start) }
        }
        return this.parseAtomic()
    }
    private parseBitwiseNotOnly(): Expression {
        const start = this.pos
        if (this.at('~')) {
            this.next()
            const arg = this.parseBitwiseNotOnly()
            return { kind: 'op', op: '~', args: [arg], span: this.span(start) }
        }
        return this.parseAtomic()
    }

    /** ValuedExpression = ShiftExpressions */
    private parseValued(): Expression {
        return this.memoized('valued', () => this.parseShift())
    }

    /** ShiftExpressions: Sum (('<<' Sum ('<<' Sum)*) | ('>>' ...) | ('>>>' ...))* */
    private parseShift(): Expression { return this.leftGroups(['<<', '>>', '>>>'], () => this.parseSum()) }
    /** SumExpression: Product (('+' Product ('+' Product)*) | ('-' Product ('-' Product)*))* */
    private parseSum(): Expression { return this.leftGroups(['+', '-'], () => this.parseProduct()) }
    /** ProductExpression: Neg (('*' ...) | ('/' ...) | ('%' ...))* */
    private parseProduct(): Expression { return this.leftGroups(['*', '/', '%'], () => this.parseNeg()) }

    /** KIELER's grouping: runs of the same operator form one n-ary node; a change of operator wraps the node. */
    private leftGroups(ops: string[], operand: () => Expression): Expression {
        const start = this.pos
        let current = operand()
        while (ops.includes(this.kind())) {
            const op = this.kind()
            const args = [current]
            while (this.at(op)) {
                this.next()
                args.push(this.operandAfter(op, operand))
            }
            current = { kind: 'op', op: op as OperatorType, args, span: this.span(start) }
        }
        return current
    }

    /** NegExpression: '-' NegExpression | TernaryOperation */
    private parseNeg(): Expression {
        const start = this.pos
        if (this.at('-')) {
            this.next()
            const arg = this.nested(() => this.parseNeg())
            return { kind: 'op', op: 'neg', args: [arg], span: this.span(start) }
        }
        return this.parseTernary()
    }

    /** TernaryOperation: AtomicValued '?' AtomicValued (':' AtomicValued)? | InitExpression */
    private parseTernary(): Expression {
        const start = this.pos
        const cond = this.attempt(() => {
            const c = this.parseAtomicValued()
            if (!this.at('?')) this.fail('(not a conditional expression)')
            return c
        })
        if (!(cond instanceof Failure)) {
            this.next()
            const then = this.parseAtomicValued()
            const args = [cond, then]
            if (this.accept(':')) args.push(this.parseAtomicValued())
            return { kind: 'op', op: '?:', args, span: this.span(start) }
        }
        return this.parseInit()
    }

    /** InitExpression: Fby ('->' Fby ('->' Fby)*)? */
    private parseInit(): Expression { return this.nary(['->'], () => this.parseFby()) }
    /** FbyExpression: Sfby ('fby' Sfby ...)? */
    private parseFby(): Expression { return this.nary(['fby'], () => this.parseSfby()) }
    /** SfbyExpression: AtomicValued ('sfby' AtomicValued ...)? */
    private parseSfby(): Expression { return this.nary(['sfby'], () => this.parseAtomicValued()) }

    /** AtomicValuedExpression: INT | FLOAT | STRING | VectorValue | NullValue | '(' ValuedExpression ')' | AtomicExpression */
    private parseAtomicValued(): Expression {
        return this.memoized('atomicValued', () => this.nested(() => {
            const t = this.la()
            switch (t.kind) {
                case 'INT': this.next(); return { kind: 'int', value: this.intValue(t), span: this.tokSpan(t) }
                case 'FLOAT': this.next(); return { kind: 'float', value: this.floatValue(t), span: this.tokSpan(t) }
                case 'STRING': this.next(); return { kind: 'string', value: stringValue(t.text), span: this.tokSpan(t) }
                case '{': return this.parseVector()
                case 'null': this.next(); return { kind: 'null', span: this.tokSpan(t) }
                case '(': {
                    const start = this.pos
                    const inner = this.attempt(() => {
                        this.next()
                        const e = this.parseValued()
                        this.expect(')')
                        return e
                    })
                    if (!(inner instanceof Failure)) return withParenSpan(inner, this.span(start))
                    return this.parseAtomic()
                }
                default: return this.parseAtomic()
            }
        }))
    }

    /** VectorValue: '{' (Member (',' Member)* | IntValue 'to' (IntValue | VOR | SpecialAccess)) '}' */
    private parseVector(): Expression {
        const start = this.pos
        this.expect('{')
        const list = this.attempt(() => {
            const values = [this.parseVectorMember()]
            while (this.accept(',')) values.push(this.parseVectorMember())
            this.expect('}')
            return values
        })
        if (!(list instanceof Failure)) return { kind: 'vector', values: list, span: this.span(start) }
        if (this.at('INT') && this.kind(1) === 'to') {
            const from = this.next()
            this.next()
            let to: Expression
            if (this.at('INT')) {
                const t = this.next()
                to = { kind: 'int', value: this.intValue(t), span: this.tokSpan(t) }
            } else if (this.at('scchart') || this.at('state')) to = this.parseSpecialAccess()
            else to = this.parseValuedObjectReference()
            this.expect('}', `Expected '}' to close the range`)
            return { kind: 'vector', range: true, values: [{ kind: 'int', value: this.intValue(from), span: this.tokSpan(from) }, to], span: this.span(start) }
        }
        throw list
    }

    /** VectorValueMember: BoolExpression | ValuedExpression | IgnoreValue */
    private parseVectorMember(): Expression {
        if (this.at('_')) {
            const t = this.next()
            return { kind: 'ignore', span: this.tokSpan(t) }
        }
        return this.parseLogicalOr()
    }

    /**
     * AtomicExpression: BoolValue | '(' BoolExpression ')' | ReferenceCall | FunctionCall | RandomCall | RandomizeCall |
     * ValuedObjectTestExpression | SpecialAccessExpression | TextExpression
     */
    private parseAtomic(): Expression {
        const t = this.la()
        const start = this.pos
        switch (t.kind) {
            case 'BOOLEAN': this.next(); return { kind: 'bool', value: t.text === 'true', span: this.tokSpan(t) }
            case '(': {
                this.next()
                const e = this.parseLogicalOr()
                this.expect(')', `Expected ')' but found ${describeToken(this.la())}`, 'Every ( needs a matching ).')
                return withParenSpan(e, this.span(start))
            }
            case 'extern': {
                this.next()
                const name = this.expect('ID', `Expected the function name after 'extern'`).text
                const args: Expression[] = []
                const access: ParamAccess[] = []
                this.parseCallArguments(args, access)
                const e: Expression = { kind: 'call', name, args, extern: true, span: this.span(start) }
                if (access.some(a => a !== null)) e.paramAccess = access
                return e
            }
            case 'random':
                this.next()
                this.accept('()')
                return { kind: 'random', span: this.span(start) }
            case 'randomize':
                this.next()
                this.accept('()')
                return { kind: 'randomize', span: this.span(start) }
            case 'pre':
            case 'val':
                return this.parseValuedObjectTest()
            case 'scchart':
            case 'state':
                if (this.kind(1) !== '(') this.failExpectedValue()
                return this.parseSpecialAccess()
            case 'HOSTCODE':
                this.next()
                return { kind: 'hostcode', text: t.text.slice(1, -1), span: this.tokSpan(t) }
            case '@':
            case 'COMMENT_ANNOTATION': {
                this.parseAnnotations('full')
                const h = this.expect('HOSTCODE', `Expected host code \`...\` after the annotation`)
                return { kind: 'hostcode', text: h.text.slice(1, -1), span: this.span(start) }
            }
            case 'super.': {
                this.next()
                const target = this.parseValuedObjectReference()
                const args: Expression[] = []
                const access: ParamAccess[] = []
                this.parseCallArguments(args, access)
                const e: Expression = { kind: 'call', name: referenceName(target), args, target, super: true, span: this.span(start) }
                if (access.some(a => a !== null)) e.paramAccess = access
                return e
            }
            case 'ID': {
                const target = this.parseValuedObjectReference()
                if (this.at('(') || this.at('()')) {
                    const args: Expression[] = []
                    const access: ParamAccess[] = []
                    this.parseCallArguments(args, access)
                    const e: Expression = { kind: 'call', name: referenceName(target), args, target, span: this.span(start) }
                    if (access.some(a => a !== null)) e.paramAccess = access
                    return e
                }
                return target
            }
            default:
                this.failExpectedValue()
        }
    }

    private failExpectedValue(): never {
        const t = this.la()
        if (t.kind === '_') this.fail(`'_' is only allowed inside a vector, as in {1, _, 3}`)
        if (t.kind === 'COMMENT_ANNOTATION') this.fail('A /** comment */ cannot appear inside an expression', 'Use `/* ... */` for comments inside expressions.')
        if (t.kind === 'SL_COMMENT_ANNOTATION') this.fail('A //* comment is not allowed here', "//* is a comment annotation, which SCTX only allows after a declaration. Write '// *' for an ordinary comment.")
        if (STRUCTURAL.has(t.kind)) this.fail(`Expected a value but found ${describeToken(t)}`, 'The expression is incomplete. Finish it (for example `if A go to B`), or remove the unfinished part.')
        if (KEYWORDS.has(t.kind) && /^[a-z]/.test(t.kind)) this.fail(`Expected a value but found the keyword '${t.kind}'`)
        if (t.kind === 'ANY_OTHER') this.fail(`Unexpected ${describeUnexpected(t)}`)
        this.fail(`Expected a value (a name, number, true/false or a parenthesised expression) but found ${describeToken(t)}`)
    }

    /** ValuedObjectTestExpression: (pre | val) '(' ValuedObjectTestExpression (',' ValuedObjectReference)? ')' | ValuedObjectReference */
    private parseValuedObjectTest(): Expression {
        const start = this.pos
        if (this.at('pre') || this.at('val')) {
            const op = this.next().kind as 'pre' | 'val'
            this.expect('(', `Expected '(' after ${op}, as in ${op}(S)`)
            if (!this.at('ID') && !this.at('pre') && !this.at('val')) {
                this.fail(`${op}(...) takes a variable or signal name, not ${describeToken(this.la())}`, `KIELER only accepts a name (or another \`pre\` or \`val\`) inside \`${op}( )\`. For an expression, write \`${op}(x) + 1\` instead of \`${op}(x + 1)\`.`)
            }
            const inner = this.nested(() => this.parseValuedObjectTest())
            const args = [inner]
            if (this.accept(',')) args.push(this.parseValuedObjectReference())
            if (!this.at(')')) {
                this.fail(`${op}(...) takes a variable or signal name, not an expression`, `KIELER only accepts a name inside \`${op}( )\`. Write \`${op}(x) + 1\` instead of \`${op}(x + 1)\`.`)
            }
            this.next()
            return { kind: 'op', op, args, span: this.span(start) }
        }
        return this.parseValuedObjectReference()
    }

    /** SCChartAccessExpression | StateAccessExpression (SCTX replaces KExpressions' static access). */
    private parseSpecialAccess(): Expression {
        const start = this.pos
        if (this.accept('scchart')) {
            this.expect('(', `Expected '(' after scchart, as in scchart(Other).CONSTANT`)
            const target = this.parsePrimeID()
            this.expect(')')
            this.expect('.', `Expected '.' and a name after scchart(${target})`)
            const sub = this.parseValuedObjectReference()
            return { kind: 'special', access: 'scchart', target, sub, text: this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end), span: this.span(start) }
        }
        this.expect('state')
        this.expect('(', `Expected '(' after state`)
        let container: string | undefined
        let target = idValue(this.expect('ID').text)
        if (this.accept('.')) {
            container = target
            target = idValue(this.expect('ID').text)
        }
        this.expect(')')
        if (this.accept('schedule')) this.parseScheduleObjectReference()
        const e: Expression = { kind: 'special', access: 'state', target, text: this.src.slice(this.toks[start].start, this.toks[this.pos - 1].end), span: this.span(start) }
        if (container) e.container = container
        return e
    }

    /** ValuedObjectReference: PrimeID ('[' Expression ']')* ('.' ValuedObjectReference)? */
    private parseValuedObjectReference(): Reference {
        const start = this.pos
        const name = this.parsePrimeID()
        const ref: Reference = { kind: 'ref', name, indices: [], span: this.span(start) }
        while (this.at('[')) {
            this.next()
            ref.indices.push(this.parseExpression())
            this.expect(']', `Expected ']' after the array index but found ${describeToken(this.la())}`)
        }
        if (this.at('.') && this.kind(1) === 'ID') {
            this.next()
            ref.sub = this.parseValuedObjectReference()
        } else if (this.at('.')) {
            this.next()
            this.fail(`Expected a member name after '.' but found ${describeToken(this.la())}`)
        }
        ref.span = this.span(start)
        return ref
    }
}

/** describeToken without a leading article, for "Unexpected ..." messages. */
function describeUnexpected(t: Token): string {
    return describeToken(t).replace(/^the (name|number|string) /, '$1 ').replace(/^the end of the file$/, 'end of file')
}

/** `a.b.c` for a reference chain. */
export function referenceName(r: Reference): string {
    return r.sub ? `${r.name}.${referenceName(r.sub)}` : r.name
}

/**
 * KIELER has no parenthesis node: the inner expression stands for `( ... )` and keeps its own span (diagnostics
 * point at it, as KIELER's do). The span including the parentheses is kept here, for code that needs the source
 * text of an operand as written (KIELER's NodeModelUtils.findActualNodeFor).
 */
export const groupSpans = new WeakMap<Expression, Span>()

function withParenSpan(e: Expression, span: Span): Expression {
    const inner = groupSpans.get(e)
    if (!inner || inner.end - inner.start < span.end - span.start) groupSpans.set(e, span)
    return e
}


/** Parses an `@@name values` line of a doc comment into an annotation (KIELER's parseAnnotation). */
function parseInnerAnnotation(text: string, span: Span): Annotation | undefined {
    const m = /^@([A-Za-z_^][\w.-]*)(?:\[([^\]]*)\])?\s*(.*)$/.exec(text.trim())
    if (!m) return undefined
    const values = m[3].trim() ? m[3].split(',').map(v => v.trim().replace(/^"(.*)"$/, '$1')) : []
    const a: Annotation = { kind: 'annotation', name: m[1], values, span }
    if (m[2] !== undefined) a.type = m[2]
    return a
}

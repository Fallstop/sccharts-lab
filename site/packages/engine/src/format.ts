// Pretty-printing of expressions, effects, triggers, declarations, actions and transition labels, exactly as
// KIELER shows them in its diagrams.
//
// This mirrors KIELER's "human readable" serialisers:
//   kexpressions/.../KExpressionsSerializeExtensions.xtend      (plain `serialize`)
//   kexpressions/.../KExpressionsSerializeHRExtensions.xtend    (`serializeHR`: only necessary parentheses)
//   kexpressions/.../keffects/.../KEffectsSerialize(HR)Extensions.xtend
//   sccharts/.../extensions/SCChartsSerializeHRExtensions.xtend (declarations, actions, regions, states)
//   sccharts.ui/.../synthesis/labels/TransitionLabelSerializer.xtend (transition labels)
//   sccharts.ui/.../synthesis/styles/StateStyles.xtend#addKeywordLabel (how highlighted parts are merged)
// including their quirks, so that a diagram here reads the same as in KIELER. The quirks are noted where
// they occur (for example a valued emission prints its value with the plain serialiser: `V((x + 1))`).

import type {
    CombineOperator, Declaration, Effect, Equation, Expression, LocalAction, OperatorType, Pragma, Program,
    Reference, Region, SclStatement, ScopeParameter, State, Transition, ValuedObject,
} from './types'

// ---------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------

/** What the formatter may need to know beyond the element itself. Everything is optional. */
export interface FormatContext {
    /** The declaration and valued object behind a resolved reference (`Reference.decl`). Used to print a
     *  valued object's display label instead of its name, and to drop the value of an emission of a pure
     *  signal (as KIELER does). */
    lookup?(valuedObjectId: string): { declaration: Declaration; valuedObject: ValuedObject } | undefined
    /** Name substitutions from `#symbols` / `#symbol` pragmas (KIELER's symbol table). */
    symbols?: SymbolTable
}

/** Builds a context for all charts of a program: declaration lookup and the pragma symbol table. */
export function createFormatContext(program: Pick<Program, 'charts' | 'pragmas'>): FormatContext {
    const map = new Map<string, { declaration: Declaration; valuedObject: ValuedObject }>()
    const addDecls = (decls: Declaration[]) => {
        for (const declaration of decls) for (const valuedObject of declaration.valuedObjects) map.set(valuedObject.id, { declaration, valuedObject })
    }
    const visitState = (state: State) => {
        addDecls(state.declarations)
        for (const region of state.regions) {
            addDecls(region.declarations)
            for (const child of region.states) visitState(child)
        }
    }
    for (const chart of program.charts) visitState(chart)
    return { lookup: id => map.get(id), symbols: symbolTableFromPragmas(program.pragmas ?? []) }
}

// ---------------------------------------------------------------------------------------------------
// Symbol tables (`#symbols "greek"`, `#symbol "alpha" "α"`)
// ---------------------------------------------------------------------------------------------------

export interface SymbolTable {
    /** Name prefix → replacement. */
    prefixes: Map<string, string>
    /** Separator → suffix processor (`#symbols "subscript" "_"`). */
    suffixes: Map<string, (s: string) => string>
}

const GREEK_UPPER = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu',
    'Xi', 'Omicron', 'Pi', 'Rho', '', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega']
const SUBSCRIPTS: Record<string, string> = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ',
    k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
}

function symbolTableFromPragmas(pragmas: Pragma[]): SymbolTable | undefined {
    const table: SymbolTable = { prefixes: new Map(), suffixes: new Map() }
    for (const pragma of pragmas) {
        const [kind, arg] = pragma.values
        if (pragma.name === 'symbols') {
            const prefix = arg ?? ''
            if (kind === 'greek') {
                table.prefixes.set(prefix + 'Heta', 'Ͱ')
                table.prefixes.set(prefix + 'heta', 'ͱ')
                table.prefixes.set(prefix + 'Yot', 'Ϳ')
                GREEK_UPPER.forEach((name, i) => {
                    if (!name) return
                    table.prefixes.set(prefix + name, String.fromCodePoint(0x391 + i))
                    table.prefixes.set(prefix + name.toLowerCase(), String.fromCodePoint(0x3b1 + i))
                })
                table.prefixes.set(prefix + 'finalsigma', 'ς')
            } else if (kind === 'subscript') {
                table.suffixes.set(prefix, s => [...s].map(c => SUBSCRIPTS[c] ?? c).join(''))
            }
            // "math script", "math fraktur" and "math doublestruck" are not supported here.
        } else if (pragma.name === 'symbol' && pragma.values.length >= 2) {
            table.prefixes.set(pragma.values[0], pragma.values[1])
        }
    }
    return table.prefixes.size || table.suffixes.size ? table : undefined
}

/** KIELER's `applySymbolTable`: strips Xtext's `^` keyword escape and applies pragma symbols. */
export function displayName(name: string, ctx?: FormatContext): string {
    let n = name.startsWith('^') ? name.slice(1) : name
    const table = ctx?.symbols
    if (!table) return n
    for (const [prefix, symbol] of table.prefixes) if (n.startsWith(prefix)) return symbol + n.slice(prefix.length)
    for (const [sep, process] of table.suffixes) {
        const pos = n.indexOf(sep)
        if (pos >= 0) return n.slice(0, pos) + process(n.slice(pos + 1))
    }
    return n
}

// ---------------------------------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------------------------------

/** Java's `Double.toString` (KIELER stores float literals as doubles): `1.0`, `0.5`, `1.0E7`, `1.0E-4`. */
export function formatFloat(value: number): string {
    if (Number.isNaN(value)) return 'NaN'
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity'
    if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
    const abs = Math.abs(value)
    const sign = value < 0 ? '-' : ''
    // Shortest round-tripping digits, as Java (JDK 19+) also produces.
    const [mantissa, expPart] = abs.toExponential().split('e')
    const digits = mantissa.replace('.', '')
    const exp = Number(expPart)
    if (abs >= 1e-3 && abs < 1e7) {
        let s: string
        if (exp >= 0) {
            const intLen = exp + 1
            const intPart = digits.slice(0, intLen).padEnd(intLen, '0')
            const frac = digits.slice(intLen)
            s = `${intPart}.${frac || '0'}`
        } else {
            s = `0.${'0'.repeat(-exp - 1)}${digits}`
        }
        return sign + s
    }
    const frac = digits.slice(1)
    return `${sign}${digits[0]}.${frac || '0'}E${exp}`
}

// ---------------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------------

type OpExpression = Extract<Expression, { kind: 'op' }>

/** KIELER's operator identity: unary minus is SUB with one operand. */
function kOp(e: OpExpression): OperatorType {
    return e.op === 'neg' ? '-' : e.op
}

/** KExpressionsSerializeHRExtensions.precedence */
function precedence(op: OperatorType): number {
    switch (op) {
        case '!': case '~': return 2
        case '*': case '/': case '%': return 3
        case '+': case '-': case 'neg': return 4
        case '<<': case '>>': case '>>>': return 5
        case '<': case '<=': case '>': case '>=': return 6
        case '==': case '!=': return 7
        case '&': return 8
        case '^': return 9
        case '|': return 10
        case '&&': return 11
        case '||': return 12
        case '?:': return 13
        default: return 99 // pre, val, ->, fby, sfby
    }
}

const ALWAYS_OMIT_PARENTHESIS = new Set<OperatorType>(['||', '&&', '!', '+', '-', '*', '&', '|', '^', '~'])

/** KExpressionsSerializeHRExtensions.requiresParenthesis */
function requiresParenthesis(e: OpExpression, parent: OpExpression, position: number): boolean {
    const mine = precedence(kOp(e))
    const theirs = precedence(kOp(parent))
    if (mine > theirs) return true
    if (mine === theirs) {
        if (position === 0 && !(parent.args.length === 1 && kOp(parent) === '-')) return false
        if (kOp(e) === kOp(parent) && ALWAYS_OMIT_PARENTHESIS.has(kOp(e))) return false
        return true
    }
    return false
}

const BINARY_SEPARATORS: Partial<Record<OperatorType, string>> = {
    '==': ' == ', '<': ' < ', '<=': ' <= ', '>': ' > ', '>=': ' >= ', '!=': ' != ', '&&': ' && ', '||': ' || ',
    '&': ' & ', '|': ' | ', '^': ' ^ ', '<<': ' << ', '>>': ' >> ', '>>>': ' >>> ', '+': ' + ', '-': ' - ',
    '*': ' * ', '/': ' / ', '%': ' % ', '->': ' -> ', 'fby': ' fby ', 'sfby': ' sfby ',
}

function formatReference(ref: Reference, ctx: FormatContext | undefined, hr: boolean): string {
    // SCChartsSerializeHRExtensions.serializeVOR (HR) / KExpressionsSerializeExtensions (plain)
    let s = hr ? displayName(ref.name, ctx) : ref.name
    for (const index of ref.indices) s += `[${hr ? formatExpression(index, ctx) : formatExpressionPlain(index, ctx)}]`
    const label = ref.decl ? ctx?.lookup?.(ref.decl)?.valuedObject.label : undefined
    if (label != null) s = label
    if (ref.sub) s += '.' + formatReference(ref.sub, ctx, hr)
    return s
}

/** `serializeHRParameters`: `(a, &b, !&c)`. */
function formatArgs(args: Expression[], ctx: FormatContext | undefined, hr: boolean, access?: (string | null | undefined)[]): string {
    return '(' + args.map((a, i) => (access?.[i] ?? '') + (hr ? formatExpression(a, ctx) : formatExpressionPlain(a, ctx))).join(', ') + ')'
}

type CallLike = { name: string; args: Expression[]; extern?: boolean; target?: Reference; super?: boolean; paramAccess?: (string | null)[] }

/** A reference call `f(x)` / `obj.f(x)` / `super.f(x)`, or a function call `extern f(x)`. */
function formatCall(c: CallLike, ctx: FormatContext | undefined, hr: boolean): string {
    if (c.extern) return 'extern ' + c.name + formatArgs(c.args, ctx, hr, c.paramAccess)
    const callee = c.target ? formatReference(c.target, ctx, hr) : hr ? displayName(c.name, ctx) : c.name
    return (c.super ? 'super.' : '') + callee + formatArgs(c.args, ctx, hr, c.paramAccess)
}

function formatAtom(e: Exclude<Expression, OpExpression>, ctx: FormatContext | undefined, hr: boolean): string {
    switch (e.kind) {
        case 'bool': return e.value ? 'true' : 'false'
        case 'int': return Number.isInteger(e.value) ? String(e.value) : formatFloat(e.value)
        case 'float': return formatFloat(e.value)
        case 'string': return `"${e.value}"`
        case 'ref': return formatReference(e, ctx, hr)
        case 'call': return formatCall(e, ctx, hr)
        case 'random': return 'random'
        case 'randomize': return 'randomize'
        // SCCharts' serializeHR(TextExpression) shows host code without the backticks.
        case 'hostcode': return hr ? e.text : '`' + e.text + '`'
        case 'vector': {
            const item = (v: Expression) => (hr ? formatExpression(v, ctx) : formatExpressionPlain(v, ctx))
            if (e.range) return `{${e.values[0] ? item(e.values[0]) : ''} to ${e.values.length ? item(e.values[e.values.length - 1]) : ''}}`
            return e.values.length ? '{' + e.values.map(item).join(', ') + '}' : '{}'
        }
        case 'ignore': return '_'
        case 'null': return 'null'
        case 'this': return 'this'
        case 'special': {
            if (e.target === undefined) return e.text
            const sub = e.sub ? '.' + formatReference(e.sub, ctx, hr) : ''
            // SCCharts prints a static access (`scchart(Target).member`) as `Target.member`, the others as
            // `access(Container.Target).member`.
            if (e.access === 'static' || e.access === 'scchart') return e.target + sub
            return `${e.access}(${e.container ? e.container + '.' : ''}${e.target})${sub}`
        }
    }
}

/** The operator expression without its own parentheses (`serializeHROperatorExpression`). */
function formatOpInner(e: OpExpression, ctx: FormatContext | undefined, hr: boolean): string {
    const sub = (child: Expression, index: number) => (hr ? formatHR(child, ctx, e, index) : formatExpressionPlain(child, ctx))
    const op = kOp(e)
    switch (op) {
        case '!': return '!' + sub(e.args[0], 0)
        case '~': return '~' + sub(e.args[0], 0)
        case 'pre': return `pre(${sub(e.args[0], 0)})`
        case 'val': return `val(${sub(e.args[0], 0)})`
        case '-':
            if (e.args.length === 1) return '-' + sub(e.args[0], 0)
            break
        case '?:':
            return sub(e.args[0], 0) + ' ? ' + sub(e.args[1], 1) + (e.args.length > 2 ? ' : ' + sub(e.args[2], 2) : '')
        case '<<': case '>>': case '>>>':
            // KIELER's HR serialiser combines shift operands with the plain serialiser.
            return e.args.map(a => formatExpressionPlain(a, ctx)).join(BINARY_SEPARATORS[op])
        case 'fby': case 'sfby':
            // The plain serialiser does not know these operators and prints nothing.
            if (!hr) return ''
            break
    }
    return e.args.map((a, i) => sub(a, i)).join(BINARY_SEPARATORS[op] ?? ` ${op} `)
}

function formatHR(e: Expression, ctx: FormatContext | undefined, parent?: OpExpression, position = 0): string {
    if (e.kind !== 'op') return formatAtom(e, ctx, true)
    const result = formatOpInner(e, ctx, true)
    const op = kOp(e)
    if (op === '!' || op === 'val' || op === 'pre') return result
    if (parent && requiresParenthesis(e, parent, position)) return `(${result})`
    return result
}

/** An expression as KIELER's diagrams show it (`serializeHR`): parentheses only where precedence needs them. */
export function formatExpression(e: Expression, ctx?: FormatContext): string {
    return formatHR(e, ctx)
}

/** KIELER's plain `serialize`: every operator expression except `!`, `~`, `pre` and `val` in parentheses.
 *  The diagram uses it for the value of a valued emission. */
export function formatExpressionPlain(e: Expression, ctx?: FormatContext): string {
    if (e.kind !== 'op') return formatAtom(e, ctx, false)
    const result = formatOpInner(e, ctx, false)
    const op = kOp(e)
    if (op === '!' || op === '~' || op === 'val' || op === 'pre') return result
    return `(${result})`
}

// ---------------------------------------------------------------------------------------------------
// How KIELER groups an expression (for teaching)
// ---------------------------------------------------------------------------------------------------

export interface ParenthesiseOptions {
    /**
     * KIELER's model keeps a run of the same operator as one node with several operands (`a - b - c` is one `-`
     * with three). 'flat' (default) prints such a node as it is, `a - b - c`; 'left' nests it the way the
     * generated C code evaluates it, `(a - b) - c`.
     */
    nary?: 'flat' | 'left'
}

/**
 * The expression with every operation that is an operand of another one in parentheses, so the grouping KIELER's
 * parser chose is visible: `a + b * c` is `a + (b * c)`, `!a && b` is `(!a) && b`, `a > 0 ? 1 : 2` is
 * `a > (0 ? 1 : 2)`. The whole expression, array indices, arguments and vector members get no extra parentheses,
 * `pre(x)` and `val(S)` none either (they look like calls already). Names print as written (no labels, no
 * symbol tables): pass the result of `parseExpression`.
 */
export function formatExpressionParenthesised(e: Expression, options: ParenthesiseOptions = {}): string {
    return parenthesised(e, options, true)
}

/** An effect with its expressions printed by `formatExpressionParenthesised`: `x = a + (b * c)`, `S(a + (b * c))`. */
export function formatEffectParenthesised(effect: Effect, options: ParenthesiseOptions = {}): string {
    const top = (x: Expression) => parenthesised(x, options, true)
    const target = (r: Reference) => parenthesisedReference(r, options)
    switch (effect.kind) {
        case 'assign': return `${target(effect.target)} ${effect.operator} ${top(effect.expression)}`
        case 'postfix': return target(effect.target) + effect.operator
        case 'emit': return effect.value ? `${target(effect.target)}(${top(effect.value)})` : target(effect.target)
        case 'call': return parenthesisedCall(effect, options)
        case 'print': return `print(${effect.args.map(top).join(', ')})`
        default: return formatEffect(effect)
    }
}

function parenthesisedReference(ref: Reference, options: ParenthesiseOptions): string {
    let s = ref.name
    for (const index of ref.indices) s += `[${parenthesised(index, options, true)}]`
    if (ref.sub) s += '.' + parenthesisedReference(ref.sub, options)
    return s
}

function parenthesisedCall(c: CallLike, options: ParenthesiseOptions): string {
    const args = '(' + c.args.map((a, i) => (c.paramAccess?.[i] ?? '') + parenthesised(a, options, true)).join(', ') + ')'
    if (c.extern) return 'extern ' + c.name + args
    return (c.super ? 'super.' : '') + (c.target ? parenthesisedReference(c.target, options) : c.name) + args
}

function parenthesised(e: Expression, options: ParenthesiseOptions, top: boolean): string {
    const sub = (x: Expression) => parenthesised(x, options, false)
    switch (e.kind) {
        case 'ref': return parenthesisedReference(e, options)
        case 'call': return parenthesisedCall(e, options)
        case 'vector':
            if (e.range) return formatAtom(e, undefined, true)
            return '{' + e.values.map(v => parenthesised(v, options, true)).join(', ') + '}'
        case 'op': break
        default: return formatAtom(e, undefined, true)
    }
    const op = kOp(e)
    let inner: string
    switch (op) {
        case 'pre': case 'val': return `${op}(${e.args.map(a => parenthesised(a, options, true)).join(', ')})`
        case '!': case '~': inner = op + sub(e.args[0]); break
        case '-':
            if (e.args.length === 1) { inner = '-' + sub(e.args[0]); break }
            inner = binary()
            break
        case '?:':
            inner = sub(e.args[0]) + ' ? ' + sub(e.args[1]) + (e.args.length > 2 ? ' : ' + sub(e.args[2]) : '')
            break
        default:
            inner = binary()
    }
    return top ? inner : `(${inner})`

    function binary(): string {
        const separator = BINARY_SEPARATORS[op] ?? ` ${op} `
        if (options.nary !== 'left' || e.kind !== 'op') return (e as OpExpression).args.map(sub).join(separator)
        const [first, ...rest] = e.args
        return rest.reduce((acc, arg, i) => (i === 0 ? acc : `(${acc})`) + separator + sub(arg), sub(first))
    }
}

// ---------------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------------

/** An effect as KIELER's diagrams show it: `x = a + 1`, `x++`, `S`, `V((x + 1))`, `print(x)`. */
export function formatEffect(effect: Effect, ctx?: FormatContext): string {
    switch (effect.kind) {
        case 'assign':
            return `${formatReference(effect.target, ctx, true)} ${effect.operator} ${formatExpression(effect.expression, ctx)}`
        case 'postfix':
            return formatReference(effect.target, ctx, true) + effect.operator
        case 'emit': {
            const name = formatReference(effect.target, ctx, true)
            if (!effect.value) return name
            // KIELER prints the value only for a valued signal, and with the plain serialiser.
            const decl = effect.target.decl ? ctx?.lookup?.(effect.target.decl)?.declaration : undefined
            if (decl && (decl.type === undefined || decl.type === 'pure')) return name
            return `${name}(${formatExpressionPlain(effect.value, ctx)})`
        }
        case 'call':
            return formatCall(effect, ctx, true)
        case 'print':
            return `print(${effect.args.map(a => formatExpression(a, ctx)).join(', ')})`
        case 'randomize':
            return 'randomize'
        case 'hostcode':
            return effect.text
        case 'code':
            return effect.statements ? formatScl(effect.declarations ?? [], effect.statements, ctx) : effect.text
    }
}

/**
 * An SCL code block (`do { ... }`) as KIELER prints it (SCLSerializeExtensions): `{` declarations joined by
 * `; `, then the statements joined by spaces, `}`, each statement ending in `;`. Loops print as their body
 * (`for` and `while` become `{...}`), conditionals as `if (c) {...} else {...}`.
 */
export function formatScl(declarations: Declaration[], statements: SclStatement[], ctx?: FormatContext): string {
    return '{' + declarations.map(d => sclDeclaration(d, ctx)).join('; ') + statements.map(s => sclStatement(s, ctx)).join(' ') + '}'
}

function sclDeclaration(d: Declaration, ctx?: FormatContext): string {
    const parts: string[] = []
    if (d.access) parts.push(d.access)
    if (d.extern) parts.push('extern')
    if (d.global) parts.push('global')
    if (d.static) parts.push('static')
    if (d.const) parts.push('const')
    if (d.input) parts.push('input')
    if (d.output) parts.push('output')
    if (d.signal) parts.push('signal')
    if (d.type === 'host') parts.push(d.hostType ?? 'host')
    else if (d.type && d.type !== 'pure') parts.push(d.type === 'clock-time' ? 'time' : d.type)
    d.valuedObjects.forEach((vo, i) => {
        parts.push(vo.label ?? vo.name + vo.cardinalities.map(c => `[${formatExpressionPlain(c, ctx)}]`).join(''))
        if (vo.initialValue) parts.push('=', formatExpressionPlain(vo.initialValue, ctx))
        if (i < d.valuedObjects.length - 1) parts.push(',')
    })
    return parts.join(' ')
}

function sclStatement(st: SclStatement, ctx?: FormatContext): string {
    switch (st.kind) {
        case 'assign': return `${formatReference(st.target, ctx, true)} ${st.operator} ${formatExpression(st.expression, ctx)};`
        case 'postfix': return `${formatReference(st.target, ctx, true)}${st.operator};`
        case 'label': return `${st.name}:`
        case 'goto': return `goto ${st.target};`
        case 'return': return `return ${formatExpression(st.expression, ctx)};`
        case 'block': case 'while': case 'for': return formatScl(st.declarations, st.statements, ctx)
        case 'if': return `if (${formatExpression(st.condition, ctx)}) {` + st.declarations.map(d => sclDeclaration(d, ctx)).join('; ')
            + st.statements.map(s => sclStatement(s, ctx)).join(' ') + '}' + (st.else ? ' else ' + formatScl(st.else.declarations, st.else.statements, ctx) : '')
        case 'print': return `print ${st.args.map(a => formatExpressionPlain(a, ctx)).join(', ')};`
        case 'call': return `${formatCall(st, ctx, true)};`
        case 'randomize': return 'randomize;'
        case 'hostcode': return '`' + st.text + '`;'
        case 'expression': return `${formatExpression(st.expression, ctx)};`
    }
}

/** Effects joined with `; `. */
export function formatEffects(effects: Effect[], ctx?: FormatContext): string {
    return effects.map(e => formatEffect(e, ctx)).join('; ')
}

// ---------------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------------

/** The trigger with its count delay: `3 A`. Empty when there is no trigger. */
export function formatTrigger(t: Pick<Transition, 'trigger' | 'triggerDelay'>, ctx?: FormatContext): string {
    if (!t.trigger) return ''
    return (t.triggerDelay !== undefined && t.triggerDelay > 1 ? `${t.triggerDelay} ` : '') + formatExpression(t.trigger, ctx)
}

/** `serializeHR(Transition)`: trigger and effects, without priority (`3 A / x = 1; S`). */
export function formatTransition(t: Transition, ctx?: FormatContext): string {
    let s = formatTrigger(t, ctx)
    if (t.effects.length) s += ' / ' + formatEffects(t.effects, ctx)
    return s
}

export interface TransitionLabelOptions extends FormatContext {
    /** Show `label "..."` user labels instead of trigger and effects (KIELER's "User Labels", default on). */
    userLabels?: boolean
}

/**
 * The lines of a transition label, as KIELER's TransitionLabelSerializer.serializeMultilineLabel builds them:
 * `["1: A && B", "/ O = true;", "  x++"]`. The priority is shown only when the source state has more than one
 * outgoing transition; the trigger goes on the first line and each effect on its own line, indented under the
 * first. `outgoing` is the number of outgoing transitions of the source state.
 */
export function transitionLabelLines(t: Transition, outgoing: number, options: TransitionLabelOptions = {}): string[] {
    const userLabels = options.userLabels ?? true
    if (userLabels && t.label) return [t.label]
    const parts: string[] = []
    let part = ''
    let effectPrefix = ''
    if (outgoing > 1) part += `${t.priority}: `
    if (t.probability !== undefined && t.probability > 0) part += `Pr=${formatFloat(t.probability)}: `
    if (t.trigger) {
        if (t.triggerDelay !== undefined && t.triggerDelay > 1) part += `${t.triggerDelay} `
        part += formatExpression(t.trigger, options)
        parts.push(part)
    } else {
        effectPrefix = part
    }
    if (parts.length === 0 && t.effects.length === 0) {
        parts.push(effectPrefix)
    } else {
        effectPrefix += '/ '
        t.effects.forEach((effect, i) => {
            parts.push(effectPrefix + formatEffect(effect, options) + (i < t.effects.length - 1 ? ';' : ''))
            effectPrefix = ' '.repeat(effectPrefix.length)
        })
    }
    return parts
}

/** The transition label on one line (`TransitionLabelSerializer.serializeLabel`): `1: A && B / O = true; x++`.
 *  Empty when KIELER shows no label. */
export function transitionLabel(t: Transition, outgoing: number, options: TransitionLabelOptions = {}): string {
    return transitionLabelLines(t, outgoing, options).map(s => s.trim()).join(' ')
}

/** KIELER draws a transition dashed when it is immediate, leaves a connector, or is a termination without
 *  trigger that is not explicitly delayed (`SCChartsTransitionExtensions.isImplicitlyImmediate`). */
export function isImplicitlyImmediate(t: Transition, source: Pick<State, 'connector'>): boolean {
    return t.delay === 'immediate' || source.connector || (t.preemption === 'termination' && !t.trigger && t.delay !== 'delayed')
}

// ---------------------------------------------------------------------------------------------------
// Highlighted labels: declarations, actions, region and state titles
// ---------------------------------------------------------------------------------------------------

export type TextFormat = 'keyword' | 'text' | 'highlight' | 'schedule'

/** A run of text in one format. Keyword runs are bold in KIELER's notation. */
export interface TextSegment {
    text: string
    format: TextFormat
}

/**
 * Merges label components into runs the way KIELER's `addKeywordLabel` does: consecutive components of the
 * same format are joined with a space (no space before a comma); a run that is followed by a run of another
 * format keeps a trailing space. Empty runs are dropped.
 */
export function mergeComponents(components: TextSegment[]): TextSegment[] {
    const out: TextSegment[] = []
    let builder = ''
    let format: TextFormat = 'keyword'
    for (const c of components) {
        if (builder.length > 0 && format !== c.format) {
            out.push({ text: builder + ' ', format })
            builder = ''
        }
        if (builder.length > 0) builder += c.text === ',' ? '' : ' '
        builder += c.text
        format = c.format
    }
    if (builder.length > 0) out.push({ text: builder, format })
    return out
}

/** The text of merged segments on one line. */
export function segmentsText(segments: TextSegment[]): string {
    return segments.map(s => s.text).join('').trimEnd()
}

const kw = (text: string): TextSegment => ({ text, format: 'keyword' })
const tx = (text: string): TextSegment => ({ text, format: 'text' })
const hl = (text: string): TextSegment => ({ text, format: 'highlight' })

function combineName(op: CombineOperator): string {
    switch (op) {
        case '|': return 'or'
        case '&': return 'and'
        default: return op
    }
}

/** A valued object as declared: `arr[3]`, or its display label. */
export function formatValuedObject(vo: ValuedObject, ctx?: FormatContext): string {
    // KExpressionsSerializeHRExtensions.serializeHR(ValuedObject): the name as written (a `^` escape stays),
    // without the symbol table that references get.
    if (vo.label != null) return vo.label
    return vo.name + vo.cardinalities.map(c => `[${formatExpression(c, ctx)}]`).join('')
}

function valuedObjectComponents(d: Declaration, ctx: FormatContext | undefined, c: TextSegment[]) {
    d.valuedObjects.forEach((vo, i) => {
        // With bindings: `ref Chart c(x, y)` prints the valued object's parameters.
        let text = formatValuedObject(vo, ctx)
        if (vo.genericParameters?.length) text += `<${vo.genericParameters.join(', ')}>`
        if (vo.parameters?.length) text += formatScopeParameters(vo.parameters, ctx)
        c.push(tx(text))
        if (vo.initialValue) {
            c.push(tx('='))
            c.push(tx(formatExpression(vo.initialValue, ctx)))
        }
        if (vo.combine && vo.combine !== 'none') {
            c.push(kw('combine'))
            c.push(tx(combineName(vo.combine)))
        }
        if (i < d.valuedObjects.length - 1) c.push(tx(','))
    })
}

function formatScopeParameters(params: ScopeParameter[], ctx?: FormatContext): string {
    return formatArgs(params.map(p => p.expression), ctx, true, params.map(p => (p.pureOutput ? '!&' : p.byReference ? '&' : null)))
}

/** A method signature (`serializeMethodHighlighted` without body): `int f(int x, bool b)`. */
/** A method signature (`serializeMethodHighlighted`): `[abstract] [override|access] int f(int x)`, and
 *  with `body` (class members, as KIELER lists them) ` { <statements> }`. */
function methodComponents(d: Declaration, ctx: FormatContext | undefined, c: TextSegment[], options: { body?: boolean; hostClass?: boolean } = {}) {
    // A method without implementation is abstract, unless it belongs to a host class.
    if (!d.body && !options.hostClass) c.push(kw('abstract'))
    if (d.override) c.push(kw('override'))
    else if (d.access) c.push(kw(d.access))
    const ret = d.returnType ?? 'void'
    c.push(kw(ret === 'host' ? (d.returnHostType ?? 'host') : ret === 'pure' ? 'void' : ret))
    c.push(tx(displayName(d.valuedObjects[0]?.name ?? '', ctx) + '('))
    ;(d.parameters ?? []).forEach((p, i, all) => {
        c.push(...declarationComponents(p, ctx))
        if (i < all.length - 1) c.push(tx(','))
    })
    c.push(tx(')'))
    if (options.body && d.body?.statements.length) {
        // The SCL serialisation without its outer braces and last semicolon.
        const text = formatScl(d.body.declarations, d.body.statements, ctx)
        c.push(tx('{'), tx(text.endsWith(';}') ? text.slice(1, -2) : text.slice(1, -1)), tx('}'))
    }
}

/** The label components of a declaration (`serializeHighlighted(declaration, hr = true)`), before merging.
 *  For a class, struct or enum this is only its first line; see `declarationLines`. */
export function declarationComponents(d: Declaration, ctx?: FormatContext): TextSegment[] {
    return declarationLines(d, ctx)[0]?.components ?? []
}

/** One line of a declaration label, indented by `indent` levels (KIELER indents 10 px per level). */
export interface DeclarationLine {
    indent: number
    components: TextSegment[]
}

/**
 * The lines of a declaration label. Most declarations are one line; a class or struct shows its members
 * indented between `class Name {` and `} instances`, as KIELER's StateSynthesis.addStructDeclarations does.
 */
export function declarationLines(d: Declaration, ctx?: FormatContext, indent = 0, member?: { hostClass: boolean }): DeclarationLine[] {
    const c: TextSegment[] = []
    if (d.declKind === 'method') {
        methodComponents(d, ctx, c, member ? { body: true, hostClass: member.hostClass } : {})
        return [{ indent, components: c }]
    }
    if (d.access) c.push(kw(d.access))
    if (d.declKind === 'variable' || d.declKind === 'class' || d.declKind === 'struct' || d.declKind === 'enum') {
        if (d.extern) c.push(kw('extern'))
        if (d.global) c.push(kw('global'))
        if (d.static) c.push(kw('static'))
        if (d.input) c.push(kw('input'))
        if (d.output) c.push(kw('output'))
        if (d.const) c.push(kw('const'))
        if (d.signal) c.push(kw('signal'))
        const type = d.type
        if (d.declKind !== 'variable') {
            if (d.host) c.push(kw('host'))
            c.push(kw(d.declKind))
        } else if (type === undefined || type === 'pure') {
            // indicated by the signal keyword
        } else if (type === 'host') {
            c.push(kw(d.hostType ?? 'host'))
        } else if (type === 'clock') {
            if (d.annotations.some(a => a.name.toLowerCase() === 'passive')) c.push(kw('passive'))
            else if (d.annotations.some(a => a.name.toLowerCase() === 'logical')) c.push(kw('logical'))
            c.push(kw('clock'))
        } else if (type === 'clock-time') {
            c.push(kw('time'))
        } else {
            c.push(kw(type))
        }
    } else if (d.declKind === 'reference' || d.declKind === 'primitive') {
        if (d.extern || d.externs?.length) {
            c.push(kw('extern'))
            c.push(hl(d.externs?.[0]?.code ?? d.hostType ?? ''))
        } else {
            if (d.input) c.push(kw('input'))
            if (d.output) c.push(kw('output'))
            if (d.const) c.push(kw('const'))
            // A declaration of a generic primitive type (`input primitive T v`) is a "simple" reference: no `ref`.
            if (d.declKind === 'reference') c.push(kw('ref'))
            c.push(hl((d.referenceContainer ? d.referenceContainer + '.' : '') + (d.referenceTarget ?? '<BROKEN-REFERENCE>')))
            if (d.genericParameters?.length) c.push(tx(`<${d.genericParameters.join(', ')}>`))
        }
    } else if (d.declKind === 'schedule') {
        c.push(kw('schedule'))
        if (d.priorities?.length) {
            c.push(tx('{'))
            d.priorities.forEach((prio, i, all) => {
                if (prio === 'conflicting' || prio === 'commuting') c.push(kw(prio))
                if (i < all.length - 1) c.push(tx(', '))
            })
            c.push(tx('}'))
        }
        const name = d.valuedObjects[0]?.name
        if (name) c.push(hl(name))
        return [{ indent, components: c }]
    } else if (d.text) {
        c.push(tx(d.text.split('\n')[0].trim()))
        return [{ indent, components: c }]
    }
    if (d.declKind === 'class' || d.declKind === 'struct' || d.declKind === 'enum') {
        const lines: DeclarationLine[] = []
        if (d.className) c.push(tx(d.className))
        else if (d.declKind === 'enum' && d.valuedObjects[0]) c.push(tx(d.valuedObjects[0].name))
        c.push(tx('{'))
        lines.push({ indent, components: c })
        for (const member of d.members ?? []) lines.push(...declarationLines(member, ctx, indent + 1, { hostClass: !!d.host }))
        const tail: TextSegment[] = [tx('}')]
        if (d.declKind !== 'enum') valuedObjectComponents(d, ctx, tail)
        lines.push({ indent, components: tail })
        return lines
    }
    valuedObjectComponents(d, ctx, c)
    return [{ indent, components: c }]
}

/** A declaration line as KIELER's diagram shows it, e.g. `[input bool ][A, B]` (first line only). */
export function declarationSegments(d: Declaration, ctx?: FormatContext): TextSegment[] {
    return mergeComponents(declarationComponents(d, ctx))
}

/** A declaration on one line: `output int F = 0`. */
export function formatDeclaration(d: Declaration, ctx?: FormatContext): string {
    return segmentsText(declarationSegments(d, ctx))
}

function actionKeyword(a: LocalAction): string {
    switch (a.kind) {
        case 'entry': return a.preemption === 'weak' ? 'weak entry' : 'entry'
        case 'during': return 'during'
        case 'exit': return a.preemption === 'weak' ? 'weak exit' : 'exit'
        case 'suspend': return a.weak ? 'weak suspend' : 'suspend'
        case 'period': return 'period'
        case 'ode': return 'ode'
    }
}

/** The label components of a local action (`serializeHighlighted(action, hr = true, userLabels)`). Note that
 *  KIELER does not show an action's count delay. */
export function actionComponents(a: LocalAction, options: TransitionLabelOptions = {}): TextSegment[] {
    const c: TextSegment[] = []
    if (a.delay === 'immediate') c.push(kw('immediate'))
    c.push(kw(actionKeyword(a)))
    if ((options.userLabels ?? true) && a.label) {
        c.push(tx(a.label))
    } else {
        if (a.trigger) {
            c.push(tx(formatExpression(a.trigger, options)))
            // KIELER adds an (empty) schedule part after every trigger; it only matters for merging.
            c.push({ text: '', format: 'schedule' })
        }
        if (a.effects.length) {
            c.push(tx('/'))
            c.push(tx(formatEffects(a.effects, options)))
        }
    }
    return c
}

/** An action line: `[during ][A ][/ c--]`. */
export function actionSegments(a: LocalAction, options: TransitionLabelOptions = {}): TextSegment[] {
    return mergeComponents(actionComponents(a, options))
}

/** An action on one line: `immediate during A / c++`. */
export function formatAction(a: LocalAction, options: TransitionLabelOptions = {}): string {
    return segmentsText(actionSegments(a, options))
}

/** The name a state shows: its label, or its name (`serializeHR(State)`). */
export function stateDisplayName(s: Pick<State, 'name' | 'label'>, ctx?: FormatContext): string {
    return displayName(s.label ?? s.name ?? '', ctx)
}

/** The title of a superstate or root state: the name, and for a reference state `@ Other (a, b)`. */
export function stateTitleSegments(s: State, ctx?: FormatContext): TextSegment[] {
    const c: TextSegment[] = [tx(stateDisplayName(s, ctx))]
    if (s.reference) {
        c.push(kw('@'))
        c.push(tx(s.reference.target))
        // KIELER always prints the parameter list, `()` when empty.
        c.push(tx(formatScopeParameters(s.reference.parameters, ctx)))
    }
    if (s.genericParameters?.length) {
        // serializeGenericParametersHighlighted: `< T is int, U is ref Other >`.
        c.push(tx('<'))
        s.genericParameters.forEach((param, i, all) => {
            const m = /^(\S+)\s+is\s+(ref\s+)?(.+)$/.exec(param.trim())
            if (!m) c.push(tx(param.trim()))
            else {
                c.push(tx(m[1]), kw('is'))
                if (m[2]) c.push(kw('ref'), tx(m[3]))
                else if (/^(bool|int|float|string|pure|host|clock|primitive)$/.test(m[3])) c.push(kw(m[3]))
                else c.push(tx(m[3]))
            }
            if (i < all.length - 1) c.push(tx(','))
        })
        c.push(tx('>'))
    }
    if (s.baseStates?.length) {
        c.push(kw('extends'))
        s.baseStates.forEach((b, i) => {
            c.push(tx(b.target + (b.parameters.length ? formatScopeParameters(b.parameters, ctx) : '')))
            if (i < s.baseStates!.length - 1) c.push(tx(','))
        })
    }
    return mergeComponents(c)
}

/** The label of a region (`serializeHighlighted(region)`): `override`, its label or name, and for a `for`
 *  region `| i[0,3]`. Empty for an anonymous region. */
export function regionLabelSegments(r: Region, ctx?: FormatContext): TextSegment[] {
    const c: TextSegment[] = []
    if (r.override) c.push(kw('override'))
    const label = r.label ?? r.name
    if (label) c.push(tx(displayName(label, ctx)))
    if (r.forLoop) {
        const [from, to] = forRegionRange(r.forLoop, ctx)
        c.push(kw('|'))
        c.push(tx(r.forLoop.variable))
        c.push(tx('['))
        c.push(tx(String(from)))
        c.push(tx(','))
        c.push(tx(String(to)))
        c.push(tx(']'))
    }
    return mergeComponents(c)
}

/**
 * The index range of a `for` region as KIELER computes it (For.getForRegionRange): `for i : 0 to 3` gives
 * [0, 3]; `for i : arr` iterates the indices of the array, [0, size - 1] (the size a literal or a constant's
 * initial value), and [0, -1] when the size is unknown.
 */
export function forRegionRange(loop: NonNullable<Region['forLoop']>, ctx?: FormatContext): [number, number] {
    if (loop.from.kind === 'int') return [loop.from.value, loop.to?.kind === 'int' ? loop.to.value : NaN]
    if (loop.from.kind === 'ref') {
        const card = loop.from.decl ? ctx?.lookup?.(loop.from.decl)?.valuedObject.cardinalities[0] : undefined
        if (card?.kind === 'int') return [0, card.value - 1]
        if (card?.kind === 'ref' && card.decl) {
            const init = ctx?.lookup?.(card.decl)?.valuedObject.initialValue
            if (init?.kind === 'int') return [0, init.value - 1]
        }
        return [0, -1]
    }
    return [NaN, NaN]
}

/** A dataflow equation on one line: `O = A && !pre(A)`. */
export function formatEquation(eq: Equation, ctx?: FormatContext): string {
    return `${formatReference(eq.target, ctx, true)} ${eq.operator} ${formatExpression(eq.expression, ctx)}`
}

// Charts KIELER accepts until its generated C code fails to compile in gcc (basics.md §10, concurrency.md R):
// the simulator rejects them too, with gcc's message in `kieler`.

import type { Diagnostic, Span } from '../types'
import { allActionSites, allScopes, effectExprs, walkExpr, type CEffect, type CExpr, type CState, type CStmt, type CVar } from './model'
import { isInlined } from './structure/methods'
import { KEYWORDS } from '../parser/lexer'

const GCC_FAILED = 'Compiler did not return success (exit value != 0)'

/** C keywords: a top-level variable of that name breaks the generated C code (KIELER does not rename them). */
const C_KEYWORDS = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float',
    'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static',
    'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool', '_Complex', '_Imaginary',
    '_Alignas', '_Alignof', '_Atomic', '_Generic', '_Noreturn', '_Static_assert', '_Thread_local',
])

/** gcc's first error for a top-level variable named after a C keyword, where it is not the usual one (probes
 *  rare/probe-c-keyword-*): type specifiers and qualifiers read as part of the declaration's type. */
function cKeywordError(name: string): string {
    if (name === 'char' || name === 'double') return 'two or more data types in declaration specifiers'
    if (name === 'union') return 'expected ‘{’ before ‘;’ token'
    if (name === 'volatile' || name === 'long' || name === 'short' || name === 'signed' || name === 'unsigned') return `expected identifier before ‘${name}’`
    return `expected identifier or ‘(’ before ‘${name}’`
}

export function checkCodegen(root: CState): Diagnostic[] {
    const out: Diagnostic[] = []
    const seen = new Set<string>()
    const add = (d: Diagnostic) => {
        const key = `${d.code}:${d.span?.start ?? ''}:${d.message}`
        if (seen.has(key)) return
        seen.add(key)
        out.push(d)
    }

    // Duplicate declarations at the top level become duplicate members of the C data struct (H-7).
    const names = new Map<string, number>()
    for (const v of root.decls) {
        if (v.const || v.declKind || v.generated) continue
        if (C_KEYWORDS.has(v.name)) {
            add({
                severity: 'error', code: 'c-keyword', span: v.span,
                message: `\`${v.name}\` is a keyword of C, so KIELER's generated C code cannot use it as a variable name`,
                kieler: `${cKeywordError(v.name)}\n${GCC_FAILED}`,
                hint: `Rename \`${v.name}\` (for example \`${v.name}Value\`).`,
                related: v.decl ? [v.decl] : undefined,
            })
        }
        names.set(v.name, (names.get(v.name) ?? 0) + 1)
        if (names.get(v.name) === 2) {
            add({
                severity: 'error', code: 'duplicate-declaration', span: v.span,
                message: `\`${v.name}\` is declared twice in the same scope`,
                kieler: `duplicate member ‘${v.name}’\n${GCC_FAILED}`,
                hint: 'Give each variable its own name (KIELER only warns "The variable is declared multiple times in this scope.", then its C compiler fails).',
                related: v.decl ? [v.decl] : undefined,
            })
        }
    }

    out.push(...cNames(root))
    for (const d of cText(root)) add(d)

    // A method with parameters and an empty body: KIELER's C code still refers to the first parameter as a member of
    // its tick data (probes structure/probe-empty-method-*).
    for (const scope of allScopes(root)) {
        for (const v of scope.decls) {
            const m = v.method
            if (v.declKind !== 'method' || !m || !m.params.length || m.body.length || m.locals.length) continue
            const name = v.member ? v.member.name : v.name
            add({
                severity: 'error', code: 'empty-method', span: v.span,
                message: `KIELER's C code for the method \`${name}\` does not compile: it has a parameter but no statements`,
                kieler: `‘TickData’ has no member named ‘${m.params[0].name}’\n${GCC_FAILED}`,
                hint: `KIELER's code generator fails on a method whose body is empty when it has parameters. Give \`${name}\` a statement, or leave out its parameters while it does nothing.`,
                related: v.decl ? [v.decl] : undefined,
            })
        }
    }

    // A for loop whose counter is not declared in its head (`for (i = 0; ...)` with a chart variable i): KIELER's C
    // code does not declare it (conformance structure/146).
    for (const scope of allScopes(root)) {
        for (const v of scope.decls) {
            const m = v.method
            if (v.declKind !== 'method' || !m) continue
            const local = new Set([...m.params, ...m.locals])
            const visit = (list: CStmt[]) => {
                for (const st of list) {
                    if (st.k === 'for') {
                        for (const init of st.init) {
                            if (init.k !== 'do' || init.f.k !== 'assign' || local.has(init.f.ref.v)) continue
                            const counter = init.f.ref.v
                            add({
                                severity: 'error', code: 'for-outer-counter', span: st.span ?? init.f.o.span,
                                message: `The loop counter \`${counter.display ?? counter.name}\` is a variable of the chart, which KIELER's C code for the loop does not declare`,
                                kieler: `\u2018${counter.name}\u2019 undeclared (first use in this function)\n${GCC_FAILED}`,
                                hint: `Declare the counter in the loop head, \`for (int j = 0; ...)\`, and assign the chart variable inside the loop if you need its value.`,
                                related: v.decl ? [v.decl] : undefined,
                            })
                        }
                        visit(st.body)
                    } else if (st.k === 'if') { visit(st.then); if (st.else) visit(st.else) }
                    else if (st.k === 'while') visit(st.body)
                }
            }
            visit(m.body)
        }
    }

    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const by = holder.origin ?? holder.about
        const related = by ? [by] : undefined
        const exprs: CExpr[] = holder.trigger ? [holder.trigger] : []
        for (const f of holder.effects) {
            exprs.push(...effectExprs(f))
            if (f.k === 'assign') {
                if (f.op === '>>>=') {
                    add({
                        severity: 'error', code: 'unsigned-shift', span: f.o.span, related,
                        message: 'C has no >>>= operator, so KIELER\'s generated code does not compile',
                        kieler: `expected expression before ‘>=’ token\n${GCC_FAILED}`,
                        hint: 'Use `>>=` instead (an arithmetic shift).',
                    })
                }
                let target = f.ref
                while (target.sub) target = target.sub
                const v = target.v
                if (v.dims.length > target.idx.length && f.expr && f.expr.k !== 'vector') {
                    add({
                        severity: 'error', code: 'array-assignment', span: f.o.span, related,
                        message: `\`${v.display ?? v.name}\` is an array: it cannot be assigned as a whole`,
                        kieler: `assignment to expression with array type\n${GCC_FAILED}`,
                        hint: `Assign the elements one by one (\`${v.name}[0] = ...\`, \`${v.name}[1] = ...\`) or with a vector, \`${v.name} = {...}\`.`,
                    })
                }
                if (f.expr?.k === 'ignore') {
                    add({
                        severity: 'error', code: 'vector-ignore', span: f.expr.span ?? f.o.span, related,
                        message: 'The ignore value _ in a vector assignment does not work in KIELER',
                        kieler: `‘_’ undeclared (first use in this function)\n${GCC_FAILED}`,
                        hint: 'Assign the elements you want to change one by one instead.',
                    })
                }
            }
        }
        for (const e of exprs) {
            walkExpr(e, x => {
                if (x.k !== 'op') return
                if (x.op === '>>>') {
                    add({
                        severity: 'error', code: 'unsigned-shift', span: x.span, related,
                        message: 'C has no >>> operator, so KIELER\'s generated code does not compile',
                        kieler: `expected expression before ‘>’ token\n${GCC_FAILED}`,
                        hint: 'Use >> instead (an arithmetic shift, which keeps the sign).',
                    })
                }
                if (x.op === 'val') {
                    add({
                        severity: 'error', code: 'val-not-signal', span: x.span, related,
                        message: '`val()` only works directly on a valued signal: `val(pre(V))`, `val(S)` of a pure signal and `val(x)` of a variable do not compile',
                        kieler: `implicit declaration of function ‘val’ [-Wimplicit-function-declaration]\n${GCC_FAILED}`,
                        hint: 'For last tick\'s value of a valued signal write `pre(val(V))`.',
                    })
                }
                if ((x.op === '+' || x.op === '-' || x.op === '*' || x.op === '/' || x.op === '%') && x.args.some(isString)) {
                    add({
                        severity: 'error', code: 'string-arithmetic', span: x.span, related,
                        message: 'Strings cannot be joined or calculated with: KIELER\'s strings are C char pointers',
                        kieler: `invalid operands to binary ${x.op} (have ‘char *’ and ‘char *’)\n${GCC_FAILED}`,
                        hint: 'Use separate string variables, or numbers, instead of building strings.',
                    })
                }
            })
        }
    }
    return out
}

/**
 * Names with a prime (`x'`) or an escape caret (`^max`): KIELER's grammar takes them (a valued object's name is a
 * PrimeID, kept as written), but its C code uses the name as it is, and gcc fails (probes rare/probe-prime-*,
 * rare/probe-caret-*). It concerns what reaches C: variables and signals at any level, class and struct members, the
 * parameters and locals of a method that is called, and the name of a called method that is not inlined (with a
 * prime only: a caret in a method name compiles). Constants (inlined), states and regions (the caret is dropped;
 * a prime is a syntax error there) are fine.
 */
function cNames(root: CState): Diagnostic[] {
    const out: Diagnostic[] = []
    const prime = (name: string) => name.includes("'")
    const caret = (name: string) => name.startsWith('^')
    const report = (v: CVar, name: string, what: string, gcc: string | undefined) => {
        const isPrime = prime(name)
        out.push({
            severity: 'error', code: 'c-name', span: v.span, related: v.decl ? [v.decl] : undefined,
            message: isPrime
                ? `The ${what} \`${name}\` has a prime in its name: KIELER accepts it, but its C code cannot use the name, so it does not compile`
                : `The ${what} \`${name}\` keeps its \`^\` in KIELER's C code, which does not compile`,
            kieler: gcc ? `${gcc}\n${GCC_FAILED}` : GCC_FAILED,
            hint: isPrime
                ? `C names cannot contain \`'\`. Rename it, for example \`${name.replace(/'/g, '') || 'x'}2\`.`
                : KEYWORDS.has(name.slice(1))
                    ? `A \`^\` lets a keyword be a name in SCTX, but a ${what} keeps it in C, where it is not allowed. Choose a name that is not a keyword, for example \`${name.slice(1)}Value\` (a state or region may keep its \`^\`).`
                    : `A \`^\` lets a keyword be a name in SCTX, but a ${what} keeps it in C, where it is not allowed. \`${name.slice(1)}\` is not a keyword: write it without the \`^\`.`,
        })
    }
    const PRIME_GCC = "missing terminating ' character"
    const { called } = reachingC(root)

    for (const scope of allScopes(root)) {
        for (const v of scope.decls) {
            if (v.const || v.generated) continue
            if (v.declKind === 'method') {
                const m = v.method
                if (!m || !called.has(v)) continue
                const name = v.member ? v.member.name : v.name
                if (prime(name) && !isInlined(m)) report(v, name, 'method', PRIME_GCC)
                // Current KIELER compiles a C function with a caret name; official KIELER 0.3.0 does not (S-71).
                if (caret(name) && !isInlined(m)) {
                    out.push({
                        severity: 'warning', code: 'kieler-divergence', span: v.span, related: v.decl ? [v.decl] : undefined,
                        message: `Official KIELER 0.3.0 cannot compile this chart: its C code keeps the \`^\` of the method name \`${name}\``,
                        kieler: GCC_FAILED,
                        hint: `Current KIELER and SCCharts Lab compile it, and so does the guide. To be safe with every version, write the name without the \`^\`${KEYWORDS.has(name.slice(1)) ? `, or choose another one (\`${name.slice(1)}Value\`)` : ''}.`,
                    })
                }
                for (const p of [...m.params, ...m.locals]) {
                    const local = m.locals.includes(p)
                    if (prime(p.name)) report(p, p.name, local ? 'local variable' : 'parameter', PRIME_GCC)
                    // An inlined method's parameters and locals become variables of the chart (with a prefix); a C
                    // function's locals are its own.
                    else if (caret(p.name)) report(p, p.name, local ? 'local variable' : 'parameter', isInlined(m)
                        ? 'expected ‘:’, ‘,’, ‘;’, ‘}’ or ‘__attribute__’ before ‘^’ token'
                        : local ? 'expected identifier or ‘(’ before ‘^’ token' : undefined)
                }
                continue
            }
            if (v.declKind) continue
            const name = v.member ? v.member.name : v.name
            const what = v.member ? 'member' : v.signal ? 'signal' : 'variable'
            if (prime(name)) report(v, name, what, PRIME_GCC)
            // At the top level the name is a member of the tick data as it is; further in KIELER prefixes it.
            else if (caret(name)) report(v, name, what, scope === root || v.member ? 'expected identifier or ‘(’ before ‘^’ token' : 'expected ‘:’, ‘,’, ‘;’, ‘}’ or ‘__attribute__’ before ‘^’ token')
        }
    }
    return out
}

/** The expressions of an SCL body, in order. */
function bodyExprs(list: CStmt[], out: CExpr[] = []): CExpr[] {
    const add = (e: CExpr | undefined) => { if (e) out.push(e) }
    for (const st of list) {
        if (st.k === 'do') out.push(...effectExprs(st.f))
        else if (st.k === 'if') { add(st.cond); bodyExprs(st.then, out); if (st.else) bodyExprs(st.else, out) }
        else if (st.k === 'while') { add(st.cond); bodyExprs(st.body, out) }
        else if (st.k === 'for') { bodyExprs(st.init, out); add(st.cond); bodyExprs(st.update, out); bodyExprs(st.body, out) }
        else if (st.k === 'return') add(st.expr)
        else if (st.k === 'expr') add(st.e)
    }
    return out
}

/**
 * What reaches KIELER's C code: the methods that are called somewhere (an uncalled one gets no C code; code effects
 * are methods too), and every expression of the triggers, effects, initial values and called methods' bodies, with
 * the element it belongs to (for `related`).
 */
function reachingC(root: CState): { called: Set<CVar>; exprs: { e: CExpr; related?: string[] }[] } {
    const called = new Set<CVar>()
    const exprs: { e: CExpr; related?: string[] }[] = []
    const pending: CVar[] = []
    const visit = (e: CExpr | undefined, related?: string[]) => {
        if (!e) return
        exprs.push({ e, related })
        walkExpr(e, x => {
            if (x.k !== 'call' || !x.target) return
            let r = x.target
            while (r.sub) r = r.sub
            const m = r.v
            if (m.method && !called.has(m)) {
                called.add(m)
                pending.push(m)
            }
        })
    }
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const by = holder.origin ?? holder.about
        const related = by ? [by] : undefined
        visit(holder.trigger, related)
        for (const f of holder.effects) for (const e of effectExprs(f)) visit(e, related)
    }
    for (const scope of allScopes(root)) for (const v of scope.decls) visit(v.init, v.decl ? [v.decl] : undefined)
    while (pending.length) {
        const m = pending.pop()!
        const related = m.method!.by ? [m.method!.by] : m.decl ? [m.decl] : undefined
        for (const e of bodyExprs(m.method!.body)) visit(e, related)
    }
    return { called, exprs }
}

/**
 * A string literal as KIELER writes it into its C code: the value between quotes, with the escapes the parser
 * resolved (a `\n` is a line break in the C file, a `\"` ends the literal there). `open`: gcc's lexer finds the
 * literal unterminated (`missing terminating " character`); `split`: a quote in the value ends the literal early, and
 * what follows is not C (probe rare/probe-string-quotes).
 */
function cStringProblem(value: string): 'open' | 'split' | undefined {
    const text = `"${value}"`
    let inString = false
    let split = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (inString) {
            if (c === '\\') i++
            else if (c === '"') inString = false
            else if (c === '\n' || c === '\r') return 'open'
        } else if (c === '"') inString = true
        else if (!/\s/.test(c)) split = true
    }
    if (inString) return 'open'
    return split ? 'split' : undefined
}

/** gcc's name for the type of an operand, when it is certain (KIELER's `float` is C's `double`). */
function cOperandType(e: CExpr): 'double' | 'int' | undefined {
    if (e.k === 'lit') return e.t === 'float' ? 'double' : e.t === 'int' ? 'int' : undefined
    if (e.k === 'ref') {
        let r = e
        while (r.sub) r = r.sub
        if (r.idx.length < r.v.dims.length) return undefined
        return r.v.type === 'float' ? 'double' : r.v.type === 'int' ? 'int' : undefined
    }
    if (e.k === 'op' && (e.op === '+' || e.op === '-' || e.op === '*' || e.op === '/') && e.args.length >= 2) {
        const types = e.args.map(cOperandType)
        if (types.some(t => t === undefined)) return undefined
        return types.includes('double') ? 'double' : 'int'
    }
    return undefined
}

const isFloatOperand = (e: CExpr): boolean => {
    if (e.k === 'lit') return e.t === 'float'
    if (e.k === 'ref') {
        let r = e
        while (r.sub) r = r.sub
        return r.v.type === 'float'
    }
    return cOperandType(e) === 'double'
}

/**
 * C text KIELER writes as it is, which gcc then rejects (probes rare/probe-string-*, rare/probe-float-modulo-*,
 * rare/probe-d-*): a string literal with a line break or a quote in it, `%` on a float, and a variable `d` in a
 * method KIELER keeps as a C function, whose tick data parameter is called `d`.
 */
function cText(root: CState): Diagnostic[] {
    const out: Diagnostic[] = []
    const { called, exprs } = reachingC(root)
    for (const { e, related } of exprs) {
        walkExpr(e, x => {
            const problem = x.k === 'lit' && x.t === 'string' ? cStringProblem(String(x.v)) : undefined
            if (problem) {
                out.push({
                    severity: 'error', code: 'c-string', span: x.span, related,
                    message: 'KIELER writes this string into its C code as it is, and the line break or the quote in it breaks the C code',
                    kieler: problem === 'open' ? `missing terminating " character\n${GCC_FAILED}` : GCC_FAILED,
                    hint: 'Leave `\\n`, `\\r` and `\\"` (and line breaks) out of strings, which KIELER\'s C code cannot hold; for a quote inside a string, use `\'`.',
                })
            }
            // An extern function named without parentheses: KIELER writes the name as it is, which C does not know
            // (the validator's warning extern-without-call comes first; probe rare/probe-extern-without-call).
            if (x.k === 'ref' && x.v.extern && !x.sub) {
                out.push({
                    severity: 'error', code: 'extern-not-called', span: x.span, related,
                    message: `\`${x.v.name}\` is an external function, so KIELER's C code needs a call: \`${x.v.name}(…)\``,
                    kieler: `‘${x.v.name}’ undeclared (first use in this function)\n${GCC_FAILED}`,
                    hint: `Call it with parentheses and its arguments, as in \`${x.v.name}(x)\`.`,
                })
            }
            if (x.k === 'op' && x.op === '%' && x.args.length === 2 && x.args.some(isFloatOperand)) {
                const [a, b] = x.args.map(cOperandType)
                out.push({
                    severity: 'error', code: 'c-float-modulo', span: x.span, related,
                    message: 'C has no `%` for floats, so KIELER\'s generated code does not compile',
                    kieler: a && b ? `invalid operands to binary % (have ‘${a}’ and ‘${b}’)\n${GCC_FAILED}` : GCC_FAILED,
                    hint: 'Keep `%` for whole numbers (`int`). For a float, subtract the whole multiples yourself, or compute with ints.',
                })
            }
        })
    }
    // `x %= 2.5` on a float target, or with a float operand.
    const assigns = (list: CEffect[], related?: string[]) => {
        for (const f of list) {
            if (f.k !== 'assign' || f.op !== '%=' || !f.expr) continue
            if (!isFloatOperand(f.ref) && !isFloatOperand(f.expr)) continue
            const [a, b] = [cOperandType(f.ref), cOperandType(f.expr)]
            out.push({
                severity: 'error', code: 'c-float-modulo', span: f.o.span, related,
                message: 'C has no `%=` for floats, so KIELER\'s generated code does not compile',
                kieler: a && b ? `invalid operands to binary % (have ‘${a}’ and ‘${b}’)\n${GCC_FAILED}` : GCC_FAILED,
                hint: 'Keep `%` for whole numbers (`int`). For a float, subtract the whole multiples yourself, or compute with ints.',
            })
        }
    }
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const by = holder.origin ?? holder.about
        assigns(holder.effects, by ? [by] : undefined)
    }
    const effectsOf = (list: CStmt[], acc: CEffect[] = []): CEffect[] => {
        for (const st of list) {
            if (st.k === 'do') acc.push(st.f)
            else if (st.k === 'if') { effectsOf(st.then, acc); if (st.else) effectsOf(st.else, acc) }
            else if (st.k === 'while') effectsOf(st.body, acc)
            else if (st.k === 'for') { effectsOf(st.init, acc); effectsOf(st.update, acc); effectsOf(st.body, acc) }
        }
        return acc
    }
    for (const m of called) {
        const related = m.decl ? [m.decl] : m.method!.by ? [m.method!.by] : undefined
        assigns(effectsOf(m.method!.body), related)
        // A C function's first parameter is the tick data, `TickData* d` (an inlined method's variables get a prefix).
        const method = m.method!
        if (isInlined(method) || m.member) continue
        const nested = new Set<CVar>()
        const inner = (list: CStmt[], top: boolean) => {
            for (const st of list) {
                if (st.k === 'do' && !top && st.f.k === 'assign' && st.f.o.hidden) nested.add(st.f.ref.v)
                else if (st.k === 'if') { inner(st.then, false); if (st.else) inner(st.else, false) }
                else if (st.k === 'while') inner(st.body, false)
                else if (st.k === 'for') { inner(st.init, false); inner(st.body, false) }
            }
        }
        inner(method.body, true)
        const name = m.generated ? 'code block' : `method \`${m.name}\``
        for (const p of method.params) {
            if (p.name !== 'd') continue
            out.push({
                severity: 'error', code: 'c-name', span: p.span ?? m.span, related: m.decl ? [m.decl] : undefined,
                message: `The parameter \`d\` of the ${name} clashes with KIELER's C code, which calls the chart's data \`d\``,
                kieler: p.type === 'int' || p.type === 'float' ? `conflicting types for ‘d’; have ‘${p.type === 'int' ? 'int' : 'double'}’\n${GCC_FAILED}` : GCC_FAILED,
                hint: 'Rename the parameter (for example `delta`).',
            })
        }
        for (const v of method.locals) {
            if (v.name !== 'd' || nested.has(v)) continue
            out.push({
                severity: 'error', code: 'c-name', span: v.span ?? m.span, related: m.decl ? [m.decl] : m.method!.by ? [m.method!.by] : undefined,
                message: `The local variable \`d\` of the ${name} clashes with KIELER's C code, which calls the chart's data \`d\``,
                kieler: `‘d’ redeclared as different kind of symbol\n${GCC_FAILED}`,
                hint: 'Rename the variable (for example `delta`).',
            })
        }
    }
    return out
}

function isString(e: CExpr): boolean {
    if (e.k === 'lit') return e.t === 'string'
    if (e.k === 'ref') {
        let r = e
        while (r.sub) r = r.sub
        return r.v.type === 'string'
    }
    return false
}

export type { Span }

/**
 * A conditional without an else part (`c ? a`) where KIELER's C code has nothing to put in its place. Its code
 * generator writes `c ? a : __CONDSELF__` and replaces the placeholder by the target of the assignment the
 * conditional is in (an inlined body's statements and a condition's guard are assignments too, ExprCompiler.selves);
 * anywhere else (print, a call that is a whole effect, an assignment's target index, the conditions and returns of a
 * method KIELER keeps as a C function) gcc rejects it (probes kieler/rare/probe-cond-noelse-*). Runs on the graph
 * after the Methods processor, whose inlining moves arguments into the bodies.
 */
export function conditionalWithoutElse(nodes: { kind: string; effect?: CEffect; expr?: CExpr }[]): Diagnostic[] {
    const out: Diagnostic[] = []
    const seen = new Set<CExpr>()
    const bare = (e: CExpr | undefined) => {
        walkExpr(e, x => {
            if (x.k === 'op' && x.op === '?:' && x.args.length === 2 && !seen.has(x)) {
                seen.add(x)
                if (!out.length) {
                    out.push({
                        severity: 'error', code: 'conditional-without-else', span: x.span,
                        message: 'A conditional without an else part only works in an assignment or a condition: here KIELER\'s C code does not compile',
                        kieler: `‘__CONDSELF__’ undeclared (first use in this function)\n${GCC_FAILED}`,
                        hint: 'KIELER writes `(c) ? a` in `x = ...` as `(c) ? a : x`, and in a trigger it keeps the previous result when `c` is false; in `print`, in the arguments of a call on its own, in an array index you assign to or in a method KIELER compiles as a C function it has nothing to put there. Write the else part: `(c) ? a : b`.',
                    })
                }
            }
        })
    }
    const methods = new Set<CVar>()
    const calls = (e: CExpr | undefined) => walkExpr(e, x => { if (x.k === 'call' && !x.extern && x.target?.v.method && !isInlined(x.target.v.method)) methods.add(x.target.v) })
    const effect = (f: CEffect) => {
        switch (f.k) {
            case 'assign': f.ref.idx.forEach(bare); f.ref.idx.forEach(calls); calls(f.expr); break
            case 'emit': f.ref.idx.forEach(bare); calls(f.value); break
            case 'print': f.args.forEach(bare); f.args.forEach(calls); break
            case 'call': f.call.args.forEach(bare); calls(f.call); break
            default: break
        }
    }
    for (const n of nodes) {
        if (n.kind === 'cond') calls(n.expr)
        else if (n.effect) effect(n.effect)
    }
    // The bodies of the methods that stay C functions (and of the methods they call).
    const done = new Set<CVar>()
    const body = (list: CStmt[]) => {
        for (const st of list) {
            switch (st.k) {
                case 'do': effect(st.f); break
                case 'if': bare(st.cond); calls(st.cond); body(st.then); if (st.else) body(st.else); break
                case 'while': bare(st.cond); calls(st.cond); body(st.body); break
                case 'for': body(st.init); bare(st.cond); calls(st.cond); body(st.update); body(st.body); break
                case 'return': bare(st.expr); calls(st.expr); break
                case 'expr': bare(st.e); calls(st.e); break
                default: break
            }
        }
    }
    for (let grew = true; grew;) {
        grew = false
        for (const m of [...methods]) {
            if (done.has(m)) continue
            done.add(m)
            grew = true
            body(m.method!.body)
        }
    }
    return out
}

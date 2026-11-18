// What gcc refuses in KIELER's C code where an array (or a string) stands for a value: the static side of
// pointers.ts (basics.md B-28a). It runs on the code KIELER writes: the graph's nodes after the Methods processor
// (a short method is copied into place, so its parameters are the arguments by then), every condition as a `char`
// guard (`_cg = <condition>`), and the bodies of the methods KIELER keeps as C functions, whose parameters are single
// values (`int p`) and whose conditions are plain C conditions.

import type { Diagnostic, Span } from '../types'
import { isFloatExpression, sourceText } from './eval'
import { allActionSites, effectExprs, walkExpr, type CEffect, type CExpr, type CRef, type CState, type CStmt, type CVar } from './model'
import {
    assignRule, binaryRule, CHAR, conditionalRule, CTyper, DOUBLE, elementType, INT, isPtr, pointerIn, ptr, referenceType,
    type CTy, type Destination, type Typed, type TypeProblem,
} from './pointers'
import { guardCondition } from './guardIndices'
import { isInlined } from './structure/methods'

const GCC_FAILED = 'Compiler did not return success (exit value != 0)'
const lowermost = (r: CRef): CRef => (r.sub ? lowermost(r.sub) : r)
const label = (v: CVar) => v.display ?? v.name

/** The code a check looks at: the graph's nodes and the methods KIELER keeps as C functions. */
export interface CheckedCode {
    nodes: { kind: string; effect?: CEffect; expr?: CExpr; transition?: { origin?: string; about?: string }; method?: unknown }[]
    functions: Iterable<CVar>
    root: CState
    /** The inputs something writes (KIELER's copy propagation keeps the guard of a condition that reads one). */
    writtenInputs?: Set<CVar>
}

class Checker {
    readonly out: Diagnostic[] = []
    private readonly seen = new Set<string>()
    private readonly scalars = new Set<CVar>()
    private related: string[] | undefined
    /** The method whose body is being checked (a C function). */
    private fn: CVar | undefined
    private readonly typer: CTyper

    constructor(private readonly root: CState, private readonly kept: (v: CVar) => boolean, nullPointer = false) {
        this.typer = new CTyper({
            scalar: v => this.scalars.has(v),
            call: e => this.call(e),
            report: p => this.problem(p),
            pair: (o, left, right, at) => this.pair(o, left, right, at),
            uses: (at, typed) => this.uses(at, typed),
            nullPointer,
        })
    }

    /** An operator that compiles with an array among its operands: it works on the array's address, which is
     *  hardly what the chart means. One warning per array named. */
    private uses(at: CExpr, typed: Typed) {
        if (typed.str) return
        const p = pointerIn(at)
        if (!p || p.k !== 'ref') return
        const { name, element, span, row } = this.pointerName(p)
        this.add({
            severity: 'warning', code: 'array-address', span: span ?? ('span' in at ? at.span : undefined),
            message: `\`${this.text(at)}\` works with the address of the ${row ? 'row' : 'array'} \`${name}\`, not with its elements`,
            hint: `In KIELER's C code the name of an array without its indices is the array's address: as a condition it is always true, two arrays compare by where they lie in memory (never equal), and a difference counts the elements between them. The guide's simulation does the same. Name the elements you mean (\`${element}\`).`,
        })
    }

    // ----- addresses the simulator cannot know -----

    /** A local array of the C function being checked: it lies on the stack, where gcc decides. */
    private local(v: CVar): boolean {
        return !!this.fn?.method?.locals.includes(v) && v.dims.length > 0
    }

    /** The variables a pointer can point into (undefined: not told from the expression). */
    private origins(e: CExpr | undefined): Set<CVar | 'string'> | undefined {
        if (!e) return undefined
        if (e.k === 'lit') return new Set(e.t === 'string' ? ['string' as const] : [])
        if (e.k === 'null') return new Set()
        if (e.k === 'ref') {
            const v = lowermost(e).v
            return new Set([v.type === 'string' && e.idx.length >= v.dims.length ? 'string' as const : v])
        }
        if (e.k !== 'op') return undefined
        if (e.op === '?:' && e.args.length === 3) {
            const [a, b] = [this.origins(e.args[1]), this.origins(e.args[2])]
            return a && b ? new Set([...a, ...b]) : undefined
        }
        if ((e.op === '+' || e.op === '-') && e.args.length === 2) {
            const pointers = e.args.filter(x => { const t = this.typer.type(x); return !!t && isPtr(t.t) })
            return pointers.length === 1 ? this.origins(pointers[0]) : undefined
        }
        return undefined
    }

    private mentionsLocal(e: CExpr): CVar | undefined {
        let found: CVar | undefined
        const visit = (x: CExpr) => {
            if (x.k === 'ref') { if (this.local(lowermost(x).v) && lowermost(x).idx.length < lowermost(x).v.dims.length) found ??= lowermost(x).v; x.idx.forEach(visit) }
            else if (x.k === 'op' || x.k === 'call') x.args.forEach(visit)
        }
        visit(e)
        return found
    }

    /** Two pointers subtracted or put in order: known inside one variable and inside the chart's struct, and for a
     *  local against the struct (the stack lies above it); between two locals gcc's stack layout decides. */
    private pair(o: string, left: CExpr | undefined, right: CExpr, at: CExpr) {
        const [l, r] = [this.origins(left), this.origins(right)]
        const local = this.mentionsLocal(at)
        const strings = [l, r].some(x => x?.has('string'))
        if (!local && !(strings && o === '-')) return
        if (l && r) {
            const all = [...l, ...r]
            if (l.size === 1 && r.size === 1 && all[0] === all[1] && all[0] !== 'string') return
            const isLocal = (x: CVar | 'string') => x !== 'string' && this.local(x)
            const chart = (x: CVar | 'string') => x !== 'string' && !this.local(x)
            if (o !== '-' && !strings && (([...l].every(isLocal) && [...r].every(chart)) || ([...l].every(chart) && [...r].every(isLocal)))) return
        }
        this.unknown(at, local, o === '-' ? 'the distance between' : 'the order of')
    }

    private unknown(at: CExpr, local: CVar | undefined, what: string) {
        const method = this.fn ? (this.fn.member?.name ?? this.fn.name) : undefined
        this.add({
            severity: 'info', code: 'unsupported', span: 'span' in at ? at.span : undefined,
            message: local
                ? `The guide's simulator cannot run ${what} the local array \`${local.name}\` of \`${method}\`${/address/.test(what) ? '' : ' and something else in memory'}`
                : `The guide's simulator cannot run ${what} a string and an array in memory`,
            hint: local
                ? `KIELER keeps \`${method}\` as a C function, and its local array lies on the C program's stack: where exactly, gcc decides, and KIELER's number comes from there. The official KIELER tools run this chart; it is hardly what the chart means, though: name the elements (\`${local.name}[0]\`).`
                : 'KIELER\'s C code subtracts two addresses that have nothing to do with each other; the number comes from where the C program\'s memory lies. The official KIELER tools run this chart.',
        })
    }

    /** A C function's parameters are single values. */
    scalarParams(m: CVar) {
        for (const p of m.method?.params ?? []) this.scalars.add(p)
    }

    private add(d: Diagnostic) {
        const key = `${d.code}:${d.span?.start ?? ''}:${d.kieler ?? d.message}`
        if (this.seen.has(key)) return
        this.seen.add(key)
        this.out.push({ ...d, related: d.related ?? this.related })
    }

    private text(e: CExpr | undefined): string {
        return (e && sourceText(e, label)) ?? '...'
    }

    /** The array (or string) an expression's pointer comes from, as written. */
    private pointerName(e: CExpr | undefined): { name: string; element: string; str: boolean; span?: Span; row: boolean } {
        const p = pointerIn(e)
        if (!p) return { name: this.text(e), element: `${this.text(e)}[0]`, str: false, span: e && 'span' in e ? e.span : undefined, row: false }
        const str = p.k === 'lit' || (p.k === 'ref' && !!referenceType(p).typed?.str)
        // `element`: one of its elements, as an example (`a[0]`, `m[1][0]`).
        const low = p.k === 'ref' ? lowermost(p) : undefined
        const missing = low ? Math.max(1, low.v.dims.length - low.idx.length) : 1
        return { name: this.text(p), element: `${this.text(p)}${'[0]'.repeat(missing)}`, str, span: 'span' in p ? p.span : undefined, row: !!low?.idx.length }
    }

    // ----- what the typer finds inside an expression -----

    private problem(p: TypeProblem) {
        const span = ('span' in p.at ? p.at.span : undefined)
        const { name, element, str } = this.pointerName(p.pointer ?? p.at)
        const kieler = `${p.gcc}\n${GCC_FAILED}`
        const address = `In KIELER's C code the name of an array without its indices is the array's address, and C only lets an address be compared, tested, subtracted from another address of the same kind, or moved by a whole number.`
        switch (p.kind) {
            case 'vector':
                this.add({
                    severity: 'error', code: 'const-array-value', span, kieler,
                    message: 'A constant array is used as a whole here: KIELER puts its values in its place, which its C code cannot have inside an expression',
                    hint: 'KIELER replaces a constant by its value where the chart names it, and the value of a constant array is the list `{...}`. Name the element you mean (`k[0]`), or use a variable array.',
                })
                return
            case 'subscript':
                this.add({
                    severity: 'error', code: 'array-index', span, kieler,
                    message: str ? `\`${name}\` is a string: it cannot be an index` : `\`${name}\` is an array: it cannot be an index`,
                    hint: str ? 'An index is a whole number. KIELER\'s strings are C char pointers.' : `An index is a whole number. Name the element you mean (\`${element}\`). ${address}`,
                })
                return
            case 'scalar-subscript': {
                const r = p.at as CRef
                const v = lowermost(r).v
                const param = this.fn?.method?.params.includes(v)
                const method = this.fn ? (this.fn.member?.name ?? this.fn.name) : undefined
                this.add(param ? {
                    severity: 'error', code: 'method-array-parameter', span: v.span ?? span, kieler, related: this.fn?.decl ? [this.fn.decl] : undefined,
                    message: `KIELER's C code for the method \`${method}\` does not compile: its parameter \`${v.name}\` is an array, which KIELER's C declares as a single ${v.type === 'float' ? 'double' : v.type === 'bool' ? 'char' : 'int'}`,
                    hint: `KIELER keeps \`${method}\` as a C function (it has a loop, or calls another method), and a C function's parameter is one value. Give \`${method}\` the elements it needs as separate parameters, or let it read the chart's array directly instead of a parameter. (A short method without a loop is copied into the place it is called, and there its array parameter is the array you pass.)`,
                } : {
                    severity: 'error', code: 'method-array-parameter', span, kieler,
                    message: `\`${label(v)}\` is a single value, but it is indexed here (\`${this.text(r)}\`): KIELER put it in the place of an array`,
                    hint: `KIELER copies a short method into the place it is called and writes the argument where the body names the parameter. An array parameter needs an array as its argument.`,
                })
                return
            }
            case 'conditional':
                this.add({
                    severity: 'error', code: 'conditional-mismatch', span, kieler,
                    message: str
                        ? 'The two branches of this conditional do not go together in KIELER\'s C code: one is a string, the other is not'
                        : `The two branches of this conditional do not go together in KIELER's C code: \`${name}\` is an array, the other branch is ${/pointer type mismatch/.test(p.gcc) ? 'an array of another kind' : 'a number'}`,
                    hint: str ? 'Give both branches a string (or `null`).' : `Name the element you mean (\`${element}\`). ${address} A conditional may choose between two arrays of the same type (or an array and 0), nothing else.`,
                })
                return
            default: {
                const o = p.op ?? '?'
                if (str) {
                    this.add({
                        severity: 'error', code: 'string-arithmetic', span, kieler,
                        message: 'Strings cannot be joined or calculated with: KIELER\'s strings are C char pointers',
                        hint: 'Use separate string variables, or numbers, instead of building strings.',
                    })
                    return
                }
                this.add({
                    severity: 'error', code: 'array-operands', span, kieler,
                    message: p.kind === 'unary'
                        ? `\`${name}\` is an array: \`${o}\` cannot be applied to it`
                        : `\`${name}\` is an array: it cannot be an operand of \`${o}\` here`,
                    hint: `Name the element you mean (\`${element}\`). ${address}`,
                })
            }
        }
    }

    // ----- calls -----

    private call(e: Extract<CExpr, { k: 'call' }>): Typed | undefined {
        const target = e.extern ? undefined : e.target
        const v = target ? lowermost(target).v : undefined
        const m = v?.method
        if (!v || !m) return undefined
        const result = (): Typed | undefined => {
            switch (m.returnType) {
                case 'int': return { t: INT }
                case 'bool': return { t: CHAR }
                case 'float': return { t: DOUBLE }
                case 'string': return { t: ptr(CHAR), str: true }
                default: return undefined
            }
        }
        if (!this.kept(v)) {
            if (!isInlined(m)) return result()
            // A short method called inside a C function: KIELER copies it into the function, and a body that is one
            // `return` gives the call its expression (in the graph itself the copy was made already).
            const only = this.fn && m.body.length === 1 && m.body[0].k === 'return' ? m.body[0].expr : undefined
            return only ? this.typer.type(only) : undefined
        }
        const params = m.params.filter(p => !p.tags.has('#self'))
        const name = `${this.root.name}_${(v.member?.name ?? v.name).replace(/^.*\./, '')}`
        // The tick data comes first, then, for a class's method, the instance.
        const fixed = m.params.length - params.length + 1
        e.args.forEach((arg, i) => {
            const p = params[i]
            const want = p && elementType(p)
            const typed = this.typer.type(arg)
            if (!want || !typed) return
            const gcc = assignRule(want, typed, { how: 'argument', n: i + fixed + 1, fn: name })
            if (gcc) this.misplaced(gcc, want, typed, arg, { how: 'argument', n: i + fixed + 1, fn: name }, `the parameter \`${p.name}\` of \`${e.name}\``)
        })
        return result()
    }

    // ----- a value put somewhere -----

    /** A pointer where a number is needed, or the other way round. `where` names the destination in source terms. */
    private misplaced(gcc: string, target: CTy, value: Typed, e: CExpr, to: Destination, where: string) {
        const kieler = `${gcc}\n${GCC_FAILED}`
        const span = this.pointerName(e).span ?? ('span' in e ? e.span : undefined)
        if (isPtr(target)) {
            // A string is the target.
            this.add({
                severity: 'error', code: 'string-assignment', span: 'span' in e ? e.span : undefined, kieler,
                message: isPtr(value.t)
                    ? `\`${this.pointerName(e).name}\` is an array: it cannot be ${to.how === 'assign' ? 'assigned to' : to.how === 'return' ? 'returned as' : 'passed as'} a string`
                    : `A number cannot be ${to.how === 'assign' ? 'assigned to' : to.how === 'return' ? 'returned as' : 'passed as'} a string (${where})`,
                hint: 'KIELER\'s strings are C char pointers: a string takes a string, or `null`.',
            })
            return
        }
        const { name, element, str } = this.pointerName(e)
        if (str || value.str) {
            this.add({
                severity: 'error', code: 'string-as-value', span, kieler,
                message: `\`${name}\` is a string: it cannot be used as a number (${where})`,
                hint: 'KIELER\'s strings are C char pointers, and C does not turn a pointer into a number without a cast. Compare the string instead (`s == "on"`), or keep a number next to it.',
            })
            return
        }
        this.add({
            severity: 'error', code: 'array-as-value', span, kieler,
            message: `\`${name}\` is an array: it cannot be used as a single value`,
            hint: `Name the element you mean (\`${element}\`). In KIELER's C code the array's name alone is its address${to.how === 'argument' ? `, and ${where} is a single value` : to.how === 'return' ? ', and the method returns a single value' : ''}.`,
        })
    }

    /** `target op= e` (or `=`) with the types of KIELER's C statement. */
    private assignment(f: Extract<CEffect, { k: 'assign' }>) {
        const low = lowermost(f.ref)
        const v = low.v
        const target = this.typer.type(f.ref)
        if (!target) return
        const scalar = this.scalars.has(v)
        const isArray = !scalar && low.idx.length < v.dims.length
        const where = `\`${this.text(f.ref)}\``
        if (f.op === '++' || f.op === '--') {
            if (isArray) {
                this.add({
                    severity: 'error', code: 'array-assignment', span: f.o.span, related: f.o.by ? [f.o.by] : undefined,
                    message: `\`${label(v)}\` is an array: it cannot be counted up or down as a whole`,
                    kieler: `lvalue required as ${f.op === '++' ? 'increment' : 'decrement'} operand\n${GCC_FAILED}`,
                    hint: `Count an element (\`${v.name}[0]${f.op}\`).`,
                })
            }
            return
        }
        const rhs = f.expr
        if (!rhs) return
        if (rhs.k === 'vector' && !isArray) {
            // A whole constant array assigned to a single variable: KIELER writes its values, `{...}`, there.
            this.typer.type(rhs)
            return
        }
        if (rhs.k === 'vector') {
            // One assignment per element (KIELER's Array Assignment).
            const element = elementType(v)
            const each = (x: CExpr) => {
                if (x.k === 'vector') { x.values.forEach(each); return }
                if (x.k === 'ignore' || !element) return
                this.value(element, v, x, { t: element, str: v.type === 'string' }, '=', where)
            }
            rhs.values.forEach(each)
            return
        }
        if (isArray) {
            this.add({
                severity: 'error', code: 'array-assignment', span: f.o.span, related: f.o.by ? [f.o.by] : undefined,
                message: `\`${label(v)}\` is an array: it cannot be assigned as a whole`,
                kieler: `assignment to expression with array type\n${GCC_FAILED}`,
                hint: `Assign the elements one by one (\`${v.name}[0] = ...\`, \`${v.name}[1] = ...\`) or with a vector, \`${v.name} = {...}\`.`,
            })
            this.typer.type(rhs)
            return
        }
        this.value(target.t, v, rhs, target, f.op, where)
    }

    private value(target: CTy, v: CVar, rhs: CExpr, self: Typed, op: string, where: string) {
        const typed = this.typer.type(rhs, self)
        if (!typed) return
        // KIELER writes `(int)(...)` around a float expression assigned to an int (basics.md B-27): a cast compiles,
        // also from a pointer, whose address it makes a number.
        const cast = v.type === 'int' && !isPtr(target) && isFloatExpression(rhs)
        if (cast && isPtr(typed.t)) this.addressValue(rhs, `\`${label(v)}\` gets`)
        const operand: Typed = cast ? { t: INT } : typed
        let result: Typed = operand
        if (op === 'min=' || op === 'max=') {
            // `x = (x < e) ? x : e`
            const compared = binaryRule(op === 'min=' ? '<' : '>', self, operand)
            if ('error' in compared) { this.problem({ kind: 'operands', gcc: compared.error, at: rhs, op: op === 'min=' ? '<' : '>', pointer: rhs, str: operand.str }); return }
            const chosen = conditionalRule(self, operand)
            if ('error' in chosen) { this.problem({ kind: 'conditional', gcc: chosen.error, at: rhs, pointer: rhs, str: operand.str }); return }
            result = chosen.t
        } else if (op !== '=') {
            const base = op.slice(0, -1)
            const r = binaryRule(base, self, operand)
            if ('error' in r) { this.problem({ kind: 'operands', gcc: r.error, at: rhs, op: base, pointer: rhs, str: operand.str || self.str }); return }
            result = r.t
        }
        const gcc = assignRule(target, result)
        if (gcc) this.misplaced(gcc, target, result, rhs, { how: 'assign' }, where)
    }

    /** A pointer made a number: the address of KIELER's struct shows, which changes with every start. */
    private addressValue(e: CExpr, gets: string) {
        const local = this.mentionsLocal(e)
        if (local) { this.unknown(e, local, 'a number made of the address of'); return }
        const { name, element, span } = this.pointerName(e)
        this.add({
            severity: 'warning', code: 'c-address-value', span: span ?? ('span' in e ? e.span : undefined),
            message: `${gets} the address of the array \`${name}\` here, a number that is different every time KIELER's simulation starts`,
            hint: `\`${name}\` is an array without its indices: its address in KIELER's C code, which a cast or \`print\` turns into a number. Name the element you mean (\`${element}\`). The guide's simulation shows the number for one address of the chart's variables (\`createSimulation\`'s \`address\` option sets another).`,
        })
    }

    effect(f: CEffect) {
        switch (f.k) {
            case 'assign': this.assignment(f); break
            case 'print':
                for (const a of f.args) {
                    const t = this.typer.type(a)
                    if (!t || !isPtr(t.t) || t.str) continue
                    // KIELER's printf takes its conversion from the variable's type: for a float or string array it
                    // reads a double (or text) where the address was passed, and what it prints nobody can tell.
                    const v = a.k === 'ref' ? lowermost(a).v : undefined
                    if (v && (v.type === 'float' || v.type === 'string')) {
                        this.add({
                            severity: 'info', code: 'unsupported', span: a.span,
                            message: `The guide's simulator cannot run \`print\` of the ${v.type} array \`${label(v)}\``,
                            hint: `KIELER's C code passes the array's address to printf and asks it for a ${v.type === 'float' ? 'float' : 'string'}: C prints whatever lies where it looks. Print an element (\`${v.name}[0]\`).`,
                        })
                        continue
                    }
                    this.addressValue(a, '`print` shows')
                }
                break
            case 'call': this.typer.type(f.call); break
            default: break
        }
    }

    /** A condition of the graph: KIELER assigns it to a `char` guard. `inline`: copy propagation puts it into the
     *  guard expression itself, where C tests it as it is. */
    guard(e: CExpr, inline: boolean) {
        const typed = this.typer.type(e, { t: CHAR })
        if (typed && inline && isPtr(typed.t)) this.uses(e, typed)
        if (!typed || inline || !isPtr(typed.t) || typed.str) return
        const { name, element, span } = this.pointerName(e)
        this.add({
            severity: 'error', code: 'array-as-value', span: span ?? ('span' in e ? e.span : undefined),
            message: `\`${name}\` is an array: it cannot be a condition on its own`,
            kieler: `${assignRule(CHAR, typed)}\n${GCC_FAILED}`,
            hint: `KIELER keeps every condition in a \`char\`, and C does not turn an array's address into a \`char\` without a cast. Test an element (\`${element}\`). (Inside a larger condition, as in \`${name} && b\`, the array counts as true: its address is never 0.)`,
        })
    }

    /** The body of a method KIELER keeps as a C function. */
    body(m: CVar) {
        const method = m.method!
        this.fn = m
        this.related = m.decl ? [m.decl] : method.by ? [method.by] : undefined
        const returns: CTy | undefined = method.returnType === 'int' ? INT : method.returnType === 'bool' ? CHAR : method.returnType === 'float' ? DOUBLE : method.returnType === 'string' ? ptr(CHAR) : undefined
        // A C condition takes a pointer as it is.
        const condition = (e: CExpr) => { const t = this.typer.type(e); if (t && isPtr(t.t)) this.uses(e, t) }
        const walk = (list: CStmt[]) => {
            for (const s of list) {
                switch (s.k) {
                    case 'do': this.effect(s.f); break
                    case 'if': condition(s.cond); walk(s.then); if (s.else) walk(s.else); break
                    case 'while': condition(s.cond); walk(s.body); break
                    case 'for': walk(s.init); if (s.cond) condition(s.cond); walk(s.update); walk(s.body); break
                    case 'return': {
                        const typed = s.expr ? this.typer.type(s.expr) : undefined
                        if (!typed || !returns) break
                        const gcc = assignRule(returns, typed, { how: 'return' })
                        if (gcc) this.misplaced(gcc, returns, typed, s.expr!, { how: 'return' }, `the result of \`${m.member?.name ?? m.name}\``)
                        break
                    }
                    case 'expr': this.typer.type(s.e); break
                    default: break
                }
            }
        }
        walk(method.body)
        this.fn = undefined
        this.related = undefined
    }

    node(related: string[] | undefined, run: () => void) {
        this.related = related
        run()
        this.related = undefined
    }
}

/** What gcc refuses in the code KIELER writes for the graph and for the methods it keeps as C functions. */
export function pointerProblems(code: CheckedCode): Diagnostic[] {
    const functions = new Set(code.functions)
    // `null` is a pointer where the C code includes <stdio.h> (print) or <stdlib.h> (random()), which define NULL
    // before KIELER's header would (as 0).
    let header = false
    const look = (e: CExpr | undefined) => walkExpr(e, x => { if (x.k === 'random') header = true })
    const effect = (f: CEffect) => { if (f.k === 'print') header = true; effectExprs(f).forEach(look) }
    const body = (list: CStmt[]) => {
        for (const s of list) {
            if (s.k === 'do') effect(s.f)
            else if (s.k === 'if') { look(s.cond); body(s.then); if (s.else) body(s.else) }
            else if (s.k === 'while') { look(s.cond); body(s.body) }
            else if (s.k === 'for') { body(s.init); look(s.cond); body(s.update); body(s.body) }
            else if (s.k === 'return') look(s.expr)
            else if (s.k === 'expr') look(s.e)
        }
    }
    for (const n of code.nodes) { if (n.effect) effect(n.effect); look(n.expr) }
    for (const m of functions) body(m.method!.body)
    const check = new Checker(code.root, v => functions.has(v), header)
    for (const m of functions) check.scalarParams(m)
    // The C file has the functions first, then the tick's code.
    for (const m of functions) check.body(m)
    for (const n of code.nodes) {
        const by = n.method ? undefined : n.transition?.origin ?? n.transition?.about
        if (n.kind === 'cond' && n.expr) {
            // The condition as KIELER's partial evaluation leaves it; a dropped index is reported with its cause
            // (compile.ts droppedIndices).
            if (guardCondition(n.expr)) continue
            const e = n.expr
            const inline = e.k === 'ref' && !e.sub && lowermost(e).v.input && !code.writtenInputs?.has(lowermost(e).v)
            check.node(by ? [by] : undefined, () => check.guard(e, inline))
        } else if (n.effect) {
            const f = n.effect
            check.node(f.o.by ? [f.o.by] : by ? [by] : undefined, () => check.effect(f))
        }
    }
    return check.out
}

/**
 * The same on the chart before its graph exists (a chart the simulator cannot run still fails in gcc, structure.md
 * S-72): triggers and effects as written. A method call is its declared type there, its arguments are not judged.
 */
export function pointerProblemsOfModel(root: CState): Diagnostic[] {
    const check = new Checker(root, () => false)
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const by = holder.origin ?? holder.about
        const related = by ? [by] : undefined
        if (holder.trigger && !guardCondition(holder.trigger)) check.node(related, () => check.guard(holder.trigger!, false))
        for (const f of holder.effects) check.node(related, () => check.effect(f))
    }
    return check.out
}

/** gcc's first error for a condition as KIELER's code has it (after its partial evaluation), or undefined. */
export function guardError(e: CExpr): string | undefined {
    let first: string | undefined
    const typer = new CTyper({ report: p => { first ??= p.gcc } })
    const typed = typer.type(e, { t: CHAR })
    return first ?? (typed && isPtr(typed.t) ? assignRule(CHAR, typed) : undefined)
}

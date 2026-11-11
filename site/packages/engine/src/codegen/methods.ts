// Methods KIELER does not inline (a loop, a call, 30 nodes or more: sim/structure/methods.ts) stay C functions, as in
// KIELER's generateMethods: `<type> <Chart>_<method>(TickData* d, <parameters>)` with the method's locals declared at
// the top. The body is structured code. A `goto` jumps forward to its label; KIELER's structured code has no jumps
// back, so a `goto` to a label before it (or to one that ends a block) ends the method (as the simulator runs it).

import { walkExpr, type CExpr, type CMethod, type CStmt, type CVar } from '../sim/model'
import { effect, expr, type ExprEnv } from './expr'
import { ctypeOf, dimsOf } from './layout'

export interface MethodsInput {
    /** The environment for the chart's variables (`d->x`). */
    env: ExprEnv
    /** The C name of each method. */
    name(v: CVar): string
    structName: string
}

/** Every method the code calls, directly or through other methods (callees first is not needed: prototypes come first). */
export function calledMethods(exprs: CExpr[]): CVar[] {
    const out: CVar[] = []
    const seen = new Set<CVar>()
    const work: CExpr[] = [...exprs]
    const visit = (e: CExpr) => {
        if (e.k !== 'call' || e.extern) return
        const v = e.target?.v
        if (!v?.method || v.extern || seen.has(v)) return
        seen.add(v)
        out.push(v)
        for (const x of bodyExprs(v.method.body)) work.push(x)
    }
    while (work.length) walkExpr(work.pop(), visit)
    return out
}

/** The expressions of a body (conditions, effects' expressions). */
export function bodyExprs(list: CStmt[]): CExpr[] {
    const out: CExpr[] = []
    const visit = (l: CStmt[]) => {
        for (const s of l) {
            switch (s.k) {
                case 'do': {
                    const f = s.f
                    if (f.k === 'assign') { out.push(f.ref); if (f.expr) out.push(f.expr) }
                    else if (f.k === 'print') out.push(...f.args)
                    else if (f.k === 'call') out.push(f.call)
                    break
                }
                case 'if': out.push(s.cond); visit(s.then); if (s.else) visit(s.else); break
                case 'while': out.push(s.cond); visit(s.body); break
                case 'for': visit(s.init); if (s.cond) out.push(s.cond); visit(s.update); visit(s.body); break
                case 'return': if (s.expr) out.push(s.expr); break
                case 'expr': out.push(s.e); break
                default: break
            }
        }
    }
    visit(list)
    return out
}

const returnType = (m: CMethod) => (m.returnType === 'void' ? 'void' : ctypeOf({ type: m.returnType, hostType: undefined } as CVar))

/** The function's signature (`int Chart_m(TickData* d, int x)`). */
export function signature(v: CVar, input: MethodsInput): string {
    const m = v.method!
    const params = m.params.map(p => `${ctypeOf(p)} ${localName(p)}`)
    return `${returnType(m)} ${input.name(v)}(${[`${input.structName}* d`, ...params].join(', ')})`
}

/** A parameter's or local's C name (`d` is the struct: a for-loop counter `d`, which KIELER declares in the loop's
 *  header, becomes `d_`). */
const localName = (v: CVar) => {
    const name = v.name.replace(/[^A-Za-z0-9_]/g, '_')
    return name === 'd' ? 'd_' : name
}

/** The function: its locals, then its body. */
export function functionCode(v: CVar, input: MethodsInput): string[] {
    const m = v.method!
    const locals = new Map<CVar, string>()
    for (const p of m.params) locals.set(p, localName(p))
    for (const l of m.locals) locals.set(l, localName(l))
    const env: ExprEnv = {
        ...input.env,
        access: x => locals.get(x) ?? input.env.access(x),
        self: undefined,
        dropped: undefined,
    }
    const lines = [`${signature(v, input)} {`]
    for (const l of m.locals) lines.push(`  ${ctypeOf(l)} ${localName(l)}${dimsOf(l).map(n => `[${n}]`).join('')};`)
    const typed = m.returnType !== 'void'
    const end = typed ? 'return 0;' : 'return;'
    block(m.body, 1, [], lines, env, end, forwardTargets(m.body))
    lines.push('}')
    // Keep what the expressions asked for (includes, NULL).
    input.env.usesNull ||= env.usesNull
    return lines
}

/**
 * A statement list. `outer`: the enclosing lists with the position of the statement that contains this list, to find
 * where a `goto` lands (sim/structure/methods.ts compileBlock: the innermost list with the label decides).
 */
function block(list: CStmt[], depth: number, outer: { list: CStmt[]; at: number }[], lines: string[], env: ExprEnv, end: string, targets: Set<string>) {
    const pad = '  '.repeat(depth)
    list.forEach((s, at) => {
        const here = [...outer, { list, at }]
        switch (s.k) {
            case 'do':
                for (const l of effect(s.f, env)) lines.push(pad + l)
                break
            case 'expr':
                lines.push(`${pad}${expr(s.e, env).text};`)
                break
            case 'return':
                lines.push(s.expr ? `${pad}return ${expr(s.expr, env).text};` : `${pad}return;`)
                break
            case 'if':
                lines.push(`${pad}if (${expr(s.cond, env).text}) {`)
                block(s.then, depth + 1, here, lines, env, end, targets)
                if (s.else?.length) {
                    lines.push(`${pad}} else {`)
                    block(s.else, depth + 1, here, lines, env, end, targets)
                }
                lines.push(`${pad}}`)
                break
            case 'while':
                lines.push(`${pad}while (${expr(s.cond, env).text}) {`)
                block(s.body, depth + 1, here, lines, env, end, targets)
                lines.push(`${pad}}`)
                break
            case 'for': {
                const cond = s.cond ? expr(s.cond, env).text : ''
                const init = header(s.init, env)
                const update = header(s.update, env)
                if (init !== undefined && update !== undefined) {
                    // KIELER's `for (i = 1; i < n; i++)`.
                    lines.push(`${pad}for (${init}; ${cond}; ${update}) {`)
                    block(s.body, depth + 1, here, lines, env, end, targets)
                } else {
                    // init; while (cond) { body; update } (SCL has no `continue`).
                    block(s.init, depth, outer, lines, env, end, targets)
                    lines.push(`${pad}while (${cond || '1'}) {`)
                    block(s.body, depth + 1, here, lines, env, end, targets)
                    block(s.update, depth + 1, here, lines, env, end, targets)
                }
                lines.push(`${pad}}`)
                break
            }
            case 'label':
                // Only the labels C jumps to (the others have no code in KIELER's structured C either).
                if (targets.has(s.name)) lines.push(`${pad.slice(2)}${s.name}: ;`)
                break
            case 'goto':
                lines.push(pad + (jumpsForward(s.target, here) ? `goto ${s.target};` : end))
                break
            case 'unsupported':
                env.fail(s.what)
                break
        }
    })
}

/** A for loop's init or update as one C expression (one simple effect), or undefined. */
function header(list: CStmt[], env: ExprEnv): string | undefined {
    if (list.length > 1) return undefined
    if (!list.length) return ''
    const s = list[0]
    if (s.k !== 'do' || (s.f.k !== 'assign' && s.f.k !== 'call')) return undefined
    const code = effect(s.f, env)
    return code.length === 1 && !code[0].includes(' ? ') ? code[0].replace(/;$/, '') : undefined
}

/** The labels of a body that some `goto` jumps forward to. */
function forwardTargets(body: CStmt[]): Set<string> {
    const out = new Set<string>()
    const walk = (list: CStmt[], outer: { list: CStmt[]; at: number }[]) => {
        list.forEach((s, at) => {
            const here = [...outer, { list, at }]
            if (s.k === 'goto' && jumpsForward(s.target, here)) out.add(s.target)
            else if (s.k === 'if') { walk(s.then, here); if (s.else) walk(s.else, here) }
            else if (s.k === 'while') walk(s.body, here)
            else if (s.k === 'for') { walk(s.init, outer); walk(s.body, here); walk(s.update, here) }
        })
    }
    walk(body, [])
    return out
}

/** A `goto` that C can take: to a label after it in the innermost list that has the label, not at that list's end. */
function jumpsForward(label: string, stack: { list: CStmt[]; at: number }[]): boolean {
    for (let k = stack.length - 1; k >= 0; k--) {
        const { list, at } = stack[k]
        const to = list.findIndex(s => s.k === 'label' && s.name === label)
        if (to < 0) continue
        const trailing = list.slice(to + 1).every(s => s.k === 'label')
        return to > at && !trailing
    }
    return false
}

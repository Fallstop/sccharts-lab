// Methods and code effects (structure.md S-43, S-44).
//
// KIELER compiles a method into an SCG of its own, and its SCG Methods processor (scg/processors/MethodProcessor
// .xtend) inlines every call of a *simple* method (fewer than 30 nodes, no loop, no call inside) into the caller's
// SCG: the body's nodes come before the calling node, parameters are replaced by the arguments, and a body with
// exactly one `return` gives the call its expression (otherwise a return variable). The inlined reads and writes are
// then the caller's for the dependency analysis. Other methods stay C functions: their bodies are invisible to the
// analysis (only the arguments are read), and the simulator interprets them when they are called. Code effects
// `do { ... }` are methods too (lower.ts makes them `_effect<n>`), so they are inlined like any short method.

import type { Diagnostic, Span } from '../../types'
import { compileEffect, SimError, type Compiled, type ExprCompiler, type Runtime } from '../eval'
import {
    CVar, copyEffect, copyExpr, type CEffect, type CExpr, type CMethod, type CRef, type CStmt,
} from '../model'
import type { SCG, SNode } from '../scg'
import { convert, ctypeOf, defaultValue, type CType, type RValue } from '../values'
import { rewriteEffect, rewriteExpr, type Rewriter } from './rewrite'

/** KIELER's limit for inlining (MethodProcessor.isSimpleMethod: fewer than 30 SCG nodes). */
const SIMPLE_NODES = 30
/** A loop in a method running longer than this is reported (KIELER's C code would hang). */
const LOOP_LIMIT = 1_000_000

// ---------------------------------------------------------------------------------------------------
// Running a method (the C function KIELER generates)
// ---------------------------------------------------------------------------------------------------

/**
 * How a block ends early: a `return` (with its value), a `goto` to a label of an enclosing block, or the end of the
 * method (`end`: what KIELER's C code makes of a jump back, below).
 */
type Flow = { ret: RValue } | { goto: string; span?: Span } | { end: true } | undefined
type Step = (rt: Runtime) => Flow

const compiling = new WeakMap<CMethod, { body?: Step }>()

const methodType = (m: CMethod): CType => (m.returnType === 'void' ? 'int' : ctypeOf(m.returnType))

/** A call of a method: evaluates the arguments, binds the parameters, runs the body, gives the return value. */
export function compileMethodCall(ec: ExprCompiler, call: Extract<CExpr, { k: 'call' }>, m: CMethod): Compiled {
    const args = call.args.map(a => ec.compile(a))
    const params = m.params.map(p => ({ slot: ec.ctx.info(p).slot, type: ec.ctx.info(p).type }))
    const type = methodType(m)
    let cell = compiling.get(m)
    if (!cell) compiling.set(m, (cell = {}))
    const holder = cell
    const span = call.span
    const name = call.name
    return {
        fn: rt => {
            // Compiled on first use, so recursive methods compile.
            if (!holder.body) holder.body = compileBlock(ec, m.body, name)
            const values = args.map(a => a.fn(rt))
            params.forEach((p, i) => { rt.vals[p.slot] = convert(values[i] ?? defaultValue(p.type), args[i]?.type === 'f32' ? 'float' : (args[i]?.type ?? p.type) as CType, p.type) })
            const flow = holder.body(rt)
            if (m.returnType === 'void') return 0
            if (!flow || !('ret' in flow)) throw new SimError(`The method ${name} ended without returning a value`, span, 'missing-return', 'In C the result would be undefined. Make every path of the method end with `return`.')
            return flow.ret
        },
        type,
    }
}

/**
 * A statement list of a method KIELER compiles to a C function. KIELER generates that function from the method's
 * graph with structured code, which has no jumps: a `goto` to a label before it leads to code already written out, so
 * the jump is dropped and the rest of the method only runs when it is not taken (the method ends there); a `goto` to a
 * label that ends a nested block goes to the method's end, where KIELER puts such labels (probes
 * kieler/rare/probe-goto-*). A jump forward skips to its label.
 */
function compileBlock(ec: ExprCompiler, list: CStmt[], method: string): Step {
    const steps = list.map(s => compileStatement(ec, s, method))
    const labels = new Map<string, number>()
    list.forEach((s, i) => { if (s.k === 'label') labels.set(s.name, i) })
    // A label followed only by labels: nothing of this list comes after it.
    const trailing = new Set([...labels].filter(([, i]) => list.slice(i + 1).every(s => s.k === 'label')).map(([l]) => l))
    const END: Flow = { end: true }
    return rt => {
        for (let pc = 0; pc < steps.length; pc++) {
            const flow = steps[pc](rt)
            if (!flow) continue
            if ('goto' in flow && labels.has(flow.goto)) {
                const to = labels.get(flow.goto)!
                if (to <= pc || trailing.has(flow.goto)) return END
                pc = to
                continue
            }
            return flow
        }
        return undefined
    }
}

const truthy = (v: RValue): boolean => (typeof v === 'number' ? v !== 0 : v !== null)

function compileStatement(ec: ExprCompiler, s: CStmt, method: string): Step {
    switch (s.k) {
        case 'do': {
            const run = compileEffect(s.f, ec)
            return rt => { run(rt, rt.printed ?? []); return undefined }
        }
        case 'expr': {
            const c = ec.compile(s.e)
            return rt => { c.fn(rt); return undefined }
        }
        case 'return': {
            const c = s.expr ? ec.compile(s.expr) : undefined
            return rt => ({ ret: c ? c.fn(rt) : 0 })
        }
        case 'if': {
            const cond = ec.compile(s.cond)
            const then = compileBlock(ec, s.then, method)
            const other = s.else ? compileBlock(ec, s.else, method) : undefined
            return rt => (truthy(cond.fn(rt)) ? then(rt) : other?.(rt))
        }
        case 'while': case 'for': {
            const init = s.k === 'for' ? compileBlock(ec, s.init, method) : undefined
            const cond = s.cond ? ec.compile(s.cond) : undefined
            const body = compileBlock(ec, s.body, method)
            const update = s.k === 'for' ? compileBlock(ec, s.update, method) : undefined
            const span = s.span
            return rt => {
                init?.(rt)
                for (let n = 0; !cond || truthy(cond.fn(rt)); n++) {
                    if (n >= LOOP_LIMIT) {
                        throw new SimError(`The loop in ${method} ran more than ${LOOP_LIMIT.toLocaleString('en-NZ')} times in one tick`, span, 'runaway-loop',
                            'KIELER\'s C code would hang here. Check that the loop condition becomes false.')
                    }
                    const flow = body(rt)
                    if (flow) return flow
                    update?.(rt)
                }
                return undefined
            }
        }
        case 'label': return () => undefined
        case 'goto': {
            const flow = { goto: s.target, span: s.span }
            return () => flow
        }
        case 'unsupported': {
            const span = s.span
            return () => { throw new SimError(`The simulator cannot run ${s.what} in methods`, span, 'unsupported') }
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// Inlining (KIELER's SCG Methods processor)
// ---------------------------------------------------------------------------------------------------

/** A loop anywhere in the statements. */
function hasLoop(list: CStmt[]): boolean {
    return list.some(s => s.k === 'while' || s.k === 'for' || (s.k === 'if' && (hasLoop(s.then) || (!!s.else && hasLoop(s.else)))))
}

/** KIELER inlines a method's calls: a simple one, or one marked `@inline` (one with a loop cannot be, see inlineMethods). */
export function isInlined(m: CMethod): boolean {
    // inline() copies effects, conditionals, returns, labels and gotos; anything else stays a C call here.
    const basic = (list: CStmt[]): boolean => list.every(s => s.k === 'do' || s.k === 'return' || s.k === 'label' || s.k === 'goto' || (s.k === 'if' && basic(s.then) && (!s.else || basic(s.else))))
    return isSimple(m) || (!!m.inline && basic(m.body))
}

/**
 * The statements KIELER keeps (SCLExtensions.removeUnreachableCode, applied before the body becomes a graph): after a
 * `goto` or a `return` (KIELER adds `goto _end` after it), everything up to the next label is dropped.
 */
function reachableStatements(list: CStmt[]): CStmt[] {
    const out: CStmt[] = []
    let dead = false
    for (const s of list) {
        if (s.k === 'label') dead = false
        if (dead) continue
        out.push(s)
        if (s.k === 'goto' || s.k === 'return') dead = true
    }
    return out
}

/**
 * KIELER's isSimpleMethod: the method's SCG has fewer than 30 nodes, no loop and no call. Its nodes are the entry,
 * the exit and one per assignment, `if` and `return`; labels and gotos are control flow only (a backward `goto` is
 * no loop to KIELER: it gets no loop annotation, so the method is inlined and the jump becomes a cycle in the tick,
 * probes kieler/rare/probe-goto-*).
 */
export function isSimple(m: CMethod): boolean {
    let nodes = 2
    let ok = true
    const expr = (e: CExpr | undefined) => {
        if (!e) return
        const visit = (x: CExpr) => {
            if (x.k === 'call' || x.k === 'host') ok = false
            else if (x.k === 'op') x.args.forEach(visit)
            else if (x.k === 'ref') x.idx.forEach(visit)
            else if (x.k === 'vector') x.values.forEach(visit)
        }
        visit(e)
    }
    const visit = (list: CStmt[]) => {
        for (const s of reachableStatements(list)) {
            switch (s.k) {
                case 'do':
                    nodes++
                    if (s.f.k === 'call' || s.f.k === 'host' || s.f.k === 'unsupported') ok = false
                    if (s.f.k === 'assign') { expr(s.f.expr); s.f.ref.idx.forEach(expr) }
                    if (s.f.k === 'print') s.f.args.forEach(expr)
                    break
                case 'if': nodes++; expr(s.cond); visit(s.then); if (s.else) visit(s.else); break
                case 'return': nodes++; expr(s.expr); break
                case 'label': case 'goto': break
                case 'expr': ok = false; break
                default: ok = false
            }
        }
    }
    visit(m.body)
    return ok && nodes < SIMPLE_NODES
}

/** The calls of simple methods in a node, innermost last (KIELER handles them in reverse containment order). */
function callsIn(n: SNode): Extract<CExpr, { k: 'call' }>[] {
    const out: Extract<CExpr, { k: 'call' }>[] = []
    const visit = (e: CExpr | undefined) => {
        if (!e) return
        if (e.k === 'call') {
            if (!e.extern && e.target?.v.method) out.push(e)
            e.args.forEach(visit)
        } else if (e.k === 'op') e.args.forEach(visit)
        else if (e.k === 'ref') e.idx.forEach(visit)
        else if (e.k === 'vector') e.values.forEach(visit)
    }
    if (n.kind === 'cond') visit(n.expr)
    else if (n.kind === 'assign' && n.effect) {
        const f = n.effect
        if (f.k === 'call') visit(f.call)
        else if (f.k === 'assign') { f.ref.idx.forEach(visit); visit(f.expr) }
        else if (f.k === 'emit') visit(f.value)
        else if (f.k === 'print') f.args.forEach(visit)
    }
    return out
}

/** Inlines the calls of simple methods into the SCG (after the superfluous fork removal, as KIELER does). */
export function inlineMethods(scg: SCG): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    let counter = 0
    const work = scg.nodes.filter(n => n.kind === 'assign' || n.kind === 'cond')
    for (const node of work) {
        const calls = callsIn(node).reverse()
        // KIELER keeps one call per method and node (a HashBasedTable cell): it inlines that one, drops the method
        // as inlined, and the other calls of it in the node call a C function that no longer exists.
        const twice = calls.find((c, i) => isInlined(c.target!.v.method!) && calls.some((d, j) => j !== i && d.target!.v === c.target!.v))
        if (twice) {
            diagnostics.push({
                severity: 'error', code: 'method-twice', span: twice.span,
                message: `KIELER cannot compile two calls of \`${twice.name}\` in one effect or trigger`,
                kieler: `implicit declaration of function \u2018${twice.name}\u2019 [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)`,
                hint: `KIELER copies a short method into the place it is called, but only once per effect or trigger; the second call is left calling a C function it never generates. Store one result in a variable first (\`t = ${twice.name}(...)\`) and use \`t\` in the second effect.`,
            })
            continue
        }
        for (const call of calls) {
            const m = call.target!.v.method!
            // `@inline` on a method with a loop: KIELER copies the loop into the tick's graph, a cycle it cannot
            // schedule (conformance structure/155).
            if (m.inline && hasLoop(m.body)) {
                diagnostics.push({
                    severity: 'error', code: 'inline-loop', span: call.span,
                    message: `\`@inline\` makes KIELER copy \`${call.name}\`, loop and all, into the tick, and it cannot schedule a loop there`,
                    kieler: 'The SCG is NOT asc-schedulable!',
                    hint: `Remove \`@inline\`: without it KIELER runs a method with a loop as a C function, which may loop as long as it likes within the tick.`,
                })
                continue
            }
            if (!isInlined(m)) continue
            const problem = inline(scg, node, call, m, counter++)
            if (problem) diagnostics.push(problem)
        }
    }
    scg.nodes.forEach((n, i) => { n.id = i })
    return diagnostics
}

/** All flows into a node, as setters (KIELER's allPrevious). */
function incoming(scg: SCG, target: SNode): ((to: SNode | undefined) => void)[] {
    const out: ((to: SNode | undefined) => void)[] = []
    for (const n of scg.nodes) {
        if (n.next === target) out.push(to => { n.next = to })
        if (n.then === target) out.push(to => { n.then = to })
        if (n.else === target) out.push(to => { n.else = to })
    }
    return out
}

function inline(scg: SCG, node: SNode, call: Extract<CExpr, { k: 'call' }>, m: CMethod, index: number): Diagnostic | undefined {
    const origin = node.effect?.o ?? { by: node.transition?.origin ?? node.transition?.about }
    // Fresh frame variables for this copy (KIELER copies the method's SCG and prefixes its names `_fn<n>_`).
    const frame = new Map<CVar, CExpr>()
    m.params.forEach((p, i) => {
        const arg = call.args[i]
        if (arg) frame.set(p, arg)
    })
    // A parameter assigned in the body is replaced by its argument (KIELER inlines by substitution): with an argument
    // that is not a variable, KIELER's compiler fails (conformance structure/151).
    const assigned = assignedVars(m.body)
    const literal = m.params.findIndex((p, i) => assigned.has(p) && call.args[i] && call.args[i].k !== 'ref')
    if (literal >= 0) {
        const p = m.params[literal]
        return {
            severity: 'error', code: 'kieler-crash', span: call.args[literal].span ?? call.span,
            message: `KIELER's compiler crashes on this call: \`${call.name}\` assigns its parameter \`${p.name}\`, and the argument is not a variable`,
            kieler: 'The compiler failed during compilation setup.',
            hint: `KIELER copies a short method into the place it is called and replaces \`${p.name}\` by the argument, which cannot be assigned. Give \`${call.name}\` a local variable (\`int v = ${p.name}\`) and change that, or pass a variable.`,
        }
    }
    const locals = new Map<CVar, CVar>()
    for (const v of m.locals) {
        const c = new CVar(`_fn${index}_${call.name}_${v.name}`, v.type)
        c.generated = true
        c.dims = v.dims.map(d => copyExpr(d))
        c.display = v.name
        locals.set(v, c)
    }
    const rw: Rewriter = {
        read: r => {
            const local = locals.get(r.v)
            if (local) return { ...r, v: local }
            const arg = frame.get(r.v)
            if (!arg) return undefined
            if (arg.k === 'ref') return { ...arg, idx: [...arg.idx.map(i => copyExpr(i)), ...r.idx] }
            return copyExpr(arg)
        },
        target: r => {
            const local = locals.get(r.v)
            if (local) return { ...r, v: local }
            const arg = frame.get(r.v)
            if (arg?.k === 'ref') return { ...arg, idx: [...arg.idx.map(i => copyExpr(i)), ...r.idx] } as CRef
            return undefined
        },
    }
    const returns = countReturns(m.body)
    const returnVar = m.returnType !== 'void' && returns > 1 ? new CVar(`_fn${index}_${call.name}_return`, m.returnType) : undefined
    if (returnVar) returnVar.generated = true
    let returnExpr: CExpr | undefined

    const reads = node.kind === 'cond' || !(node.effect?.k === 'call' && node.effect.call === call)
    // KIELER takes the value from the body's return assignments; a method without any (void, or typed but never
    // returning) has none (MethodProcessor: "The method does not return any value!").
    if (reads && (m.returnType === 'void' || returns === 0)) {
        return m.returnType === 'void'
            ? { severity: 'error', code: 'method-without-value', span: call.span, message: `\`${call.name}()\` returns no value, so it cannot be used in an expression`, kieler: 'The method does not return any value!', hint: `Give \`${call.name}\` a return type and a \`return\` statement, or call it as an effect on its own.` }
            : { severity: 'error', code: 'method-without-return', span: call.span, message: `\`${call.name}()\` is declared to return a value but has no return statement`, kieler: 'The method does not return any value!', hint: `End the body of \`${call.name}\` with \`return\` and the value it should give.` }
    }
    // Build the body's nodes as KIELER's SCL-to-SCG transformation does: each statement gets the open flows of the one
    // before; a label stands for the next node of its statement list (a label that ends a nested list is only resolved
    // when the method's exit is made, so a jump to it leaves the body); a goto takes its open flows to its label.
    type End = (to: SNode | undefined) => void
    const made: SNode[] = []
    const info = { name: call.name }
    const mk = (kind: 'assign' | 'cond', extra: Partial<SNode>): SNode => {
        const n: SNode = { id: scg.nodes.length + made.length, kind, thread: node.thread, state: node.state, transition: node.transition, method: info, ...extra }
        n.gen = (scg.nodes.length + made.length) * 1000
        made.push(n)
        return n
    }
    const effect = (f: CEffect, span?: Span): CEffect => ({ ...rewriteEffect(copyEffect(f), rw), o: { ...origin, span: span ?? f.o.span, hidden: origin.hidden } })
    const labelNode = new Map<string, SNode>()
    const gotos: { label: string; ends: End[]; span?: Span; at: number }[] = []
    const returned: End[] = []
    const toExit: string[] = []
    const build = (list: CStmt[], incoming: End[]): End[] => {
        let cf = incoming
        let labels: string[] = []
        const place = (n: SNode) => {
            for (const e of cf) e(n)
            for (const l of labels) labelNode.set(l, n)
            labels = []
        }
        for (const s of reachableStatements(list)) {
            if (s.k === 'label') { labels.push(s.name); continue }
            if (s.k === 'do') {
                const n = mk('assign', { effect: effect(s.f) })
                place(n)
                cf = [to => { n.next = to }]
            } else if (s.k === 'if') {
                const n = mk('cond', { expr: rewriteExpr(copyExpr(s.cond), rw) })
                place(n)
                cf = [...build(s.then, [to => { n.then = to }]), ...build(s.else ?? [], [to => { n.else = to }])]
            } else if (s.k === 'goto') {
                gotos.push({ label: s.target, ends: cf, span: s.span, at: made.length })
                cf = []
            } else if (s.k === 'return') {
                const value = s.expr ? rewriteExpr(copyExpr(s.expr), rw) : undefined
                if (returnVar && value) {
                    const n = mk('assign', { effect: { k: 'assign', ref: { k: 'ref', v: returnVar, idx: [] }, op: '=', expr: value, o: { ...origin, hidden: true, span: s.span } } })
                    place(n)
                    returned.push(to => { n.next = to })
                } else {
                    returnExpr = value
                    returned.push(...cf)
                    toExit.push(...labels)
                    labels = []
                }
                cf = []
            }
        }
        // Labels at the end of a list: the next node of this list does not exist (KIELER's unmappedLabels).
        if (labels.length) toExit.push(...labels)
        return cf
    }
    const preds = incoming(scg, node)
    let first: SNode | undefined
    let entered = false
    const entry: End = to => { entered = true; first = to; for (const p of preds) p(to) }
    const ends = build(m.body, [entry])
    // Where the body goes on: back to the calling node (or past it when the call is the whole effect).
    const after = reads ? node : node.next
    for (const e of [...ends, ...returned]) e(after)
    for (const g of gotos) {
        const target = toExit.includes(g.label) ? undefined : labelNode.get(g.label)
        // A label before the goto: control goes round within the tick.
        if (target && made.indexOf(target) < g.at) {
            const from = made[g.at - 1]
            for (const n of made) if (n === from || n === target) n.method = { name: call.name, jumpsBack: { label: g.label, span: g.span } }
        }
        for (const e of g.ends) e(target ?? after)
    }
    if (!entered) first = after
    if (reads) {
        const replacement: CExpr = returnVar ? { k: 'ref', v: returnVar, idx: [], span: call.span } : returnExpr ? { ...returnExpr, span: call.span } : { k: 'lit', t: 'int', v: 0 }
        replaceCall(node, call, replacement)
    } else {
        // The call node goes.
        const i = scg.nodes.indexOf(node)
        if (i >= 0) scg.nodes.splice(i, 1)
        const instead = first ?? after
        for (const [st, n] of scg.stateNodes) if (n === node && instead) scg.stateNodes.set(st, instead)
    }
    for (const n of made) n.seq = { next: scg.seq++, then: n.kind === 'cond' ? scg.seq++ : undefined, else: n.kind === 'cond' ? scg.seq++ : undefined }
    scg.nodes.push(...made)
    return undefined
}

function countReturns(list: CStmt[]): number {
    let n = 0
    for (const s of list) {
        if (s.k === 'return') n++
        else if (s.k === 'if') n += countReturns(s.then) + countReturns(s.else ?? [])
        else if (s.k === 'while' || s.k === 'for') n += countReturns(s.body)
    }
    return n
}

/** Replaces the call expression (by identity) in the node's condition or effect. */
function replaceCall(node: SNode, call: CExpr, replacement: CExpr) {
    if (node.kind === 'cond' && node.expr) node.expr = rewriteExprIdentity(node.expr, call, replacement)
    else if (node.effect) node.effect = rewriteEffectIdentity(node.effect, call, replacement)
}

function rewriteExprIdentity(e: CExpr, target: CExpr, replacement: CExpr): CExpr {
    if (e === target) return replacement
    switch (e.k) {
        case 'op': return { ...e, args: e.args.map(a => rewriteExprIdentity(a, target, replacement)) }
        case 'ref': return { ...e, idx: e.idx.map(a => rewriteExprIdentity(a, target, replacement)) }
        case 'vector': return { ...e, values: e.values.map(a => rewriteExprIdentity(a, target, replacement)) }
        case 'call': return { ...e, args: e.args.map(a => rewriteExprIdentity(a, target, replacement)) }
        default: return e
    }
}

function rewriteEffectIdentity(f: CEffect, target: CExpr, replacement: CExpr): CEffect {
    const m = (e: CExpr) => rewriteExprIdentity(e, target, replacement)
    switch (f.k) {
        case 'assign': return { ...f, ref: { ...f.ref, idx: f.ref.idx.map(m) }, expr: f.expr ? m(f.expr) : undefined }
        case 'emit': return { ...f, value: f.value ? m(f.value) : undefined }
        case 'print': return { ...f, args: f.args.map(m) }
        case 'call': return { ...f, call: m(f.call) as typeof f.call }
        default: return f
    }
}

/** The variables a statement list assigns (at any depth). */
function assignedVars(list: CStmt[]): Set<CVar> {
    const out = new Set<CVar>()
    const visit = (stmts: CStmt[]) => {
        for (const st of stmts) {
            if (st.k === 'do' && st.f.k === 'assign') out.add(st.f.ref.v)
            else if (st.k === 'if') { visit(st.then); if (st.else) visit(st.else) }
            else if (st.k === 'while') visit(st.body)
            else if (st.k === 'for') { visit(st.init); visit(st.update); visit(st.body) }
        }
    }
    visit(list)
    return out
}

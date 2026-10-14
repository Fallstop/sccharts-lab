// Host code and extern calls. Owner: the structure workstream. structure.md S-45 .. S-47.
//
// Not one of KIELER's SCCharts processors: host code (backticks), `extern` functions and `#hostcode` pragmas go
// straight into KIELER's generated C code, which the browser cannot compile or run. KIELER accepts such charts, so
// they stay accepted (`ok`), but the simulator reports that it cannot run them ('unsupported', info). Methods are
// run by the simulator (structure/methods.ts); recursive ones are not supported.

import type { Pass, PassContext } from './context'
import { construct, declsOf } from './detect'
import { allActionSites, effectExprs, walkExpr, type CExpr, type CMethod, type CState, type CStmt, type CVar } from '../model'
import type { Construct } from './context'

function hostUses(root: CState): Construct[] {
    const out: Construct[] = []
    for (const v of declsOf(root)) {
        if (v.extern) out.push(construct('extern functions', v.span, v.decl))
        if (v.method) for (const s of stmts(v.method.body)) if (s.k === 'do' && s.f.k === 'host') out.push(construct('host code', s.f.o.span, v.decl))
    }
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        const by = holder.origin ?? holder.about
        const visit = (e: CExpr) => {
            if (e.k === 'call' && e.extern) out.push(construct('extern function calls', e.span, by))
            if (e.k === 'host') out.push(construct('host code', e.span, by))
        }
        walkExpr(holder.trigger, visit)
        for (const f of holder.effects) {
            if (f.k === 'host') out.push(construct('host code', f.o.span, by))
            for (const e of effectExprs(f)) walkExpr(e, visit)
        }
    }
    return out
}

function* stmts(list: CStmt[]): Generator<CStmt> {
    for (const s of list) {
        yield s
        if (s.k === 'if') { yield* stmts(s.then); if (s.else) yield* stmts(s.else) }
        if (s.k === 'while' || s.k === 'for') { yield* stmts(s.body); if (s.k === 'for') { yield* stmts(s.init); yield* stmts(s.update) } }
    }
}

/** Methods that call themselves, directly or through others (the simulator runs methods with one frame each). */
function recursive(root: CState): CVar[] {
    const methods = declsOf(root).filter(v => v.method)
    const calls = (m: CMethod): CVar[] => {
        const out: CVar[] = []
        const visit = (e: CExpr) => { if (e.k === 'call' && e.target?.v.method) out.push(e.target.v) }
        for (const s of stmts(m.body)) {
            if (s.k === 'do') for (const e of effectExprs(s.f)) walkExpr(e, visit)
            else if (s.k === 'if' || s.k === 'while') walkExpr(s.cond, visit)
            else if (s.k === 'for') walkExpr(s.cond, visit)
            else if (s.k === 'return' || s.k === 'expr') walkExpr(s.k === 'return' ? s.expr : s.e, visit)
        }
        return out
    }
    return methods.filter(m => {
        const seen = new Set<CVar>()
        const work = calls(m.method!)
        while (work.length) {
            const x = work.pop()!
            if (x === m) return true
            if (seen.has(x)) continue
            seen.add(x)
            if (x.method) work.push(...calls(x.method))
        }
        return false
    })
}

export const hostCode: Pass = {
    id: 'de.cau.cs.kieler.scg.processors.methods',
    name: 'Methods and host code',
    owner: 'structure',
    run(ctx: PassContext) {
        const uses = hostUses(ctx.root)
        if (uses.length) {
            ctx.report({
                severity: 'info', code: 'unsupported', span: uses[0].span, related: [...new Set(uses.flatMap(u => u.related ?? []))],
                message: `This chart uses ${uses[0].what}, which cannot run in the browser`,
                hint: 'KIELER pastes host code and extern calls into the C program it generates and compiles that with gcc, so whether it accepts the chart depends on that C text; the guide\'s simulator runs in your browser and has no C compiler. Try the chart in SCCharts Lab or KIELER.',
            })
            return
        }
        const loops = recursive(ctx.root)
        if (loops.length) {
            ctx.report({
                severity: 'info', code: 'unsupported', span: loops[0].span, related: loops.flatMap(v => (v.decl ? [v.decl] : [])),
                message: `The guide's simulator cannot run recursive methods (${loops.map(v => `\`${v.name}\``).join(', ')}) yet`,
                hint: 'KIELER compiles such methods into C functions, which may call themselves; the simulator keeps one set of variables per method. The official KIELER tools can run this chart.',
            })
        }
    },
}

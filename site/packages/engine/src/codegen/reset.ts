// What runs in reset(): KIELER's GO-init optimisation moves the assignments of tick 1's straight-line start (the GO
// block) whose right-hand side reads no input into reset(), before the environment's first inputs (sim/goblock.ts).
//
// For inputs that is what the simulator does too (basics.md B-7: the environment's tick-1 value wins), so those always
// move. For everything else the simulator runs the assignment in tick 1 at its place (B-34: KIELER's move can reorder
// it around input reads), so an assignment moves only where that makes no difference: a plain value (no call, no
// random(), no host code, no print) that nothing earlier in the schedule writes or reads, and whose reads nothing
// earlier writes. The rest stays in logic(), under `_GO`. Initialisations (`output int x = 0`) move, as in KIELER.

import type { ExecutableChart } from '../sim/exec'
import { walkExpr, type CEffect, type CExpr, type CVar } from '../sim/model'
import type { SNode } from '../sim/scg'

const ALL = Symbol('everything')
type Access = Set<CVar | typeof ALL>

function readsOf(n: SNode): Access {
    const out: Access = new Set()
    const visit = (e: CExpr) => {
        if (e.k === 'ref') out.add(e.v)
        else if (e.k === 'call' || e.k === 'host' || e.k === 'random') out.add(ALL)
    }
    if (n.kind === 'cond') walkExpr(n.expr, visit)
    const f = n.effect
    if (f) effectReads(f, out, visit)
    return out
}

function effectReads(f: CEffect, out: Access, visit: (e: CExpr) => void) {
    switch (f.k) {
        case 'assign':
            for (const i of f.ref.idx) walkExpr(i, visit)
            walkExpr(f.expr, visit)
            if (f.op !== '=') out.add(f.ref.v)
            break
        case 'print': f.args.forEach(a => walkExpr(a, visit)); out.add(ALL); break
        case 'call': case 'host': case 'randomize': out.add(ALL); break
        default: break
    }
}

function writesOf(n: SNode): Access {
    const f = n.effect
    if (!f) {
        const out: Access = new Set()
        walkExpr(n.expr, e => { if (e.k === 'call' || e.k === 'host') out.add(ALL) })
        return out
    }
    switch (f.k) {
        case 'assign': {
            const out: Access = new Set([f.ref.v])
            walkExpr(f.expr, e => { if (e.k === 'call' || e.k === 'host') out.add(ALL) })
            return out
        }
        case 'call': case 'host': case 'print': case 'randomize': return new Set([ALL])
        default: return new Set()
    }
}

const meets = (a: Access, b: Access) => {
    if ((a.has(ALL) && b.size) || (b.has(ALL) && a.size)) return true
    for (const x of a) if (b.has(x)) return true
    return false
}

/**
 * The schedule positions of the assignments that run in reset() instead of logic(), in schedule order: tick 1's
 * input assignments (exec.ts goInit) and the moved assignments that make no difference there.
 */
export function resetNodes(exe: ExecutableChart): number[] {
    const nodes = exe.nodes
    const moved = exe.compiled.goBlock.moved
    const position = new Map(nodes.map((x, i) => [x.src, i]))
    const out: number[] = []
    const inReset = new Set<number>()
    const reads: Access[] = nodes.map(x => readsOf(x.src))
    const writes: Access[] = nodes.map(x => writesOf(x.src))
    // In the GO block's order (exec.ts runs KIELER's reset() in that order).
    for (const n of exe.compiled.goBlock.nodes) {
        const i = position.get(n)
        if (i === undefined || !moved.has(n)) continue
        const x = nodes[i]
        const f = n.effect
        let safe = !!x.goInit || (f?.k === 'mark' && f.m.kind === 'ttsReset')
        if (!safe && f?.k === 'assign' && !reads[i].has(ALL) && !writes[i].has(ALL) && ![...reads[i]].some(v => v !== ALL && v.input)) {
            const target = new Set<CVar | typeof ALL>([f.ref.v])
            safe = true
            for (let k = 0; k < i && safe; k++) {
                if (inReset.has(k)) continue
                if (meets(writes[k], target) || meets(reads[k], target) || meets(writes[k], reads[i])) safe = false
            }
        }
        if (!safe) continue
        inReset.add(i)
        out.push(i)
    }
    return out
}

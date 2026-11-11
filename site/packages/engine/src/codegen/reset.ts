// What runs in reset(): KIELER's GO-init optimisation moves the assignments of tick 1's straight-line start (the GO
// block) whose right-hand side reads no input into reset(), before the environment's first inputs (sim/goblock.ts).
//
// For inputs that is what the simulator does too (basics.md B-7: the environment's tick-1 value wins), so those always
// move. For everything else the simulator runs the effect in tick 1 at its place (B-34: KIELER's move can reorder
// it around input reads), so an effect moves only where that makes no difference: nothing earlier in the schedule
// (that stays in logic) writes or reads what it writes, or writes what it reads; printed text and random() count as
// variables of their own. Host code moves as in KIELER (the simulator does not run it). Initialisations
// (`output int x = 0`) and tick-1 prints move, as in KIELER.

import type { ExecutableChart } from '../sim/exec'
import { walkExpr, type CEffect, type CExpr, type CVar } from '../sim/model'
import type { SNode } from '../sim/scg'

const ALL = Symbol('everything')
const OUTPUT = Symbol('printed text')
const RANDOM = Symbol('random()')
type Item = CVar | typeof ALL | typeof OUTPUT | typeof RANDOM
type Access = Set<Item>

interface Accesses { reads: Access; writes: Access; host: boolean }

function accessesOf(n: SNode): Accesses {
    const a: Accesses = { reads: new Set(), writes: new Set(), host: false }
    const visit = (e: CExpr) => {
        if (e.k === 'ref') a.reads.add(e.v)
        else if (e.k === 'random') { a.reads.add(RANDOM); a.writes.add(RANDOM) }
        else if (e.k === 'host') { a.host = true; a.reads.add(ALL); a.writes.add(ALL) }
        else if (e.k === 'call') { a.reads.add(ALL); a.writes.add(ALL) }
    }
    if (n.kind === 'cond') walkExpr(n.expr, visit)
    if (n.effect) effectAccesses(n.effect, a, visit)
    return a
}

function effectAccesses(f: CEffect, a: Accesses, visit: (e: CExpr) => void) {
    switch (f.k) {
        case 'assign':
            for (const i of f.ref.idx) walkExpr(i, visit)
            walkExpr(f.expr, visit)
            if (f.op !== '=') a.reads.add(f.ref.v)
            a.writes.add(f.ref.v)
            break
        case 'print': f.args.forEach(x => walkExpr(x, visit)); a.reads.add(OUTPUT); a.writes.add(OUTPUT); break
        case 'host': a.host = true; a.reads.add(ALL); a.writes.add(ALL); break
        case 'call': case 'randomize': a.reads.add(ALL); a.writes.add(ALL); break
        default: break
    }
}

const meets = (a: Access, b: Access) => {
    if ((a.has(ALL) && b.size) || (b.has(ALL) && a.size)) return true
    for (const x of a) if (b.has(x)) return true
    return false
}

/**
 * The schedule positions of the effects that run in reset() instead of logic(), in the GO block's order: tick 1's
 * input assignments (exec.ts goInit) and the moved effects that make no difference there.
 */
export function resetNodes(exe: ExecutableChart): number[] {
    const nodes = exe.nodes
    const moved = exe.compiled.goBlock.moved
    const position = new Map(nodes.map((x, i) => [x.src, i]))
    const out: number[] = []
    const inReset = new Set<number>()
    const acc = nodes.map(x => accessesOf(x.src))
    // In the GO block's order (exec.ts runs KIELER's reset() in that order).
    for (const n of exe.compiled.goBlock.nodes) {
        const i = position.get(n)
        if (i === undefined || !moved.has(n)) continue
        const f = n.effect
        let safe = !!nodes[i].goInit || (f?.k === 'mark' && f.m.kind === 'ttsReset') || acc[i].host
        if (!safe && (f?.k === 'assign' || f?.k === 'print') && !acc[i].reads.has(ALL) && ![...acc[i].reads].some(v => typeof v !== 'symbol' && v.input)) {
            const { reads, writes } = acc[i]
            safe = true
            for (let k = 0; k < i && safe; k++) {
                if (inReset.has(k)) continue
                if (meets(acc[k].writes, writes) || meets(acc[k].reads, writes) || meets(acc[k].writes, reads)) safe = false
            }
        }
        if (!safe) continue
        inReset.add(i)
        out.push(i)
    }
    return out
}

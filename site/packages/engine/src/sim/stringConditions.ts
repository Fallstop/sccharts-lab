// A string as a whole condition (`if t go to ...` with `string t`): KIELER's netlist code keeps every condition in a
// `char` guard (`_cg<n> = d->t;`), and gcc (14 and later) rejects turning a `char*` into a `char` without a cast
// ("assignment to ‘char’ from ‘char *’ makes integer from pointer without a cast"). A plain read of an input the
// chart never writes is the exception: KIELER's copy propagation puts it into the guard expression itself, where C
// tests the pointer. Probe tests/engine/kieler/probe-string-condition.

import type { Diagnostic } from '../types'
import type { CExpr, CRef } from './model'
import type { SCG } from './scg'

const lowermost = (r: CRef): CRef => (r.sub ? lowermost(r.sub) : r)

/** The C value of the expression is a pointer (a string, NULL, an array without all its indices). */
function isPointer(e: CExpr): boolean {
    switch (e.k) {
        case 'lit': return e.t === 'string'
        case 'null': return true
        case 'ref': {
            const r = lowermost(e)
            return r.v.type === 'string' || r.idx.length < r.v.dims.length
        }
        case 'call': return !e.extern && e.target?.v.method?.returnType === 'string'
        case 'op': return e.op === '?:' && e.args.slice(1).some(isPointer)
        default: return false
    }
}

export function stringConditions(scg: SCG): Diagnostic[] {
    const written = new Set<unknown>()
    for (const n of scg.nodes) if (n.effect?.k === 'assign') written.add(lowermost(n.effect.ref).v)
    for (const n of scg.nodes) {
        const e = n.expr
        if (n.kind !== 'cond' || !e || !isPointer(e)) continue
        if (e.k === 'ref' && !e.sub && e.v.input && !written.has(e.v)) continue
        const by = n.method ? undefined : n.transition?.origin ?? n.transition?.about
        return [{
            severity: 'error', code: 'c-string-condition', span: e.span, related: by ? [by] : undefined,
            message: 'A string is not a condition in KIELER\'s C code: gcc rejects it',
            kieler: 'assignment to ‘char’ from ‘char *’ makes integer from pointer without a cast [-Wint-conversion]\nCompiler did not return success (exit value != 0)',
            hint: 'KIELER keeps every condition in a `char`, and C does not turn a string into a `char` without a cast. Test what you mean instead: compare the string (`t == "on"`), or keep a `bool` next to it.',
        }]
    }
    return []
}

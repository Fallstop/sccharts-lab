// KIELER's Count Delay processor (sccharts/processors/CountDelay.xtend, the pre-based variant; the structure-based
// one is off by default): `[immediate] if n T go to X` from S becomes a counter `_cdcounter` declared in S's
// parent, `entry do _cdcounter = 0` on S (tagged DoNotDefer), `[immediate] during if T do _cdcounter += 1` on S
// (immediate iff the transition is implicitly immediate) and the trigger `pre(_cdcounter) == n - 1 && T`
// (preemption.md P-28..P-36). Count delays on actions are not transformed: KIELER ignores them on during actions
// (the validator warns, P-13) and on suspends (P-32).
//
// Because the counter lives in a during action and its test reads `pre`, a count delay inherits their timing:
// the entry tick of a delayed count is not counted, the count restarts on every entry, suspension freezes it
// (Suspend runs first and guards T), and an immediate count can complete at once on re-entry because pre(counter)
// is still last visit's count (P-30, reported by quirks.ts).

import type { Pass, PassContext } from './context'
import { containedTransitions, markDoNotDefer } from './contained'
import {
    assign, copyExpr, createAction, createEntryAction, createVar, isImplicitlyImmediate, lit, op, ref, type CTransition,
    quoted, readableName,
} from '../model'

export const countDelay: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.countDelay',
    name: 'Count Delay',
    owner: 'preemption',
    run(ctx: PassContext) {
        for (const t of containedTransitions(ctx.root)) transformCountDelay(t, ctx)
    },
}

function transformCountDelay(t: CTransition, ctx: PassContext) {
    const n = t.triggerDelay
    if (n === undefined || n <= 1 || t.trigger === undefined) return
    const source = t.source
    const parent = source.parent!.parent
    const by = t.origin ?? t.about
    const o = { hidden: true, by }

    const counter = createVar(parent, '_cdcounter', 'int', 'counter')
    counter.display = `the count delay on ${quoted(readableName(source)) ?? 'a state'}'s transition to ${quoted(readableName(t.target)) ?? 'another state'}`
    // The source transition, for the diagnostics (compile.ts countDelayResetLoop).
    if (by) counter.tags.add(`#count-delay:${by}`)

    // entry do _cdcounter = 0 (DoNotDefer: a deferred entry still restarts the count, P-34)
    const entry = createEntryAction(source)
    entry.about = by
    entry.effects.push(assign(counter, lit(0), o))
    markDoNotDefer(ctx, entry)

    // [immediate] during if T do _cdcounter = _cdcounter + 1
    const during = createAction(source, 'during')
    during.about = by
    during.delay = isImplicitlyImmediate(t) ? 'immediate' : 'undefined'
    during.trigger = copyExpr(t.trigger)
    during.effects.push(assign(counter, op('+', ref(counter), lit(1)), o))

    // trigger := pre(_cdcounter) == n - 1 && T
    t.trigger = op('&&', op('==', op('pre', ref(counter)), lit(n - 1)), t.trigger)
    t.triggerDelay = 1
}

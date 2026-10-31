// The desugaring pipeline: KIELER's processors in the order of its netlist simulation chain
// (de.cau.cs.kieler.sccharts.simulation.tts.netlist.c -> de.cau.cs.kieler.sccharts.extended, sccharts/system/
// de.cau.cs.kieler.sccharts.extended.kico; preemption.md §0, concurrency.md 1.2). Taken Transition Signaling and
// Const are done while lowering (lower.ts); Trigger/Effect and Surface/Depth while building the SCG (scg.ts).
//
// Each pass is one module. A pass without `run` is a placeholder: the simulator rejects charts that use its
// constructs (found by `uses`) instead of running them wrongly. See ../README.md, "Adding a feature".

import type { Pass } from './context'
import { abort } from './abort'
import { abortRegion } from './abortRegion'
import { arrayAssignment } from './arrayAssignment'
import { codeEffects } from './codeEffects'
import { complexFinalState } from './complexFinalState'
import { connector } from './connector'
import { countDelay } from './countDelay'
import { deferred } from './deferred'
import { during } from './during'
import { entryPass } from './entry'
import { enumPass } from './enum'
import { exitPass } from './exit'
import { finalRegion } from './finalRegion'
import { followedBy } from './followedBy'
import { forRegion } from './forRegion'
import { history } from './history'
import { hostCode } from './hostCode'
import { initialization } from './initialization'
import { initOperator } from './initOperator'
import { ode } from './ode'
import { period } from './period'
import { pre } from './pre'
import { prTransitions } from './prTransitions'
import { reference } from './reference'
import { regionActions } from './regionActions'
import { sequentialFollowedBy } from './sequentialFollowedBy'
import { signal } from './signal'
import { staticPass } from './static'
import { suspend } from './suspend'
import { timedAutomata } from './timedAutomata'
import { unpackClasses } from './unpackClasses'
import { userSchedule } from './userSchedule'
import { weakSuspend } from './weakSuspend'

export type { Pass, PassContext, Construct, Owner } from './context'

/** KIELER's extended SCCharts chain, in order. */
export const PIPELINE: Pass[] = [
    reference,
    unpackClasses,
    regionActions,
    codeEffects,
    forRegion,
    prTransitions,
    enumPass,
    // const: done while lowering (lower.ts)
    period,
    timedAutomata,
    initOperator,
    followedBy,
    sequentialFollowedBy,
    history,
    // SyncCharts
    signal,
    suspend,
    countDelay,
    pre,
    // Scade / Quartz / Esterel V7
    weakSuspend,
    deferred,
    staticPass,
    // Statecharts
    ode,
    during,
    finalRegion,
    complexFinalState,
    exitPass('weak'),
    entryPass('weak'),
    abortRegion,
    abort,
    exitPass('strong'),
    initialization,
    entryPass('strong'),
    connector,
    arrayAssignment,
    userSchedule,
    // Not in KIELER's SCCharts chain: methods, host code and extern calls (SCG and C code generation).
    hostCode,
]

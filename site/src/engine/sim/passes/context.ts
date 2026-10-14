// What a desugaring pass gets to work with, and how passes describe themselves to the registry (index.ts).

import type { Diagnostic, Span } from '../../types'
import type { CState, CVar } from '../model'

export type Owner = 'core' | 'preemption' | 'structure'

/** A construct of the chart that a pass removes (used to report charts the simulator cannot run yet). */
export interface Construct {
    what: string
    span?: Span
    related?: string[]
}

export interface PassContext {
    /** The scchart being compiled (rewritten in place). */
    readonly root: CState
    /** KIELER configuration that decides how some processors behave in the netlist simulation chain. */
    readonly config: {
        /** de.cau.cs.kieler.sccharts.finalRegion.supported (false in the netlist system). */
        finalRegions: boolean
    }
    /** Source variables by ValuedObject id. */
    readonly vars: Map<string, CVar>
    /** Reports a problem; errors make the chart rejected. */
    report(d: Diagnostic): void
    /** Shared state between passes (for example Termination's annotations that Abort reads). */
    readonly shared: Record<string, unknown>
}

export interface Pass {
    /** KIELER's processor id (de.cau.cs.kieler.sccharts.processors....). */
    id: string
    name: string
    /** The workstream that implements it. */
    owner: Owner
    /** KIELER runs some processors twice with different configurations (entry and exit actions). */
    config?: Record<string, string>
    /** Constructs in the chart that need this pass. Only consulted while `run` is missing. */
    uses?(root: CState): Construct[]
    /** Rewrites the chart. Missing: the pass is not implemented yet, and charts that use it are rejected. */
    run?(ctx: PassContext): void
}

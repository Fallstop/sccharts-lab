// Abort regions (`abort region`, preemption.md P-62; netlist only). In KIELER's netlist chain the SCCharts-level
// Abort Regions processor (sccharts/processors/AbortRegion.xtend) does nothing (abortRegions.supported is true,
// abortRegions is false); the regions go through every other transformation unchanged and the SCG processor
// SCGAbortRegionProcessor turns the fork of their state into a sequential preemptive fork with a par-or join
// (../abortRegions.ts: the simulator does the same on its SCG).
//
// What KIELER rejects is rejected exactly, on the SCG (abortRegionErrors, called by ../abortRegions.ts): abort regions
// must be the first or the last regions of their state, and there must be other regions to abort. Regions the
// passes add count (the `_ACtrl` watcher of a state with aborts, `_During` regions), which is why an abort region
// last in a state with an abort transition is rejected; states that cannot be reached have no SCG and are not
// checked.

import type { Diagnostic } from '../../types'
import type { Pass } from './context'
import type { CRegion } from '../model'

export const abortRegion: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.abortRegions',
    name: 'Abort Region',
    owner: 'preemption',
    run() {
        // Netlist chain: nothing to do here (see above).
    },
}

const ERROR_ORDER = 'Illegal order of abort and non-abort regions. Abort regions are only allowed as first or last regions and cannot be mixed with regular regions.'
const ERROR_NONE = 'Found abort regions but there are no regions to abort.'

/**
 * SCGAbortRegionProcessor's checks for one fork of the SCG (abortRegions.ts calls this for the forks of reachable
 * states only: KIELER's SCG has no nodes for states that cannot be reached, so their regions are not checked):
 * abort regions first or last, and something to abort. `regions` are the fork's threads' regions, in order.
 */
export function abortRegionErrors(regions: (CRegion | undefined)[], stateId: string | undefined, name: string): Diagnostic | undefined {
    const first = regions.find(r => r?.abort)
    const related = [first?.origin, stateId].filter((x): x is string => !!x)
    // 0: leading abort regions, 1: content, 2: trailing abort regions
    let type = 0
    let content = 0
    for (const r of regions) {
        if (r?.abort) {
            if (type === 1) type = 2
        } else if (type === 2) {
            return {
                severity: 'error', code: 'abort-region-order', related,
                message: `The abort regions of \`${name}\` must come first or last, with the other regions together in between`,
                hint: r?.origin
                    ? 'Move the abort regions to the start or the end of the state.'
                    : `KIELER adds a region of its own after the abort region (for ${name}'s outgoing transitions or during actions), so an abort region cannot be last here. Put it first, or remove the transitions out of ${name}.`,
                kieler: ERROR_ORDER,
            }
        } else {
            type = 1
            content++
        }
    }
    if (content) return undefined
    return {
        severity: 'error', code: 'abort-region-alone', related,
        message: `\`${name}\` has only abort regions, so there is nothing for them to abort`,
        hint: 'An abort region ends the other regions of its state when it reaches a final state. Add the regions it should watch, or make it a normal region.',
        kieler: ERROR_NONE,
    }
}

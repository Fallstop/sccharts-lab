/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/* global HTMLElement */

import { SimulationVariableState, SimulationViewState } from '../../../src/simulation/protocol'
import { formatValue, h, sameValue } from './dom'
import { NumberFormat } from './format'

export type FormatFor = (id: string) => NumberFormat

function latest(variable: SimulationVariableState): unknown {
    return variable.history[variable.history.length - 1]
}

function previous(variable: SimulationVariableState): unknown {
    return variable.history[variable.history.length - 2]
}

function changedThisTick(variable: SimulationVariableState): boolean {
    return variable.history.length >= 2 && !sameValue(latest(variable), previous(variable))
}

/** A boolean that is true, or any other value; the things worth mentioning in a tick. */
function isPresent(variable: SimulationVariableState): boolean {
    const value = latest(variable)
    return typeof value === 'boolean' ? value : value !== undefined
}

function chip(variable: SimulationVariableState, role: string, format: NumberFormat): HTMLElement {
    const value = latest(variable)
    const text = typeof value === 'boolean' ? variable.label : `${variable.label}=${formatValue(value, format)}`
    const el = h(`span.kv-chip.kv-chip-${role}`, {}, text)
    if (typeof value === 'boolean') {
        el.title = `${variable.label} is present in this tick`
    } else if (changedThisTick(variable)) {
        el.title = `was ${formatValue(previous(variable), format)}`
    }
    return el
}

function fact(label: string, title: string, chips: HTMLElement[], empty = 'none'): HTMLElement {
    return h(
        'span.kv-fact',
        { title },
        h('span.kv-fact-label', {}, label),
        ...(chips.length > 0 ? chips : [h('span.kv-fact-empty', {}, empty)])
    )
}

/** One line about what the last tick did, above the trace table. Explanations live in tooltips. */
export function renderSummary(state: SimulationViewState, formatFor: FormatFor = () => 'dec'): HTMLElement {
    const visible = state.variables.filter((variable) => !variable.internal || state.showInternal)
    const queued = visible.filter((variable) => variable.pending)
    const queuedFact =
        queued.length > 0 &&
        fact(
            'Next',
            `Input values queued for tick ${state.tick + 1}`,
            queued.map((variable) =>
                h(
                    'span.kv-chip.kv-chip-queued',
                    {},
                    `${variable.label}=${formatValue(variable.next, formatFor(variable.id))}`
                )
            )
        )
    const tickLabel = h(
        'span.kv-summary-tick',
        { title: 'One tick is one reaction of the model: read inputs, take transitions, write outputs' },
        `Tick ${state.tick}`
    )

    if (state.tick === 0) {
        return h(
            'div.kv-summary',
            {},
            tickLabel,
            h('span.kv-summary-text', {}, 'Set inputs, then press Step to run one tick.'),
            queuedFact
        )
    }

    const inputs = visible.filter((variable) => variable.role === 'input' && isPresent(variable))
    const outputs = visible.filter(
        (variable) =>
            variable.role === 'output' &&
            (typeof latest(variable) === 'boolean' ? latest(variable) === true : latest(variable) !== undefined)
    )
    const locals = visible.filter(
        (variable) => variable.role !== 'input' && variable.role !== 'output' && changedThisTick(variable)
    )
    const printed = state.printed?.[state.tick - state.firstTick] ?? []

    return h(
        'div.kv-summary',
        {},
        tickLabel,
        fact(
            'In',
            'Inputs present in this tick',
            inputs.map((variable) => chip(variable, 'in', formatFor(variable.id)))
        ),
        fact(
            'Out',
            'Outputs emitted in this tick',
            outputs.map((variable) => chip(variable, 'out', formatFor(variable.id)))
        ),
        locals.length > 0 &&
            fact(
                'Changed',
                'Variables that changed in this tick (hover for the previous value)',
                locals.map((variable) => chip(variable, 'local', formatFor(variable.id)))
            ),
        printed.length > 0 &&
            fact(
                'Printed',
                'What the model printed in this tick. Click printed in the table for every line so far.',
                printed.map((line) => h('span.kv-chip.kv-chip-printed', { title: line }, line))
            ),
        queuedFact
    )
}

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

import { SimulationViewCommand, SimulationViewState } from '../../../src/simulation/protocol'
import { h, icon, replaceChildren } from './dom'

type Send = (command: SimulationViewCommand) => void

function button(iconName: string, label: string, title: string, onclick: () => void, on?: boolean): HTMLElement {
    return h(
        `button.kv-btn.kv-btn-quiet${on ? '.kv-btn-active' : ''}`,
        {
            type: 'button',
            title: `${label}: ${title}`,
            'aria-label': label,
            'aria-pressed': on === undefined ? undefined : String(on),
            onclick,
        },
        icon(iconName),
        h('span.kv-btn-label', {}, label)
    )
}

/** The trace's own controls, at the right end of the drawer's summary line. */
export function renderDrawerTools(state: SimulationViewState, send: Send): HTMLElement {
    return h(
        'div.kv-drawer-tools',
        {},
        button(
            'symbol-misc',
            'Generated',
            'Show guards, tick counters and other symbols the compiler added',
            () => send({ kind: 'setShowInternal', enabled: !state.showInternal }),
            state.showInternal
        ),
        button('save', 'Save', 'Save the run so far, or only its inputs, as KTrace, CSV, JSON or XML', () =>
            send({ kind: 'saveTrace' })
        ),
        button(
            'folder-opened',
            'Replay',
            'Drive the inputs from a saved trace or input sequence and check the outputs against it',
            () => send({ kind: 'loadTrace' })
        ),
        button('git-compare', 'Compare', 'Compare this run with saved traces, tick by tick', () =>
            send({ kind: 'compareTrace' })
        )
    )
}

/**
 * The trace being replayed: how far it got and whether the outputs match. Built once and updated
 * in place, so the Stop button is never replaced under the pointer.
 */
export class ReplayNotice {
    readonly el: HTMLElement

    private readonly icon = h('span.kv-replay-icon')

    private readonly text = h('span.kv-replay-text')

    private readonly detail = h('span.kv-replay-detail')

    private iconName = ''

    constructor(send: Send) {
        this.el = h(
            'div.kv-replay-notice',
            { role: 'status', hidden: true },
            this.icon,
            this.text,
            this.detail,
            h(
                'button.kv-btn.kv-btn-quiet.kv-replay-stop',
                {
                    type: 'button',
                    title: 'Stop replaying: the inputs are yours again',
                    'aria-label': 'Stop replaying',
                    onclick: () => send({ kind: 'stopReplay' }),
                },
                icon('close')
            )
        )
    }

    render(state: SimulationViewState): void {
        const { replay } = state
        this.el.hidden = !replay
        if (!replay) return
        const finished = replay.tick >= replay.length
        const differs = replay.mismatchTicks > 0
        this.el.classList.toggle('kv-replay-differs', differs)
        const iconName = differs ? 'warning' : finished ? 'check' : 'play-circle'
        if (iconName !== this.iconName) {
            this.iconName = iconName
            replaceChildren(this.icon, icon(iconName))
        }
        let text = finished
            ? `Replayed ${replay.label}: ${replay.length} ticks`
            : `Replaying ${replay.label}: tick ${replay.tick} of ${replay.length}`
        if (replay.firstMismatch) {
            const more = replay.mismatchTicks > 1 ? ` (${replay.mismatchTicks} ticks differ)` : ''
            text += `. Differs at tick ${replay.firstMismatch.tick}: ${replay.firstMismatch.text}${more}`
        } else if (replay.checked.length > 0 && replay.tick > 0) {
            text += finished ? '. The outputs matched.' : '. The outputs match so far.'
        } else if (replay.checked.length === 0) {
            text += '. The file has no outputs of this model to check.'
        }
        this.text.textContent = text
        const details = [
            replay.unset.length > 0 ? `Yours to set: ${replay.unset.join(', ')}` : '',
            replay.ignored.length > 0 ? `Not in this model: ${replay.ignored.join(', ')}` : '',
            ...replay.problems,
            ...replay.notes,
        ].filter(Boolean)
        this.detail.textContent = details.join(' · ')
        this.el.title = [text, ...details].join('\n')
    }
}

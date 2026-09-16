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

/* global document, HTMLElement, HTMLInputElement, KeyboardEvent, Node */

import { SimulationVariableState, SimulationViewCommand, SimulationViewState } from '../../../src/simulation/protocol'
import { isCompatibleInput } from '../../../src/simulation/input-value'
import { formatValue, h, replaceChildren, sameValue } from './dom'
import { NumberFormat, describeFormat, parseNumber, unescapeText } from './format'

type GroupKey = 'input' | 'output' | 'local' | 'internal'

const GROUPS: { key: GroupKey; title: string; hint: string }[] = [
    {
        key: 'input',
        title: 'Inputs',
        hint: 'Set by the environment. Change one here; the model reads it at the next tick.',
    },
    { key: 'output', title: 'Outputs', hint: 'Written by the model during a tick.' },
    { key: 'local', title: 'Variables', hint: 'Values the model keeps between ticks.' },
    { key: 'internal', title: 'Generated', hint: 'Guards, tick counters and other symbols the compiler added.' },
]

/** Per-variable number formats, owned by the view so they survive rebuilds. */
export interface FormatStore {
    get(id: string): NumberFormat
    cycle(id: string): void
}

const EDIT_TITLE = 'Type a value and press Enter; the model reads it at the next tick'

/** A single-line field cannot hold a newline, so string inputs are typed and shown escaped. */
const TEXT_EDIT_TITLE = `${EDIT_TITLE}. Use \\n, \\r, \\t, \\0, \\xNN and \\\\ for special characters`

function editTitle(variable: SimulationVariableState): string {
    return typeof variable.next === 'string' ? TEXT_EDIT_TITLE : EDIT_TITLE
}

/**
 * The text the view last put in an input, read back after the browser sanitised it. A field the
 * user never touched therefore compares equal and is never committed back over the real value.
 */
const shownText = new WeakMap<HTMLInputElement, string>()

/** How long a clicked switch shows its new value while the server has not yet confirmed it. */
const CONFIRM_WINDOW_MS = 1500

type ControlKind = 'switch' | 'text' | 'none'

/** One variable's row. The leading cells and the control stay put; the tick cells are rebuilt. */
interface Row {
    tr: HTMLElement
    next: HTMLElement
    kind: ControlKind
    control?: HTMLElement
    format?: HTMLElement
}

function controlKind(variable: SimulationVariableState): ControlKind {
    if (variable.role !== 'input') return 'none'
    return typeof variable.next === 'boolean' ? 'switch' : 'text'
}

/** Removes every child after the first `keep`. */
function trimAfter(parent: HTMLElement, keep: number): void {
    while (parent.childNodes.length > keep) {
        parent.removeChild(parent.lastChild as Node)
    }
}

/**
 * The trace table: one row per variable, one column per tick, newest on the right. Inputs get an
 * editable "next tick" cell. Rows and their controls are created once and updated in place: while
 * the simulation runs, a tick arrives every few hundred milliseconds, and a control that is
 * replaced between mousedown and mouseup swallows the click, so only the tick cells are rebuilt.
 */
export class Timeline {
    readonly el = h('div.kv-timeline')

    private readonly rows = new Map<string, Row>()

    /** The variables as last rendered; the controls read the current value from here when used. */
    private readonly latest = new Map<string, SimulationVariableState>()

    /**
     * Switch values sent but not yet seen back from the server. On a fast simulation a state pushed
     * before the click was handled arrives after it and would flip the switch back for a moment.
     */
    private readonly unconfirmed = new Map<string, { value: boolean; at: number }>()

    private head: HTMLElement | undefined

    private groups: HTMLElement[] = []

    private shape = ''

    constructor(
        private readonly send: (command: SimulationViewCommand) => void,
        private readonly formats: FormatStore = { get: () => 'dec', cycle: () => undefined }
    ) {}

    clear(): void {
        this.rows.clear()
        this.latest.clear()
        this.unconfirmed.clear()
        this.head = undefined
        this.groups = []
        this.shape = ''
        replaceChildren(this.el)
    }

    render(state: SimulationViewState): void {
        const stickToEnd = this.el.scrollLeft + this.el.clientWidth >= this.el.scrollWidth - 40
        state.variables.forEach((variable) => this.latest.set(variable.id, this.confirmed(variable)))
        const shape = JSON.stringify([
            state.showInternal,
            state.variables.map((variable) => [
                variable.id,
                variable.label,
                variable.role,
                variable.internal,
                controlKind(variable),
                isNumeric(variable),
            ]),
        ])
        if (shape !== this.shape || !this.head) {
            this.build(state)
            this.shape = shape
        }

        const ticks: number[] = []
        for (let tick = state.firstTick; tick <= state.tick; tick++) {
            ticks.push(tick)
        }
        const elided = state.firstTick > 1
        const head = this.head as HTMLElement
        trimAfter(head, 2)
        if (elided) {
            head.appendChild(
                h('th.kv-col-more', { title: `Ticks 1 to ${state.firstTick - 1} are no longer shown` }, '…')
            )
        }
        ticks.forEach((tick) => head.appendChild(this.tickHeader(tick, state)))
        this.groups.forEach((group) => group.setAttribute('colspan', String(ticks.length + (elided ? 3 : 2))))
        state.variables.forEach((variable) => {
            const row = this.rows.get(variable.id)
            if (row) this.updateRow(row, this.latest.get(variable.id) ?? variable, state, elided)
        })
        if (stickToEnd) {
            this.el.scrollLeft = this.el.scrollWidth
        }
    }

    /** The variable as the server reports it, unless a clicked switch is still waiting to be seen back. */
    private confirmed(variable: SimulationVariableState): SimulationVariableState {
        const sent = this.unconfirmed.get(variable.id)
        if (!sent) return variable
        if (variable.next === sent.value || Date.now() - sent.at > CONFIRM_WINDOW_MS) {
            this.unconfirmed.delete(variable.id)
            return variable
        }
        return { ...variable, next: sent.value }
    }

    /** Creates the table skeleton; controls of variables that are still there move over. */
    private build(state: SimulationViewState): void {
        const focused = document.activeElement
        const refocus = focused instanceof HTMLElement && this.el.contains(focused) ? focused : undefined
        const previous = new Map(this.rows)
        this.rows.clear()
        this.groups = []
        this.head = h(
            'tr',
            {},
            h('th.kv-col-name', {}, 'Variable'),
            h('th.kv-col-next', { title: 'What the model will read at the next tick' }, 'Next')
        )
        const bodies = GROUPS.map((group) => {
            const members = state.variables.filter((variable) => groupOf(variable) === group.key)
            if (members.length === 0 || (group.key === 'internal' && !state.showInternal)) {
                return null
            }
            const title = h('th', { title: group.hint }, h('span.kv-group-title', {}, group.title))
            this.groups.push(title)
            return h(
                'tbody',
                {},
                h('tr.kv-group', {}, title),
                ...members.map((variable) => this.createRow(variable, previous.get(variable.id)).tr)
            )
        })
        replaceChildren(this.el, h('table.kv-table', {}, h('thead', {}, this.head), ...bodies))
        if (refocus?.isConnected) {
            refocus.focus({ preventScroll: true })
        }
    }

    private tickHeader(tick: number, state: SimulationViewState): HTMLElement {
        const hit = state.debug?.paused?.step === tick
        const canRewind = !!state.debug?.canStepBack && tick < state.tick && !state.playing
        const classes = [
            'kv-col-tick',
            tick === state.tick ? 'kv-latest' : '',
            hit ? 'kv-hit' : '',
            canRewind ? 'kv-rewindable' : '',
        ]
            .filter(Boolean)
            .join('.')
        let title = `After tick ${tick}`
        if (hit) title += ` (paused here: ${state.debug?.paused?.label})`
        if (canRewind) title += '. Click to rewind the simulation to this tick.'
        return h(
            `th.${classes}`,
            {
                title,
                role: canRewind ? 'button' : undefined,
                tabindex: canRewind ? 0 : undefined,
                'data-control': canRewind ? `tick:${tick}` : undefined,
                onclick: canRewind ? () => this.send({ kind: 'stepBack', toStep: tick }) : undefined,
                onkeydown: canRewind
                    ? (event) => {
                          if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
                              event.preventDefault()
                              this.send({ kind: 'stepBack', toStep: tick })
                          }
                      }
                    : undefined,
            },
            String(tick)
        )
    }

    private createRow(variable: SimulationVariableState, reuse: Row | undefined): Row {
        const kind = controlKind(variable)
        let control: HTMLElement | undefined
        if (reuse?.kind === kind && reuse.control) {
            control = reuse.control
        } else if (kind === 'switch') {
            control = this.switchControl(variable)
        } else if (kind === 'text') {
            control = this.textControl(variable)
        }
        const format = isNumeric(variable) ? reuse?.format ?? this.formatButton(variable) : undefined
        const categories = variable.categories.length > 0 ? `\n${variable.categories.join(', ')}` : ''
        const next = h('td.kv-col-next', {}, control)
        const tr = h(
            'tr.kv-row',
            {},
            h(
                'td.kv-col-name',
                { title: `${variable.id}${categories}` },
                h('span.kv-name', {}, variable.label),
                format
            ),
            next
        )
        const row: Row = { tr, next, kind, control, format }
        this.rows.set(variable.id, row)
        return row
    }

    private updateRow(row: Row, variable: SimulationVariableState, state: SimulationViewState, elided: boolean): void {
        const format = this.formats.get(variable.id)
        if (row.format) {
            const { label, title } = describeFormat(format)
            row.format.textContent = label
            row.format.title = `Shown as ${title}. Click to change the format for ${variable.label}.`
            row.format.setAttribute('aria-label', `Number format for ${variable.label}: ${title}`)
        }
        row.next.classList.toggle('kv-pending', variable.pending)
        if (variable.pending) row.next.title = 'Queued: the server reads this at the next tick'
        else row.next.removeAttribute('title')
        if (row.control) this.updateControl(row.control, variable, format)

        trimAfter(row.tr, 2)
        if (elided) row.tr.appendChild(h('td.kv-col-more'))
        variable.history.forEach((value, index) => {
            const tick = state.firstTick + index
            const prev = index > 0 ? variable.history[index - 1] : undefined
            const changed = index > 0 && !sameValue(value, prev)
            const classes = [
                'kv-cell',
                tick === state.tick ? 'kv-latest' : '',
                changed ? 'kv-changed' : '',
                state.debug?.paused?.step === tick ? 'kv-hit' : '',
            ]
                .filter(Boolean)
                .join('.')
            let title = `${variable.label} = ${formatValue(value, format)} after tick ${tick}`
            if (changed) {
                title += ` (was ${formatValue(prev, format)})`
            }
            row.tr.appendChild(h(`td.${classes}`, { title }, valueNode(value, format)))
        })
    }

    /** Shows the queued value; an input being edited keeps what the user typed. */
    private updateControl(control: HTMLElement, variable: SimulationVariableState, format: NumberFormat): void {
        if (control instanceof HTMLInputElement) {
            if (document.activeElement === control) return
            control.value = editValue(variable.next, format)
            shownText.set(control, control.value)
            control.classList.remove('kv-invalid')
            control.removeAttribute('aria-invalid')
            control.title = editTitle(variable)
            return
        }
        const on = variable.next === true
        control.setAttribute('aria-checked', String(on))
        control.title = `Click to make ${variable.label} ${on ? 'absent' : 'present'} at the next tick`
        const label = control.querySelector('.kv-switch-label')
        if (label) label.textContent = on ? 'true' : 'false'
    }

    /** Small "dec / hex / bin / chr" button that cycles this variable's number format. */
    private formatButton(variable: SimulationVariableState): HTMLElement {
        return h('button.kv-fmt', {
            type: 'button',
            'data-control': `fmt:${variable.id}`,
            onclick: () => this.formats.cycle(variable.id),
        })
    }

    private switchControl(variable: SimulationVariableState): HTMLElement {
        const { id } = variable
        return h(
            'button.kv-switch',
            {
                type: 'button',
                role: 'switch',
                'aria-checked': 'false',
                'aria-label': `Next value for ${variable.label}`,
                'data-control': `switch:${id}`,
                onclick: () => {
                    const current = this.latest.get(id)
                    const row = this.rows.get(id)
                    if (!current || !row?.control) return
                    const value = current.next !== true
                    const toggled = { ...current, next: value }
                    // Shown at once, and held until the server reports it, so a second click before
                    // the answer toggles again and a state from before the click cannot flip it back.
                    this.latest.set(id, toggled)
                    this.unconfirmed.set(id, { value, at: Date.now() })
                    this.updateControl(row.control, toggled, 'dec')
                    this.send({ kind: 'setInput', id, value })
                },
            },
            h('span.kv-switch-track', {}, h('span.kv-switch-knob')),
            h('span.kv-switch-label', {}, 'false')
        )
    }

    private textControl(variable: SimulationVariableState): HTMLElement {
        const { id } = variable
        const input = h('input.kv-input', {
            type: 'text',
            'data-id': id,
            title: editTitle(variable),
            'aria-label': `Next value for ${variable.label}`,
            spellcheck: 'false',
        })
        shownText.set(input, input.value)
        const commit = (): boolean => {
            const current = this.latest.get(id)
            if (!current || !input.isConnected) {
                // The table was rebuilt underneath the input; the edit stays in the field.
                return false
            }
            // Nothing was typed, so there is no edit to commit and nothing to report as invalid.
            if (shownText.get(input) === input.value) return true
            const format = this.formats.get(id)
            const parsed = parseLike(input.value, current.next, format)
            if (parsed === undefined) {
                input.classList.add('kv-invalid')
                input.setAttribute('aria-invalid', 'true')
                input.title = 'Invalid value. Use a number, text, or JSON matching this input’s type and array size.'
                return false
            }
            input.classList.remove('kv-invalid')
            input.removeAttribute('aria-invalid')
            input.title = editTitle(current)
            shownText.set(input, input.value)
            if (!sameValue(parsed, current.next)) {
                this.send({ kind: 'setInput', id, value: parsed })
            }
            return true
        }
        input.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                if (commit()) input.blur()
            } else if (event.key === 'Escape') {
                const current = this.latest.get(id)
                input.value = editValue(current?.next, this.formats.get(id))
                shownText.set(input, input.value)
                input.blur()
            }
            event.stopPropagation()
        })
        input.addEventListener('blur', () => {
            commit()
        })
        return input
    }
}

function groupOf(variable: SimulationVariableState): GroupKey {
    return variable.internal ? 'internal' : variable.role
}

function isNumeric(variable: SimulationVariableState): boolean {
    const sample = variable.history.length > 0 ? variable.history[variable.history.length - 1] : variable.next
    return typeof sample === 'number'
}

function valueNode(value: unknown, format: NumberFormat): HTMLElement {
    if (typeof value === 'boolean') {
        return h(`span.kv-bit.${value ? 'kv-bit-on' : 'kv-bit-off'}`, { role: 'img', 'aria-label': String(value) })
    }
    return h('span.kv-value', {}, formatValue(value, format))
}

/** Parse `text` as the same kind of value as `like`; undefined when it does not fit. */
export function parseLike(text: string, like: unknown, format: NumberFormat = 'dec'): unknown {
    const trimmed = text.trim()
    if (typeof like === 'number') {
        return parseNumber(trimmed, format)
    }
    if (typeof like === 'string') {
        return unescapeText(text)
    }
    try {
        const value: unknown = JSON.parse(trimmed)
        return isCompatibleInput(value, like) ? value : undefined
    } catch {
        return undefined
    }
}

function editValue(value: unknown, format: NumberFormat): string {
    // Composite values remain JSON so changing the number format never corrupts an array edit.
    // Scalars go through formatValue, which escapes a string for the same reason parseLike unescapes one.
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : formatValue(value, format)
}

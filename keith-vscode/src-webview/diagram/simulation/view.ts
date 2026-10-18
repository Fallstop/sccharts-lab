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

/* global document, window, localStorage, HTMLElement, KeyboardEvent, MouseEvent, ResizeObserver */

import { HOST_EXTENSION } from 'vscode-messenger-common'
import { Messenger } from 'vscode-messenger-webview'
import {
    SimulationViewCommand,
    SimulationViewState,
    simulationCommandNotification,
    simulationStateNotification,
} from '../../../src/simulation/protocol'
import { h, replaceChildren } from './dom'
import { NumberFormat, isNumberFormat, nextFormat } from './format'
import { renderSummary } from './summary'
import { Timeline } from './timeline'
import { Toolbar } from './toolbar'
import { BreakpointPanel, WatchPanel, renderPauseNotice } from './debug'
import { ReplayNotice, renderDrawerTools } from './drawer-tools'

const DRAWER_KEY = 'keith.simulation.drawer'
const DRAWER_HEIGHT_KEY = 'keith.simulation.drawerHeight'
const FORMATS_KEY = 'keith.simulation.formats'
const MIN_DRAWER = 96

function readSetting(key: string, fallback: string): string {
    try {
        return localStorage.getItem(key) ?? fallback
    } catch {
        return fallback
    }
}

function writeSetting(key: string, value: string): void {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Storage can be unavailable in a webview; the setting then lasts for the session only.
    }
}

function readFormats(): Record<string, NumberFormat> {
    try {
        const parsed: unknown = JSON.parse(readSetting(FORMATS_KEY, '{}'))
        const formats: Record<string, NumberFormat> = {}
        if (parsed && typeof parsed === 'object') {
            Object.entries(parsed).forEach(([id, format]) => {
                if (isNumberFormat(format)) formats[id] = format
            })
        }
        return formats
    } catch {
        return {}
    }
}

/**
 * Wraps the KLighD diagram in a simulation workbench: transport controls above, the diagram in the
 * middle, and the tick trace in a resizable drawer below. Owns the message exchange with the
 * extension; everything it shows comes from the last {@link SimulationViewState} it received.
 */
export class SimulationView {
    private readonly root = h('div.kv-root')

    private readonly drawer = h('section.kv-drawer', { hidden: true })

    private readonly summary = h('div.kv-summary-host')

    private readonly tools = h('div.kv-drawer-tools-host')

    private readonly notice = h('div.kv-notice-host')

    private readonly toolbar: Toolbar

    private readonly breakpoints: BreakpointPanel

    private readonly watches: WatchPanel

    private readonly timeline: Timeline

    private readonly replay: ReplayNotice

    private state: SimulationViewState | undefined

    private drawerOpen = readSetting(DRAWER_KEY, 'open') === 'open'

    private toolsKey = ''

    /** Number format per variable id; anything unset shows as decimal. */
    private readonly formats = readFormats()

    constructor(private readonly messenger: Messenger) {
        this.breakpoints = new BreakpointPanel((command) => this.send(command))
        this.watches = new WatchPanel((command) => this.send(command))
        this.replay = new ReplayNotice((command) => this.send(command))
        this.toolbar = new Toolbar({
            send: (command) => this.send(command),
            toggleDrawer: () => this.setDrawer(!this.drawerOpen),
            drawerOpen: () => this.drawerOpen,
            toggleBreakpoints: () => {
                this.breakpoints.toggle()
                if (this.state) this.toolbar.render(this.state)
            },
            breakpointsOpen: () => this.breakpoints.isOpen(),
        })
        this.timeline = new Timeline((command) => this.send(command), {
            get: (id) => this.formatFor(id),
            cycle: (id) => this.cycleFormat(id),
        })
        this.buildLayout()
        this.messenger.onNotification(simulationStateNotification, (state) => this.update(state))
        document.addEventListener('keydown', (event) => this.onKeyDown(event))
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.connect()
        })
    }

    /** Whether a simulation is running for the shown model. */
    get running(): boolean {
        return this.state?.phase === 'running'
    }

    /** Call once the messenger is started, so the extension can answer with the current state. */
    connect(): void {
        this.send({ kind: 'requestState' })
    }

    private send(command: SimulationViewCommand): void {
        this.messenger.sendNotification(simulationCommandNotification, HOST_EXTENSION, {
            ...command,
            modelUri: this.state?.modelUri,
        })
    }

    private formatFor(id: string): NumberFormat {
        return this.formats[id] ?? 'dec'
    }

    private cycleFormat(id: string): void {
        this.formats[id] = nextFormat(this.formatFor(id))
        writeSetting(FORMATS_KEY, JSON.stringify(this.formats))
        if (this.state) {
            this.update(this.state)
        }
    }

    private buildLayout(): void {
        // sprotty-vscode emits a single `<clientId>_container` div; the diagram renders into it.
        const container = document.querySelector<HTMLElement>('div[id$="_container"]')
        if (!container) {
            return
        }
        container.style.removeProperty('height')
        container.classList.add('kv-diagram')

        const handle = h('div.kv-drawer-handle', {
            title: 'Drag to resize',
            role: 'separator',
            tabindex: 0,
            'aria-label': 'Resize simulation trace',
            'aria-orientation': 'horizontal',
            onkeydown: (event) => {
                const { key } = event as KeyboardEvent
                if (key === 'ArrowUp' || key === 'ArrowDown') {
                    event.preventDefault()
                    this.resizeDrawer(this.drawer.getBoundingClientRect().height + (key === 'ArrowUp' ? 20 : -20))
                    writeSetting(DRAWER_HEIGHT_KEY, String(Math.round(this.drawer.getBoundingClientRect().height)))
                }
            },
            onmousedown: (event) => this.startResize(event as MouseEvent),
        })
        // Watches and the trace's tools share the top line; what the last tick did sits above the table.
        const header = h('div.kv-drawer-header', {}, this.watches.el, this.tools)
        replaceChildren(this.drawer, handle, header, this.notice, this.replay.el, this.summary, this.timeline.el)
        this.resizeDrawer(Number(readSetting(DRAWER_HEIGHT_KEY, '220')))

        replaceChildren(this.root, this.toolbar.el, this.breakpoints.el, container, this.drawer)
        document.body.insertBefore(this.root, document.body.firstChild)
        // Only klighd's sidebar reads this offset; feeding the measured height back into the
        // toolbar's own height would grow it by its border on every cycle.
        const resize = new ResizeObserver(() => {
            document.documentElement.style.setProperty(
                '--kv-toolbar-offset',
                `${container.getBoundingClientRect().top}px`
            )
            window.dispatchEvent(new Event('resize'))
        })
        resize.observe(this.toolbar.el)
        resize.observe(container)
        this.toolbar.render({
            phase: 'idle',
            canStart: false,
            playing: false,
            tick: 0,
            firstTick: 1,
            stepDelay: 200,
            showInternal: false,
            variables: [],
        })
    }

    private update(state: SimulationViewState): void {
        if (
            state.modelUri !== this.state?.modelUri ||
            state.phase !== 'running' ||
            state.tick < (this.state?.tick ?? 0)
        ) {
            this.timeline.clear()
            replaceChildren(this.summary)
        }
        this.state = state
        this.toolbar.render(state)
        this.breakpoints.render(state)
        const showDrawer = state.phase === 'running' && this.drawerOpen
        this.drawer.hidden = !showDrawer
        if (showDrawer) {
            replaceChildren(
                this.summary,
                renderSummary(state, (id) => this.formatFor(id))
            )
            // Rebuilt only when a tool's state changes; a click must not land on a replaced button.
            const toolsKey = String(state.showInternal)
            if (toolsKey !== this.toolsKey) {
                this.toolsKey = toolsKey
                replaceChildren(
                    this.tools,
                    renderDrawerTools(state, (command) => this.send(command))
                )
            }
            replaceChildren(this.notice, renderPauseNotice(state.debug))
            this.replay.render(state)
            this.watches.render(state)
            this.timeline.render(state)
        }
    }

    private setDrawer(open: boolean): void {
        this.drawerOpen = open
        writeSetting(DRAWER_KEY, open ? 'open' : 'closed')
        if (this.state) {
            this.update(this.state)
        }
        window.dispatchEvent(new Event('resize'))
    }

    private startResize(event: MouseEvent): void {
        if (event.button !== 0) return
        event.preventDefault()
        const startY = event.clientY
        const startHeight = this.drawer.getBoundingClientRect().height
        const onMove = (move: MouseEvent) => {
            this.resizeDrawer(startHeight + (startY - move.clientY))
        }
        const onUp = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            window.removeEventListener('blur', onUp)
            document.body.classList.remove('kv-resizing')
            writeSetting(DRAWER_HEIGHT_KEY, String(Math.round(this.drawer.getBoundingClientRect().height)))
            window.dispatchEvent(new Event('resize'))
        }
        document.body.classList.add('kv-resizing')
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        window.addEventListener('blur', onUp)
    }

    private resizeDrawer(height: number): void {
        const maxHeight = Math.max(
            MIN_DRAWER,
            window.innerHeight - this.toolbar.el.getBoundingClientRect().height - 120
        )
        const size = Math.min(maxHeight, Math.max(MIN_DRAWER, Number.isFinite(height) ? height : 220))
        this.drawer.style.setProperty('--kv-drawer-height', `${size}px`)
        this.drawer.querySelector('[role="separator"]')?.setAttribute('aria-valuenow', String(Math.round(size)))
    }

    private onKeyDown(event: KeyboardEvent): void {
        const { target } = event
        if (
            event.defaultPrevented ||
            event.repeat ||
            (target instanceof HTMLElement &&
                (target.isContentEditable || target.closest('input, textarea, select, button, a, [role="separator"]')))
        ) {
            return
        }
        if (!this.state || this.state.phase !== 'running' || event.ctrlKey || event.metaKey || event.altKey) {
            return
        }
        const busy = this.state.playing || !!this.state.debug?.runningToBreakpoint
        if (event.code === 'Space') {
            event.preventDefault()
            if (!busy) this.send({ kind: 'step' })
        } else if (event.key === 'r' || event.key === 'R') {
            event.preventDefault()
            this.send({ kind: this.state.playing ? 'pause' : 'play' })
        } else if (event.key === 'Backspace') {
            event.preventDefault()
            if (!busy && this.state.debug?.canStepBack) this.send({ kind: 'stepBack' })
        } else if (event.key === 'c' || event.key === 'C') {
            event.preventDefault()
            if (this.state.debug?.runningToBreakpoint) this.send({ kind: 'pause' })
            else if (!busy) this.send({ kind: 'runToBreakpoint' })
        }
    }
}

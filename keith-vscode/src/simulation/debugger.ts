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

import type { Memento } from 'vscode'
import { BreakpointPause, BreakpointState, ModelStateInfo, SimulationDebugState, WatchState } from './protocol'

/** The subset of the language client the debugger talks to; keeps the class testable without vscode-languageclient. */
export interface DebugConnection {
    sendRequest<R>(method: string, param?: unknown): Promise<R>
    sendNotification(method: string, param?: unknown): Promise<void>
}

interface Accepted {
    id: string
    ok: boolean
    message?: string
}

interface AcceptedResult {
    accepted: Accepted[]
}

/** Per-model breakpoints and watches, remembered in the workspace so a restarted simulation keeps them. */
export interface StoredDebugSettings {
    breakpoints: Omit<BreakpointState, 'error' | 'note'>[]
    watches: { id: string; expression: string }[]
}

export interface StepBackResult {
    ok: boolean
    message?: string
    step: number
    replayMs: number
}

/** The additions the server puts on a keith/simulation/didStep message. */
export interface DebugStepFields {
    step?: number
    watches?: { id: string; value?: unknown; error?: string }[]
    breakpoint?: BreakpointPause
    rewound?: boolean
}

const STORAGE_PREFIX = 'keith.simulation.debug:'

/**
 * Breakpoints, watches and rewinding for the simulation of one model: keeps the client's view of the
 * server's `keith/simulation/*` debugging methods and persists the definitions per model URI.
 */
export class SimulationDebugger {
    breakpoints: BreakpointState[] = []

    watches: WatchState[] = []

    paused: BreakpointPause | undefined

    runningToBreakpoint = false

    /** The model's states as the server listed them when the simulation started. */
    states: ModelStateInfo[] = []

    private modelUri: string | undefined

    private nextId = Date.now()

    constructor(
        private readonly connection: DebugConnection,
        private readonly storage: Memento,
        private readonly changed: () => void
    ) {}

    /** Loads the stored definitions of a model and sends them to the server; call once the simulation started. */
    async attach(modelUri: string): Promise<void> {
        this.modelUri = modelUri
        this.paused = undefined
        this.runningToBreakpoint = false
        const stored = this.storage.get<StoredDebugSettings>(STORAGE_PREFIX + modelUri)
        this.breakpoints = (stored?.breakpoints ?? []).map((breakpoint) => ({ ...breakpoint }))
        this.watches = (stored?.watches ?? []).map((watch) => ({ ...watch }))
        this.watches.forEach((watch) => {
            watch.value = undefined
            watch.error = undefined
        })
        this.states = []
        await this.sync()
        try {
            const listed = await this.connection.sendRequest<{ states?: ModelStateInfo[] }>('keith/simulation/states', {
                uri: modelUri,
            })
            this.states = (listed?.states ?? []).filter((state) => state.qualified.includes('.'))
        } catch {
            // Without the list, breakpoints are still typed by name.
        }
        this.changed()
    }

    /** Forgets the running simulation's values but keeps the definitions for the next run. */
    detach(): void {
        this.modelUri = undefined
        this.paused = undefined
        this.runningToBreakpoint = false
        this.watches.forEach((watch) => {
            watch.value = undefined
            watch.error = undefined
        })
        this.changed()
    }

    get attached(): boolean {
        return this.modelUri !== undefined
    }

    state(tick: number): SimulationDebugState {
        return {
            breakpoints: this.breakpoints.map((breakpoint) => ({ ...breakpoint })),
            states: this.states,
            watches: this.watches.map((watch) => ({ ...watch })),
            paused: this.paused,
            canStepBack: tick > 0,
            runningToBreakpoint: this.runningToBreakpoint,
        }
    }

    async addBreakpoint(definition: { state?: string; expression?: string }): Promise<BreakpointState | undefined> {
        const state = definition.state?.trim()
        const expression = definition.expression?.trim()
        if (!state && !expression) return undefined
        const breakpoint: BreakpointState = state
            ? { id: this.id(), kind: 'state', state, enabled: true }
            : { id: this.id(), kind: 'condition', expression, enabled: true }
        this.breakpoints.push(breakpoint)
        await this.store()
        await this.sync()
        return breakpoint
    }

    async removeBreakpoint(id: string): Promise<void> {
        this.breakpoints = this.breakpoints.filter((breakpoint) => breakpoint.id !== id)
        await this.store()
        await this.sync()
    }

    async toggleBreakpoint(id: string, enabled: boolean): Promise<void> {
        const breakpoint = this.breakpoints.find((entry) => entry.id === id)
        if (!breakpoint || breakpoint.enabled === enabled) return
        breakpoint.enabled = enabled
        await this.store()
        await this.sync()
    }

    async addWatch(expression: string): Promise<WatchState | undefined> {
        const text = expression.trim()
        if (!text) return undefined
        const watch: WatchState = { id: this.id(), expression: text }
        this.watches.push(watch)
        await this.store()
        await this.sync()
        return watch
    }

    async removeWatch(id: string): Promise<void> {
        this.watches = this.watches.filter((watch) => watch.id !== id)
        await this.store()
        await this.sync()
    }

    /** Takes the debugging fields of a step message; returns true when a breakpoint fired. */
    onStep(message: DebugStepFields): boolean {
        if (!this.attached) return false
        if (message.watches) {
            message.watches.forEach((update) => {
                const watch = this.watches.find((entry) => entry.id === update.id)
                if (watch) {
                    watch.value = update.error ? undefined : update.value
                    watch.error = update.error
                }
            })
        }
        this.paused = message.breakpoint
        if (message.breakpoint || message.rewound) this.runningToBreakpoint = false
        return !!message.breakpoint
    }

    onPaused(hit: BreakpointPause): void {
        this.paused = hit
        this.runningToBreakpoint = false
        this.changed()
    }

    async runToBreakpoint(maxSteps = 1000): Promise<void> {
        if (!this.attached || this.runningToBreakpoint) return
        this.paused = undefined
        this.runningToBreakpoint = true
        this.changed()
        await this.connection.sendNotification('keith/simulation/runToBreakpoint', { maxSteps })
    }

    async pause(): Promise<void> {
        if (!this.runningToBreakpoint) return
        this.runningToBreakpoint = false
        this.changed()
        await this.connection.sendNotification('keith/simulation/pause')
    }

    /** Rewinds to the state after `toStep`; the server answers with a didStep message marked `rewound`. */
    async stepBack(toStep: number): Promise<StepBackResult> {
        if (!this.attached) return { ok: false, message: 'No simulation is running.', step: 0, replayMs: 0 }
        this.paused = undefined
        const result = await this.connection.sendRequest<StepBackResult>('keith/simulation/stepBack', {
            toStep: Math.max(0, Math.floor(toStep)),
        })
        return result
    }

    /** Sends the definitions to the server and records what it accepted. */
    async sync(): Promise<void> {
        if (!this.attached) {
            this.changed()
            return
        }
        const [breakpoints, watches] = await Promise.all([
            this.connection.sendRequest<AcceptedResult>('keith/simulation/setBreakpoints', {
                breakpoints: this.breakpoints.map((breakpoint) => ({
                    id: breakpoint.id,
                    kind: breakpoint.kind,
                    state: breakpoint.state,
                    expression: breakpoint.expression,
                    enabled: breakpoint.enabled,
                })),
            }),
            this.connection.sendRequest<AcceptedResult>('keith/simulation/setWatches', {
                watches: this.watches.map((watch) => ({ id: watch.id, expression: watch.expression })),
            }),
        ])
        breakpoints?.accepted?.forEach((accepted) => {
            const breakpoint = this.breakpoints.find((entry) => entry.id === accepted.id)
            if (!breakpoint) return
            breakpoint.error = accepted.ok ? undefined : accepted.message ?? 'Rejected by the server.'
            breakpoint.note = accepted.ok ? accepted.message ?? undefined : undefined
        })
        watches?.accepted?.forEach((accepted) => {
            const watch = this.watches.find((entry) => entry.id === accepted.id)
            if (watch && !accepted.ok) {
                watch.error = accepted.message ?? 'Rejected by the server.'
                watch.value = undefined
            }
        })
        this.changed()
    }

    private async store(): Promise<void> {
        if (!this.modelUri) return
        const stored: StoredDebugSettings = {
            breakpoints: this.breakpoints.map(({ id, kind, state, expression, enabled }) => ({
                id,
                kind,
                state,
                expression,
                enabled,
            })),
            watches: this.watches.map(({ id, expression }) => ({ id, expression })),
        }
        await this.storage.update(STORAGE_PREFIX + this.modelUri, stored)
    }

    private id(): string {
        this.nextId += 1
        return `d${this.nextId.toString(36)}`
    }
}

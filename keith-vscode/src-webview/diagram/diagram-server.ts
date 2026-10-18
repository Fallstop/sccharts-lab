/*
 * SCCharts Lab
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { Connection, ServiceTypes } from '@kieler/klighd-core'
import { KlighdDiagramServer } from '@kieler/klighd-core/lib/diagram-server'
import { inject, injectable } from 'inversify'
import { ActionMessage } from 'sprotty-protocol'
import { keepsViewport } from './viewport-policy'

/** Tells the diagram server whether a simulation is running in this webview. */
export const SimulationRunning = Symbol('SimulationRunning')

export type SimulationRunningQuery = () => boolean

/** Tells the extension that a model of a running simulation is drawn. */
export const ModelDrawn = Symbol('ModelDrawn')

export type ModelDrawnListener = () => void

/** Sprotty's proxy marks an action from the server with this, so it is not sent back. */
const RECEIVED_FROM_SERVER = '__receivedFromServer'

/**
 * klighd-core's diagram server refits the diagram after every model update while "Resize To Fit on Refresh" is on,
 * which is the default and, without the sidebar, cannot be changed. A running simulation sends a model update per
 * tick, so this server applies those updates the plain sprotty way, keeping the viewport.
 */
@injectable()
export class KeithDiagramServer extends KlighdDiagramServer {
    constructor(
        @inject(ServiceTypes.Connection) connection: Connection,
        @inject(SimulationRunning) private readonly simulationRunning: SimulationRunningQuery,
        @inject(ModelDrawn) private readonly modelDrawn: ModelDrawnListener
    ) {
        super(connection)
    }

    /** A model update of a running simulation is being drawn. */
    private drawing = false

    /** The newest model update that arrived while another was drawn. */
    private waiting: ActionMessage | undefined

    override messageReceived(message: ActionMessage): void {
        if (keepsViewport(message.action?.kind, this.simulationRunning())) {
            this.drawLatest(message)
            return
        }
        super.messageReceived(message)
    }

    /**
     * Applies a model the plain sprotty way, keeping the viewport (klighd-core's override would refit).
     * A fast run sends a model per tick, faster than the webview draws them, and drawing each in turn
     * fell further and further behind until the editor froze. While one is drawn, only the newest of
     * those that arrive waits; the others are skipped. Each is the whole diagram, so none is missed.
     */
    private drawLatest(message: ActionMessage): void {
        if (this.drawing) {
            this.waiting = message
            return
        }
        if (message.clientId && message.clientId !== this.clientId) return
        this.drawing = true
        const { action } = message
        ;(action as unknown as Record<string, unknown>)[RECEIVED_FROM_SERVER] = true
        this.actionDispatcher
            .dispatch(action)
            .then(() => this.storeNewModel(action))
            .catch(() => undefined)
            .finally(() => {
                this.drawing = false
                const next = this.waiting
                this.waiting = undefined
                if (next) this.messageReceived(next)
                else this.modelDrawn()
            })
    }
}

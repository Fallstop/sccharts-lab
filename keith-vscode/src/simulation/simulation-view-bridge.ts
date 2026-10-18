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

import * as path from 'path'
import * as vscode from 'vscode'
import { Settings, settingsKey } from '../constants'
import { DiagramController } from '../diagram/diagram-controller'
import { GENERATE_CODE } from '../kico/code-generation'
import { SHOW_MODEL, SHOW_STAGE } from '../kico/commands'
import { SettingsService } from '../settings'
import {
    COMPARE_RUN,
    COMPILE_AND_SIMULATE,
    LOAD_TRACE,
    PAUSE_SIMULATION,
    RUN_SIMULATION,
    SAVE_TRACE,
    STEP_SIMULATION,
    STOP_SIMULATION,
} from './commands'
import {
    HISTORY_WINDOW,
    SimulationVariableState,
    SimulationViewRequest,
    SimulationViewState,
    simulationCommandNotification,
    simulationStateNotification,
} from './protocol'
import { SimulationData, SimulationTableDataProvider } from './simulation-table-data-provider'

/**
 * Connects the simulation state owned by {@link SimulationTableDataProvider} to the controls
 * rendered inside the diagram preview webview. State flows out as one snapshot per change;
 * user actions flow back as commands and are routed to the existing VS Code commands.
 */
export class SimulationViewBridge implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = []

    constructor(
        private readonly simulation: SimulationTableDataProvider,
        private readonly diagrams: DiagramController,
        private readonly settings: SettingsService<Settings>
    ) {
        this.disposables.push(
            diagrams.onWebviewNotification(simulationCommandNotification, (command) => {
                this.handle(command).catch((error) => {
                    vscode.window.showErrorMessage(`The simulation command failed: ${error}`)
                    this.push()
                })
            })
        )
        this.disposables.push(simulation.onDidChangeViewState(() => this.push()))
        this.disposables.push(diagrams.onDidChangeDiagram(() => this.push()))
        this.disposables.push(simulation.kico.onDidChangeStage(() => this.push()))
        // The settings cache refreshes in an earlier listener, so the values are current here.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`${settingsKey}.showInternalVariables.enabled`)) {
                    simulation.initializeTable()
                } else if (event.affectsConfiguration(settingsKey)) {
                    this.push()
                }
            })
        )
    }

    dispose(): void {
        this.disposables.forEach((disposable) => disposable.dispose())
    }

    push(): void {
        this.diagrams.sendToDiagram(simulationStateNotification, this.viewState())
    }

    private async handle(command: SimulationViewRequest): Promise<void> {
        if (!command || typeof command.kind !== 'string') return
        const diagramCommands = ['showModel', 'showStage', 'generateCode']
        if (!['requestState', 'setStepDelay', 'setShowInternal', ...diagramCommands].includes(command.kind)) {
            const state = this.viewState()
            const canHandle = command.kind === 'start' ? state.canStart : state.phase === 'running'
            if (!command.modelUri || command.modelUri !== state.modelUri || !canHandle) {
                this.push()
                return
            }
        } else if (diagramCommands.includes(command.kind)) {
            // These act on whatever the preview shows, which must still be the model the button was pressed for.
            if (!command.modelUri || command.modelUri !== this.diagrams.currentUri?.toString()) {
                this.push()
                return
            }
        }
        switch (command.kind) {
            case 'requestState':
                this.push()
                break
            case 'start':
                await vscode.commands.executeCommand(COMPILE_AND_SIMULATE.command, this.diagrams.currentUri)
                break
            case 'rebuild':
                await this.simulation.rebuildSimulation()
                break
            case 'showModel':
                await vscode.commands.executeCommand(SHOW_MODEL.command, this.diagrams.currentUri)
                break
            case 'showStage':
                await vscode.commands.executeCommand(SHOW_STAGE.command, this.diagrams.currentUri)
                break
            case 'generateCode':
                await vscode.commands.executeCommand(GENERATE_CODE, this.diagrams.currentUri)
                break
            case 'step':
                await vscode.commands.executeCommand(STEP_SIMULATION.command)
                break
            case 'play':
                if (!this.simulation.play) {
                    await vscode.commands.executeCommand(RUN_SIMULATION.command)
                }
                break
            case 'pause':
                if (this.simulation.play) {
                    await vscode.commands.executeCommand(PAUSE_SIMULATION.command)
                } else if (this.simulation.debugger.runningToBreakpoint) {
                    await this.simulation.debugger.pause()
                }
                break
            case 'stop':
                await vscode.commands.executeCommand(STOP_SIMULATION.command)
                break
            case 'restart':
                await this.simulation.restartSimulation()
                break
            case 'saveTrace':
                await vscode.commands.executeCommand(SAVE_TRACE.command)
                break
            case 'loadTrace':
                await vscode.commands.executeCommand(LOAD_TRACE.command)
                break
            case 'stopReplay':
                this.simulation.stopReplay()
                break
            case 'compareTrace':
                await vscode.commands.executeCommand(COMPARE_RUN.command)
                break
            case 'setInput': {
                const data = this.simulation.simulationData.get(command.id)
                if (data && data.input) {
                    this.simulation.setInputValue(data, command.value)
                }
                break
            }
            case 'setStepDelay':
                if (Number.isSafeInteger(command.delay) && command.delay >= 0) {
                    await this.settings.set('simulationStepDelay', command.delay)
                }
                break
            case 'setShowInternal':
                if (typeof command.enabled === 'boolean') {
                    await this.settings.set('showInternalVariables.enabled', command.enabled)
                }
                break
            case 'addBreakpoint':
                await this.simulation.debugger.addBreakpoint({ state: command.state, expression: command.expression })
                break
            case 'removeBreakpoint':
                await this.simulation.debugger.removeBreakpoint(command.id)
                break
            case 'toggleBreakpoint':
                await this.simulation.debugger.toggleBreakpoint(command.id, !!command.enabled)
                break
            case 'addWatch':
                await this.simulation.debugger.addWatch(command.expression)
                break
            case 'removeWatch':
                await this.simulation.debugger.removeWatch(command.id)
                break
            case 'stepBack':
                await this.simulation.stepBack(command.toStep)
                break
            case 'runToBreakpoint':
                await this.simulation.runToBreakpoint()
                break
            default:
                break
        }
    }

    viewState(): SimulationViewState {
        const sim = this.simulation
        const uri = this.diagrams.currentUri
        const modelUri = uri?.toString()
        const matches = !!modelUri && !!sim.modelUri && modelUri === vscode.Uri.parse(sim.modelUri).toString()
        const tick = matches ? Math.max(0, sim.simulationStep) : 0
        const firstTick = Math.max(1, tick - HISTORY_WINDOW + 1)
        const variables: SimulationVariableState[] = []
        sim.simulationData.forEach((entry) => {
            if (matches && !sim.isBlacklisted(entry)) {
                variables.push(this.variableState(entry, tick, firstTick))
            }
        })
        const shown = sim.kico.currentStage(modelUri)
        return {
            phase: matches ? sim.phase : 'idle',
            canStart: !!uri && sim.phase !== 'starting' && sim.phase !== 'stopping',
            playing: matches && sim.play,
            tick,
            firstTick,
            stepDelay: this.settings.get('simulationStepDelay'),
            showInternal: this.settings.get('showInternalVariables.enabled'),
            modelUri,
            model: uri ? path.basename(uri.path) : undefined,
            variables,
            error: matches ? sim.lastError : undefined,
            stale: matches && sim.stale,
            stage: shown ? { name: shown.name, position: shown.index + 1, count: shown.count } : undefined,
            canGenerate: !!uri && uri.scheme === 'file' && uri.path.endsWith('.sctx'),
            debug: matches && sim.phase === 'running' ? sim.debugger.state(tick) : undefined,
            replay: matches && sim.phase === 'running' && sim.replay ? sim.replay.state(tick) : undefined,
        }
    }

    private variableState(entry: SimulationData, tick: number, firstTick: number): SimulationVariableState {
        // history[i] holds the value after tick i + 1.
        const history = entry.data.slice(Math.max(0, firstTick - 1), Math.max(0, tick))
        let role: SimulationVariableState['role'] = 'local'
        if (entry.input) {
            role = 'input'
        } else if (entry.output) {
            role = 'output'
        }
        const expected = this.simulation.replay
            ?.mismatchesOf(entry.id)
            .filter((mismatch) => mismatch.tick >= firstTick && mismatch.tick <= tick)
            .map((mismatch) => ({ tick: mismatch.tick, value: mismatch.expected }))
        return {
            id: entry.id,
            label: entry.label,
            role,
            categories: entry.categories,
            history,
            expected: expected && expected.length > 0 ? expected : undefined,
            next: entry.input ? this.simulation.valuesForNextStep.get(entry.id) : undefined,
            pending: this.simulation.changedValuesForNextStep.has(entry.id),
            internal: this.simulation.isInternal(entry),
        }
    }
}

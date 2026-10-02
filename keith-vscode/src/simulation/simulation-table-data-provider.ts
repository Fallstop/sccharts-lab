/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2021 - 2024 by
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
import { LanguageClient, State } from 'vscode-languageclient/node'
import { Settings, SimulationType } from '../constants'
import {
    CompilationDataProvider,
    CompilationSystem,
    CompilationSystemsMessage,
} from '../kico/compilation-data-provider'
import { SettingsService } from '../settings'
import { Tuple } from '../util'
import {
    ADD_CO_SIMULATION,
    COMPILE_AND_SIMULATE,
    COMPILE_AND_SIMULATE_SNAPSHOT,
    LOAD_TRACE,
    NEW_VALUE_SIMULATION,
    STEP_BACK_SIMULATION,
    RUN_TO_BREAKPOINT,
    ADD_BREAKPOINT,
    ADD_WATCH,
    PAUSE_SIMULATION,
    REBUILD_SIMULATION,
    RUN_SIMULATION,
    SAVE_TRACE,
    SET_SIMULATION_STEP_DELAY,
    SET_SIMULATION_TYPE_TO,
    SHOW_INTERNAL_VARIABLES,
    RESTART_LANGUAGE_SERVER,
    SIMULATE,
    STEP_SIMULATION,
    STOP_SIMULATION,
} from './commands'
import {
    isInternal,
    isTimeDelta,
    isTimeRelated,
    LoadedTraceMessage,
    SavedTraceMessage,
    SimulationDataBlackList,
    SimulationStartedMessage,
    SimulationStepMessage,
    SimulationStoppedMessage,
    strMapToObj,
    Trace,
} from './helper'
import { BreakpointPause, SimulationPhase } from './protocol'
import { isCompatibleInput } from './input-value'
import { inputValue, readDataPool } from './data-pool'
import { StepController } from './step-controller'
import { DebugStepFields, SimulationDebugger } from './debugger'

export const externalStepMessageType = 'keith/simulation/didStep'
export const valuesForNextStepMessageType = 'keith/simulation/valuesForNextStep'
export const externalStopMessageType = 'keith/simulation/externalStop'
export const startedSimulationMessageType = 'keith/simulation/started'
export const pausedSimulationMessageType = 'keith/simulation/paused'

/** Workspace-state key remembering the Δt a user last set, reused when the next simulation starts. */
const DELTA_T_KEY = 'keith.simulation.deltaT'

export class SimulationTableDataProvider {
    public readonly newSimulationDataEmitter = new vscode.EventEmitter<this>()

    public readonly newSimulationData: vscode.Event<this> = this.newSimulationDataEmitter.event

    protected readonly onRequestSimulationSystemsEmitter = new vscode.EventEmitter<this | undefined>()

    readonly onDidChangeOpenStateEmitter = new vscode.EventEmitter<boolean>()

    /** Fires whenever anything the simulation controls in the diagram preview show has changed. */
    private readonly onDidChangeViewStateEmitter = new vscode.EventEmitter<void>()

    public readonly onDidChangeViewState: vscode.Event<void> = this.onDidChangeViewStateEmitter.event

    /** Where the simulation is in its lifecycle, as shown in the diagram preview. */
    public phase: SimulationPhase = 'idle'

    /** Last start or step failure, cleared when the next simulation starts. */
    public lastError: string | undefined

    public modelUri: string | undefined

    private generation = 0

    private starting = false

    private startTimer: ReturnType<typeof setTimeout> | undefined

    private pickingSystem = false

    private stopRequest: Promise<boolean> | undefined

    private readonly stepper = new StepController(async () => {
        const values = strMapToObj(this.changedValuesForNextStep)
        // Edits made after dispatch belong to the following tick.
        this.changedValuesForNextStep.clear()
        await this.lsClient.sendNotification('keith/simulation/step', {
            valuesForNextStep: values,
            simulationType: 'Manual',
        })
    })

    output: vscode.OutputChannel

    /**
     * Trace for each symbol.
     */
    public simulationData: Map<string, SimulationData> = new Map()
    /**
     * Trace for each symbol.
     */
    // public simulationTreeData: SimulationTreeData[] = [new SimulationTreeData("test", "test", vscode.TreeItemCollapsibleState.None, [true, true, false], true, true, ["fun", "with", "flags"])]

    /**
     * Holds the value that is set in the next tick. Holds only the inputs of the simulation
     */
    public valuesForNextStep: Map<string, unknown> = new Map()

    /**
     * Indicates whether an input value should be sent to the server.
     */
    public changedValuesForNextStep: Map<string, unknown> = new Map()

    /**
     * Map which holds wether a event listener is registered for a symbol
     */
    public eventListenerRegistered: Map<string, boolean> = new Map()

    /**
     * Wether next simulation step should be requested after a time specified by simulation delay
     */
    public play = false

    /**
     * Set by SimulationContribution after a simulation is started or stopped.
     * If false disables step, stop and play.
     */
    public controlsEnabled = false

    /**
     * Indicates whether a simulation is currently running.
     * TODO this might not be needed since simulationRunning already expresses this
     */
    simulationRunning = false

    /**
     * Categories of variables with their respective members.
     */
    public categories: string[] = []

    /**
     * The trace that is loaded for the current model.
     */
    public currentTrace: Trace

    public simulationStep = -1

    public compilingSimulation = false

    simulationCommands: vscode.Command[] = []

    startTime = 0

    endTime = 0

    public kico: CompilationDataProvider

    private lsClient: LanguageClient

    private systems: CompilationSystem[] = []

    private snapshotSystems: CompilationSystem[] = []

    private simulationStatus: vscode.StatusBarItem

    protected disposables: vscode.Disposable[] = []

    /** Text of the model when it was compiled for the running simulation, to notice later edits. */
    private compiledText: string | undefined

    /** The simulation system the running simulation was built with, so a rebuild needs no prompt. */
    private lastSystem: { id: string; snapshot: boolean } | undefined

    /** The model was edited after the running simulation was built. */
    public stale = false

    /** Breakpoints, watches and rewinding of the running simulation. */
    public readonly debugger: SimulationDebugger

    constructor(
        lsClient: LanguageClient,
        kico: CompilationDataProvider,
        readonly context: vscode.ExtensionContext,
        private readonly settings: SettingsService<Settings>
    ) {
        // Output channel
        this.output = vscode.window.createOutputChannel('KIELER Simulation')
        this.output.appendLine(`[INFO]\t${'Simulation view is created'}`)

        this.lsClient = lsClient
        this.kico = kico
        this.debugger = new SimulationDebugger(
            {
                sendRequest: (method, param) => lsClient.sendRequest(method, param),
                sendNotification: (method, param) => lsClient.sendNotification(method, param),
            },
            context.workspaceState,
            () => this.onDidChangeViewStateEmitter.fire()
        )
        this.simulationStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
        this.context.subscriptions.push(this.simulationStatus)

        // Push context variables for conditional menu items
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)

        // Bind to events
        this.disposables.push(
            kico.newSimulationCommands((systems) => {
                if (typeof systems !== 'undefined') {
                    this.registerSimulationCommands(systems)
                }
                // Else case is not important enough to alert the user
            })
        )
        this.disposables.push(
            kico.compilationStarted(() => {
                this.compilationStarted()
            })
        )
        this.disposables.push(
            kico.compilationFinished((success) => {
                if (typeof success !== 'undefined') {
                    this.compilationFinished(success)
                }
                // Else case is not important enough to alert the user
            })
        )
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => this.onDidChangeModelText(event.document))
        )
        // Bind to LSP messages
        this.disposables.push(
            lsClient.onDidChangeState((event) => {
                if (event.newState === State.Stopped) this.resetForRestart()
            }),
            lsClient.onNotification(externalStepMessageType, (message: SimulationStepMessage) => {
                this.handleStepMessage(message)
            }),
            lsClient.onNotification(valuesForNextStepMessageType, (message: SimulationStepMessage) => {
                this.handleExternalNewUserValue(message)
            }),
            lsClient.onNotification(externalStopMessageType, (message: string) => {
                this.handleExternalStop(message)
            }),
            lsClient.onNotification(startedSimulationMessageType, (message: SimulationStartedMessage) => {
                this.handleSimulationStarted(message)
            }),
            lsClient.onNotification(pausedSimulationMessageType, (hit: BreakpointPause) => {
                this.handlePaused(hit)
            })
        )
        this.context.subscriptions.push(this)

        // Create commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SIMULATE.command, async () => {
                await this.restartSimulation()
            }),
            vscode.commands.registerCommand(REBUILD_SIMULATION.command, async () => {
                await this.rebuildSimulation()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(STOP_SIMULATION.command, async () => {
                await this.stopSimulation()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(STEP_SIMULATION.command, async () => {
                await this.executeSimulationStep()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(PAUSE_SIMULATION.command, async () => {
                await this.setPlaying(false)
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(RUN_SIMULATION.command, async () => {
                await this.setPlaying(true)
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SAVE_TRACE.command, async () => {
                await this.saveTrace()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(LOAD_TRACE.command, async () => {
                await this.loadTrace()
            })
        )

        // Simulation quickpick commands

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_AND_SIMULATE.command, (uri?: vscode.Uri) =>
                this.compileAndSimulate(false, uri)
            )
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_AND_SIMULATE_SNAPSHOT.command, () => this.compileAndSimulate(true))
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(ADD_CO_SIMULATION.command, this.handleAddCoSimulation, this)
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(NEW_VALUE_SIMULATION.command, this.newInputValue, this)
        )

        // Debugging commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(STEP_BACK_SIMULATION.command, () => this.stepBack()),
            vscode.commands.registerCommand(RUN_TO_BREAKPOINT.command, () => this.runToBreakpoint()),
            vscode.commands.registerCommand(ADD_BREAKPOINT.command, () => this.addBreakpointInteractively()),
            vscode.commands.registerCommand(ADD_WATCH.command, () => this.addWatchInteractively())
        )

        // settings commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SET_SIMULATION_STEP_DELAY.command, async () => {
                const input = await vscode.window.showInputBox({
                    validateInput: (val) =>
                        /^\d+$/.test(val.trim()) && Number.isSafeInteger(Number(val))
                            ? null
                            : 'Enter a non-negative whole number of milliseconds.',
                })
                if (input !== undefined) {
                    await this.settings.set('simulationStepDelay', Number(input))
                }
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SET_SIMULATION_TYPE_TO.command, () => {
                const simulationTypes: Tuple<SimulationType> = ['Manual', 'Periodic', 'Dynamic']
                const options: vscode.QuickPickItem[] = simulationTypes.map((type) => ({
                    label: type,
                    picked: this.settings.get('simulationType') === type,
                }))
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('simulationType', selection[0].label as SimulationType)
                    }
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_INTERNAL_VARIABLES.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('showInternalVariables.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('showInternalVariables.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('showInternalVariables.enabled', selection[0]?.label === 'true')
                        this.initializeTable()
                    }
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )
    }

    clickedRow(rowId: string): void {
        const data = this.simulationData.get(rowId)
        if (!data || !data.input) {
            return
        }
        const current = this.valuesForNextStep.get(rowId)
        if (typeof current === 'boolean') {
            this.setInputValue(data, !current)
        } else {
            this.newInputValue(data)
        }
    }

    /**
     * Queues a new input value for the next tick and reflects it in the table.
     */
    setInputValue(simulationData: SimulationData, value: unknown): void {
        if (isTimeDelta(simulationData) && typeof value === 'number' && value > 0) {
            this.context.workspaceState.update(DELTA_T_KEY, value)
        }
        if (
            !this.simulationRunning ||
            this.phase !== 'running' ||
            !simulationData.input ||
            this.simulationData.get(simulationData.id) !== simulationData ||
            !isCompatibleInput(value, this.valuesForNextStep.get(simulationData.id))
        )
            return
        this.valuesForNextStep.set(simulationData.id, value)
        this.changedValuesForNextStep.set(simulationData.id, value)
        this.onDidChangeViewStateEmitter.fire()
    }

    /**
     * Starts the simulation again from tick 0. With the model unchanged the compiled model is reused;
     * after an edit it is rebuilt first, since restarting stale code is never what the author wants.
     */
    async restartSimulation(): Promise<void> {
        if (this.phase === 'starting' || this.phase === 'stopping') return
        if (this.stale && this.lastSystem) {
            await this.rebuildSimulation()
            return
        }
        const uri = this.modelUri ?? this.kico.lastCompiledUri
        if (this.simulationRunning) {
            if (!(await this.stopSimulation())) return
        }
        await this.simulate(uri)
    }

    /**
     * Compiles the current model with the simulation system of the running (or last) simulation and
     * starts over. Falls back to the system prompt when nothing was built yet.
     */
    async rebuildSimulation(): Promise<boolean> {
        if (
            this.pickingSystem ||
            this.phase === 'starting' ||
            this.phase === 'stopping' ||
            this.kico.compiling ||
            this.kico.generatingCode ||
            this.kico.preparingSimulation
        )
            return false
        const uri = this.modelUri ?? this.kico.lastCompiledUri
        const system = this.lastSystem
        if (!uri || !system) return this.compileAndSimulate(false, uri ? vscode.Uri.parse(uri) : undefined)
        this.pickingSystem = true
        this.kico.preparingSimulation = true
        try {
            if (this.simulationRunning && !(await this.stopSimulation())) return false
            const { generation } = this
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
            if (generation !== this.generation) return false
            if (document.isDirty && !(await document.save())) throw new Error('The model could not be saved.')
            if (generation !== this.generation) return false
            return await this.startBuild(document, system.id, system.snapshot)
        } catch (error) {
            this.fail(`The simulation could not be rebuilt: ${error}`)
            return false
        } finally {
            this.pickingSystem = false
            this.kico.preparingSimulation = false
        }
    }

    /**
     * Checks that the tools the build needs are present (and may install them) before the compile request
     * is sent. Set by the extension; a false result cancels the build quietly, the hook has already reported.
     */
    prepareBuild?: (systemId: string, label?: string) => Promise<boolean>

    /** The compilation-finished event starts the run once the saved model was built. */
    private async startBuild(document: vscode.TextDocument, systemId: string, snapshot: boolean): Promise<boolean> {
        const { generation } = this
        if (this.prepareBuild) {
            const label = [...this.systems, ...this.snapshotSystems].find((system) => system.id === systemId)?.label
            if (!(await this.prepareBuild(systemId, label))) return false
        }
        if (generation !== this.generation) return false
        if (document.isDirty) throw new Error('The model changed while preparing the build. Save it and try again.')
        this.lastError = undefined
        this.modelUri = document.uri.toString()
        this.compiledText = document.getText()
        this.lastSystem = { id: systemId, snapshot }
        this.setStale(false)
        this.compilingSimulation = true
        this.setPhase('starting')
        await this.kico.compile(systemId, true, false, snapshot, this.modelUri)
        return true
    }

    private setStale(stale: boolean): void {
        if (this.stale === stale) return
        this.stale = stale
        this.onDidChangeViewStateEmitter.fire()
    }

    /** An edit to the simulated model marks the running simulation as built from an older version. */
    private onDidChangeModelText(document: vscode.TextDocument): void {
        if (!this.modelUri || document.uri.toString() !== vscode.Uri.parse(this.modelUri).toString()) return
        if (this.compiledText === undefined) return
        this.setStale(document.getText() !== this.compiledText)
    }

    private setPhase(phase: SimulationPhase): void {
        this.phase = phase
        this.onDidChangeViewStateEmitter.fire()
    }

    async waitForRunning(): Promise<boolean> {
        if (this.phase !== 'starting') return this.phase === 'running'
        return new Promise<boolean>((resolve) => {
            const subscription = this.onDidChangeViewState(() => {
                if (this.phase !== 'starting') {
                    subscription.dispose()
                    resolve(this.phase === 'running')
                }
            })
        })
    }

    /**
     * Forgets the running simulation without contacting the server, e.g. before restarting the server.
     */
    resetForRestart(): void {
        this.setValuesToStopSimulation()
        this.compilingSimulation = false
        this.stopRequest = undefined
        this.modelUri = undefined
        this.compiledText = undefined
        this.stale = false
        this.lastError = undefined
        this.simulationStep = -1
        this.updateTickIndicators()
        this.simulationStatus.hide()
        this.setPhase('idle')
    }

    dispose() {
        this.stepper.reset()
        clearTimeout(this.startTimer)
        this.disposables.forEach((d) => d.dispose())
        this.output.dispose()
        this.onDidChangeViewStateEmitter.dispose()
        this.newSimulationDataEmitter.dispose()
        this.onRequestSimulationSystemsEmitter.dispose()
        this.onDidChangeOpenStateEmitter.dispose()
    }

    async compileAndSimulate(snapshot: boolean, uri?: vscode.Uri): Promise<boolean> {
        if (
            this.pickingSystem ||
            this.phase === 'starting' ||
            this.phase === 'stopping' ||
            this.kico.compiling ||
            this.kico.generatingCode ||
            this.kico.preparingSimulation
        )
            return false
        this.pickingSystem = true
        const { generation } = this
        try {
            if (uri && uri.toString() !== this.kico.editor?.document.uri.toString()) {
                const editor = await vscode.window.showTextDocument(uri, { preserveFocus: true })
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        subscription.dispose()
                        reject(new Error('The simulation systems did not load.'))
                    }, 10000)
                    const subscription = this.kico.newSimulationCommands(() => {
                        clearTimeout(timer)
                        subscription.dispose()
                        resolve()
                    })
                    this.kico.onDidChangeActiveTextEditor(editor).catch((error) => {
                        clearTimeout(timer)
                        subscription.dispose()
                        reject(error)
                    })
                })
            }
            const { editor } = this.kico
            const systems = snapshot ? this.snapshotSystems : this.systems
            if (!editor || systems.length === 0) {
                await vscode.window.showInformationMessage('Open a model and wait for its simulation systems to load.')
                return false
            }
            const selected = await vscode.window.showQuickPick(
                systems.map((system) => ({ label: system.label, description: system.id, system })),
                { title: snapshot ? 'Simulate diagram snapshot' : 'Simulate model' }
            )
            if (!selected || generation !== this.generation) return false
            this.kico.preparingSimulation = true
            if (this.simulationRunning && !(await this.stopSimulation())) return false
            const preparedGeneration = this.generation
            if (editor.document.isDirty && !(await editor.document.save()))
                throw new Error('The model could not be saved.')
            if (preparedGeneration !== this.generation) return false
            return await this.startBuild(editor.document, selected.system.id, snapshot)
        } catch (error) {
            this.fail(`The simulation could not be prepared: ${error}`)
            return false
        } finally {
            this.pickingSystem = false
            this.kico.preparingSimulation = false
        }
    }

    private fail(message: string): void {
        this.lastError = message
        this.compilingSimulation = false
        this.setValuesToStopSimulation()
        this.simulationStatus.text = '$(error) Simulation failed'
        this.simulationStatus.tooltip = message
        this.simulationStatus.show()
        this.output.appendLine(`[ERROR]\t${message}`)
    }

    createQuickPick(systems: CompilationSystem[]): vscode.QuickPickItem[] {
        const quickPicks: vscode.QuickPickItem[] = []
        systems.forEach((system) => {
            quickPicks.push({
                label: system.label,
            })
        })
        return quickPicks
    }

    // SIMULATION

    /**
     * Registers send systems as simulation systems in the command palette
     * @param systems systems that are assumed to be simulation systems
     */
    registerSimulationCommands(systemsMessage: CompilationSystemsMessage): void {
        this.systems = []
        this.snapshotSystems = []
        systemsMessage.systems.forEach((system) => {
            this.systems.push(system)
        })
        systemsMessage.snapshotSystems.forEach((system) => {
            this.snapshotSystems.push(system)
        })
        this.simulationStatus.hide()
    }

    /**
     * Called after a compilation process was started
     */
    compilationStarted(): void {
        // this.update()
    }

    /**
     * Called after compilation finished.
     */
    compilationFinished(successful: boolean): void {
        if (this.compilingSimulation) {
            // If a simulation systems is currently compiling one has to simulate it afterwards
            this.compilingSimulation = false
            if (successful) {
                this.simulate(this.modelUri)
            } else {
                this.compiledText = undefined
                this.setStale(true)
                this.lastError =
                    'The model could not be compiled for simulation. See Problems or KIELER Compilation output.'
                this.setPhase('idle')
            }
        } else {
            // this.update()
        }
    }

    async handleAddCoSimulation(): Promise<void> {
        // TODO Uri of simulation file
        const executableUri = await vscode.window.showOpenDialog({
            title: 'Select CoSimulation executable',
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
        })
        if (executableUri) {
            const lClient = await this.lsClient
            lClient.sendNotification('keith/simulation/addCoSimulation', {
                clientId: 'keith-diagram_sprotty',
                fileUri: executableUri[0].path.toString(),
            })
        }
    }

    async newInputValue(simulationData: SimulationData): Promise<void> {
        const result = await vscode.window.showInputBox({
            value: JSON.stringify(this.valuesForNextStep.get(simulationData.id)),
            placeHolder: `Input value for ${simulationData.id}`,
            title: `New value for ${simulationData.id}`,
            validateInput: (text) => {
                try {
                    if (isCompatibleInput(JSON.parse(text), this.valuesForNextStep.get(simulationData.id))) return ''
                } catch {
                    return 'Enter a valid JSON value.'
                }
                return 'The value must match the input’s type and array dimensions.'
            },
        })
        if (result) {
            this.setInputValue(simulationData, JSON.parse(result))
        }
    }

    /**
     * Invoke simulation.
     * To be successful a compilation with a simulation compilation system has to be invoked before this function call.
     */
    async simulate(uri = this.kico.lastCompiledUri): Promise<void> {
        if (this.starting || this.simulationRunning || this.phase === 'stopping') return
        if (!uri) {
            this.fail('Compile a model with a simulation system first.')
            return
        }
        const { generation } = this
        this.starting = true
        this.modelUri = uri
        this.lastError = undefined
        this.startTime = Date.now()
        this.setPhase('starting')
        this.simulationStatus.text = '$(loading~spin) Starting simulation...'
        this.simulationStatus.show()
        this.startTimer = setTimeout(
            () => this.fail('Starting the simulation timed out. Restart the KIELER language server and try again.'),
            30000
        )
        try {
            await this.lsClient.start()
            if (generation !== this.generation) return
            await this.lsClient.sendNotification('keith/simulation/start', {
                uri,
                simulationType: this.settings.get('simulationType'),
            })
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation could not be started: ${error}`)
        }
    }

    /**
     * Start simulation after server successfully started it.
     */
    async handleSimulationStarted(startMessage: SimulationStartedMessage): Promise<void> {
        if (!this.starting || this.phase !== 'starting') return
        this.starting = false
        clearTimeout(this.startTimer)
        this.endTime = Date.now()
        if (!startMessage.successful) {
            this.fail(`The simulation could not be started: ${startMessage.error}`)
            return
        }
        if (
            !startMessage.dataPool ||
            typeof startMessage.dataPool !== 'object' ||
            Array.isArray(startMessage.dataPool) ||
            !startMessage.propertySet ||
            typeof startMessage.propertySet !== 'object' ||
            Array.isArray(startMessage.propertySet) ||
            Object.values(startMessage.propertySet).some(
                (symbols) => !Array.isArray(symbols) || symbols.some((symbol) => typeof symbol !== 'string')
            )
        ) {
            this.fail('The language server returned an invalid simulation configuration.')
            return
        }
        this.simulationData.clear()
        this.valuesForNextStep.clear()
        this.changedValuesForNextStep.clear()
        this.simulationStatus.show()

        // Get the start configuration for the simulation
        const pool = readDataPool(startMessage.dataPool)
        const propertySet: Map<string, string[]> = new Map(Object.entries(startMessage.propertySet))
        // Inputs and outputs are handled separately
        let inputs: string[] | undefined = propertySet.get('input')
        inputs = inputs === undefined ? [] : inputs
        let outputs: string[] | undefined = propertySet.get('output')
        outputs = outputs === undefined ? [] : outputs
        // Construct list of all categories
        this.categories = Array.from(propertySet.keys())
        pool.forEach(({ value, type }, key) => {
            // Add list of properties to SimulationData
            const categoriesList: string[] = []
            propertySet.forEach((list, propertyKey) => {
                if (list.includes(key)) {
                    categoriesList.push(propertyKey)
                }
            })
            const newData: SimulationData = {
                id: key,
                label: key,
                data: [],
                input: inputs?.includes(key) ?? false,
                output: outputs?.includes(key) ?? false,
                categories: categoriesList,
                type,
            }
            this.simulationData.set(key, newData)
            // Set the value for which will be set for the next step for inputs
            if (inputs?.includes(key)) {
                this.valuesForNextStep.set(key, inputValue(value, type))
                // Timed models never advance with Δt at 0, so start with the last Δt the user
                // chose in this workspace, or one time unit per tick.
                if (isTimeDelta(newData) && typeof value === 'number') {
                    const remembered = this.context.workspaceState.get<number>(DELTA_T_KEY)
                    const initial = typeof remembered === 'number' && remembered > 0 ? remembered : value || 1
                    if (initial !== value) {
                        this.valuesForNextStep.set(key, initial)
                        this.changedValuesForNextStep.set(key, initial)
                    }
                }
            }
        })
        this.controlsEnabled = true
        this.simulationRunning = true
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        this.simulationStep = 0
        this.phase = 'running'
        this.initializeTable()
        // Breakpoints and watches remembered for this model apply to the new run.
        if (this.modelUri) {
            this.debugger.attach(this.modelUri).catch((error) => {
                this.output.appendLine(`[WARN]\tBreakpoints could not be sent to the server: ${error}`)
            })
        }
        // The diagram preview carries the simulation controls, so bring it up next to the model being simulated.
        if (this.modelUri) {
            vscode.commands.executeCommand('keith-vscode.diagram.open', vscode.Uri.parse(this.modelUri), {
                preserveFocus: true,
            })
        }
    }

    /**
     * Shows the current tick in the view description and the status bar.
     */
    updateTickIndicators(): void {
        if (this.phase === 'running') {
            this.simulationStatus.text = `$(debug-step-over) Tick ${this.simulationStep}`
            this.simulationStatus.tooltip = 'Execute simulation step'
            this.simulationStatus.command = STEP_SIMULATION.command
        } else {
            this.simulationStatus.command = undefined
        }
    }

    /**
     * Executes a simulation step on the LS.
     */
    async executeSimulationStep(): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play) return
        const { generation } = this
        try {
            await this.stepper.step()
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation tick failed: ${error}`)
        }
    }

    /**
     * Request a simulation stop from the LS.
     */
    public async stopSimulation(timeoutMs = 30000): Promise<boolean> {
        if (this.stopRequest) return this.stopRequest
        if (!this.simulationRunning && !this.starting && !this.compilingSimulation) return false
        this.stepper.reset()
        this.play = false
        this.controlsEnabled = false
        this.starting = false
        this.compilingSimulation = false
        clearTimeout(this.startTimer)
        const generation = ++this.generation
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', false)
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', false)
        this.setPhase('stopping')
        this.simulationStatus.text = '$(loading~spin) Stopping simulation...'
        this.simulationStatus.show()
        const request = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
                const message = await Promise.race([
                    this.lsClient.sendRequest<SimulationStoppedMessage>('keith/simulation/stop'),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () =>
                                reject(
                                    new Error('Stopping the simulation timed out. Restart the KIELER language server.')
                                ),
                            timeoutMs
                        )
                    }),
                ])
                if (generation !== this.generation) return false
                if (!message.successful) throw new Error(message.message)
                this.setValuesToStopSimulation()
                this.simulationStatus.text = 'Stopped simulation'
                this.simulationStatus.tooltip = ''
                return true
            } catch (error) {
                if (generation === this.generation) this.fail(`The simulation could not be stopped: ${error}`)
                throw error
            } finally {
                clearTimeout(timer)
            }
        })()
        this.stopRequest = request
        try {
            return await request
        } finally {
            if (this.stopRequest === request) this.stopRequest = undefined
        }
    }

    private setValuesToStopSimulation(): void {
        this.generation++
        this.stepper.reset()
        this.debugger.detach()
        clearTimeout(this.startTimer)
        this.starting = false
        // Stop all simulation, i.e. empty maps and kill simulation process on LS
        this.valuesForNextStep.clear()
        this.changedValuesForNextStep.clear()
        this.simulationData.clear()
        this.simulationStep = -1
        // this.simulationTreeData = []
        this.play = false
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)
        this.controlsEnabled = false
        this.simulationRunning = false
        vscode.commands.executeCommand('setContext', 'keith.vscode:simulationRunning', this.simulationRunning)
        this.updateTickIndicators()
        this.setPhase('idle')
    }

    /**
     * Toggles play.
     * Begins to execute steps while waiting simulationWidget.simulationDelay between each step.
     */
    async startOrPauseSimulation(): Promise<void> {
        await this.setPlaying(!this.play)
    }

    async setPlaying(playing: boolean): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play === playing) return
        this.play = playing
        vscode.commands.executeCommand('setContext', 'keith.vscode:play', this.play)
        this.onDidChangeViewStateEmitter.fire()
        if (this.play) {
            await this.waitForNextStep()
        } else {
            this.stepper.pause()
        }
    }

    /**
     * Asks the user for a file to store the simulation trace from the current simulation in a file.
     */
    async saveTrace(): Promise<void> {
        // Ask the user where to save this trace
        const currentFolder = vscode.workspace.workspaceFolders
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined
        const uri = await vscode.window.showSaveDialog({
            filters: { KTrace: ['ktrace'] },
            title: 'Save current KTrace to...',
            defaultUri: currentFolder ? vscode.Uri.file(`${currentFolder}/trace.ktrace`) : undefined,
        })
        if (uri === undefined) {
            // The user did not pick any file to save to.
            return
        }

        // Request the LS to save the current trace into the file picked by the user.
        const lsClient = await this.lsClient
        const message = (await lsClient.sendRequest('keith/simulation/saveTrace', uri.path)) as SavedTraceMessage
        if (!message.successful) {
            const errorMessage = `could not save trace: ${message.reason}`
            this.output.appendLine(`[ERROR]\t${errorMessage}`)
            vscode.window.showErrorMessage(errorMessage)
        }
    }

    /**
     * Asks the user for a file to load simulation trace from and loads that onto the client and server.
     */
    async loadTrace(): Promise<void> {
        // Loading the trace file.
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { KTrace: ['ktrace'] },
        })
        if (uris === undefined) {
            // The user did not pick any file to load.
            return
        }
        await this.loadTraceFromUri(uris[0])
    }

    async loadTraceFromUri(uri: vscode.Uri): Promise<void> {
        // Send the trace file uri to the server to convert it into a Trace model and to load it.
        const lClient = await this.lsClient
        const message = (await lClient.sendRequest('keith/simulation/loadTrace', uri.path)) as LoadedTraceMessage
        if (message.successful) {
            this.debugger.traceLoaded = true
            this.onDidChangeViewStateEmitter.fire()
        }

        if (!message.successful) {
            const errorMessage = `could not load trace: ${message.reason}`
            this.output.appendLine(`[ERROR]\t${errorMessage}`)
            vscode.window.showErrorMessage(errorMessage)
            return
        }
        // Store the trace model here as well.
        this.currentTrace = message.trace
    }

    /**
     * Execute a simulation step with a delay.
     */
    async waitForNextStep(): Promise<void> {
        const { generation } = this
        try {
            await this.stepper.run(() => this.settings.get('simulationStepDelay'))
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation tick failed: ${error}`)
        }
    }

    /**
     * Is executed after the server finishes a step.
     * @param message data of step, includes new values.
     */
    handleStepMessage(message: SimulationStepMessage): boolean {
        if (!this.simulationRunning || this.phase !== 'running') return false
        if (message?.successful === false) {
            this.fail(`The simulation tick failed: ${message.error ?? 'Unknown server error'}`)
            return false
        }
        if (!message?.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
            this.fail('The language server returned invalid tick data.')
            return false
        }
        const unknown = Object.keys(message.values).find((key) => !this.simulationData.has(key))
        if (unknown) {
            this.fail(`Unexpected value for ${unknown} in simulation data. Restart the simulation.`)
            return false
        }
        const debug = message as DebugStepFields
        if (debug.rewound) {
            // The server replayed the run up to an earlier tick: drop the later ticks from every trace.
            const step = Math.max(0, debug.step ?? 0)
            this.simulationData.forEach((history, key) => {
                history.data.length = Math.min(history.data.length, step)
                const present = Object.prototype.hasOwnProperty.call(message.values, key)
                if (step > 0) history.data[step - 1] = present ? message.values[key] : history.data[step - 1]
                if (present && history.input) {
                    this.valuesForNextStep.set(key, inputValue(message.values[key], history.type))
                }
            })
            this.changedValuesForNextStep.clear()
            this.simulationStep = step
            this.debugger.onStep(debug)
            this.update()
            return true
        }
        this.simulationData.forEach((history, key) => {
            const present = Object.prototype.hasOwnProperty.call(message.values, key)
            const value = present ? message.values[key] : history.data[history.data.length - 1]
            history.data.push(value)
            if (present && history.input && !this.changedValuesForNextStep.has(key)) {
                this.valuesForNextStep.set(key, inputValue(value, history.type))
            }
        })
        this.simulationStep++
        this.stepper.acknowledge()
        if (this.debugger.onStep(debug) && this.play) {
            // A breakpoint fired: stop running ticks automatically, the user decides how to go on.
            this.setPlaying(false)
        }
        this.update()
        return true
    }

    /** The server reports a breakpoint separately as well, so a run loop stops even if the tick was missed. */
    handlePaused(hit: BreakpointPause): void {
        if (!this.simulationRunning || this.phase !== 'running') return
        this.debugger.onPaused(hit)
        if (this.play) this.setPlaying(false)
    }

    /** Rewinds to the state after `toStep`; the trace is trimmed when the server's rewound tick arrives. */
    async stepBack(toStep = this.simulationStep - 1): Promise<boolean> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play || toStep < 0) return false
        if (this.debugger.runningToBreakpoint) await this.debugger.pause()
        const { generation } = this
        try {
            const result = await this.debugger.stepBack(toStep)
            if (generation !== this.generation) return false
            if (!result.ok) {
                vscode.window.showWarningMessage(result.message ?? 'The simulation could not be rewound.')
                return false
            }
            return true
        } catch (error) {
            if (generation === this.generation) this.fail(`The simulation could not be rewound: ${error}`)
            return false
        }
    }

    /** Quick pick of the model's states (from the server), or a typed condition, becomes a breakpoint. */
    async addBreakpointInteractively(): Promise<void> {
        if (!this.simulationRunning || !this.modelUri) {
            vscode.window.showInformationMessage('Start a simulation first.')
            return
        }
        const { states } = this.debugger
        const condition = '$(debug-breakpoint-conditional) When a condition holds...'
        const items: vscode.QuickPickItem[] = [
            { label: condition, detail: 'Pause after any tick in which an expression over the variables is true' },
            ...states.map((state) => ({
                label: `$(debug-breakpoint) ${state.qualified}`,
                description: state.initial ? 'initial' : undefined,
                detail: `Pause when ${state.name} is entered`,
            })),
        ]
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pause the simulation when...' })
        if (!picked) return
        if (picked.label === condition) {
            const expression = await vscode.window.showInputBox({
                prompt: 'Condition, e.g. count >= 3 && !done',
                validateInput: (value) => (value.trim() ? null : 'Enter an expression.'),
            })
            if (expression) await this.debugger.addBreakpoint({ expression })
            return
        }
        await this.debugger.addBreakpoint({ state: picked.label.replace(/^\$\([^)]*\)\s*/, '') })
    }

    async addWatchInteractively(): Promise<void> {
        if (!this.simulationRunning || !this.modelUri) {
            vscode.window.showInformationMessage('Start a simulation first.')
            return
        }
        const expression = await vscode.window.showInputBox({
            prompt: 'Expression to watch, e.g. count * 10',
            validateInput: (value) => (value.trim() ? null : 'Enter an expression.'),
        })
        if (expression) await this.debugger.addWatch(expression)
    }

    /** Lets the server step until a breakpoint fires; every tick still arrives as a step message. */
    async runToBreakpoint(): Promise<void> {
        if (!this.simulationRunning || this.phase !== 'running' || this.play) return
        if (this.debugger.breakpoints.every((breakpoint) => !breakpoint.enabled || breakpoint.error)) {
            vscode.window.showInformationMessage('Add an enabled breakpoint first.')
            return
        }
        await this.debugger.runToBreakpoint()
    }

    handleExternalNewUserValue(values: unknown): void {
        if (!this.simulationRunning || !values || typeof values !== 'object' || Array.isArray(values)) return
        Object.entries(values).forEach(([id, value]) => {
            const entry = this.simulationData.get(id)
            value = inputValue(value, entry?.type)
            if (
                entry?.input &&
                !this.changedValuesForNextStep.has(id) &&
                isCompatibleInput(value, this.valuesForNextStep.get(id))
            ) {
                this.valuesForNextStep.set(id, value)
            }
        })
        this.update()
    }

    handleExternalStop(message: string): void {
        if (this.phase === 'idle' || this.phase === 'stopping') return
        this.output.appendLine(`[ERROR]\tStopped simulation because of an exception on the language server: ${message}`)
        this.fail('The simulation crashed on the language server.')
        vscode.window
            .showErrorMessage('The simulation crashed on the KIELER language server.', RESTART_LANGUAGE_SERVER.title)
            .then((choice) => {
                if (choice === RESTART_LANGUAGE_SERVER.title) {
                    vscode.commands.executeCommand(RESTART_LANGUAGE_SERVER.command)
                }
            })
    }

    getExtensionFileUri(...segments: string[]): vscode.Uri {
        return vscode.Uri.file(path.join(this.context.extensionPath, ...segments))
    }

    /**
     * Whether a data pool entry is shown in the table.
     */
    isVisible(entry: SimulationData): boolean {
        if (this.isBlacklisted(entry)) {
            return false
        }
        return !this.isInternal(entry) || this.settings.get('showInternalVariables.enabled')
    }

    isBlacklisted(entry: SimulationData): boolean {
        return SimulationDataBlackList.includes(entry.id)
    }

    /** Symbols the compiler generated rather than the model author. */
    isInternal(entry: SimulationData): boolean {
        if (isTimeRelated(entry)) {
            return false
        }
        return (
            isInternal(entry) ||
            entry.id.includes('_tickCounter') ||
            entry.id.startsWith('_') ||
            entry.id.startsWith('#')
        )
    }

    /** Rebuilds what the preview shows after the variable set or a display setting changed. */
    initializeTable() {
        this.update()
    }

    update(): void {
        this.updateTickIndicators()
        this.onDidChangeViewStateEmitter.fire()
    }
}

export class SimulationData {
    constructor(
        public label: string,
        public id: string,
        public data: unknown[],
        public input: boolean,
        public output: boolean,
        public categories: string[],
        public type?: string
    ) {}
}

/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2021-2024 by
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

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { Utils } from 'vscode-uri'
import { CompilerDiagnostics } from './compiler-diagnostics'
import {
    CompileProgress,
    ProcessorInfo,
    ProcessorTiming,
    finishedSummary,
    formatDuration,
    progressText,
    progressTooltip,
    slowestProcessor,
    stageTiming,
} from './compile-progress'
import { CompilerIssue } from './diagnostic-protocol'
import { groupSystemsForQuickPick, pickedSystem, SystemQuickPickItem } from './workspace-systems'
import { GeneratedCodeDocuments, GeneratedFile } from './generated-code-documents'
import { Settings } from '../constants'
import { SettingsService } from '../settings'
import {
    COMPILE_COMMAND,
    COMPILE_SNAPSHOT_COMMAND,
    REQUEST_CS,
    SHOW_MODEL,
    SHOW_NEXT,
    SHOW_PREVIOUS,
    SHOW_STAGE,
    TOGGLE_AUTO_COMPILE,
    TOGGLE_INPLACE,
    TOGGLE_PRIVATE_SYSTEMS,
    TOGGLE_SHOW_RESULTING_MODEL,
} from './commands'

export const compilerWidgetId = 'compiler-widget'
export const COMPILE = 'keith/kicool/compile'
export const CANCEL_COMPILATION = 'keith/kicool/cancel-compilation'
export const SHOW = 'keith/kicool/show'
export const GET_SYSTEMS = 'keith/kicool/get-systems'

export const OPEN_COMPILER_WIDGET_KEYBINDING = 'ctrlcmd+alt+c'
export const SHOW_PREVIOUS_KEYBINDING = 'alt+g'
export const SHOW_NEXT_KEYBINDING = 'alt+j'

export const EDITOR_UNDEFINED_MESSAGE = 'Editor is undefined'
export const snapshotDescriptionMessageType = 'keith/kicool/didCompile'
export const compileProgressMessageType = 'keith/kicool/progress'
export const cancelCompilationMessageType = 'keith/kicool/cancel-compilation'
export const compilationSystemsMessageType = 'keith/kicool/compilation-systems'

export const diagramType = 'keith-diagram'

/** A compiler stage other than the source model that the diagram preview currently shows. */
export interface ShownStage {
    name: string
    index: number
    count: number
}

export class CompilationDataProvider {
    readonly diagnostics = new CompilerDiagnostics()

    /** Set by the extension: resolves once the diagram view received the model a show request produced. */
    awaitDiagram: (() => Promise<void>) | undefined

    private showQueue: Promise<void> = Promise.resolve()

    /** Index of the stage the diagram shows per model URI; -1 or absent is the source model. */
    private readonly shownStage = new Map<string, number>()

    private readonly stageChangedEmitter = new vscode.EventEmitter<void>()

    /** Fires when the diagram switches between the source model and a compiler stage. */
    readonly onDidChangeStage: vscode.Event<void> = this.stageChangedEmitter.event

    /** Compiles started by the Compile command still owe the user the resulting model or code. */
    private readonly pendingResults = new Map<string, boolean>()

    private preparingCompilation = false

    private generation = 0

    private completionNotified = false

    editor: vscode.TextEditor | undefined = undefined

    requestedSystems = false

    systems: CompilationSystem[] = []

    snapshotSystems: CompilationSystem[] = []

    quickpickSystems: vscode.QuickPickItem[] = []

    startTime = 0

    endTime = 0

    compiling = false

    generatingCode = false

    preparingSimulation = false

    lastInvokedCompilation = ''

    lastCompiledUri = ''

    sourceModelPath = '' // Set when editor is changed to current uri

    requestSystems: vscode.StatusBarItem

    compilation: vscode.StatusBarItem

    output: vscode.OutputChannel

    /**
     * The file extension of the last file for which compilation systems where requested.
     */
    public lastRequestedUriExtension = ''

    /**
     * Indicates that a compilation is currently being cancelled
     */
    public cancellingCompilation = false

    /**
     * Snapshots that are currently shown in the view, created during compilation.
     */
    snapshots: CompilationResults | undefined = undefined

    isCompiled: Map<string, boolean> = new Map()

    sourceURI: Map<string, string> = new Map()

    resultMap: Map<string, CompilationResults> = new Map()

    indexMap: Map<string, number> = new Map()

    lengthMap: Map<string, number> = new Map()

    public readonly compilationStartedEmitter = new vscode.EventEmitter<this | undefined>()

    /**
     * Finish of compilation is recognized by cancel of compilation or by receiving a snapshot that is the last of the compilation system.
     * Returns whether compilation has successfully finished (the last snapshot was send).
     */
    public readonly compilationFinishedEmitter = new vscode.EventEmitter<boolean | undefined>()

    public readonly showedNewSnapshotEmitter = new vscode.EventEmitter<string | undefined>()

    public readonly newSimulationCommandsEmitter = new vscode.EventEmitter<CompilationSystemsMessage>()

    public readonly compilationStarted: vscode.Event<this | undefined> = this.compilationStartedEmitter.event

    /**
     * Finish of compilation is recognized by cancel of compilation or by receiving a snapshot that is the last of the compilation system.
     * Returns whether compilation has successfully finished (the last snapshot was send).
     */
    public readonly compilationFinished: vscode.Event<boolean | undefined> = this.compilationFinishedEmitter.event

    public readonly showedNewSnapshot: vscode.Event<string | undefined> = this.showedNewSnapshotEmitter.event

    public readonly newSimulationCommands: vscode.Event<CompilationSystemsMessage> =
        this.newSimulationCommandsEmitter.event

    constructor(
        private lsClient: LanguageClient,
        readonly context: vscode.ExtensionContext,
        private readonly settings: SettingsService<Settings>,
        /** Generated C and Java open as read-only editor tabs instead of a diagram. */
        readonly documents: GeneratedCodeDocuments = new GeneratedCodeDocuments()
    ) {
        // Output channel
        this.output = vscode.window.createOutputChannel('KIELER Compilation')
        this.context.subscriptions.push(
            this.diagnostics,
            this.output,
            this.stageChangedEmitter,
            this.compilationStartedEmitter,
            this.compilationFinishedEmitter,
            this.showedNewSnapshotEmitter,
            this.newSimulationCommandsEmitter
        )

        // Status bar item for compilation
        this.requestSystems = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
        this.requestSystems.command = REQUEST_CS.command
        this.context.subscriptions.push(this.requestSystems)
        this.compilation = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
        this.compilation.command = SHOW_STAGE.command
        this.context.subscriptions.push(this.compilation)

        // Bind notifications to receive
        this.context.subscriptions.push(
            lsClient.onNotification(cancelCompilationMessageType, (success: boolean) =>
                this.cancelCompilation(success)
            ),
            lsClient.onNotification(
                compilationSystemsMessageType,
                (param: { systems: CompilationSystem[]; snapshotSystems: CompilationSystem[] }) => {
                    this.handleReceiveSystemDescriptions(param.systems, param.snapshotSystems)
                }
            ),
            lsClient.onNotification(compileProgressMessageType, (params: CompileProgress) =>
                this.handleProgress(params)
            ),
            lsClient.onNotification(
                snapshotDescriptionMessageType,
                (params: {
                    results: CompilationResults
                    uri: string
                    finished: boolean
                    currentIndex: number
                    maxIndex: number
                    currentProcessor?: ProcessorInfo
                }) => {
                    // The server spells the URI its own way (drive letters and encoding differ on
                    // Windows); every lookup here uses VS Code's spelling.
                    this.handleNewSnapshotDescriptions(
                        params.results,
                        vscode.Uri.parse(params.uri).toString(),
                        params.finished,
                        params.currentIndex,
                        params.maxIndex,
                        params.currentProcessor
                    ).catch((error) =>
                        this.output.appendLine(`[ERROR]\tCould not handle compilation results: ${error}`)
                    )
                }
            )
        )
        // Bind to change active editor event
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(async (editor) => {
                await this.onDidChangeActiveTextEditor(editor).catch((error) => this.output.appendLine(String(error)))
            })
        )

        // Bind event executed after a new snapshot is shown.
        this.context.subscriptions.push(
            this.showedNewSnapshot(() => {
                this.requestSystemDescriptions().catch((error) => this.output.appendLine(String(error)))
            })
        )

        this.context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(this.onDidSaveTextDocument.bind(this)))
        // Request compilation systems at the start, since onDidChangeActiveTextEditor does not fire at the beginning
        const editor = vscode.window.activeTextEditor
        if (editor) {
            this.onDidChangeActiveTextEditor(editor).catch((error) => this.output.appendLine(String(error)))
        }

        // TODO lme: maybe re-order commands to fit order in commands.ts
        // Create commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand(TOGGLE_AUTO_COMPILE.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('autocompile.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('autocompile.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('autocompile.enabled', selection[0]?.label === 'true')
                    }
                    quickPick.hide()
                })

                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.registerShowNext()

        this.registerShowPrevious()

        this.context.subscriptions.push(
            vscode.commands.registerCommand(REQUEST_CS.command, async () => {
                vscode.commands.executeCommand('setContext', 'keith.vscode:compilationReady', false)
                await this.requestSystemDescriptions()
                vscode.window.showInformationMessage('Registered compilation system')
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(TOGGLE_INPLACE.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('compileInplace.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('compileInplace.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('compileInplace.enabled', selection[0]?.label === 'true')
                    }
                    quickPick.hide()
                })

                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(TOGGLE_SHOW_RESULTING_MODEL.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('showResultingModel.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('showResultingModel.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('showResultingModel.enabled', selection[0]?.label === 'true')
                    }
                    quickPick.hide()
                })

                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(TOGGLE_PRIVATE_SYSTEMS.command, () => {
                const options: vscode.QuickPickItem[] = [
                    {
                        label: 'true',
                        picked: this.settings.get('showPrivateSystems.enabled'),
                    },
                    {
                        label: 'false',
                        picked: !this.settings.get('showPrivateSystems.enabled'),
                    },
                ]
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    if (selection[0]) {
                        this.settings.set('showPrivateSystems.enabled', selection[0]?.label === 'true')
                    }
                    quickPick.hide()
                })

                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_STAGE.command, (uri?: vscode.Uri) => this.pickStage(uri)),
            vscode.commands.registerCommand(SHOW_MODEL.command, (uri?: vscode.Uri) => this.showModel(uri))
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_COMMAND.command, async () => {
                const options = this.createQuickPick(
                    this.systems.filter((system) => system.isPublic || this.settings.get('showPrivateSystems.enabled'))
                )
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    const system = pickedSystem(this.systems, selection[0] as SystemQuickPickItem)
                    if (system) this.compileAndPresent(system.id, system.snapshotSystem)
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )

        this.context.subscriptions.push(
            vscode.commands.registerCommand(COMPILE_SNAPSHOT_COMMAND.command, async () => {
                const options = this.createQuickPick(this.snapshotSystems)
                const quickPick = vscode.window.createQuickPick()
                quickPick.items = options
                quickPick.onDidChangeSelection((selection) => {
                    const system = pickedSystem(this.snapshotSystems, selection[0] as SystemQuickPickItem)
                    if (system) this.compileAndPresent(system.id, system.snapshotSystem)
                    quickPick.hide()
                })
                quickPick.onDidHide(() => quickPick.dispose())
                quickPick.show()
            })
        )
    }

    /** Workspace systems (from .kico files) come first under their own heading, then the built-in ones. */
    createQuickPick(systems: CompilationSystem[]): vscode.QuickPickItem[] {
        return groupSystemsForQuickPick(systems)
    }

    /**
     * Compiles for the user and presents the result: generated C or Java opens as editor tabs, any
     * other final model is shown in the diagram (when the setting asks for it). The server is never
     * asked to show the result itself, so a code container no longer replaces the model diagram.
     */
    async compileAndPresent(systemId: string, snapshot: boolean, source = this.editor?.document.uri): Promise<void> {
        const uri = source?.toString()
        if (!uri) {
            vscode.window.showErrorMessage('Open a model to compile it.')
            return
        }
        if (this.preparingCompilation || this.compiling || this.generatingCode || this.preparingSimulation) {
            vscode.window.showInformationMessage('A compilation is already in progress.')
            return
        }
        this.preparingCompilation = true
        const { generation } = this
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
            if (document.isDirty && !(await document.save())) throw new Error('Save the model before compiling it.')
            if (generation !== this.generation) return
            if (document.isDirty) throw new Error('The model changed while saving. Save it and compile again.')
            this.pendingResults.set(uri, this.settings.get('showResultingModel.enabled'))
            await this.compile(systemId, this.settings.get('compileInplace.enabled'), false, snapshot, uri)
        } catch (error) {
            this.pendingResults.delete(uri)
            vscode.window.showErrorMessage(`Could not compile: ${error instanceof Error ? error.message : error}`)
        } finally {
            this.preparingCompilation = false
        }
    }

    /**
     * Presents a finished compilation. The diagram either shows the new final stage or, when the
     * result is code or nothing was asked for, returns to the source model: the stages it showed
     * before belonged to the previous compilation, and a diagram nobody can leave was the old bug.
     */
    private async presentResult(uri: string, results: CompilationResults, errorOccurred: boolean): Promise<void> {
        const showModel = this.pendingResults.get(uri)
        this.pendingResults.delete(uri)
        const wasShowingStage = (this.shownStage.get(uri) ?? -1) !== -1
        const files = results.generatedFiles
        if (showModel !== undefined && !errorOccurred && files?.length) {
            const target = files.some((file) => file.fileName.endsWith('.java')) ? 'java' : 'c'
            try {
                await this.documents.open(vscode.Uri.parse(uri), target, files)
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open the generated code: ${String(error)}`)
            }
        } else if (showModel && !errorOccurred && (this.lengthMap.get(uri) ?? 0) > 0) {
            await this.show(uri, (this.lengthMap.get(uri) ?? 1) - 1).catch((error) =>
                vscode.window.showErrorMessage(String(error))
            )
            return
        }
        if (wasShowingStage) await this.show(uri, -1).catch(() => this.setShownStage(uri, -1))
    }

    /** The stage the diagram shows for a model, or undefined for the source model. */
    currentStage(uri: string | undefined): ShownStage | undefined {
        if (!uri) return undefined
        const index = this.shownStage.get(uri)
        const results = this.resultMap.get(uri)
        if (index === undefined || index < 0 || !results) return undefined
        const stages = results.files.flat()
        const stage = stages[index]
        return stage && stage.processorId !== 'source-validation'
            ? { name: stage.name, index, count: stages.length }
            : undefined
    }

    private setShownStage(uri: string, index: number): void {
        const previous = this.shownStage.get(uri) ?? -1
        this.shownStage.set(uri, index)
        if (previous !== index) this.stageChangedEmitter.fire()
    }

    /** Called when the diagram is rebuilt from the source, which forgets any shown stage. */
    diagramReset(uri: string | undefined): void {
        if (uri && (this.shownStage.get(uri) ?? -1) !== -1) this.setShownStage(uri, -1)
    }

    /** Brings the diagram back to the source model after a stage was shown. */
    async showModel(uri?: vscode.Uri | string): Promise<void> {
        const key = this.targetUri(uri)
        if (!key) return
        if ((this.shownStage.get(key) ?? -1) === -1) return
        await this.show(key, -1)
    }

    /** Lets the user pick a stage of the last compilation of a model; this replaced the compiler tree view. */
    async pickStage(uri?: vscode.Uri | string): Promise<void> {
        const key = this.targetUri(uri)
        const results = key ? this.resultMap.get(key) : undefined
        if (!key || !results || !results.files.length) {
            const choice = await vscode.window.showInformationMessage('Compile the model first.', 'Compile...')
            if (choice) await vscode.commands.executeCommand(COMPILE_COMMAND.command)
            return
        }
        const shown = this.shownStage.get(key) ?? -1
        const slowest = slowestProcessor(results.processors)
        const items: (vscode.QuickPickItem & { index: number })[] = [
            {
                label: `$(symbol-class) ${Utils.basename(vscode.Uri.parse(key))}`,
                description: shown === -1 ? 'shown' : 'source model',
                index: -1,
            },
        ]
        let index = 0
        results.files.forEach((group) => {
            const groupName = group.length > 1 ? group[0].name : undefined
            group.forEach((stage) => {
                if (stage.processorId === 'source-validation') {
                    index++
                    return
                }
                const problems = stage.errors?.length
                    ? '$(error) '
                    : stage.warnings?.length
                      ? '$(warning) '
                      : stage.infos?.length
                        ? '$(info) '
                        : ''
                const timing = stageTiming(stage, slowest)
                items.push({
                    label: `${problems}${groupName && stage.name !== groupName ? `${groupName} › ` : ''}${stage.name}`,
                    description: `${index + 1}/${results.files.flat().length}${timing ? ` · ${timing}` : ''}${
                        index === shown ? ' · shown' : ''
                    }`,
                    detail: stage.errors?.[0] ?? stage.warnings?.[0],
                    index,
                })
                index++
            })
        })
        const total = results.totalMs !== undefined ? formatDuration(results.totalMs) : ''
        const choice = await vscode.window.showQuickPick(items, {
            title: `Show Compilation Stage${total ? ` · compiled in ${total}` : ''}${
                slowest ? `, slowest ${slowest.name} ${formatDuration(slowest.durationMs)}` : ''
            }`,
            placeHolder: 'Choose what the diagram preview shows',
            matchOnDescription: true,
        })
        if (choice) await this.show(key, choice.index).catch((error) => vscode.window.showErrorMessage(String(error)))
    }

    private targetUri(uri?: vscode.Uri | string): string | undefined {
        if (uri) return typeof uri === 'string' ? uri : uri.toString()
        return this.editor?.document.uri.toString() ?? this.lastCompiledUri
    }

    /**
     * Message of the server to notify the client what compilation systems are available
     * to compile the original model and the currently opened snapshot.
     * @param systems compilation systems for original model
     * @param snapshotSystems compilation systems for currently opened snapshot
     */
    handleReceiveSystemDescriptions(systems: CompilationSystem[], snapshotSystems: CompilationSystem[]): void {
        // Remove status bar element after successfully requesting systems
        this.requestSystems.hide()

        // Compilation and simulation menu items
        vscode.commands.executeCommand('setContext', 'keith.vscode:compilationReady', true)

        // Sort all compilation systems by id
        systems.sort((a, b) => (a.id > b.id ? 1 : -1))
        this.systems = systems
        this.snapshotSystems = snapshotSystems
        if (this.editor) {
            this.sourceModelPath = this.editor.document.uri.toString()
            this.lastRequestedUriExtension = Utils.extname(this.editor.document.uri)
        }
        this.requestedSystems = false

        const simulationSystems = systems.filter((system) => system.simulation)
        const simulationSnapshotSystems = snapshotSystems.filter((system) => system.simulation)
        // Register additional simulation commands
        this.newSimulationCommandsEmitter.fire(
            new CompilationSystemsMessage(simulationSystems, simulationSnapshotSystems)
        )
    }

    async onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        if (editor && editor.document.uri.scheme === 'file' && ['sctx', 'scl'].includes(editor.document.languageId)) {
            this.editor = editor
            this.sourceModelPath = editor.document.uri.toString()
            await this.requestSystemDescriptions()
        }
    }

    onDidSaveTextDocument(document: vscode.TextDocument): void {
        // don't autocompile, if autocompile is off, document is not saved or it is not the last compiled file
        if (
            this.generatingCode ||
            this.preparingCompilation ||
            this.preparingSimulation ||
            this.compiling ||
            !this.settings.get('autocompile.enabled') ||
            document.isDirty ||
            document.uri.toString() !== this.lastCompiledUri
        )
            return
        this.compileAndPresent(this.lastInvokedCompilation, false, document.uri)
    }

    async requestSystemDescriptions(): Promise<void> {
        if (this.editor) {
            // when systems are requested request systems status bar entry is updated
            this.requestSystems.text = '$(spinner) Request compilation systems'
            this.requestSystems.tooltip = 'Requesting compilation systems...'
            this.requestSystems.show()
            this.requestedSystems = true
            const uri = this.editor.document.uri.toString()
            // Check if language client was already initialized and wait till it is
            try {
                await this.lsClient.start()
                await this.lsClient.sendNotification(GET_SYSTEMS, uri)
            } catch (error) {
                this.requestedSystems = false
                this.requestSystems.hide()
                throw error
            }
        } else {
            this.systems = []
        }
    }

    /**
     *
     * @param id id of snapshot e.g. Signal
     * @param index index of snapshot
     */
    public show(uri: string, index: number): Promise<void> {
        const run = async () => {
            if (index >= 0 && this.resultMap.get(uri)?.files.flat()[index]?.processorId === 'source-validation') {
                throw new Error(
                    'Source validation failed before any compilation stage was created. Fix the model and compile again.'
                )
            }
            await this.lsClient.start()
            const delivered = this.awaitDiagram?.()
            delivered?.catch(() => undefined)
            const result = await this.lsClient.sendRequest(SHOW, { uri, clientId: `${diagramType}_sprotty`, index })
            if (result === 'ERR') throw new Error('The compiler diagram could not be opened.')
            this.indexMap.set(uri, index)
            this.setShownStage(uri, index)
            // Original model must not fire this emitter.
            if (index !== -1) this.showedNewSnapshotEmitter.fire('Success')
            await delivered
        }
        // The server keeps generating after it acknowledges a show; overlapping requests would race.
        const next = this.showQueue.then(run, run)
        this.showQueue = next.catch(() => undefined)
        return next
    }

    /**
     * Invoke compilation and update status in widget
     * @param command compilation system
     * @param inplace whether inplace compilation is on or off
     * @param showResultingModel whether the resulting model should be shown in the diagram. Simulation does not do this.
     */
    public async compile(
        command: string,
        inplace: boolean,
        showResultingModel: boolean,
        snapshot: boolean,
        uri = this.editor?.document.uri.toString()
    ): Promise<void> {
        if (!uri) throw new Error(EDITOR_UNDEFINED_MESSAGE)
        if (!command) throw new Error('Choose a compilation system first.')
        if (this.compiling) throw new Error('A compilation is already in progress.')
        const generation = ++this.generation
        this.completionNotified = false
        this.startTime = Date.now()
        this.compiling = true
        this.cancellingCompilation = false
        this.compilation.text = '$(spinner) Preparing compilation'
        this.compilation.tooltip = 'Preparing compilation...'
        this.compilation.show()
        this.lastInvokedCompilation = command
        this.lastCompiledUri = uri
        try {
            await this.diagnostics?.begin(uri)
            if (generation !== this.generation) throw new Error('The language server restarted. Compile again.')
            await this.executeCompile(command, inplace, showResultingModel, snapshot, uri, generation)
        } catch (error) {
            if (generation !== this.generation) throw error
            this.compiling = false
            this.compilation.text = '$(error) Compilation failed'
            this.compilation.tooltip = error instanceof Error ? error.message : String(error)
            this.diagnostics?.finish(uri, [[{ name: 'Language server', index: 0, errors: [String(error)] }]], false)
            this.finishCompilation(false)
            throw error
        }
    }

    async executeCompile(
        command: string,
        inplace: boolean,
        showResultingModel: boolean,
        snapshot: boolean,
        uri = this.sourceModelPath,
        generation = this.generation
    ): Promise<void> {
        // The status bar item shows the compilation's progress; no popup is needed.
        await this.lsClient.start()
        if (generation !== this.generation) throw new Error('The language server restarted. Compile again.')
        await this.lsClient.sendNotification(COMPILE, {
            uri,
            clientId: `${diagramType}_sprotty`,
            command,
            inplace,
            showResultingModel,
            snapshot,
        })
        this.compilationStartedEmitter.fire(this)
    }

    /**
     * Handles the visualization of new snapshot descriptions send by the LS.
     */
    async handleNewSnapshotDescriptions(
        results: CompilationResults | null,
        uri: string,
        finished: boolean,
        currentIndex: number,
        maxIndex: number,
        currentProcessor?: ProcessorInfo
    ): Promise<void> {
        uri = vscode.Uri.parse(uri).toString()
        if (!this.compiling && this.completionNotified) return
        if (this.lastCompiledUri && uri !== this.lastCompiledUri && this.compiling) return
        results ??= {
            files: [
                [
                    new SnapshotDescription('Source model', '', undefined, 'Source model', 0, 0, [
                        'The model could not be loaded. Check the source errors in Problems.',
                    ]),
                ],
            ],
        }
        this.isCompiled.set(uri as string, true)
        this.resultMap.set(uri as string, results)
        this.snapshots = results
        const length = results.files.reduce((previousSum, snapshots) => previousSum + snapshots.length, 0)
        this.lengthMap.set(uri as string, length)
        this.indexMap.set(uri as string, length - 1)
        if (finished) {
            const report = this.diagnostics?.finish(uri, results.files, this.cancellingCompilation)
            let index = 0
            let errorOccurred = false
            this.compiling = false
            let errorString = ''
            results.files.forEach((array) => {
                array.forEach((e) => {
                    const element = e
                    if (element.infos && element.infos.length > 0) {
                        this.output.appendLine(`[INFO]\t${element.infos.reduce((x, y) => `${x}\n\t\t${y}`)}`)
                    }
                    if (element.warnings && element.warnings.length > 0) {
                        this.output.appendLine(`[WARN]\t${element.warnings.reduce((x, y) => `${x}\n\t\t${y}`)}`)
                    }
                    if (element.errors && element.errors.length > 0) {
                        errorString = element.errors.reduce((x, y) => `${x}\n\t\t${y}`)
                        errorOccurred = true
                        this.output.appendLine(`[ERROR]\t${errorString}`)
                    }
                    element.index = index
                    index++
                })
            })
            this.endTime = Date.now()
            const cancelled = this.cancellingCompilation || report?.status === 'cancelled' || currentIndex < maxIndex
            const success = !errorOccurred && !cancelled && report?.status !== 'stale' && report?.status !== 'failed'
            // The server's wall time covers exactly the processors; the client's own clock is the fallback.
            const summary = finishedSummary({
                success,
                cancelled: cancelled && !errorOccurred,
                totalMs: results.totalMs ?? this.endTime - this.startTime,
                processors: results.processors,
                processorCount: results.processorCount,
            })
            this.compilation.text = summary.text
            this.compilation.tooltip = summary.tooltip
            if (errorOccurred && report?.status !== 'stale' && !this.generatingCode) {
                const first = report?.issues.find((issue) => issue.severity === 'error')
                vscode.window
                    .showErrorMessage(
                        first ? `${first.stage}: ${first.message}` : 'Compilation failed.',
                        'Problems',
                        'Compiler output'
                    )
                    .then((choice) => {
                        if (choice === 'Problems') vscode.commands.executeCommand('workbench.actions.view.problems')
                        if (choice === 'Compiler output') this.output.show()
                    })
            }
            const presentation = this.presentResult(uri, results, !success)
            this.finishCompilation(success)
            await presentation
        } else {
            // A snapshot names the processor that produced it; the next progress notification replaces this.
            this.compilation.show()
            this.compilation.text = currentProcessor
                ? progressText({ processor: currentProcessor, index: currentIndex, maxIndex })
                : `$(spinner) Compiling (${Math.min(currentIndex, maxIndex)}/${maxIndex})`
            this.compilation.tooltip = 'Compiling...'
        }
    }

    /** The server announces every processor as it starts; the status bar shows which one is running. */
    handleProgress(progress: CompileProgress): void {
        if (!this.compiling) return
        if (this.lastCompiledUri && vscode.Uri.parse(progress.uri).toString() !== this.lastCompiledUri) return
        this.compilation.show()
        this.compilation.text = progressText(progress)
        this.compilation.tooltip = progressTooltip(progress)
    }

    /**
     * Notifies the LS to cancel the compilation.
     */
    public async requestCancelCompilation(): Promise<void> {
        const { generation } = this
        await this.lsClient.start()
        if (!this.compiling || generation !== this.generation) return
        this.cancellingCompilation = true
        try {
            await this.lsClient.sendNotification(CANCEL_COMPILATION)
        } catch (error) {
            this.cancellingCompilation = false
            throw error
        }
    }

    /**
     * Notification from LS that the compilation was cancelled.
     * @param success wether cancelling the compilation was successful
     */
    public async cancelCompilation(success: boolean): Promise<void> {
        if (!this.cancellingCompilation) return
        this.cancellingCompilation = false
        if (success) {
            this.compiling = false
            this.diagnostics?.cancel(this.lastCompiledUri)
            this.pendingResults.delete(this.lastCompiledUri)
            this.finishCompilation(false)
        }
    }

    private finishCompilation(success: boolean): void {
        if (this.completionNotified) return
        this.completionNotified = true
        this.compilationFinishedEmitter.fire(success)
    }

    /** Compiler snapshots belong to the server process that created them. */
    resetForRestart(): void {
        this.generation++
        this.compiling = false
        this.cancellingCompilation = false
        this.lastCompiledUri = ''
        this.snapshots = undefined
        this.requestedSystems = false
        this.systems = []
        this.snapshotSystems = []
        this.pendingResults.clear()
        this.isCompiled.clear()
        this.sourceURI.clear()
        this.resultMap.clear()
        this.indexMap.clear()
        this.lengthMap.clear()
        this.shownStage.clear()
        this.diagnostics?.reset()
        this.requestSystems.hide()
        this.compilation.hide()
        this.finishCompilation(false)
        this.stageChangedEmitter.fire()
    }

    registerShowNext(): void {
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_NEXT.command, () => {
                if (!this.editor) {
                    return false
                }
                const uri = this.sourceModelPath
                if (!this.isCompiled.get(uri)) {
                    return false
                }
                const lastIndex = this.indexMap.get(uri)
                if (lastIndex !== 0 && !lastIndex) {
                    return false
                }
                const length = this.lengthMap.get(uri)
                if (length !== 0 && !length) {
                    return false
                }
                if (lastIndex === length - 1) {
                    // No show necessary, since the last snapshot is already drawn.
                    return false
                }
                return this.show(uri, Math.min(lastIndex + 1, length - 1))
            })
        )
    }

    registerShowPrevious(): void {
        this.context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_PREVIOUS.command, () => {
                if (!this.editor) {
                    return false
                }
                const uri = this.sourceModelPath
                if (!this.isCompiled.get(uri)) {
                    return false
                }
                const lastIndex = this.indexMap.get(uri)
                if (lastIndex !== 0 && !lastIndex) {
                    return false
                }
                if (lastIndex === -1) {
                    // No show necessary, since the original model is already drawn.
                    return true
                }
                // Show for original model is on the lower bound of -1.
                return this.show(uri, Math.max(lastIndex - 1, -1))
            })
        )
    }
}

/** One compiler stage as sent by the language server, once a tree item and now plain data. */
export class SnapshotDescription {
    diagnostics?: CompilerIssue[]

    constructor(
        public label: string,
        public version: string,
        _collapsibleState: unknown,
        name: string,
        snapshotIndex: number,
        index: number,
        errors?: string[],
        warnings?: string[],
        infos?: string[]
    ) {
        this.name = name
        this.snapshotIndex = snapshotIndex
        this.index = index
        if (errors) {
            this.errors = errors
        }
        if (warnings) {
            this.warnings = warnings
        }
        if (infos) {
            this.infos = infos
        }
    }

    name: string

    snapshotIndex: number

    index: number

    errors?: string[]

    warnings?: string[]

    infos?: string[]

    /** Id of the processor that produced the snapshot. */
    processorId?: string

    /** Wall time of the processor stage in milliseconds; only on the snapshot a processor finished with. */
    durationMs?: number

    startedAtMs?: number

    status?: 'ok' | 'warning' | 'error' | 'skipped' | 'cancelled'
}

export class CompilationSystem {
    constructor(label: string, id: string, isPublic: boolean, simulation: boolean, snapshotSystem: boolean) {
        this.label = label
        this.id = id
        this.isPublic = isPublic
        this.simulation = simulation
        this.snapshotSystem = snapshotSystem
    }

    label: string

    id: string

    isPublic: boolean

    simulation: boolean

    snapshotSystem: boolean

    /** File URI of the .kico this system was loaded from; absent for built-in systems. */
    source?: string
}

export class CompilationSystemsMessage {
    constructor(systems: CompilationSystem[], snapshotSystems: CompilationSystem[]) {
        this.systems = systems
        this.snapshotSystems = snapshotSystems
    }

    systems: CompilationSystem[]

    snapshotSystems: CompilationSystem[]
}

/**
 * Equivalent to CompilationResults sent by LS
 */
export interface CompilationResults {
    files: SnapshotDescription[][]
    generatedFiles?: GeneratedFile[]
    generationError?: string
    /** Wall time of the whole compilation; only once it finished. */
    totalMs?: number
    processorCount?: number
    /** Every processor of the system in execution order, including the ones that never ran. */
    processors?: ProcessorTiming[]
}

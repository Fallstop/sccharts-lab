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

import 'reflect-metadata'
import {
    ChangeColorThemeAction,
    ClientColorPreferencesAction,
    ColorThemeKind,
    DebugOptions,
    SetRenderOptionAction,
} from '@kieler/klighd-core'
import { Action, ActionMessage } from 'sprotty-protocol'
import { registerLspEditCommands } from 'sprotty-vscode'
import * as vscode from 'vscode'
import { LanguageClient, State } from 'vscode-languageclient/node'
import { NotificationType } from 'vscode-messenger-common'
import { registerCommands, registerTextEditorSync } from './commandContributions'
import { command, diagramClientId, diagramType } from './constants'
import { KlighdWebviewReopener } from './klighd-webview-reopener'
import { LspHandler } from './lsp-handler'
import { diagramDrawnNotification } from '../simulation/protocol'
import { ReportChangeMessage } from './storage/messages'
import { StorageService } from './storage/storage-service'
import { ActionHandlerCallback, KLighDWebviewPanelManager } from './webview-panel-manager'

/**
 * Owns the KLighD diagram integration for the lifetime of the extension.
 *
 * The upstream klighd-vscode extension rebuilt its panel manager and re-registered its commands
 * every time the language client reached the Running state, which throws on the second time and
 * so broke every server restart. Here everything is created once; later Running states only
 * bring the open diagram back on the fresh server.
 */
export class DiagramController {
    private manager: KLighDWebviewPanelManager | undefined

    private readonly actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[] = []

    private readonly storageService: StorageService

    private readonly disposables: vscode.Disposable[] = []

    private readonly notificationHandlers = new Set<() => void>()

    private readonly diagramChanged = new vscode.EventEmitter<void>()

    readonly onDidChangeDiagram = this.diagramChanged.event

    private readonly modelDrawn = new vscode.EventEmitter<void>()

    /** The preview missed a draw; Run does not wait for it until it draws again. */
    private notDrawing = false

    private hasRun = false

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: LanguageClient,
        private readonly fileEndings: string[]
    ) {
        // Persist diagram options per workspace, as klighd-vscode did.
        this.storageService = new StorageService(context.workspaceState, client)
        setColorTheme(client)
        LspHandler.init(client, () => this.restart())

        this.disposables.push(
            client.onDidChangeState((event) => {
                if (event.newState !== State.Running) {
                    return
                }
                if (!this.hasRun) {
                    this.hasRun = true
                    this.setup()
                } else {
                    // The server came back after a restart or crash. Its diagram state is gone, so the
                    // webview must be rebuilt against it rather than left showing a dead diagram.
                    this.manager?.restart().catch((error) => {
                        vscode.window.showErrorMessage(`The diagram could not be restarted: ${error}`)
                    })
                }
            })
        )

        this.disposables.push(
            vscode.commands.registerCommand(command.clearData, () => {
                StorageService.clearAll(context.workspaceState)
                this.manager?.messenger.sendNotification(
                    { method: 'klighd/persistence' },
                    { type: 'webview', webviewType: diagramType },
                    { type: 'persistence/reportChange', payload: { type: 'clear' } } as ReportChangeMessage
                )
                vscode.window.showInformationMessage('Stored diagram data has been deleted.')
            })
        )
        this.disposables.push(
            vscode.commands.registerCommand(command.debugOptions, () => {
                this.dispatchAction(SetRenderOptionAction.create(DebugOptions.ID, true))
            })
        )
        this.disposables.push(vscode.commands.registerCommand(command.diagramRestart, () => this.restart()))
        this.disposables.push(
            this.onWebviewNotification(diagramDrawnNotification, () => {
                this.notDrawing = false
                this.modelDrawn.fire()
            })
        )
        context.subscriptions.push(...this.disposables)
    }

    private setup(): void {
        try {
            this.manager = new KLighDWebviewPanelManager(
                {
                    extensionUri: this.context.extensionUri,
                    defaultDiagramType: diagramType,
                    languageClient: this.client,
                    supportedFileExtensions: this.fileEndings.map((ending) => `.${ending}`),
                    singleton: true,
                },
                this.storageService,
                this.actionHandlers
            )
            registerCommands(this.manager, this.context)
            registerLspEditCommands(this.manager, this.context, { extensionPrefix: 'keith-vscode.diagram' })
            registerTextEditorSync(this.manager, this.context)
            this.context.subscriptions.push(
                vscode.window.onDidChangeActiveColorTheme((theme) => {
                    this.manager?.endpoints.forEach((endpoint) => endpoint.sendAction(paletteAction(theme.kind)))
                }),
                vscode.workspace.onDidChangeConfiguration((event) => {
                    if (!event.affectsConfiguration(DIAGRAM_COLOR_THEME_SETTING)) return
                    setColorTheme(this.client)
                    this.manager?.endpoints.forEach((endpoint) => endpoint.sendAction(paletteAction()))
                })
            )
            this.storageService.setMessenger(this.manager.messenger)
            this.notificationHandlers.forEach((register) => register())
            this.context.subscriptions.push(
                this.manager.onDidChangeDiagram(() => this.diagramChanged.fire()),
                this.diagramChanged
            )
            new KlighdWebviewReopener(this.storageService).reopenDiagram()
        } catch (error) {
            vscode.window.showErrorMessage(`The KIELER diagram view could not be set up: ${error}`)
            throw error
        }
    }

    /** Intercept diagram actions of the given kind before they reach the language server. */
    addActionHandler(kind: string, actionHandler: ActionHandlerCallback): void {
        this.actionHandlers.push({ kind, actionHandler })
    }

    /** Receive a notification of the given type from any diagram webview. */
    onWebviewNotification<P>(type: NotificationType<P>, handler: (params: P) => void): vscode.Disposable {
        let subscription: vscode.Disposable | undefined
        const register = () => {
            subscription = this.manager?.messenger.onNotification(type, handler)
        }
        this.notificationHandlers.add(register)
        register()
        return new vscode.Disposable(() => {
            this.notificationHandlers.delete(register)
            subscription?.dispose()
        })
    }

    get currentUri(): vscode.Uri | undefined {
        return this.manager?.currentUri
    }

    /** When the user last acted on the diagram, as `Date.now()`; 0 before any interaction. */
    get lastDiagramInteraction(): number {
        return this.manager?.lastInteraction ?? 0
    }

    /** Resolves once the server delivers the next diagram model, or after the timeout when none arrives. */
    nextModel(timeoutMs = 15000): Promise<void> {
        const { manager } = this
        if (!manager || !manager.isOpen) return Promise.resolve()
        return new Promise((resolve) => {
            const subscription = manager.onDidReceiveModel(() => finish())
            const timer = setTimeout(finish, timeoutMs)
            function finish() {
                clearTimeout(timer)
                subscription.dispose()
                resolve()
            }
        })
    }

    /** Whether a visible preview shows the model, so its diagram is redrawn after every tick. */
    drawsVisibly(uri: vscode.Uri | string | undefined): boolean {
        const shown = this.manager?.currentUri?.toString()
        if (!uri || !shown || shown !== vscode.Uri.parse(uri.toString()).toString()) return false
        return this.manager!.isVisible
    }

    /**
     * Resolves once the preview has drawn a simulation's diagram, or after the timeout. A preview that
     * is scrolled away or in a minimized window draws nothing (the browser holds its animation frames),
     * so after a timeout this resolves at once until the preview draws again: a preview that does not
     * draw only swaps the waiting diagram for the newest, which costs next to nothing.
     */
    nextDraw(timeoutMs = 250): Promise<void> | undefined {
        if (this.notDrawing) return undefined
        return new Promise((resolve) => {
            const subscription = this.modelDrawn.event(() => finish())
            const timer = setTimeout(() => {
                this.notDrawing = true
                finish()
            }, timeoutMs)
            function finish() {
                clearTimeout(timer)
                subscription.dispose()
                resolve()
            }
        })
    }

    /** Send a notification to every open diagram webview; a no-op while none is open. */
    sendToDiagram<P>(type: NotificationType<P>, payload: P): void {
        this.manager?.messenger.sendNotification(type, { type: 'webview', webviewType: diagramType }, payload)
    }

    /** Send an action to the open diagram, if any. */
    dispatchAction(action: Action): void {
        this.manager?.messenger.sendNotification(
            { method: 'ActionMessage' },
            { type: 'webview', webviewType: diagramType },
            { clientId: diagramClientId, action } as ActionMessage
        )
    }

    /**
     * Rebuild the diagram from scratch: close the panel, drop the server-side diagram state, and
     * open the same model again. Falls back to the active editor when no diagram was open.
     */
    async restart(): Promise<void> {
        if (!this.manager) {
            return
        }
        if (this.manager.isOpen) {
            await this.manager.restart()
            return
        }
        const editor = vscode.window.activeTextEditor
        if (editor) {
            await vscode.commands.executeCommand(command.diagramOpen, editor.document.uri)
        }
    }
}

export const DIAGRAM_COLOR_THEME_SETTING = 'keith-vscode.diagramColorTheme'

interface DiagramPalette {
    kind: ColorThemeKind
    foreground: string
    background: string
    highlight: string
}

/**
 * The palette the server should draw with. KIELER's dark palette is low-contrast, so the default pins
 * diagrams to the light one; `editor` follows the VS Code theme instead. VS Code exposes no API for
 * theme colours, so the values mirror its default themes.
 */
export function diagramPalette(
    setting = vscode.workspace.getConfiguration().get<string>(DIAGRAM_COLOR_THEME_SETTING),
    editorTheme: vscode.ColorThemeKind = vscode.window.activeColorTheme.kind
): DiagramPalette {
    const kind = setting === 'editor' ? convertColorThemeKind(editorTheme) : ColorThemeKind.LIGHT
    if (kind === ColorThemeKind.DARK || kind === ColorThemeKind.HIGH_CONTRAST_DARK) {
        return { kind, foreground: '#D4D4D4', background: '#1E1E1E', highlight: '#0078D4' }
    }
    return { kind, foreground: '#000000', background: '#FFFFFF', highlight: '#005FB8' }
}

/** Sends the diagram palette with the language client's initialisation options. */
function setColorTheme(client: LanguageClient): void {
    client.clientOptions.initializationOptions = {
        ...client.clientOptions.initializationOptions,
        clientColorPreferences: diagramPalette(),
    }
}

/**
 * Re-colours open diagrams. Following the editor goes through klighd-core, which reads the real theme
 * colours from the webview's CSS; the pinned light palette is sent with explicit colours, because the
 * server paints light regions with whatever background it is given.
 */
function paletteAction(editorTheme?: vscode.ColorThemeKind): ChangeColorThemeAction | ClientColorPreferencesAction {
    const palette = diagramPalette(undefined, editorTheme)
    const followEditor = vscode.workspace.getConfiguration().get<string>(DIAGRAM_COLOR_THEME_SETTING) === 'editor'
    return followEditor
        ? ChangeColorThemeAction.create(palette.kind)
        : ClientColorPreferencesAction.create({ ...palette })
}

function convertColorThemeKind(kind: vscode.ColorThemeKind): ColorThemeKind {
    switch (kind) {
        case vscode.ColorThemeKind.Light:
            return ColorThemeKind.LIGHT
        case vscode.ColorThemeKind.Dark:
            return ColorThemeKind.DARK
        case vscode.ColorThemeKind.HighContrast:
            return ColorThemeKind.HIGH_CONTRAST_DARK
        case vscode.ColorThemeKind.HighContrastLight:
            return ColorThemeKind.HIGH_CONTRAST_LIGHT
        default:
            return ColorThemeKind.LIGHT
    }
}

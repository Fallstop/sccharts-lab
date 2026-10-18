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
import { Action } from 'sprotty-protocol'
import {
    SprottyDiagramIdentifier,
    WebviewEndpoint,
    createFileUri,
    createWebviewHtml,
    createWebviewTitle,
    isWebviewPanel,
    serializeUri,
} from 'sprotty-vscode'
import { LspWebviewEndpoint, LspWebviewPanelManager, LspWebviewPanelManagerOptions } from 'sprotty-vscode/lib/lsp'
import { addLspLabelEditActionHandler, addWorkspaceEditActionHandler } from 'sprotty-vscode/lib/lsp/editing'
import { didCloseMessageType } from 'sprotty-vscode/lib/lsp/protocol'
import * as path from 'path'
import * as vscode from 'vscode'
import { contextKeys, diagramClientId } from './constants'
import { StorageService } from './storage/storage-service'
import { KlighDWebviewEndpoint, KlighDWebviewEndpointOptions } from './webview-endpoint'

/**
 * Callback provided for other parts of the extension to intercept diagram actions before they
 * reach the language server.
 */
export type ActionHandlerCallback = (action: Action) => unknown

/**
 * The webview panel manager for KLighD diagrams. Adds editor synchronisation, external action
 * handlers, and a restart that throws away both the webview and the server-side diagram state.
 */
export class KLighDWebviewPanelManager extends LspWebviewPanelManager {
    readonly storageService: StorageService

    private syncWithEditor: boolean

    private actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[]

    /** Uri of the model shown last, so a restart can bring the same diagram back. */
    private lastUri: vscode.Uri | undefined

    /** Column the diagram panel was in last, so a restart reopens it in the same place. */
    private lastViewColumn: vscode.ViewColumn | undefined

    private restarting = false

    private readonly diagramChanged = new vscode.EventEmitter<void>()

    readonly onDidChangeDiagram = this.diagramChanged.event

    private readonly modelReceived = new vscode.EventEmitter<void>()

    /** Fires when the server delivers a diagram model, which is when a show request has really finished. */
    readonly onDidReceiveModel = this.modelReceived.event

    /** When the webview last sent a user-driven action to the server, as `Date.now()`; 0 before any. */
    lastInteraction = 0

    constructor(
        options: LspWebviewPanelManagerOptions,
        storageService: StorageService,
        actionHandlers: { kind: string; actionHandler: ActionHandlerCallback }[]
    ) {
        super(options)
        this.storageService = storageService
        this.actionHandlers = actionHandlers
        this.syncWithEditor = true
        this.setSyncWithEditor(true)
        vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, false)
    }

    /** Changes the behavior of "sync with editor". If disabled, the diagram view will not update when the active editor changes. */
    setSyncWithEditor(sync: boolean): void {
        this.syncWithEditor = sync
        vscode.commands.executeCommand('setContext', contextKeys.syncWithEditor, sync)
    }

    getSyncWithEdior(): boolean {
        return this.syncWithEditor
    }

    get isOpen(): boolean {
        return this.endpoints.length > 0
    }

    /** Some preview is on screen; a hidden webview draws nothing until it is shown again. */
    get isVisible(): boolean {
        return this.endpoints.some((endpoint) => {
            try {
                return endpoint.webviewContainer.visible === true
            } catch {
                return false
            }
        })
    }

    get currentUri(): vscode.Uri | undefined {
        return this.lastUri
    }

    override async openDiagram(
        uri: vscode.Uri,
        options: { diagramType?: string; reveal?: boolean; preserveFocus?: boolean } = {}
    ): Promise<WebviewEndpoint | undefined> {
        this.pruneDisposedEndpoints()
        const endpoint = await super.openDiagram(uri, options)
        if (endpoint) {
            this.lastUri = uri
            if (endpoint.diagramIdentifier) {
                endpoint.webviewContainer.title = `[Preview] ${createWebviewTitle(endpoint.diagramIdentifier)}`
            }
            vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, true)
            if (options.reveal && isWebviewPanel(endpoint.webviewContainer)) {
                endpoint.webviewContainer.reveal(endpoint.webviewContainer.viewColumn, options.preserveFocus)
            }
            this.diagramChanged.fire()
        }
        return endpoint
    }

    /** Drops endpoints whose panel VS Code has disposed without telling us. */
    private pruneDisposedEndpoints(): void {
        for (const endpoint of [...this.endpoints]) {
            const panel = endpoint.webviewContainer
            let disposed = false
            try {
                // Any property access on a disposed WebviewPanel throws.
                disposed = isWebviewPanel(panel) && panel.visible === undefined
            } catch {
                disposed = true
            }
            if (disposed) {
                this.didCloseWebview(endpoint)
            }
        }
    }

    /**
     * Closes every diagram panel, which also makes the language server forget its diagram state
     * for this client, and reopens the last diagram. This is the cure for a diagram that keeps
     * failing to render, for example after the server switched the model behind it.
     */
    async restart(): Promise<void> {
        if (this.restarting) {
            return
        }
        this.restarting = true
        try {
            const uri = this.lastUri
            const column = this.lastViewColumn
            const endpoints = [...this.endpoints]
            const panels = endpoints.map((endpoint) => endpoint.webviewContainer)
            panels.forEach((panel) => {
                if (isWebviewPanel(panel)) {
                    panel.dispose()
                }
            })
            // Disposal is reported asynchronously; wait until the manager has dropped the endpoints.
            await waitUntil(() => this.endpoints.length === 0, 2000)
            this.pruneDisposedEndpoints()
            endpoints.forEach((endpoint) => this.didCloseWebview(endpoint))
            if (uri) {
                this.lastViewColumn = column
                await this.openDiagram(uri, { reveal: true, preserveFocus: true })
                this.storageService.setItem('diagramOpen', true)
            }
        } finally {
            this.restarting = false
        }
    }

    protected override async createDiagramIdentifier(
        uri: vscode.Uri,
        diagramType?: string
    ): Promise<SprottyDiagramIdentifier | undefined> {
        if (!diagramType) {
            diagramType = await this.getDiagramType(uri)
            if (!diagramType) {
                return undefined
            }
        }
        return {
            diagramType,
            uri: serializeUri(uri),
            clientId: diagramClientId,
        }
    }

    /**
     * Same as the sprotty-vscode default, but titled as a preview, and reopened in the column the
     * diagram was in before a restart instead of always beside the editor.
     */
    protected override createWebview(identifier: SprottyDiagramIdentifier): vscode.WebviewPanel {
        const extensionPath = this.options.extensionUri.fsPath
        const title = `[Preview] ${createWebviewTitle(identifier)}`
        const panel = vscode.window.createWebviewPanel(
            identifier.diagramType || 'diagram',
            title,
            { viewColumn: this.lastViewColumn ?? vscode.ViewColumn.Beside, preserveFocus: true },
            {
                localResourceRoots: this.options.localResourceRoots ?? [createFileUri(extensionPath, 'pack')],
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        )
        panel.iconPath = vscode.Uri.file(path.join(extensionPath, 'icon.png'))
        const scriptUri = createFileUri(extensionPath, 'pack', 'webview.js')
        // sprotty-vscode's policy has no font-src, which silently blocks klighd's codicon font.
        panel.webview.html = createWebviewHtml(identifier, panel, { scriptUri, title }).replace(
            'style-src',
            `font-src ${panel.webview.cspSource}; style-src`
        )
        panel.onDidChangeViewState(() => {
            this.lastViewColumn = panel.viewColumn ?? this.lastViewColumn
        })
        return panel
    }

    protected override createEndpoint(identifier: SprottyDiagramIdentifier): LspWebviewEndpoint {
        const webviewContainer = this.createWebview(identifier)
        const participant = this.messenger.registerWebviewPanel(webviewContainer)
        const options: KlighDWebviewEndpointOptions = {
            languageClient: this.languageClient,
            webviewContainer,
            messenger: this.messenger,
            messageParticipant: participant,
            identifier,
            onModelReceived: () => this.modelReceived.fire(),
            onActionSent: (kind) => {
                // The initial model request is the extension's doing, not the user's.
                if (kind !== 'requestModel') this.lastInteraction = Date.now()
            },
        }
        const endpoint = new KlighDWebviewEndpoint(options)

        addWorkspaceEditActionHandler(endpoint as unknown as LspWebviewEndpoint)
        addLspLabelEditActionHandler(endpoint as unknown as LspWebviewEndpoint)

        for (const actionHandler of this.actionHandlers) {
            endpoint.addKlighdActionHandler(actionHandler.kind, actionHandler.actionHandler)
        }
        return endpoint as unknown as LspWebviewEndpoint
    }

    protected override didCloseWebview(endpoint: WebviewEndpoint): void {
        if (!this.endpoints.includes(endpoint)) return
        // The panel is already disposed here; reading its view column would throw and leave the
        // dead endpoint registered, which is why the diagram could never be reopened.
        this.endpoints.splice(this.endpoints.indexOf(endpoint), 1)
        if (this.languageClient.isRunning()) {
            this.languageClient
                .sendNotification(didCloseMessageType, endpoint.diagramIdentifier?.clientId)
                .catch(() => undefined)
        }
        if (this.endpoints.length === 0) {
            vscode.commands.executeCommand('setContext', `${endpoint.diagramIdentifier?.diagramType}-focused`, false)
            vscode.commands.executeCommand('setContext', contextKeys.diagramOpen, false)
            // A restart closes and reopens; only a user-initiated close should be remembered.
            if (!this.restarting) {
                this.storageService.setItem('diagramOpen', false)
            }
        }
    }
}

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const started = Date.now()
        const tick = () => {
            if (condition() || Date.now() - started > timeoutMs) {
                resolve()
            } else {
                setTimeout(tick, 20)
            }
        }
        tick()
    })
}

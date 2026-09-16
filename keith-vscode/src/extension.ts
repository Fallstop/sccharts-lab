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

import { connect, NetConnectOpts, Socket } from 'net'
import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, ServerOptions, State, StreamInfo } from 'vscode-languageclient/node'
import { Settings, settingsKey } from './constants'
import { KeithErrorHandler } from './error-handler'
import { reportConflictingExtensions } from './conflicts'
import { DiagramController } from './diagram/diagram-controller'
import { registerCursorSync } from './diagram/cursor-sync-registration'
import { REQUEST_CS } from './kico/commands'
import { CompilationDataProvider } from './kico/compilation-data-provider'
import { DiagnosticBridge } from './kico/diagnostic-bridge'
import { registerCodeGeneration } from './kico/code-generation'
import { WorkspaceSystems } from './kico/workspace-systems'
import { LiveDiagnostics, LiveDiagnosticsParam, liveDiagnosticsMethod } from './kico/live-diagnostics'
import { WarningToggle } from './kico/warning-toggle'
import { handlePerformAction, PerformActionAction, performActionKind } from './perform-action-handler'
import { RuntimeManager } from './runtime/runtime-manager'
import { SettingsService } from './settings'
import { RESTART_LANGUAGE_SERVER } from './simulation/commands'
import { SimulationTableDataProvider } from './simulation/simulation-table-data-provider'
import { SimulationViewBridge } from './simulation/simulation-view-bridge'
// import 'simulation/index.css'

/**
 * All file endings of the languages that are supported by keith-vscode.
 * The file ending should also be the language id, since it is also used to
 * register document selectors in the language client.
 */
const supportedFileEndings = ['sctx', 'scl', 'kico']

let lsClient: LanguageClient
let socket: Socket
let settingsService: SettingsService<Settings>
/** Kept here because it owns the server process, which has to be ended on the way out. */
let runtimeManager: RuntimeManager | undefined

// this method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
    if (socket) {
        // Don't call lsClient.stop when we are connected via socket for development.
        // That call will end the LS server, leading to a bad dev experience.
        socket.end()
        return
    }
    try {
        await lsClient?.stop()
    } catch {
        // stop() rejects when its own two-second shutdown times out. The JVM is then still running, so
        // swallowing the rejection here is what keeps the kill below reachable.
    }
    // The client only ever asked the server to exit (see runtime/server-process.ts); this makes sure it did.
    await runtimeManager?.stopServer()
}

/**
 * Depending on the launch configuration, returns {@link ServerOptions} that either
 * connect to a socket or start the LS as a process. It uses a socket if the
 * environment variable `KEITH_LS_PORT` is present. Otherwise it runs the jar located
 * at `server/sccharts-lite-server.jar` on the Java the {@link RuntimeManager} resolved:
 * the runtime bundled with a platform build, or a Java 21+ found on the machine.
 */
function createServerOptions(runtime: RuntimeManager): ServerOptions {
    // Connect to language server via socket if a port is specified as an env variable
    if (typeof process.env.KEITH_LS_PORT !== 'undefined') {
        const connectionInfo: NetConnectOpts = {
            port: parseInt(process.env.KEITH_LS_PORT, 10),
        }
        // eslint-disable-next-line no-console
        console.log('Connecting to language server on port: ', connectionInfo.port)

        return async () => {
            socket = connect(connectionInfo)
            const result: StreamInfo = {
                writer: socket,
                reader: socket,
            }
            return result
        }
    }
    // The server is the sccharts-lite build: KIELER's SCCharts compiler, simulation and KLighD
    // diagram server with this extension's diagnostics built in, shaded into one JAR. Spawning it
    // ourselves (instead of handing the client a command) lets every restart pick up a toolchain that
    // was downloaded or configured in the meantime.
    return () => runtime.launchServer()
}

/**
 * Restarts the language server in place, without reloading the window, and forgets any running simulation.
 * This clears stuck server state such as a diagram view that keeps failing to render.
 */
async function restartLanguageServer(simulation: SimulationTableDataProvider): Promise<void> {
    simulation.resetForRestart()
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting KIELER language server...' },
        async () => {
            try {
                await lsClient.restart()
                vscode.window.setStatusBarMessage('$(check) KIELER language server restarted', 5000)
            } catch {
                // restart() gives up inside its stop() phase when the server does not act on the shutdown
                // request, so the old JVM is still running and no new one was started. End it and retry;
                // without this the window is left with a dead client and a server that never goes away.
                await runtimeManager?.stopServer()
                try {
                    await lsClient.start()
                    vscode.window.setStatusBarMessage('$(check) KIELER language server restarted', 5000)
                } catch (error) {
                    vscode.window.showErrorMessage(`KIELER language server failed to restart: ${error}`)
                }
            }
        }
    )
}

// this method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (await reportConflictingExtensions()) {
        return
    }

    // Create context key of supported languages
    vscode.commands.executeCommand('setContext', 'keith-vscode.languages', supportedFileEndings)

    // Without a usable Java there is nothing to start; explain and stop instead of registering
    // commands that would all fail with "spawn java ENOENT".
    const runtime = new RuntimeManager(context)
    runtimeManager = runtime
    context.subscriptions.push(runtime)
    if (typeof process.env.KEITH_LS_PORT === 'undefined' && !(await runtime.resolveJava())) {
        await runtime.reportMissingJava()
        return
    }

    const serverOptions: ServerOptions = createServerOptions(runtime)

    const clientOptions: LanguageClientOptions = {
        documentSelector: supportedFileEndings.map((ending) => ({
            scheme: 'file',
            language: ending,
        })),
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.*'),
        },
    }

    lsClient = new LanguageClient('KIELER Language Server', serverOptions, clientOptions, true)

    // Setup basic connection error reporting
    const defaultErrorHandler = lsClient.createDefaultErrorHandler()
    lsClient.clientOptions.errorHandler = new KeithErrorHandler(defaultErrorHandler)

    // Diagrams are part of this extension now (merged from klighd-vscode), so no other
    // extension has to be handed the language client.
    const diagrams = new DiagramController(context, lsClient, supportedFileEndings)

    // create SettingsService with list of setting-keys to manage
    settingsService = new SettingsService<Settings>(settingsKey, [
        'autocompile.enabled',
        'compileInplace.enabled',
        'showResultingModel.enabled',
        'showPrivateSystems.enabled',
        'simulationStepDelay',
        'simulationType',
        'showInternalVariables.enabled',
        'liveDiagnostics.enabled',
        'liveDiagnostics.debounceMs',
        'diagnostics.showWarnings',
    ])
    context.subscriptions.push(settingsService)

    const compilationDataProvider = new CompilationDataProvider(lsClient, context, settingsService)
    registerCodeGeneration(context, compilationDataProvider)
    // .kico files in the workspace define compilation systems of their own; the server loads them.
    context.subscriptions.push(new WorkspaceSystems(lsClient))
    compilationDataProvider.awaitDiagram = () => diagrams.nextModel()
    context.subscriptions.push(
        new DiagnosticBridge(compilationDataProvider.diagnostics, diagrams, (uri, index) =>
            compilationDataProvider.show(uri, index)
        )
    )
    // The server analyses open SCCharts after every edit; the findings show as squiggles without a compile.
    const liveDiagnostics = new LiveDiagnostics(lsClient, compilationDataProvider.diagnostics)
    const showWarnings = () => settingsService.get('diagnostics.showWarnings') ?? true
    compilationDataProvider.diagnostics.setShowWarnings(showWarnings())
    const liveConfiguration = () => ({
        enabled: settingsService.get('liveDiagnostics.enabled') ?? true,
        debounceMs: settingsService.get('liveDiagnostics.debounceMs') ?? 400,
    })
    context.subscriptions.push(
        liveDiagnostics,
        new WarningToggle(settingsService, compilationDataProvider.diagnostics, liveDiagnostics),
        lsClient.onNotification(liveDiagnosticsMethod, (params: LiveDiagnosticsParam) =>
            liveDiagnostics.accept(params)
        ),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${settingsKey}.liveDiagnostics`))
                liveDiagnostics.configure(liveConfiguration())
            if (event.affectsConfiguration(`${settingsKey}.diagnostics.showWarnings`))
                compilationDataProvider.diagnostics.setShowWarnings(showWarnings())
        })
    )
    // Clicking the code view's text asks for an Eclipse editor; the generated code opens as tabs instead.
    diagrams.addActionHandler(performActionKind, (action) => {
        const uri = diagrams.currentUri
        const stage = compilationDataProvider.currentStage(uri?.toString())
        const target = stage && /java/i.test(stage.name) ? 'java' : 'c'
        return handlePerformAction(action as PerformActionAction, uri, target)
    })
    // Reopening or restarting the diagram synthesizes the source model again, so no stage is shown any more.
    context.subscriptions.push(
        diagrams.onDidChangeDiagram(() => compilationDataProvider.diagramReset(diagrams.currentUri?.toString()))
    )
    // The editor cursor follows into the diagram (and diagram selections back into the editor).
    registerCursorSync(context, lsClient, diagrams)

    // The simulation lives in the diagram preview tab: controls above the diagram, the tick-by-tick trace below.
    const simulationDataProvider: SimulationTableDataProvider = new SimulationTableDataProvider(
        lsClient,
        compilationDataProvider,
        context,
        settingsService
    )
    // A simulation build needs a C compiler (or javac); check, offer the download, and only then compile.
    simulationDataProvider.prepareBuild = (systemId, label) => runtime.prepareBuild(systemId, label)
    runtime.restartServer = () => restartLanguageServer(simulationDataProvider)
    context.subscriptions.push(new SimulationViewBridge(simulationDataProvider, diagrams, settingsService))

    context.subscriptions.push(
        vscode.commands.registerCommand(RESTART_LANGUAGE_SERVER.command, () =>
            restartLanguageServer(simulationDataProvider)
        )
    )

    // After a restart (manual or automatic) the compiler panel must learn the fresh server's systems.
    let serverStarts = 0
    context.subscriptions.push(
        lsClient.onDidChangeState((event) => {
            if (event.newState === State.Stopped) {
                compilationDataProvider.diagnostics.reset()
                compilationDataProvider.compiling = false
                compilationDataProvider.lastCompiledUri = ''
                compilationDataProvider.compilationFinishedEmitter.fire(false)
                vscode.commands.executeCommand('setContext', 'keith.vscode:compilationReady', false)
            }
            if (event.newState !== State.Running) {
                return
            }
            serverStarts++
            liveDiagnostics.configure(liveConfiguration())
            if (serverStarts > 1) {
                vscode.commands.executeCommand(REQUEST_CS.command)
            }
        })
    )

    // eslint-disable-next-line no-console
    console.debug('Starting Language Server...')
    await lsClient.start()

    // TODO save stuff in context e.g. commands.executeCommand("setContext", "var", value);
}

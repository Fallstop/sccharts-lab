import * as vscode from 'vscode'
import { DiagramController } from '../diagram/diagram-controller'
import { CompilerDiagnostics } from './compiler-diagnostics'
import { diagnosticCommand, DiagnosticCommand, diagnosticHighlight, diagnosticState } from './diagnostic-protocol'
import { HIDE_WARNINGS, SHOW_WARNINGS } from './warning-toggle'

/** One build report drives editor diagnostics and the preview, including after reopening the panel. */
export class DiagnosticBridge implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[]

    private readonly decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid',
        borderColor: new vscode.ThemeColor('editorError.foreground'),
    })

    constructor(
        private readonly diagnostics: CompilerDiagnostics,
        private readonly diagrams: DiagramController,
        private readonly showStage: (uri: string, index: number) => void | Promise<unknown>
    ) {
        this.subscriptions = [
            diagnostics.onDidChange(() => {
                this.clearHighlights()
                this.push()
            }),
            diagrams.onDidChangeDiagram(() => {
                this.clearHighlights()
                this.push()
            }),
            diagrams.onWebviewNotification(diagnosticCommand, (command) => {
                this.handle(command).catch((error) =>
                    vscode.window.showErrorMessage(`Could not open compiler diagnostic: ${String(error)}`)
                )
            }),
        ]
    }

    dispose(): void {
        this.subscriptions.forEach((subscription) => subscription.dispose())
        this.decoration.dispose()
    }

    private clearHighlights(): void {
        vscode.window.visibleTextEditors.forEach((editor) => editor.setDecorations(this.decoration, []))
        this.diagrams.sendToDiagram(diagnosticHighlight, { traceUris: [] })
    }

    private push(): void {
        const modelUri = this.diagrams.currentUri?.toString()
        const report = modelUri ? this.diagnostics.get(modelUri) : undefined
        this.diagrams.sendToDiagram(diagnosticState, {
            modelUri,
            report: report && { ...report, issues: report.issues.map((issue) => ({ ...issue, details: undefined })) },
            showWarnings: this.diagnostics.showWarnings ?? true,
        })
    }

    private async handle(command: DiagnosticCommand): Promise<void> {
        if (!command || typeof command.kind !== 'string') return
        if (command.kind === 'request') {
            this.push()
            return
        }
        if (command.kind === 'showWarnings') {
            // The same setting the editor's quick fix and the status bar change; the compiler's change event pushes it back.
            await vscode.commands.executeCommand(command.enabled ? SHOW_WARNINGS : HIDE_WARNINGS)
            return
        }
        const uri = this.diagrams.currentUri?.toString()
        const report = uri ? this.diagnostics.get(uri) : undefined
        if (!report || report.id !== command.build) return
        if (command.kind === 'problems') {
            await vscode.commands.executeCommand('workbench.actions.view.problems')
            return
        }
        if (command.kind === 'copy') {
            await vscode.commands.executeCommand('keith-vscode.copy-diagnostics', vscode.Uri.parse(report.uri))
            return
        }
        const issue = report.issues.find((entry) => entry.id === command.issue)
        if (!issue) return
        if (command.kind === 'details') {
            const document = await vscode.workspace.openTextDocument({
                language: 'plaintext',
                content: `${issue.stage}: ${issue.message}\n\n${issue.hint ?? ''}\n\n${
                    issue.details ?? 'No additional compiler output.'
                }\n\n${issue.cycle.map((edge) => `${edge.from} -> ${edge.to}: ${edge.reason}`).join('\n')}`,
            })
            await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside })
            return
        }
        const current = () =>
            this.diagnostics.get(report.uri) === report && (report.status === 'failed' || report.status === 'succeeded')
        if (!current()) return
        if (command.kind === 'stage') {
            if (issue.snapshotIndex < 0) return
            this.clearHighlights()
            await this.showStage(report.uri, issue.snapshotIndex)
            return
        }
        if (command.kind === 'highlight') {
            await this.showStage(report.uri, -1)
            if (!current()) return
            this.diagrams.sendToDiagram(diagnosticHighlight, {
                traceUris: issue.locations
                    .map((location) => location.traceUris ?? [])
                    .filter((traces) => traces.length > 0),
            })
            return
        }
        const location = issue.locations[command.location ?? 0]
        if (!location || vscode.Uri.parse(location.uri).scheme !== 'file') return
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri))
        if (!current()) return
        if (location.uri === report.uri && document.version !== report.version) return
        const range = this.diagnostics.range(location, document)
        const visible = vscode.window.visibleTextEditors.find((entry) => entry.document.uri.toString() === location.uri)
        const group = vscode.window.tabGroups.all.find((entry) =>
            entry.tabs.some(
                (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === location.uri
            )
        )
        const editor = await vscode.window.showTextDocument(document, {
            preview: true,
            viewColumn: visible?.viewColumn ?? group?.viewColumn ?? vscode.ViewColumn.Beside,
            selection: range,
            preserveFocus: false,
        })
        if (!current() || (location.uri === report.uri && document.version !== report.version)) return
        editor.setDecorations(
            this.decoration,
            issue.locations.filter((l) => l.uri === location.uri).map((l) => this.diagnostics.range(l, document))
        )
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }
}

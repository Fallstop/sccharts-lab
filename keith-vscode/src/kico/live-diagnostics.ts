import * as vscode from 'vscode'
import type { LanguageClient } from 'vscode-languageclient/node'
import { CompilerDiagnostics, renderIssues, withoutExplainedLoops } from './compiler-diagnostics'
import { CompilerIssue } from './diagnostic-protocol'
import { OwnedDiagnostics } from './owned-diagnostics'

/** `keith/diagnostics/live`: what the server's live analysis found in one version of an open document. */
export interface LiveDiagnosticsParam {
    uri: string
    version?: number | null
    issues: CompilerIssue[]
    durationMs: number
    reason?: 'clean' | 'syntax' | 'source' | 'internal' | 'disabled' | 'closed' | 'cancelled' | null
}

export interface LiveDiagnosticsConfig {
    enabled: boolean
    debounceMs: number
}

export const liveDiagnosticsMethod = 'keith/diagnostics/live'
export const configureLiveDiagnosticsMethod = 'keith/diagnostics/configure'

/**
 * Shows the server's live analysis (scheduling cycles, instantaneous loops and other located analyzer findings)
 * as squiggles while the user types, in its own collection next to the compile results. A current compile report
 * for the same document wins: live results are hidden while it is current and only return once an edit makes it
 * stale. Results for a document version the editor has moved past are dropped.
 */
export class LiveDiagnostics implements vscode.Disposable {
    private readonly collection = new OwnedDiagnostics('kieler-live')

    /** The last accepted result per document, kept so it can return once a compile report goes stale. */
    private readonly latest = new Map<string, LiveDiagnosticsParam>()

    private readonly subscriptions: vscode.Disposable[]

    private readonly changed = new vscode.EventEmitter<void>()

    /** Fires when a document's held live result changes or is dropped. */
    readonly onDidChange = this.changed.event

    private config: LiveDiagnosticsConfig = { enabled: true, debounceMs: 400 }

    constructor(
        private readonly client: Pick<LanguageClient, 'sendNotification'>,
        private readonly compiler: Pick<CompilerDiagnostics, 'get' | 'onDidChange' | 'showWarnings'>
    ) {
        this.subscriptions = [
            // A compile that starts or finishes takes over; one that goes stale hands back to the live result.
            compiler.onDidChange(() => this.reconcile()),
            vscode.workspace.onDidChangeTextDocument(({ document }) => {
                const uri = document.uri.toString()
                if (this.latest.get(uri)?.version !== document.version) this.forget(uri)
            }),
            vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri.toString())),
        ]
    }

    dispose(): void {
        this.collection.dispose()
        this.changed.dispose()
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }

    /** Results belong to the server process that analyzed the document. */
    reset(): void {
        this.latest.clear()
        this.collection.clear()
        this.changed.fire()
    }

    get configuration(): LiveDiagnosticsConfig {
        return this.config
    }

    /** Sends the configuration to the server; called on start and whenever the settings change. */
    async configure(config: LiveDiagnosticsConfig): Promise<void> {
        this.config = {
            enabled: config.enabled,
            debounceMs: Number.isFinite(config.debounceMs) ? Math.max(0, Math.round(config.debounceMs)) : 400,
        }
        if (!this.config.enabled) {
            ;[...this.latest.keys()].forEach((uri) => this.forget(uri))
        }
        try {
            await this.client.sendNotification(configureLiveDiagnosticsMethod, this.config)
        } catch {
            // The server is not running; it gets the configuration when it starts.
        }
    }

    /** Handles one `keith/diagnostics/live` notification. Returns whether it was shown. */
    accept(params: LiveDiagnosticsParam): boolean {
        if (!this.config.enabled) return false
        const uri = vscode.Uri.parse(params.uri).toString()
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri)
        if (!document) {
            this.forget(uri)
            return false
        }
        if (params.version != null && params.version !== document.version) return false
        const issues = withoutExplainedLoops(params.issues ?? [])
        this.latest.set(uri, { ...params, uri, issues, version: params.version ?? document.version })
        const shown = this.show(uri)
        this.changed.fire()
        return shown
    }

    /** The live issues currently held for a document, whether shown or hidden behind a compile report. */
    get(uri: string): LiveDiagnosticsParam | undefined {
        return this.latest.get(vscode.Uri.parse(uri).toString())
    }

    private show(uri: string): boolean {
        const params = this.latest.get(uri)
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri)
        if (!params || !document || document.version !== params.version) {
            this.clear(uri)
            return false
        }
        if (this.compileIsCurrent(uri, document)) {
            this.clear(uri)
            return false
        }
        const issues = params.issues.filter((issue) => this.compiler.showWarnings || issue.severity !== 'warning')
        const byFile = renderIssues(issues, uri, document, document.getText(), () => 'KIELER · live')
        this.collection.publish(uri, byFile)
        return true
    }

    /** A compile report that is in progress or describes exactly this document version shows instead. */
    private compileIsCurrent(uri: string, document: vscode.TextDocument): boolean {
        const report = this.compiler.get(uri)
        if (!report) return false
        if (report.status === 'stale' || report.status === 'cancelled') return false
        return report.version === document.version
    }

    private reconcile(): void {
        this.latest.forEach((_, uri) => this.show(uri))
    }

    private clear(uri: string): void {
        this.collection.remove(uri)
    }

    private forget(uri: string): void {
        this.clear(uri)
        if (this.latest.delete(uri)) this.changed.fire()
    }
}

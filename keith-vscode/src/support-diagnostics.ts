import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import type { CompilationDataProvider, CompilationResults } from './kico/compilation-data-provider'
import type { BuildReport } from './kico/diagnostic-protocol'
import type { LiveDiagnostics } from './kico/live-diagnostics'
import type { RuntimeManager } from './runtime/runtime-manager'

export const COPY_DIAGNOSTICS = 'keith-vscode.copy-diagnostics'
const MAX_ISSUES = 50
const MAX_DETAIL_LENGTH = 4000

export interface DiagnosticReportContext {
    extensionVersion: string
    vscodeVersion: string
    platform: string
    serverFingerprint: string
    java?: string
    system?: string
    model?: string
    documentVersion?: number
    report?: BuildReport
    results?: CompilationResults
    live?: boolean
}

/** Keeps the report useful for reproduction without exporting the model or generated files. */
export function formatDiagnosticReport(context: DiagnosticReportContext): string {
    const { report, results } = context
    const lines = [
        'SCCharts Lab diagnostics',
        `Extension: ${context.extensionVersion}`,
        `VS Code: ${context.vscodeVersion}`,
        `Platform: ${context.platform}`,
        `Server SHA-256: ${context.serverFingerprint}`,
        `Java: ${context.java ?? 'Not resolved'}`,
    ]
    if (context.model) lines.push(`Model: ${context.model} (document version ${context.documentVersion ?? '?'})`)
    if (report) {
        lines.push(`${context.live ? 'Live analysis' : 'Build'}: ${report.status} (source version ${report.version})`)
        if (context.system) lines.push(`System: ${context.system}`)
        if (results?.totalMs !== undefined) lines.push(`Duration: ${results.totalMs} ms`)
        lines.push('', `Issues: ${report.issues.length}`)
        report.issues.slice(0, MAX_ISSUES).forEach((issue) => {
            lines.push(`[${issue.severity}] ${issue.code} at ${issue.stage}: ${issue.message}`)
            if (issue.hint) lines.push(`Hint: ${issue.hint}`)
            issue.locations.forEach((location) => {
                let file = 'model'
                try {
                    file = path.basename(vscode.Uri.parse(location.uri).path)
                } catch {
                    // A bad server location must not prevent copying the failure itself.
                }
                const position = location.line !== undefined ? `line ${location.line + 1}` : `offset ${location.offset}`
                lines.push(`Location: ${file}, ${position}, length ${location.length}`)
            })
            if (issue.details) {
                const detail = issue.details
                // Java's caused-by stack is at the end, so preserve both ends of a long failure.
                lines.push(
                    detail.length > MAX_DETAIL_LENGTH
                        ? `${detail.slice(0, MAX_DETAIL_LENGTH / 2)}\n(Technical details truncated.)\n${detail.slice(
                              -MAX_DETAIL_LENGTH / 2
                          )}`
                        : detail
                )
            }
            lines.push('')
        })
        if (report.issues.length > MAX_ISSUES) lines.push(`(${report.issues.length - MAX_ISSUES} more issues omitted.)`)
        if (results?.processors?.length) {
            lines.push('Processors:')
            results.processors.forEach((processor) => {
                lines.push(
                    `${processor.id}: ${processor.status}${
                        processor.durationMs !== undefined ? `, ${processor.durationMs} ms` : ''
                    }`
                )
            })
        }
    } else lines.push('', 'No compiler report for this model. Reproduce the failure, then copy again.')
    return `${lines.join('\n')}\n`
}

export function registerSupportDiagnostics(
    context: vscode.ExtensionContext,
    compiler: CompilationDataProvider,
    runtime: RuntimeManager,
    diagramUri: () => vscode.Uri | undefined,
    liveDiagnostics?: Pick<LiveDiagnostics, 'get'>
): void {
    let serverFingerprint: string | undefined
    context.subscriptions.push(
        vscode.commands.registerCommand(COPY_DIAGNOSTICS, async (requested?: vscode.Uri) => {
            const active = vscode.window.activeTextEditor?.document
            const uri =
                requested ??
                (active?.languageId === 'sctx' ? active.uri : undefined) ??
                diagramUri() ??
                compiler.editor?.document.uri
            let report = uri && compiler.diagnostics.get(uri.toString())
            let results = report && compiler.resultMap.get(report.uri)
            let system = report?.uri === compiler.lastCompiledUri ? compiler.lastInvokedCompilation : undefined
            const document = vscode.workspace.textDocuments.find((entry) => entry.uri.toString() === uri?.toString())
            const live = uri && liveDiagnostics?.get(uri.toString())
            const useLive = !!live && live.version === document?.version && (!report || report.status === 'stale')
            if (useLive && live) {
                report = {
                    id: 0,
                    uri: live.uri,
                    version: live.version!,
                    rawCount: live.issues.length,
                    status: live.issues.some((issue) => issue.severity === 'error') ? 'failed' : 'succeeded',
                    issues: live.issues.map((issue, index) => ({
                        ...issue,
                        id: `live:${index}`,
                        stage: 'Live analysis',
                        snapshotIndex: -1,
                    })),
                }
                results = { files: [], totalMs: live.durationMs }
                system = 'Live analysis'
            }
            if (!serverFingerprint) {
                try {
                    const jar = await fs.promises.readFile(context.asAbsolutePath('server/sccharts-lite-server.jar'))
                    serverFingerprint = crypto.createHash('sha256').update(new Uint8Array(jar)).digest('hex')
                } catch {
                    serverFingerprint = 'Unavailable (external or missing server)'
                }
            }
            const java = runtime.javaRuntime
            const text = formatDiagnosticReport({
                extensionVersion: context.extension.packageJSON.version,
                vscodeVersion: vscode.version,
                platform: `${process.platform}-${process.arch}`,
                serverFingerprint,
                java: java && `${java.description} (${java.source})`,
                model: uri && path.basename(uri.path),
                documentVersion: document?.version,
                system,
                report,
                results,
                live: useLive,
            })
            try {
                await vscode.env.clipboard.writeText(text)
                vscode.window.setStatusBarMessage('$(check) SCCharts diagnostic report copied', 5000)
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Could not copy diagnostic report: ${error instanceof Error ? error.message : error}`
                )
            }
        })
    )
}

import * as vscode from 'vscode'
import { CompilationDataProvider } from './compilation-data-provider'
import { GeneratedFile } from './generated-code-documents'

export type CodeTarget = 'c' | 'java'

const systems: Record<CodeTarget, string> = {
    c: 'de.cau.cs.kieler.sccharts.netlist',
    java: 'de.cau.cs.kieler.sccharts.netlist.java',
}

/** Capture files inside the completion event, before another build can replace the compiler's result. */
export function generateModel(
    compiler: CompilationDataProvider,
    document: vscode.TextDocument,
    target: CodeTarget,
    token: vscode.CancellationToken,
    timeoutMs = 120000
): Promise<GeneratedFile[]> {
    if (compiler.compiling) return Promise.reject(new Error('A compilation is already in progress.'))
    if (document.isDirty) return Promise.reject(new Error('The model changed. Save it and generate code again.'))
    if (token.isCancellationRequested) return Promise.resolve([])
    const uri = document.uri.toString()
    const { version } = document
    return new Promise((resolve, reject) => {
        let sent = false
        let stopRequested = false
        let settled = false
        const finish = (files?: GeneratedFile[], error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            completed.dispose()
            cancelled.dispose()
            if (error) reject(error)
            else resolve(files ?? [])
        }
        const completed = compiler.compilationFinished((success) => {
            if (token.isCancellationRequested) return finish([])
            if (document.version !== version || compiler.diagnostics.get(uri)?.status === 'stale') {
                return finish(undefined, new Error('The model changed during generation. Generate code again.'))
            }
            if (compiler.lastCompiledUri !== uri) {
                return finish(undefined, new Error('The language server restarted. Generate code again.'))
            }
            const report = compiler.diagnostics.get(uri)
            const result = compiler.resultMap.get(uri)
            if (!success || report?.status !== 'succeeded') {
                const issue = report?.issues.find((candidate) => candidate.severity === 'error')
                return finish(
                    undefined,
                    new Error(issue?.message ?? 'Generation stopped. See Problems or restart the language server.')
                )
            }
            if (result?.generationError) return finish(undefined, new Error(result.generationError))
            if (!result?.generatedFiles?.length) {
                return finish(
                    undefined,
                    new Error(
                        'The language server did not return generated files. Code generation requires the bundled SCCharts Lab server; rebuild or update the extension and restart the server.'
                    )
                )
            }
            return finish(result.generatedFiles)
        })
        const cancel = () => {
            stopRequested = true
            if (sent) compiler.requestCancelCompilation().catch((error) => finish(undefined, new Error(String(error))))
        }
        const cancelled = token.onCancellationRequested(() => {
            cancel()
            finish([])
        })
        const timeout = setTimeout(() => {
            finish(undefined, new Error('Code generation timed out. Restart the language server before trying again.'))
            cancel()
        }, timeoutMs)
        compiler.compile(systems[target], false, false, false, uri).then(
            () => {
                sent = true
                if (stopRequested || token.isCancellationRequested) cancel()
            },
            (error) => finish(undefined, error instanceof Error ? error : new Error(String(error)))
        )
    })
}

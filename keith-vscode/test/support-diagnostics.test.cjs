const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

const context = {
    extensionVersion: '0.9.6', vscodeVersion: '1.104', platform: 'darwin-arm64',
    serverFingerprint: 'server-hash', java: 'Java 21 (bundled)', model: 'counter.sctx',
    documentVersion: 5, system: 'netlist.c',
}
const report = {
    id: 1, uri: 'file:///private/models/counter.sctx', version: 4, status: 'stale',
    issues: [{ severity: 'error', code: 'compiler-internal', stage: 'SCG',
        message: 'Internal compiler error.', hint: 'Copy the diagnostic report.', details: 'NullPointerException\nat compiler.copy',
        locations: [{ uri: 'file:///private/models/counter.sctx', offset: 15, length: 3 }], cycle: [],
    }], rawCount: 1,
}

test('a report identifies the exact runtime, failed stage and stale source version without exporting models', () => {
    const { formatDiagnosticReport } = createLoader({ vscode: { Uri: URI } })('src/support-diagnostics.ts')
    const text = formatDiagnosticReport({ ...context, report, results: {
        files: [], totalMs: 123, generatedFiles: [{ content: 'SECRET MODEL' }],
        processors: [{ id: 'scg', status: 'error', durationMs: 50 }],
    } })
    assert.match(text, /Server SHA-256: server-hash/)
    assert.match(text, /document version 5/)
    assert.match(text, /stale \(source version 4\)/)
    assert.match(text, /NullPointerException\nat compiler.copy/)
    assert.match(text, /scg: error, 50 ms/)
    assert.match(text, /counter.sctx, offset 15/)
    assert.doesNotMatch(text, /SECRET MODEL|file:\/\/\/private/)
})

test('large compiler failures are bounded and missing reports explain how to collect one', () => {
    const { formatDiagnosticReport } = createLoader({ vscode: { Uri: URI } })('src/support-diagnostics.ts')
    const text = formatDiagnosticReport({ ...context, report: {
        ...report, issues: Array.from({ length: 70 }, () => ({ ...report.issues[0], details: 'x'.repeat(8000) + '\nCaused by: root failure' })),
    } })
    assert.match(text, /Technical details truncated/)
    assert.match(text, /Caused by: root failure/)
    assert.match(text, /20 more issues omitted/)
    assert.ok(text.length < 220000)
    assert.match(formatDiagnosticReport(context), /Reproduce the failure, then copy again/)
})

test('copying from a preview uses its explicit model and handles clipboard failure', async () => {
    let handler
    const copied = []
    const errors = []
    let live
    const uri = URI.parse(report.uri)
    const vscode = {
        Uri: URI, version: '1.104',
        workspace: { textDocuments: [{ uri, version: 5 }] },
        window: { activeTextEditor: { document: { languageId: 'sctx', uri: URI.parse('file:///other.sctx') } },
            setStatusBarMessage() {}, showErrorMessage: message => errors.push(message) },
        commands: { registerCommand: (_id, callback) => { handler = callback; return { dispose() {} } } },
        env: { clipboard: { writeText: async text => copied.push(text) } },
    }
    const { registerSupportDiagnostics } = createLoader({ vscode, fs: { promises: { readFile: async () => Buffer.from('server') } } })('src/support-diagnostics.ts')
    registerSupportDiagnostics({ subscriptions: [], extension: { packageJSON: { version: '0.9.6' } }, asAbsolutePath: value => value }, {
        diagnostics: { get: value => value === report.uri ? report : undefined },
        resultMap: new Map(), lastCompiledUri: 'file:///other.sctx', lastInvokedCompilation: 'other.system',
    }, { javaRuntime: { description: 'Java 21', source: 'bundled' } }, () => undefined, { get: () => live })
    await handler(uri)
    assert.match(copied[0], /Model: counter.sctx/)
    assert.match(copied[0], /compiler-internal/)
    assert.doesNotMatch(copied[0], /other.system/)
    live = { uri: report.uri, version: 5, issues: report.issues, durationMs: 23 }
    await handler(uri)
    assert.match(copied[1], /Live analysis: failed \(source version 5\)/)
    assert.match(copied[1], /Duration: 23 ms/)
    vscode.env.clipboard.writeText = async () => { throw new Error('clipboard unavailable') }
    await handler(uri)
    assert.match(errors[0], /Could not copy diagnostic report: clipboard unavailable/)
})

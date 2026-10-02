const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function setup() {
    const uri = URI.parse('file:///demo.sctx')
    const issue = { id: '1:0', locations: [{ uri: uri.toString(), offset: 0, length: 4, label: 'flag', traceUris: [uri + '#action'] }], cycle: [], snapshotIndex: 7 }
    const report = { id: 1, uri: uri.toString(), version: 1, status: 'failed', issues: [issue] }
    const document = { uri, version: 1 }
    const shown = [], sent = [], stages = [], executions = []
    const disposable = { dispose() {} }
    class TabInputText { constructor(uri) { this.uri = uri } }
    const window = {
        visibleTextEditors: [], tabGroups: { all: [] },
        createTextEditorDecorationType: () => disposable,
        showTextDocument: async (_, options) => {
            shown.push(options)
            return { setDecorations() {}, revealRange() {} }
        },
    }
    const workspace = { openTextDocument: async () => document }
    const vscode = { Uri: URI, TabInputText, window, ThemeColor: class {}, ViewColumn: { Beside: -2 },
        commands: { executeCommand: async (...args) => executions.push(args) },
        TextEditorRevealType: { InCenterIfOutsideViewport: 2 }, workspace }
    let currentReport = report
    const diagnostics = { get: () => currentReport, onDidChange: () => disposable, range: () => 'source-range' }
    const diagrams = { currentUri: uri, onDidChangeDiagram: () => disposable, onWebviewNotification: () => disposable,
        sendToDiagram: (type, payload) => sent.push({ method: type.method, payload }) }
    const { DiagnosticBridge } = createLoader({ vscode })('src/kico/diagnostic-bridge.ts')
    const bridge = new DiagnosticBridge(diagnostics, diagrams, async (...args) => stages.push(args))
    const command = kind => bridge.handle({ kind, build: 1, issue: '1:0', location: 0 })
    return { uri, document, report, window, workspace, shown, sent, stages, executions, TabInputText, command,
        replaceReport: value => { currentReport = value } }
}

test('source navigation reuses the visible editor instead of opening another group', async () => {
    const { document, window, shown, command } = setup()
    window.visibleTextEditors = [{ document, viewColumn: 1 }]
    await command('source')
    assert.equal(shown[0].viewColumn, 1)
    assert.equal(shown[0].selection, 'source-range')
})

test('source navigation finds an existing tab even when hidden behind another file', async () => {
    const { uri, window, shown, TabInputText, command } = setup()
    window.tabGroups.all = [{ viewColumn: 2, tabs: [{ input: new TabInputText(uri) }] }]
    await command('source')
    assert.equal(shown[0].viewColumn, 2)
})

test('diagram highlight restores the source model, while stage navigation clears the highlight', async () => {
    const { uri, command, stages, sent } = setup()
    await command('highlight')
    assert.deepEqual(stages, [[uri.toString(), -1]])
    assert.ok(sent.at(-1).payload.traceUris[0].length)
    await command('stage')
    assert.deepEqual(stages.at(-1), [uri.toString(), 7])
    assert.deepEqual(sent.at(-1).payload.traceUris, [])
})

test('stale reports cannot navigate or change the diagram', async () => {
    const { report, command, shown, stages, sent } = setup()
    report.status = 'stale'
    await command('highlight')
    await command('source')
    assert.deepEqual([shown, stages, sent], [[], [], []])
})

test('a report replaced while opening its source cannot move the editor to an obsolete location', async () => {
    const { document, report, workspace, command, shown, replaceReport } = setup()
    workspace.openTextDocument = async () => {
        replaceReport({ ...report, id: 2 })
        return document
    }
    await command('source')
    assert.deepEqual(shown, [])
})

test('cancelled reports cannot navigate source or stage', async () => {
    const { report, command, shown, stages, sent } = setup()
    report.status = 'cancelled'
    await command('source')
    await command('stage')
    await command('highlight')
    assert.deepEqual([shown, stages, sent], [[], [], []])
})

test('synthetic diagnostic stages cannot open an old compiler snapshot', async () => {
    const { report, command, stages, sent } = setup()
    report.issues[0].snapshotIndex = -1
    await command('stage')
    assert.deepEqual(stages, [])
    assert.deepEqual(sent, [])
})

test('copy diagnostics explicitly selects the preview model even when the report is stale', async () => {
    const { uri, report, command, executions } = setup()
    report.status = 'stale'
    await command('copy')
    assert.equal(executions[0][0], 'keith-vscode.copy-diagnostics')
    assert.equal(executions[0][1].toString(), uri.toString())
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function setup() {
    class EventEmitter {
        listeners = []
        event = callback => { this.listeners.push(callback); return { dispose() {} } }
        fire(value) { this.listeners.forEach(listener => listener(value)) }
        dispose() {}
    }
    const configChanges = new EventEmitter()
    const editorChanges = new EventEmitter()
    const documentChanges = new EventEmitter()
    const commands = {}
    const contexts = {}
    const status = { shown: false, show() { this.shown = true }, hide() { this.shown = false }, dispose() {} }
    const documents = []
    let provider
    const mock = {
        Uri: URI, EventEmitter,
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        CodeActionKind: { QuickFix: 'quickfix' },
        CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }) } },
        StatusBarAlignment: { Left: 1 },
        commands: {
            registerCommand: (id, handler) => { commands[id] = handler; return { dispose() {} } },
            executeCommand: async (id, key, value) => { if (id === 'setContext') contexts[key] = value },
        },
        languages: { registerCodeActionsProvider: (_, p) => { provider = p; return { dispose() {} } } },
        window: { createStatusBarItem: () => status, activeTextEditor: undefined, onDidChangeActiveTextEditor: editorChanges.event },
        workspace: {
            textDocuments: documents,
            onDidOpenTextDocument: () => ({ dispose() {} }),
            onDidCloseTextDocument: () => ({ dispose() {} }),
            onDidChangeTextDocument: documentChanges.event,
            onDidChangeConfiguration: configChanges.event,
        },
    }
    const { WarningToggle } = createLoader({ vscode: mock })('src/kico/warning-toggle.ts')
    const values = { 'diagnostics.showWarnings': true }
    const settings = {
        get: key => values[key],
        set: async (key, value) => { values[key] = value; configChanges.fire({ affectsConfiguration: section => section === `keith-vscode.${key}` }) },
    }
    const compilerChanges = new EventEmitter()
    const liveChanges = new EventEmitter()
    const reports = new Map()
    const liveResults = new Map()
    const compiler = { get: uri => reports.get(uri), onDidChange: compilerChanges.event }
    const live = { get: uri => liveResults.get(uri), onDidChange: liveChanges.event }
    const toggle = new WarningToggle(settings, compiler, live)
    const open = (path, version = 1) => {
        const document = { uri: URI.parse(`file:///${path}`), version }
        documents.push(document)
        mock.window.activeTextEditor = { document }
        editorChanges.fire(mock.window.activeTextEditor)
        return document
    }
    return { toggle, commands, contexts, status, provider, values, open, reports, liveResults, compilerChanges, liveChanges, documentChanges }
}

const diagnostic = (severity, source = 'KIELER · live') => ({ severity, source })

test('a warning squiggle offers to hide the warnings; the status bar counts them and brings them back', async () => {
    const { toggle, commands, contexts, status, provider, values, open, reports, liveResults, compilerChanges, liveChanges } = setup()
    assert.equal(contexts['keith.vscode:warningsHidden'], false)
    assert.equal(status.shown, false)
    // The lightbulb only appears on a KIELER warning, never on an error or on another extension's warning.
    assert.equal(provider.provideCodeActions({}, {}, { diagnostics: [diagnostic(0)] }).length, 0)
    assert.equal(provider.provideCodeActions({}, {}, { diagnostics: [diagnostic(1, 'eslint')] }).length, 0)
    const [action] = provider.provideCodeActions({}, {}, { diagnostics: [diagnostic(1)] })
    assert.equal(action.title, 'Hide KIELER warnings')
    assert.equal(action.command.command, 'keith-vscode.hide-warnings')

    const document = open('demo.sctx')
    const uri = document.uri.toString()
    liveResults.set(uri, { version: 1, issues: [{ severity: 'warning' }, { severity: 'warning' }, { severity: 'error' }] })
    liveChanges.fire()
    assert.equal(status.shown, false, 'nothing shows while warnings are visible')
    await commands['keith-vscode.hide-warnings']()
    assert.equal(values['diagnostics.showWarnings'], false)
    assert.equal(toggle.hidden, true)
    assert.equal(contexts['keith.vscode:warningsHidden'], true)
    assert.equal(status.shown, true)
    assert.equal(status.text, '$(eye-closed) 2 warnings hidden')
    assert.equal(status.command, 'keith-vscode.show-warnings')
    assert.equal(provider.provideCodeActions({}, {}, { diagnostics: [diagnostic(1)] }).length, 0, 'no quick fix while hidden')
    // A current compile report counts instead of the live result; a stale one does not.
    reports.set(uri, { version: 1, status: 'succeeded', issues: [{ severity: 'warning' }] })
    compilerChanges.fire()
    assert.equal(status.text, '$(eye-closed) 1 warning hidden')
    document.version = 2
    compilerChanges.fire()
    assert.equal(status.text, '$(eye-closed) Warnings hidden', 'An old live result must not inflate the count')
    await commands['keith-vscode.show-warnings']()
    assert.equal(values['diagnostics.showWarnings'], true)
    assert.equal(status.shown, false)
    assert.equal(contexts['keith.vscode:warningsHidden'], false)
})

test('the hidden warning count updates on an edit without a compiler change event', async () => {
    const { commands, status, open, liveResults, liveChanges, documentChanges } = setup()
    const document = open('demo.sctx')
    liveResults.set(document.uri.toString(), { version: 1, issues: [{ severity: 'warning' }] })
    liveChanges.fire()
    await commands['keith-vscode.hide-warnings']()
    assert.equal(status.text, '$(eye-closed) 1 warning hidden')
    document.version++
    documentChanges.fire({ document })
    assert.equal(status.text, '$(eye-closed) Warnings hidden')
})

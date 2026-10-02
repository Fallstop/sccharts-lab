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
    class Range {
        constructor(a, b, c, d) {
            this.start = typeof a === 'object' ? a : { line: a, character: b }
            this.end = typeof a === 'object' ? b : { line: c, character: d }
        }
        intersection() { return this }
    }
    const changes = new EventEmitter()
    const closes = new EventEmitter()
    const collections = {}
    const documents = []
    const mock = {
        Uri: URI, EventEmitter, Range,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }) } },
        DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }) } },
        Location: class { constructor(uri, range) { Object.assign(this, { uri, range }) } },
        CodeActionKind: { QuickFix: 'quickfix' },
        CodeAction: class { constructor(title) { this.title = title } },
        WorkspaceEdit: class {},
        languages: {
            createDiagnosticCollection: name => {
                const entries = new Map()
                collections[name] = entries
                return { set: (uri, value) => entries.set(uri.toString(), value), delete: uri => entries.delete(uri.toString()), clear: () => entries.clear(), dispose() {} }
            },
            registerCodeActionsProvider: () => ({ dispose() {} }),
        },
        workspace: {
            textDocuments: documents,
            openTextDocument: async uri => documents.find(doc => doc.uri.toString() === uri.toString()),
            onDidChangeTextDocument: changes.event,
            onDidDeleteFiles: () => ({ dispose() {} }),
            onDidCloseTextDocument: closes.event,
        },
    }
    const load = createLoader({ vscode: mock })
    const { CompilerDiagnostics } = load('src/kico/compiler-diagnostics.ts')
    const { LiveDiagnostics } = load('src/kico/live-diagnostics.ts')
    const sent = []
    const client = { sendNotification: async (method, params) => { sent.push({ method, params }) } }
    const compiler = new CompilerDiagnostics()
    const live = new LiveDiagnostics(client, compiler)
    function document(uri, text = 'scchart Demo {\n  int x\n}') {
        const doc = { uri: URI.parse(uri), version: 1, getText: () => text, lineCount: text.split('\n').length,
            positionAt: offset => ({ line: text.slice(0, offset).split('\n').length - 1, character: offset - text.lastIndexOf('\n', offset - 1) - 1 }),
            lineAt: line => ({ text: text.split('\n')[line] }), validateRange: range => range }
        documents.push(doc)
        return doc
    }
    const issue = (overrides = {}) => ({ code: 'scheduling-cycle', message: 'Circular dependency involving x prevents scheduling this tick.', severity: 'error', hint: 'Give x one owner.', locations: [{ uri: 'file:///demo.sctx', offset: 17, length: 5, label: 'int x', traceUris: [] }], cycle: [], ...overrides })
    return { live, compiler, document, issue, changes, closes, sent, collections }
}

test('live results show for the current version and are dropped for a version the editor left', () => {
    const { live, document, issue, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    assert.equal(live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 }), true)
    const shown = collections['kieler-live'].get(uri)
    assert.equal(shown.length, 1)
    assert.equal(shown[0].source, 'KIELER · live')
    assert.equal(shown[0].message, 'Circular dependency involving x prevents scheduling this tick.\nGive x one owner.')
    assert.deepEqual(shown[0].range.start, { line: 1, character: 2 })
    doc.version = 3
    assert.equal(live.accept({ uri, version: 2, issues: [issue()], durationMs: 300 }), false, 'A stale version is ignored')
    assert.equal(live.accept({ uri, version: 3, issues: [], durationMs: 200, reason: 'clean' }), true)
    assert.equal(collections['kieler-live'].has(uri), false, 'A clean result clears the squiggles')
})

test('editing clears live results immediately even when the model has never been compiled', () => {
    const { live, document, issue, changes, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 })
    let updates = 0
    live.onDidChange(() => updates++)
    doc.version++
    changes.fire({ document: doc })
    assert.equal(collections['kieler-live'].has(uri), false, 'No obsolete underline remains during debounce')
    assert.equal(live.get(uri), undefined, 'Status counts cannot use the old result')
    assert.equal(updates, 1)
    assert.equal(live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 }), false)
    assert.equal(collections['kieler-live'].has(uri), false, 'A delayed old result cannot restore it')
})

test('a current compile report takes precedence and live results return once it goes stale', async () => {
    const { live, compiler, document, issue, changes, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 })
    assert.equal(collections['kieler-live'].get(uri).length, 1)
    await compiler.begin(uri)
    assert.equal(collections['kieler-live'].has(uri), false, 'Compiling hides the live result')
    assert.equal(live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 }), false, 'Nothing resurrects while the compile is current')
    compiler.finish(uri, [[{ name: 'Scheduler', index: 0, errors: [], diagnostics: [issue()] }]], false)
    assert.equal(collections['kieler-compiler'].get(uri).length, 1)
    assert.equal(collections['kieler-live'].has(uri), false, 'The finished report still wins')
    doc.version = 2
    changes.fire({ document: doc })
    assert.equal(collections['kieler-compiler'].has(uri), false)
    assert.equal(collections['kieler-live'].has(uri), false, 'The old live result belongs to version 1 and stays hidden')
    assert.equal(live.accept({ uri, version: 2, issues: [issue()], durationMs: 250 }), true, 'The next live result for the edited version shows')
    assert.equal(collections['kieler-live'].get(uri).length, 1)
})

test('configuration reaches the server and disabling clears everything', async () => {
    const { live, document, issue, sent, collections, closes } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 })
    await live.configure({ enabled: true, debounceMs: 250.6 })
    assert.deepEqual(sent.at(-1), { method: 'keith/diagnostics/configure', params: { enabled: true, debounceMs: 251 } })
    await live.configure({ enabled: false, debounceMs: 250 })
    assert.equal(collections['kieler-live'].has(uri), false)
    assert.equal(live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 }), false, 'Ignored while disabled')
    await live.configure({ enabled: true, debounceMs: 400 })
    live.accept({ uri, version: 1, issues: [issue()], durationMs: 300 })
    closes.fire(doc)
    assert.equal(collections['kieler-live'].has(uri), false, 'Closing the document clears its live squiggles')
})

test('a server restart forgets held live results before resetting compiler precedence', async () => {
    const { live, compiler, document, issue, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    live.accept({ uri, version: 1, issues: [issue()], durationMs: 20 })
    await compiler.begin(uri)
    assert.equal(collections['kieler-live'].has(uri), false)
    live.reset()
    compiler.reset()
    assert.equal(live.get(uri), undefined)
    assert.equal(collections['kieler-live'].size, 0, 'Old server results cannot reappear after compiler reset')
})

test('loop warnings explained by a live cycle error are folded into it', () => {
    const { live, document, issue, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    const loop = issue({ code: 'instantaneous-loop', severity: 'warning', message: 'Potential instantaneous loop through x.' })
    live.accept({ uri, version: 1, issues: [loop, issue()], durationMs: 300 })
    assert.deepEqual(collections['kieler-live'].get(uri).map(d => d.code), ['scheduling-cycle'])
})

test('warning squiggles can be switched off for compile and live results alike; errors stay', async () => {
    const { live, compiler, document, issue, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    const warning = issue({ code: 'unused-variable', message: 'x is never read.', severity: 'warning' })
    live.accept({ uri, version: 1, issues: [issue(), warning], durationMs: 300 })
    assert.equal(collections['kieler-live'].get(uri).length, 2)
    compiler.setShowWarnings(false)
    assert.deepEqual(collections['kieler-live'].get(uri).map((d) => d.severity), [0], 'only the error remains live')
    // A compile report published while warnings are off omits them too, and gets them back when they return.
    await compiler.begin(uri)
    compiler.finish(uri, [[{ name: 'Compiler', index: 0, errors: [], diagnostics: [
        { code: 'c-compiler', message: 'Compiler failed', severity: 'error', locations: [], cycle: [] },
        { code: 'unused-variable', message: 'x is never read.', severity: 'warning', locations: [], cycle: [] },
    ] }]], false)
    assert.deepEqual(collections['kieler-compiler'].get(uri).map((d) => d.severity), [0])
    assert.equal(compiler.get(uri).issues.length, 2, 'the report itself keeps the warning')
    compiler.setShowWarnings(true)
    assert.deepEqual(collections['kieler-compiler'].get(uri).map((d) => d.severity).sort(), [0, 1])
})

test('information keeps its severity and stays visible when warnings are hidden', () => {
    const { live, compiler, document, issue, collections } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    compiler.setShowWarnings(false)
    live.accept({ uri, version: 1, issues: [
        issue({ code: 'note', severity: 'info', message: 'A helpful note.' }),
        issue({ code: 'warning', severity: 'warning', message: 'A warning.' }),
    ], durationMs: 30 })
    assert.deepEqual(collections['kieler-live'].get(uri).map(d => d.severity), [2])
})

test('live diagnostics for a shared generated file survive editing another owner', () => {
    const { live, document, issue, changes, collections } = setup()
    const a = document('file:///a.sctx')
    const b = document('file:///b.sctx')
    const location = { uri: 'file:///shared.c', line: 0, column: 0, offset: 0, length: 1, label: 'Generated' }
    for (const doc of [a, b]) live.accept({ uri: doc.uri.toString(), version: 1, issues: [issue({ message: doc.uri.path, locations: [location] })], durationMs: 10 })
    assert.equal(collections['kieler-live'].get(location.uri).length, 2)
    a.version++
    changes.fire({ document: a })
    assert.deepEqual(collections['kieler-live'].get(location.uri).map(d => d.message), ['/b.sctx\nGive x one owner.'])
})

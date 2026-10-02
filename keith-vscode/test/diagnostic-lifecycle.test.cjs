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
    const deletes = new EventEmitter()
    const entries = new Map()
    const documents = []
    let actions
    const mock = {
        Uri: URI, EventEmitter, Range,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }) } },
        DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }) } },
        Location: class { constructor(uri, range) { Object.assign(this, { uri, range }) } },
        CodeActionKind: { QuickFix: 'quickfix' },
        CodeAction: class { constructor(title) { this.title = title } },
        WorkspaceEdit: class { replace(uri, range, text) { Object.assign(this, { uri, range, text }) } },
        languages: {
            createDiagnosticCollection: () => ({ set: (uri, value) => entries.set(uri.toString(), value), delete: uri => entries.delete(uri.toString()), clear: () => entries.clear(), dispose() {} }),
            registerCodeActionsProvider: (_, provider) => { actions = provider; return { dispose() {} } },
        },
        workspace: {
            textDocuments: documents,
            openTextDocument: async uri => documents.find(doc => doc.uri.toString() === uri.toString()),
            onDidChangeTextDocument: changes.event,
            onDidCloseTextDocument: closes.event,
            onDidDeleteFiles: deletes.event,
        },
    }
    const { CompilerDiagnostics } = createLoader({ vscode: mock })('src/kico/compiler-diagnostics.ts')
    const diagnostics = new CompilerDiagnostics()
    function document(uri, text = 'scchart Demo {}') {
        const doc = { uri: URI.parse(uri), version: 1, getText: () => text, lineCount: text.split('\n').length,
            positionAt: offset => ({ line: text.slice(0, offset).split('\n').length - 1, character: offset - text.lastIndexOf('\n', offset - 1) - 1 }),
            lineAt: line => ({ text: text.split('\n')[line] }), validateRange: range => range }
        documents.push(doc)
        return doc
    }
    const stage = (locations = [], overrides = {}) => [[{ name: 'Compiler', index: 0, errors: ['raw error'], diagnostics: [{ code: 'c-compiler', message: 'Compiler failed', severity: 'error', locations, cycle: [], ...overrides }] }]]
    return { diagnostics, changes, closes, deletes, entries, document, stage, actions }
}

test('identical warning and error messages retain the error and distinct diagnostic codes', async () => {
    const { diagnostics, document, entries } = setup()
    const uri = document('file:///demo.sctx').uri.toString()
    const issue = { code: 'first', severity: 'warning', message: 'Cannot process this model.', locations: [], cycle: [] }
    await diagnostics.begin(uri)
    const report = diagnostics.finish(uri, [[
        { name: 'Early analyzer', index: 0, diagnostics: [issue, issue] },
        { name: 'Compiler', index: 1, diagnostics: [{ ...issue, severity: 'error' }, { ...issue, code: 'second' }] },
    ]], false)
    assert.equal(report.status, 'failed', 'Deduplication must never turn a failing compile into success')
    assert.equal(report.issues.length, 3)
    assert.deepEqual(entries.get(uri).map(issue => issue.severity), [1, 0, 1])
})

test('empty structured diagnostics cannot hide a stage failure', async () => {
    const { diagnostics, document, entries } = setup()
    const uri = document('file:///demo.sctx').uri.toString()
    await diagnostics.begin(uri)
    const report = diagnostics.finish(uri, [[{ name: 'Compiler', index: 0, diagnostics: [], errors: ['Raw failure\nstack details'] }]], false)
    assert.equal(report.status, 'failed')
    assert.equal(report.issues[0].details, 'Raw failure\nstack details')
    assert.equal(entries.get(uri)[0].message, 'Raw failure')
})

test('synthetic validation failures have no compiler snapshot to navigate to', async () => {
    const { diagnostics, document } = setup()
    const uri = document('file:///demo.sctx').uri.toString()
    await diagnostics.begin(uri)
    const report = diagnostics.finish(uri, [[{
        name: 'Source Validation', index: 0, processorId: 'source-validation',
        errors: ['Missing initial state'],
        diagnostics: [{ code: 'source-validation', severity: 'error', message: 'Missing initial state', locations: [], cycle: [] }],
    }]], false)
    assert.equal(report.issues[0].snapshotIndex, -1, 'Stage 0 from an older build must never be used')
})

test('edits invalidate diagnostics and late build results cannot restore stale errors', async () => {
    const { diagnostics, changes, entries, document, stage } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage(), false)
    assert.equal(entries.get(uri).length, 1)
    doc.version++
    changes.fire({ document: doc })
    assert.equal(diagnostics.get(uri).status, 'stale')
    assert.equal(entries.size, 0)
    diagnostics.finish(uri, stage(), false)
    assert.equal(entries.size, 0)
    await diagnostics.begin(uri)
    doc.version++
    changes.fire({ document: doc })
    diagnostics.finish(uri, stage(), false)
    assert.equal(diagnostics.get(uri).status, 'stale')
    assert.equal(entries.size, 0)
})

test('closing and reopening with a reused version cannot make an obsolete report current', async () => {
    const { diagnostics, closes, entries, document, stage, actions } = setup()
    const old = document('file:///demo.sctx', 'scchart Old {}')
    const uri = old.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage([], { code: 'internal-compiler-error', details: 'Retained technical details' }), false)
    closes.fire(old)
    const reopened = document(uri, 'scchart Changed {}')
    assert.equal(reopened.version, diagnostics.get(uri).version, 'VS Code can reuse version 1 after reopening')
    assert.equal(diagnostics.get(uri).status, 'stale')
    assert.equal(diagnostics.get(uri).issues[0].details, 'Retained technical details')
    assert.equal(entries.size, 0)
    assert.deepEqual(actions.provideCodeActions(reopened, {}), [])
})

test('rebuild, cancellation, deletion and restart clear owned errors without affecting another model', async () => {
    const { diagnostics, deletes, entries, document, stage } = setup()
    const a = document('file:///a.sctx').uri.toString()
    const b = document('file:///b.sctx').uri.toString()
    await diagnostics.begin(a)
    diagnostics.finish(a, stage([{ uri: 'file:///generated.c', line: 2, column: 3, offset: 0, length: 1, label: 'Generated code' }]), false)
    await diagnostics.begin(b)
    diagnostics.finish(b, stage(), false)
    assert.equal(entries.size, 2)
    await diagnostics.begin(a)
    assert.deepEqual([...entries.keys()], [b])
    diagnostics.cancel(a)
    diagnostics.finish(a, stage(), false)
    assert.equal(diagnostics.get(a).status, 'cancelled')
    assert.deepEqual([...entries.keys()], [b])
    deletes.fire({ files: [URI.parse(b)] })
    assert.equal(entries.size, 0)
    assert.equal(diagnostics.get(b), undefined)
    diagnostics.reset()
    assert.equal(diagnostics.get(a), undefined)
})

test('shared generated-file diagnostics retain each model owner when another model rebuilds', async () => {
    const { diagnostics, entries, document, stage } = setup()
    const a = document('file:///a.sctx').uri.toString()
    const b = document('file:///b.sctx').uri.toString()
    const location = { uri: 'file:///shared.c', line: 0, column: 0, offset: 0, length: 1, label: 'Generated code' }
    await diagnostics.begin(a)
    diagnostics.finish(a, stage([location], { message: 'Failure from a' }), false)
    await diagnostics.begin(b)
    diagnostics.finish(b, stage([location], { message: 'Failure from b' }), false)
    assert.deepEqual(entries.get(location.uri).map(issue => issue.message), ['Failure from a', 'Failure from b'])
    await diagnostics.begin(a)
    assert.deepEqual(entries.get(location.uri).map(issue => issue.message), ['Failure from b'])
    diagnostics.cancel(a)
    assert.deepEqual(entries.get(location.uri).map(issue => issue.message), ['Failure from b'])
})

test('internal compiler errors offer a report-copy action bound to the source model', async () => {
    const { diagnostics, document, stage, actions, entries } = setup()
    const doc = document('file:///demo.sctx')
    const uri = doc.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage([], { code: 'internal-compiler-error' }), false)
    const [action] = actions.provideCodeActions(doc, entries.get(uri)[0].range)
    assert.equal(action.command.command, 'keith-vscode.copy-diagnostics')
    assert.equal(action.command.arguments[0], doc.uri)
})

test('mapped array errors keep generated related information and a version-bound quick fix', async () => {
    const { diagnostics, changes, entries, document, stage, actions } = setup()
    const text = 'scchart Demo {\n int a[2]\n int b[2]\n initial state A\n entry do a = b\n}'
    const doc = document('file:///demo.sctx', text)
    const uri = doc.uri.toString()
    await diagnostics.begin(uri)
    diagnostics.finish(uri, stage([{ uri: 'file:///generated.c', line: 10, column: 7, offset: 0, length: 1, generatedLine: 'd->a = d->b;', label: 'Array assignment' }], { message: "array type 'int[2]' is not assignable" }), false)
    const problem = entries.get(uri)[0]
    assert.equal(problem.relatedInformation[0].location.uri.toString(), 'file:///generated.c')
    const fix = actions.provideCodeActions(doc, problem.range)
    assert.match(fix[0].edit.text, /a\[0\] = b\[0\];\n a\[1\] = b\[1\]/)
    doc.version++
    changes.fire({ document: doc })
    assert.deepEqual(actions.provideCodeActions(doc, problem.range), [])
})

test('loop warnings explained by a scheduler cycle are dropped; standalone ones keep their source', async () => {
    const { diagnostics, document } = setup()
    const doc = document('file:///demo.sctx', 'scchart Demo { int x\n }')
    const uri = doc.uri.toString()
    const at = (offset, label) => ({ uri, offset, length: 3, label })
    // The analyzer names the symbols itself now; the client shows its message as sent.
    const loop = (locations) => ({ code: 'instantaneous-loop', message: 'Potential instantaneous loop through x.', severity: 'warning', hint: 'Make one transition delayed.', locations, cycle: [] })
    const cycle = { code: 'scheduling-cycle', message: 'Circular dependency prevents scheduling this tick.', severity: 'error', locations: [at(15, 'x = 1'), at(19, 'x = 2')], cycle: [] }
    await diagnostics.begin(uri)
    let report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 1'), at(19, 'x = 2')])] },
        { name: 'Basic Blocks', index: 1, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 1'), at(19, 'x = 2')])] },
        { name: 'Scheduler', index: 2, errors: ['The SCG is NOT asc-schedulable!'], diagnostics: [cycle] },
    ]], false)
    assert.deepEqual(report.issues.map(issue => issue.code), ['scheduling-cycle'])
    assert.equal(report.status, 'failed')

    await diagnostics.begin(uri)
    report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 0')])] },
        { name: 'Basic Blocks', index: 1, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([at(15, 'x = 0')])] },
    ]], false)
    assert.equal(report.status, 'succeeded')
    assert.equal(report.issues.length, 1, 'Both analyzer runs describe the same loop')
    assert.equal(report.issues[0].message, 'Potential instantaneous loop through x.')
    assert.equal(report.issues[0].hint, 'Make one transition delayed.')
    assert.equal(report.issues[0].severity, 'warning')

    await diagnostics.begin(uri)
    report = diagnostics.finish(uri, [[
        { name: 'Dependency', index: 0, warnings: ['Instantaneous loop detected!'], diagnostics: [loop([])] },
        { name: 'Scheduler', index: 1, errors: ['The SCG is NOT asc-schedulable!'], diagnostics: [cycle] },
    ]], false)
    assert.deepEqual(report.issues.map(issue => issue.code), ['scheduling-cycle'], 'An unlocated loop warning adds nothing to a cycle error')
})

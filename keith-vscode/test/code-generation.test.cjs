const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI, Utils } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function emitter() {
    const listeners = new Set()
    return {
        event: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) } },
        fire: value => [...listeners].forEach(callback => callback(value)),
        get size() { return listeners.size },
    }
}

function generation() {
    const completed = emitter()
    const cancelled = emitter()
    const document = { uri: URI.file('/models/demo.sctx'), version: 1, isDirty: false }
    const token = { isCancellationRequested: false, onCancellationRequested: cancelled.event }
    const report = { status: 'compiling', issues: [] }
    const compiler = {
        compiling: false, resultMap: new Map(), diagnostics: { get: () => report },
        compilationFinished: completed.event,
        async compile(command, inplace, show, snapshot, uri) {
            this.compiling = true
            this.lastCompiledUri = uri
            this.invocation = { command, inplace, show, snapshot, uri }
        },
        async requestCancelCompilation() { this.cancelled = true; completed.fire(false) },
    }
    const { generateModel } = createLoader({ vscode: {} })('src/kico/generate-model.ts')
    const run = (target = 'c', timeout) => generateModel(compiler, document, target, token, timeout)
    const finish = (result = { generatedFiles: [{ fileName: 'Demo.c', code: 'generated' }] }, status = 'succeeded') => {
        compiler.resultMap.set(document.uri.toString(), result)
        report.status = status
        compiler.compiling = false
        completed.fire(status === 'succeeded')
    }
    return { completed, cancelled, document, token, report, compiler, run, finish }
}

test('generation uses the requested model and target and captures the matching completed result', async () => {
    const s = generation()
    const pending = s.run('java')
    assert.deepEqual(s.compiler.invocation, {
        command: 'de.cau.cs.kieler.sccharts.netlist.java', inplace: false, show: false, snapshot: false, uri: s.document.uri.toString(),
    })
    s.finish({ generatedFiles: [{ fileName: 'Demo.java', code: 'public class Demo {}' }] })
    s.compiler.resultMap.clear()
    assert.equal((await pending)[0].fileName, 'Demo.java')
    assert.equal(s.completed.size, 0)
    assert.equal(s.cancelled.size, 0)
})

test('edits, failed builds, host incompatibility and unsupported servers never expose old output', async () => {
    for (const scenario of ['edited', 'failed', 'host', 'unsupported', 'restart']) {
        const s = generation()
        const pending = s.run()
        if (scenario === 'edited') s.document.version++
        if (scenario === 'restart') s.compiler.lastCompiledUri = ''
        s.report.issues = [{ severity: 'error', message: 'Scheduler rejected this model' }]
        s.finish(scenario === 'unsupported' ? {} : scenario === 'host' ? { generationError: 'C-only host implementation' } : undefined,
            scenario === 'failed' ? 'failed' : 'succeeded')
        await assert.rejects(pending, {
            edited: /model changed/, failed: /Scheduler rejected/, host: /C-only/, unsupported: /bundled SCCharts Lab server/, restart: /restarted/,
        }[scenario])
    }
})

test('dirty sources and concurrent compilations are refused before sending work', async () => {
    const s = generation()
    s.document.isDirty = true
    await assert.rejects(s.run(), /Save it/)
    s.document.isDirty = false
    s.compiler.compiling = true
    await assert.rejects(s.run(), /already in progress/)
    assert.equal(s.compiler.invocation, undefined)
})

test('cancellation during startup waits until compilation was sent, then discards all output', async () => {
    const s = generation()
    let started
    s.compiler.compile = async function (_, __, ___, ____, uri) {
        this.lastCompiledUri = uri
        await new Promise(resolve => { started = resolve })
    }
    const pending = s.run()
    s.token.isCancellationRequested = true
    s.cancelled.fire()
    assert.equal(s.compiler.cancelled, undefined)
    started()
    assert.deepEqual(await pending, [])
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(s.compiler.cancelled, true)
    assert.equal(s.completed.size, 0)
})

test('a generation timeout during server startup still cancels when its request eventually dispatches', async () => {
    const s = generation()
    let started
    s.compiler.compile = async function (_, __, ___, ____, uri) {
        this.lastCompiledUri = uri
        await new Promise(resolve => { started = resolve })
    }
    await assert.rejects(s.run('c', 10), /timed out/)
    assert.equal(s.compiler.cancelled, undefined)
    started()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(s.compiler.cancelled, true)
    assert.equal(s.completed.size, 0)
    assert.equal(s.cancelled.size, 0)
})

test('cancelled generation returns promptly even when server cancellation is never acknowledged', async () => {
    const s = generation()
    s.compiler.requestCancelCompilation = async () => { s.compiler.cancelled = true }
    const pending = s.run()
    await Promise.resolve()
    s.token.isCancellationRequested = true
    s.cancelled.fire()
    assert.deepEqual(await pending, [])
    assert.equal(s.compiler.cancelled, true)
    assert.equal(s.completed.size, 0)
})

test('timeouts cancel the server operation and remove listeners', async () => {
    const s = generation()
    await assert.rejects(s.run('c', 10), /timed out/)
    assert.equal(s.compiler.cancelled, true)
    assert.equal(s.completed.size, 0)
    assert.equal(s.cancelled.size, 0)
})

function previews() {
    const closed = emitter()
    const commands = new Map()
    const writes = []
    const messages = []
    const executed = []
    const existing = new Map()
    class FileSystemError extends Error {
        constructor(code) { super(code); this.code = code }
    }
    let provider
    const vscode = {
        Uri: { from: URI.from, parse: URI.parse, file: URI.file, joinPath: Utils.joinPath },
        FileSystemError, FileType: { File: 1, Directory: 2 },
        workspace: {
            textDocuments: [],
            registerTextDocumentContentProvider: (scheme, value) => { provider = value; return { dispose() {} } },
            onDidCloseTextDocument: closed.event,
            async openTextDocument(uri) {
                const present = this.textDocuments.find(d => d.uri.toString() === uri.toString())
                if (present) return present
                const content = provider.provideTextDocumentContent(uri)
                const doc = { uri, getText: () => content }
                this.textDocuments.push(doc)
                return doc
            },
            fs: {
                async stat(uri) { if (existing.has(uri.toString())) return existing.get(uri.toString()); throw new FileSystemError('FileNotFound') },
                async createDirectory() {},
                async writeFile(uri, bytes) { writes.push({ uri, text: new TextDecoder().decode(bytes) }) },
            },
        },
        languages: {
            // VS Code emits close/open when changing a document's language.
            async setTextDocumentLanguage(document, languageId) {
                closed.fire(document)
                document.isClosed = true
                const replacement = { ...document, languageId, isClosed: false }
                const index = vscode.workspace.textDocuments.indexOf(document)
                vscode.workspace.textDocuments.splice(index, 1, replacement)
                return replacement
            },
        },
        window: {
            async showTextDocument(document) {
                assert.ok(!document.isClosed, 'Cannot show a closed document')
                this.activeTextEditor = { document: document.uri ? document : await vscode.workspace.openTextDocument(document) }
            },
            async showOpenDialog() { return [URI.file('/exports')] },
            async showWarningMessage() { return 'Replace' },
            async showInformationMessage(message) { messages.push(message) },
            async showErrorMessage(message) { messages.push(message) },
        },
        commands: {
            registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} } },
            async executeCommand(id) { executed.push(id) },
        },
    }
    const module = createLoader({ vscode })('src/kico/generated-code-documents.ts')
    const documents = new module.GeneratedCodeDocuments()
    return { ...module, documents, vscode, commands, writes, messages, existing, executed, closed }
}

const files = [{ fileName: 'Demo.c', code: 'source' }, { fileName: 'Demo.h', code: 'header' }]

test('previews write nothing, retain language-change content and keep separate generations', async () => {
    const s = previews()
    const source = URI.file('/models/demo.sctx')
    await s.documents.open(source, 'c', files)
    const first = s.vscode.workspace.textDocuments[0]
    assert.equal(first.languageId, 'c')
    assert.equal(s.documents.provideTextDocumentContent(first.uri), 'source')
    assert.equal(s.vscode.window.activeTextEditor.document.uri.toString(), first.uri.toString())
    await s.documents.open(source, 'c', [{ fileName: 'Demo.c', code: 'new source' }])
    assert.equal(s.documents.provideTextDocumentContent(first.uri), 'source')
    assert.equal(s.vscode.workspace.textDocuments.length, 3)
    assert.deepEqual(s.writes, [])
    first.isClosed = true
    s.closed.fire(first)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.throws(() => s.documents.provideTextDocumentContent(first.uri), /expired/)
})

test('Save As uses the native command and Save All includes closed companion files', async () => {
    const s = previews()
    await s.documents.open(URI.file('/models/demo.sctx'), 'c', files)
    await s.commands.get(s.SAVE_GENERATED)()
    assert.deepEqual(s.executed, ['workbench.action.files.saveAs'])
    s.closed.fire(s.vscode.workspace.textDocuments[1])
    await s.commands.get(s.SAVE_ALL_GENERATED)()
    assert.deepEqual(s.writes.map(entry => [entry.uri.path, entry.text]), [['/exports/Demo.c', 'source'], ['/exports/Demo.h', 'header']])
})

test('Save All respects folder/overwrite cancellation and refuses unsaved edits', async () => {
    for (const scenario of ['folder', 'overwrite', 'dirty']) {
        const s = previews()
        await s.documents.open(URI.file('/models/demo.sctx'), 'c', files)
        if (scenario === 'folder') s.vscode.window.showOpenDialog = async () => undefined
        if (scenario === 'overwrite') {
            s.existing.set(URI.file('/exports/Demo.c').toString(), { type: 1 })
            s.vscode.window.showWarningMessage = async () => undefined
        }
        if (scenario === 'dirty') s.vscode.workspace.textDocuments.push({ uri: URI.file('/exports/Demo.c'), isDirty: true })
        await s.commands.get(s.SAVE_ALL_GENERATED)()
        assert.deepEqual(s.writes, [])
        if (scenario === 'dirty') assert.match(s.messages[0], /Save or close your edits/)
    }
})

test('save failures identify partial exports and keep the preview available', async () => {
    const s = previews()
    await s.documents.open(URI.file('/models/demo.sctx'), 'c', files)
    const write = s.vscode.workspace.fs.writeFile
    s.vscode.workspace.fs.writeFile = async (uri, bytes) => {
        if (uri.path.endsWith('.h')) throw new Error('Permission denied')
        await write(uri, bytes)
    }
    await s.commands.get(s.SAVE_ALL_GENERATED)()
    assert.match(s.messages[0], /1 already saved.*Permission denied/)
    assert.equal(s.documents.provideTextDocumentContent(s.vscode.workspace.textDocuments[0].uri), 'source')
})

test('unsafe and colliding generated paths are rejected before opening or exporting', async () => {
    const s = previews()
    for (const fileName of ['../escape.c', '/absolute.c', 'C:\\model.c', 'dir/../model.c', '', 'a//b.c']) {
        await assert.rejects(s.documents.open(URI.file('/model.sctx'), 'c', [{ fileName, code: 'bad' }]), /invalid generated filename/)
    }
    assert.throws(() => s.validateGeneratedFiles([{ fileName: 'a.c', code: '' }, { fileName: 'A.c', code: '' }]), /duplicate/)
    assert.equal(s.vscode.workspace.textDocuments.length, 0)
    assert.equal(s.writes.length, 0)
})

test('the command saves its source, generates targets in order and retains C when Java fails', async () => {
    const source = { uri: URI.file('/model.sctx'), version: 1, isDirty: true }
    const calls = []
    const opened = []
    const compiler = {
        compiling: false,
        generatingCode: false,
        documents: {
            async open(uri, target, result) {
                opened.push({ uri, target, result })
                vscode.window.activeTextEditor = { document: { uri: URI.parse('sccharts-generated:/Demo.c') } }
            },
            dispose() {},
        },
    }
    const messages = []
    let command
    source.save = async () => {
        assert.equal(compiler.generatingCode, true, 'Auto-compilation is suspended while saving')
        source.isDirty = false
        source.version++
        return true
    }
    const vscode = {
        ProgressLocation: { Notification: 15 },
        workspace: { openTextDocument: async () => source },
        window: {
            activeTextEditor: { document: source },
            showQuickPick: async () => ({ targets: ['c', 'java'] }),
            withProgress: async (_, work) => work({ report() {} }, { isCancellationRequested: false }),
            showErrorMessage: async message => { messages.push(message) },
            showInformationMessage: async message => { messages.push(message) },
        },
        commands: { registerCommand: (_, callback) => { command = callback; return { dispose() {} } } },
    }
    const { registerCodeGeneration } = createLoader({
        vscode,
        './generate-model': {
            async generateModel(receivedCompiler, document, target) {
                assert.equal(receivedCompiler, compiler)
                assert.equal(document, source)
                assert.equal(source.isDirty, false)
                calls.push(target)
                if (target === 'java') throw new Error('C-only host code')
                return files
            },
        },
    })('src/kico/code-generation.ts')
    registerCodeGeneration({ subscriptions: [] }, compiler)
    await command()
    assert.deepEqual(calls, ['c', 'java'])
    assert.equal(opened.length, 1)
    assert.equal(opened[0].uri.toString(), source.uri.toString())
    assert.deepEqual(messages, ['Opened 2 generated files. Java: C-only host code'])
    assert.equal(compiler.generatingCode, false)
})

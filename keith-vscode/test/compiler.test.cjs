const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function setup() {
    const messages = []
    const vscode = {
        TreeItem: class {}, TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class {},
        commands: { getCommands: async () => ['keith-vscode.show-next'] },
        Uri: URI,
        window: { showErrorMessage: async (message) => { messages.push(message) }, showInformationMessage: async () => undefined },
        workspace: { openTextDocument: async (uri) => ({ uri, isDirty: false }) },
    }
    const load = createLoader({ vscode })
    const { CompilationDataProvider } = load('src/kico/compilation-data-provider.ts')
    const compiler = Object.create(CompilationDataProvider.prototype)
    const finished = []
    for (const map of ['isCompiled', 'sourceURI', 'resultMap', 'lengthMap', 'indexMap', 'shownStage', 'pendingResults']) compiler[map] = new Map()
    compiler.compilationFinishedEmitter = { fire: (success) => finished.push(success) }
    compiler.compilationStartedEmitter = { fire() {} }
    compiler.stageChangedEmitter = { fire() {} }
    compiler.compilation = { show() {}, hide() {} }
    compiler.requestSystems = { hide() {} }
    compiler.output = { appendLine() {} }
    compiler.startTime = Date.now()
    compiler.generation = 0
    compiler.showQueue = Promise.resolve()
    return { compiler, finished, vscode, messages }
}

test('compilation progress can exceed the server estimate without crashing or marking success as failure', async () => {
    const { compiler, finished } = setup()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', false, 46, 43)
    assert.ok(compiler.compilation.text.length < 100)
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 46, 43)
    assert.deepEqual(finished, [true])
    assert.match(compiler.compilation.tooltip, /^Compiled in \d+ ms$/)
})

test('cancelled compilations never start a simulation', async () => {
    const { compiler, finished } = setup()
    compiler.cancellingCompilation = true
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 43, 43)
    assert.deepEqual(finished, [false])
})

test('an unloadable source produces a failed build instead of crashing on null results', async () => {
    const { compiler, finished } = setup()
    compiler.compiling = true
    await compiler.handleNewSnapshotDescriptions(null, 'file:///invalid.sctx', true, 0, 1000)
    assert.deepEqual(finished, [false])
    assert.equal(compiler.compiling, false)
    assert.match(compiler.resultMap.get('file:///invalid.sctx').files[0][0].errors[0], /model could not be loaded/)
})

test('cancellation transport failures reach the caller instead of escaping as unhandled rejections', async () => {
    const { compiler, finished } = setup()
    compiler.lsClient = { start: async () => {}, sendNotification: async () => { throw new Error('Server disconnected') } }
    compiler.compiling = true
    await assert.rejects(compiler.requestCancelCompilation(), /Server disconnected/)
    assert.deepEqual(finished, [])
    assert.equal(compiler.cancellingCompilation, false)
})

test('cancellation completes once after server confirmation, never on dispatch', async () => {
    const { compiler, finished } = setup()
    compiler.lsClient = { start: async () => {}, sendNotification: async () => {} }
    compiler.compiling = true
    compiler.lastCompiledUri = 'file:///model.sctx'
    await compiler.requestCancelCompilation()
    assert.deepEqual(finished, [])
    assert.equal(compiler.compiling, true)
    await compiler.handleNewSnapshotDescriptions({ files: [] }, compiler.lastCompiledUri, true, 3, 3)
    await compiler.cancelCompilation(true)
    assert.deepEqual(finished, [false])
    assert.match(compiler.compilation.tooltip, /Compilation stopped/)
})

test('a cancellation acknowledgement without a final snapshot still completes and clears pending output', async () => {
    const { compiler, finished } = setup()
    compiler.lastCompiledUri = 'file:///model.sctx'
    compiler.compiling = true
    compiler.cancellingCompilation = true
    compiler.pendingResults.set(compiler.lastCompiledUri, true)
    await compiler.cancelCompilation(true)
    assert.equal(compiler.compiling, false)
    assert.equal(compiler.pendingResults.size, 0)
    assert.deepEqual(finished, [false])
})

test('a delayed cancellation acknowledgement cannot cancel the next compilation', async () => {
    const { compiler, finished } = setup()
    compiler.lsClient = { start: async () => {}, sendNotification: async () => {} }
    compiler.compiling = true
    compiler.lastCompiledUri = 'file:///old.sctx'
    await compiler.requestCancelCompilation()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, compiler.lastCompiledUri, true, 3, 3)
    await compiler.compile('new.system', false, false, false, 'file:///new.sctx')
    await compiler.cancelCompilation(true)
    assert.equal(compiler.compiling, true)
    assert.equal(compiler.lastCompiledUri, 'file:///new.sctx')
    assert.deepEqual(finished, [false])
})

test('a cancellation waiting for startup cannot cancel a later build', async () => {
    const { compiler } = setup()
    let ready
    let cancellations = 0
    compiler.compiling = true
    compiler.lsClient = { start: () => new Promise((resolve) => { ready = resolve }), sendNotification: async () => { cancellations++ } }
    const request = compiler.requestCancelCompilation()
    compiler.generation++
    ready()
    await request
    assert.equal(cancellations, 0)
    assert.equal(compiler.cancellingCompilation, undefined)
})

test('stale builds never open generated code or announce successful compilation', async () => {
    const { compiler, finished } = setup()
    const uri = 'file:///model.sctx'
    compiler.pendingResults.set(uri, true)
    compiler.diagnostics = { finish: () => ({ status: 'stale', issues: [] }) }
    compiler.documents = { open: async () => assert.fail('Stale generated code must stay hidden') }
    await compiler.handleNewSnapshotDescriptions({ files: [], generatedFiles: [{ fileName: 'Old.c', code: 'old' }] }, uri, true, 3, 3)
    assert.deepEqual(finished, [false])
    assert.equal(compiler.pendingResults.size, 0)
    assert.match(compiler.compilation.tooltip, /Compilation failed/)
})

test('unrelated snapshots and progress cannot finish or replace an active compilation', async () => {
    const { compiler, finished } = setup()
    compiler.compiling = true
    compiler.lastCompiledUri = 'file:///new.sctx'
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///old.sctx', true, 3, 3)
    compiler.handleProgress({ uri: 'file:///old.sctx', processor: { name: 'Old' }, index: 0, maxIndex: 3 })
    assert.equal(compiler.resultMap.size, 0)
    assert.equal(compiler.compilation.text, undefined)
    assert.equal(compiler.compiling, true)
    assert.deepEqual(finished, [])
})

test('server-decoded filenames still match the active model and result cache', async () => {
    const { compiler, finished } = setup()
    const source = URI.file('/models/my model.sctx').toString()
    compiler.lastCompiledUri = source
    compiler.compiling = true
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///models/my model.sctx', true, 3, 3)
    assert.deepEqual(finished, [true])
    assert.equal(compiler.resultMap.has(source), true)
})

test('server reset discards unusable snapshots and aborts compilation waiting for startup', async () => {
    const { compiler, finished } = setup()
    let ready
    let sent = false
    compiler.generation = 0
    compiler.sourceURI = new Map()
    compiler.lsClient = { start: () => new Promise((resolve) => { ready = resolve }), sendNotification: async () => { sent = true } }
    const pending = compiler.compile('test.system', false, false, false, 'file:///model.sctx')
    await Promise.resolve()
    compiler.resultMap.set('file:///old.sctx', { files: [] })
    compiler.resetForRestart()
    ready()
    await assert.rejects(pending, /restarted/)
    assert.equal(sent, false)
    assert.equal(compiler.resultMap.size, 0)
    assert.equal(compiler.lastCompiledUri, '')
    assert.deepEqual(finished, [false])
})

test('auto-compilation binds to the saved model even after changing editors', () => {
    const { compiler } = setup()
    const uri = URI.file('/models/saved.sctx')
    compiler.lastCompiledUri = uri.toString()
    compiler.lastInvokedCompilation = 'test.system'
    compiler.settings = { get: () => true }
    compiler.editor = { document: { uri: URI.file('/models/other.sctx') } }
    const calls = []
    compiler.compileAndPresent = (...args) => calls.push(args)
    compiler.onDidSaveTextDocument({ uri, isDirty: false })
    assert.deepEqual(calls, [['test.system', false, uri]])
})

test('auto-compilation defers to simulation preparation and generation', () => {
    const { compiler } = setup()
    const uri = URI.file('/models/model.sctx')
    compiler.lastCompiledUri = uri.toString()
    compiler.settings = { get: () => true }
    compiler.compileAndPresent = () => assert.fail('Preparation must suppress auto-compilation')
    compiler.preparingSimulation = true
    compiler.onDidSaveTextDocument({ uri, isDirty: false })
    compiler.preparingSimulation = false
    compiler.generatingCode = true
    compiler.onDidSaveTextDocument({ uri, isDirty: false })
})

test('Compile saves its selected model and suppresses competing auto-compilation during that save', async () => {
    const { compiler, vscode } = setup()
    const uri = URI.file('/models/selected.sctx')
    const document = { uri, isDirty: true }
    compiler.editor = { document }
    compiler.lastCompiledUri = uri.toString()
    compiler.settings = { get: () => true }
    vscode.workspace.openTextDocument = async () => document
    const builds = []
    compiler.compile = async (...args) => builds.push(args)
    document.save = async () => {
        assert.equal(compiler.preparingCompilation, true)
        document.isDirty = false
        compiler.onDidSaveTextDocument(document)
        compiler.editor = { document: { uri: URI.file('/models/other.sctx') } }
        return true
    }
    await compiler.compileAndPresent('test.system', false)
    assert.deepEqual(builds, [['test.system', true, false, false, uri.toString()]])
    assert.equal(compiler.preparingCompilation, false)
    assert.equal(compiler.pendingResults.get(uri.toString()), true)
})

test('Compile refuses failed saves or edits made while saving and leaves no pending output', async () => {
    const { compiler, vscode, messages } = setup()
    const uri = URI.file('/models/selected.sctx')
    const document = { uri, isDirty: true, save: async () => false }
    compiler.editor = { document }
    compiler.settings = { get: () => true }
    vscode.workspace.openTextDocument = async () => document
    compiler.compile = async () => assert.fail('Unsaved models must not compile')
    await compiler.compileAndPresent('test.system', false)
    assert.match(messages.pop(), /Save the model before compiling/)
    document.save = async () => true
    await compiler.compileAndPresent('test.system', false)
    assert.match(messages.pop(), /model changed while saving/)
    assert.equal(compiler.pendingResults.size, 0)
    assert.equal(compiler.preparingCompilation, false)
})

test('compilation startup errors clear the running flag and show a failed status', async () => {
    const { compiler, finished } = setup()
    compiler.lsClient = { start: async () => { throw new Error('Java stopped') } }
    await assert.rejects(compiler.compile('test.system', false, false, false, 'file:///model.sctx'), /Java stopped/)
    assert.equal(compiler.compiling, false)
    assert.match(compiler.compilation.text, /Compilation failed/)
    assert.match(compiler.compilation.tooltip, /Java stopped/)
    assert.deepEqual(finished, [false])
})

test('a terminal partial compilation never launches a simulation', async () => {
    const { compiler, finished } = setup()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///model.sctx', true, 2, 10)
    assert.deepEqual(finished, [false])
    assert.match(compiler.compilation.tooltip, /Compilation stopped/)
})

test('a finished presentation cannot overwrite the status of a newer compilation', async () => {
    const { compiler } = setup()
    compiler.pendingResults.set('file:///model.sctx', true)
    let shown
    compiler.documents = { open: () => new Promise((resolve) => { shown = resolve }) }
    const presentation = compiler.handleNewSnapshotDescriptions({ files: [], generatedFiles: [{ fileName: 'Model.c', code: '' }] }, 'file:///model.sctx', true, 3, 3)
    compiler.compilation.text = '$(spinner) New compilation'
    shown()
    await presentation
    assert.equal(compiler.compilation.text, '$(spinner) New compilation')
})

test('source-validation failures expose only the source model in the stage picker', async () => {
    const { compiler, vscode } = setup()
    const uri = 'file:///model.sctx'
    compiler.resultMap.set(uri, { files: [[{ name: 'Source validation', processorId: 'source-validation', errors: ['Invalid source'] }]] })
    let items
    vscode.window.showQuickPick = async (choices) => { items = choices }
    await compiler.pickStage(uri)
    assert.deepEqual(items.map((item) => item.index), [-1])
    compiler.shownStage.set(uri, 0)
    assert.equal(compiler.currentStage(uri), undefined)
})

test('synthetic validation stages never request an old server snapshot, while the source remains available', async () => {
    const { compiler } = setup()
    const uri = 'file:///model.sctx'
    const shown = []
    compiler.resultMap.set(uri, { files: [[{ name: 'Source validation', processorId: 'source-validation' }]] })
    compiler.lsClient = { start: async () => {}, sendRequest: async (_, params) => { shown.push(params.index) } }
    await assert.rejects(compiler.show(uri, 0), /before any compilation stage was created/)
    assert.deepEqual(shown, [])
    await compiler.show(uri, -1)
    assert.deepEqual(shown, [-1])
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

const load = createLoader({ vscode: {
    Uri: URI,
    TreeItem: class {}, TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class {},
    commands: { getCommands: async () => [] },
    window: { showErrorMessage: async () => undefined },
} })
const progress = load('src/kico/compile-progress.ts')

function provider() {
    const { CompilationDataProvider } = load('src/kico/compilation-data-provider.ts')
    const compiler = Object.create(CompilationDataProvider.prototype)
    for (const map of ['isCompiled', 'resultMap', 'lengthMap', 'indexMap', 'shownStage', 'pendingResults']) compiler[map] = new Map()
    compiler.compilationFinishedEmitter = { fire() {} }
    compiler.stageChangedEmitter = { fire() {} }
    compiler.compilation = { shown: 0, show() { this.shown++ } }
    compiler.output = { appendLine() {} }
    compiler.startTime = Date.now() - 5000
    compiler.compiling = true
    return compiler
}

const processors = [
    { id: 'a', name: 'Reference Expansion', status: 'ok', durationMs: 8, startedAtMs: 0, snapshotIndex: 0 },
    { id: 'b', name: 'GCC Compiler', status: 'ok', durationMs: 1100, startedAtMs: 20, snapshotIndex: 1 },
    { id: 'c', name: 'Link', status: 'skipped', snapshotIndex: -1 },
]

test('durations read naturally at every scale', () => {
    assert.equal(progress.formatDuration(0), '0 ms')
    assert.equal(progress.formatDuration(142), '142 ms')
    assert.equal(progress.formatDuration(1830), '1.8 s')
    assert.equal(progress.formatDuration(12345), '12 s')
    assert.equal(progress.formatDuration(undefined), '')
})

test('the running processor and its position appear while compiling', () => {
    const compiler = provider()
    compiler.handleProgress({ uri: 'file:///m.sctx', processor: { id: 'b', name: 'GCC Compiler', index: 1 }, index: 1, maxIndex: 38, elapsedMs: 1830 })
    assert.equal(compiler.compilation.text, '$(spinner) GCC Compiler (2/38)')
    assert.equal(compiler.compilation.tooltip, 'Compiling: GCC Compiler · 1.8 s elapsed')
    assert.equal(compiler.compilation.shown, 1)
    compiler.compiling = false
    compiler.handleProgress({ uri: 'file:///m.sctx', processor: { id: 'c', name: 'Late', index: 2 }, index: 2, maxIndex: 38, elapsedMs: 1 })
    assert.equal(compiler.compilation.text, '$(spinner) GCC Compiler (2/38)', 'progress after the end of a compilation is ignored')
})

test('a snapshot names the processor it came from', async () => {
    const compiler = provider()
    await compiler.handleNewSnapshotDescriptions({ files: [[{ name: 'SCG', index: 0 }]] }, 'file:///m.sctx', false, 12, 38, { id: 'x', name: 'SCG', index: 12 })
    assert.equal(compiler.compilation.text, '$(spinner) SCG (13/38)')
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///m.sctx', false, 40, 38)
    assert.equal(compiler.compilation.text, '$(spinner) Compiling (38/38)', 'an index past the estimate never overflows the bar')
})

test('the finished summary uses the server wall time and names the slowest processor', async () => {
    const compiler = provider()
    await compiler.handleNewSnapshotDescriptions(
        { files: [[{ name: 'GCC Compiler', index: 0 }]], totalMs: 1830, processorCount: 3, processors },
        'file:///m.sctx', true, 3, 3
    )
    assert.equal(compiler.compilation.text, '$(check) 1.8 s')
    assert.equal(compiler.compilation.tooltip, 'Compiled in 1.8 s (2/3 processors, slowest: GCC Compiler 1.1 s)')
})

test('a stopped compilation says so and falls back to the client clock without server timings', async () => {
    const compiler = provider()
    await compiler.handleNewSnapshotDescriptions({ files: [] }, 'file:///m.sctx', true, 2, 38)
    assert.match(compiler.compilation.text, /^\$\(times\) \d+(\.\d)? s$/)
    assert.match(compiler.compilation.tooltip, /^Compilation stopped after /)
})

test('a failed compilation is marked as such with its timings', () => {
    const summary = progress.finishedSummary({ success: false, cancelled: false, totalMs: 300, processors, processorCount: 3 })
    assert.equal(summary.text, '$(times) 300 ms')
    assert.equal(summary.tooltip, 'Compilation failed in 300 ms (2/3 processors, slowest: GCC Compiler 1.1 s)')
})

test('stage rows carry their duration and the slowest one is flagged', () => {
    const slowest = progress.slowestProcessor(processors)
    assert.equal(slowest.id, 'b')
    assert.equal(progress.stageTiming({ processorId: 'a', durationMs: 8 }, slowest), '8 ms')
    assert.equal(progress.stageTiming({ processorId: 'b', durationMs: 1100 }, slowest), '1.1 s $(flame)')
    assert.equal(progress.stageTiming({ processorId: 'b' }, slowest), '', 'intermediate snapshots have no duration')
    assert.equal(progress.slowestProcessor(undefined), undefined)
})

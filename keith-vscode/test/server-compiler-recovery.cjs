// Real-protocol regressions for incomplete source, compiler recovery and background/user overlap.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')
const { java, classpath, serverArgs, sameFile } = require('./server-launch.cjs')

async function main() {
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'sccharts-recovery-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    const logErrors = []
    const progress = []
    const finals = []
    connection.onNotification((method, params) => {
        if (method === 'window/logMessage' && params.type === 1) logErrors.push(params.message)
        if (method === 'keith/kicool/progress') progress.push(params)
        if (method === 'keith/kicool/didCompile' && params.finished) finals.push(params)
        for (const waiter of [...waiters]) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Timeout: ' + method + '\n' + stderr)) }, 40000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('keith/diagnostics/configure', { enabled: false })
        const cancellation = waitFor('keith/kicool/cancel-compilation')
        await connection.sendNotification('keith/kicool/cancel-compilation')
        const cancelled = await cancellation
        assert.equal(Array.isArray(cancelled) ? cancelled[0] : cancelled, false, 'Cancellation without any prior compile answers without throwing')
        const file = path.join(workspace, 'recovery.sctx')
        const uri = pathToFileURL(file).href
        const good = 'scchart Recovery { output bool result = false\n initial state Idle\n do result = !result go to Idle\n}'
        fs.writeFileSync(file, good)
        let version = 1
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version, text: good } })
        const change = async text => {
            fs.writeFileSync(file, text)
            await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] })
        }
        const compile = async (command = 'de.cau.cs.kieler.sccharts.netlist') => {
            const complete = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
            await connection.sendNotification('keith/kicool/compile', { uri, command, clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
            return (await complete).results
        }
        const issuesOf = result => result.files.flat().flatMap(stage => stage.diagnostics ?? [])
        const invalid = [
            ['unknown target', good.replace('go to Idle', 'go to Missing'), 'Missing'],
            ['unknown variable', good.replace('!result', 'missing'), 'missing'],
            ['missing initial state', good.replace('initial state', 'state')],
            ['incomplete expression', good.replace('!result', '')],
            ['empty document', ''],
            ['comment-only document', '// A new chart goes here']
        ]
        for (const [name, text, token] of invalid) {
            await change(text)
            const started = progress.length
            const count = finals.length
            const result = await compile()
            const issues = issuesOf(result)
            assert.ok(issues.length > 0 && issues.every(issue => issue.code === 'source-validation'), name + ': ' + JSON.stringify(issues))
            assert.ok(issues.every(issue => issue.locations.length > 0), name + ': every finding is located')
            assert.equal(result.generatedFiles, undefined, name + ': no output from invalid source')
            assert.equal(progress.length, started, name + ': no processor runs on incomplete input')
            assert.equal(finals.length, count + 1, name + ': exactly one terminal result')
            if (token) assert.ok(issues.some(issue => issue.locations.some(location => text.slice(location.offset, location.offset + location.length) === token)), name + ': exact source token')
            await change(good)
            const recovered = await compile()
            assert.deepEqual(recovered.files.flat().flatMap(stage => stage.errors ?? []), [], name + ': corrected source compiles')
            assert.ok(recovered.generatedFiles.length > 0, name + ': generated code is available after recovery')
            console.log('Recovery: ' + name + ' produces a located source error, then compiles after correction.')
        }
        const baseFile = path.join(workspace, 'base.sctx')
        const baseUri = pathToFileURL(baseFile).href
        const brokenBase = "scchart Base { initial state Start\n go to Missing\n}"
        fs.writeFileSync(baseFile, brokenBase)
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: baseUri, languageId: 'sctx', version: 1, text: brokenBase } })
        const derived = "import \"base.sctx\"\nscchart Derived extends Base {}"
        await change(derived)
        const imported = await compile()
        assert.ok(issuesOf(imported).some(issue => issue.code === 'source-validation' && issue.locations.some(location => sameFile(location.uri, baseUri) && brokenBase.slice(location.offset, location.offset + location.length) === 'Missing')), 'Imported failures point to the imported source token: ' + JSON.stringify(issuesOf(imported)))
        const fixedBase = brokenBase.replace('Missing', 'Start')
        fs.writeFileSync(baseFile, fixedBase)
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri: baseUri, version: 2 }, contentChanges: [{ text: fixedBase }] })
        assert.deepEqual((await compile()).files.flat().flatMap(stage => stage.errors ?? []), [], 'Correcting the imported source permits compilation')
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri: baseUri } })
        await change(good)
        console.log('Recovery: an imported broken transition points to its own file and compiles after correction.')

        const unavailable = await compile('sccharts.missing.system')
        assert.ok(issuesOf(unavailable).some(issue => issue.code === 'compilation-system' && issue.message.includes('sccharts.missing.system') && issue.hint), JSON.stringify(issuesOf(unavailable)))
        assert.deepEqual((await compile()).files.flat().flatMap(stage => stage.errors ?? []), [])
        console.log('Recovery: an unavailable compilation system finishes with a useful error, then compiles with an existing system.')

        // Live analysis and user compilation share the compiler gate, including repeated edits.
        await connection.sendNotification('keith/diagnostics/configure', { enabled: true, debounceMs: 0 })
        for (let round = 0; round < 3; round++) {
            const nextVersion = version + 1
            const live = waitFor('keith/diagnostics/live', result => sameFile(result.uri, uri) && result.version === nextVersion)
            await change(good + '\n'.repeat(round + 1))
            const result = await compile()
            assert.deepEqual(result.files.flat().flatMap(stage => stage.errors ?? []), [])
            assert.ok(!(await live).issues.some(issue => issue.code === 'internal-compiler-error'))
        }
        const otherFiles = [1, 2, 3].map(index => ({ uri: pathToFileURL(path.join(workspace, 'live-' + index + '.sctx')).href, text: good.replace('Recovery', 'Live' + index) }))
        const analyses = otherFiles.map(file => waitFor('keith/diagnostics/live', result => sameFile(result.uri, file.uri) && result.version === 1))
        for (const file of otherFiles) {
            fs.writeFileSync(new URL(file.uri), file.text)
            await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: file.uri, languageId: 'sctx', version: 1, text: file.text } })
        }
        assert.ok((await Promise.all(analyses)).every(result => !result.issues.some(issue => issue.code === 'internal-compiler-error')))
        console.log('Live queue: three concurrently opened documents each receive their own analysis.')

        const checkFile = path.join(workspace, 'CompilerFailureCheck.java')
        fs.writeFileSync(checkFile, "import de.cau.cs.kieler.language.server.kicool.SourceValidation;\nclass CompilerFailureCheck {\n public static void main(String[] args) throws Exception {\n  var failure = new IllegalStateException(\"outer failure\", new NullPointerException(\"root cause\"));\n  var issue = SourceValidation.internalFailure(\"Dependency\", failure, null, \"file:///failure.sctx\");\n  if (!issue.code.equals(\"internal-compiler-error\") || !issue.message.contains(\"Dependency\") || !issue.details.contains(\"Caused by: java.lang.NullPointerException: root cause\") || issue.locations.isEmpty() || !issue.hint.contains(\"report\")) throw new AssertionError(issue.details);\n  var result = SourceValidation.failed(\"file:///failure.sctx\", failure, null);\n  if (result.files.isEmpty() || result.files.get(0).get(0).getErrors().isEmpty() || result.generatedFiles != null) throw new AssertionError(\"missing terminal failure\");\n  var read = SourceValidation.capture(() -> { throw failure; });\n  try { read.getValue(); throw new AssertionError(\"failure lost\"); } catch (IllegalStateException expected) { if (expected != failure) throw new AssertionError(\"cause replaced\"); }\n }\n}")
        // Source launch needs a full JDK; the selected server runtime can be a jlink image.
        const check = spawnSync('java', ['-cp', classpath, checkFile], { encoding: 'utf8', timeout: 60000 })
        assert.equal(check.status, 0, check.stderr || 'CompilerFailureCheck timed out')
        console.log('Internal failures: processor name, source location, complete caused-by stack, copy hint and terminal error result are preserved.')
        assert.deepEqual(logErrors, [])
        assert.doesNotMatch(stderr, /NullPointerException|ConcurrentModificationException|Error executing EValidator/)
        console.log('Recovery: overlapping live analysis and user compilation finish without compiler exceptions.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await exited
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
}

main().catch(error => { console.error(error); process.exit(1) })

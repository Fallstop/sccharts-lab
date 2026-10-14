const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const extension = path.resolve(__dirname, '..')
    const { classpath, java, serverArgs, sameFile } = require('./server-launch.cjs')
    // The two source-launcher checks below need a JDK (`java File.java`), so they always use PATH's java.
    const closedDiagram = spawnSync('java', ['-cp', classpath, path.join(__dirname, 'fixtures/DiagramRefreshCheck.java')], { encoding: 'utf8' })
    assert.equal(closedDiagram.status, 0, closedDiagram.stderr)
    const reentrant = spawnSync('java', ['-cp', classpath, path.join(__dirname, 'fixtures/MainThreadCheck.java')], { encoding: 'utf8', timeout: 60000 })
    assert.equal(reentrant.status, 0, reentrant.stderr || 'MainThreadCheck timed out')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-diagnostics-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const closed = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    // A hang is only diagnosable from the server's threads, which a CI log cannot show otherwise.
    const threads = () => (spawnSync('jstack', [String(server.pid)], { encoding: 'utf8' }).stdout || '').trim()
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}\n${threads()}`)) }, 40000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    async function compile(name, text) {
        const dir = path.join(workspace, name)
        fs.mkdirSync(dir)
        const file = path.join(dir, `${name}.sctx`)
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const done = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await done
        const stages = result.results.files.flat()
        return { dir, uri, stages, issues: stages.flatMap(stage => stage.diagnostics ?? []), errors: stages.flatMap(stage => stage.errors ?? []) }
    }
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const demo = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
        const baseline = fs.readFileSync(path.join(__dirname, 'fixtures/audit.sctx'), 'utf8')
        const broken = await compile('broken', demo)
        const cycles = broken.issues.filter(issue => issue.code === 'scheduling-cycle')
        assert.equal(cycles.length, 1)
        assert.equal(cycles[0].cycle.length, 2, 'Return a short witness, not all blocked operations')
        assert.ok(cycles[0].locations.some(location => location.label === 'timeout_update = false'))
        assert.ok(cycles[0].locations.some(location => location.label === 'timeout_update = true'))
        for (const location of cycles[0].locations) {
            assert.equal(demo.slice(location.offset, location.offset + location.length).trim().replace(/\s+/g, ' '), location.label)
            assert.ok(location.traceUris.length > 0)
        }
        assert.ok(!broken.issues.some(issue => issue.code === 'compiler' && /Can't schedule|NOT asc-schedulable/.test(issue.message)), 'Per-edge scheduler messages stay in Technical details only')
        const loops = broken.issues.filter(issue => issue.code === 'instantaneous-loop')
        assert.ok(loops.length > 0 && loops.every(loop => loop.severity === 'warning' && loop.locations.length > 0), JSON.stringify(broken.issues))
        assert.ok(loops.some(loop => loop.locations.some(location => cycles[0].locations.some(other => other.offset === location.offset))), 'The analyzer also warns about the cycle the scheduler rejects')
        assert.ok(!broken.stages.some(stage => stage.name === 'GCC Compiler'), 'Stop after scheduler errors')
        assert.ok(!fs.existsSync(path.join(broken.dir, 'kieler-gen/bin/simulation.exe')))
        console.log('Scheduler: one two-edge cycle, exact source ranges, diagram traces, no executable.')

        const diagramReady = waitFor('diagram/accept', message => !!message.action?.newRoot)
        await connection.sendNotification('diagram/accept', { clientId: 'keith-diagram_sprotty', action: { kind: 'requestModel', requestId: 'source-diagram', options: { sourceUri: broken.uri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } })
        const diagram = (await diagramReady).action
        const { findDiagramElements } = require('./load-typescript.cjs')({ sprotty: {}, 'sprotty-protocol': {} })('src-webview/diagram/diagnostics/highlight.ts')
        const selected = findDiagramElements(diagram.newRoot, cycles[0].locations.map(location => location.traceUris))
        assert.ok(selected.length >= 2 && selected.length <= 4, JSON.stringify(selected))
        assert.ok(selected.some(id => id.includes('red')))
        assert.ok(selected.some(id => id.includes('listening')))
        console.log('Diagram: both conflict participants resolve to actual SCCharts diagram elements.')

        const schedulerIndex = broken.stages.findIndex(stage => stage.diagnostics?.some(issue => issue.code === 'scheduling-cycle'))
        for (const index of [schedulerIndex, -1, schedulerIndex, -1]) {
            const shown = waitFor('diagram/accept', message => !!message.action?.newRoot)
            assert.equal(await connection.sendRequest('keith/kicool/show', { uri: broken.uri, clientId: 'keith-diagram_sprotty', index }), 'OK')
            await shown
        }
        assert.ok(!stderr.includes('NullPointerException'), stderr)
        console.log('Diagram recovery: scheduler/source switching completes without stale-context failures.')

        // The bundled server deadlocked on overlapping show requests (main thread waiting for the diagram
        // state lock held by a request waiting for the main thread) and raced synthesis against traversal.
        for (let round = 0; round < 3; round++) {
            const settled = waitFor('diagram/accept', message => !!message.action?.newRoot)
            const overlapping = [schedulerIndex, -1, 0, -1].map(index => connection.sendRequest('keith/kicool/show', { uri: broken.uri, clientId: 'keith-diagram_sprotty', index }))
            overlapping.push(connection.sendNotification('diagram/accept', { clientId: 'keith-diagram_sprotty', action: { kind: 'requestModel', requestId: `overlap-${round}`, options: { sourceUri: broken.uri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } }))
            const answers = await Promise.race([Promise.all(overlapping), new Promise((_, reject) => setTimeout(() => reject(new Error(`Overlapping show requests hung\n${threads()}`)), 30000))])
            assert.deepEqual(answers.slice(0, 4), ['OK', 'OK', 'OK', 'OK'])
            await settled
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
        assert.ok(!/NullPointerException|ConcurrentModificationException|Java-level deadlock/.test(stderr), stderr)
        console.log('Diagram concurrency: overlapping show and model requests neither hang nor fail.')

        // A diagram opened on a source with errors has no previous root to keep, so it must show the error message.
        const unlinkedText = 'scchart Unlinked {\n initial state A\n go to Missing\n}'
        const unlinkedUri = pathToFileURL(path.join(workspace, 'unlinked.sctx')).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: unlinkedUri, languageId: 'sctx', version: 1, text: unlinkedText } })
        const messageShown = waitFor('diagram/accept', message => message.clientId === 'unlinked-diagram' && !!message.action?.newRoot)
        await connection.sendNotification('diagram/accept', { clientId: 'unlinked-diagram', action: { kind: 'requestModel', requestId: 'unlinked', options: { sourceUri: unlinkedUri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } })
        assert.match(JSON.stringify((await messageShown).action.newRoot), /Line 3: Couldn't resolve reference to State 'Missing'/)
        console.log('Diagram: a first diagram of a source with errors shows the located error message.')

        const timed = await compile('timed', fs.readFileSync(path.join(__dirname, 'fixtures/timed-loop.sctx'), 'utf8'))
        assert.deepEqual(timed.errors, [], 'A delayed clock loop still compiles')
        const advisory = timed.issues.filter(issue => issue.code === 'instantaneous-loop')
        assert.ok(advisory.length >= 1, JSON.stringify(timed.issues))
        assert.ok(advisory[0].locations.some(location => location.label === 'x = 0'), JSON.stringify(advisory[0].locations))
        assert.ok(!advisory[0].locations.some(location => /^light = /.test(location.label)), 'Entry actions that merely lie on a timed loop are not listed')
        assert.equal(advisory[0].message, 'Potential instantaneous loop through the timed transitions on x.')
        assert.ok(advisory[0].hint.includes('resets x on entry'), advisory[0].hint)
        assert.ok(advisory[0].details.includes('control flow only'), advisory[0].details)
        assert.ok(!timed.issues.some(issue => issue.code === 'compiler' && issue.message.includes('Instantaneous loop')), 'The bare analyzer message is replaced, not duplicated')
        console.log('Loop analyzer: timed models get a located, explained warning instead of a bare message.')

        const array = await compile('array', demo.replace('timeout_update = false;', ''))
        const cIssue = array.issues.find(issue => issue.code === 'c-compiler' && /array type.*not assignable|assignment to expression with array type/.test(issue.message))
        assert.ok(cIssue, JSON.stringify(array.issues))
        const generated = cIssue.locations.find(location => location.generatedLine)
        assert.match(generated.generatedLine, /d->timeout_vals = d->timeout_buf/)
        assert.ok(generated.line > 0)
        assert.ok(cIssue.locations.some(location => location.label === 'timeout_vals = timeout_buf'), JSON.stringify(cIssue.locations, null, 2))
        assert.ok(cIssue.details.includes('gcc'))
        console.log('C compiler: actual array diagnostic, generated file/line/column and full output.')

        const { arrayCopyFix } = require('./load-typescript.cjs')()('src/kico/source-mapping.ts')
        const arraySource = demo.replace('timeout_update = false;', '')
        const origin = cIssue.locations.find(location => location.label === 'timeout_vals = timeout_buf')
        const replacement = arrayCopyFix(arraySource, origin)
        assert.ok(replacement)
        const fixed = await compile('array-fixed', arraySource.slice(0, origin.offset) + replacement + arraySource.slice(origin.offset + origin.length))
        assert.deepEqual(fixed.errors, [], 'Element-copy quick fix must compile on the actual demo')

        const host = await compile('host', '#hostcode-c "\nint probe(void) { return missing_symbol; }\n"\n' + baseline)
        const hostIssue = host.issues.find(issue => issue.code === 'c-compiler')
        assert.match(hostIssue.message, /missing_symbol/)
        assert.match(hostIssue.locations[0].generatedLine, /return missing_symbol/)

        const recovered = await compile('recovered', baseline)
        assert.deepEqual(recovered.errors, [])
        assert.ok(fs.existsSync(path.join(recovered.dir, 'kieler-gen/bin/simulation.exe')))
        const started = waitFor('keith/simulation/started')
        await connection.sendNotification('keith/simulation/start', { uri: recovered.uri, simulationType: 'Manual' })
        assert.equal((await started).successful, true)
        await connection.sendRequest('keith/simulation/stop')
        assert.ok(!/KIELER diagnostic tracing:|KIELER C diagnostics:|VerifyError|NoSuchMethodError/.test(stderr), stderr)
        console.log('Recovery: clean model compiles and simulates after scheduler and C failures.')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

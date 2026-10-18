// Ticks as fast as the server answers, with the diagram open, as Run does at step delay 0. Each tick
// used to queue a diagram layout of its own while the highlighter edited the diagram unlocked: the
// layouts piled up without bound, raced each other into exceptions, and froze the editor. Now one
// layout runs at a time and the ticks in between share one more. Also checks that what the model
// prints during a tick arrives with that tick.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const CLIENT = 'keith-diagram_sprotty'
const TICKS = 300

async function main() {
    const { java, serverArgs, sameFile } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-flood-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    let failures = 0
    server.stderr.on('data', chunk => {
        const text = String(chunk)
        failures += (text.match(/NullPointerException|NoSuchElementException|ConcurrentModificationException|Failed to perform diagram layout/g) ?? []).length
        stderr = (stderr + text).slice(-12000)
    })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const threads = () => (spawnSync('jstack', [String(server.pid)], { encoding: 'utf8' }).stdout || '').trim()
    const waiters = new Set()
    const models = []
    const options = []
    connection.onNotification((method, params) => {
        if (method === 'diagram/accept' && params.action?.newRoot) models.push(Date.now())
        if (method === 'diagram/accept' && /Options/.test(params.action?.kind ?? '')) options.push(params.action.kind)
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 40000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}\n${threads()}`)) }, timeout)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 240000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const text = fs.readFileSync(path.join(__dirname, 'fixtures/printer.sctx'), 'utf8')
        const file = path.join(workspace, 'printer.sctx')
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const opened = waitFor('diagram/accept', message => !!message.action?.newRoot)
        await connection.sendNotification('diagram/accept', { clientId: CLIENT, action: { kind: 'requestModel', requestId: 'source', options: { sourceUri: uri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } })
        await opened

        const compiled = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: CLIENT, inplace: true, showResultingModel: false, snapshot: false })
        const result = await compiled
        assert.deepEqual(result.results.files.flat().flatMap(stage => stage.errors ?? []), [])
        const started = waitFor('keith/simulation/started')
        await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
        assert.ok((await started).successful)
        await new Promise(resolve => setTimeout(resolve, 1000))

        const before = models.length
        const optionsBefore = options.length
        const begun = Date.now()
        const ticks = []
        for (let index = 0; index < TICKS; index++) {
            const tick = waitFor('keith/simulation/didStep')
            // Two ticks on, two off.
            await connection.sendNotification('keith/simulation/step', { valuesForNextStep: { snap: index % 4 < 2 }, simulationType: 'Manual' })
            ticks.push(await tick)
        }
        const ended = Date.now()
        await new Promise(resolve => setTimeout(resolve, 3000))
        const during = models.filter(at => at >= begun && at <= ended).length
        const after = models.filter(at => at > ended).length
        console.log(`${TICKS} ticks in ${ended - begun} ms with the diagram open: ${during} redraws during the run, ${after} after it (${models.length - before} in all).`)
        assert.equal(failures, 0, `The server failed while ticking fast:\n${stderr}`)
        // The ticks share layouts: only the one in flight and the one for the last ticks trail the run,
        // and they are done quickly, however long the run was.
        const last = Math.max(...models)
        assert.ok(after <= 3, `${after} redraws were still queued after the last tick`)
        assert.ok(last - ended < 1500, `redraws went on for ${last - ended} ms after the last tick`)
        assert.ok(models.length - before <= TICKS, 'more redraws than ticks')
        // The diagram options do not change while ticking, so they are not sent again with every redraw.
        assert.deepEqual(options.slice(optionsBefore), [], 'options sent during the run')
        assert.ok(optionsBefore > 0, 'the options reach the client once')

        // Printed lines come with their tick. snap is true at ticks 1, 2, 5, 6, 9, ...; the camera's
        // transition is delayed, so it is not taken in the first tick: it prints at ticks 2, 5, 9, ...
        // The prints have no line break (a \n in an SCCharts string breaks the generated C, in KIELER
        // too), so each shares a line with the tick's values on the executable's output.
        const printed = ticks.map(tick => tick.printed ?? [])
        const shown = JSON.stringify(printed.slice(0, 10))
        assert.deepEqual(printed[0], [], shown)
        assert.deepEqual(printed[1], ['Snapshot taken'], shown)
        assert.deepEqual(printed[2], [], shown)
        assert.deepEqual(printed[4], ['Snapshot taken'], shown)
        assert.equal(printed.filter(lines => lines.includes('Snapshot taken')).length, TICKS / 4)
        const seven = printed.findIndex(lines => lines.includes('seven'))
        assert.equal(seven, 7, shown)
        assert.equal(printed.flat().length, TICKS / 4 + 1)
        console.log(`Printed lines arrive with their tick: ${printed.flat().length} lines, "seven" at tick ${seven + 1}.`)

        await connection.sendRequest('keith/simulation/stop')
        await connection.sendRequest('shutdown')
        connection.sendNotification('exit')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await exited
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}

main().catch(error => { console.error(error); process.exit(1) })

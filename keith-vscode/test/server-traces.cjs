// Saved traces against the real server: what the lab writes must load in KIELER's own KTrace
// parser, and the lab must read KIELER's saved trace as the run that produced it.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')
const createLoader = require('./load-typescript.cjs')

const load = createLoader()
const { readTrace, writeTrace, inputsOnly, sameTraceValue } = load('src/simulation/trace-file.ts')

async function main() {
    const { java, serverArgs, sameFile } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-traces-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    const messages = []
    connection.onNotification((method, params) => {
        if (method === 'general/sendMessage' || method === 'window/showMessage') messages.push(params)
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 60000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}`)) }, timeout)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 240000)
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        const file = path.join(workspace, 'trace-types.sctx')
        fs.copyFileSync(path.join(__dirname, 'fixtures/trace-types.sctx'), file)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: fs.readFileSync(file, 'utf8') } })
        const compiled = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await compiled
        assert.deepEqual(result.results.files.flat().flatMap(stage => stage.errors ?? []), [])
        const started = waitFor('keith/simulation/started')
        await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
        const start = await started
        assert.ok(start.successful, start.error)

        // The run as the client keeps it: the values after each tick, by role from the interface.
        const roles = start.propertySet
        const declared = start.dataPool['#interface']
        const variables = Object.keys(start.dataPool)
            .filter(name => !name.startsWith('#') && !name.startsWith('_'))
            .map(name => ({
                name,
                role: roles.input?.includes(name) ? 'input' : roles.output?.includes(name) ? 'output' : 'local',
                type: declared[name]?.type,
            }))
        const inputs = [
            { arr: [1, 2], f: 1.5, s: 'a "quoted", text\twith\\escapes', S: true },
            { S: false },
            { f: 2, arr: [-3, 4] },
            {},
            { s: 'reset', S: true },
        ]
        const ticks = []
        for (const values of inputs) {
            const tick = waitFor('keith/simulation/didStep')
            await connection.sendNotification('keith/simulation/step', { valuesForNextStep: values, simulationType: 'Manual' })
            const step = await tick
            ticks.push(Object.fromEntries(variables.map(({ name }) => [name, step.values[name]])))
        }
        const run = { model: 'trace-types.sctx', variables, ticks }
        assert.ok(variables.some(v => v.name === 'steps' && v.role === 'local'))

        // KIELER's own trace of the run reads as the same inputs and outputs.
        const saved = path.join(workspace, 'kieler.ktrace')
        assert.deepEqual(await connection.sendRequest('keith/simulation/saveTrace', saved), { successful: true, reason: 'Saving successful.' })
        const kieler = readTrace(fs.readFileSync(saved, 'utf8'), 'ktrace')
        assert.equal(kieler.ticks.length, ticks.length)
        for (const variable of variables.filter(v => v.role !== 'local')) {
            ticks.forEach((tick, index) =>
                assert.ok(sameTraceValue(kieler.ticks[index][variable.name], tick[variable.name]),
                    `${variable.name} after tick ${index + 1}: KIELER saved ${JSON.stringify(kieler.ticks[index][variable.name])}, the run had ${JSON.stringify(tick[variable.name])}`))
        }
        console.log('KIELER\'s saved trace reads back as the run, value for value.')

        // The lab's KTrace, a full trace and an input sequence, loads in KIELER's parser and checks without a mismatch.
        for (const [name, trace] of [['lab.ktrace', run], ['lab-inputs.ktrace', inputsOnly(run)]]) {
            const target = path.join(workspace, name)
            fs.writeFileSync(target, writeTrace(trace, 'ktrace'))
            const loaded = await connection.sendRequest('keith/simulation/loadTrace', target)
            assert.ok(loaded.successful, `${name}: ${loaded.reason}`)
            assert.equal(loaded.trace.ticks.length, ticks.length, name)
        }
        console.log('KTrace written by the lab loads in KIELER: arrays, negative numbers, floats, escaped strings and signals.')
        // The same lab file, read by the lab again, is the run it came from.
        const back = readTrace(writeTrace(run, 'ktrace'), 'ktrace')
        ticks.forEach((tick, index) => variables.filter(v => v.role !== 'local').forEach(({ name }) =>
            assert.ok(sameTraceValue(back.ticks[index][name], tick[name]), `${name} after tick ${index + 1}`)))
        for (const format of ['csv', 'json', 'xml']) {
            const again = readTrace(writeTrace(run, format), format)
            ticks.forEach((tick, index) => variables.forEach(({ name }) =>
                assert.ok(sameTraceValue(again.ticks[index][name], tick[name]), `${format}: ${name} after tick ${index + 1}`)))
        }
        console.log('CSV, JSON and XML hold every variable of the run, including the model\'s own.')
        await connection.sendRequest('keith/simulation/stop')
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await exited
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})

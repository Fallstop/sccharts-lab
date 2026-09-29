// Exercises the language server's per-processor progress and timings and the SCTX editor services:
// hover cards, go-to-definition, find references and the document outline.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

async function main() {
    const { java, serverArgs, sameFile } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-compile-ide-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const closed = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    const progress = []
    const failedRequests = []
    connection.onNotification((method, params) => {
        if (method === 'keith/kicool/progress') progress.push(params)
        if (method === 'window/logMessage' && params.type === 1) failedRequests.push(params.message)
        for (const waiter of waiters) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}\n${stderr}`)) }, 40000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/hover.sctx'), 'utf8')
    const lines = text.split('\n')
    /** Position of the n-th occurrence of `needle` on the given line (1-based line as in an editor). */
    const at = (line, needle, occurrence = 0) => {
        let character = -1
        for (let i = 0; i <= occurrence; i++) character = lines[line - 1].indexOf(needle, character + 1)
        assert.ok(character >= 0, `${needle} on line ${line}`)
        return { line: line - 1, character: character + 1 }
    }
    const range = (line, needle, occurrence = 0) => {
        const { character } = at(line, needle, occurrence)
        return { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character: character - 1 + needle.length } }
    }
    try {
        const init = await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: { textDocument: { hover: { contentFormat: ['markdown'] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }, workspaceFolders: null })
        for (const capability of ['hoverProvider', 'definitionProvider', 'referencesProvider', 'documentSymbolProvider', 'renameProvider']) {
            assert.ok(init.capabilities[capability], `server advertises ${capability}`)
        }
        await connection.sendNotification('initialized', {})
        const file = path.join(workspace, 'hover.sctx')
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })

        // --- Per-processor progress and timings -------------------------------------------------------
        const done = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
        await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.netlist', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const result = await done
        const { results } = result
        assert.ok(progress.length >= 10, `progress notifications: ${progress.length}`)
        assert.equal(progress[0].index, 0)
        assert.equal(progress[0].processor.index, 0)
        assert.ok(progress.every(p => p.processor.id && p.processor.name && p.maxIndex === results.processorCount && p.elapsedMs >= 0), JSON.stringify(progress[0]))
        assert.ok(progress.every((p, i) => i === 0 || p.elapsedMs >= progress[i - 1].elapsedMs), 'elapsed time only grows')
        assert.equal(result.maxIndex, results.processorCount, 'maxIndex is the number of processors the system runs')
        assert.equal(result.currentIndex, results.processorCount, 'every processor finished')
        assert.equal(results.processors.length, results.processorCount)
        assert.ok(results.totalMs >= 0 && Number.isInteger(results.totalMs))
        const ran = results.processors.filter(p => p.durationMs !== undefined)
        assert.equal(ran.length, results.processorCount, 'a successful netlist compilation runs every processor')
        assert.ok(results.processors.every(p => ['ok', 'warning'].includes(p.status)), JSON.stringify(results.processors.map(p => p.status)))
        assert.ok(results.processors.every(p => p.durationMs >= 0 && p.startedAtMs >= 0 && p.snapshotIndex >= 0))
        assert.ok(results.processors.every((p, i) => i === 0 || p.startedAtMs >= results.processors[i - 1].startedAtMs), 'processors are listed in execution order')
        const sum = results.processors.reduce((total, p) => total + p.durationMs, 0)
        assert.ok(results.totalMs + 50 >= sum, `total ${results.totalMs} ms covers the stages (${sum} ms)`)
        assert.ok(results.totalMs < 10 * Math.max(sum, 20) + 500, `total ${results.totalMs} ms is the same order as the stages (${sum} ms)`)
        const stages = results.files.flat()
        assert.ok(stages.every(stage => typeof stage.processorId === 'string' && stage.processorId.length > 0), 'every stage names its processor')
        const finals = stages.filter(stage => stage.durationMs !== undefined)
        assert.equal(finals.length, results.processorCount, 'one timed snapshot per processor')
        assert.ok(finals.every(stage => stage.durationMs >= 0 && stage.startedAtMs >= 0 && stage.status === results.processors.find(p => p.id === stage.processorId).status))
        for (const timing of results.processors) assert.equal(stages[timing.snapshotIndex].processorId, timing.id, 'snapshotIndex points at the processor\'s own snapshot')
        const partial = await new Promise(resolve => {
            const seen = []
            const waiter = { method: 'keith/kicool/didCompile', accept: p => !p.finished && p.currentProcessor && (seen.push(p), true), resolve: p => { waiters.delete(waiter); resolve(p) } }
            waiters.add(waiter)
            connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.netlist', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        })
        assert.ok(partial.currentProcessor.id && partial.currentProcessor.name, 'snapshot updates name their processor')
        await waitFor('keith/kicool/didCompile', p => p.finished)
        console.log(`Timings: ${results.processorCount} processors, ${results.totalMs} ms total, slowest ${[...results.processors].sort((a, b) => b.durationMs - a.durationMs)[0].name}.`)

        // --- Compiling while the document is edited ------------------------------------------------------
        // The compilation copies the open document's model under the read lock; an edit that cancels the
        // queued read must delay the compilation, not fail it.
        let version = 1
        for (let round = 0; round < 5; round++) {
            const compiled = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri))
            await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
            for (let edit = 1; edit <= 4; edit++) {
                await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text: text + '\n'.repeat(edit) }] })
            }
            const { results } = await compiled
            assert.deepEqual(results.files.flat().flatMap(stage => stage.errors ?? []), [], `round ${round}`)
        }
        assert.deepEqual(failedRequests, [])
        console.log('Edits during compilation: 5 compilations, each chased by 4 edits, finish without errors.')

        // A failing compilation: the stages after the failure are reported as skipped, not silently absent.
        const brokenFile = path.join(workspace, 'broken.sctx')
        const broken = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
        fs.writeFileSync(brokenFile, broken)
        const brokenUri = pathToFileURL(brokenFile).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: brokenUri, languageId: 'sctx', version: 1, text: broken } })
        const failed = waitFor('keith/kicool/didCompile', p => p.finished && sameFile(p.uri, brokenUri))
        await connection.sendNotification('keith/kicool/compile', { uri: brokenUri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'keith-diagram_sprotty', inplace: true, showResultingModel: false, snapshot: false })
        const failure = (await failed).results
        const errorIndex = failure.processors.findIndex(p => p.status === 'error')
        assert.ok(errorIndex > 0, JSON.stringify(failure.processors.map(p => p.status)))
        assert.ok(failure.processors.slice(errorIndex + 1).every(p => p.status === 'skipped' && p.durationMs === undefined), 'processors after the failure are skipped')
        assert.ok(failure.processors.slice(0, errorIndex).every(p => p.status !== 'skipped' && p.durationMs !== undefined))
        assert.equal(failure.processors.length, failure.processorCount)
        console.log(`Failure: ${errorIndex} processors ran, ${failure.processorCount - errorIndex - 1} skipped after ${failure.processors[errorIndex].name}.`)

        // --- Hover -----------------------------------------------------------------------------------
        const hover = async position => (await connection.sendRequest('textDocument/hover', { textDocument: { uri }, position })).contents.value
        const declaration = await hover(at(4, 'trigger'))
        assert.match(declaration, /```sctx\ninput bool trigger\n```/)
        assert.doesNotMatch(declaration, /of type|Declared in `Audit`|Initial value/, 'the code block already says kind, type and initial value; the root scope is implied')
        assert.match(declaration, /Read 2 times, never written\./)
        assert.match(declaration, /Rising edge of the sensor\./, 'the // comment above the declaration is its documentation')
        assert.equal(await hover(at(12, 'trigger')), declaration, 'hovering a reference shows the declaration card')
        const output = await hover(at(6, 'result'))
        assert.match(output, /```sctx\noutput bool result = false/)
        assert.match(output, /Written 2 times, never read\./)
        assert.match(output, /Set while listening\./, 'a //* semantic comment is documentation')
        const constant = await hover(at(8, 'LIMIT'))
        assert.match(constant, /```sctx\nconst int LIMIT = /)
        assert.match(constant, /Read once, never written\./)
        const state = await hover(at(14, 'Active'))
        assert.match(state, /\*\*state\*\* `Active`/)
        assert.match(state, /Contains 1 region:\n- controlflow region `main` with 2 states/)
        assert.match(state, /Actions:\n- `entry \/ count = count \+ 1`/)
        assert.match(state, /Outgoing transitions \(2\):\n- `!trigger \/ result = false` go to `Idle`\n- join to `Idle`/)
        assert.match(state, /Entered from `Idle`/)
        assert.equal(await hover(at(12, 'Active')), state, 'hovering a go to target shows the state card')
        const initial = await hover(at(11, 'Idle'))
        assert.match(initial, /\*\*initial state\*\* `Idle` "Waiting"/)
        const transition = await hover(at(12, 'if'))
        assert.match(transition, /```sctx\nif trigger do result = true; echoed = timeout_update_vals go to Active\n```/)
        assert.match(transition, /\*\*transition\*\* `Idle` → `Active` · priority 1 of 1/)
        assert.match(transition, /weak abort \(`go to`\)/)
        assert.match(transition, /delayed/)
        assert.match(transition, /Trigger: `trigger`/)
        assert.match(transition, /Effects:\n- `result = true`\n- `echoed = timeout_update_vals`/)
        const abort = await hover(at(18, 'if'))
        assert.match(abort, /strong abort \(`abort to`\)/)
        assert.match(abort, /Trigger: `count > LIMIT`/)
        const region = await hover(at(16, 'main'))
        assert.match(region, /\*\*controlflow region `main` with 2 states\*\*/)
        assert.match(region, /Initial state: `On`/)
        assert.match(region, /Final state: `Off`/)
        const root = await hover(at(2, 'Audit'))
        assert.match(root, /\*\*root state\*\* `Audit`/)
        assert.match(root, /The audit chart reacts to a trigger\./, 'the /** */ comment is documentation')
        const entry = await hover(at(15, 'entry'))
        assert.match(entry, /\*\*entry action\*\* `entry \/ count = count \+ 1`/)
        console.log('Hover: declarations, references, states, regions, transitions and actions carry model cards with comments.')

        // --- Definition and references -------------------------------------------------------------
        const definition = async position => connection.sendRequest('textDocument/definition', { textDocument: { uri }, position })
        assert.deepEqual((await definition(at(12, 'Active'))).map(l => l.range), [range(14, 'Active')], 'go to Active jumps to the state')
        assert.deepEqual((await definition(at(12, 'trigger'))).map(l => l.range), [range(4, 'trigger')], 'a variable reference jumps to its declaration')
        assert.deepEqual((await definition(at(18, 'LIMIT'))).map(l => l.range), [range(8, 'LIMIT')])
        assert.deepEqual((await definition(at(18, 'Off'))).map(l => l.range), [range(19, 'Off')], 'abort to Off jumps to the nested state')
        const references = await connection.sendRequest('textDocument/references', { textDocument: { uri }, position: at(6, 'result'), context: { includeDeclaration: true } })
        assert.deepEqual(references.map(l => l.range).sort((a, b) => a.start.line - b.start.line), [range(6, 'result'), range(12, 'result'), range(21, 'result')])
        console.log('Definition and references: states and variables resolve to exact ranges.')

        // --- Outline ----------------------------------------------------------------------------------
        const symbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri } })
        const Kind = { Module: 2, Namespace: 3, Class: 5, Property: 7, Variable: 13, Constant: 14, Struct: 23 }
        assert.equal(symbols.length, 1, JSON.stringify(symbols.map(s => [s.name, s.kind, s.detail, s.range.start.line])))
        const chart = symbols[0]
        assert.equal(chart.name, 'Audit')
        assert.equal(chart.kind, Kind.Class)
        assert.equal(chart.detail, 'root state 1 region')
        const byName = Object.fromEntries(chart.children.map(child => [child.name, child]))
        assert.deepEqual(Object.keys(byName), ['trigger', 'timeout_update_vals', 'result', 'echoed', 'LIMIT', 'count', 'Idle', 'Active'], 'simple names, nothing unnamed')
        assert.equal(byName.trigger.kind, Kind.Property); assert.equal(byName.trigger.detail, 'input bool')
        assert.equal(byName.result.detail, 'output bool')
        assert.equal(byName.LIMIT.kind, Kind.Constant); assert.equal(byName.LIMIT.detail, 'const int')
        assert.equal(byName.count.kind, Kind.Variable); assert.equal(byName.count.detail, 'int')
        assert.equal(byName.Idle.kind, Kind.Struct); assert.equal(byName.Idle.detail, 'initial state')
        assert.equal(byName.Active.detail, 'state 1 region')
        assert.deepEqual(byName.Idle.selectionRange, range(11, 'Idle'))
        const main = byName.Active.children[0]
        assert.equal(main.name, 'main'); assert.equal(main.kind, Kind.Namespace); assert.equal(main.detail, 'controlflow region, 2 states')
        assert.deepEqual(main.children.map(s => [s.name, s.detail]), [['On', 'initial state'], ['Off', 'final state']])
        console.log('Outline: chart › declarations and states › regions › states, with kinds and details.')
        assert.ok(!/Exception/.test(stderr), stderr)
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
    }
}

main().catch(error => { console.error(error); process.exit(1) })

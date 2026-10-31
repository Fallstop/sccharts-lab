#!/usr/bin/env node
// The KIELER oracle: compiles an SCChart with the real SCCharts language server (the sccharts-lite
// fork of the KIELER server) and simulates it tick by tick, so the guide's in-browser simulator can
// be checked against the official compiler.
//
//   node tools/oracle/oracle.mjs chart.sctx [--ticks 5] [--inputs '[{"A":true},{}]'] [--system netlist|priority] [--raw]
//   node tools/oracle/oracle.mjs --batch scenarios.json        (many charts, one server)
//
// A scenario is { "name"?: string, "file"?: path, "model"?: sctx text, "ticks"?: number,
//                 "inputs"?: [ {var: value}, ... ], "system"?: "netlist" | "priority" }.
// Output (stdout, JSON): one result, or an array for --batch:
//   { name, ok, system, errors: [msg], warnings: [msg], interface: { var: {type, properties} },
//     ticks: [ { step, inputs, values, taken: [fired this tick, per transition], takenTotal, terminated } ],
//     diagnostics?: [LSP diagnostic { severity, message, line, column, source, code }],
//     issues?: [the compiler's structured issues { severity, code, message, hint?, details?, line?, column?, processor }],
//     internalErrors?: [{ message, processor, details }] }
// `internalErrors` are KIELER's crashes ("The compiler failed during ..."): `details` is the exception with its stack
// trace, for diagnosis (`errors` has the same text). The lab server sends the issues; official KIELER does not.
//
// From a script: const oracle = await startOracle(); await oracle.run(scenario); ...; await oracle.stop(), or
// oracle.kill() when the server does not answer (a compilation that never finishes).
// `values` is the full data pool after the tick, without the wall-clock "#ticktime" and without
// the compiler's generated helpers (names starting with "_") unless --raw is given.
//
// Inputs persist between ticks in the KIELER simulator: a value given for tick n stays until changed.
// The oracle sends every tick's inputs explicitly, so pass each tick's full input set if in doubt.
//
// Environment: SCCHARTS_JAVA (java launcher), SCCHARTS_SERVER_JAR (sccharts-lite-server.jar).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import rpc from 'vscode-jsonrpc/node'

const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = rpc
const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_JAVA = '/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin/java'
const DEFAULT_JAR = path.resolve(here, '../../../../kieler-server-fork/server/target/sccharts-lite-server.jar')
export const SYSTEMS = {
    netlist: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c',
    priority: 'de.cau.cs.kieler.sccharts.simulation.tts.priority.c',
}

function sameFile(a, b) {
    try {
        const real = f => { try { return fs.realpathSync.native(f) } catch { return path.resolve(f) } }
        return real(fileURLToPath(a)) === real(fileURLToPath(b))
    } catch { return a === b }
}

/** Starts one language server; `run(scenario)` may be called many times, one at a time. */
export async function startOracle({ java = process.env.SCCHARTS_JAVA ?? DEFAULT_JAVA, jar = process.env.SCCHARTS_SERVER_JAR ?? DEFAULT_JAR, log = () => {} } = {}) {
    if (!fs.existsSync(jar)) throw new Error(`Server JAR not found: ${jar} (set SCCHARTS_SERVER_JAR)`)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-oracle-'))
    const server = spawn(java, ['-Xmx1500m', '-Djava.awt.headless=true', '-cp', jar, 'de.cau.cs.kieler.language.server.LanguageServer'], { cwd: workspace })
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    const diagnostics = new Map()
    connection.onNotification((method, params) => {
        log(method, params)
        if (method === 'textDocument/publishDiagnostics') diagnostics.set(params.uri, params.diagnostics)
        for (const waiter of [...waiters]) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 60000) => new Promise((resolve, reject) => {
        const waiter = {
            method, accept,
            resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) },
            reject: error => { clearTimeout(timer); waiters.delete(waiter); reject(error) },
        }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout waiting for ${method}\n${stderr.slice(-3000)}`)) }, timeout)
        waiters.add(waiter)
    })
    connection.listen()
    await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
    await connection.sendNotification('initialized', {})

    let counter = 0
    async function run(scenario) {
        const name = scenario.name ?? (scenario.file ? path.basename(scenario.file) : `model${counter}`)
        const model = scenario.model ?? fs.readFileSync(scenario.file, 'utf8')
        const systemKey = scenario.system ?? 'netlist'
        const system = SYSTEMS[systemKey] ?? systemKey
        const inputs = scenario.inputs ?? []
        const ticks = Math.max(scenario.ticks ?? 0, inputs.length)
        const dir = path.join(workspace, `m${counter++}`)
        fs.mkdirSync(dir)
        // Imported charts (scenario.imports: { "file.sctx": text }) live next to the model.
        for (const [file, text] of Object.entries(scenario.imports ?? {})) fs.writeFileSync(path.join(dir, file), text)
        const file = path.join(dir, scenario.fileName ?? 'model.sctx')
        fs.writeFileSync(file, model)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: model } })
        const result = { name, ok: false, system: systemKey, errors: [], warnings: [], ticks: [] }
        for (const key of [...diagnostics.keys()]) if (sameFile(key, uri)) diagnostics.delete(key)
        try {
            const compiled = waitFor('keith/kicool/didCompile', r => r.finished && sameFile(r.uri, uri), 120000)
            await connection.sendNotification('keith/kicool/compile', { uri, command: system, clientId: 'oracle', inplace: true, showResultingModel: false, snapshot: false })
            const compile = await compiled
            for (const stage of (compile.results?.files ?? []).flat()) {
                for (const e of stage.errors ?? []) result.errors.push(messageOf(e))
                for (const w of stage.warnings ?? []) result.warnings.push(messageOf(w))
                for (const issue of stage.diagnostics ?? []) {
                    const at = issue.locations?.find(l => l.line >= 0)
                    const entry = { severity: issue.severity, code: issue.code, message: issue.message, processor: stage.name }
                    if (issue.hint) entry.hint = issue.hint
                    if (issue.details) entry.details = issue.details
                    if (at) { entry.line = at.line + 1; entry.column = at.column + 1 }
                    ;(result.issues ??= []).push(entry)
                    if (issue.code === 'internal-compiler-error') (result.internalErrors ??= []).push({ message: issue.message, processor: stage.name, details: issue.details ?? '' })
                }
            }
            // Parse and validation problems arrive as LSP diagnostics, not in the compile result.
            await new Promise(resolve => setTimeout(resolve, 300))
            for (const [key, list] of diagnostics) {
                if (!sameFile(key, uri)) continue
                for (const d of list) {
                    const entry = { severity: d.severity, message: d.message, line: d.range?.start?.line + 1, column: d.range?.start?.character + 1, source: d.source, code: d.code }
                    result.diagnostics = [...(result.diagnostics ?? []), entry]
                    if (d.severity === 1 && !result.errors.includes(d.message)) result.syntaxErrors = [...(result.syntaxErrors ?? []), `${entry.line}:${entry.column} ${d.message}`]
                }
            }
            if (result.syntaxErrors?.length) result.errors.unshift(...result.syntaxErrors)
            if (result.errors.length) return result
            const started = waitFor('keith/simulation/started')
            await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
            const start = await started
            if (!start.successful) { result.errors.push(`simulation did not start: ${start.error ?? JSON.stringify(start)}`); return result }
            for (let i = 0; i < ticks; i++) {
                const values = inputs[i] ?? {}
                const stepped = waitFor('keith/simulation/didStep', () => true, 60000)
                await connection.sendNotification('keith/simulation/step', { valuesForNextStep: values, simulationType: 'Manual' })
                const tick = await stepped
                if (!result.interface && tick.values?.['#interface']) result.interface = publicInterface(tick.values['#interface'], scenario.raw)
                result.ticks.push({
                    step: tick.step,
                    inputs: values,
                    values: clean(tick.values, scenario.raw),
                    // How often each transition fired in this tick (the server counts cumulatively).
                    // The index order is the TTS processor's transition order, not necessarily source order.
                    taken: delta(tick.values?._taken_transitions, result.ticks.at(-1)?.takenTotal),
                    takenTotal: tick.values?._taken_transitions,
                    terminated: tick.values?._TERM,
                })
                if (tick.error) { result.errors.push(`tick ${i + 1}: ${tick.error}`); break }
            }
            result.ok = true
            return result
        } catch (error) {
            result.errors.push(String(error.message ?? error))
            return result
        } finally {
            try { await connection.sendRequest('keith/simulation/stop') } catch {}
            try { await connection.sendNotification('textDocument/didClose', { textDocument: { uri } }) } catch {}
            // Forget this scenario's files: the server resolves `state S is C` against every chart it has
            // indexed, so a later scenario's reference to a common name could otherwise bind to this one.
            try {
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).map(f => pathToFileURL(path.join(dir, f)).href)
                fs.rmSync(dir, { recursive: true, force: true })
                await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: files.map(u => ({ uri: u, type: 3 })) })
            } catch {}
        }
    }
    let stopped = false
    async function stop() {
        if (stopped) return
        stopped = true
        try { await Promise.race([(async () => { await connection.sendRequest('shutdown'); await connection.sendNotification('exit') })(), new Promise(r => setTimeout(r, 3000))]) } catch {}
        setTimeout(() => server.kill(), 2000).unref()
        connection.dispose()
    }
    /** Ends the language server at once (SIGKILL), e.g. while a compilation hangs; every pending run fails. */
    function kill() {
        stopped = true
        try { connection.dispose() } catch {}
        try { server.kill('SIGKILL') } catch {}
        for (const waiter of [...waiters]) waiter.reject(new Error('The language server was killed'))
    }
    return { run, stop, kill, stderr: () => stderr, pid: server.pid }
}

function messageOf(diagnostic) {
    if (typeof diagnostic === 'string') return diagnostic
    return diagnostic.message ?? diagnostic.text ?? JSON.stringify(diagnostic)
}

function delta(total, previous) {
    if (!Array.isArray(total)) return undefined
    return total.map((count, i) => count - (previous?.[i] ?? 0))
}

function publicInterface(iface, raw) {
    const out = {}
    for (const [key, value] of Object.entries(iface)) {
        if (key.startsWith('#') || (!raw && key.startsWith('_'))) continue
        out[key] = value
    }
    return out
}

function clean(pool, raw) {
    const out = {}
    for (const [key, value] of Object.entries(pool ?? {})) {
        if (key === '#ticktime' || key === '#interface') continue
        if (!raw && key.startsWith('_')) continue
        out[key] = value
    }
    return out
}

async function main(argv) {
    const args = { inputs: undefined, ticks: undefined, system: undefined, raw: false, batch: undefined, file: undefined }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--inputs') args.inputs = JSON.parse(argv[++i])
        else if (a === '--ticks') args.ticks = Number(argv[++i])
        else if (a === '--system') args.system = argv[++i]
        else if (a === '--raw') args.raw = true
        else if (a === '--batch') args.batch = argv[++i]
        else if (a === '--verbose') args.verbose = true
        else args.file = a
    }
    const oracle = await startOracle({ log: args.verbose ? (m, p) => console.error(m, JSON.stringify(p).slice(0, 2000)) : undefined })
    try {
        if (args.batch) {
            const scenarios = JSON.parse(fs.readFileSync(args.batch, 'utf8'))
            const base = path.dirname(path.resolve(args.batch))
            const results = []
            for (const s of scenarios) {
                if (s.file && !path.isAbsolute(s.file)) s.file = path.join(base, s.file)
                results.push(await oracle.run({ raw: args.raw, ...s }))
            }
            process.stdout.write(JSON.stringify(results, null, 2) + '\n')
        } else {
            if (!args.file) throw new Error('usage: oracle.mjs chart.sctx [--ticks n] [--inputs json] [--system netlist|priority] [--raw]')
            const result = await oracle.run({ file: args.file, inputs: args.inputs, ticks: args.ticks ?? 3, system: args.system, raw: args.raw })
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        }
    } finally {
        await oracle.stop()
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}

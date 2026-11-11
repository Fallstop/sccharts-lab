// The engine's traces against the SCCharts Lab language server (opt-in, needs Java and the server JAR; one JVM):
//
//   TRACE_SERVER=1 pnpm exec vitest run tests/trace/server-traces.test.ts
//
// For each chart, the server runs it as the extension does (netlist C simulation, Manual steps), and the trace the
// extension would save is built from the server's messages with the extension's rules
// (simulation-table-data-provider.ts: readDataPool, isInternal, currentTrace, the printed lines of each step).
// The engine runs the same inputs; its four files must be the extension's, byte for byte (printed lines included).
// KIELER's own saved trace (keith/simulation/saveTrace) must read back as the engine's run and replay in the engine
// without a mismatch, and the engine's KTrace (the run and its inputs) must load in KIELER (keith/simulation/loadTrace).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import rpc from 'vscode-jsonrpc/node'
import { compile, createSimulation } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'
import {
    inputsOnly, printedOf, readTrace, replayTrace, sameTraceValue, traceFromRun, writeTrace,
    type TraceFormat, type TraceRecord, type TraceRole,
} from '@sccharts-lab/trace'
// @ts-ignore plain JS module
import { defaultJava } from '../../tools/oracle/java.mjs'
import { site } from './recordings'

const ENABLED = !!process.env.TRACE_SERVER
const JAR = process.env.SCCHARTS_SERVER_JAR ?? path.resolve(site, '../../kieler-server-fork/server/target/sccharts-lite-server.jar')
const FORMATS: TraceFormat[] = ['ktrace', 'csv', 'json', 'xml']

/** The extension's test fixture (keith-vscode/test/fixtures/trace-types.sctx) and the inputs its server test uses. */
const TYPES = `scchart TraceTypes {
  input int arr[2]
  input float f
  input string s
  input signal S
  output int sum = 0
  output float g = 0
  output string echo = ""
  output signal T
  int steps = 0

  during do sum = arr[0] + arr[1]; g = f * 2; echo = s; steps++
  during if S do T

  initial state Running
}
`
const TYPES_INPUTS: Record<string, Value>[] = [
    { arr: [1, 2], f: 1.5, s: 'a "quoted", text\twith\\escapes', S: true },
    { S: false },
    { f: 2, arr: [-3, 4] },
    {},
    { s: 'reset', S: true },
]

interface Chart { file: string; text: string; inputs: Record<string, Value>[] }

function scenarioChart(id: string): Chart {
    const base = path.join(site, id)
    const scenario = JSON.parse(fs.readFileSync(`${base}.scenario.json`, 'utf8')) as { ticks: { inputs?: Record<string, Value> }[] }
    return { file: `${path.basename(base)}.sctx`, text: fs.readFileSync(`${base}.sctx`, 'utf8'), inputs: scenario.ticks.map((t) => t.inputs ?? {}) }
}

const CHARTS: Chart[] = ENABLED ? [
    { file: 'trace-types.sctx', text: TYPES, inputs: TYPES_INPUTS },
    scenarioChart('tests/conformance/structure/81-print'),
    { ...scenarioChart('src/examples/advanced/methods/report'), inputs: [{ level: 1 }, { level: 2 }, { level: 3 }, {}] },
    scenarioChart('src/examples/advanced/time/blink-forgetful'),
    scenarioChart('src/examples/learn/variables/greeting'),
    scenarioChart('src/examples/learn/signals/bonus-solution'),
    scenarioChart('src/examples/advanced/data-types/logger'),
    scenarioChart('tests/conformance/structure/130-chart-class-inheritance'),
    scenarioChart('tests/conformance/basics/37-input-written-by-chart'),
] : []

interface Started { successful: boolean; error?: string; dataPool: Record<string, unknown>; propertySet: Record<string, string[]> }
interface Stepped { values: Record<string, unknown>; printed?: string[] }

/** The trace the extension saves after these messages (simulation-table-data-provider.ts). */
function extensionTrace(model: string, start: Started, steps: Stepped[]): TraceRecord {
    // readDataPool: the pool's names, then the ones only #interface declares, with their types.
    const pool = new Map<string, { type?: string }>(Object.keys(start.dataPool).map((id) => [id, {}]))
    const declared = start.dataPool['#interface'] as Record<string, { type?: unknown }> | undefined
    for (const [id, d] of Object.entries(declared ?? {})) if (typeof d?.type === 'string') pool.set(id, { type: d.type })
    const categoriesOf = (id: string) => Object.keys(start.propertySet).filter((key) => start.propertySet[key].includes(id))
    const timeRelated = (id: string) => /^[#_]*deltaT$/i.test(id) || categoriesOf(id).includes('clock')
    const internal = (id: string) =>
        !timeRelated(id) &&
        (['guard', 'term', 'ticktime'].some((c) => categoriesOf(id).includes(c)) || id.includes('_tickCounter') || id.startsWith('_') || id.startsWith('#'))
    const roleOf = (id: string): TraceRole =>
        start.propertySet.input?.includes(id) ? 'input' : start.propertySet.output?.includes(id) ? 'output' : 'local'
    const order: TraceRole[] = ['input', 'output', 'local']
    const ids = [...pool.keys()].filter((id) => id !== '#interface' && !internal(id))
    ids.sort((a, b) => order.indexOf(roleOf(a)) - order.indexOf(roleOf(b)))
    const data = new Map<string, unknown[]>(ids.map((id) => [id, []]))
    for (const step of steps) {
        for (const [id, history] of data) history.push(Object.hasOwn(step.values, id) ? step.values[id] : history.at(-1))
    }
    const printed = printedOf(steps.map((step) => step.printed ?? []))
    return {
        model,
        variables: ids.map((id) => ({ name: id, role: roleOf(id), type: pool.get(id)!.type })),
        ticks: steps.map((_, index) => Object.fromEntries(ids.map((id) => [id, data.get(id)![index]]))),
        ...(printed ? { printed } : {}),
    }
}

describe.skipIf(!ENABLED)('engine traces against the lab server', () => {
    let server: ChildProcess
    let connection: rpc.MessageConnection
    let workspace: string
    const waiters = new Set<{ method: string; accept: (p: any) => boolean; resolve: (p: any) => void }>()
    const waitFor = (method: string, accept: (p: any) => boolean = () => true, timeout = 120000) =>
        new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout: ${method}`)) }, timeout)
            const waiter = { method, accept, resolve: (p: any) => { clearTimeout(timer); waiters.delete(waiter); resolve(p) } }
            waiters.add(waiter)
        })

    beforeAll(async () => {
        expect(fs.existsSync(JAR), `server JAR ${JAR}`).toBe(true)
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-server-'))
        server = spawn(defaultJava(), ['-Xmx1500m', '-Djava.awt.headless=true', '-cp', JAR, 'de.cau.cs.kieler.language.server.LanguageServer'], { cwd: workspace })
        connection = rpc.createMessageConnection(new rpc.StreamMessageReader(server.stdout!), new rpc.StreamMessageWriter(server.stdin!))
        connection.onNotification((method: string, params: any) => {
            for (const waiter of [...waiters]) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
        })
        connection.onRequest('workspace/configuration', (params: any) => params.items.map(() => null))
        connection.onRequest('client/registerCapability', () => null)
        connection.listen()
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
    }, 120000)

    afterAll(async () => {
        try { await Promise.race([connection?.sendRequest('shutdown'), new Promise((r) => setTimeout(r, 3000))]) } catch { /* gone */ }
        connection?.dispose()
        server?.kill('SIGKILL')
        if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
    })

    for (const chart of CHARTS) {
        it(chart.file, async () => {
            const file = path.join(workspace, chart.file)
            fs.writeFileSync(file, chart.text)
            const uri = pathToFileURL(file).href
            await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: chart.text } })
            const compiled = waitFor('keith/kicool/didCompile', (r) => r.finished && fs.realpathSync(new URL(r.uri)) === fs.realpathSync(file))
            await connection.sendNotification('keith/kicool/compile', { uri, command: 'de.cau.cs.kieler.sccharts.simulation.tts.netlist.c', clientId: 'trace-test', inplace: true, showResultingModel: false, snapshot: false })
            await compiled
            const started = waitFor('keith/simulation/started')
            await connection.sendNotification('keith/simulation/start', { uri, simulationType: 'Manual' })
            const start: Started = await started
            expect(start.successful, start.error).toBe(true)
            const steps: Stepped[] = []
            for (const values of chart.inputs) {
                const tick = waitFor('keith/simulation/didStep')
                await connection.sendNotification('keith/simulation/step', { valuesForNextStep: values, simulationType: 'Manual' })
                steps.push(await tick)
            }
            const saved = path.join(workspace, `${chart.file}.ktrace`)
            const save = await connection.sendRequest('keith/simulation/saveTrace', saved)

            const result = compile(chart.text)
            const simulation = createSimulation(result)
            for (const values of chart.inputs) simulation.step(values)
            const engine = traceFromRun(result, simulation, { model: chart.file })
            const extension = extensionTrace(chart.file, start, steps)
            for (const format of FORMATS) expect(writeTrace(engine, format), format).toBe(writeTrace(extension, format))

            expect(save).toEqual({ successful: true, reason: 'Saving successful.' })
            const kieler = readTrace(fs.readFileSync(saved, 'utf8'), 'ktrace')
            expect(kieler.ticks.length).toBe(engine.ticks.length)
            for (const { name, role } of engine.variables.filter((v) => v.role !== 'local')) {
                engine.ticks.forEach((tick, i) => expect(sameTraceValue(kieler.ticks[i][name], tick[name]), `${role} ${name} after tick ${i + 1}`).toBe(true))
            }
            const replayed = replayTrace(result, kieler, { label: 'kieler.ktrace' })
            const writesInputs = chart.file.startsWith('37-')
            if (!writesInputs) expect(replayed.mismatches).toEqual([])

            for (const [name, trace] of [['engine.ktrace', engine], ['engine-inputs.ktrace', inputsOnly(engine)]] as const) {
                const target = path.join(workspace, `${chart.file}-${name}`)
                fs.writeFileSync(target, writeTrace(trace, 'ktrace'))
                const loaded: any = await connection.sendRequest('keith/simulation/loadTrace', target)
                expect(loaded.successful, `${name}: ${loaded.reason}`).toBe(true)
                expect(loaded.trace.ticks.length).toBe(engine.ticks.length)
            }
            await connection.sendRequest('keith/simulation/stop')
            await connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
            fs.rmSync(file)
            await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 3 }] })
        }, 120000)
    }
})

#!/usr/bin/env node
// KIELER's own diagram for a chart, as a reference for the guide's diagram renderer.
//
//   node tools/diagram-reference.mjs chart.sctx [more.sctx ...] [--out dir] [--summary]
//
// Starts the sccharts-lite language server (the KIELER server fork, see tools/oracle), opens each chart,
// requests its diagram with server-side layout (KLighD synthesis + ELK, exactly what the KIELER VS Code
// extension shows; text is measured by the server's AWT fonts) and writes the laid-out sprotty model as
// JSON (<out>/<name>.kieler.json). --summary prints a compact outline instead: every node, edge and label
// with its position, size and text, which is what the diagram tests compare against.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import rpc from 'vscode-jsonrpc/node'

const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = rpc
const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_JAVA = '/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin/java'
const DEFAULT_JAR = path.resolve(here, '../../../kieler-server-fork/server/target/sccharts-lite-server.jar')
const CLIENT = 'keith-diagram_sprotty'

export async function startDiagramServer({ java = process.env.SCCHARTS_JAVA ?? DEFAULT_JAVA, jar = process.env.SCCHARTS_SERVER_JAR ?? DEFAULT_JAR } = {}) {
    if (!fs.existsSync(jar)) throw new Error(`Server JAR not found: ${jar} (set SCCHARTS_SERVER_JAR)`)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-diagram-'))
    const server = spawn(java, ['-Djava.awt.headless=true', '-cp', jar, 'de.cau.cs.kieler.language.server.LanguageServer'], { cwd: workspace })
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    connection.onNotification((method, params) => {
        if (process.env.DIAGRAM_REF_DEBUG) console.error(method, JSON.stringify(params).slice(0, 300))
        for (const waiter of [...waiters]) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept = () => true, timeout = 60000) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timeout waiting for ${method}\n${stderr.slice(-3000)}`)) }, timeout)
        waiters.add(waiter)
    })
    connection.listen()
    await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
    await connection.sendNotification('initialized', {})
    let counter = 0
    async function diagram(text, name = `model${counter}`) {
        const dir = path.join(workspace, `m${counter++}`)
        fs.mkdirSync(dir)
        const file = path.join(dir, `${name}.sctx`)
        fs.writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const ready = waitFor('diagram/accept', m => m.action?.newRoot?.id === uri && m.action.newRoot.children?.[0]?.size?.width > 0)
        await connection.sendNotification('diagram/accept', { clientId: CLIENT, action: { kind: 'requestModel', requestId: 'ref', options: { sourceUri: uri, diagramType: 'keith-diagram', needsClientLayout: false, needsServerLayout: true } } })
        const model = (await ready).action.newRoot
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
        return model
    }
    async function stop() {
        try { await connection.sendRequest('shutdown'); await connection.sendNotification('exit') } catch {}
        setTimeout(() => server.kill(), 2000).unref()
        connection.dispose()
    }
    return { diagram, stop }
}

/** Collects the texts of a KRendering tree. */
function texts(rendering, out = []) {
    if (!rendering) return out
    if (rendering.type === 'KTextImpl' && rendering.text !== undefined) out.push(rendering.text)
    for (const child of rendering.children ?? []) texts(child, out)
    return out
}

export function summarise(element, depth = 0, lines = []) {
    const pad = '  '.repeat(depth)
    const fmt = n => (Math.round(n * 10) / 10)
    const pos = element.position ? `@${fmt(element.position.x)},${fmt(element.position.y)}` : ''
    const size = element.size ? ` ${fmt(element.size.width)}x${fmt(element.size.height)}` : ''
    const data = (element.data ?? []).flatMap(d => texts(d))
    const label = data.length ? JSON.stringify(data.join(' | ')) : element.text !== undefined ? JSON.stringify(element.text) : ''
    let extra = ''
    if (element.type === 'edge') {
        const pts = [element.routingPoints ?? element.junctionPoints ?? []].flat().map(p => `${fmt(p.x)},${fmt(p.y)}`)
        extra = ` ${element.sourceId} -> ${element.targetId} [${pts.join(' ')}]`
    }
    lines.push(`${pad}${element.type} ${pos}${size} ${label}${extra}`)
    for (const child of element.children ?? []) summarise(child, depth + 1, lines)
    return lines
}

async function main(argv) {
    const files = []
    let out = '.'
    let summary = false
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') out = argv[++i]
        else if (argv[i] === '--summary') summary = true
        else files.push(argv[i])
    }
    const server = await startDiagramServer()
    try {
        for (const file of files) {
            const name = path.basename(file, '.sctx')
            const model = await server.diagram(fs.readFileSync(file, 'utf8'), name)
            if (summary) {
                console.log(`== ${file}`)
                console.log(summarise(model).join('\n'))
            } else {
                fs.mkdirSync(out, { recursive: true })
                fs.writeFileSync(path.join(out, `${name}.kieler.json`), JSON.stringify(model, null, 1))
                console.error(`wrote ${path.join(out, `${name}.kieler.json`)}`)
            }
        }
    } finally {
        await server.stop()
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1) })
}

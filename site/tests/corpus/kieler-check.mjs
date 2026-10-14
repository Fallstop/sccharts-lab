#!/usr/bin/env node
// Fast front-end check against the real KIELER language server: opens SCTX texts as in-memory documents
// and collects the diagnostics the server publishes (syntax, linking and validation), without compiling or
// simulating. Used to learn exactly which charts KIELER's parser and validators accept, so the in-browser
// parser can be tested against it (tests/corpus/probes, mutation runs).
//
//   node tests/corpus/kieler-check.mjs file.sctx [...]          (prints JSON per file)
//   node tests/corpus/kieler-check.mjs --json texts.json         ([text, ...] or {name: text}) -> results
//
// API: const server = await startChecker(); await server.check(text, name?) -> [{ kind, severity, line, col,
//      endLine, endCol, message, code }]; await server.stop()
// kind: 'syntax' | 'linking' | 'validation' (severity 'error' | 'warning' | 'info').
//
// Each document gets a unique in-memory URI and is closed again after its diagnostics arrive. Charts in
// one server can still see the root states of documents that are open at the same time, so check() runs
// one document at a time; give charts unique names if linking verdicts matter.
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
const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' }

export async function startChecker({ java = process.env.SCCHARTS_JAVA ?? DEFAULT_JAVA, jar = process.env.SCCHARTS_SERVER_JAR ?? DEFAULT_JAR } = {}) {
    if (!fs.existsSync(jar)) throw new Error(`Server JAR not found: ${jar} (set SCCHARTS_SERVER_JAR)`)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-check-'))
    const server = spawn(java, ['-Djava.awt.headless=true', '-cp', jar, 'de.cau.cs.kieler.language.server.LanguageServer'], { cwd: workspace })
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const pending = new Map()
    connection.onNotification((method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return
        const waiter = pending.get(params.uri)
        if (waiter) waiter(params.diagnostics)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    connection.listen()
    await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
    await connection.sendNotification('initialized', {})

    let counter = 0
    async function check(text, name = 'model') {
        const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '_')
        const uri = pathToFileURL(path.join(workspace, `d${counter++}`, safe.endsWith('.sctx') ? safe : `${safe}.sctx`)).href
        const got = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(uri); reject(new Error(`Timeout waiting for diagnostics\n${stderr.slice(-3000)}`)) }, 60000)
            pending.set(uri, diagnostics => { clearTimeout(timer); pending.delete(uri); resolve(diagnostics) })
        })
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text } })
        const diagnostics = await got
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
        return diagnostics.map(d => {
            const code = String(d.code ?? '')
            const kind = code.endsWith('Diagnostic.Syntax') ? 'syntax' : code.endsWith('Diagnostic.Linking') ? 'linking' : 'validation'
            return {
                kind, severity: SEVERITY[d.severity] ?? 'error',
                line: d.range.start.line + 1, col: d.range.start.character + 1,
                endLine: d.range.end.line + 1, endCol: d.range.end.character + 1,
                message: d.message, code,
            }
        }).sort((a, b) => a.line - b.line || a.col - b.col || a.message.localeCompare(b.message))
    }
    async function stop() {
        try { await connection.sendRequest('shutdown'); await connection.sendNotification('exit') } catch {}
        setTimeout(() => server.kill(), 2000).unref()
        connection.dispose()
        try { fs.rmSync(workspace, { recursive: true, force: true }) } catch {}
    }
    return { check, stop, stderr: () => stderr }
}

/** Runs many texts, using `jobs` servers in parallel. texts: [{ name, text }]. */
export async function checkAll(texts, { jobs = 3, onProgress } = {}) {
    const results = new Array(texts.length)
    let next = 0
    let done = 0
    async function worker() {
        const server = await startChecker()
        try {
            while (next < texts.length) {
                const i = next++
                try {
                    results[i] = await server.check(texts[i].text, texts[i].name)
                } catch (error) {
                    results[i] = { error: String(error.message ?? error) }
                }
                done++
                onProgress?.(done, texts.length)
            }
        } finally {
            await server.stop()
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, texts.length)) }, worker))
    return results
}

async function main(argv) {
    let texts = []
    let jobs = 3
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--json') {
            const data = JSON.parse(fs.readFileSync(argv[++i], 'utf8'))
            texts.push(...(Array.isArray(data) ? data.map((text, n) => typeof text === 'string' ? { name: `t${n}`, text } : text) : Object.entries(data).map(([name, text]) => ({ name, text }))))
        } else if (argv[i] === '--jobs') jobs = Number(argv[++i])
        else texts.push({ name: path.basename(argv[i]), text: fs.readFileSync(argv[i], 'utf8') })
    }
    const results = await checkAll(texts, { jobs })
    process.stdout.write(JSON.stringify(texts.map((t, i) => ({ name: t.name, diagnostics: results[i] })), null, 1) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}

#!/usr/bin/env node
// Records what the real KIELER tools say about every corpus file, so the parser and validator tests can
// check that the in-browser engine accepts and rejects exactly the same charts.
//
//   node tests/corpus/record.mjs                 (all of wiki/, lab/, probes/ and the CS303 files)
//   node tests/corpus/record.mjs probes/x.sctx   (only these files; paths relative to tests/corpus)
//   node tests/corpus/record.mjs --jobs 3
//
// Each file is compiled by its own language server: in one server, a chart can resolve references to
// charts of files opened earlier, which would make the verdicts depend on the order of the files.
// The result is merged into tests/corpus/expectations.json:
//   { "<key>": { syntax: [d], linking: [d], errors: [d], warnings: [d], compileErrors: [msg], ok } }
// with d = { line, col, message }. syntax: lexer and parser errors; linking: unresolved names; errors and
// warnings: KIELER's validators; compileErrors: what the compiler or C simulation reported after that.
// CS303 course files are keyed "cs303:<path below the CS303 folder>" and are never copied here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOracle } from '../../tools/oracle/oracle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CS303 = '/home/fallstop/Documents/projects/CS303'
const EXPECTATIONS = path.join(here, 'expectations.json')
// Verdicts for the CS303 files quote their code (names, suggested rewrites), so they stay out of the repository.
export const CS303_EXPECTATIONS = path.join(here, 'expectations.cs303.json')

export function listCorpus() {
    const files = []
    for (const dir of ['wiki', 'lab', 'probes']) {
        const abs = path.join(here, dir)
        if (!fs.existsSync(abs)) continue
        for (const f of fs.readdirSync(abs).sort()) if (f.endsWith('.sctx')) files.push({ key: `${dir}/${f}`, file: path.join(abs, f) })
    }
    for (const file of listCs303()) files.push({ key: `cs303:${path.relative(CS303, file)}`, file })
    return files
}

export function listCs303() {
    const out = []
    const walk = dir => {
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue
            const p = path.join(dir, e.name)
            if (e.isDirectory()) walk(p)
            else if (e.name.endsWith('.sctx')) out.push(p)
        }
    }
    walk(CS303)
    return out
}

function classify(result) {
    const entry = { syntax: [], linking: [], errors: [], warnings: [], compileErrors: [], ok: false }
    const lspMessages = new Set()
    for (const d of result.diagnostics ?? []) {
        const code = String(d.code ?? '')
        lspMessages.add(d.message)
        if (code.startsWith('org.eclipse.emf')) continue // follow-up of a linking error
        const item = { line: d.line, col: d.column, message: d.message }
        if (code.endsWith('Diagnostic.Syntax')) entry.syntax.push(item)
        else if (code.endsWith('Diagnostic.Linking')) entry.linking.push(item)
        else if (d.severity === 1) entry.errors.push(item)
        else if (d.severity === 2) entry.warnings.push(item)
    }
    for (const e of result.errors ?? []) {
        if (/^\d+:\d+ /.test(e) && lspMessages.has(e.replace(/^\d+:\d+ /, ''))) continue
        if (lspMessages.has(e)) continue
        if (entry.compileErrors.length < 6) entry.compileErrors.push(e.length > 300 ? e.slice(0, 300) + '...' : e)
    }
    const order = (a, b) => a.line - b.line || a.col - b.col || a.message.localeCompare(b.message)
    for (const k of ['syntax', 'linking', 'errors', 'warnings']) entry[k].sort(order)
    entry.ok = result.ok && !entry.syntax.length && !entry.linking.length && !entry.errors.length && !entry.compileErrors.length
    return entry
}

async function main(argv) {
    let jobs = 3
    const only = []
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--jobs') jobs = Number(argv[++i])
        else only.push(argv[i])
    }
    let files = listCorpus()
    if (only.length) {
        files = only.map(f => {
            const key = f.replace(/^tests\/corpus\//, '')
            return key.startsWith('cs303:') ? { key, file: path.join(CS303, key.slice(6)) } : { key, file: path.join(here, key) }
        })
    }
    const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    const expectations = { ...read(EXPECTATIONS), ...read(CS303_EXPECTATIONS) }
    const queue = [...files]
    let done = 0
    async function worker() {
        while (queue.length) {
            const { key, file } = queue.shift()
            let oracle
            try {
                oracle = await startOracle()
                const result = await oracle.run({ file, ticks: 0, fileName: path.basename(file) })
                expectations[key] = classify(result)
            } catch (error) {
                console.error(`${key}: ${error.message}`)
            } finally {
                if (oracle) await oracle.stop()
            }
            done++
            const e = expectations[key]
            console.error(`[${done}/${files.length}] ${key}: ${e ? (e.ok ? 'ok' : `syntax ${e.syntax.length}, linking ${e.linking.length}, errors ${e.errors.length}, compile ${e.compileErrors.length}`) : 'failed'}`)
        }
    }
    await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker))
    const sorted = Object.entries(expectations).sort(([a], [b]) => a.localeCompare(b))
    const write = (file, entries) => fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries), null, 1) + '\n')
    write(EXPECTATIONS, sorted.filter(([key]) => !key.startsWith('cs303:')))
    const cs303 = sorted.filter(([key]) => key.startsWith('cs303:'))
    if (cs303.length) write(CS303_EXPECTATIONS, cs303)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}

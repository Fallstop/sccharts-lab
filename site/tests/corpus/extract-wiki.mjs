#!/usr/bin/env node
// Extracts the SCTX code blocks of the KIELER wiki into tests/corpus/wiki/<page>-<n>.sctx.
//
//   node tests/corpus/extract-wiki.mjs <wiki directory with *.md>
//
// A block is taken when its fence names sct/sctx, or when it names no language and contains "scchart"
// (the wiki writes many SCTX examples as plain ``` blocks). Blocks are written verbatim: some are
// fragments or contain typos, and the corpus records whether KIELER accepts each one.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wiki = process.argv[2]
if (!wiki) throw new Error('usage: extract-wiki.mjs <wiki directory>')
const out = path.join(here, 'wiki')
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (f.endsWith('.sctx')) fs.unlinkSync(path.join(out, f))

const slug = name => name.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
let total = 0
for (const page of fs.readdirSync(wiki).filter(f => f.endsWith('.md')).sort()) {
    const lines = fs.readFileSync(path.join(wiki, page), 'utf8').split(/\r?\n/)
    let n = 0
    for (let i = 0; i < lines.length; i++) {
        const open = /^(\s*)```\s*([\w+-]*)\s*$/.exec(lines[i])
        if (!open) continue
        const indent = open[1].length
        const lang = open[2].toLowerCase()
        const body = []
        let j = i + 1
        for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].slice(Math.min(indent, /^\s*/.exec(lines[j])[0].length)))
        i = j
        const text = body.join('\n') + '\n'
        const isSct = lang === 'sct' || lang === 'sctx' || (lang === '' && /\bscchart\b/.test(text))
        if (!isSct) continue
        n++
        total++
        fs.writeFileSync(path.join(out, `${slug(page)}-${n}.sctx`), text)
    }
}
console.log(`extracted ${total} blocks into ${path.relative(process.cwd(), out)}`)

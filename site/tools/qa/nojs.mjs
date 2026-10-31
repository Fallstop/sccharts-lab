#!/usr/bin/env node
// Pages with JavaScript turned off (docs-internal/QA.md, check 5): every widget frame must still show its
// diagram, and a tour its text. Writes full-page screenshots (1280 light, 390 dark) to --out to look at.
//
//   node tools/qa/nojs.mjs [--url http://127.0.0.1:4330] [--out tests/screenshots/nojs] [/route/ ...]
import fs from 'node:fs'
import path from 'node:path'
import { browser as launch, parseArgs, serve, site } from './common.mjs'

const { opts, rest } = parseArgs()
const list = rest.length ? rest : ['/learn/transitions/', '/reference/notation/', '/patterns/level-crossing/']
const out = path.resolve(site, String(opts.out ?? 'tests/screenshots/nojs'))
fs.mkdirSync(out, { recursive: true })
const server = await serve(opts.url)
const browser = await launch()
let fail = 0
try {
    for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
        const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 }, colorScheme: theme })
        const page = await ctx.newPage()
        for (const r of list) {
            await page.goto(server.base + r, { waitUntil: 'load' })
            const info = await page.evaluate(() => {
                // HowKielerReads frames (.sc-frame--reads) have no diagram by design: their first example and a note.
                const frames = [...document.querySelectorAll('.sc-frame:not(.sc-frame--reads)')]
                return {
                    frames: frames.length,
                    withDiagram: frames.filter((f) => f.querySelector('svg.sc-diagram')).length,
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                }
            })
            const ok = info.frames === info.withDiagram && info.overflow <= 0
            if (!ok) fail++
            const file = path.join(out, `${r.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'index'}-nojs-${theme}-${width}.png`)
            await page.screenshot({ path: file, fullPage: true })
            console.log(`${ok ? 'ok     ' : 'PROBLEM'} ${r} ${theme}-${width}: ${info.withDiagram}/${info.frames} frames with a diagram, overflow ${info.overflow} -> ${path.relative(site, file)}`)
        }
        await ctx.close()
    }
} finally {
    await browser.close()
    server.stop()
}
process.exitCode = fail ? 1 : 0

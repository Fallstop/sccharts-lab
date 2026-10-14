#!/usr/bin/env node
// Phone-width details the page-wide overflow check misses (docs-internal/QA.md, check 5): Markdown tables and
// code blocks that scroll sideways inside themselves at 390 px. Not a failure (they scroll, and wide tables are a
// tab stop), but the list to keep short.
//
//   node tools/qa/phone.mjs [--url http://127.0.0.1:4330] [--width 390]
import { browser as launch, parseArgs, routes, serve } from './common.mjs'

const { opts } = parseArgs()
const width = Number(opts.width ?? 390)
const server = await serve(opts.url)
const browser = await launch()
let tables = 0
let code = 0
try {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } })
    for (const r of routes({ with404: false })) {
        const page = await ctx.newPage()
        await page.goto(server.base + r, { waitUntil: 'load' })
        await page.evaluate(() => document.fonts.ready)
        const res = await page.evaluate(() => ({
            t: [...document.querySelectorAll('.sl-markdown-content table')]
                .filter((e) => e.scrollWidth > e.clientWidth + 1)
                .map((e) => `${e.scrollWidth}/${e.clientWidth} px "${(e.querySelector('th')?.textContent ?? '').trim().slice(0, 24)}"`),
            c: [...document.querySelectorAll('.expressive-code pre')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
        }))
        tables += res.t.length
        code += res.c
        if (res.t.length) console.log(`${r}: ${res.t.join('; ')}`)
        await page.close()
    }
} finally {
    await browser.close()
    server.stop()
}
console.log(`${tables} tables and ${code} code blocks scroll sideways at ${width} px`)

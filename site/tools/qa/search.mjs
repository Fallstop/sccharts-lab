#!/usr/bin/env node
// Pagefind search of the built site (docs-internal/QA.md, check 8): each term must find at least one page, and
// the page named after it must be among the first five results.
//
//   node tools/qa/search.mjs [--url http://127.0.0.1:4330] ["term=/expected/page/" ...]
import { browser as launch, parseArgs, serve } from './common.mjs'

const { opts, rest } = parseArgs()
const queries = (rest.length ? rest : ['abort=/learn/preemption/', 'pre=/learn/pre/', 'causality=/learn/causality/', 'valued signal=/learn/signals/', 'level crossing=/patterns/level-crossing/', 'enum=/advanced/data-types/', 'troubleshooting=/reference/troubleshooting/', 'arbiter=/patterns/arbiter/']).map((q) => {
    const [term, expect] = q.split('=')
    return { term, expect }
})
const server = await serve(opts.url)
const browser = await launch()
let fail = 0
try {
    const page = await browser.newPage()
    await page.goto(server.base + '/', { waitUntil: 'networkidle' })
    for (const { term, expect } of queries) {
        const hits = await page.evaluate(async (t) => {
            const pf = await import('/pagefind/pagefind.js')
            await pf.init()
            const r = await pf.search(t)
            const top = await Promise.all(r.results.slice(0, 5).map((x) => x.data()))
            return { n: r.results.length, top: top.map((d) => d.url) }
        }, term)
        const ok = hits.n > 0 && (!expect || hits.top.includes(expect))
        if (!ok) fail++
        console.log(`${ok ? 'ok     ' : 'PROBLEM'} "${term}": ${hits.n} results; first five: ${hits.top.join(', ')}`)
    }
} finally {
    await browser.close()
    server.stop()
}
process.exitCode = fail ? 1 : 0

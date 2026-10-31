#!/usr/bin/env node
// Every built page in a browser (docs-internal/QA.md, checks 3 to 6), against `astro preview` of dist/:
//  - console errors and warnings, page errors and failed requests, on load and while stepping the first widget;
//  - axe-core (WCAG 2.0, 2.1 and 2.2 A/AA and best practices), on load and again after engaging the first widget;
//  - sideways page scroll, with the elements that stick out;
//  - bytes before interaction (gzip for text, as compressed on the wire; fonts and images as they are), and the
//    bytes the first engagement loads; layout shift on load and on hydration; time from the first pointer on
//    the first widget's Step to its island being live.
// Prints one line per page and configuration and writes the details to --out (JSON). Exit code 1 on any problem
// (the unknown path's own 404 response excepted).
//
//   pnpm build
//   node tools/qa/pages.mjs [--url http://127.0.0.1:4330] [--configs light-1280,dark-390] [--routes /a/,/b/]
//                           [--no-axe] [--no-engage] [--out /tmp/qa-pages.json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { AxeBuilder } from '@axe-core/playwright'
import { browser as launch, parseArgs, routes as allRoutes, serve } from './common.mjs'

const { opts } = parseArgs()
const list = opts.routes ? String(opts.routes).split(',') : allRoutes()
const configs = String(opts.configs ?? 'light-1280,dark-390')
    .split(',')
    .map((c) => ({ name: c, theme: c.split('-')[0], width: Number(c.split('-')[1]) }))
const out = String(opts.out ?? path.join(os.tmpdir(), 'qa-pages.json'))
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length
const axe = async (page) =>
    (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        count: v.nodes.length,
        nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.slice(0, 300) })),
    }))

const server = await serve(opts.url)
const browser = await launch()
const results = []

async function run(route, cfg) {
    const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.width < 600 ? 844 : 900 }, colorScheme: cfg.theme, reducedMotion: 'reduce' })
    await ctx.addInitScript((theme) => {
        try {
            localStorage.setItem('starlight-theme', theme)
        } catch {}
        window.__shifts = []
        new PerformanceObserver((l) => {
            for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts.push(e.value)
        }).observe({ type: 'layout-shift', buffered: true })
    }, cfg.theme)
    const page = await ctx.newPage()
    const r = { route, config: cfg.name, console: [], errors: [], failed: [], bytes: {}, requests: [] }
    let phase = 'load'
    const is404 = route === '/no-such-page/'
    page.on('console', (m) => {
        if (m.type() !== 'error' && m.type() !== 'warning') return
        // The unknown path is meant to answer 404, and Chromium logs that status.
        if (is404 && /status of 404/.test(m.text())) return
        r.console.push({ phase, type: m.type(), text: m.text().slice(0, 300) })
    })
    page.on('pageerror', (e) => r.errors.push({ phase, text: String(e).slice(0, 300) }))
    page.on('requestfailed', (q) => r.failed.push({ phase, url: q.url(), why: q.failure()?.errorText }))
    page.on('response', async (res) => {
        const url = res.url()
        const type = res.request().resourceType()
        if (!url.startsWith(server.base)) return void r.requests.push({ phase, url, type, external: true })
        if (res.status() >= 400 && !is404) r.failed.push({ phase, url, why: `HTTP ${res.status()}` })
        try {
            const body = await res.body()
            r.requests.push({ phase, url: url.slice(server.base.length), type, size: /font|image/.test(type) ? body.length : gz(body) })
        } catch {}
    })
    await page.goto(server.base + route, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    // Late scripts settle: Expressive Code makes overflowing blocks focusable 250 ms after layout, on idle.
    await page.waitForTimeout(1200)
    r.overflow = await page.evaluate(() => {
        const d = document.documentElement
        const over = d.scrollWidth - d.clientWidth
        const wide = []
        if (over > 0)
            for (const el of document.querySelectorAll('body *')) {
                const b = el.getBoundingClientRect()
                if (b.right > d.clientWidth + 1 && b.width > 0 && wide.length < 6) wide.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(b.right)}`)
            }
        return { over, wide }
    })
    r.shiftsLoad = await page.evaluate(() => window.__shifts.reduce((s, v) => s + v, 0))
    if (!opts['no-axe']) r.axe = await axe(page)

    const island = page.locator('astro-island[client="engage"]').first()
    if (!opts['no-engage'] && (await island.count()) > 0) {
        phase = 'engage'
        r.widget = (await island.getAttribute('component-url')).replace(/^.*\/|\..*$/g, '')
        const frame = page.locator('.sc-frame:has(astro-island[client="engage"])').first()
        const step = frame.locator('.sc-simctl__step, button:has-text("Next"), button[type=submit]').first()
        const target = (await step.count()) > 0 ? step : frame
        await target.scrollIntoViewIfNeeded()
        await page.waitForTimeout(300)
        const mark = await page.evaluate(() => window.__shifts.length)
        const t = Date.now()
        await target.hover()
        await page.waitForFunction((el) => !el.hasAttribute('ssr'), await island.elementHandle(), { timeout: 15000 }).catch(() => (r.hydrateTimeout = true))
        r.hydrateMs = Date.now() - t
        await page.waitForTimeout(200)
        if (target === step)
            for (let i = 0; i < 3; i++) {
                if (await step.isEnabled()) await step.click()
                await page.waitForTimeout(150)
            }
        r.shiftsHydrate = await page.evaluate((m) => window.__shifts.slice(m).reduce((s, v) => s + v, 0), mark)
        if (!opts['no-axe']) r.axeAfter = await axe(page)
    }
    for (const q of r.requests) {
        if (q.external || q.phase !== 'load') continue
        const k = { script: 'js', stylesheet: 'css', font: 'font', document: 'html' }[q.type] ?? q.type
        r.bytes[k] = (r.bytes[k] ?? 0) + q.size
    }
    r.bytes.engage = r.requests.filter((q) => q.phase === 'engage' && !q.external).reduce((s, q) => s + q.size, 0)
    r.external = r.requests.filter((q) => q.external).map((q) => q.url)
    r.requests = r.requests.filter((q) => !q.external).map((q) => `${q.phase} ${q.type} ${q.size} ${q.url}`)
    await ctx.close()
    return r
}

let bad = 0
const kb = (n) => ((n ?? 0) / 1024).toFixed(1)
try {
    for (const route of list)
        for (const cfg of configs) {
            let r
            try {
                r = await run(route, cfg)
            } catch (e) {
                r = { route, config: cfg.name, crash: String(e).slice(0, 400) }
            }
            results.push(r)
            const nAxe = [...(r.axe ?? []), ...(r.axeAfter ?? [])].reduce((s, v) => s + v.count, 0)
            const problems = (r.console?.length ?? 0) + (r.errors?.length ?? 0) + (r.failed?.length ?? 0) + nAxe + (r.overflow?.over > 0 ? 1 : 0) + (r.crash ? 1 : 0) + (r.hydrateTimeout ? 1 : 0)
            if (problems) bad++
            console.log(
                `${problems ? 'PROBLEM' : 'ok     '} ${route} ${cfg.name}: console ${r.console?.length ?? '-'}, errors ${r.errors?.length ?? '-'}, failed ${r.failed?.length ?? '-'}, ` +
                    `axe ${(r.axe ?? []).map((v) => v.id).join('+') || 0}/${(r.axeAfter ?? []).map((v) => v.id).join('+') || 0}, overflow ${r.overflow?.over ?? '-'} | ` +
                    `kB js ${kb(r.bytes?.js)} css ${kb(r.bytes?.css)} font ${kb(r.bytes?.font)} html ${kb(r.bytes?.html)} engage ${kb(r.bytes?.engage)} | ` +
                    `hydrate ${r.hydrateMs ?? '-'} ms, CLS ${(r.shiftsLoad ?? 0).toFixed(3)}/${(r.shiftsHydrate ?? 0).toFixed(3)}${r.crash ? ' ' + r.crash : ''}`
            )
            fs.writeFileSync(out, JSON.stringify(results, null, 1))
        }
} finally {
    await browser.close()
    server.stop()
}
console.log(`${results.length} page loads, ${bad} with problems; details in ${out}`)
process.exitCode = bad ? 1 : 0

#!/usr/bin/env node
// Time to interactive of a Sim on a slow phone (docs-internal/QA.md, check 6): Lighthouse's mobile profile
// (150 ms round trip, 1.6 Mbit/s down, 750 kbit/s up, CPU 4x slower), cold cache, 390 px with touch. Reports the
// first paint, then taps the first widget's Step and times hydration and the first tick shown.
//
//   node tools/qa/interactive.mjs [--url http://127.0.0.1:4330] [--route /learn/transitions/] [--fast]
import { browser as launch, parseArgs, serve } from './common.mjs'

const { opts } = parseArgs()
const route = String(opts.route ?? '/learn/transitions/')
const server = await serve(opts.url)
const browser = await launch()
try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    if (!opts.fast) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    }
    let bytes = 0
    cdp.on('Network.loadingFinished', (e) => (bytes += e.encodedDataLength))
    const t0 = Date.now()
    await page.goto(server.base + route, { waitUntil: 'load' })
    const load = Date.now() - t0
    const fcp = await page.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0))
    const loadBytes = bytes
    const frame = page.locator('.sc-frame:has(astro-island[client="engage"])').first()
    const step = frame.locator('.sc-simctl__step').first()
    await step.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    const island = await frame.locator('astro-island[client="engage"]').first().elementHandle()
    const label = frame.locator('.sc-tour__label, .sc-simctl__tick').first()
    const before = (await label.textContent())?.trim()
    const t1 = Date.now()
    await step.tap()
    await page.waitForFunction((el) => !el.hasAttribute('ssr'), island, { timeout: 60000 })
    const hydrated = Date.now() - t1
    await page.waitForFunction(([el, b]) => el.textContent.trim() !== b, [await label.elementHandle(), before], { timeout: 60000 })
    const shown = Date.now() - t1
    console.log(
        `${route} (${opts.fast ? 'no throttling' : 'slow 4G, CPU x4'}): first contentful paint ${fcp} ms, load ${load} ms, ${Math.round(loadBytes / 1024)} kB; ` +
            `tap on Step: island live after ${hydrated} ms, "${before}" became "${(await label.textContent())?.trim()}" after ${shown} ms (${Math.round((bytes - loadBytes) / 1024)} kB more)`
    )
} finally {
    await browser.close()
    server.stop()
}

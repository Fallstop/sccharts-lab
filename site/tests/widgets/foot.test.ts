// The foot of every simulation widget keeps its height while the reader steps (src/components/sim/README.md, "The
// foot"): on the landing page (its chart replays its opening and hands over) and on every guide page with a
// simulation, each widget is engaged and stepped through its whole tour, then in free play (Step, Back, a replay,
// clicks in the timing diagram, Restart the tour, Previous, Take over, Run, Reset). Folded, neither the foot's height
// nor the page's may change. Then the details are unfolded once: stepping may make them taller, never shorter.
//
// Opt-in, because it needs the shared dev server (tools/dev-server.sh) and takes a few minutes:
//
//   FOOT_E2E=1 pnpm exec vitest run tests/widgets/foot.test.ts --silent=false   (prints the widgets covered)
//   SC_DEV_URL=http://127.0.0.1:4321 ...   (default; another dev server: PORT=4381 tools/dev-server.sh)
//   FOOT_WIDTHS=1280,390                   (default; the viewport widths to check every page at)
//   FOOT_PAGES=/learn/transitions/,/       (only these routes)
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchChromium } from '../../tools/chromium.mjs'

const BASE = process.env.SC_DEV_URL ?? 'http://127.0.0.1:4321'
const enabled = !!process.env.FOOT_E2E
const WIDTHS = (process.env.FOOT_WIDTHS ?? '1280,390').split(',').map(Number)

/** Every page of the guide with a simulation widget (drafts too: the dev server serves them). */
function widgetPages(): string[] {
    const root = new URL('../../src/content/docs/', import.meta.url).pathname
    const out: string[] = []
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) walk(p)
            else if (/\.mdx?$/.test(e.name) && /<(Sim|Compare|Predict|Playground)\b/.test(fs.readFileSync(p, 'utf8'))) {
                out.push(`/${path.relative(root, p).replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))
            }
        }
    }
    walk(root)
    return out.sort()
}
const only = process.env.FOOT_PAGES?.split(',')
const PAGES = ['/', ...widgetPages()].filter((p) => !only || only.includes(p))

// The dev server is shared: a WebSocket that never connects keeps Vite's HMR from reloading the page under test.
const noHmr = () => {
    const Real = window.WebSocket
    function Quiet(this: EventTarget, url: string, p?: string) {
        if (!/vite|token/.test(String(url))) return new Real(url, p)
        const quiet = new EventTarget() as EventTarget & { send(): void; close(): void; readyState: number }
        quiet.send = () => {}
        quiet.close = () => {}
        quiet.readyState = 0
        return quiet
    }
    ;(window as unknown as { WebSocket: unknown }).WebSocket = Quiet
}

/** One measurement: after `what`, the foot's height, the page's, and whether a run-time error (which may add its
 *  alert) is showing. */
interface Sample {
    what: string
    foot: number
    doc: number
    exceptional: boolean
}
interface Drive {
    name: string
    folded: Sample[]
    unfolded: Sample[]
    skipped?: string
}

/**
 * Runs in the page: drives the `index`th widget frame through the reader's moves and measures after each one.
 * Kept free of closures over Node values (Playwright serialises it).
 */
async function drive({ index, run }: { index: number; run: boolean }): Promise<Drive> {
    const frame = document.querySelectorAll<HTMLElement>('figure.sc-frame')[index]
    const name = `${frame.querySelector('.sc-frame__name')?.textContent?.trim()} (${[...frame.classList].find((c) => c.startsWith('sc-frame--'))?.slice(10)} ${index})`
    const sim = () => frame.querySelector<HTMLElement>('.sc-sim[data-state="ready"]')
    const out: Drive = { name, folded: [], unfolded: [] }
    if (!sim()) return { ...out, skipped: 'no runnable simulation' }
    const settle = () => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r())), 0))
    const foot = () => sim()!.querySelector<HTMLElement>(':scope > .sc-sim__foot')!
    const shown = (b: Element | null | undefined): b is HTMLButtonElement => !!b && b instanceof HTMLButtonElement && !b.disabled && b.checkVisibility({ visibilityProperty: true })
    const button = (text: string) => [...sim()!.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === text && shown(b))
    let into = out.folded
    const measure = async (what: string) => {
        await settle()
        into.push({ what, foot: foot().getBoundingClientRect().height, doc: document.documentElement.scrollHeight, exceptional: !!sim()!.querySelector('.sc-sim__halted, .sc-sim__failure') })
    }
    const press = async (b: HTMLButtonElement | undefined, what: string) => {
        if (!shown(b)) return false
        b.click()
        await measure(what)
        return true
    }
    const tick = () => Number(sim()!.querySelector('.sc-simctl__tick b')?.textContent ?? 0)
    const clickTick = async (n: number) => {
        const trace = sim()!.querySelector<HTMLElement>('.sc-sim__trace')!
        const hit = trace.querySelector<SVGRectElement>(`.wv-hit[data-tick="${n}"]`)
        if (!hit) return
        const r = hit.getBoundingClientRect()
        trace.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
        await measure(`click tick ${n}`)
    }
    const steps = async (n: number) => {
        for (let i = 0; i < n; i++) await press(sim()!.querySelector<HTMLButtonElement>('.sc-simctl__step') ?? undefined, 'Step')
    }

    await measure('start')
    // The whole tour.
    for (let i = 0; i < 60 && (await press(button('Next'), `Next to ${tick() + 1}`)); i++);
    // Free play (Step at the end of a tour takes over), Back, a replay, the trace.
    await steps(4)
    await press(button('Back one tick'), 'Back')
    await press(button('Back one tick'), 'Back')
    await steps(1)
    await press(button('Back one tick'), 'Back')
    for (const n of [1, 3, tick() + 1]) await clickTick(n)
    // The tour again: Previous, Take over.
    if (await press(button('Restart the guided tour'), 'Restart the guided tour')) {
        await press(button('Next'), 'Next')
        await press(button('Next'), 'Next')
        await press(button('Previous'), 'Previous')
        await press(button('Take over'), 'Take over')
        await steps(2)
    }
    if (run && (await press(button('Run'), 'Run'))) {
        for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 220)).then(() => measure('running'))
        await press(button('Pause'), 'Pause')
    }
    await press(button('Reset'), 'Reset')

    // Unfolded: the details may grow while stepping, never shrink.
    await steps(2)
    const toggle = sim()!.querySelector<HTMLButtonElement>('.sc-foot__toggle')
    if (!shown(toggle)) return { ...out, skipped: 'no Details button after stepping' }
    toggle.click()
    into = out.unfolded
    await measure('unfolded')
    await steps(3)
    await press(button('Back one tick'), 'Back')
    await press(button('Back one tick'), 'Back')
    for (const n of [1, tick() + 2]) await clickTick(n)
    await steps(2)
    // Folded again: the reader's choice is stored, and the next widget must start folded.
    toggle.click()
    await settle()
    return out
}

/** Engages a widget as a reader would (client:engage: the pointer over its frame) and waits for its island. */
async function engage(page: Page, index: number) {
    const ok = await page.evaluate(async (i) => {
        const frame = document.querySelectorAll<HTMLElement>('figure.sc-frame')[i]
        frame.scrollIntoView({ block: 'center' })
        frame.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
        for (let t = 0; t < 300; t++) {
            if (![...frame.querySelectorAll('astro-island')].some((x) => x.hasAttribute('ssr'))) return true
            await new Promise((r) => setTimeout(r, 50))
        }
        return false
    }, index)
    expect(ok, `widget ${index} hydrates`).toBe(true)
}

/** Equal within half a pixel. */
const same = (a: number, b: number) => Math.abs(a - b) < 0.5

function check(d: Drive, where: string) {
    const folded = d.folded.filter((s) => !s.exceptional)
    const changes = folded.filter((s) => !same(s.foot, folded[0].foot) || !same(s.doc, folded[0].doc))
    expect(changes.map((s) => `${s.what}: foot ${folded[0].foot} -> ${s.foot}, page ${folded[0].doc} -> ${s.doc}`), `${where} ${d.name}, folded`).toEqual([])
    const shrinks: string[] = []
    const unfolded = d.unfolded.filter((s) => !s.exceptional)
    unfolded.forEach((s, i) => {
        const before = unfolded[i - 1]
        if (before && (s.foot < before.foot - 0.5 || s.doc < before.doc - 0.5)) shrinks.push(`${s.what}: foot ${before.foot} -> ${s.foot}, page ${before.doc} -> ${s.doc}`)
    })
    expect(shrinks, `${where} ${d.name}, unfolded`).toEqual([])
}

describe.skipIf(!enabled)('the foot of every simulation keeps its height while stepping', () => {
    let browser: Browser
    const covered: string[] = []
    const errors: string[] = []

    beforeAll(async () => {
        browser = await launchChromium()
    })
    afterAll(async () => {
        await browser?.close()
        // What was covered, for the record (the test's output).
        console.log(`Foot heights checked on ${covered.length} widgets:\n${covered.join('\n')}`)
    })

    async function open(route: string, width: number) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
        page.on('pageerror', (e) => errors.push(`${route}: ${e.message}`))
        await page.addInitScript(noHmr)
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 60000 })
        return page
    }

    for (const width of WIDTHS) {
        if (PAGES.includes('/')) {
            it(`landing page at ${width}: the chart replays its opening and hands over without moving anything`, async () => {
                const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' })
                page.on('pageerror', (e) => errors.push(`/: ${e.message}`))
                await page.addInitScript(noHmr)
                // The foot in every frame, counted again from each web font that comes in (a font swap is not a step).
                await page.addInitScript(() => {
                    const w = window as unknown as { feet: { tick: number; foot: number; doc: number; handed: boolean }[] }
                    w.feet = []
                    document.fonts.addEventListener('loadingdone', () => (w.feet.length = 0))
                    document.fonts.ready.then(() => {
                        const sample = () => {
                            const sim = document.querySelector('.sc-hero-chart .sc-sim')
                            const foot = sim?.querySelector(':scope > .sc-sim__foot')
                            if (sim && foot) {
                                w.feet.push({
                                    tick: Number(sim.querySelector('.sc-simctl__tick b')?.textContent),
                                    foot: foot.getBoundingClientRect().height,
                                    doc: document.documentElement.scrollHeight,
                                    handed: !!sim.querySelector('.sc-what__handover:not(.is-off)'),
                                })
                            }
                            if (w.feet.length < 20000) requestAnimationFrame(sample)
                        }
                        requestAnimationFrame(sample)
                    })
                })
                await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
                // The chart hydrates (client:visible) and replays once it is in view: on a phone, after a scroll.
                await page.locator('.sc-hero-chart').scrollIntoViewIfNeeded()
                // The replay starts over at tick 0 and hands over at tick 7.
                await page.waitForFunction(() => {
                    const feet = (window as unknown as { feet: { tick: number; handed: boolean }[] }).feet
                    const from = feet.findIndex((s) => s.tick === 0)
                    return from >= 0 && feet.slice(from).some((s) => s.tick === 7 && s.handed)
                }, null, { timeout: 30000 })
                await page.waitForTimeout(1000)
                const feet = await page.evaluate(() => (window as unknown as { feet: { tick: number; foot: number; doc: number }[] }).feet)
                expect(new Set(feet.map((s) => s.foot)).size, `the foot during the replay (${feet.length} frames)`).toBe(1)
                expect(new Set(feet.map((s) => s.doc)).size, 'the page during the replay').toBe(1)
                const index = await page.evaluate(() => [...document.querySelectorAll('figure.sc-frame')].indexOf(document.querySelector('.sc-hero-chart')!))
                const d = await page.evaluate(drive, { index, run: false })
                check(d, `/ at ${width}`)
                covered.push(`/ at ${width}: ${d.name} (opening replay, ${d.folded.length} moves folded, ${d.unfolded.length} unfolded)`)
                await page.close()
            }, 120000)
        }

        for (const route of PAGES.filter((p) => p !== '/')) {
            it(`${route} at ${width}`, async () => {
                const page = await open(route, width)
                const frames = await page.evaluate(() => [...document.querySelectorAll('figure.sc-frame')].map((f, i) => ({ i, kind: [...f.classList].find((c) => c.startsWith('sc-frame--'))?.slice(10) })))
                let first = true
                for (const { i, kind } of frames) {
                    if (kind === 'sim' || kind === 'compare') {
                        await engage(page, i)
                        const d = await page.evaluate(drive, { index: i, run: first })
                        first = false
                        if (d.skipped) {
                            covered.push(`${route} at ${width}: ${d.name}: ${d.skipped}`)
                            continue
                        }
                        check(d, `${route} at ${width}`)
                        covered.push(`${route} at ${width}: ${d.name} (${d.folded.length} moves folded, ${d.unfolded.length} unfolded)`)
                    } else if (kind === 'predict') {
                        await engage(page, i)
                        const heights = await page.evaluate(async (index) => {
                            const frame = document.querySelectorAll<HTMLElement>('figure.sc-frame')[index]
                            const run = [...frame.querySelectorAll('button')].find((b) => /^(Run and check|Check)$/.test(b.textContent?.trim() ?? ''))
                            if (!run || run.disabled) return []
                            run.click()
                            const settle = () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(undefined)), 0))
                            await settle()
                            const out: number[][] = []
                            const trace = frame.querySelector<HTMLElement>('.sc-predict__trace')
                            for (const hit of trace?.querySelectorAll<SVGRectElement>('.wv-hit') ?? []) {
                                const r = hit.getBoundingClientRect()
                                trace!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
                                await settle()
                                out.push([frame.getBoundingClientRect().height, document.documentElement.scrollHeight])
                            }
                            return out
                        }, i)
                        expect(new Set(heights.map((h) => h.join(' '))).size, `${route} at ${width}: Predict ${i}, clicking ticks`).toBeLessThanOrEqual(1)
                        covered.push(`${route} at ${width}: Predict ${i} (${heights.length} ticks clicked)`)
                    } else if (kind === 'playground') {
                        // The inline playground starts when the reader engages with it; its panel then works as a <Sim>'s.
                        await page.evaluate((index) => document.querySelectorAll<HTMLElement>('figure.sc-frame')[index].querySelector<HTMLElement>('[data-pg-static]')?.focus(), i)
                        // The app's root is the frame itself.
                        await page.waitForFunction((index) => document.querySelectorAll('figure.sc-frame')[index].matches('[data-pg-ready]'), i, { timeout: 60000 })
                        await page.waitForTimeout(1500)
                        const d = await page.evaluate(drive, { index: i, run: true })
                        check(d, `${route} at ${width}`)
                        covered.push(`${route} at ${width}: ${d.name} (${d.folded.length} moves folded, ${d.unfolded.length} unfolded)`)
                    }
                }
                await page.close()
            }, 600000)
        }
    }

    it('no page errors', () => {
        expect(errors).toEqual([])
    })
})

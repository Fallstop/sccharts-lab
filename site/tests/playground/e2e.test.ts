// End-to-end checks of /playground and the inline <Playground> against a running dev server, in Chromium:
// typing a chart, its diagnostics, the live diagram, the simulation and its Rebuild, the cursor link between the
// editor and the diagram, completion, hover cards, examples, share links, and no console errors.
//
// Opt-in, because it needs the shared dev server (tools/dev-server.sh) and a browser. The dev server reloads the page
// whenever an example file is added (the example list is an import.meta.glob), so while the guide's examples are being
// written a run can fail on a reload; run it again.
//
//
//   PLAYGROUND_E2E=1 pnpm exec vitest run tests/playground/e2e.test.ts
//   PLAYGROUND_URL=http://127.0.0.1:4321 ...   (default)
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchChromium } from '../../tools/chromium.mjs'
import { encodeRun, hashForSource } from '../../src/components/playground/share'

const BASE = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4321'
const enabled = !!process.env.PLAYGROUND_E2E

/** Console messages that are not the page's fault: the dev server's own dependency optimiser. */
const IGNORED = [/Outdated Optimize Dep/, /dev-toolbar/, /\[vite\]/]

describe.skipIf(!enabled)('playground in the browser', () => {
    let browser: Browser
    const errors: string[] = []

    async function open(path: string, width = 1280): Promise<Page> {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true })
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
        const page = await ctx.newPage()
        page.on('console', m => {
            if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some(r => r.test(m.text() + m.location().url))) errors.push(`${path}: ${m.text()}`)
        })
        page.on('pageerror', e => errors.push(`${path}: ${e.message}`))
        // The shared dev server reloads pages when it re-optimises dependencies: wait for the app, not for one load.
        await page.goto(BASE + path, { waitUntil: 'commit', timeout: 60000 })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForLoadState('load')
        return page
    }

    /** Replaces the editor's text (select all, then type or paste). */
    async function setSource(page: Page, text: string) {
        await page.locator('.cm-content').first().click()
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Delete')
        await page.evaluate(t => navigator.clipboard.writeText(t), text)
        await page.keyboard.press('Control+v')
    }

    /** Moves the mouse over the character `k` of the first occurrence of `needle` in the editor. */
    async function hoverText(page: Page, needle: string, k: number) {
        const at = await page.evaluate(
            ([needle, k]) =>
                new Promise<{ x: number; y: number }>(resolve => {
                    type View = { state: { doc: { toString(): string } }; dispatch(t: unknown): void; coordsAtPos(p: number): { left: number; right: number; top: number; bottom: number } | null; constructor: { scrollIntoView(p: number, o?: unknown): unknown } }
                    const view = (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: View } }).playground.view
                    const pos = view.state.doc.toString().indexOf(needle as string) + (k as number)
                    view.dispatch({ effects: view.constructor.scrollIntoView(pos, { y: 'center' }) })
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        const c = view.coordsAtPos(pos)!
                        resolve({ x: (c.left + c.right) / 2 + 2, y: (c.top + c.bottom) / 2 })
                    }))
                }),
            [needle, k] as const,
        )
        await page.mouse.move(at.x, at.y)
    }

    const diagramIds = (page: Page, cls = '') =>
        page.$$eval(`[data-pg-stage] svg.sc-pg-svg [data-id]${cls}`, els => els.map(e => e.getAttribute('data-id')!))

    beforeAll(async () => {
        browser = await launchChromium()
    }, 120000)
    afterAll(async () => {
        await browser?.close()
    })

    test('a typed chart: diagnostics, live diagram, simulation, Rebuild with the trace kept', async () => {
        const page = await open('/playground/')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        await setSource(page, 'scchart Lamp {\n  input bool press\n  output bool on = false\n\n  initial state Off\n    if press do on = true go to On\n\n  state On\n    if press do on = false go to Of\n}\n')
        // An unknown target: KIELER's linking error, a squiggle, the problems summary, the diagram still drawn.
        await page.waitForFunction(() => document.querySelector('[data-pg-problems]')?.getAttribute('data-state') === 'error')
        expect(await page.textContent('[data-pg-problems-summary]')).toMatch(/1 error/)
        expect(await page.locator('.cm-lintRange-error').count()).toBeGreaterThan(0)
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Lamp')
        // Fix it with the problem's quick fix (KIELER-style "did you mean"): no problems, the diagram has both states.
        await page.click('[data-pg-problems-toggle]')
        await page.click('.sc-pg-problem__fix')
        expect(await page.locator('.cm-line', { hasText: 'go to Off' }).count()).toBe(1)
        await page.waitForFunction(() => document.querySelector('[data-pg-problems]')?.getAttribute('data-state') === 'ok')
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="Lamp.On"]'))
        expect(await diagramIds(page)).toEqual(expect.arrayContaining(['Lamp', 'Lamp.Off', 'Lamp.On', 'Lamp.Off->1', 'Lamp.On->1']))

        // Simulate: tick 1 (Ctrl+Enter in the editor), then press in tick 2: On is active and the transition was taken.
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+Enter')
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="Lamp.Off"].is-active'))
        await page.locator('[data-pg-sim] .sc-input--bool', { hasText: 'press' }).locator('input').check()
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="Lamp.On"].is-active'))
        expect(await diagramIds(page, '.is-taken')).toContain('Lamp.Off->1')

        // Edit while simulating: the run is kept and Rebuild appears; the interface is unchanged, so the trace is kept.
        await page.locator('.cm-line', { hasText: 'state On' }).click()
        await page.keyboard.press('End')
        await page.keyboard.type(' "lit"')
        await page.waitForSelector('[data-action="rebuild"]:not([hidden])')
        await page.click('[data-action="rebuild"]')
        await page.waitForSelector('[data-action="rebuild"][hidden]', { state: 'attached' })
        expect(await page.textContent('[data-pg-sim] .sc-simctl__tick')).toMatch(/Tick\s*2/)
        expect(await page.textContent('[data-pg-toast]')).toMatch(/replayed/)
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="Lamp.On"].is-active'))
        await page.context().close()
    }, 120000)

    test('a syntax error keeps the last diagram, dimmed with a badge', async () => {
        const page = await open('/playground/')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('\nstate')
        await page.waitForSelector('[data-pg-badge]:not([hidden])')
        expect(await page.$eval('[data-pg-diagram]', el => el.classList.contains('is-stale'))).toBe(true)
        expect(await page.locator('[data-pg-stage] svg.sc-pg-svg').count()).toBe(1)
        await page.keyboard.press('Control+z')
        await page.waitForSelector('[data-pg-badge][hidden]', { state: 'attached' })
        // Another chart typed over it, not parsing yet: the old diagram goes, and the stage waits for the new one.
        await setSource(page, 'scchart Lamp {\n  input bool press\n  initial state Off\n    if press go to')
        await page.waitForSelector('[data-pg-empty]:not([hidden])')
        expect(await page.textContent('[data-pg-empty]')).toBe('The diagram appears once Lamp parses.')
        expect(await page.locator('[data-pg-stage] svg.sc-pg-svg').count()).toBe(0)
        expect(await page.textContent('[data-pg-chart-name]')).toBe('Lamp')
        await page.keyboard.type(' Off\n}\n')
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Lamp')
        expect(await page.isVisible('[data-pg-empty]')).toBe(false)
        // A chart loaded from a link that does not parse: never the chart before it.
        await page.evaluate(h => (location.hash = h), hashForSource('scchart Broken {\n  initial state A\n    if go to A\n}\n'))
        await page.waitForSelector('[data-pg-empty]:not([hidden])')
        expect(await page.locator('[data-pg-stage] svg.sc-pg-svg').count()).toBe(0)
        await page.context().close()
    }, 120000)

    test('the cursor and the diagram are linked both ways; completion and hover', async () => {
        const page = await open('/playground/?example=showcase/abro')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        // Cursor in a state: that state is outlined in the diagram.
        await page.locator('.cm-line', { hasText: 'initial state WaitB' }).click()
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="ABRO.ABO.WaitAB.WaitB"].is-focus'))
        // A click in the diagram selects the source.
        await page.locator('[data-pg-stage] [data-id="ABRO.ABO.Done"]').click()
        expect(await page.evaluate(() => getSelection()?.toString())).toBe('state Done')
        // Completion after `go to` offers the states of the region.
        await page.locator('.cm-line', { hasText: 'if A go to DoneA' }).click()
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await page.keyboard.type('if B go to ')
        await page.waitForSelector('.cm-tooltip-autocomplete')
        const options = await page.$$eval('.cm-tooltip-autocomplete .cm-completionLabel', els => els.map(e => e.textContent))
        expect(options.sort()).toEqual(['DoneA', 'WaitA'])
        await page.keyboard.press('Escape')
        await page.keyboard.press('Control+z')
        // Hover over a signal: its declaration; over a keyword: what it means.
        await hoverText(page, 'if R abort', 3)
        await page.waitForSelector('.cm-tooltip-hover .sc-pg-info', { timeout: 5000 })
        expect(await page.textContent('.cm-tooltip-hover')).toMatch(/input signal R/)
        await page.mouse.move(5, 5)
        await page.waitForSelector('.cm-tooltip-hover', { state: 'detached' })
        await hoverText(page, 'if R abort', 6)
        await page.waitForSelector('.cm-tooltip-hover .sc-pg-info')
        expect(await page.textContent('.cm-tooltip-hover')).toMatch(/strong abort/i)
        await page.context().close()
    }, 120000)

    test('examples load from the menu and from ?example=; share links round-trip', async () => {
        const page = await open('/playground/?example=showcase/stopwatch')
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Stopwatch')
        expect(await page.textContent('[data-pg-title-name]')).toBe('Stopwatch')
        await page.click('[data-pg-examples] summary')
        await page.fill('[data-pg-filter]', 'adder')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Adder')
        expect(new URL(page.url()).searchParams.get('example')).toBe('showcase/adder')

        // Copy link puts the whole source in the hash; opening it shows the same text.
        const source = await page.evaluate(() => (document.querySelector('.cm-content') as HTMLElement & { cmView?: unknown }).innerText)
        await page.click('[data-action="share"]')
        const link = await page.evaluate(() => navigator.clipboard.readText())
        expect(link).toMatch(/\/playground\/#code=/)
        const other = await open(new URL(link).pathname + new URL(link).hash)
        expect(await other.evaluate(() => (document.querySelector('.cm-content') as HTMLElement).innerText)).toBe(source)
        expect(await other.textContent('[data-pg-title-name]')).toBe('Shared chart')
        await other.context().close()

        // A hand-made link works too.
        const third = await open('/playground/' + hashForSource('scchart Tiny {\n  initial state A\n}\n'))
        await third.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Tiny')
        await third.context().close()
        await page.context().close()
    }, 120000)

    test('a link pasted into an open playground opens its chart and its run; the edits are kept', async () => {
        const page = await open('/playground/')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg')
        const text = () => page.evaluate(() => (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString())
        const chart = (name: string) => page.waitForFunction(n => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === n, name)
        // The reader edits the chart, then a link arrives in the same tab (only the hash changes: no reload).
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('\n// my edit')
        const edited = await text()
        await page.evaluate(() => ((window as Window & { marker?: number }).marker = 1))
        const lamp = 'scchart Lamp {\n  input bool press\n  output bool on = false\n  initial state Off\n    if press do on = true go to On\n  state On\n    if press do on = false go to Off\n}\n'
        await page.evaluate(h => (location.hash = h), hashForSource(lamp))
        await chart('Lamp')
        expect(await text()).toBe(lamp)
        expect(await page.textContent('[data-pg-title-name]')).toBe('Shared chart')
        expect(await page.textContent('[data-pg-toast]')).toMatch(/Your edits are kept/)
        // The edits are in the scratch buffer, and Back returns to them, in the same page.
        expect(await page.evaluate(() => localStorage.getItem('sccharts-guide:playground:scratch'))).toBe(edited)
        await page.evaluate(() => history.back())
        await chart('ABRO')
        expect(await text()).toBe(edited)
        // A run link (#code=...&run=...): the run replays as a tour, at the tick shown.
        const run = encodeRun({ ticks: [{ press: false }, { press: true }, { press: false }], at: 2 })
        await page.evaluate(h => (location.hash = h), `${hashForSource(lamp)}&run=${run}`)
        await chart('Lamp')
        await page.waitForSelector('[data-pg-sim] .sc-tour')
        expect(await page.textContent('[data-pg-sim] .sc-tour__label')).toMatch(/^Shared run, tick 2 of 3/)
        expect(await page.$eval('[data-pg-mode] [aria-pressed="true"]', b => b.textContent)).toBe('Shared run')
        await page.waitForFunction(() => !!document.querySelector('[data-pg-stage] [data-id="Lamp.On"].is-active'))
        // A damaged chart link is said so, and the chart stays.
        await page.evaluate(() => (location.hash = '#code=%%%'))
        await page.waitForFunction(() => /its chart could not be read/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        expect(await text()).toBe(lamp)
        // None of this reloaded the page.
        expect(await page.evaluate(() => (window as Window & { marker?: number }).marker)).toBe(1)
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:scratch'))
        await page.context().close()
    }, 120000)

    test('the diagram downloads as a standalone SVG', async () => {
        const page = await open('/playground/?example=showcase/abro')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-svg"]')])
        expect(download.suggestedFilename()).toBe('ABRO.svg')
        const text = await (await download.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8'))
        expect(text).toMatch(/^<\?xml/)
        expect(text).toContain('@font-face')
        expect(text).toContain('data-id="ABRO.ABO"')
        expect(text).not.toMatch(/class="[^"]*\bis-(active|focus|taken)/)
        await page.context().close()
    }, 120000)

    test('phones: tabs, no sideways scrolling', async () => {
        const page = await open('/playground/', 390)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        await page.click('[data-pg-tabs] [data-tab="diagram"]')
        expect(await page.isVisible('[data-pg-stage]')).toBe(true)
        expect(await page.isVisible('[data-pg-editor]')).toBe(false)
        await page.click('[data-pg-tabs] [data-tab="sim"]')
        expect(await page.isVisible('[data-pg-sim]')).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        await page.context().close()
        // The diagram's head keeps the chart's name whole beside its six tools, in the Diagram and the Simulate tab.
        const seat = await open('/playground/?example=advanced/for-regions/seatbelts', 390)
        await seat.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Seatbelts')
        for (const tab of ['diagram', 'sim']) {
            await seat.click(`[data-pg-tabs] [data-tab="${tab}"]`)
            const name = await seat.$eval('[data-pg-chart-name]', e => ({ text: e.textContent, shown: e.clientWidth, needs: e.scrollWidth }))
            expect(name.text).toBe('Seatbelts')
            expect(name.shown, tab).toBeGreaterThanOrEqual(name.needs)
            expect(await seat.locator('.sc-pg__panel--diagram .sc-pg__zoom .sc-pg__tool:visible').count()).toBe(6)
        }
        await seat.context().close()
    }, 120000)

    test('for-region copies: each state active in several copies gets its badge, as in the widgets', async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        page.on('pageerror', e => errors.push(`copies: ${e.message}`))
        await page.goto(BASE + '/playground/?example=advanced/for-regions/seatbelts', { waitUntil: 'commit', timeout: 60000 })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForFunction(() => !!document.querySelector('[data-pg-sim] .sc-simctl__step'))
        for (let i = 0; i < 3; i++) {
            await page.click('[data-pg-sim] .sc-simctl__step')
            await page.waitForFunction(n => document.querySelector('[data-pg-sim] .sc-simctl__tick')?.textContent?.includes(String(n)) ?? true, i + 1)
        }
        await page.waitForFunction(() => document.querySelectorAll('[data-pg-stage] .sc-copy-badge').length === 2)
        expect((await page.locator('[data-pg-stage] .sc-copy-badge text').allTextContents()).sort()).toEqual(['×1', '×3'])
        expect(await page.locator('[data-pg-stage] [data-sc-copies]').evaluateAll(els => els.map(e => e.getAttribute('data-sc-copies')).sort()))
            .toEqual(['active in 1 of 4 copies', 'active in 3 of 4 copies'])
        // The elements' names say it, and so does the outline (with the badge).
        // The elements' names say it per copy, by the region's counter, as the widgets do; and so does the outline,
        // with the badge.
        const named = await page.getAttribute('[data-pg-stage] [data-sc-nav][data-id="Seatbelts.Checking.Fastened"]', 'aria-label')
        expect(named).toBe('final state Fastened, active in 3 of 4 copies (i = 0, 1 and 3), entered in this tick in the copies i = 1 and 3')
        await page.click('[data-action="outline"]')
        const fastened = page.locator('[data-pg-outline] button[data-id="Seatbelts.Checking.Fastened"]')
        expect(await fastened.getAttribute('aria-label')).toBe(named)
        expect(await fastened.locator('.sc-pg-outline__copies').textContent()).toBe('×3')
        await page.close()
    }, 120000)

    test('the inline playground starts at its final size; a click on Step before it is live steps', async () => {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
            page.on('pageerror', e => errors.push(`inline ${width}: ${e.message}`))
            page.on('console', m => {
                if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some(r => r.test(m.text() + m.location().url))) errors.push(`inline ${width}: ${m.text()}`)
            })
            await page.goto(BASE + '/learn/first-chart/', { waitUntil: 'load' })
            const frame = page.locator('.sc-frame--playground').first()
            await frame.scrollIntoViewIfNeeded()
            const boxes = () => frame.evaluate(f => ['.sc-frame__box', '.sc-pg-inline__editor', '.sc-pg-inline__diagram', '[data-pg-sim]', '[data-pg-stage] svg .sc-root'].map(s => {
                const r = f.querySelector(s)!.getBoundingClientRect()
                return [Math.round(r.top), Math.round(r.left), Math.round(r.height), Math.round(r.width)]
            }))
            const before = await boxes()
            // The build-time diagram stands below the zoom buttons.
            const tools = await frame.locator('.sc-pg-inline__tools').boundingBox()
            expect(before[4][0], 'diagram under the tools').toBeGreaterThan(tools!.y + tools!.height)
            // Started (a click on the diagram), nothing has moved: the code, the diagram, the panel, the chart in it.
            await frame.locator('[data-pg-stage]').click({ position: { x: 8, y: 30 } })
            await frame.locator('.cm-content').waitFor({ timeout: 30000 })
            await frame.locator('[data-pg-sim] .sc-sim').waitFor()
            await page.waitForTimeout(400)
            const after = await boxes()
            for (let i = 0; i < before.length; i++) for (let k = 0; k < 4; k++) expect(Math.abs(after[i][k] - before[i][k]), `${width}: part ${i}, ${k}`).toBeLessThanOrEqual(1)
            await page.close()
        }
        // Step pressed before the app is live: held, and made on the live panel's Step.
        const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' })
        await page.goto(BASE + '/learn/first-chart/', { waitUntil: 'load' })
        const frame = page.locator('.sc-frame--playground').first()
        await frame.scrollIntoViewIfNeeded()
        await frame.locator('[data-pg-sim] .sc-simctl__step').click()
        await frame.locator('.cm-content').waitFor({ timeout: 30000 })
        await page.waitForFunction(() => /Tick\s*1/.test(document.querySelector('.sc-frame--playground [data-pg-sim] .sc-simctl__tick')?.textContent ?? ''))
        await frame.locator('[data-pg-stage] .is-active').first().waitFor()
        await page.close()
        // Without JavaScript: the code and the diagram, and a note instead of controls that cannot work.
        const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, javaScriptEnabled: false })
        const plain = await ctx.newPage()
        await plain.goto(BASE + '/learn/first-chart/', { waitUntil: 'load' })
        const still = plain.locator('.sc-frame--playground').first()
        expect(await still.locator('.sc-pg-inline__nojs').isVisible()).toBe(true)
        expect(await still.locator('[data-pg-sim]').isVisible()).toBe(false)
        expect(await still.locator('.sc-pg-inline__tools').isVisible()).toBe(false)
        expect(await still.locator('[data-pg-stage] svg').isVisible()).toBe(true)
        await ctx.close()
    }, 180000)

    test('the inline playground on a page', async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        page.on('pageerror', e => errors.push(`specimen: ${e.message}`))
        await page.goto(BASE + '/design/specimen/', { waitUntil: 'load' })
        const frame = page.locator('.sc-frame--playground').first()
        await frame.scrollIntoViewIfNeeded()
        // Scrolled to, it stays the build-time picture; a click into the code starts it, with the cursor in the editor.
        await page.waitForTimeout(500)
        expect(await frame.locator('.cm-content').count()).toBe(0)
        await frame.locator('[data-pg-static]').click()
        await frame.locator('.cm-content').waitFor({ timeout: 30000 })
        await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'))
        await frame.locator('.sc-simctl__step').click()
        await frame.locator('[data-pg-stage] .is-active').first().waitFor()
        await frame.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('\n// edited')
        await page.waitForFunction(() => document.querySelector('.sc-frame--playground .sc-frame__open')?.getAttribute('href')?.includes('#code='))
        await page.close()
    }, 120000)

    test('a reader tabbing past the inline playground is not caught in its editor', async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        page.on('pageerror', e => errors.push(`specimen tab: ${e.message}`))
        await page.goto(BASE + '/design/specimen/', { waitUntil: 'load' })
        const frame = page.locator('.sc-frame--playground').first()
        await frame.scrollIntoViewIfNeeded()
        const inEditor = () => page.evaluate(() => !!document.activeElement?.classList.contains('cm-content'))
        const doc = () => frame.locator('.cm-content').innerText()
        // Tab onto the build-time code: the app starts and hands the focus to its editor; the next Tab moves on.
        await frame.locator('a.sc-frame__open').focus()
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'), null, { timeout: 30000 })
        const text = await doc()
        await page.keyboard.press('Tab')
        expect(await inEditor()).toBe(false)
        await page.keyboard.press('Shift+Tab')
        expect(await inEditor()).toBe(true)
        await page.keyboard.press('Shift+Tab')
        expect(await inEditor()).toBe(false)
        expect(await doc()).toBe(text)
        // A click into the code: Tab is the editor's again (it indents).
        await frame.locator('.cm-content').click()
        await page.keyboard.press('Tab')
        expect(await inEditor()).toBe(true)
        expect(await doc()).not.toBe(text)
        await page.close()
    }, 120000)

    test('the layout: every lane of the timing diagram in view, a readable diagram, no bundled ELK', async () => {
        const requests: string[] = []
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        const page = await ctx.newPage()
        page.on('request', r => requests.push(r.url()))
        page.on('pageerror', e => errors.push(`layout: ${e.message}`))
        await page.goto(BASE + '/playground/?example=showcase/abro', { waitUntil: 'commit', timeout: 60000 })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForFunction(() => !!document.querySelector('[data-pg-sim] .sc-sim__trace svg'))
        await page.click('[data-pg-sim] .sc-simctl__step')
        // ABRO's trace has 8 lanes (4 signals, 4 regions): the panel shows all of them without scrolling.
        await page.waitForFunction(() => {
            const sim = document.querySelector<HTMLElement>('[data-pg-sim]')!
            return sim.scrollHeight <= sim.clientHeight + 1 && document.querySelectorAll('[data-pg-sim] .sc-sim__trace text').length > 0
        })
        // Lane labels end with the lane's name (after its <title>).
        const lanes = await page.$$eval('[data-pg-sim] .sc-sim__trace svg text', els => els.map(e => e.textContent ?? ''))
        for (const name of ['A', 'B', 'R', 'O', 'state', 'ABO', 'HandleA', 'HandleB']) expect(lanes.some(l => l.endsWith(name)), name).toBe(true)
        // The editor and the diagram open with 62 % of the first screen below the toolbar (and at least 18rem).
        const main = await page.$eval('[data-pg-diagram]', el => el.getBoundingClientRect())
        expect(main.height).toBeGreaterThanOrEqual(Math.max(18 * 16, 0.62 * (900 - main.top - 12)) - 2)
        // The diagram opens whole, fitted in both dimensions, at a zoom whose text can be read (at least 50 %).
        const zoom = Number((await page.textContent('[data-pg-zoom]'))!.replace(/\D/g, ''))
        expect(zoom).toBeGreaterThanOrEqual(50)
        const [stage, svg] = await page.$$eval('[data-pg-stage], [data-pg-stage] svg.sc-pg-svg', els => els.map(e => e.getBoundingClientRect().toJSON() as DOMRect))
        expect(svg.top).toBeGreaterThanOrEqual(stage.top)
        expect(svg.bottom).toBeLessThanOrEqual(stage.bottom)
        expect(svg.left).toBeGreaterThanOrEqual(stage.left)
        expect(svg.right).toBeLessThanOrEqual(stage.right)
        // Dragging the splitter sets a height of one's own; Enter goes back to fitting the content.
        const handle = page.locator('[data-pg-hsplit]')
        await handle.focus()
        await page.keyboard.press('ArrowDown')
        await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-pg-sim]')!.scrollHeight > document.querySelector<HTMLElement>('[data-pg-sim]')!.clientHeight + 1)
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-pg-sim]')!.scrollHeight <= document.querySelector<HTMLElement>('[data-pg-sim]')!.clientHeight + 1)
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:sim-height'))
        // ELK runs in its worker: the page never fetches elkjs's bundled build.
        expect(requests.filter(u => /elk\.bundled/.test(u))).toEqual([])
        expect(requests.some(u => /elk-worker/.test(u))).toBe(true)
        await ctx.close()
    }, 120000)

    test('guided tour or free play', async () => {
        // A guide example with a scenario opens in its tour; the switch leaves it and comes back.
        const page = await open('/playground/?example=learn/actions/during')
        await page.waitForSelector('[data-pg-mode]:not([hidden])')
        const pressed = () => page.$eval('[data-pg-mode] [aria-pressed="true"]', b => b.getAttribute('data-mode'))
        expect(await pressed()).toBe('tour')
        await page.waitForSelector('[data-pg-sim] .sc-tour')
        await page.click('[data-pg-mode] [data-mode="free"]')
        await page.waitForSelector('[data-pg-sim] .sc-tour', { state: 'detached' })
        expect(await pressed()).toBe('free')
        await page.click('[data-pg-mode] [data-mode="tour"]')
        await page.waitForSelector('[data-pg-sim] .sc-tour')
        // Take over inside the panel counts too.
        await page.click('[data-pg-sim] .sc-tour__take')
        await page.waitForFunction(() => document.querySelector('[data-pg-mode] [aria-pressed="true"]')?.getAttribute('data-mode') === 'free')
        await page.context().close()
        // The showcase opens in free play, its tour one click away.
        const abro = await open('/playground/?example=showcase/abro')
        await abro.waitForSelector('[data-pg-mode]:not([hidden])')
        expect(await abro.$eval('[data-pg-mode] [aria-pressed="true"]', b => b.getAttribute('data-mode'))).toBe('free')
        expect(await abro.locator('[data-pg-sim] .sc-tour').count()).toBe(0)
        await abro.context().close()
        // A new chart has no tour.
        const fresh = await open('/playground/' + hashForSource('scchart Tiny {\n  initial state A\n}\n'))
        expect(await fresh.$eval('[data-pg-mode]', el => (el as HTMLElement).hidden)).toBe(true)
        await fresh.context().close()
    }, 120000)

    test("an exercise's task: the TryIt's title and text, a link back to its section, and \"This is still the starter\"", async () => {
        const page = await open('/playground/?example=advanced/annotations/doorbell-start&solution=advanced/annotations/doorbell-solution')
        await page.waitForSelector('[data-pg-task]:not([hidden])')
        expect(await page.textContent('[data-pg-task-title]')).toBe('A diagram that explains itself')
        expect(await page.textContent('[data-pg-task-text]')).toMatch(/^Document the doorbell/)
        expect(await page.$eval('[data-pg-task-back]', a => a.getAttribute('href'))).toBe('/advanced/annotations/#try-it')
        // Comments and labels do not change behaviour: the unchanged starter already "matches", and says so.
        await page.waitForSelector('[data-pg-task-starter]:not([hidden])')
        await page.click('[data-pg-compare] > summary')
        await page.waitForSelector('.sc-pg-compare__result.is-starter')
        expect(await page.textContent('.sc-pg-compare__result')).toMatch(/^This is still the starter\./)
        await page.click('[data-pg-compare] > summary')
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+Home')
        await page.keyboard.type('/** A doorbell. */\n')
        await page.waitForSelector('[data-pg-task-starter]', { state: 'hidden' })
        await page.click('[data-pg-compare] > summary')
        await page.waitForSelector('.sc-pg-compare__result.is-match')
        // The task folds to its title, and stays folded.
        await page.click('[data-pg-task-toggle]')
        expect(await page.$eval('[data-pg-task-toggle]', b => b.getAttribute('aria-expanded'))).toBe('false')
        expect(await page.isVisible('[data-pg-task-text]')).toBe(false)
        expect(await page.evaluate(() => localStorage.getItem('sccharts-guide:playground:task-open'))).toBe('closed')
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:task-open'))
        // Every exercise's link back goes to a section that exists on its page.
        const exercises = JSON.parse((await page.textContent('[data-pg-exercises]'))!) as { href: string; starter: string }[]
        expect(exercises.length).toBeGreaterThan(50)
        const pages = new Map<string, string[]>()
        for (const e of exercises) {
            const [path, anchor] = e.href.split('#')
            pages.set(path, [...(pages.get(path) ?? []), anchor])
        }
        const missing: string[] = []
        const paths = [...pages.keys()]
        for (let i = 0; i < paths.length; i += 6) {
            await Promise.all(paths.slice(i, i + 6).map(async path => {
                const html = await (await page.request.get(BASE + path, { timeout: 60000 })).text()
                for (const anchor of pages.get(path)!) if (!anchor || !html.includes(`id="${anchor}"`)) missing.push(`${path}#${anchor}`)
            }))
        }
        expect(missing).toEqual([])
        await page.context().close()
    }, 240000)

    test('an exercise: compare with the model solution', async () => {
        const page = await open('/playground/?example=learn/actions/stopwatch-start&solution=learn/actions/stopwatch-solution')
        await page.waitForSelector('[data-pg-compare]:not([hidden])')
        await page.click('[data-pg-compare] > summary')
        await page.waitForSelector('.sc-pg-compare__result')
        expect(await page.textContent('.sc-pg-compare__result')).toBe("Your outputs (elapsed, running) match the model solution’s in ticks 1 and 2. In tick 3 your elapsed is 0; the model solution has 1.")
        expect(await page.locator('.sc-pg-compare__ticks .is-different').count()).toBeGreaterThan(0)
        // The solution's source stays hidden until asked for.
        expect(await page.locator('.sc-pg-compare__solution').count()).toBe(0)
        expect(await page.textContent('.sc-pg-compare')).not.toContain('during do elapsed++')
        await page.click('.sc-pg-compare__actions .sc-btn--quiet')
        await page.waitForSelector('.sc-pg-compare__solution pre')
        expect(await page.textContent('.sc-pg-compare__solution')).toContain('during do elapsed++')
        // Fix the starter as the solution does, and compare again.
        const fixed = await page.$eval('.sc-pg-compare__solution pre', el => (el as HTMLElement).innerText)
        await page.click('[data-pg-compare] > summary')
        await setSource(page, fixed)
        await page.waitForFunction(() => document.querySelector('[data-pg-problems]')?.getAttribute('data-state') === 'ok')
        await page.click('[data-pg-compare] > summary')
        await page.waitForFunction(() => document.querySelector('.sc-pg-compare__result')?.classList.contains('is-match'))
        expect(await page.textContent('.sc-pg-compare__result')).toMatch(/match(es)? the model solution[’']s in all 7 ticks/)
        // "Replay the test run": the switch and the panel name the tour alike.
        await page.click('.sc-pg-compare__actions .sc-btn:not(.sc-btn--quiet)')
        await page.waitForSelector('[data-pg-sim] .sc-tour__label')
        const name = await page.$eval('[data-pg-mode] [data-mode="tour"]', b => b.textContent!)
        expect(await page.textContent('[data-pg-sim] .sc-tour__label')).toMatch(new RegExp(`^${name},`))
        // The address bar keeps the exercise.
        await page.waitForFunction(() => new URL(location.href).searchParams.get('solution') === 'learn/actions/stopwatch-solution' && location.hash.startsWith('#code='))
        await page.context().close()
    }, 120000)

    test('the outline: the diagram for the keyboard and screen readers', async () => {
        const page = await open('/playground/?example=showcase/abro')
        await page.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        await page.click('[data-action="outline"]')
        await page.waitForSelector('[data-pg-outline]:not([hidden]) button[data-id="ABRO"]')
        expect(await page.$eval('[data-action="outline"]', b => b.getAttribute('aria-expanded'))).toBe('true')
        const ids = await page.$$eval('[data-pg-outline] button[data-id]', bs => bs.map(b => b.getAttribute('data-id')))
        expect(ids).toEqual(expect.arrayContaining(['ABRO', 'ABRO.ABO', 'ABRO.ABO.WaitAB.WaitA', 'ABRO.ABO.Done', 'ABRO.ABO->1']))
        // Moving through it marks the element in the diagram.
        await page.keyboard.press('ArrowDown')
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.id!)
        await page.waitForFunction(id => !!document.querySelector(`[data-pg-stage] [data-id="${id}"].is-focus`), focused, { timeout: 5000 }).catch(async e => {
            throw new Error(`${e.message}\nfocused ${focused}; marked ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-pg-stage] .is-focus')].map(x => x.getAttribute('data-id'))))}; active ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 100))}`)
        })
        // Enter selects its source.
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => !!document.querySelector('.cm-selectionBackground, .cm-content ::selection') || (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { selection: { main: { empty: boolean } } } } } }).playground.view.state.selection.main.empty === false)
        // The simulation's active states are marked in it too.
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.waitForSelector('[data-pg-outline] button.is-active[data-id="ABRO.ABO.WaitAB.WaitA"]')
        expect(await page.getAttribute('[data-pg-outline] button[data-id="ABRO.ABO.WaitAB.WaitA"]', 'aria-label')).toBe('initial state WaitA, active, entered in this tick')
        await page.locator('[data-pg-outline] button').first().focus()
        await page.keyboard.press('Escape')
        await page.waitForSelector('[data-pg-outline][hidden]', { state: 'attached' })
        expect(await page.evaluate(() => document.activeElement?.getAttribute('data-action'))).toBe('outline')
        await page.context().close()
    }, 120000)

    /** The names of the timing diagram's lanes (each label ends with its lane's name, after its <title>). */
    const lanes = (page: Page) => page.$$eval('[data-pg-sim] .sc-sim__trace svg text', els => els.map(e => e.textContent ?? ''))

    test('variables: the timing diagram follows the check boxes, remembered per chart', async () => {
        const page = await open('/playground/?example=showcase/stopwatch')
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:variables:Stopwatch'))
        await page.waitForFunction(() => !!document.querySelector('[data-pg-sim] .sc-sim__trace svg'))
        expect((await lanes(page)).some(l => l.endsWith('display'))).toBe(true)
        await page.click('[data-pg-vars-toggle]')
        await page.waitForSelector('[data-pg-vars]:not([hidden]) input[value="display"]')
        expect(await page.$eval('[data-pg-vars-toggle]', b => b.getAttribute('aria-expanded'))).toBe('true')
        // Focus goes to the first check box; groups are named.
        expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe('startStop')
        expect(await page.$$eval('[data-pg-vars-list] [role="group"]', gs => gs.map(g => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent))).toEqual(['Inputs', 'Outputs'])
        await page.uncheck('[data-pg-vars] input[value="display"]')
        await page.waitForFunction(() => ![...document.querySelectorAll('[data-pg-sim] .sc-sim__trace svg text')].some(e => e.textContent?.endsWith('display')))
        expect((await page.textContent('[data-pg-vars-count]'))?.trim()).toBe('4 of 5')
        // Remembered for the chart.
        await page.reload({ waitUntil: 'commit' })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForFunction(() => !!document.querySelector('[data-pg-sim] .sc-sim__trace svg'))
        expect((await lanes(page)).some(l => l.endsWith('display'))).toBe(false)
        expect((await lanes(page)).some(l => l.endsWith('time'))).toBe(true)
        // Default brings it back and forgets the choice; Escape closes the strip and returns to its button.
        await page.click('[data-pg-vars-toggle]')
        await page.click('[data-pg-vars] button[data-vars="default"]')
        await page.waitForFunction(() => [...document.querySelectorAll('[data-pg-sim] .sc-sim__trace svg text')].some(e => e.textContent?.endsWith('display')))
        expect(await page.evaluate(() => localStorage.getItem('sccharts-guide:playground:variables:Stopwatch'))).toBeNull()
        await page.focus('[data-pg-vars] input[value="lap"]')
        await page.keyboard.press('Escape')
        await page.waitForSelector('[data-pg-vars][hidden]', { state: 'attached' })
        expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-pg-vars-toggle'))).toBe(true)
        await page.context().close()
    }, 120000)

    test('the watch: an expression in the tick shown, and Run until it holds or a state is active', async () => {
        const page = await open('/playground/?example=learn/actions/stopwatch-solution')
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:watch:Stopwatch'))
        await page.waitForFunction(() => !!document.querySelector('[data-pg-sim] .sc-sim__trace svg'))
        await page.click('[data-pg-mode] [data-mode="free"]')
        await page.click('[data-pg-vars-toggle]')
        const value = () => page.textContent('[data-pg-watch-value]')
        await page.fill('[data-pg-watch-input]', 'elapsed >= 4')
        await page.keyboard.press('Enter')
        expect(await value()).toBe('Run a tick first.')
        // Tick 1, then start (tick 2): Running counts from tick 3.
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.click('[data-pg-sim] .sc-input--bool[data-input="start"] .sc-input__pulse')
        expect(await page.$eval('[data-pg-until]', s => (s as HTMLSelectElement).value)).toBe('watch')
        await page.click('[data-pg-until-run]')
        await page.waitForFunction(() => /^Stopped in tick 6: the watch holds/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        expect(await value()).toBe('In tick 6: true')
        expect(await page.textContent('[data-pg-sim] .sc-simctl__tick')).toMatch(/Tick\s*6/)
        // C's integer division, pre, and what it cannot read.
        await page.fill('[data-pg-watch-input]', 'elapsed / 3 + pre(elapsed)')
        await page.keyboard.press('Enter')
        expect(await value()).toBe('In tick 6: 4')
        await page.fill('[data-pg-watch-input]', 'speed > 1')
        await page.keyboard.press('Enter')
        expect(await value()).toMatch(/^speed is not one of the chart/)
        expect(await page.$eval('[data-pg-watch-input]', i => i.getAttribute('aria-invalid'))).toBe('true')
        // Run until a state is active: stop leaves Running.
        await page.selectOption('[data-pg-until]', { label: 'Stopped is active' })
        await page.click('[data-pg-sim] .sc-input--bool[data-input="stop"] .sc-input__pulse')
        await page.click('[data-pg-until-run]')
        await page.waitForFunction(() => /^Stopped in tick 7: Stopped is active/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        // Remembered for the chart.
        expect(await page.evaluate(() => localStorage.getItem('sccharts-guide:playground:watch:Stopwatch'))).toBe('speed > 1')
        await page.evaluate(() => localStorage.removeItem('sccharts-guide:playground:watch:Stopwatch'))
        await page.context().close()
    }, 120000)

    test('a shared run: the link replays the inputs as a tour, at the tick shown, with Take over', async () => {
        const page = await open('/playground/?example=showcase/abro')
        expect(await page.$eval('[data-action="share-run"]', b => b.getAttribute('aria-disabled'))).toBe('true')
        const pulse = (name: string) => page.click(`[data-pg-sim] .sc-input--bool[data-input="${name}"] .sc-input__pulse`)
        const step = () => page.click('[data-pg-sim] .sc-simctl__step')
        await step()
        await pulse('A')
        await step()
        await pulse('B')
        await step()
        await step()
        await page.click('[data-pg-sim] button[aria-label="Back one tick"]')
        // Tick 3 shown (of 4): O was emitted then.
        const active = () => diagramIds(page, '.is-active')
        const there = (await active()).sort()
        await page.click('[data-action="share-run"]')
        await page.waitForFunction(() => /replays this run/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        expect(await page.textContent('[data-pg-toast]')).toMatch(/replays this run \(4 ticks, opening at tick 3\)\.$/)
        const link = await page.evaluate(() => navigator.clipboard.readText())
        expect(link).toMatch(/\/playground\/\?example=showcase\/abro#run=/)
        const other = await open(new URL(link).pathname + new URL(link).search + new URL(link).hash)
        await other.waitForSelector('[data-pg-sim] .sc-tour')
        expect(await other.textContent('[data-pg-sim] .sc-simctl__tick')).toMatch(/Tick\s*3/)
        expect(await other.$eval('[data-pg-mode] [aria-pressed="true"]', b => b.textContent)).toBe('Shared run')
        // The switch and the panel name the tour alike.
        expect(await other.textContent('[data-pg-sim] .sc-tour__label')).toMatch(/^Shared run, tick 3 of 4/)
        await other.waitForFunction(() => !!document.querySelector('[data-pg-stage] svg.sc-pg-svg [data-id].is-active'))
        expect((await diagramIds(other, '.is-active')).sort()).toEqual(there)
        // The note says what changed and where the other inputs stand.
        expect(await other.textContent('[data-pg-sim] .sc-tour__note')).toBe('In this tick A is absent and B is present; R stays absent.')
        // Take over, in the toast that says what the link does.
        await other.waitForFunction(() => /replays a run of 4 ticks, shown at tick 3/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        await other.click('[data-pg-toast] .sc-pg-toast__action')
        await other.waitForFunction(() => document.querySelector('[data-pg-mode] [aria-pressed="true"]')?.getAttribute('data-mode') === 'free')
        await other.context().close()
        // A damaged run is said so, and the chart opens without it.
        const broken = await open('/playground/?example=showcase/abro#run=xyz')
        await broken.waitForFunction(() => /its run could not be read/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        expect(await broken.locator('[data-pg-sim] .sc-tour').count()).toBe(0)
        await broken.context().close()
        await page.context().close()
    }, 120000)

    test('Compare with the model solution: a chart the guide cannot run is not compared, and says why', async () => {
        const page = await open('/playground/?example=advanced/host-code/gauge&solution=advanced/host-code/gauge-method')
        await page.waitForSelector('[data-pg-compare]:not([hidden])')
        await page.click('[data-pg-compare] > summary')
        const result = page.locator('[data-pg-compare-panel] .sc-pg-compare__result')
        await result.waitFor()
        expect(await result.getAttribute('class')).toMatch(/\bis-unsupported\b/)
        expect(await result.textContent()).toBe('Your chart cannot run in the browser, so it cannot be compared here.')
        expect(await page.textContent('[data-pg-compare-panel] .sc-pg-compare__errors')).toMatch(/^Line 6 This chart uses extern functions, which cannot run in the browser$/)
        expect(await page.locator('[data-pg-compare-panel] .sc-pg-compare__ticks').count()).toBe(0)
        await page.context().close()
    }, 120000)

    test("an example as recorded: KIELER's words, what only KIELER reports, and links to the error reference", async () => {
        const page = await open('/playground/?example=learn/first-chart/err-goto')
        await page.waitForFunction(() => /2 errors, 1 warning/.test(document.querySelector('[data-pg-problems-summary]')?.textContent ?? ''))
        await page.click('[data-pg-problems-toggle]')
        const text = await page.textContent('[data-pg-problems-list]')
        expect(text).toContain("KIELER says no viable alternative at input 'goto'")
        expect(text).toContain("KIELER says mismatched input 'state' expecting 'to'")
        expect(text).not.toMatch(/required feature/)
        expect(await page.$$eval('[data-pg-problems-list] a.sc-pg-about', as => as.map(a => a.getAttribute('href')))).toContain('/reference/errors/#no-viable-alternative-at-input-x')
        // The panel says KIELER rejects it (its recording does).
        expect(await page.textContent('[data-pg-sim] .sc-diag__head')).toMatch(/KIELER rejects this chart/)
        // Edited, it is the reader's chart: only the guide's checker has seen it.
        await page.locator('.cm-line', { hasText: 'state Dim' }).click()
        await page.keyboard.press('End')
        await page.keyboard.type(' ')
        await page.waitForFunction(() => /1 error/.test(document.querySelector('[data-pg-problems-summary]')?.textContent ?? '') && !/2 errors/.test(document.querySelector('[data-pg-problems-summary]')?.textContent ?? ''))
        await page.waitForFunction(() => /guide's checker/.test(document.querySelector('[data-pg-sim] .sc-diag__head')?.textContent ?? ''), undefined, { timeout: 10000 })
        await page.context().close()
    }, 120000)

    test('the diagram from the keyboard: its elements, one tab stop, named with their marks', async () => {
        const page = await open('/playground/?example=showcase/abro')
        await page.waitForSelector('[data-pg-stage] svg[data-sc-keys]')
        await page.focus('[data-pg-stage]')
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('initial superstate ABO')
        await page.keyboard.press('End')
        await page.keyboard.press('Home')
        await page.keyboard.press('ArrowDown')
        const id = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
        await page.waitForFunction(i => !!document.querySelector(`[data-pg-stage] [data-id="${i}"].is-focus`), id)
        // The simulation's marks are in the names.
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.waitForFunction(() => /active/.test(document.querySelector('[data-pg-stage] [data-id="ABRO.ABO"]')?.getAttribute('aria-label') ?? ''))
        // Enter finds the element in the source.
        await page.locator('[data-pg-stage] [data-id="ABRO.ABO.Done"]').focus()
        await page.keyboard.press('Enter')
        expect(await page.evaluate(() => getSelection()?.toString())).toBe('state Done')
        await page.context().close()
        // The inline playground's diagram too.
        const inline = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        inline.on('pageerror', e => errors.push(`specimen keys: ${e.message}`))
        await inline.goto(BASE + '/design/specimen/', { waitUntil: 'load' })
        const frame = inline.locator('.sc-frame--playground').first()
        await frame.scrollIntoViewIfNeeded()
        await frame.locator('[data-pg-stage]').click()
        await frame.locator('[data-pg-stage] svg[data-sc-keys]').waitFor({ timeout: 30000 })
        expect(await frame.locator('[data-pg-stage] [data-sc-nav][tabindex="0"]').count()).toBe(1)
        expect(await frame.locator('[data-pg-stage] svg').getAttribute('role')).toBe('graphics-document')
        await inline.close()
    }, 120000)

    test('no console errors', () => {
        expect(errors).toEqual([])
    })
})

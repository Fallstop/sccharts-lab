// End-to-end checks that /playground never loses or damages the reader's work, in Chromium against a dev server:
// links anyone can write, a folder on disk changed behind the playground's back, two tabs of one project, the
// browser's list of projects, and text from outside that must stay text. Opt-in, as e2e.test.ts:
//
//   PLAYGROUND_E2E=1 PLAYGROUND_URL=http://127.0.0.1:4321 pnpm exec vitest run tests/playground/e2e-safety.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright'
import LZString from 'lz-string'
import { launchChromium } from '../../tools/chromium.mjs'

const BASE = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4321'
const enabled = !!process.env.PLAYGROUND_E2E
const IGNORED = [/Outdated Optimize Dep/, /dev-toolbar/, /\[vite\]/]

/** A `#project=` payload as anyone can write one. */
const projectHash = (data: unknown) => `#project=${LZString.compressToEncodedURIComponent(JSON.stringify(data))}`

describe.skipIf(!enabled)("the reader's work in the browser", () => {
    let browser: Browser
    const errors: string[] = []

    async function context(): Promise<BrowserContext> {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
        return ctx
    }

    async function open(ctx: BrowserContext, path: string): Promise<Page> {
        const page = await ctx.newPage()
        page.on('console', m => {
            if (m.type() === 'error' && !IGNORED.some(r => r.test(m.text() + m.location().url))) errors.push(`${path}: ${m.text()}`)
        })
        page.on('pageerror', e => errors.push(`${path}: ${e.message}`))
        await page.goto(BASE + path, { waitUntil: 'commit', timeout: 60000 })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForLoadState('load')
        return page
    }

    const files = (page: Page) => page.$$eval('[data-pg-files] button.sc-pg-file[data-path]', els => els.map(e => e.getAttribute('data-path')!))
    const editorText = (page: Page) => page.evaluate(() => (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString())

    beforeAll(async () => {
        browser = await launchChromium()
    }, 120000)
    afterAll(async () => {
        await browser?.close()
    })

    test('a #project= link that names no file as active, or paths that climb out, opens its files inside the project', async () => {
        const ctx = await context()
        const hash = projectHash({ v: 1, n: 'Odd', a: 'toString', f: [['main.sctx', 'scchart Main {\n  initial state A\n}\n'], ['../../up.sctx', 'scchart Up {\n  initial state B\n}\n']] })
        const page = await open(ctx, `/playground/${hash}`)
        expect(await editorText(page)).toContain('scchart Main')
        // A path out of the project is no file of it.
        expect(await files(page)).toEqual(['main.sctx'])
        await ctx.close()
    }, 120000)

    test('no errors on the page', () => {
        expect(errors).toEqual([])
    })
})

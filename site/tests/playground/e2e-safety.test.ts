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

    // ----- A folder on disk -------------------------------------------------------------------------------------

    /** A page whose Open folder picks `name` in the origin-private file system, filled with `files`. */
    async function opfsFolder(ctx: BrowserContext, name: string, initial: Record<string, string>): Promise<Page> {
        await ctx.addInitScript(n => {
            ;(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
                (await navigator.storage.getDirectory()).getDirectoryHandle(n, { create: true })
        }, name)
        const page = await open(ctx, '/playground/')
        await page.evaluate(
            async ([n, fs]) => {
                const root = await navigator.storage.getDirectory()
                await root.removeEntry(n, { recursive: true }).catch(() => undefined)
                await root.getDirectoryHandle(n, { create: true })
                for (const [p, t] of Object.entries(fs)) await (window as unknown as { putOpfs: (d: string, p: string, t: string) => Promise<void> }).putOpfs(n, p, t)
            },
            [name, initial] as const,
        )
        await openFolder(page)
        return page
    }

    async function openFolder(page: Page) {
        await page.click('[data-pg-project] > summary')
        await page.click('[data-action="open-folder"]')
        await page.waitForSelector('.sc-pg-files__folder', { state: 'attached' })
        await showFiles(page)
    }

    /** The files sidebar open (a project of one file starts with it closed). */
    async function showFiles(page: Page) {
        if ((await page.getAttribute('[data-sc-playground]', 'data-files')) !== 'open') await page.click('[data-pg-file-tabs] [data-action="toggle-files"]')
        await page.waitForSelector('.sc-pg-files__folder')
    }

    /** Writes or removes (null) a file of an OPFS folder, as another program would. */
    const changeOpfs = (page: Page, dir: string, path: string, text: string | null) =>
        page.evaluate(([d, p, t]) => (t === null ? (window as unknown as { removeOpfs: (d: string, p: string) => Promise<void> }).removeOpfs(d!, p!) : (window as unknown as { putOpfs: (d: string, p: string, t: string) => Promise<void> }).putOpfs(d!, p!, t)), [dir, path, text] as const)
    const readOpfs = (page: Page, dir: string) => page.evaluate(d => (window as unknown as { readOpfs: (d: string) => Promise<Record<string, string>> }).readOpfs(d), dir)

    /** OPFS helpers in every page of the context. */
    async function withOpfs(ctx: BrowserContext) {
        await ctx.addInitScript(() => {
            const at = async (d: string, path: string, create: boolean) => {
                let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d, { create })
                const parts = path.split('/')
                for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create })
                return { dir, name: parts[parts.length - 1] }
            }
            const w = window as unknown as Record<string, unknown>
            w.putOpfs = async (d: string, path: string, text: string) => {
                const { dir, name } = await at(d, path, true)
                const out = await (await dir.getFileHandle(name, { create: true })).createWritable()
                await out.write(text)
                await out.close()
            }
            w.removeOpfs = async (d: string, path: string) => {
                const { dir, name } = await at(d, path, false)
                await dir.removeEntry(name)
            }
            w.readOpfs = async (d: string) => {
                const out: Record<string, string> = {}
                const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
                    for await (const e of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
                        if (e.kind === 'file') out[prefix + e.name] = await (await (e as FileSystemFileHandle).getFile()).text()
                        else await walk(e as FileSystemDirectoryHandle, `${prefix}${e.name}/`)
                    }
                }
                await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(d), '')
                return out
            }
        })
    }

    async function typeAtEnd(page: Page, path: string, text: string) {
        await page.click(`[data-pg-files] button.sc-pg-file[data-path="${path}"]`)
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type(text)
    }

    async function rename(page: Page, from: string, to: string) {
        await page.dblclick(`[data-pg-files] button.sc-pg-file[data-path="${from}"]`)
        await page.waitForFunction(() => document.activeElement?.matches('[data-pg-files] input[data-name]'))
        await page.keyboard.press('Control+a')
        await page.keyboard.type(to)
        await page.keyboard.press('Enter')
        await page.waitForSelector(`[data-pg-files] button.sc-pg-file[data-path="${to.endsWith('.sctx') ? to : `${to}.sctx`}"]`)
    }

    const toast = (page: Page) => page.textContent('[data-pg-toast]')
    async function save(page: Page) {
        await page.evaluate(() => document.querySelector('[data-pg-toast]')?.replaceChildren())
        await page.click('.sc-pg-files__folder .sc-btn')
        await page.waitForFunction(() => /\S/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
    }

    const MAIN = 'scchart Main {\n  initial state A\n}\n'
    const LAMP = 'scchart Lamp {\n  initial state Off\n}\n'

    test('Save never writes over a file changed in the folder since it was read; Overwrite does, when asked', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        const page = await opfsFolder(ctx, 'safety-external', { 'main.sctx': MAIN, 'lamp.sctx': LAMP })
        await typeAtEnd(page, 'main.sctx', '// mine')
        await changeOpfs(page, 'safety-external', 'main.sctx', `${MAIN}// theirs\n`)
        await save(page)
        expect((await readOpfs(page, 'safety-external'))['main.sctx']).toBe(`${MAIN}// theirs\n`)
        expect(await toast(page)).toMatch(/main\.sctx changed in the folder/)
        // The reader's text is still here, unsaved; Overwrite writes it.
        expect(await editorText(page)).toContain('// mine')
        await page.click('[data-pg-toast] .sc-pg-toast__action')
        await page.waitForFunction(() => /^Saved/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        expect((await readOpfs(page, 'safety-external'))['main.sctx']).toContain('// mine')
        await ctx.close()
    }, 120000)

    test('Save never removes a file changed in the folder since it was read (a file renamed or deleted here)', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        const page = await opfsFolder(ctx, 'safety-rename', { 'main.sctx': MAIN, 'lamp.sctx': LAMP })
        await rename(page, 'lamp.sctx', 'light')
        await page.click('[data-pg-files] button.sc-pg-file[data-path="main.sctx"]')
        await page.click('[data-pg-files] button[aria-label="Delete main.sctx"]')
        await changeOpfs(page, 'safety-rename', 'lamp.sctx', `${LAMP}// theirs\n`)
        await changeOpfs(page, 'safety-rename', 'main.sctx', `${MAIN}// theirs\n`)
        await save(page)
        const disk = await readOpfs(page, 'safety-rename')
        expect(disk['lamp.sctx']).toBe(`${LAMP}// theirs\n`)
        expect(disk['main.sctx']).toBe(`${MAIN}// theirs\n`)
        expect(disk['light.sctx']).toBe(LAMP)
        await ctx.close()
    }, 120000)

    test('Save never writes over a file made in the folder since it was read, under a name made here too', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        const page = await opfsFolder(ctx, 'safety-new', { 'main.sctx': MAIN })
        await changeOpfs(page, 'safety-new', 'helper.sctx', 'scchart Theirs {\n  initial state T\n}\n')
        await page.click('[data-pg-files] [data-new-file]')
        await page.keyboard.press('Control+a')
        await page.keyboard.type('helper')
        await page.keyboard.press('Enter')
        await page.waitForSelector('[data-pg-files] button.sc-pg-file[data-path="helper.sctx"]')
        await save(page)
        expect((await readOpfs(page, 'safety-new'))['helper.sctx']).toContain('Theirs')
        await ctx.close()
    }, 120000)

    test('after a reload, Save keeps a file the folder gained meanwhile, an empty one too', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        const page = await opfsFolder(ctx, 'safety-reload', { 'main.sctx': MAIN })
        await typeAtEnd(page, 'main.sctx', '// edited')
        // Saved in the browser (with the folder's handle) after a pause in typing.
        await page.waitForTimeout(800)
        await changeOpfs(page, 'safety-reload', 'empty.sctx', '')
        await changeOpfs(page, 'safety-reload', 'other.sctx', LAMP)
        await page.reload({ waitUntil: 'commit' })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await showFiles(page)
        // Read again from the folder: the file it gained is in the project.
        await page.waitForSelector('[data-pg-files] button.sc-pg-file[data-path="other.sctx"]')
        await save(page)
        const disk = await readOpfs(page, 'safety-reload')
        expect(Object.keys(disk).sort()).toEqual(['empty.sctx', 'main.sctx', 'other.sctx'])
        expect(disk['main.sctx']).toContain('// edited')
        await ctx.close()
    }, 120000)

    test('a rename that changes only the case keeps the file on a disk that ignores case (macOS, Windows)', async () => {
        const ctx = await context()
        await ctx.addInitScript({ path: new URL('./fixtures/mock-folder.js', import.meta.url).pathname })
        await ctx.addInitScript(() => {
            const w = window as unknown as { mockFolder: (f: Record<string, string>, o: object) => unknown; theFolder: unknown; showDirectoryPicker: () => Promise<unknown> }
            w.theFolder = w.mockFolder({ 'abc.sctx': 'scchart Abc {\n  initial state A\n}\n' }, { caseInsensitive: true, name: 'mac' })
            w.showDirectoryPicker = async () => w.theFolder
        })
        const page = await open(ctx, '/playground/')
        await openFolder(page)
        await rename(page, 'abc.sctx', 'ABC')
        await save(page)
        const disk = await page.evaluate(() => (window as unknown as { theFolder: { files(): Record<string, string> } }).theFolder.files())
        expect(Object.values(disk)).toEqual(['scchart Abc {\n  initial state A\n}\n'])
        await ctx.close()
    }, 120000)

    test('no errors on the page', () => {
        expect(errors).toEqual([])
    })
})

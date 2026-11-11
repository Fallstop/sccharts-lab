// End-to-end checks that /playground never loses or damages the reader's work, in Chromium against a dev server:
// links anyone can write, a folder on disk changed behind the playground's back, two tabs of one project, the
// browser's list of projects, and text from outside that must stay text. Opt-in, as e2e.test.ts:
//
//   PLAYGROUND_E2E=1 PLAYGROUND_URL=http://127.0.0.1:4321 pnpm exec vitest run tests/playground/e2e-safety.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright'
import LZString from 'lz-string'
import { launchChromium } from '../../tools/chromium.mjs'
import { hashForSource } from '../../src/components/playground/share'

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

    // ----- The browser's projects ------------------------------------------------------------------------------

    /** Every project stored in this browser (IndexedDB), read directly. */
    const stored = (page: Page) =>
        page.evaluate(
            () =>
                new Promise<{ id: string; name: string; files: Record<string, string>; updated: number; folder?: { disk: Record<string, string> } }[]>(resolve => {
                    const req = indexedDB.open('sccharts-lab-playground')
                    // Not there yet: never make it here (the playground makes it with its store).
                    req.onupgradeneeded = () => req.transaction!.abort()
                    req.onerror = () => resolve([])
                    req.onsuccess = () => {
                        const db = req.result
                        if (!db.objectStoreNames.contains('projects')) return resolve([])
                        const all = db.transaction('projects').objectStore('projects').getAll()
                        all.onsuccess = () => resolve(all.result)
                        db.close()
                    }
                })
        )
    /** Waits until some stored project holds `text`. */
    async function storedWith(page: Page, text: string) {
        for (let i = 0; i < 50; i++) {
            if ((await stored(page)).some(p => Object.values(p.files).some(t => t.includes(text)))) return
            await page.waitForTimeout(100)
        }
        throw new Error(`No stored project holds ${text}`)
    }

    test('a reload right after typing keeps every keystroke, and so does closing the tab', async () => {
        const ctx = await context()
        const page = await open(ctx, '/playground/')
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('// typed')
        await page.waitForTimeout(600)
        // Typed and reloaded at once, before the pause in typing that saves.
        await page.keyboard.type(' then reloaded')
        await page.reload({ waitUntil: 'commit' })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        expect(await editorText(page)).toContain('// typed then reloaded')
        // A project of two files: the other file is in the browser only.
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type(' and closed')
        await page.close({ runBeforeUnload: true })
        const again = await open(ctx, '/playground/')
        expect(await editorText(again)).toContain('// typed then reloaded and closed')
        await ctx.close()
    }, 120000)

    test('Back to another link right after typing, then a reload, at any moment: the edits are always stored by the time the page is back', async () => {
        const ctx = await context()
        const B = 'scchart Bee {\n  initial state B\n}\n'
        const A = 'scchart Ay {\n  initial state A\n}\n'
        const shows = (page: Page, text: string) =>
            page.waitForFunction(t => (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString().includes(t), text)
        const has = async (page: Page, text: string) => (await stored(page)).some(p => Object.values(p.files).some(t => t.includes(text)))
        const page = await open(ctx, `/playground/${hashForSource(B)}`)
        // Back and the reload come at once, during the save Back starts, and after the pause in typing that saves.
        // `waitForB`: the reload comes once the page shows B, or as soon as Back has happened.
        const pauses = [0, 30, 120, 450]
        const runs = [...pauses.flatMap(back => pauses.map(reload => ({ back, reload, waitForB: true }))), ...pauses.map(back => ({ back, reload: 0, waitForB: false }))]
        for (const [n, { back, reload, waitForB }] of runs.entries()) {
            const mark = `// edited A ${n}`
            await page.evaluate(h => (location.hash = h), hashForSource(A).slice(1))
            await shows(page, 'scchart Ay')
            await page.locator('.cm-content').click()
            await page.keyboard.press('Control+End')
            await page.keyboard.type(mark)
            await page.waitForTimeout(back)
            await page.goBack({ waitUntil: 'commit' })
            if (waitForB) await shows(page, 'scchart Bee')
            await page.waitForTimeout(reload)
            await page.reload({ waitUntil: 'commit' })
            await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
            const where = `run ${n} (${back} ms to Back, ${waitForB ? `B shown, ${reload} ms` : 'at once'} to the reload)`
            // No waiting: the page's start has put every save a page going away left unfinished into the store.
            expect(await has(page, mark), where).toBe(true)
            // Once B was shown, the reload opens B; before then it may open A as it was on the screen.
            const text = await editorText(page)
            expect(waitForB ? text.includes('scchart Bee') : text.includes('scchart Bee') || text.includes(mark), where).toBe(true)
        }
        await ctx.close()
    }, 300000)

    test('New, an example, a link or a file opened at once over edits: the edits are saved first, and Undo brings them back', async () => {
        const ctx = await context()
        const page = await open(ctx, '/playground/')
        const typeNow = async (text: string) => {
            await page.locator('.cm-content').click()
            await page.keyboard.press('Control+End')
            await page.keyboard.type(text)
        }
        const undo = async (text: string) => {
            await page.click('[data-pg-toast] .sc-pg-toast__action')
            await page.waitForFunction(t => (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString().includes(t), text)
        }
        // New, right after typing (before the pause that saves).
        await typeNow('// before new')
        await page.click('[data-pg-project] > summary')
        await page.click('[data-action="new"]')
        await storedWith(page, '// before new')
        await undo('// before new')
        // An example from the menu.
        await typeNow(' // before example')
        await page.click('[data-pg-examples] summary')
        await page.fill('[data-pg-filter]', 'adder')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Adder')
        await storedWith(page, '// before example')
        await undo('// before example')
        // A link pasted into the address bar.
        await typeNow(' // before link')
        await page.evaluate(h => (location.hash = h), hashForSource('scchart Linked {\n  initial state L\n}\n').slice(1))
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Linked')
        await storedWith(page, '// before link')
        await undo('// before link')
        // A file opened.
        await typeNow(' // before file')
        await page.setInputFiles('[data-pg-file]', { name: 'opened.sctx', mimeType: 'text/plain', buffer: Buffer.from('scchart Opened {\n  initial state O\n}\n') })
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Opened')
        await storedWith(page, '// before file')
        await undo('// before file')
        await ctx.close()
    }, 120000)

    test('a file deleted in the sidebar comes back with Undo, its text as it was', async () => {
        const ctx = await context()
        const page = await open(ctx, `/playground/${projectHash({ v: 1, n: 'Two', a: 'a.sctx', f: [['a.sctx', 'scchart A {\n  initial state S\n}\n'], ['b.sctx', 'scchart B {\n  initial state T\n}\n']] })}`)
        await typeAtEnd(page, 'b.sctx', '// edited b')
        await page.hover('[data-pg-files] button.sc-pg-file[data-path="b.sctx"]')
        await page.click('[data-pg-files] button[aria-label="Delete b.sctx"]')
        expect(await files(page)).toEqual(['a.sctx'])
        await page.click('[data-pg-toast] .sc-pg-toast__action')
        expect(await files(page)).toEqual(['a.sctx', 'b.sctx'])
        await page.click('[data-pg-files] button.sc-pg-file[data-path="b.sctx"]')
        expect(await editorText(page)).toContain('// edited b')
        await ctx.close()
    }, 120000)

    test('with storage blocked the playground works, and a reload after a pause keeps the edits (in the address)', async () => {
        const ctx = await context()
        await ctx.addInitScript(() => {
            const blocked = () => {
                throw new DOMException('Storage is blocked.', 'SecurityError')
            }
            for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(window, name, { get: blocked, configurable: true })
        })
        const page = await open(ctx, '/playground/')
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('// no storage')
        await page.waitForTimeout(800)
        await page.reload({ waitUntil: 'commit' })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        expect(await editorText(page)).toContain('// no storage')
        await ctx.close()
    }, 120000)

    test('a browser store that is slow to open (a busy machine) still gets every save of the page', async () => {
        const ctx = await context()
        // The page's first opening of the store answers after 2.5 s.
        await ctx.addInitScript(() => {
            const open = IDBFactory.prototype.open
            let first = true
            IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
                const req = open.apply(this, args)
                if (!first) return req
                first = false
                const late: Record<string, ((e: Event) => void) | null> = {}
                const listen = (type: 'success' | 'error') =>
                    req.addEventListener(type, e => {
                        e.stopImmediatePropagation()
                        setTimeout(() => late[type]?.call(req, e), 2500)
                    })
                listen('success')
                listen('error')
                for (const type of ['success', 'error'] as const) Object.defineProperty(req, `on${type}`, { set: f => (late[type] = f), get: () => late[type], configurable: true })
                return req
            }
        })
        const page = await open(ctx, '/playground/')
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('// slow store')
        await page.waitForTimeout(3500)
        await page.keyboard.type(' and later')
        await storedWith(page, '// slow store and later')
        await ctx.close()
    }, 120000)

    test("two tabs of one project: each tab's edits are kept, neither saves over the other's", async () => {
        const ctx = await context()
        const one = await open(ctx, '/playground/')
        await one.locator('.cm-content').click()
        await one.keyboard.press('Control+End')
        await one.keyboard.type('// start')
        await storedWith(one, '// start')
        // A second tab on the bare address opens the same project, the reader's last.
        const two = await open(ctx, '/playground/')
        expect(await editorText(two)).toContain('// start')
        await one.keyboard.type(' one')
        await storedWith(one, '// start one')
        await two.locator('.cm-content').click()
        await two.keyboard.press('Control+End')
        await two.keyboard.type(' two')
        await storedWith(two, '// start two')
        expect(await toast(two)).toMatch(/also changed in another tab/)
        await one.keyboard.type(' more')
        await storedWith(one, '// start one more')
        const texts = (await stored(one)).flatMap(p => Object.values(p.files))
        expect(texts.some(t => t.includes('// start one more'))).toBe(true)
        expect(texts.some(t => t.includes('// start two'))).toBe(true)
        // The project and the copy: a tab's own saves, one after another, never make copies.
        expect(texts).toHaveLength(2)
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
        await page.hover('[data-pg-files] button.sc-pg-file[data-path="main.sctx"]')
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

    test('the browser keeps 40 projects, but never drops a folder project whose edits are not in its folder yet', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        const page = await opfsFolder(ctx, 'safety-keep', { 'main.sctx': MAIN, 'lamp.sctx': LAMP })
        await typeAtEnd(page, 'main.sctx', '// only here')
        await storedWith(page, '// only here')
        // Forty projects edited since, the newest one through the page.
        const since = Math.max(...(await stored(page)).map(p => p.updated))
        await page.evaluate(
            since =>
                new Promise<void>(resolve => {
                    const req = indexedDB.open('sccharts-lab-playground')
                    req.onsuccess = () => {
                        const tx = req.result.transaction('projects', 'readwrite')
                        for (let i = 0; i < 40; i++) tx.objectStore('projects').put({ id: `filler-${i}`, name: `Filler ${i}`, files: { 'f.sctx': 'scchart F {}' }, active: 'f.sctx', open: ['f.sctx'], updated: since + 1 + i })
                        tx.oncomplete = () => resolve()
                    }
                }),
            since,
        )
        await page.click('[data-pg-project] > summary')
        await page.click('[data-action="new"]')
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('// newest')
        await storedWith(page, '// newest')
        await page.waitForTimeout(300)
        const all = await stored(page)
        expect(all.some(p => Object.values(p.files).some(t => t.includes('// only here')))).toBe(true)
        // The rest is trimmed to 40: the oldest filler went.
        expect(all.filter(p => !p.folder)).toHaveLength(40)
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

    test('a Save waiting for the browser\'s permission never writes another project into the folder', async () => {
        const ctx = await context()
        await ctx.addInitScript({ path: new URL('./fixtures/mock-folder.js', import.meta.url).pathname })
        await ctx.addInitScript(() => {
            const w = window as unknown as { mockFolder: (f: Record<string, string>, o: object) => unknown; theFolder: unknown; showDirectoryPicker: () => Promise<unknown> }
            w.theFolder = w.mockFolder({ 'a.sctx': 'scchart Ay {\n  initial state A\n}\n' }, { name: 'mine' })
            w.showDirectoryPicker = async () => w.theFolder
        })
        const page = await open(ctx, '/playground/')
        await openFolder(page)
        await typeAtEnd(page, 'a.sctx', '// edited')
        // The browser asks, and the reader opens another chart before answering.
        await page.evaluate(() => {
            const w = window as unknown as { theFolder: Record<string, unknown>; grant?: () => void }
            w.theFolder.queryPermission = async () => 'prompt'
            w.theFolder.requestPermission = () => new Promise(resolve => (w.grant = () => resolve('granted')))
        })
        await page.click('.sc-pg-files__folder .sc-btn')
        await page.waitForFunction(() => typeof (window as unknown as { grant?: unknown }).grant === 'function')
        await page.evaluate(h => (location.hash = h), hashForSource('scchart Other {\n  initial state O\n}\n').slice(1))
        await page.waitForFunction(() => /scchart Other/.test((document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString()))
        await page.evaluate(() => (window as unknown as { grant: () => void }).grant())
        await page.waitForTimeout(500)
        const disk = await page.evaluate(() => (window as unknown as { theFolder: { files(): Record<string, string> } }).theFolder.files())
        expect(disk).toEqual({ 'a.sctx': 'scchart Ay {\n  initial state A\n}\n' })
        await ctx.close()
    }, 120000)

    test('a folder read as the page starts never goes into a chart opened meanwhile', async () => {
        const ctx = await context()
        await withOpfs(ctx)
        // Reading a folder waits for the test while sessionStorage says so (it survives the reload).
        await ctx.addInitScript(() => {
            if (!sessionStorage.getItem('gate-reads')) return
            const w = window as unknown as { release?: () => void }
            const gate = new Promise<void>(resolve => (w.release = resolve))
            const proto = FileSystemDirectoryHandle.prototype as unknown as { values: () => AsyncIterable<unknown> }
            const values = proto.values
            proto.values = async function* (this: FileSystemDirectoryHandle) {
                await gate
                yield* values.call(this)
            } as unknown as () => AsyncIterable<unknown>
        })
        const page = await opfsFolder(ctx, 'safety-late-read', { 'main.sctx': MAIN, 'only-here.sctx': LAMP })
        await typeAtEnd(page, 'main.sctx', '// edited')
        await page.waitForTimeout(800)
        // The folder gains a file while the page is away: read at start, it would come into the project.
        await changeOpfs(page, 'safety-late-read', 'new-there.sctx', LAMP)
        await page.evaluate(() => sessionStorage.setItem('gate-reads', '1'))
        await page.reload({ waitUntil: 'commit' })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForFunction(() => typeof (window as unknown as { release?: unknown }).release === 'function')
        const OTHER = 'scchart Other {\n  initial state O\n}\n'
        await page.evaluate(h => (location.hash = h), hashForSource(OTHER).slice(1))
        await page.waitForFunction(() => /scchart Other/.test((document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString()))
        await page.evaluate(() => (window as unknown as { release: () => void }).release())
        await page.waitForTimeout(500)
        expect(await editorText(page)).toBe(OTHER)
        const paths = await page.evaluate(() => (document.querySelector('[data-sc-playground]') as HTMLElement & { playground: { project: { texts(): Record<string, string> } } }).playground.project.texts())
        expect(Object.keys(paths)).not.toContain('only-here.sctx')
        expect(Object.keys(paths)).not.toContain('new-there.sctx')
        await ctx.close()
    }, 120000)

    test("the Trace tab's Save in folder never writes over a file there, however many the folder holds", async () => {
        const ctx = await context()
        await ctx.addInitScript({ path: new URL('./fixtures/mock-folder.js', import.meta.url).pathname })
        await ctx.addInitScript(() => {
            const files: Record<string, string> = { 'lamp.sctx': 'scchart Lamp {\n  input bool press\n  output bool lit = false\n  initial state Off\n    if press do lit = true go to On\n  state On\n}\n' }
            for (let i = 0; i < 200; i++) files[`old-${String(i).padStart(3, '0')}.csv`] = 'tick\n'
            files['Lamp-run.csv'] = 'precious'
            const w = window as unknown as { mockFolder: (f: Record<string, string>, o: object) => unknown; theFolder: unknown; showDirectoryPicker: () => Promise<unknown> }
            w.theFolder = w.mockFolder(files, { name: 'runs' })
            w.showDirectoryPicker = async () => w.theFolder
        })
        const page = await open(ctx, '/playground/')
        await openFolder(page)
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.click('[data-pg-panel-tabs] [data-panel-tab="trace"]')
        await page.selectOption('.sc-pg-trace select', 'csv')
        await page.click('.sc-pg-trace__group button:has-text("Save in folder")')
        await page.waitForFunction(() => /^Saved Lamp-run/.test(document.querySelector('[data-pg-toast]')?.textContent ?? ''))
        const disk = await page.evaluate(() => (window as unknown as { theFolder: { files(): Record<string, string> } }).theFolder.files())
        expect(disk['Lamp-run.csv']).toBe('precious')
        expect(disk['Lamp-run-2.csv']).toMatch(/^tick,/)
        await ctx.close()
    }, 120000)

    // ----- Text from outside stays text ----------------------------------------------------------------------

    test("a chart from a link: its labels, comments, strings and what it prints are shown as text everywhere", async () => {
        const ctx = await context()
        const bad = (n: number) => `<img src=x data-pwn onerror=window.__pwned=${n}>`
        const chart = [
            `/** ${bad(1)} [x](javascript:window.__pwned=2) */`,
            'scchart Evil {',
            '  input bool press',
            `  output string s = "${bad(3)}"`,
            `  initial state A "${bad(4)}"`,
            `    if press do s = "\`</code>${bad(5)}"; print("${bad(6)}") go to B label "${bad(7)}"`,
            `  state B "</title></text></svg>${bad(8)}"`,
            '}',
            '',
        ].join('\n')
        const page = await open(ctx, `/playground/${hashForSource(chart)}`)
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Evil')
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.locator('[data-pg-sim] .sc-input--bool', { hasText: 'press' }).locator('input').check()
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.waitForFunction(() => /Tick\s*2/.test(document.querySelector('[data-pg-sim] .sc-simctl__tick')?.textContent ?? ''))
        await page.click('[data-action="outline"]')
        for (const tab of ['console', 'c', 'problems', 'trace']) {
            await page.click(`[data-pg-panel-tabs] [data-panel-tab="${tab}"]`)
            await page.waitForTimeout(300)
        }
        await page.waitForFunction(() => /Evil/.test(document.querySelector('.sc-pg-c__code .cm-content')?.textContent ?? ''))
        expect(await page.locator('.sc-pg-console__lines li').first().textContent()).toContain(bad(6))
        await page.waitForTimeout(300)
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
        expect(await page.locator('[data-pwn]').count()).toBe(0)
        await ctx.close()
    }, 120000)

    test('no errors on the page', () => {
        expect(errors).toEqual([])
    })
})

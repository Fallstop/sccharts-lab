// End-to-end checks of the embed in Chromium: a page on another origin (a server this test starts) embeds a chart as
// an iframe and as <sccharts-lab-chart>, drives it with postMessage and the element's methods (ABRO: O once A and B
// have come), and follows its events; the frame takes its content's height; the keyboard reaches the chart from the
// page; a phone's width scrolls nothing sideways; nothing logs an error; the embed leaves the reader's own playground
// storage alone; and the playground's Embed dialog writes the code.
//
// Opt-in, as tests/playground/e2e.test.ts: it needs a dev server and a browser.
//
//   EMBED_E2E=1 pnpm exec vitest run tests/embed/e2e.test.ts
//   EMBED_URL=http://127.0.0.1:4351 ...        (the dev server; default PLAYGROUND_URL, else :4321)
//   EMBED_HOST_PORT=4352 ...                   (the other origin's port)
import fs from 'node:fs'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, BrowserContext, Frame, Page } from 'playwright'
import { launchChromium } from '../../tools/chromium.mjs'
import { hashForSource } from '../../src/components/playground/share'

const BASE = (process.env.EMBED_URL ?? process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '')
const PORT = Number(process.env.EMBED_HOST_PORT ?? 4352)
const HOST = `http://127.0.0.1:${PORT}`
const enabled = !!process.env.EMBED_E2E

/** The dev server's own noise, not the page's (and the 404 of a test's missing file). */
const IGNORED = [/Outdated Optimize Dep/, /\[vite\]/, /dev-toolbar/, /nothing-here\.sctx/]

const ABRO = `scchart ABRO {
  input signal A, B, R
  output signal O
  initial state ABO {
    initial state WaitAB {
      region HandleA:
        initial state WaitA
          if A go to DoneA
        final state DoneA
      region HandleB:
        initial state WaitB
          if B go to DoneB
        final state DoneB
    }
    do O join to Done
    state Done
  }
  if R abort to ABO
}
`
const TOGGLE = `scchart Toggle {
  input bool button
  output bool on = false

  initial state Off
    if button do on = true go to On

  state On
    if button do on = false go to Off
}
`
const EXAMPLES = new URL('../../src/examples/advanced/references/', import.meta.url)
const MAIN = fs.readFileSync(new URL('import-main.sctx', EXAMPLES), 'utf8')
const SWITCH = fs.readFileSync(new URL('push-switch.sctx', EXAMPLES), 'utf8')
const LAMP = 'scchart Lamp {\n  input bool press\n  output bool lit = false\n  initial state Dark\n    if press do lit = true go to Lit\n  state Lit\n}\n'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** The other site's pages. */
const PAGES: Record<string, string> = {
    '/iframe.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host</title>
<style>body { font: 16px/1.5 serif; max-width: 760px; margin: 1rem auto; padding: 0 16px } iframe { display: block; width: 100%; border: 0 }</style></head><body>
<button id="before">A button of the page</button>
<iframe id="f" src="${BASE}/embed/?source=parent&height=auto" height="200" title="ABRO"></iframe>
<p>After the chart.</p>
<script>
  const f = document.getElementById('f')
  window.events = []
  window.send = (m) => f.contentWindow.postMessage(m, ${JSON.stringify(new URL(BASE).origin)})
  addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.origin !== ${JSON.stringify(new URL(BASE).origin)}) return
    window.events.push(e.data)
    if (e.data && e.data.event === 'resize') f.style.height = e.data.height + 'px'
  })
  let n = 0
  window.call = (command, fields) => new Promise((resolve) => {
    const id = 'c' + ++n
    addEventListener('message', function on(e) {
      if (e.source === f.contentWindow && e.data && e.data.event === 'reply' && e.data.id === id) { removeEventListener('message', on); resolve(e.data) }
    })
    send(Object.assign({ type: 'sccharts-lab', version: 1, command, id }, fields || {}))
  })
  f.addEventListener('load', () => send({ type: 'sccharts-lab', version: 1, command: 'setSource', source: ${JSON.stringify(ABRO)}, id: 'first' }))
</script></body></html>`,
    '/element.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host</title>
<script src="${BASE}/embed.js"></script>
<style>body { font: 16px/1.5 serif; max-width: 760px; margin: 1rem auto; padding: 0 16px }</style></head><body>
<button id="before">A button of the page</button>
<sccharts-lab-chart id="ex" example="showcase/abro" loading="eager"></sccharts-lab-chart>
<sccharts-lab-chart id="inline" view="full" loading="eager">
  <pre>
    ${esc(TOGGLE).replace(/\n/g, '\n    ')}
  </pre>
</sccharts-lab-chart>
<sccharts-lab-chart id="fetched" src="/lamp.sctx" view="diagram" height="300" loading="eager"></sccharts-lab-chart>
<script>
  window.ticks = []
  document.getElementById('ex').addEventListener('tick', (e) => window.ticks.push(e.detail.tick))
</script></body></html>`,
    '/lamp.sctx': LAMP,
}

describe.skipIf(!enabled)('embedding a chart in another site', () => {
    let browser: Browser
    let server: http.Server
    const errors: string[] = []

    async function open(path: string, width = 900, height = 900, base = HOST): Promise<{ page: Page; context: BrowserContext }> {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })
        const page = await context.newPage()
        page.on('console', m => {
            if (m.type() === 'error' && !IGNORED.some(r => r.test(m.text() + m.location().url))) errors.push(`${path}: ${m.text()} (${m.location().url})`)
        })
        page.on('pageerror', e => errors.push(`${path}: ${e.message}`))
        await page.goto(base + path, { waitUntil: 'load', timeout: 60000 })
        return { page, context }
    }

    const embedFrame = (page: Page, match = '/embed/'): Frame => {
        const f = page.frames().find(fr => fr.url().includes(match))
        if (!f) throw new Error(`no frame ${match}`)
        return f
    }

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            // A file that takes its time: the element's attributes change while it is on its way.
            if (new URL(req.url ?? '/', HOST).pathname === '/slow.sctx') {
                setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('scchart Slow {\n  initial state S\n}\n'), 800)
                return
            }
            const body = PAGES[new URL(req.url ?? '/', HOST).pathname]
            if (!body) {
                res.writeHead(404).end()
                return
            }
            res.writeHead(200, { 'Content-Type': req.url?.endsWith('.sctx') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' }).end(body)
        })
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(PORT, '127.0.0.1', resolve))
        browser = await launchChromium()
    }, 120000)

    afterAll(async () => {
        await browser?.close()
        await new Promise(resolve => server?.close(resolve))
        expect(errors).toEqual([])
    })

    test('an iframe driven with postMessage: the chart, steps with inputs, rewind, reset, events, errors', async () => {
        const { page, context } = await open('/iframe.html')
        const events = () => page.evaluate(() => (window as unknown as { events: { event: string }[] }).events)
        type Reply = { event: 'reply'; id: string; ok: boolean; error?: string; result: Record<string, unknown> & { values: Record<string, unknown>; active: string[] } }
        const call = (command: string, fields: Record<string, unknown> = {}) =>
            page.evaluate(([c, f]) => (window as unknown as { call: (c: string, f: unknown) => Promise<Reply> }).call(c as string, f), [command, fields] as const)

        // The chart from the page (source=parent): `ready`, and the first setSource answered with its compile.
        await page.waitForFunction(() => (window as unknown as { events: { event: string }[] }).events.some(e => e.event === 'ready'), null, { timeout: 60000 })
        const ready = (await events()).find(e => e.event === 'ready') as unknown as { view: string; compiled: { chart: string; ok: boolean; inputs: { name: string }[] }; tick: { tick: number } }
        expect(ready).toMatchObject({ view: 'sim', compiled: { chart: 'ABRO', ok: true }, tick: { tick: 0 } })
        expect(ready.compiled.inputs.map(v => v.name)).toEqual(['A', 'B', 'R'])
        await page.waitForFunction(() => (window as unknown as { events: { event: string; id?: string }[] }).events.some(e => e.event === 'reply' && e.id === 'first'))

        // ABRO: tick 1 starts it; A in tick 2; B in tick 3 completes both regions, so O is emitted.
        const t1 = await call('step')
        expect(t1).toMatchObject({ ok: true, result: { tick: 1, ticks: 1, values: { A: false, B: false, R: false, O: false } } })
        const t2 = await call('step', { inputs: { A: true } })
        expect(t2.result).toMatchObject({ tick: 2, values: { A: true, O: false } })
        expect(t2.result.active).toContain('ABRO.ABO.WaitAB.DoneA')
        const t3 = await call('step', { inputs: { A: false, B: true } })
        expect(t3.result).toMatchObject({ tick: 3, values: { A: false, B: true, O: true }, present: { O: true }, terminated: false })
        expect(t3.result.active).toContain('ABRO.ABO.Done')
        expect(t3.result.taken).toEqual(expect.arrayContaining(['ABRO.ABO.WaitAB.WaitB->1']))
        // The panel shows it too.
        const frame = embedFrame(page)
        expect(await frame.textContent('[data-pg-sim] .sc-simctl__tick')).toMatch(/Tick\s*3/)
        expect(await frame.$$eval('[data-pg-stage] [data-id="ABRO.ABO.Done"].is-active', els => els.length)).toBe(1)
        // Every tick was reported as an event, in order.
        await page.waitForFunction(() => (window as unknown as { events: { event: string; tick?: number }[] }).events.filter(e => e.event === 'tick').at(-1)?.tick === 3)
        const ticks = (await events()).filter(e => e.event === 'tick') as unknown as { tick: number; values: { O: boolean } }[]
        expect(ticks.map(t => t.tick)).toEqual([1, 2, 3])
        expect(ticks.at(-1)!.values.O).toBe(true)

        // Rewind keeps the later ticks; Step replays them as they were. Reset goes back to tick 0.
        expect((await call('rewind', { tick: 1 })).result).toMatchObject({ tick: 1, ticks: 3 })
        expect((await call('step')).result).toMatchObject({ tick: 2, ticks: 3, values: { A: true } })
        expect(await call('rewind', { tick: 9 })).toMatchObject({ ok: false, error: expect.stringMatching(/3 ticks/) })
        expect((await call('reset')).result).toMatchObject({ tick: 0, ticks: 0 })

        // Refused: an input the chart does not have, a wrong type, an unknown command. Nothing runs.
        expect(await call('step', { inputs: { Z: true } })).toMatchObject({ ok: false, error: expect.stringMatching(/`Z` is not an input .*A, B, R/) })
        expect(await call('step', { inputs: { A: 1 } })).toMatchObject({ ok: false, error: '`A` takes true or false.' })
        expect(await call('fly')).toMatchObject({ ok: false, error: expect.stringMatching(/no command `fly`/) })
        // Ignored without a word: anything that is not a command in the envelope.
        const before = (await events()).length
        await page.evaluate(() => {
            const send = (window as unknown as { send: (m: unknown) => void }).send
            send('step')
            send({ type: 'sccharts-lab', version: 1, event: 'tick' })
            send({ type: 'other', command: 'step' })
            send(null)
        })
        expect((await call('getState')).result).toMatchObject({ tick: { tick: 0 }, compiled: { chart: 'ABRO' } })
        expect((await events()).slice(before).map(e => e.event).filter(e => e !== 'resize')).toEqual(['reply'])

        // A new chart from the page: `compiled`, and the simulation starts on it.
        const compiled = await call('setSource', { source: TOGGLE })
        expect(compiled.result).toMatchObject({ ok: true, chart: 'Toggle', charts: ['Toggle'] })
        await page.waitForFunction(() => (window as unknown as { events: { event: string; chart?: string }[] }).events.some(e => e.event === 'compiled' && e.chart === 'Toggle'))
        expect((await call('step', { inputs: { button: true } })).result).toMatchObject({ tick: 1, values: { button: true, on: false } })
        expect((await call('step')).result).toMatchObject({ tick: 2, values: { button: true, on: true } })
        // A chart with an error: reported, and it cannot run.
        const bad = await call('setSource', { source: 'scchart Bad {\n  initial state S\n    if x go to S\n}\n' })
        expect(bad.result).toMatchObject({ ok: false, chart: 'Bad', diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 'error', line: 3 })]) })
        expect(await call('step')).toMatchObject({ ok: false, error: expect.stringMatching(/cannot run/) })
        // A file of two charts: the first is shown; selectChart picks the other.
        const two = `${TOGGLE}\n${LAMP}`
        expect((await call('setSource', { source: two })).result).toMatchObject({ chart: 'Toggle', charts: ['Toggle', 'Lamp'] })
        const lamp = await call('selectChart', { chart: 'Lamp' })
        expect(lamp.result).toMatchObject({ ok: true, chart: 'Lamp', inputs: [{ name: 'press' }] })
        expect(await frame.$eval('[data-pg-chart]', el => (el as HTMLSelectElement).value)).toBe('Lamp')
        expect(await call('selectChart', { chart: 'Nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/no chart `Nope`.*Toggle, Lamp/) })
        // A project of two files, one importing the other (KIELER's import rules).
        const project = await call('setFiles', { files: { 'main.sctx': MAIN, 'push-switch.sctx': SWITCH }, active: 'main.sctx' })
        expect(project.result).toMatchObject({ ok: true, file: 'main.sctx', chart: 'HallLights' })
        await call('step', { inputs: { switchA: false } })
        expect((await call('step', { inputs: { switchA: true } })).result).toMatchObject({ tick: 2, values: { hall: true } })
        await call('setSource', { source: ABRO })

        // The frame takes the content's height, reported by `resize`.
        await page.waitForTimeout(500)
        const iframeHeight = await page.$eval('#f', el => el.getBoundingClientRect().height)
        const content = await frame.evaluate(() => document.querySelector('[data-sc-embed]')!.getBoundingClientRect().height)
        expect(iframeHeight).toBeGreaterThan(400)
        expect(Math.abs(iframeHeight - content)).toBeLessThanOrEqual(2)
        expect(await frame.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true)
        await context.close()
    }, 120000)

    test('<sccharts-lab-chart>: an example, code of its own, a fetched file; methods, events, its height', async () => {
        const { page, context } = await open('/element.html')
        const ready = (id: string) => page.evaluate(i => (document.getElementById(i) as HTMLElement & { ready: Promise<unknown> }).ready, id)
        const step = (id: string, inputs?: Record<string, unknown>) =>
            page.evaluate(([i, inp]) => (document.getElementById(i as string) as HTMLElement & { step: (x?: unknown) => Promise<{ tick: number; values: Record<string, unknown> }> }).step(inp ?? undefined), [id, inputs ?? null] as const)
        await Promise.all([ready('ex'), ready('inline'), ready('fetched')])

        // An example: ABRO through the element's methods.
        await step('ex')
        await step('ex', { A: true })
        expect(await step('ex', { A: false, B: true })).toMatchObject({ tick: 3, values: { O: true } })
        await page.waitForFunction(() => (window as unknown as { ticks: number[] }).ticks.at(-1) === 3)
        expect(await page.evaluate(() => (window as unknown as { ticks: number[] }).ticks)).toEqual([1, 2, 3])
        expect(await page.evaluate(() => (document.getElementById('ex') as HTMLElement & { tick: { tick: number } }).tick.tick)).toBe(3)
        const refused = await page.evaluate(() => (document.getElementById('ex') as HTMLElement & { step: (x: unknown) => Promise<unknown> }).step({ Q: true }).then(() => 'resolved', (e: Error) => e.message))
        expect(refused).toMatch(/`Q` is not an input/)

        // Its own code (a <pre>, indented in the page's HTML): Toggle, in the full view.
        expect(await page.evaluate(() => (document.getElementById('inline') as HTMLElement & { compiled: { chart: string } }).compiled.chart)).toBe('Toggle')
        await step('inline', { button: true })
        expect(await step('inline')).toMatchObject({ tick: 2, values: { on: true } })
        const inline = embedFrame(page, 'source=parent&view=full')
        expect(await inline.evaluate(() => (document.querySelector('[data-sc-embed]') as HTMLElement & { playground: { view: { state: { doc: { toString(): string } } } } }).playground.view.state.doc.toString())).toBe(TOGGLE)
        // A file next to the page.
        expect(await page.evaluate(() => (document.getElementById('fetched') as HTMLElement & { compiled: { chart: string } }).compiled.chart)).toBe('Lamp')

        // Sizes: auto follows the content; a number is that many pixels. The frame is named for screen readers.
        await page.waitForTimeout(500)
        const sizes = await page.evaluate(() =>
            ['ex', 'inline', 'fetched'].map(id => {
                const f = (document.getElementById(id) as HTMLElement & { iframe: HTMLIFrameElement }).iframe
                return { h: Math.round(f.getBoundingClientRect().height), title: f.title }
            }),
        )
        expect(sizes[2]).toEqual({ h: 300, title: 'SCCharts Lab: Lamp (diagram)' })
        expect(sizes[0].title).toBe('SCCharts Lab: ABRO (simulation)')
        for (const [i, id] of ['source=parent&view=full', 'example=showcase/abro'].entries()) {
            const content = await embedFrame(page, id).evaluate(() => document.querySelector('[data-sc-embed]')!.getBoundingClientRect().height)
            expect(Math.abs(sizes[1 - i].h - content), `${id}: frame ${sizes[1 - i].h}, content ${content}`).toBeLessThanOrEqual(2)
        }
        await context.close()
    }, 120000)

    test('an element made by a script: `ready` and the commands sent before it, a new address, a file that is not there', async () => {
        const { page, context } = await open('/element.html')
        const result = await page.evaluate(async () => {
            type Chart = HTMLElement & { ready: Promise<{ compiled: { chart: string } }>; step: (i?: unknown) => Promise<{ tick: number; values: Record<string, unknown> }>; compiled?: { chart: string } }
            const el = document.createElement('sccharts-lab-chart') as Chart
            el.setAttribute('example', 'showcase/abro')
            el.setAttribute('loading', 'eager')
            document.body.append(el)
            // Asked for at once, before the frame exists: both wait for it.
            const [ready, first] = await Promise.all([el.ready, el.step({ A: true })])
            // Another chart: the frame loads again, and `ready` is a new promise.
            const before = el.ready
            el.setAttribute('example', 'learn/first-chart/dimmer')
            const again = await el.ready
            const missing = document.createElement('sccharts-lab-chart') as Chart
            missing.setAttribute('src', '/nothing-here.sctx')
            const failed = new Promise(resolve => missing.addEventListener('error', e => resolve((e as unknown as CustomEvent<{ message: string }>).detail.message)))
            document.body.append(missing)
            const failure = await failed
            const alert = missing.shadowRoot?.querySelector('[role="alert"]')?.textContent
            // A new address after the failure: the element tries again.
            missing.setAttribute('example', 'showcase/abro')
            const recovered = (await missing.ready).compiled.chart
            const alertAfter = missing.shadowRoot?.querySelector('[role="alert"]') ?? null
            // An attribute changed while the file is fetched: the frame has it.
            const slow = document.createElement('sccharts-lab-chart') as Chart
            slow.setAttribute('src', '/slow.sctx')
            slow.setAttribute('loading', 'eager')
            document.body.append(slow)
            await new Promise(r => setTimeout(r, 100))
            slow.setAttribute('view', 'diagram')
            const slowChart = (await slow.ready).compiled.chart
            const slowView = new URL(slow.shadowRoot!.querySelector('iframe')!.src).searchParams.get('view')
            return { ready: ready.compiled.chart, first: first.tick, renewed: before !== el.ready, again: again.compiled.chart, failed: failure, alert, recovered, alertAfter, slowChart, slowView }
        })
        expect(result).toEqual({
            ready: 'ABRO',
            first: 1,
            renewed: true,
            again: 'Dimmer',
            failed: 'The chart /nothing-here.sctx could not be loaded (404 Not Found).',
            alert: 'The chart /nothing-here.sctx could not be loaded (404 Not Found).',
            recovered: 'ABRO',
            alertAfter: null,
            slowChart: 'Slow',
            slowView: 'diagram',
        })
        await context.close()
    }, 120000)

    test('the keyboard reaches the chart from the page, and steps it', async () => {
        const { page, context } = await open('/element.html')
        await page.evaluate(() => (document.getElementById('ex') as HTMLElement & { ready: Promise<unknown> }).ready)
        await page.focus('#before')
        const frame = embedFrame(page, 'example=showcase/abro')
        const seen: string[] = []
        let onStep = false
        for (let i = 0; i < 20 && !onStep; i++) {
            await page.keyboard.press('Tab')
            const here = await frame.evaluate(() => {
                const a = document.activeElement
                if (!a || a === document.body || !document.hasFocus()) return ''
                return a.matches('.sc-simctl__step') ? 'step' : a.matches('[data-embed-open]') ? 'open' : a.matches('[data-pg-stage]') ? 'stage' : a.tagName.toLowerCase()
            })
            if (here) seen.push(here)
            onStep = here === 'step'
        }
        expect(seen[0]).toBe('open')
        expect(seen).toContain('stage')
        expect(onStep).toBe(true)
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => (window as unknown as { ticks: number[] }).ticks.at(-1) === 1)
        // Space anywhere in the chart but on a control steps too (the widgets' keys).
        await frame.focus('[data-pg-stage]')
        await page.keyboard.press(' ')
        await page.waitForFunction(() => (window as unknown as { ticks: number[] }).ticks.at(-1) === 2)
        await context.close()
    }, 120000)

    test('controls=0: the page drives the chart, so neither the tour\'s buttons nor the keys step it', async () => {
        const { page, context } = await open('/embed/?example=learn/first-chart/dimmer&view=sim&tour&tick=3&controls=0', 640, 520, BASE)
        await page.waitForSelector('[data-pg-ready]')
        await page.waitForFunction(() => /Tick\s*3/.test(document.querySelector('.sc-simctl__tick')?.textContent ?? document.body.textContent ?? ''))
        const shown = await page.$$eval('.sc-tour__nav button, .sc-tour__restart, .sc-simctl__step', bs => bs.filter(b => (b as HTMLElement).offsetParent !== null).length)
        expect(shown).toBe(0)
        const tick = () => page.evaluate(() => document.querySelector('.sc-sim')?.querySelector('.sc-simctl__tick b')?.textContent ?? '')
        const before = await tick()
        await page.focus('.sc-sim__trace')
        for (const key of [' ', 'Enter', 'ArrowRight', 'r', 'ArrowLeft']) await page.keyboard.press(key)
        await page.waitForTimeout(300)
        expect(await tick()).toBe(before)
        await context.close()
    }, 120000)

    test('the reference page\'s demo does what its caption says: A, then B, and O is present', async () => {
        const { page, context } = await open('/reference/embed/', 1280, 900, BASE)
        const box = page.locator('[data-api]')
        await box.scrollIntoViewIfNeeded()
        await page.waitForFunction(() => /^Tick 1/.test(document.querySelector('[data-api] [data-out]')?.textContent ?? ''), undefined, { timeout: 60000 })
        await box.locator('button:has-text("Step with A")').click()
        await page.waitForFunction(() => /^Tick 2/.test(document.querySelector('[data-api] [data-out]')?.textContent ?? ''))
        await box.locator('button:has-text("Step with B")').click()
        await page.waitForFunction(() => /^Tick 3/.test(document.querySelector('[data-api] [data-out]')?.textContent ?? ''))
        expect(await page.textContent('[data-api] [data-out]')).toBe('Tick 3: O present')
        // Reset starts it again, with tick 1 run: A, then B work again.
        await box.locator('button:has-text("Reset")').click()
        await page.waitForFunction(() => /^Tick 1/.test(document.querySelector('[data-api] [data-out]')?.textContent ?? ''))
        await context.close()
    }, 120000)

    test('Open in SCCharts Lab keeps the chart the embed shows, also before its first tick', async () => {
        const src = 'scchart First {\n  initial state A\n}\n\nscchart Second {\n  initial state B\n}\n'
        const { page, context } = await open(`/embed/?view=sim${hashForSource(src)}&chart=Second`, 900, 700, BASE)
        await page.waitForSelector('[data-pg-ready]')
        await page.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Second')
        await page.focus('[data-embed-open]')
        const href = await page.getAttribute('[data-embed-open]', 'href')
        expect(href).toContain('chart=Second')
        const ide = await context.newPage()
        await ide.goto(href!, { waitUntil: 'commit' })
        await ide.waitForFunction(() => document.querySelector('[data-pg-stage] svg')?.getAttribute('data-chart') === 'Second', null, { timeout: 30000 })
        await context.close()
    }, 120000)

    test('at a phone width nothing scrolls sideways', async () => {
        const { page, context } = await open('/element.html', 390, 844)
        await page.evaluate(() => Promise.all(['ex', 'inline', 'fetched'].map(id => (document.getElementById(id) as HTMLElement & { ready: Promise<unknown> }).ready)))
        await page.waitForTimeout(500)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        for (const f of page.frames().filter(fr => fr.url().includes('/embed/'))) {
            expect(await f.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        }
        // The full view stacks the editor over the diagram.
        const inline = embedFrame(page, 'view=full')
        const [editor, diagram] = await inline.$$eval('.sc-embed__editor, .sc-embed__diagram', els => els.map(e => e.getBoundingClientRect()).map(r => ({ top: r.top, left: r.left })))
        expect(diagram.top).toBeGreaterThan(editor.top)
        expect(diagram.left).toBe(editor.left)
        await context.close()
    }, 120000)

    test("the embed never reads or writes the reader's own playground storage", async () => {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' })
        const page = await context.newPage()
        page.on('pageerror', e => errors.push(`storage: ${e.message}`))
        // The reader's own work on this site: a scratch buffer, a run speed, a project in IndexedDB.
        await page.goto(`${BASE}/robots.txt`)
        const mine = { 'sccharts-guide:playground:scratch': 'scchart Mine {\n  initial state S\n}\n', 'sc-sim-speed': '1000', 'sccharts-guide:playground:project': 'p1' }
        await page.evaluate(m => {
            for (const [k, v] of Object.entries(m)) localStorage.setItem(k, v)
            return new Promise(resolve => {
                const req = indexedDB.open('sccharts-lab-playground', 1)
                req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' })
                req.onsuccess = () => {
                    const tx = req.result.transaction('projects', 'readwrite')
                    tx.objectStore('projects').put({ id: 'p1', name: 'Mine', files: { 'mine.sctx': 'scchart Mine {}' }, active: 'mine.sctx', open: [], updated: 1 })
                    tx.oncomplete = () => {
                        req.result.close()
                        resolve(null)
                    }
                }
            })
        }, mine)
        const snapshot = () =>
            page.evaluate(async () => {
                const ls = Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))
                const dbs = (await indexedDB.databases()).map(d => d.name).sort()
                const projects = await new Promise(resolve => {
                    const req = indexedDB.open('sccharts-lab-playground', 1)
                    req.onsuccess = () => {
                        const all = req.result.transaction('projects').objectStore('projects').getAll()
                        all.onsuccess = () => {
                            req.result.close()
                            resolve(all.result)
                        }
                    }
                })
                return { ls, dbs, projects, session: sessionStorage.length }
            })
        const before = await snapshot()

        // The embed, at the top of this very origin (the strictest case: no third-party storage partitioning).
        await page.goto(`${BASE}/embed/?example=showcase/abro&view=full`)
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.waitForSelector('[data-pg-sim] .sc-simctl__step')
        expect(await page.evaluate(() => [localStorage.getItem('sccharts-guide:playground:scratch'), localStorage.getItem('sc-sim-speed'), typeof indexedDB])).toEqual([null, null, 'undefined'])
        // Edit, step, change the run speed (SimPanel remembers it), choose variables: all of it stays in the embed.
        await page.locator('.cm-content').click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type('\n// edited in the embed\n')
        await page.click('[data-pg-sim] .sc-simctl__step')
        await page.selectOption('[data-pg-sim] .sc-simctl__speed select', { index: 0 })
        await page.waitForTimeout(800)
        expect(await page.evaluate(() => localStorage.getItem('sc-sim-speed'))).not.toBeNull()

        await page.goto(`${BASE}/robots.txt`)
        expect(await snapshot()).toEqual(before)
        expect(before.ls).toEqual(mine)
        await context.close()
    }, 120000)

    test("the playground's Embed dialog: the view, the code, the preview", async () => {
        const { page, context } = await open('/playground/?example=showcase/abro', 1280, 900, BASE)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
        await page.waitForSelector('[data-pg-ready] .cm-content', { timeout: 60000 })
        await page.click('[data-pg-embed]')
        const dialog = page.locator('dialog.sc-embed-dialog[open]')
        await dialog.waitFor()
        expect(await dialog.locator('[data-snippet]').textContent()).toBe(`<script src="${BASE}/embed.js" async></script>\n<sccharts-lab-chart example="showcase/abro"></sccharts-lab-chart>`)
        await dialog.locator('label', { hasText: 'Diagram' }).click()
        await dialog.locator('label', { hasText: 'iframe' }).click()
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('[data-preview]')?.src.includes('view=diagram'))
        // The preview is the embed itself, sized by its `resize`; the iframe's code takes the height it needed.
        const preview = page.frames().find(f => f.url().includes('/embed/?example=showcase/abro&view=diagram&height=auto'))!
        await preview.waitForSelector('[data-pg-stage] svg.sc-pg-svg', { timeout: 60000 })
        await page.waitForTimeout(600)
        const previewHeight = await page.$eval('[data-preview]', el => el.getBoundingClientRect().height)
        const code = await dialog.locator('[data-snippet]').textContent()
        expect(code).toMatch(new RegExp(`^<iframe src="${BASE.replace(/[.]/g, '\\.')}/embed/\\?example=showcase/abro&amp;view=diagram" title="ABRO in SCCharts Lab" width="100%" height="\\d+0"`))
        expect(Number(/height="(\d+)"/.exec(code!)![1])).toBe(Math.ceil(previewHeight / 10) * 10)
        await dialog.locator('[data-copy]').click()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        await context.close()
    }, 120000)
})

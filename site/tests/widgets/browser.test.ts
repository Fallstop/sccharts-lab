// Interaction checks of the widgets in a real browser, against the shared dev server
// (tools/dev-server.sh) and the test bench page src/content/docs/design/widgets-test.mdx. Skipped when the
// dev server is not running. Run: pnpm exec vitest run tests/widgets/browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchChromium } from '../../tools/chromium.mjs'

const BASE = process.env.SC_DEV_URL ?? 'http://127.0.0.1:4321'
const PAGE = `${BASE}/design/widgets-test/`
const up = await fetch(PAGE, { signal: AbortSignal.timeout(20000) }).then((r) => r.ok, () => false)

// The dev server is shared: other people's edits make Vite reload pages. A WebSocket that never connects
// keeps the page under test still.
const noHmr = () => {
    const Real = window.WebSocket
    // A socket that never opens for Vite's HMR client; any other socket is a real one.
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

/** What a reader's pointer does to every widget: client:engage hydrates on it. */
const engageAll = () => {
    for (const f of document.querySelectorAll('.sc-frame')) f.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
}

describe.skipIf(!up)('widgets in the browser', () => {
    let browser: Browser
    let page: Page
    const errors: string[] = []
    const requests: string[] = []
    const beforeEngaging: string[] = []

    beforeAll(async () => {
        browser = await launchChromium()
        page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        page.on('console', (m) => {
            if (m.type() === 'error' && !/dev-toolbar|Outdated Optimize Dep/.test(m.text() + m.location().url)) errors.push(m.text())
        })
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('request', (r) => requests.push(r.url()))
        await page.addInitScript(noHmr)
        await page.goto(PAGE, { waitUntil: 'networkidle' })
        // Before anyone engages with a widget, no island code (Svelte, the engine) has loaded (client:engage).
        beforeEngaging.push(...requests)
        // Hydrate every island: client:engage islands when the pointer is over their frame, client:visible
        // ones (the landing chart) when they scroll into view.
        for (let y = 0; y < 20000; y += 500) {
            await page.evaluate((yy) => window.scrollTo(0, yy), y)
            await page.waitForTimeout(40)
        }
        await page.evaluate(engageAll)
        await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((i) => !i.hasAttribute('ssr')), null, { timeout: 20000 })
    }, 60000)

    afterAll(async () => {
        await browser?.close()
    })

    // Frames by kind and chart name, in page order: frame('sim', 'Toggle').
    const frame = (kind: string, name: string, nth = 0) =>
        page.locator(`figure.sc-frame--${kind}`).filter({ has: page.locator('.sc-frame__name', { hasText: new RegExp(`^${name}$`) }) }).nth(nth)
    // SVG shapes are never "stable" for Playwright's hover (their strokes transition): move the mouse instead.
    const pointAt = async (l: ReturnType<Page['locator']>) => {
        await l.scrollIntoViewIfNeeded()
        const b = (await l.boundingBox())!
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    }
    const tickOf = async (f: ReturnType<Page['locator']>) => Number(await f.locator('.sc-simctl__tick b').textContent())

    it('hydrates every widget without console errors', () => {
        expect(errors).toEqual([])
    })

    it('loads no layout code (elkjs) in the browser', () => {
        expect(requests.filter((u) => /elk/i.test(u))).toEqual([])
    })

    it('loads no engine and no island code before the reader engages with a widget', () => {
        expect(beforeEngaging.filter((u) => /\/src\/engine\/|\/sim\/(Sim|CompareSim|PredictSim|SimPanel)\.svelte/.test(u))).toEqual([])
    })

    it('Chart: hovering a state marks its source lines, hovering a line marks its element', async () => {
        const f = frame('chart', 'Toggle')
        await f.getByRole('tab', { name: 'Both' }).click()
        await pointAt(f.locator('[data-id="Toggle.On"] .sc-shape').first())
        await expect.poll(() => f.locator('.ec-line.is-focus').count()).toBe(1)
        await f.locator('.ec-line').nth(5).hover()
        await expect.poll(() => f.locator('[data-id="Toggle.Off->1"]').getAttribute('class')).toContain('is-focus')
    })

    it('Chart: highlight pins is-focus; a rejected chart marks the elements and lists the messages', async () => {
        expect(await frame('chart', 'ABRO').locator('.sc-diagram .is-focus').count()).toBeGreaterThan(0)
        const rejected = frame('chart', 'Blink')
        expect(await rejected.locator('.sc-diagram .is-error').count()).toBeGreaterThan(0)
        expect(await rejected.locator('.sc-diag__list li').count()).toBeGreaterThan(0)
    })

    it('Sim: the guided tour steps with the script, Back goes back, a click in the trace jumps', async () => {
        const f = frame('sim', 'Toggle')
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        expect(await tickOf(f)).toBe(2)
        expect(await f.locator('[data-id="Toggle.On"]').getAttribute('class')).toContain('is-active')
        await expect.poll(() => f.locator('.sc-tour__note').textContent()).toContain('fires')
        await f.getByRole('button', { name: 'Back one tick' }).click()
        expect(await tickOf(f)).toBe(1)
        expect(await f.locator('[data-id="Toggle.Off"]').getAttribute('class')).toContain('is-active')
        await f.locator('.wv-hit[data-tick="2"]').click({ force: true })
        expect(await tickOf(f)).toBe(2)
    })

    it('Sim: the Code view marks the active state\'s line', async () => {
        const f = frame('sim', 'Toggle')
        await f.getByRole('tab', { name: 'Code' }).click()
        // Tick 2: On is active (line 8), Off -> On fired (line 6).
        expect(await f.locator('.ec-line.is-active').count()).toBe(1)
        expect(await f.locator('.ec-line').nth(7).getAttribute('class')).toContain('is-active')
        expect(await f.locator('.ec-line').nth(5).getAttribute('class')).toContain('is-taken')
        await f.getByRole('tab', { name: 'Diagram' }).click()
    })

    it('Sim: keyboard: Space steps, Backspace goes back, R resets', async () => {
        const f = frame('sim', 'Toggle')
        await f.getByRole('button', { name: 'Take over' }).click()
        await f.locator('.sc-dview').click({ position: { x: 5, y: 5 } })
        const before = await tickOf(f)
        await page.keyboard.press('Space')
        expect(await tickOf(f)).toBe(before + 1)
        await page.keyboard.press('Backspace')
        expect(await tickOf(f)).toBe(before)
        await page.keyboard.press('r')
        expect(await tickOf(f)).toBe(0)
    })

    it('Sim: a pulse is present for one tick, a switch stays where it is put', async () => {
        const f = frame('sim', 'Counter') // no scenario
        const step = f.getByRole('button', { name: 'Step' })
        await f.getByRole('button', { name: 'Pulse tick for one tick' }).click()
        expect(await f.getByRole('button', { name: 'Pulse tick for one tick' }).getAttribute('aria-pressed')).toBe('true')
        await step.click()
        expect(await f.getByRole('switch', { name: 'tick' }).isChecked()).toBe(false)
        expect(await f.getByRole('button', { name: 'Pulse tick for one tick' }).getAttribute('aria-pressed')).toBe('false')
        await f.getByRole('switch', { name: 'tick' }).check()
        await step.click()
        await step.click()
        expect(await f.getByRole('switch', { name: 'tick' }).isChecked()).toBe(true)
        expect(await tickOf(f)).toBe(3)
        // The trace has a lane per input, output and region.
        const lanes = await f.locator('.wv-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))
        expect(lanes).toEqual(['tick', 'count', 'wrap', 'state'])
    })

    it('Sim: Run steps on its own and Pause stops it', async () => {
        const f = frame('sim', 'Counter')
        await f.getByRole('button', { name: 'Run' }).click()
        await page.waitForTimeout(1300)
        await f.getByRole('button', { name: 'Pause' }).click()
        const t = await tickOf(f)
        expect(t).toBeGreaterThan(3)
        await page.waitForTimeout(700)
        expect(await tickOf(f)).toBe(t)
    })

    it('Sim: a rejected chart shows its messages instead of the controls', async () => {
        const f = frame('sim', 'Blink')
        expect(await f.getByRole('button', { name: 'Step' }).count()).toBe(0)
        expect(await f.locator('.sc-diag__list li').count()).toBeGreaterThan(0)
        expect(await f.locator('.sc-diagram .is-error').count()).toBeGreaterThan(0)
    })

    it('Diagnostics: each message links to its section of the compiler messages page; errors carry a marker', async () => {
        const f = frame('sim', 'Blink')
        const about = f.locator('.sc-diag--error a.sc-diag__about').first()
        expect(await about.textContent()).toBe('About this message')
        expect(await about.getAttribute('href')).toBe('/reference/errors/#the-scg-is-not-asc-schedulable')
        // An error is told by a marker, not by dashes (dashes mean "immediate" in KIELER's notation).
        expect(await f.locator('.sc-diagram .sc-error-marker').count()).toBeGreaterThan(0)
        expect(await f.locator('.sc-diagram .sc-state.is-error > .sc-shape').first().evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe('none')
    })

    it('Sim: a short trace does not scroll, and its hidden table does not widen it', async () => {
        const f = frame('sim', 'Toggle')
        const trace = f.locator('.sc-sim__trace')
        const [scroll, client] = await trace.evaluate((el) => [el.scrollWidth, el.clientWidth])
        expect(scroll).toBeLessThanOrEqual(client + 1)
    })

    it('Sim: announces each tick to screen readers', async () => {
        const f = frame('sim', 'ABRO')
        await f.getByRole('button', { name: 'Next' }).click()
        await expect.poll(() => f.locator('[aria-live="polite"]').last().textContent()).toMatch(/^Tick 1\./)
    })

    it('Sim: a run-time error is said in the foot and marked in the trace', async () => {
        const f = frame('sim', 'Divide')
        await f.getByRole('button', { name: 'Step' }).click()
        await f.locator('[data-input="d"] input').fill('0')
        await f.locator('[data-input="d"] input').press('Tab')
        await f.getByRole('button', { name: 'Step' }).click()
        await expect.poll(() => f.locator('.sc-what__item.is-error').count()).toBe(1)
        expect(await f.locator('.wv-error').count()).toBe(1)
        // The field keeps what the reader typed: the failed tick was not applied.
        expect(await f.locator('[data-input="d"] input').inputValue()).toBe('0')
        expect(await f.locator('.sc-what__item.is-error').textContent()).toMatch(/^The simulation stopped in tick 2: /)
    })

    it('Sim: after a run-time error Step and Run are off and Restart is offered, with the focus kept', async () => {
        const f = frame('sim', 'Divide')
        // Where the test before left it: tick 2 failed. Step, Run and the inputs are off; focus goes from Step to Restart.
        const step = f.getByRole('button', { name: 'Step' })
        expect(await step.isDisabled()).toBe(true)
        expect(await f.getByRole('button', { name: 'Run' }).isDisabled()).toBe(true)
        expect(await f.locator('[data-input="d"] input').isDisabled()).toBe(true)
        expect(await f.locator('.sc-sim__halted').textContent()).toMatch(/Step and Run are off/)
        // The keyboard cannot step it either, and the message keeps its tick.
        await f.locator('.sc-sim__trace').focus()
        await page.keyboard.press('ArrowRight')
        expect(await tickOf(f)).toBe(2)
        // Back to tick 1 and again: Step replays tick 2 (the error), and the focus moves from Step to Restart.
        await f.getByRole('button', { name: 'Back one tick' }).click()
        expect(await step.isDisabled()).toBe(false)
        await step.focus()
        await page.keyboard.press('Enter')
        await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('sc-sim__restart'))).toBe(true)
        expect(await f.locator('.sc-what__item.is-error').textContent()).toMatch(/^The simulation stopped in tick 2: /)
        // Restart: tick 0, the controls back, the focus on Step.
        await page.keyboard.press('Enter')
        await expect.poll(() => tickOf(f)).toBe(0)
        expect(await step.isDisabled()).toBe(false)
        expect(await f.locator('.sc-sim__halted').count()).toBe(0)
        await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('sc-simctl__step'))).toBe(true)
        await f.locator('[data-input="d"] input').fill('1')
        await f.locator('[data-input="d"] input').press('Tab')
    })

    it('Sim: the tour reaches termination, which the trace marks', async () => {
        const f = frame('sim', 'Countdown')
        for (let i = 0; i < 5; i++) await f.getByRole('button', { name: 'Next' }).click()
        expect(await f.locator('.wv-term').count()).toBe(1)
        expect(await f.locator('.sc-tour__note').textContent()).toMatch(/terminates/)
        expect(await f.locator('[data-id="Countdown.Finished"]').getAttribute('class')).toContain('is-active')
    })

    it('Compare: the guided tour plays the scenario on both charts, with its notes', async () => {
        const f = frame('compare', 'Toggle and ToggleEdge')
        expect(await f.locator('.sc-sim .sc-tour__label').textContent()).toMatch(/Guided tour, 7 ticks/)
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        expect(await tickOf(f)).toBe(2)
        expect(await f.locator('.sc-tour__note').textContent()).toContain('fires')
        // The switches show the inputs of the tick shown.
        expect(await f.getByRole('switch', { name: 'button' }).isChecked()).toBe(true)
        expect(await f.locator('.sc-diagram .sc-state.is-active:not(.sc-root)').count()).toBe(2)
        await f.getByRole('button', { name: 'Previous' }).click()
        expect(await tickOf(f)).toBe(1)
        expect(await f.getByRole('switch', { name: 'button' }).isChecked()).toBe(false)
        await f.getByRole('button', { name: 'Take over' }).click()
        expect(await f.getByRole('button', { name: 'Restart the guided tour' }).count()).toBe(1)
        await f.getByRole('button', { name: 'Reset' }).click()
        expect(await tickOf(f)).toBe(0)
    })

    it('Compare: termination per chart, in the trace and in the difference line', async () => {
        const f = frame('compare', 'Once and OnceBool')
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        await expect.poll(() => f.locator('.sc-compare__diff').first().textContent()).toContain('OnceBool terminated in tick 2; Once did not.')
        expect(await f.locator('.wv-term title').first().textContent()).toBe('OnceBool terminated in this tick')
        // `show` traced only the named variables.
        expect(await f.locator('.wv-row[data-role="output"]').count()).toBe(2)
        // The delayed transitions that fired are drawn solid, without moving dashes; the states left, solid too.
        const edge = f.locator('.sc-transition.is-taken:not(.sc-immediate) > .sc-edge').first()
        expect(await edge.evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe('none')
        const left = f.locator('.sc-state.is-exited:not(.is-active) > .sc-shape').first()
        expect(await left.evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe('none')
    })

    it('How KIELER reads it: grouping, tree, traps and syntax errors with a link', async () => {
        const f = page.locator('figure.sc-frame--reads').first()
        await f.scrollIntoViewIfNeeded()
        expect(await f.locator('.sc-reads__result code').textContent()).toBe('A > (2 ? A : 0)')
        await f.locator('input[type="text"]').fill('x = a + b * c')
        await expect.poll(() => f.locator('.sc-reads__result code').textContent()).toBe('x = a + (b * c)')
        expect(await f.locator('.sc-reads__tree li').count()).toBe(7)
        await f.getByRole('button', { name: 'Count delay' }).click()
        await expect.poll(() => f.locator('.sc-reads__delay').textContent()).toContain('count delay of 3')
        expect(await f.getByRole('radio', { name: /a trigger/ }).isChecked()).toBe(true)
        await f.getByRole('button', { name: '== chain' }).click()
        await expect.poll(() => f.locator('.sc-reads__msg').textContent()).toMatch(/Column 8: Comparisons cannot be chained/)
        expect(await f.locator('a.sc-diag__about').getAttribute('href')).toMatch(/^\/reference\/errors\/#/)
    })

    it('Compare: scenario={false} starts in free play', async () => {
        const f = frame('compare', 'Stairs and Lift')
        expect(await f.locator('.sc-tour').count()).toBe(0)
        expect(await f.locator('.sc-what__idle').count()).toBe(1)
    })

    it('Sim: during the tour the switches show the inputs of the tick shown', async () => {
        const f = frame('sim', 'Stopwatch')
        const next = f.getByRole('button', { name: 'Next' })
        for (let i = 0; i < 2; i++) await next.click()
        expect(await f.getByRole('switch', { name: 'start' }).isChecked()).toBe(true)
        expect(await f.locator('.sc-simctl__inputs legend').textContent()).toBe('Inputs of tick 2 of the guided tour')
    })

    it('Sim: an accepted chart lists KIELER\'s warnings under the simulation', async () => {
        const f = frame('sim', 'Stopwatch')
        const warn = f.locator('details.sc-diag--warning')
        expect(await warn.count()).toBe(1)
        expect(await warn.getAttribute('open')).toBeNull()
        expect(await warn.textContent()).toContain('KIELER says: The transition is not reachable.')
    })

    it('Sim: a rejected chart lists the errors first, with KIELER\'s words, and the warnings apart', async () => {
        const f = frame('sim', 'Retry')
        const first = f.locator('.sc-diag--error .sc-diag__list li').first()
        expect(await first.textContent()).toContain('KIELER says: The SCG is NOT asc-schedulable!')
        expect(await f.locator('.sc-diag--warning summary').textContent()).toMatch(/^Also( a (warning|note):| \d+ (warning|note))/)
    })

    it('Sim: a chart that imports another runs with it', async () => {
        const f = frame('sim', 'HallLights')
        expect(await f.locator('.sc-sim__errors, .sc-cannot-run').count()).toBe(0)
        await f.getByRole('button', { name: 'Next' }).click()
        await f.getByRole('button', { name: 'Next' }).click()
        expect(await f.locator('.wv-row[data-name="hall"]').count()).toBe(1)
    })

    it('Sim: references="expanded" highlights the referenced chart\'s states', async () => {
        const f = frame('sim', 'LampPanel')
        await f.getByRole('button', { name: 'Next' }).click()
        await f.getByRole('button', { name: 'Next' }).click()
        expect(await f.locator('[data-id="LampPanel.Left/PushSwitch.On"]').getAttribute('class')).toContain('is-active')
        expect(await f.locator('[data-id="LampPanel.Right/PushSwitch.Off"]').getAttribute('class')).toContain('is-active')
    })

    it('Sim: a timed chart advances by sleepT', async () => {
        const f = frame('sim', 'EggTimer')
        const take = f.getByRole('button', { name: 'Take over' })
        if (await take.count()) await take.click()
        const advance = f.getByRole('button', { name: /^Advance by sleepT/ })
        expect(await advance.isDisabled()).toBe(true)
        await f.getByRole('button', { name: 'Step' }).click()
        expect(await advance.textContent()).toContain('1000')
        await advance.click()
        expect(await tickOf(f)).toBe(2)
        expect(await f.locator('[data-input="deltaT"] input').inputValue()).toBe('1000')
        expect(await f.locator('.wv-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))).toEqual(['deltaT', 'sleepT', 'ring', 't', 'state'])
    })

    it('Sim: a chart KIELER accepts but the engine cannot run says so instead of the controls', async () => {
        const f = frame('sim', 'Backticks')
        expect(await f.getByRole('button', { name: 'Step' }).count()).toBe(0)
        expect(await f.locator('.sc-cannot-run').textContent()).toMatch(/KIELER accepts this chart/)
        expect(await f.locator('.sc-diag--error').count()).toBe(0)
    })

    it('Compare: steps both charts with the same inputs', async () => {
        const f = frame('compare', 'Toggle and ToggleEdge')
        await f.getByRole('switch', { name: 'button' }).check()
        await f.getByRole('button', { name: 'Step' }).click()
        await f.getByRole('button', { name: 'Step' }).click()
        expect(await tickOf(f)).toBe(2)
        expect(await f.locator('.sc-diagram .sc-state.is-active:not(.sc-root)').count()).toBe(2)
        expect(await f.locator('.sc-compare__diff').textContent()).toMatch(/tick 2/)
    })

    it('Compare: a "What happened" line marks its elements on its own chart\'s diagram', async () => {
        const f = frame('compare', 'Toggle and ToggleEdge')
        await f.getByRole('tab', { name: 'Diagrams' }).click()
        const [left, right] = [f.locator('svg.sc-diagram').nth(0), f.locator('svg.sc-diagram').nth(1)]
        const line = f.locator('.sc-compare__what .sc-what').nth(1).locator('li[data-linked]').first()
        await line.hover()
        await expect.poll(() => right.locator('.is-focus').count()).toBeGreaterThan(0)
        expect(await left.locator('.is-focus').count()).toBe(0)
        // Keyboard: the list is one tab stop; focus marks the elements as hovering does.
        await page.mouse.move(0, 0)
        await expect.poll(() => right.locator('.is-focus').count()).toBe(0)
        await line.focus()
        await expect.poll(() => right.locator('.is-focus').count()).toBeGreaterThan(0)
        await line.blur()
        await expect.poll(() => right.locator('.is-focus').count()).toBe(0)
    })

    it('Keyboard: a diagram is one tab stop; the arrows walk its elements in source order and link their lines', async () => {
        const f = frame('sim', 'Toggle')
        await f.getByRole('tab', { name: 'Both' }).click()
        const svg = f.locator('svg.sc-diagram')
        expect(await svg.getAttribute('role')).toBe('graphics-document')
        expect(await svg.locator('[data-sc-nav][tabindex="0"]').count()).toBe(1)
        const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '')
        await f.locator('.sc-frame__open').focus()
        await page.keyboard.press('Tab')
        expect(await focused()).toMatch(/^initial state Off/)
        await page.keyboard.press('ArrowRight')
        expect(await focused()).toBe('transition Off to On: if button do light = true go to On')
        // Linked as by hover (line 6), with a focus ring; the simulation's Left / Right do not apply in here.
        const before = await tickOf(f)
        expect(await f.locator('.ec-line.is-focus').count()).toBe(1)
        expect(await f.locator('.ec-line').nth(5).getAttribute('class')).toContain('is-focus')
        expect(await svg.locator('.sc-focus-ring').count()).toBe(1)
        await page.keyboard.press('ArrowLeft')
        expect(await focused()).toMatch(/^initial state Off/)
        expect(await tickOf(f)).toBe(before)
        // Space still steps, and the names say what the simulation marks.
        await page.keyboard.press('Space')
        expect(await tickOf(f)).toBe(before + 1)
        expect(await focused()).toMatch(/^initial state Off, active/)
        // The Code view: its lines are the next tab stop; Up and Down move, focus marks the element.
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.classList.contains('ec-line'))).toBe(true)
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
        expect(await focused()).toMatch(/initial state Off \(active state\)/)
        expect(await svg.locator('[data-id="Toggle.Off"].is-focus').count()).toBe(1)
        await f.getByRole('tab', { name: 'Diagram' }).click()
    })

    it('Screen readers: the timing diagram is also a table, one row per tick', async () => {
        const f = frame('sim', 'Toggle')
        const table = f.locator('.sc-sim__trace table.wv-table')
        expect(await table.count()).toBe(1)
        expect(await f.locator('.sc-sim__trace svg.sc-wave__lanes').getAttribute('aria-hidden')).toBe('true')
        const ticks = await tickOf(f)
        expect(await table.locator('tbody tr').count()).toBeGreaterThanOrEqual(ticks)
        expect(await table.locator('tr[aria-current="true"] th').textContent()).toBe(`Tick ${ticks}, shown`)
        expect(await table.locator('thead th').allTextContents()).toEqual(['Tick', 'input bool button', 'output bool light', 'Active state of the chart'])
    })

    it('Predict: Run and check marks every answer with the real value', async () => {
        const f = frame('predict', 'Toggle')
        await f.locator('select').first().selectOption('true')
        await f.getByRole('button', { name: 'Run and check' }).click()
        await expect.poll(() => f.locator('.sc-predict__verdict').count()).toBe(3)
        expect(await f.locator('.sc-predict__score').textContent()).toMatch(/of 3/)
        expect(await f.locator('.sc-predict__trace .wv-row').count()).toBeGreaterThan(0)
    })

    it('Predict: the caption comes before the inputs and questions; the trace has only the run\'s ticks, its hatching explained', async () => {
        const f = frame('predict', 'RateOfChange')
        const foot = f.locator('.sc-frame__foot .sc-predict')
        expect(await foot.locator(':scope > *').first().getAttribute('class')).toContain('sc-predict__caption')
        expect(await f.locator('.sc-frame__caption').count()).toBe(0)
        await f.getByRole('button', { name: 'Run and check' }).click()
        await expect.poll(() => f.locator('.sc-predict__verdict').count()).toBe(2)
        // Five ticks, no empty column after them.
        expect(await f.locator('.sc-predict__trace .wv-tick').count()).toBe(5)
        expect(await f.locator('.sc-predict__legend').count()).toBe(1)
    })

    it('Predict: Run and check keeps the Both view (it shows the diagram already)', async () => {
        const f = frame('predict', 'Toggle', 1)
        expect(await f.getByRole('tab', { name: 'Both' }).getAttribute('aria-selected')).toBe('true')
        await f.getByRole('button', { name: 'Run and check' }).click()
        await expect.poll(() => f.locator('.sc-predict__verdict').count()).toBe(1)
        expect(await f.getByRole('tab', { name: 'Both' }).getAttribute('aria-selected')).toBe('true')
    })

    it('Sim: show traces an inner local and members, from the engine\'s trace', async () => {
        const f = frame('sim', 'Shadowing')
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        const lanes = await f.locator('.wv-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))
        expect(lanes.slice(0, 4)).toEqual(['press', 'count', 'seen', 'Outer.count'])
        const table = f.locator('.sc-sim__trace table.wv-table')
        expect(await table.locator('thead th').nth(4).textContent()).toBe('local int count of state Outer')
        expect(await table.locator('tbody tr').nth(1).locator('td').nth(3).textContent()).toBe('11')
        const board = frame('sim', 'Scoreboard')
        expect(await board.locator('.wv-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))).toContain('home.count')
    })

    it('Compare: a warning both charts get is one line in one box, naming both', async () => {
        const f = frame('compare', 'Blink and BlinkForgetful')
        const boxes = f.locator('details.sc-diag--warning')
        expect(await boxes.count()).toBe(1)
        expect(await boxes.locator('summary').textContent()).toMatch(/^Warning: .*\(Blink and BlinkForgetful\)$/)
        expect(await boxes.locator('.sc-diag__list li').count()).toBe(1)
        expect(await boxes.locator('.sc-diag__where').textContent()).toBe('Warning in Blink and BlinkForgetful, line 5, column 17')
        // The hint's own pointer to the errors page is left out: About this message links it.
        expect(await boxes.locator('.sc-diag__hint').textContent()).not.toContain('See ')
        expect(await boxes.locator('a.sc-diag__about').getAttribute('href')).toBe('/reference/errors/#instantaneous-loop-detected')
    })

    it('TryIt: the hint is a closed box of its own, after the starter and before the solution', async () => {
        const t = page.locator('.sc-tryit', { hasText: 'Light on the press' })
        await t.scrollIntoViewIfNeeded()
        const summaries = await t.locator('details > summary').allTextContents()
        expect(summaries).toEqual(['Show the starter chart', 'Show a hint', 'Show a solution'])
        const hint = t.locator('details.sc-tryit__hint')
        expect(await hint.getAttribute('open')).toBeNull()
        await hint.locator('summary').click()
        expect(await hint.locator('p').count()).toBe(2)
        expect(await hint.locator('a[href="/learn/pre/"] code').textContent()).toBe('pre')
        // Without a hint, no hint box.
        expect(await page.locator('.sc-tryit', { hasText: 'No solution, no hint' }).locator('details').count()).toBe(1)
    })

    it('Predict: checks against KIELER\'s recorded run when the engine cannot run the chart', async () => {
        const f = frame('predict', 'Backticks')
        await f.getByRole('textbox', { name: /what is x/ }).fill('42')
        await f.getByRole('button', { name: 'Check' }).click()
        await expect.poll(() => f.locator('.sc-predict__verdict').count()).toBe(3)
        expect(await f.locator('.sc-predict__score').textContent()).toMatch(/1 of 2/)
        expect(await f.locator('li.is-right').count()).toBe(1)
    })
})

describe.skipIf(!up)('widgets before hydration', () => {
    it('a tap on Step before the island is live is not lost; hydrating moves nothing', async () => {
        const browser = await launchChromium()
        const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true })
        await page.addInitScript(noHmr)
        await page.addInitScript(() => {
            const w = window as unknown as { shifts: number }
            w.shifts = 0
            new PerformanceObserver((list) => {
                for (const e of list.getEntries() as (PerformanceEntry & { value: number })[]) w.shifts += e.value
            }).observe({ type: 'layout-shift', buffered: true })
        })
        await page.goto(PAGE, { waitUntil: 'networkidle' })
        const shifts = () => page.evaluate(() => (window as unknown as { shifts: number }).shifts)
        // ABRO: engaged by keyboard focus, hydrated without any other input: no layout shift, same height.
        const abro = page.locator('figure.sc-frame--sim').nth(1)
        await abro.scrollIntoViewIfNeeded()
        await page.waitForTimeout(300)
        const height = (await abro.boundingBox())!.height
        const quiet = await shifts()
        await abro.locator('.sc-simctl__step').focus()
        await expect.poll(() => abro.locator('astro-island').getAttribute('ssr'), { timeout: 15000 }).toBeNull()
        await page.waitForTimeout(300)
        expect((await abro.boundingBox())!.height).toBe(height)
        expect((await shifts()) - quiet).toBeLessThan(0.001)
        // Counter (no tour): a tap on Step while the island is still server-rendered runs tick 1 once it is live.
        const counter = page.locator('figure.sc-frame--sim').nth(3)
        await counter.scrollIntoViewIfNeeded()
        expect(await counter.locator('astro-island').getAttribute('ssr')).not.toBeNull()
        const box = (await counter.locator('.sc-simctl__step').boundingBox())!
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
        await expect.poll(() => counter.locator('.sc-simctl__tick b').textContent(), { timeout: 15000 }).toBe('1')
        expect(await counter.locator('astro-island').getAttribute('ssr')).toBeNull()
        await browser.close()
    }, 60000)
})

describe.skipIf(!up)('frames before their script runs', () => {
    it('are drawn as the script makes them (a page painted before its scripts must not jump)', async () => {
        const browser = await launchChromium()
        const boxes = async (block: boolean, width: number) => {
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
            await page.addInitScript(noHmr)
            // WidgetFrame's view switching, as a slow connection leaves it until the whole page has arrived.
            if (block) await page.route(/WidgetFrame\.astro\?astro&type=script/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }))
            await page.goto(PAGE, { waitUntil: 'networkidle' })
            const out = await page.$$eval('figure.sc-frame', (fs) => fs.slice(0, 12).map((f) => [f.hasAttribute('data-enhanced'), Math.round(f.getBoundingClientRect().height)]))
            await page.close()
            return out
        }
        for (const width of [1280, 390]) {
            const before = await boxes(true, width)
            const after = await boxes(false, width)
            expect(before.every(([enhanced]) => !enhanced)).toBe(true)
            expect(before.map(([, h]) => h)).toEqual(after.map(([, h]) => h))
        }
        await browser.close()
    }, 60000)
})

describe.skipIf(!up)('the playground\'s rejected view', () => {
    it('renders messages and hints as text with inline code (no backticks), each with its link', async () => {
        const browser = await launchChromium()
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.addInitScript(noHmr)
        await page.goto(`${BASE}/playground/?example=learn/first-chart/lamp-broken`, { waitUntil: 'networkidle' })
        const panel = page.locator('.sc-sim__errors').first()
        await panel.waitFor({ timeout: 20000 })
        const text = await panel.textContent()
        expect(text).not.toContain('`')
        expect(await panel.locator('code').count()).toBeGreaterThan(0)
        expect(await panel.locator('a.sc-diag__about').count()).toBeGreaterThan(0)
        expect(errors).toEqual([])
        await browser.close()
    }, 60000)
})

describe.skipIf(!up)('long sources and for-region copies', () => {
    it('a source cut off at its height fades out and offers all its lines, by keyboard too', async () => {
        const browser = await launchChromium()
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.addInitScript(noHmr)
        await page.goto(`${BASE}/patterns/modes/`, { waitUntil: 'networkidle' })
        const f = page.locator('figure.sc-frame--sim').filter({ has: page.locator('.sc-frame__name', { hasText: /^CoffeeEmergency$/ }) })
        await f.scrollIntoViewIfNeeded()
        await f.getByRole('tab', { name: 'Code' }).click()
        const source = f.locator('[data-sc-source]')
        const toggle = source.locator('.sc-source__toggle')
        await expect.poll(() => toggle.isVisible()).toBe(true)
        expect(await source.getAttribute('class')).toMatch(/is-clipped/)
        expect(await toggle.textContent()).toMatch(/Show all 46 lines/)
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        const cut = await source.locator('.sc-source__scroll').evaluate((el) => [el.clientHeight, el.scrollHeight])
        expect(cut[1]).toBeGreaterThan(cut[0])
        // Keyboard: the button opens the whole source and closes it again.
        await toggle.focus()
        await page.keyboard.press('Enter')
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        expect(await toggle.textContent()).toMatch(/Show fewer lines/)
        const open = await source.locator('.sc-source__scroll').evaluate((el) => [el.clientHeight, el.scrollHeight])
        expect(open[0]).toBe(open[1])
        await page.keyboard.press('Enter')
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        expect(errors).toEqual([])
        await browser.close()
    }, 60000)

    it("names a for-region's states per copy on the diagram", async () => {
        const browser = await launchChromium()
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        await page.addInitScript(noHmr)
        await page.goto(`${BASE}/advanced/for-regions/`, { waitUntil: 'networkidle' })
        const f = page.locator('figure.sc-frame--sim').filter({ has: page.locator('.sc-frame__name', { hasText: /^Seatbelts$/ }) })
        await f.scrollIntoViewIfNeeded()
        await f.hover()
        await expect.poll(() => f.locator('astro-island').getAttribute('ssr'), { timeout: 15000 }).toBeNull()
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        const label = (name: string) => f.locator(`svg.sc-diagram .sc-state[data-sc-name$="${name}"]`).first().getAttribute('aria-label')
        // Tick 2: the copy i = 0 left Open for Fastened; the other three stay.
        await expect.poll(() => label('Open')).toBe('initial state Open, active in 3 of 4 copies (i = 1, 2 and 3), left in this tick in the copy i = 0')
        expect(await label('Fastened')).toBe('final state Fastened, active in 1 of 4 copies (i = 0), entered in this tick in the copy i = 0')
        // Back to tick 1: every copy entered Open.
        await f.getByRole('button', { name: 'Previous' }).click()
        await expect.poll(() => label('Open')).toBe('initial state Open, active in 4 of 4 copies (i = 0, 1, 2 and 3), entered in this tick in the copies i = 0, 1, 2 and 3')
        // A source that fits (17 lines) has no bar under it.
        await f.getByRole('tab', { name: 'Code' }).click()
        await page.waitForTimeout(200)
        expect(await f.locator('.sc-source__more').isHidden()).toBe(true)
        expect(await f.locator('[data-sc-source]').getAttribute('class')).not.toMatch(/is-clipped/)
        await browser.close()
    }, 60000)
})

describe.skipIf(!up)('widgets on a phone', () => {
    it('never scroll the page sideways at 390 px, in either theme', async () => {
        const browser = await launchChromium()
        for (const colorScheme of ['light', 'dark'] as const) {
            const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce', colorScheme })
            await page.addInitScript(noHmr)
            await page.goto(PAGE, { waitUntil: 'networkidle' })
            for (let y = 0; y < 30000; y += 700) {
                await page.evaluate((yy) => window.scrollTo(0, yy), y)
                await page.waitForTimeout(30)
            }
            const wide = await page.evaluate(() => document.documentElement.scrollWidth)
            expect(wide).toBeLessThanOrEqual(390)
            // A frame head with views and a link: the name on one row, the views and the link together on the next
            // (the link never on a row of its own), and no name cut off.
            const heads = await page.evaluate(() =>
                [...document.querySelectorAll('.sc-frame__head')].flatMap((h) => {
                    const views = h.querySelector('.sc-frame__views:not([hidden])')
                    const link = h.querySelector('.sc-frame__open')
                    const name = h.querySelector<HTMLElement>('.sc-frame__name')
                    const cut = !!name && name.scrollWidth > name.clientWidth + 1
                    if (!views || !link) return cut ? [`${name?.textContent}: cut`] : []
                    const v = views.getBoundingClientRect()
                    const l = link.getBoundingClientRect()
                    const together = Math.abs(v.top + v.height / 2 - (l.top + l.height / 2)) < 4
                    return together && !cut ? [] : [`${name?.textContent}: ${together ? 'cut' : 'link apart'}`]
                })
            )
            expect(heads).toEqual([])
            await page.close()
        }
        await browser.close()
    }, 60000)
})

describe.skipIf(!up)('widgets with motion', () => {
    it('pulse along a transition that fires, and the landing chart replays its opening', async () => {
        const browser = await launchChromium()
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' })
        await page.addInitScript(noHmr)
        await page.goto(PAGE, { waitUntil: 'networkidle' })
        const f = page.locator('figure.sc-frame--sim').first()
        await f.scrollIntoViewIfNeeded()
        await f.hover()
        await page.waitForFunction(() => !document.querySelector('figure.sc-frame--sim')?.querySelector('astro-island[ssr]'), null, { timeout: 15000 })
        const next = f.getByRole('button', { name: 'Next' })
        await next.click()
        await next.click()
        expect(await f.locator('.sc-edge-pulse').count()).toBe(1)
        await page.waitForTimeout(900)
        expect(await f.locator('.sc-edge-pulse').count()).toBe(0)

        // The landing page: without waiting, the build-time picture is the opening's last tick; the replay
        // starts over and ends at the same tick, then hands over.
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
        const hero = page.locator('.sc-hero-chart')
        expect(await hero.locator('.sc-simctl__tick b').textContent()).toBe('7')
        await page.waitForTimeout(800)
        await expect.poll(() => hero.locator('.sc-simctl__tick b').textContent(), { timeout: 10000 }).toBe('7')
        await expect.poll(() => hero.locator('.sc-what__handover').count(), { timeout: 10000 }).toBe(1)
        await browser.close()
    }, 60000)
})

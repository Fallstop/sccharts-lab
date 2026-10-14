#!/usr/bin/env node
// Keyboard-only walk through one widget (docs-internal/QA.md, check 3): Tab into the n-th widget frame of a page
// and through it, listing every focus stop with its role, name and whether a focus ring is drawn; then step it
// with Enter on Step (or Next) and Backspace, go back to tick 0 with Previous, and check that the keyboard focus
// is never dropped to the page when a button disables itself.
//
// A Predict is answered from the keyboard and submitted with Enter. With --playground: the playground's toolbar,
// typing in the editor, leaving it with Escape then Tab, and stepping the simulation with Enter.
//
//   node tools/qa/keyboard.mjs [--url http://127.0.0.1:4330] [--route /learn/transitions/] [--frame 0]
//   node tools/qa/keyboard.mjs --playground
import { browser as launch, parseArgs, serve } from './common.mjs'

const { opts } = parseArgs()
const route = String(opts.route ?? '/learn/transitions/')
const idx = Number(opts.frame ?? 0)
const server = await serve(opts.url)
const browser = await launch()
let fail = 0
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(String(e)))
    if (opts.playground) {
        await page.goto(server.base + '/playground/', { waitUntil: 'networkidle' })
        await page.waitForTimeout(1500)
        const name = () => page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim().slice(0, 40))
        const seen = []
        // The skip link, the header, the trust note's two links and the toolbar come before the editor.
        for (let i = 0; i < 20; i++) {
            await page.keyboard.press('Tab')
            seen.push(await name())
            if (seen.at(-1) === 'SCTX source') break
        }
        console.log(`playground: Tab reaches ${seen.join(' | ')}`)
        if (seen.at(-1) !== 'SCTX source') fail++
        await page.keyboard.press('Control+End')
        await page.keyboard.type('\n// typed from the keyboard')
        await page.waitForTimeout(600)
        // The first Escape closes the completion list that typing opened; the second arms Tab to leave.
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Tab')
        const after = await name()
        if (after === 'SCTX source') fail++
        console.log(`  typed in the editor; Escape (twice: the completion list) then Tab moves on to: ${after}`)
        let stepped = false
        for (let i = 0; i < 60 && !stepped; i++) {
            if ((await name()) === 'Step') {
                await page.keyboard.press('Enter')
                await page.keyboard.press('Enter')
                stepped = true
            } else await page.keyboard.press('Tab')
        }
        await page.waitForTimeout(500)
        const tick = await page.locator('.sc-simctl__tick').first().textContent().catch(() => '')
        if (!stepped || !/Tick 2/.test(tick ?? '')) fail++
        console.log(`  Step with Enter twice: ${stepped ? (tick ?? '').trim() : 'Step NOT REACHED'}`)
        if (errors.length) fail++
        console.log(`  console: ${errors.length ? errors.join(' | ') : 'none'}`)
        process.exitCode = fail ? 1 : 0
        await browser.close()
        server.stop()
        process.exit()
    }
    await page.goto(server.base + route, { waitUntil: 'networkidle' })
    const focused = () =>
        page.evaluate((i) => {
            const e = document.activeElement
            if (!e || e === document.body) return null
            // The ring is on the element, or on the control that wraps it (an input switch: :has(input:focus-visible)).
            const ringOn = (el) => {
                const cs = getComputedStyle(el)
                return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'
            }
            const frame = e.closest('.sc-frame')
            return {
                tag: e.tagName.toLowerCase(),
                role: e.getAttribute('role') ?? '',
                name: (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim().slice(0, 50),
                inFrame: frame === document.querySelectorAll('.sc-frame')[i],
                // Diagrams draw their own ring (a rect).
                ring: ringOn(e) || !!e.closest('.sc-input--bool, .sc-input') && ringOn(e.closest('.sc-input--bool, .sc-input')) || !!frame?.querySelector('.sc-focus-ring'),
            }
        }, idx)
    await page.evaluate((i) => {
        const f = document.querySelectorAll('.sc-frame')[i]
        f.scrollIntoView({ block: 'center' })
        const all = [...document.querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"]), summary, select, textarea')]
        all[all.findIndex((el) => f.contains(el)) - 1]?.focus()
    }, idx)
    const stops = []
    for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab')
        const d = await focused()
        if (!d?.inFrame) {
            if (stops.length) break
            continue
        }
        stops.push(d)
    }
    console.log(`${route}, widget ${idx}: ${stops.length} focus stops`)
    for (const s of stops) {
        if (!s.ring) fail++
        console.log(`  ${s.ring ? 'ring   ' : 'NO RING'} <${s.tag}${s.role ? ` role=${s.role}` : ''}> ${s.name}`)
    }
    // Operate it: Step (or Next) twice, back once, then Previous until it disables itself.
    const press = async (name, key = 'Enter') => {
        const target = page.locator('.sc-frame').nth(idx).getByRole('button', { name, exact: true }).first()
        if (!(await target.count()) || !(await target.isEnabled())) return false
        await target.focus()
        await page.keyboard.press(key)
        await page.waitForTimeout(300)
        return true
    }
    const frame = page.locator('.sc-frame').nth(idx)
    if ((await frame.locator('.sc-predict').count()) > 0) {
        // A Predict: answer every question with the keyboard (type, or pick the first option), submit with Enter.
        const fields = frame.locator('.sc-predict__form :is(input:not([type=radio]), select)')
        for (let i = 0; i < (await fields.count()); i++) {
            const f = fields.nth(i)
            await f.focus()
            if ((await f.evaluate((el) => el.tagName)) === 'SELECT') await page.keyboard.press('ArrowDown')
            else await page.keyboard.type('0')
        }
        await page.keyboard.press('Enter')
        const verdict = frame.locator('.sc-predict__score')
        await verdict.waitFor({ timeout: 20000 }).catch(() => {})
        const text = (await verdict.textContent().catch(() => ''))?.trim()
        if (!text) fail++
        console.log(`  keys: filled ${await fields.count()} answer field(s) and pressed Enter: ${text ? `"${text}"` : 'NO VERDICT'}`)
        if (errors.length) fail++
        console.log(`  console: ${errors.length ? errors.join(' | ') : 'none'}`)
        process.exitCode = fail ? 1 : 0
        await browser.close()
        server.stop()
        process.exit()
    }
    if ((await frame.locator('.sc-reads').count()) > 0) {
        // How KIELER reads it: press a trap (one not shown yet) with Enter, then type an expression of one's own; each must update the
        // reading.
        const out = () => frame.locator('.sc-reads__out').textContent()
        const before = (await out())?.trim()
        await frame.locator('.sc-reads__seeds button[aria-pressed="false"]').first().focus()
        await page.keyboard.press('Enter')
        await page.waitForTimeout(300)
        const trap = (await out())?.trim()
        await frame.locator('.sc-reads__input').focus()
        await page.keyboard.press('Control+A')
        await page.keyboard.type('a + b * c')
        await page.waitForTimeout(300)
        const typed = (await out())?.trim()
        const ok = trap !== before && typed !== trap && /a \+ \(?b \* c\)?/.test(typed ?? '')
        if (!ok) fail++
        console.log(`  keys: Enter on a trap ${trap !== before ? 'changed' : 'DID NOT change'} the reading; typed "a + b * c": ${JSON.stringify((typed ?? '').slice(0, 60))}`)
        if (errors.length) fail++
        console.log(`  console: ${errors.length ? errors.join(' | ') : 'none'}`)
        process.exitCode = fail ? 1 : 0
        await browser.close()
        server.stop()
        process.exit()
    }
    const tick = () => frame.locator('.sc-tour__label, .sc-simctl__tick').first().textContent()
    const t0 = (await tick())?.trim()
    ;(await press('Next')) || (await press('Step'))
    ;(await press('Next')) || (await press('Step'))
    const t2 = (await tick())?.trim()
    let lost = false
    while (await press('Previous')) {
        const d = await focused()
        if (!d) lost = true
    }
    const tEnd = (await tick())?.trim()
    if (t0 === t2 || lost) fail++
    console.log(`  keys: "${t0}" -> "${t2}" -> Previous to the start: "${tEnd}"; focus ${lost ? 'DROPPED to the page' : 'kept in the widget'}`)
    if (errors.length) fail++
    console.log(`  console: ${errors.length ? errors.join(' | ') : 'none'}`)
} finally {
    await browser.close()
    server.stop()
}
process.exitCode = fail ? 1 : 0

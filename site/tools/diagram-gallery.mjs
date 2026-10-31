#!/usr/bin/env node
// Visual QA for the diagram renderer: renders a set of charts into tests/diagram-gallery/index.html (light and
// dark theme with the site's --sc-* tokens, highlight samples, a 390 px phone column) and screenshots it with
// Playwright into tests/diagram-gallery/screenshots/ (one PNG per chart and theme, plus the full page).
//
//   node tools/diagram-gallery.mjs [chart.sctx ...] [--no-shots] [--only <substring>] [--out <dir>]
//
// Without arguments it renders tests/diagram/{charts,kieler}/*.sctx, the KIELER wiki examples in tests/corpus/wiki
// and the lab fixtures in tests/corpus/lab. It also checks the text width table against chromium's
// rendering and prints the largest deviation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createViteServer } from 'vitest/node'
import { launchChromium } from './chromium.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'tests/diagram-gallery')
const shotDir = path.join(outDir, 'screenshots')

const noShots = args.includes('--no-shots')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined
const explicit = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only' && args[i - 1] !== '--out')

function listSctx(dir) {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).sort().map(f => path.join(dir, f))
}
let files = explicit.length ? explicit.map(f => path.resolve(f)) : [
    ...listSctx(path.join(root, 'tests/diagram/charts')),
    ...listSctx(path.join(root, 'tests/diagram/kieler')),
    ...listSctx(path.join(root, 'tests/corpus/wiki')),
    ...listSctx(path.join(root, 'tests/corpus/lab')),
]
if (only) files = files.filter(f => f.includes(only))

// Theme tokens from the design workstream's tokens.css: all custom properties of the dark (:root) and light
// (:root[data-theme='light']) blocks.
function themeBlocks() {
    const css = fs.readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8')
    const block = start => {
        const m = new RegExp('^' + start.replace(/[[\]()]/g, '\\$&') + '\\s*\\{', 'm').exec(css)
        if (!m) return ''
        const i = m.index
        const open = css.indexOf('{', i)
        let depth = 0
        for (let j = open; j < css.length; j++) {
            if (css[j] === '{') depth++
            else if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j)
        }
        return ''
    }
    const props = text => (text.match(/--[\w-]+\s*:[^;]+;/g) ?? []).join('\n')
    return { dark: props(block(':root')), light: props(block(":root[data-theme='light']")) }
}

const server = await createViteServer({
    root, configFile: false, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
})
try {
    const diagram = await server.ssrLoadModule('/src/diagram/index.ts')
    const support = await server.ssrLoadModule('/tests/diagram/support.ts')
    const sections = []
    const failures = []
    const highlightSamples = []
    const commented = []
    const referenced = []
    let totalMs = 0
    for (const file of files) {
        const name = path.relative(root, file)
        const source = fs.readFileSync(file, 'utf8')
        try {
            const { chart, program } = await support.chartOf(source)
            const t0 = performance.now()
            const layout = await diagram.layoutChart(chart, { program })
            const ms = performance.now() - t0
            totalMs += ms
            const svg = diagram.renderSvg(layout, { fit: 'none' })
            sections.push({ name, svg, ms, layout, chart })
            if (/\bstate\s+\w+(\s+"[^"]*")?\s+is\s/.test(source)) {
                const expanded = await diagram.layoutChart(chart, { references: 'expanded', program })
                referenced.push({ name, svg: diagram.renderSvg(expanded, { fit: 'none' }), ms: 0, layout: expanded })
            }
            if (/\/\*\*/.test(source)) {
                const withComments = await diagram.layoutChart(chart, { comments: true, program })
                commented.push({ name, svg: diagram.renderSvg(withComments, { fit: 'none' }), ms: 0, layout: withComments })
            }
            if (/abro|aborts|concurrencies|complex|transitions\.sctx|dishwasher/i.test(name)) highlightSamples.push({ name, layout })
        } catch (error) {
            failures.push({ name, message: String(error?.stack ?? error).split('\n').slice(0, 4).join('\n') })
        }
    }

    // Highlight samples: a plausible tick (first initial leaf state active, its outgoing transition taken).
    const highlighted = highlightSamples.map(({ name, layout }) => {
        const classes = {}
        const states = []
        const walk = s => { for (const r of s.regions) for (const c of r.states) { states.push({ c, r }); walk(c) } }
        walk(layout.root)
        const leaf = states.find(({ c }) => c.initial && c.shape === 'simple') ?? states[0]
        if (leaf) {
            classes[leaf.c.id] = ['is-active', 'is-entered']
            const t = leaf.r.transitions.find(x => x.source === leaf.c.id)
            if (t) {
                classes[t.id] = ['is-taken']
                classes[t.target] = ['is-active', 'is-entered']
                classes[leaf.c.id] = ['is-exited']
            }
        }
        const other = states.find(({ c }) => c.shape !== 'connector' && !classes[c.id])
        if (other) classes[other.c.id] = ['is-focus']
        const errorState = states.filter(({ c }) => !classes[c.id]).at(-1)
        if (errorState) classes[errorState.c.id] = ['is-error']
        return { name, svg: diagram.renderSvg(layout, { fit: 'none', classes }) }
    })

    const themes = themeBlocks()
    const css = fs.readFileSync(path.join(root, 'src/diagram/diagram.css'), 'utf8')
    const rel = p => path.relative(outDir, path.join(root, p)).split(path.sep).join('/')
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const figure = (s, i, theme) => `<figure id="${theme}-${i}" class="chart"><figcaption>${esc(s.name)} <span>${s.layout ? `${Math.round(s.layout.width)}×${Math.round(s.layout.height)}, ${s.ms.toFixed(0)} ms` : ''}</span></figcaption>${s.svg}</figure>`
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagram gallery</title>
<style>
@font-face { font-family: 'Atkinson Hyperlegible Next Variable'; font-weight: 200 800; src: url(${rel('node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Atkinson Hyperlegible Mono Variable'; font-weight: 200 800; src: url(${rel('node_modules/@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2')}) format('woff2'); }
body { margin: 0; font: 14px/1.4 'Atkinson Hyperlegible Next Variable', sans-serif; }
.theme { padding: 16px; }
.theme-light { ${themes.light} background: var(--c-paper, #fff); color: var(--c-text, #222); }
.theme-dark { ${themes.dark} background: var(--c-paper, #121a2a); color: var(--c-text, #ddd); }
.grid { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.chart { margin: 0; padding: 10px; border: 1px solid var(--c-rule, #ccc); border-radius: 6px; background: var(--c-sheet, transparent); }
.chart figcaption { font-size: 12px; margin-bottom: 6px; color: var(--c-muted, #666); }
.chart figcaption span { opacity: .7; }
.phone { width: 390px; padding: 16px; box-sizing: border-box; border: 1px dashed var(--c-rule, #aaa); }
.phone .chart { padding: 6px; }
h2 { margin: 8px 0 12px; font-size: 18px; }
pre.fail { color: #c33; white-space: pre-wrap; }
${css}
</style></head><body>
${['light', 'dark'].map(theme => `<section class="theme theme-${theme}" id="section-${theme}"><h2>${theme} theme</h2>
<div class="grid">${sections.map((s, i) => figure(s, i, theme)).join('\n')}</div>
<h2>Highlights (is-active, is-entered, is-exited, is-taken, is-focus, is-error)</h2>
<div class="grid">${highlighted.map((s, i) => figure({ ...s, ms: 0 }, `hl-${i}`, theme)).join('\n')}</div>
<h2>References expanded (references: 'expanded')</h2>
<div class="grid">${referenced.map((s, i) => figure(s, `ref-${i}`, theme)).join('\n')}</div>
<h2>Doc comments (comments: true)</h2>
<div class="grid">${commented.map((s, i) => figure(s, `doc-${i}`, theme)).join('\n')}</div>
<h2>Phone width (fit: width)</h2>
<div class="phone" id="${theme}-phone">${sections.filter(s => /abro|aborts|dishwasher/i.test(s.name)).map(s => `<figure class="chart"><figcaption>${esc(s.name)}</figcaption>${diagram.renderSvg(s.layout, { fit: 'width' })}</figure>`).join('')}</div>
</section>`).join('\n')}
${failures.length ? `<section class="theme"><h2>Failures</h2>${failures.map(f => `<pre class="fail">${esc(f.name)}\n${esc(f.message)}</pre>`).join('')}</section>` : ''}
</body></html>`
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'index.html'), html)
    console.log(`rendered ${sections.length} charts (${failures.length} failed) in ${totalMs.toFixed(0)} ms layout time -> ${path.relative(root, path.join(outDir, 'index.html'))}`)
    for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message.split('\n')[0]}`)

    if (!noShots) {
        fs.mkdirSync(shotDir, { recursive: true })
        for (const f of fs.readdirSync(shotDir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(shotDir, f))
        const browser = await launchChromium()
        try {
            const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 })
            await page.goto('file://' + path.join(outDir, 'index.html'))
            await page.evaluate(() => document.fonts.ready)
            // Text width check: the layout's measured line widths against chromium's rendering.
            const samples = ['Transitions', 'input bool ', 'A, B', '1: A && B / O = true;', 'WaitAB', 'immediate during ', 'x = pre(x) + 1', 'ÄÖÜ äöü ß', '{1, 2, 3}', 'combine +']
            const expected = []
            for (const text of samples) for (const style of [{ size: 11, bold: true }, { size: 11 }, { size: 10 }, { size: 10, bold: true }, { size: 10, mono: true }]) {
                expected.push({ text, style, width: diagram.measureWithTable(text, style) })
            }
            const deviations = await page.evaluate(async items => {
                for (const w of [400, 700]) {
                    await document.fonts.load(`${w} 10px 'Atkinson Hyperlegible Next Variable'`)
                    await document.fonts.load(`${w} 10px 'Atkinson Hyperlegible Mono Variable'`)
                }
                const ns = 'http://www.w3.org/2000/svg'
                const svg = document.createElementNS(ns, 'svg')
                svg.setAttribute('class', 'sc-diagram')
                document.body.appendChild(svg)
                const out = items.map(item => {
                    const t = document.createElementNS(ns, 'text')
                    t.setAttribute('font-size', String(item.style.size))
                    if (item.style.bold) t.setAttribute('class', 'sc-bold' + (item.style.mono ? ' sc-mono' : ''))
                    else if (item.style.mono) t.setAttribute('class', 'sc-mono')
                    t.textContent = item.text
                    svg.appendChild(t)
                    return { text: item.text, style: item.style, expected: item.width, actual: t.getComputedTextLength() }
                })
                svg.remove()
                return out
            }, expected)
            const worst = deviations.map(d => ({ ...d, diff: Math.abs(d.actual - d.expected) })).sort((a, b) => b.diff - a.diff)
            for (const w of worst.slice(0, 3)) console.log(`text width check: deviation ${w.diff.toFixed(3)} px (${JSON.stringify(w.text)} ${JSON.stringify(w.style)}: table ${w.expected.toFixed(2)}, chromium ${w.actual.toFixed(2)})`)
            for (const theme of ['light', 'dark']) {
                const figures = await page.locator(`#section-${theme} .grid > figure.chart`).all()
                for (const fig of figures) {
                    const id = await fig.getAttribute('id')
                    const caption = (await fig.locator('figcaption').innerText()).split(' ')[0]
                    const slug = caption.replace(/^tests\//, '').replace(/[^\w.-]+/g, '_').replace(/\.sctx$/, '')
                    const kind = id.includes('hl-') ? 'hl-' : id.includes('doc-') ? 'doc-' : id.includes('ref-') ? 'ref-' : ''
                    await fig.screenshot({ path: path.join(shotDir, `${theme}-${kind}${slug}.png`) })
                }
                await page.locator(`#${theme}-phone`).screenshot({ path: path.join(shotDir, `${theme}-phone.png`) })
            }
            console.log(`screenshots -> ${path.relative(root, shotDir)}`)
        } finally {
            await browser.close()
        }
    }
} finally {
    await server.close()
}

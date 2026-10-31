#!/usr/bin/env node
// Renders public/og.png, the 1200 x 630 social card (og:image) of sccharts.jmw.nz: the mark, the
// landing headline and the landing chart (Toggle, with On active and Off -> On just taken), in the
// light theme's colours. Rerun after changing the headline or the palette:
//
//   node tools/og-image.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fonts = path.join(site, 'node_modules/@fontsource-variable')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'AHN'; font-weight: 200 800; src: url(${fonts}/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2) format('woff2'); }
@font-face { font-family: 'Arch'; font-weight: 100 900; font-stretch: 62% 125%; src: url(${fonts}/archivo/files/archivo-latin-wdth-normal.woff2) format('woff2'); }
body { margin: 0; width: 1200px; height: 630px; background: #f8f9fd; font-family: AHN; color: #111a2c; position: relative; overflow: hidden }
.ruler { position: absolute; left: 0; right: 0; top: 0; height: 10px;
  background: linear-gradient(#b8c3d4,#b8c3d4) bottom/100% 1px no-repeat, repeating-linear-gradient(to right,#b8c3d4 0 1px,transparent 1px 96px) bottom/100% 10px no-repeat, repeating-linear-gradient(to right,#dce2ec 0 1px,transparent 1px 12px) bottom/100% 5px no-repeat }
.copy { position: absolute; left: 72px; top: 100px; width: 560px }
.brand { display: flex; align-items: center; gap: 14px; font: 650 30px Arch; font-stretch: 112% }
h1 { text-wrap: balance; font: 600 54px/1.04 Arch; font-stretch: 112%; letter-spacing: -0.02em; margin: 48px 0 0 }
p { font-size: 26px; line-height: 1.45; color: #283246; margin: 26px 0 0 }
.url { position: absolute; left: 72px; bottom: 56px; font-size: 22px; color: #536075 }
.chart { position: absolute; right: 48px; top: 120px; width: 500px; padding: 18px; border: 1px solid #b8c3d4; border-radius: 16px; background: #fff; box-shadow: 0 18px 40px -24px rgba(20,40,80,.35) }
.k-root{fill:url(#r);stroke:#a3aebd}.k-title{fill:#111826;font:600 15px AHN;text-anchor:middle}.k-decl{fill:#182030;font:13.5px AHN}.k-kw{fill:#730041;font-weight:700}
.k-region{fill:#fff;stroke:#b4bfce}.k-shadow{fill:rgba(16,24,40,.14)}.k-shape{fill:url(#s);stroke:#7d889b}.ini{stroke:#182030;stroke-width:3}
.act{stroke:#c61f3a;stroke-width:3.5}.glow{fill:none;stroke:rgba(198,31,58,.3);stroke-width:10.5}
.k-name{fill:#111826;font:700 16px AHN;text-anchor:middle;dominant-baseline:central}
.line{fill:none;stroke:#182030;stroke-width:2}.head{fill:#182030}.lab{fill:#111826;font:600 13.5px AHN;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:4px}
.taken .line{stroke:#1769d6;stroke-width:3}.taken .head{fill:#1769d6}.taken .lab{fill:#1769d6;font-weight:800}.tglow{fill:none;stroke:rgba(23,105,214,.26);stroke-width:10;stroke-linecap:round}
</style></head><body><div class="ruler"></div>
<div class="copy">
 <div class="brand"><svg viewBox="0 0 32 32" width="44" height="44"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8f9fd"/><stop offset="1" stop-color="#cddcf3"/></linearGradient></defs><rect x="2" y="6" width="28" height="20" rx="10" fill="url(#g)" stroke="#111a2c" stroke-width="3"/><path d="M7.5 20.5 H12.25 V11.5 H19.75 V20.5 H24.5" fill="none" stroke="#7a1452" stroke-width="2.75" stroke-linejoin="round" stroke-linecap="round"/></svg>SCCharts</div>
 <h1>Statecharts, one tick at a time</h1>
 <p>An interactive guide to SCCharts: learn the language by running charts tick by tick.</p>
</div>
<div class="url">sccharts.jmw.nz</div>
<div class="chart"><svg viewBox="0 0 380 232" width="464">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8f9fd"/><stop offset="1" stop-color="#cddcf3"/></linearGradient><linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fafbfe"/><stop offset="1" stop-color="#e3ebf8"/></linearGradient></defs>
<rect class="k-root" x="0.75" y="0.75" width="378.5" height="230.5" rx="12"/>
<text class="k-title" x="190" y="23">Toggle</text>
<text class="k-decl" x="14" y="46"><tspan class="k-kw">input bool</tspan> button</text>
<text class="k-decl" x="14" y="64"><tspan class="k-kw">output bool</tspan> light = false</text>
<rect class="k-region" x="10" y="76" width="360" height="146" rx="6"/>
<g class="taken"><path class="tglow" d="M122 127 C 160 95, 216 91, 250 121"/><path class="line" d="M122 127 C 160 95, 216 91, 250 121"/><polygon class="head" points="257.5,127.6 247.02,124.38 252.98,117.63"/><text class="lab" x="190" y="90">button / light = true</text></g>
<g><path class="line" d="M258 165 C 220 199, 162 203, 130 171"/><polygon class="head" points="122.93,163.93 133.18,167.82 126.82,174.18"/><text class="lab" x="190" y="214">button / light = false</text></g>
<rect class="k-shadow" x="49" y="128" width="88" height="42" rx="21"/><rect class="k-shape ini" x="46" y="125" width="88" height="42" rx="21"/><text class="k-name" x="90" y="146">Off</text>
<rect class="k-shadow" x="249" y="128" width="88" height="42" rx="21"/><rect class="glow" x="246" y="125" width="88" height="42" rx="21"/><rect class="k-shape act" x="246" y="125" width="88" height="42" rx="21"/><text class="k-name" x="290" y="146">On</text>
</svg></div>
</body></html>
`

function findChromium() {
    const root = path.join(os.homedir(), '.cache/ms-playwright')
    if (!fs.existsSync(root)) return undefined
    const shells = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of shells) {
        const exe = path.join(root, d, 'chrome-headless-shell-linux64/chrome-headless-shell')
        if (fs.existsSync(exe)) return exe
    }
    return undefined
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'))
const file = path.join(dir, 'og.html')
fs.writeFileSync(file, html)
const browser = await chromium.launch({ executablePath: findChromium() })
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
    await page.goto('file://' + file)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(site, 'public/og.png') })
} finally {
    await browser.close()
    fs.rmSync(dir, { recursive: true, force: true })
}
console.log('public/og.png')

#!/usr/bin/env node
// Screenshots of the built site, in light and dark mode, at a phone and a desktop width.
//
//   pnpm build
//   node tools/screenshot.mjs / /learn/ticks/ /playground/       # starts `astro preview` itself
//   node tools/screenshot.mjs --url http://localhost:4321 /      # use a server that is already running
//
// Options:
//   --widths 390,1280     viewport widths (default 390,1280)
//   --themes light,dark   (default both)
//   --viewport            capture only the first screen instead of the full page
//   --motion              allow motion (default: prefers-reduced-motion, for stable pictures)
//   --engage              hydrate every widget first (they hydrate when a reader engages with them, client:engage;
//                         without this flag the pictures show the server-rendered state, which is what loads)
//   --wait <ms>           extra wait after load (default 250)
//   --out <dir>           output directory (default tests/screenshots, git-ignored)
//
// Files are named <route>-<theme>-<width>.png, e.g. learn-ticks-dark-390.png ("index" for /).
// Chromium: the newest headless shell in ~/.cache/ms-playwright, else Playwright's default.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const v = argv[i + 1]
    argv.splice(i, 2)
    return v
}
const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return false
    argv.splice(i, 1)
    return true
}

const widths = opt('widths', '390,1280').split(',').map(Number)
const themes = opt('themes', 'light,dark').split(',')
const out = path.resolve(site, opt('out', 'tests/screenshots'))
const wait = Number(opt('wait', '250'))
let baseUrl = opt('url', '')
const viewportOnly = flag('viewport')
const motion = flag('motion')
const engage = flag('engage')
const routes = argv.length ? argv : ['/']

function findChromium() {
    const root = path.join(os.homedir(), '.cache/ms-playwright')
    if (!fs.existsSync(root)) return undefined
    const shells = fs
        .readdirSync(root)
        .filter((d) => d.startsWith('chromium_headless_shell-'))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of shells) {
        const exe = path.join(root, d, 'chrome-headless-shell-linux64/chrome-headless-shell')
        if (fs.existsSync(exe)) return exe
    }
    return undefined
}

async function startPreview() {
    const port = 4400 + Math.floor(Math.random() * 400)
    // Our own foreground server (--ignore-lock: Astro otherwise reuses or backgrounds a shared one),
    // in its own process group so it can be stopped with everything it started.
    const astro = path.join(site, 'node_modules/astro/bin/astro.mjs')
    const child = spawn(process.execPath, [astro, 'preview', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
        cwd: site,
        stdio: 'ignore',
        detached: true,
    })
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url + '/')
            if (res.ok) return { url, child }
        } catch {}
        await new Promise((r) => setTimeout(r, 200))
    }
    stop(child)
    throw new Error('astro preview did not start within 30 s (did you run pnpm build?)')
}

function stop(child) {
    try {
        process.kill(-child.pid, 'SIGTERM')
    } catch {
        child.kill()
    }
}

const slug = (route) => route.replace(/^\/|\/$/g, '').replace(/[/?=&]+/g, '-') || 'index'

let preview
if (!baseUrl) {
    preview = await startPreview()
    baseUrl = preview.url
}
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: findChromium() })
const written = []
try {
    for (const theme of themes) {
        for (const width of widths) {
            const context = await browser.newContext({
                viewport: { width, height: width < 600 ? 844 : 900 },
                deviceScaleFactor: 1,
                colorScheme: theme === 'dark' ? 'dark' : 'light',
                reducedMotion: motion ? 'no-preference' : 'reduce',
            })
            await context.addInitScript((t) => {
                try {
                    localStorage.setItem('starlight-theme', t)
                } catch {}
            }, theme)
            const page = await context.newPage()
            for (const route of routes) {
                await page.goto(baseUrl + route, { waitUntil: 'networkidle' })
                await page.evaluate(() => document.fonts.ready)
                if (engage) {
                    await page.evaluate(() => {
                        for (const f of document.querySelectorAll('.sc-frame')) f.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
                    })
                    await page
                        .waitForFunction(() => [...document.querySelectorAll('astro-island')].every((i) => !i.hasAttribute('ssr')), null, { timeout: 20000 })
                        .catch(() => console.warn(`${route}: not every widget hydrated`))
                }
                await page.waitForTimeout(wait)
                const file = path.join(out, `${slug(route)}-${theme}-${width}.png`)
                await page.screenshot({ path: file, fullPage: !viewportOnly })
                written.push(path.relative(site, file))
            }
            await context.close()
        }
    }
} finally {
    await browser.close()
    if (preview) stop(preview.child)
}
console.log(written.join('\n'))

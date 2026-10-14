// Shared bits of the production QA scripts in tools/qa (docs-internal/QA.md): the site directory, the built
// pages, an `astro preview` of dist/ when no --url is given, and argument parsing.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const dist = path.join(site, 'dist')

/** `--name value` and `--flag` options; what is left are positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
    const opts = {}
    const rest = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (!a.startsWith('--')) rest.push(a)
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i]
        else opts[a.slice(2)] = true
    }
    return { opts, rest }
}

/** Every route of the build, from the sitemap (drafts are not in it), plus an unknown path for the 404 page. */
export function routes({ with404 = true } = {}) {
    if (!fs.existsSync(path.join(dist, 'sitemap-0.xml'))) throw new Error('No dist/sitemap-0.xml: run pnpm build first.')
    const sitemap = fs.readFileSync(path.join(dist, 'sitemap-0.xml'), 'utf8')
    const list = [...sitemap.matchAll(/<loc>https:\/\/sccharts\.jmw\.nz([^<]*)<\/loc>/g)].map((m) => m[1])
    if (with404) list.push('/no-such-page/')
    return list
}

/** The base URL to test: --url, else a fresh `astro preview` of dist/ (stopped by the returned function). */
export async function serve(url) {
    if (typeof url === 'string') return { base: url.replace(/\/$/, ''), stop: () => {} }
    const port = 4400 + Math.floor(Math.random() * 400)
    const astro = path.join(site, 'node_modules/astro/bin/astro.mjs')
    const child = spawn(process.execPath, [astro, 'preview', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
        cwd: site,
        stdio: 'ignore',
        detached: true,
    })
    const stop = () => {
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            child.kill()
        }
    }
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        try {
            if ((await fetch(base + '/')).ok) return { base, stop }
        } catch {}
        await new Promise((r) => setTimeout(r, 200))
    }
    stop()
    throw new Error('astro preview did not start within 30 s (did you run pnpm build?)')
}

export async function browser() {
    const { launchChromium } = await import(path.join(site, 'tools/chromium.mjs'))
    return launchChromium()
}

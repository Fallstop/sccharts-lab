#!/usr/bin/env node
// Links of the built site (docs-internal/QA.md, check 2). Reads dist/**/*.html, no server needed:
//  - every internal href/src resolves to a file, with a trailing slash for pages, and every #anchor exists;
//  - playground links name examples that exist (?example=, &solution=);
//  - nothing links to a draft (/design/);
//  - with --external: every external URL answers 2xx/3xx (GET, following redirects, browser user agent).
//
//   node tools/qa/links.mjs [--external]
import fs from 'node:fs'
import path from 'node:path'
import { dist, parseArgs, site } from './common.mjs'

const { opts } = parseArgs()
const pages = []
;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
            if (e.name !== '_astro' && e.name !== 'pagefind') walk(p)
        } else if (e.name.endsWith('.html')) pages.push(p)
    }
})(dist)

const decode = (s) => s.replace(/&amp;|&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const routeOf = (file) => {
    const rel = '/' + path.relative(dist, file).split(path.sep).join('/')
    return rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel
}

const ids = new Map()
const links = []
for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8')
    const route = routeOf(file)
    ids.set(route, new Set([...html.matchAll(/\s(?:id|name)="([^"]*)"/g)].map((m) => decode(m[1]))))
    for (const m of html.matchAll(/<(a|link|script|img|source|iframe|use|image)\b([^>]*)>/gi)) {
        if (/rel="(preconnect|dns-prefetch)"/.test(m[2])) continue
        for (const a of m[2].matchAll(/\s(href|src|xlink:href|srcset)="([^"]*)"/gi)) {
            let v = decode(a[2])
            if (a[1].toLowerCase() === 'srcset') v = v.split(',')[0].trim().split(/\s+/)[0]
            links.push({ from: route, url: v, tag: m[1].toLowerCase() })
        }
    }
}

const exampleExists = (id) => {
    const clean = id.replace(/^\/+/, '').replace(/\.sctx$/, '')
    return clean.startsWith('showcase/')
        ? fs.existsSync(path.join(site, 'src/components/playground/showcase', clean.slice(9) + '.sctx'))
        : fs.existsSync(path.join(site, 'src/examples', clean + '.sctx'))
}
const fileFor = (p) => {
    const f = path.join(dist, decodeURIComponent(p))
    if (p.endsWith('/')) return fs.existsSync(path.join(f, 'index.html')) ? path.join(f, 'index.html') : null
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
    if (fs.existsSync(path.join(f, 'index.html'))) return 'NOSLASH'
    return fs.existsSync(f + '.html') ? f + '.html' : null
}

const problems = new Set()
const externals = new Map()
let internal = 0
for (const { from, url, tag } of links) {
    if (/^(mailto|tel|javascript|data):/i.test(url)) continue
    // The 404 page's own canonical and og:url (Starlight's /404/; the page is noindex).
    if (from === '/404.html' && url === 'https://sccharts.jmw.nz/404/') continue
    if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
        if (new URL(url, 'https://sccharts.jmw.nz').host !== 'sccharts.jmw.nz') {
            if (!externals.has(url)) externals.set(url, new Set())
            externals.get(url).add(from)
            continue
        }
    }
    internal++
    const u = new URL(url, 'https://sccharts.jmw.nz' + from)
    const p = u.pathname
    if (p.startsWith('/design/')) problems.add(`${from}: ${url} links to a draft page`)
    const f = fileFor(p)
    if (!f) {
        problems.add(`${from}: ${url}: no such file`)
        continue
    }
    if (f === 'NOSLASH' && tag === 'a') problems.add(`${from}: ${url}: no trailing slash (a redirect)`)
    const anchor = u.hash.length > 1 ? decodeURIComponent(u.hash.slice(1)) : ''
    if (anchor && ids.get(p) && !ids.get(p).has(anchor)) problems.add(`${from}: ${url}: no element with id "${anchor}"`)
    if (p === '/playground/')
        for (const key of ['example', 'solution']) {
            const id = u.searchParams.get(key)
            if (id && !exampleExists(id)) problems.add(`${from}: ${url}: there is no example ${id}`)
        }
}
console.log(`${pages.length} pages, ${links.length} links (${internal} internal), ${externals.size} external URLs`)

if (opts.external) {
    const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
    for (const [url, from] of externals) {
        let status = 'error'
        try {
            const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/pdf,*/*' }, signal: AbortSignal.timeout(25_000) })
            status = res.status
            res.body?.cancel()
        } catch (e) {
            status = String(e.cause?.code ?? e.name)
        }
        const ok = typeof status === 'number' && status < 400
        console.log(`${ok ? 'ok ' : 'BAD'} ${status} ${url}`)
        if (!ok) problems.add(`external ${url} (${status}), linked from ${[...from].join(', ')}`)
    }
}
for (const p of problems) console.log('PROBLEM', p)
console.log(problems.size ? `${problems.size} problems` : 'no problems')
process.exitCode = problems.size ? 1 : 0

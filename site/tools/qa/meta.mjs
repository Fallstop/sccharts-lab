#!/usr/bin/env node
// SEO and meta tags of the built site (docs-internal/QA.md, check 7). Reads dist/, no server needed: a unique
// <title> and description on every page, the canonical URL and og:url on https://sccharts.jmw.nz, Open Graph and
// Twitter tags, a favicon and lang, the sitemap (every page, no drafts, no 404), robots.txt with the sitemap,
// the social card and icons, and a noindex 404 page.
//
//   node tools/qa/meta.mjs
import fs from 'node:fs'
import path from 'node:path'
import { dist } from './common.mjs'

const pages = []
;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
            if (e.name !== '_astro' && e.name !== 'pagefind') walk(p)
        } else if (e.name.endsWith('.html')) pages.push(p)
    }
})(dist)
const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const routeOf = (file) => {
    const rel = '/' + path.relative(dist, file).split(path.sep).join('/')
    return rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel
}

const problems = []
const titles = new Map()
const descriptions = new Map()
const routes = []
for (const file of pages.sort()) {
    const html = fs.readFileSync(file, 'utf8')
    const head = html.slice(html.indexOf('<head'), html.indexOf('</head>'))
    const r = routeOf(file)
    routes.push(r)
    const meta = (attr, name) => {
        const m = new RegExp(`<meta\\s+${attr}="${name.replace(/[.:]/g, '\\$&')}"\\s+content="([^"]*)"`).exec(head)
        return m ? unescape(m[1]) : undefined
    }
    const title = /<title>([^<]*)<\/title>/.exec(head)?.[1]
    const desc = meta('name', 'description')
    const canonical = /<link rel="canonical" href="([^"]*)"/.exec(head)?.[1]
    titles.set(title, [...(titles.get(title) ?? []), r])
    descriptions.set(desc, [...(descriptions.get(desc) ?? []), r])
    if (!title) problems.push(`${r}: no <title>`)
    if (!desc) problems.push(`${r}: no description`)
    else if (r !== '/404.html' && (desc.length < 50 || desc.length > 170)) problems.push(`${r}: description of ${desc.length} characters`)
    if (r !== '/404.html') {
        const want = 'https://sccharts.jmw.nz' + r
        if (canonical !== want) problems.push(`${r}: canonical ${canonical}, not ${want}`)
        if (meta('property', 'og:url') !== want) problems.push(`${r}: og:url ${meta('property', 'og:url')}`)
    } else if (!/<meta name="robots" content="noindex"/.test(head)) problems.push('404.html can be indexed')
    for (const [attr, name] of [['property', 'og:title'], ['property', 'og:description'], ['property', 'og:image'], ['property', 'og:image:alt'], ['property', 'og:type'], ['property', 'og:site_name'], ['name', 'twitter:card'], ['name', 'twitter:image']])
        if (meta(attr, name) === undefined) problems.push(`${r}: no ${name}`)
    if (!/<link rel="(shortcut )?icon"/.test(head)) problems.push(`${r}: no favicon`)
    if (!/<html[^>]*\slang="en/.test(html)) problems.push(`${r}: no lang="en"`)
}
for (const [t, rs] of titles) if (rs.length > 1) problems.push(`title "${t}" on ${rs.join(', ')}`)
for (const [d, rs] of descriptions) if (rs.length > 1) problems.push(`description "${d}" on ${rs.join(', ')}`)

const sitemap = fs.readFileSync(path.join(dist, 'sitemap-0.xml'), 'utf8')
const locs = new Set([...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]))
for (const l of locs) if (l.includes('/design/') || l.includes('404')) problems.push(`the sitemap lists ${l}`)
for (const r of routes) if (r !== '/404.html' && !locs.has('https://sccharts.jmw.nz' + r)) problems.push(`the sitemap misses ${r}`)
const robots = path.join(dist, 'robots.txt')
if (!fs.existsSync(robots)) problems.push('no robots.txt')
else if (!fs.readFileSync(robots, 'utf8').includes('Sitemap: https://sccharts.jmw.nz/sitemap-index.xml')) problems.push('robots.txt names no sitemap')
for (const f of ['favicon.svg', 'apple-touch-icon.png', 'og.png', '404.html', '_headers']) if (!fs.existsSync(path.join(dist, f))) problems.push(`no dist/${f}`)

console.log(`${pages.length} pages, ${locs.size} sitemap URLs, ${titles.size} distinct titles`)
for (const p of problems) console.log('PROBLEM', p)
console.log(problems.length ? `${problems.length} problems` : 'no problems')
process.exitCode = problems.length ? 1 : 0

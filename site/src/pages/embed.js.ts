// /embed.js: the loader of <sccharts-lab-chart> (packages/embed/src/loader.ts), one small dependency-free script that
// any page can include. Built by tools/packages/embed-bundle.mjs (Vite's library build: an IIFE, minified), the same
// build as the npm package's dist/embed.min.js, at `astro build` into dist/embed.js and on each request by the dev
// server. Not hashed: public/_headers lets any origin load it and keeps it fresh.
import type { APIRoute } from 'astro'
import fs from 'node:fs'
import path from 'node:path'
import { buildEmbedBundle } from '../../tools/packages/embed-bundle.mjs'

export const prerender = true

/** The loader's source: from the site's folder (astro runs there), or from the repository's root. */
function entry(): string {
    for (const dir of [process.cwd(), path.join(process.cwd(), 'site')]) {
        const file = path.join(dir, 'packages/embed/src/loader.ts')
        if (fs.existsSync(file)) return file
    }
    throw new Error('embed.js: packages/embed/src/loader.ts not found (run astro from site/)')
}

export const GET: APIRoute = async () =>
    new Response(await buildEmbedBundle(entry()), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })

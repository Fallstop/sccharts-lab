// /embed.js: the loader of <sccharts-lab-chart> (packages/embed/src/loader.ts), one small dependency-free script that
// any page can include. Built here with Vite's library build (an IIFE, minified), at `astro build` into dist/embed.js
// and on each request by the dev server. Not hashed: public/_headers lets any origin load it and keeps it fresh.
import type { APIRoute } from 'astro'
import fs from 'node:fs'
import path from 'node:path'

export const prerender = true

/** The loader's source: from the site's folder (astro runs there), or from the repository's root. */
function entry(): string {
    for (const dir of [process.cwd(), path.join(process.cwd(), 'site')]) {
        const file = path.join(dir, 'packages/embed/src/loader.ts')
        if (fs.existsSync(file)) return file
    }
    throw new Error('embed.js: packages/embed/src/loader.ts not found (run astro from site/)')
}

const BANNER = '/*! SCCharts Lab embed: <sccharts-lab-chart>. EPL-2.0. How to use it: https://sccharts.jmw.nz/reference/embed/ */\n'

export const GET: APIRoute = async () => {
    const { build } = await import('vite')
    const file = entry()
    const result = await build({
        configFile: false,
        root: path.dirname(file),
        logLevel: 'silent',
        envFile: false,
        build: {
            write: false,
            emptyOutDir: false,
            sourcemap: false,
            minify: true,
            target: 'es2020',
            lib: { entry: file, formats: ['iife'], name: 'SCChartsLabEmbed', fileName: () => 'embed.js' },
        },
    })
    const outputs = (Array.isArray(result) ? result : [result]) as { output: { type: string; code?: string }[] }[]
    const chunk = outputs.flatMap(o => o.output).find(o => o.type === 'chunk')
    if (!chunk?.code) throw new Error('embed.js: the library build produced no code')
    return new Response(BANNER + chunk.code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
}

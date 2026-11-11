// The single-file build of <sccharts-lab-chart> (packages/embed/src/loader.ts): one minified, dependency-free IIFE,
// with Vite's library build. The site serves it as /embed.js (src/pages/embed.js.ts) and the npm package ships the
// same file as dist/embed.min.js (tools/packages/build.mjs).

export const EMBED_BANNER = '/*! SCCharts Lab embed: <sccharts-lab-chart>. EPL-2.0. How to use it: https://sccharts.jmw.nz/reference/embed/ */\n'

/**
 * Builds the loader at `entry` (the absolute path of packages/embed/src/loader.ts; the site's endpoint finds it from
 * the working directory, since Astro bundles this module elsewhere).
 * @param {string} entry
 * @returns {Promise<string>} the script, with its banner
 */
export async function buildEmbedBundle(entry) {
    const { build } = await import('vite')
    const path = await import('node:path')
    const result = await build({
        configFile: false,
        root: path.dirname(entry),
        logLevel: 'silent',
        envFile: false,
        build: {
            write: false,
            emptyOutDir: false,
            sourcemap: false,
            minify: true,
            target: 'es2020',
            lib: { entry, formats: ['iife'], name: 'SCChartsLabEmbed', fileName: () => 'embed.js' },
        },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const chunk = outputs.flatMap(o => o.output).find(o => o.type === 'chunk')
    if (!chunk?.code) throw new Error('embed.js: the library build produced no code')
    return EMBED_BANNER + chunk.code
}

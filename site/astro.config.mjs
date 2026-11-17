// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import svelte from '@astrojs/svelte'
import { fileURLToPath } from 'node:url'
import noJsTheme from './src/styles/no-js-theme.mjs'

// Code block settings (SCTX highlighting, themes) live in ec.config.mjs, so that the <Code> component
// used by the guide's widgets renders exactly like fenced code blocks.

/**
 * Short inline code (`->`, `pre(x)`, `V_val`, `go to`, `x += 1`, `if d != 0`) must not break across lines: browsers
 * break after a hyphen, so `->` could end one line with '-' and start the next with '>', and a short expression read
 * across two lines is no longer one expression. Spans of at most 12 characters (spaces or not) and of at most 16
 * without spaces get the class sc-nobr (white-space: nowrap in theme.css), in prose, captions and table cells alike;
 * longer ones still wrap, so nothing overflows a phone (16 characters of code are about 150 px). The widgets' inline
 * Markdown (src/components/frame/inline-md.ts, shortCode) does the same. In a table cell, where a phone squeezes the
 * columns, longer code with spaces whose words are all short gets sc-words: it breaks only at its spaces
 * (theme.css), never inside a name or an operator. A hast plugin of Astro's Markdown processor (Sätteri), added the
 * way Starlight adds its own (to `markdown.processor.options`).
 */
/** @type {{ name: string, element: { filter: string[], visit: (node: any, ctx: any) => void }[] }} */
const shortCode = {
    name: 'sc-short-code',
    element: [
        {
            filter: ['code'],
            visit(node, ctx) {
                let cell = false
                for (let p = ctx.parent(node); p; p = ctx.parent(p)) {
                    if (p.type !== 'element') continue
                    if (p.tagName === 'pre') return
                    if (p.tagName === 'td' || p.tagName === 'th') cell = true
                }
                const text = String(ctx.textContent(node))
                const short = text.length <= 12 || (text.length <= 16 && !/\s/.test(text))
                // Words of up to 16 characters each: a longer one (`@layout[elk.direction] DOWN`) may still have to break.
                const words = !short && cell && /\S\s+\S/.test(text) && text.split(/\s+/).every((w) => w.length <= 16)
                if (!short && !words) return
                const cls = node.properties?.className
                ctx.setProperty(node, 'className', [...(Array.isArray(cls) ? cls : cls ? [String(cls)] : []), short ? 'sc-nobr' : 'sc-words'])
            },
        },
    ],
}
/** @type {import('astro').AstroIntegration} */
const shortInlineCode = {
    name: 'sc-short-inline-code',
    hooks: {
        'astro:config:setup': ({ config, logger }) => {
            const plugins = /** @type {{ options?: { hastPlugins?: unknown[] } } | undefined} */ (config.markdown?.processor)?.options?.hastPlugins
            if (Array.isArray(plugins)) plugins.push(shortCode)
            else logger.warn('The Markdown processor takes no hast plugins: short inline code may break across lines.')
        },
    },
}

/**
 * `client:engage` (src/components/sim/engage.ts): the widgets' islands hydrate when the reader first engages with
 * a widget (pointer, touch, focus, key), so a page loads no engine or Svelte code until then. Types:
 * src/components/client-directives.d.ts.
 */
/** @type {import('astro').AstroIntegration} */
const engageDirective = {
    name: 'sc-client-engage',
    hooks: {
        'astro:config:setup': ({ addClientDirective }) => {
            addClientDirective({ name: 'engage', entrypoint: fileURLToPath(new URL('./src/components/sim/engage.ts', import.meta.url)) })
        },
    },
}

/**
 * The theme without JavaScript follows the system's colour scheme (Starlight's would always be dark): the
 * middleware drops the server-rendered `data-theme="dark"` from <html>, and a PostCSS plugin gives every
 * theme-specific rule a copy for <html> without `data-theme` under prefers-color-scheme. With JavaScript,
 * Starlight's ThemeProvider sets the attribute before the first paint, as before. See src/styles/no-js-theme.mjs.
 */
/** @type {import('astro').AstroIntegration} */
const noJsThemeIntegration = {
    name: 'sc-no-js-theme',
    hooks: {
        'astro:config:setup': ({ addMiddleware }) => {
            addMiddleware({ order: 'post', entrypoint: fileURLToPath(new URL('./src/components/overrides/theme-middleware.ts', import.meta.url)) })
        },
    },
}

export default defineConfig({
    site: 'https://sccharts.jmw.nz',
    // The dev toolbar's entry point keeps failing with Vite's 'Outdated Optimize Dep' on the shared dev server.
    devToolbar: { enabled: false },
    integrations: [
        starlight({
            title: 'SCCharts Lab',
            description:
                'SCCharts Lab: a beginner-friendly, interactive guide to SCCharts, the synchronous statechart language from Kiel University’s KIELER project, and an in-browser IDE to write, run and export charts.',
            favicon: '/favicon.svg',
            // The guide and SCCharts Lab share one repository.
            social: [{ icon: 'github', label: 'SCCharts Lab and this guide on GitHub', href: 'https://github.com/Fallstop/sccharts-lab' }],
            head: [
                { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
                // Social card (tools/og-image.mjs renders it).
                { tag: 'meta', attrs: { property: 'og:image', content: 'https://sccharts.jmw.nz/og.png' } },
                { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
                { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
                { tag: 'meta', attrs: { property: 'og:image:alt', content: 'SCCharts Lab: an interactive guide and playground for SCCharts. A statechart with the states Off and On.' } },
                { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://sccharts.jmw.nz/og.png' } },
                { tag: 'meta', attrs: { name: 'theme-color', content: '#f8f9fd', media: '(prefers-color-scheme: light)' } },
                { tag: 'meta', attrs: { name: 'theme-color', content: '#0f141e', media: '(prefers-color-scheme: dark)' } },
                // Print in the light theme (diagrams are SVG, whose fills print even without background
                // graphics): switch for the print, then back. Print styles: src/styles/widgets.css.
                {
                    tag: 'script',
                    content:
                        "addEventListener('beforeprint',()=>{const r=document.documentElement;if(r.dataset.theme!=='light'){r.dataset.scPrintTheme=r.dataset.theme||'';r.dataset.theme='light'}});" +
                        "addEventListener('afterprint',()=>{const r=document.documentElement;if('scPrintTheme' in r.dataset){r.dataset.theme=r.dataset.scPrintTheme||'dark';delete r.dataset.scPrintTheme}})",
                },
            ],
            customCss: [
                '@fontsource-variable/atkinson-hyperlegible-next/wght.css',
                '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css',
                '@fontsource-variable/atkinson-hyperlegible-mono/wght.css',
                // Archivo, pinned to the one width and the weights the site uses (see the file).
                './src/styles/display-font.css',
                './src/styles/tokens.css',
                './src/styles/theme.css',
                './src/styles/wave.css',
                './src/styles/widgets.css',
            ],
            components: {
                SiteTitle: './src/components/overrides/SiteTitle.astro',
                PageTitle: './src/components/overrides/PageTitle.astro',
                Hero: './src/components/overrides/Hero.astro',
                Head: './src/components/overrides/Head.astro',
                // "Report a mistake on this page" when REPORT_URL is set (src/components/site.ts).
                Footer: './src/components/overrides/Footer.astro',
                // Light only for now (theme-middleware.ts).
                ThemeProvider: './src/components/overrides/ThemeProvider.astro',
                ThemeSelect: './src/components/overrides/ThemeSelect.astro',
            },
            tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
            // The site map is docs-internal/CONTENT-PLAN.md. Pages set their order with `sidebar.order`.
            sidebar: [
                { label: 'Playground', link: '/playground/', attrs: { class: 'sc-sidebar-playground' } },
                { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
                // Learn chapters are numbered in the sidebar and in each chapter's ruler (PageTitle).
                { label: 'Learn', items: [{ autogenerate: { directory: 'learn', attrs: { class: 'sc-step' } } }] },
                { label: 'Going further', items: [{ autogenerate: { directory: 'advanced' } }] },
                { label: 'Patterns', items: [{ autogenerate: { directory: 'patterns' } }] },
                { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
                // The npm packages' documentation, a section of its own: packages-nav.ts gives its pages a sidebar of
                // only these entries and the guide's pages one collapsed group with a link per entry.
                {
                    label: 'Packages',
                    items: [
                        { label: 'Overview', link: '/packages/' },
                        { label: 'Quick start', link: '/packages/quick-start/' },
                        ...['Engine', 'Diagram', 'Trace', 'Embed'].map((name) => ({
                            label: name,
                            items: [
                                { label: 'Guide', link: `/packages/${name.toLowerCase()}/` },
                                { label: 'API reference', link: `/packages/${name.toLowerCase()}/api/` },
                            ],
                        })),
                    ],
                },
            ],
            routeMiddleware: './src/components/overrides/packages-nav.ts',
        }),
        svelte(),
        shortInlineCode,
        engageDirective,
        noJsThemeIntegration,
    ],
    vite: {
        css: { postcss: { plugins: [noJsTheme()] } },
        build: {
            // Two chunks are over Vite's default 500 kB. The playground's app (CodeMirror and the editor, about
            // 520 kB, 165 kB gzipped), which only /playground loads, all of it at start. And elkjs's main-thread
            // build (1.43 MB, 435 kB gzipped), which the diagram package loads when it lays out without a worker:
            // only the quick start's live example does (/packages/quick-start/ runs the sample it shows), on the
            // reader's first press. Guide pages load about 16 kB of JS until a widget is engaged. elkjs's 1.6 MB
            // layout worker, which the site's own widgets use, is an asset, not a chunk.
            chunkSizeWarningLimit: 1500,
        },
        resolve: {
            alias: {
                // The diagram package's fonts.css exists only in its build (src/styles/diagram-fonts.css says why).
                '@sccharts-lab/diagram/fonts.css': fileURLToPath(new URL('./src/styles/diagram-fonts.css', import.meta.url)),
                '~engine': fileURLToPath(new URL('./packages/engine/src', import.meta.url)),
                '~diagram': fileURLToPath(new URL('./packages/diagram/src', import.meta.url)),
                '~components': fileURLToPath(new URL('./src/components', import.meta.url)),
                '~examples': fileURLToPath(new URL('./src/examples', import.meta.url)),
            },
        },
    },
})

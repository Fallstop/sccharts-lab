// The theme without JavaScript (src/styles/no-js-theme.mjs, src/components/overrides/theme-middleware.ts): theme
// rules get a copy for <html> without data-theme under prefers-color-scheme, and the server-rendered
// data-theme="dark" is removed from <html>.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import noJsTheme, { noJsSelector } from '../../src/styles/no-js-theme.mjs'
import { stripServerTheme } from '../../src/components/overrides/theme-middleware'

const root = fileURLToPath(new URL('../..', import.meta.url))

// PostCSS is Vite's (not a direct dependency of the site): resolve it through Vite.
async function loadPostcss() {
    try {
        const vite = createRequire(import.meta.url).resolve('vite/package.json')
        return (await import(createRequire(vite).resolve('postcss'))).default
    } catch {
        const store = join(root, 'node_modules/.pnpm')
        const dir = readdirSync(store).find((d) => /^postcss@\d/.test(d))!
        return (await import(join(store, dir, 'node_modules/postcss/lib/postcss.js'))).default
    }
}
const postcss = await loadPostcss()
const run = async (css: string) => (await postcss([noJsTheme()]).process(css, { from: undefined })).css.replace(/\s*}/g, ' }').replace(/\s+/g, ' ').trim()

describe('theme without JavaScript', () => {
    it('rewrites a theme selector for <html> without data-theme, keeping its specificity', () => {
        expect(noJsSelector(":root[data-theme='light']", 'light')).toBe(':root:not([data-theme])')
        expect(noJsSelector('[data-theme=light] button:where(.x)', 'light')).toBe(':where(:root):not([data-theme]) button:where(.x)')
        expect(noJsSelector('[data-theme=light]:root', 'light')).toBe(':not([data-theme]):root')
        expect(noJsSelector('html[data-theme=light]', 'light')).toBe('html:not([data-theme])')
        expect(noJsSelector('[data-theme=dark] .dark\\:sl-hidden', 'dark')).toBe(':where(:root):not([data-theme]) .dark\\:sl-hidden')
        expect(noJsSelector('[data-theme=dark] .x', 'light')).toBeUndefined()
        // Expressive Code's own fallback is left alone.
        expect(noJsSelector(":root:not([data-theme='dark']) .ec", 'light')).toBeUndefined()
    })

    it('adds the copies under the colour-scheme media queries, next to the original', async () => {
        const out = await run(":root { --c: black } :root[data-theme='light'] { --c: white } [data-theme=light] .a, [data-theme=dark] .b, .c { color: red }")
        expect(out).toContain(":root[data-theme='light'] { --c: white } @media (prefers-color-scheme: light) { :root:not([data-theme]) { --c: white } }")
        expect(out).toContain('@media (prefers-color-scheme: light) { :where(:root):not([data-theme]) .a { color: red } }')
        expect(out).toContain('@media not all and (prefers-color-scheme: light) { :where(:root):not([data-theme]) .b { color: red } }')
        // Run twice (Vite may), nothing more is added.
        const again = await run(out)
        expect(again.match(/@media/g)?.length).toBe(out.match(/@media/g)?.length)
    })

    it('works inside layers and leaves other rules alone', async () => {
        const out = await run('@layer starlight.base { [data-theme=light] .a { color: red } .b { color: blue } }')
        expect(out).toBe('@layer starlight.base { [data-theme=light] .a { color: red } @media (prefers-color-scheme: light) { :where(:root):not([data-theme]) .a { color: red } } .b { color: blue } }')
    })

    it('removes the server-rendered data-theme from <html> only', () => {
        expect(stripServerTheme('<!DOCTYPE html><html lang="en" dir="ltr" data-theme="dark" data-has-toc><body data-theme="dark">')).toBe(
            '<!DOCTYPE html><html lang="en" dir="ltr" data-has-toc><body data-theme="dark">',
        )
        expect(stripServerTheme('<html lang="en">')).toBe('<html lang="en">')
    })
})

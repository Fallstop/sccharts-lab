// The theme for readers without JavaScript (docs-internal/DESIGN.md, "Light and dark").
//
// Starlight's convention is `:root` = dark, `:root[data-theme='light']` = light, and its inline ThemeProvider script
// sets `data-theme` on <html> before the first paint (from the reader's choice, else prefers-color-scheme). The
// HTML itself carries no `data-theme` (src/components/overrides/theme-middleware.ts removes Starlight's
// server-rendered `data-theme="dark"`), so without JavaScript <html> has none. This PostCSS plugin gives that case
// the system's colour scheme: every rule written for one theme (`[data-theme='light'] …`, `[data-theme=dark] …`)
// gets a copy for `:root` without `data-theme`, inside `@media (prefers-color-scheme: light)` for the light
// theme and `@media not all and (prefers-color-scheme: light)` for the dark one (the default, as in Expressive
// Code's own fallback, `:root:not([data-theme='dark'])` under prefers light). With JavaScript the attribute is
// always set, so the copies never match: no flash, no change.
//
// The copy keeps the original's specificity (`:where(:root):not([data-theme])` for a bare `[data-theme=…]`).

const ATTR = /\[data-theme=(['"]?)(light|dark)\1\]/g
const SEEN = Symbol('sc-no-js-theme')

/** The selector with its theme attribute replaced by "the root has no data-theme", or undefined. */
export function noJsSelector(selector, theme) {
    if (/:not\([^)]*data-theme/.test(selector)) return undefined
    const found = [...selector.matchAll(ATTR)]
    if (found.length !== 1 || found[0][2] !== theme) return undefined
    const m = found[0]
    const at = m.index
    // The compound selector around the attribute: up to whitespace or a combinator outside brackets and parens.
    let start = at
    let depth = 0
    while (start > 0) {
        const c = selector[start - 1]
        if (c === ')' || c === ']') depth++
        else if (c === '(' || c === '[') depth--
        if (depth === 0 && /[\s>+~,]/.test(c)) break
        start--
    }
    let end = at + m[0].length
    depth = 0
    while (end < selector.length) {
        const c = selector[end]
        if (c === '(' || c === '[') depth++
        else if (c === ')' || c === ']') depth--
        if (depth === 0 && /[\s>+~,]/.test(c)) break
        end++
    }
    const compound = selector.slice(start, end)
    const rooted = /:root\b/.test(compound) || /^html\b/.test(compound)
    return selector.slice(0, at) + (rooted ? ':not([data-theme])' : ':where(:root):not([data-theme])') + selector.slice(at + m[0].length)
}

/** @type {import('postcss').PluginCreator<void>} */
export default function noJsTheme() {
    return {
        postcssPlugin: 'sc-no-js-theme',
        Rule(rule, { AtRule }) {
            if (rule[SEEN]) return
            rule[SEEN] = true
            if (!rule.selector.includes('data-theme')) return
            if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
            let after = rule
            for (const theme of ['light', 'dark']) {
                const selectors = rule.selectors.map((s) => noJsSelector(s, theme)).filter((s) => s !== undefined)
                if (!selectors.length) continue
                // Already there (the CSS went through the plugin before): leave it.
                const next = after.next()
                if (next?.type === 'atrule' && next.name === 'media' && next.first?.type === 'rule' && next.first.selector === selectors.join(',')) {
                    next.first[SEEN] = true
                    after = next
                    continue
                }
                const copy = rule.clone({ selectors })
                copy[SEEN] = true
                const media = new AtRule({ name: 'media', params: theme === 'light' ? '(prefers-color-scheme: light)' : 'not all and (prefers-color-scheme: light)' })
                media.append(copy)
                after.after(media)
                after = media
            }
        },
    }
}
noJsTheme.postcss = true

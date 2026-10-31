// Expressive Code (code blocks) configuration. It lives in this file rather than in astro.config.mjs so
// that Starlight's <Code> component, used by the guide's widgets, gets exactly the same settings.
import { defineEcConfig } from '@astrojs/starlight/expressive-code'
import sctxGrammar from './src/highlight/sctx.tmLanguage.json' with { type: 'json' }
import { scchartsDark, scchartsLight } from './src/highlight/code-themes.mjs'

// The grammar is a copy of the SCCharts Lab extension's (keith-vscode/syntaxes/sctx.tmLanguage.json) with one
// addition: `deep` is a keyword (as in `go to B deep deferred`), which the extension's grammar does not list yet.
// Shiki keys languages by `name`, so register it as `sctx` with the alias `sct`.
const sctx = { ...sctxGrammar, name: 'sctx', displayName: 'SCTX', aliases: ['sct'] }

// Expressive Code makes a block that scrolls sideways a focusable `role="region"`, but gives it no name, so a page
// with two such blocks has identical, unnamed regions (axe: landmark-unique) and a screen reader announces
// just "region". Name each one after its title or first line ("Code: scchart Stopwatch {"), unique on the page,
// and drop the name again when Expressive Code drops the role (aria-label is not allowed on a plain <pre>).
// The module also does Expressive Code's first focusability pass at once (below).
const regionNames = `{
const used = new Set()
const name = (pre) => {
    if (!(pre instanceof HTMLPreElement) || !pre.closest('.expressive-code')) return
    if (pre.getAttribute('role') !== 'region') {
        if (pre.dataset.scName) { pre.removeAttribute('aria-label'); delete pre.dataset.scName }
        return
    }
    if (pre.hasAttribute('aria-label')) return
    const title = pre.closest('figure')?.querySelector('figcaption .title')?.textContent?.trim()
    const first = [...pre.querySelectorAll('.ec-line')].map((l) => l.textContent.trim()).find(Boolean) ?? ''
    const base = title || (first ? 'Code: ' + (first.length > 48 ? first.slice(0, 47) + '\u2026' : first) : 'Code')
    let text = base
    for (let n = 2; used.has(text); n++) text = base + ' (' + n + ')'
    used.add(text)
    pre.dataset.scName = text
    pre.setAttribute('aria-label', text)
}
new MutationObserver((ms) => ms.forEach((m) => name(m.target))).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['role'] })
// Expressive Code makes an overflowing block focusable only 250 ms after layout, when the browser is idle; on a
// long page that can take seconds. Do its first pass at once (and again when the fonts are in); its own
// ResizeObserver keeps it right afterwards, with the same rule.
const focusable = () => {
    for (const pre of document.querySelectorAll('.expressive-code pre')) {
        if (pre.hasAttribute('tabindex') || pre.scrollWidth <= pre.clientWidth) continue
        pre.setAttribute('tabindex', '0')
        pre.setAttribute('role', 'region')
    }
}
focusable()
document.fonts?.ready.then(focusable)
document.querySelectorAll('.expressive-code pre[role=region]').forEach(name)
}`

export default defineEcConfig({
    themes: [scchartsDark, scchartsLight],
    useStarlightDarkModeSwitch: true,
    useStarlightUiThemeColors: false,
    shiki: { langs: [sctx] },
    plugins: [{ name: 'sc-code-region-names', jsModules: [regionNames] }],
    defaultProps: {
        // `sctx` blocks never wrap: indentation is structure. Long lines scroll inside the block.
        wrap: false,
    },
    styleOverrides: {
        borderRadius: '0.5rem',
        borderWidth: '1px',
        borderColor: 'var(--c-rule)',
        codeFontFamily: 'var(--__sl-font-mono)',
        codeFontSize: '0.875rem',
        codeLineHeight: '1.6',
        codePaddingBlock: '0.875rem',
        codePaddingInline: '1.125rem',
        uiFontFamily: 'var(--__sl-font)',
        uiFontSize: '0.8125rem',
        scrollbarThumbColor: 'var(--c-rule-strong)',
        scrollbarThumbHoverColor: 'var(--c-muted)',
        focusBorder: 'var(--c-accent-bright)',
        frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorActiveTabBackground: 'var(--c-code-bg)',
            editorActiveTabForeground: 'var(--c-text)',
            editorActiveTabBorderColor: 'transparent',
            editorActiveTabIndicatorTopColor: 'var(--c-accent-bright)',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBarBackground: 'var(--c-rail)',
            editorTabBarBorderBottomColor: 'var(--c-rule)',
            editorBackground: 'var(--c-code-bg)',
            terminalBackground: 'var(--c-code-bg)',
            terminalTitlebarBackground: 'var(--c-rail)',
            terminalTitlebarForeground: 'var(--c-muted)',
            terminalTitlebarBorderBottomColor: 'var(--c-rule)',
            terminalTitlebarDotsForeground: 'var(--c-rule-strong)',
            terminalTitlebarDotsOpacity: '1',
            inlineButtonBackground: 'var(--c-text)',
            inlineButtonForeground: 'var(--c-text)',
            inlineButtonBorder: 'var(--c-rule-strong)',
            tooltipSuccessBackground: 'var(--c-go)',
            tooltipSuccessForeground: 'var(--c-on-strong)',
        },
        textMarkers: {
            markBackground: 'var(--c-mark-bg)',
            markBorderColor: 'var(--c-accent-bright)',
            backgroundOpacity: '100%',
        },
    },
})

// The app bar's Embed button (/playground): opens the Embed dialog (dialog.ts, loaded on the first click) for the
// chart in the playground.
import type { Playground } from '../playground/app'

/** The button's icon: code brackets, as the snippet it gives. */
export const embedIcon =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3l-2.5 10"/></svg>'

export function wireEmbedButton() {
    const root = document.querySelector<HTMLElement & { playground?: Playground }>('[data-sc-playground]')
    root?.querySelector('[data-pg-embed]')?.addEventListener('click', () => {
        // The playground starts a moment after the page; until then there is no chart to embed.
        const app = root.playground
        if (app) void import('./dialog').then(m => m.openEmbedDialog(app))
    })
}

// The guide is light only for now (the dark theme needs a design pass). Starlight renders <html data-theme="dark">;
// this middleware makes it data-theme="light", so pages are light with or without JavaScript. ThemeProvider and
// ThemeSelect are overridden too (src/components/overrides/), so nothing switches it back.
// stripServerTheme (kept for the no-JS fallback should the dark theme return) removes the attribute instead.
//
// Registered in astro.config.mjs; it runs in the dev server and, for the prerendered pages, at build time.
import type { MiddlewareHandler } from 'astro'

/** The HTML with the opening <html> tag's `data-theme="dark"` removed (nothing else is touched). */
export function stripServerTheme(html: string): string {
    return html.replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\s+data-theme=(["'])dark\1/i, ''))
}

/** The HTML with the opening <html> tag's theme set to light. */
export function forceLightTheme(html: string): string {
    return html.replace(/<html\b[^>]*>/i, (tag) => {
        const without = tag.replace(/\s+data-theme=(["'])[^"']*\1/i, '')
        return without.replace(/^<html\b/i, '<html data-theme="light"')
    })
}

export const onRequest: MiddlewareHandler = async (_context, next) => {
    const response = await next()
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response
    const html = await response.text()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(forceLightTheme(html), { status: response.status, statusText: response.statusText, headers })
}

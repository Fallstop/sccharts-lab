// Starlight renders <html data-theme="dark"> and lets its inline ThemeProvider script (in the head, before the
// first paint) set the reader's theme. Without JavaScript the page would always be dark. This middleware removes
// the server-rendered attribute, so that a page without JavaScript has <html> without `data-theme`, which the
// stylesheets give the system's colour scheme (src/styles/no-js-theme.mjs; Expressive Code does the same for code
// blocks). With JavaScript nothing changes: the script sets the attribute before anything is drawn.
//
// Registered in astro.config.mjs; it runs in the dev server and, for the prerendered pages, at build time.
import type { MiddlewareHandler } from 'astro'

/** The HTML with the opening <html> tag's `data-theme="dark"` removed (nothing else is touched). */
export function stripServerTheme(html: string): string {
    return html.replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\s+data-theme=(["'])dark\1/i, ''))
}

export const onRequest: MiddlewareHandler = async (_context, next) => {
    const response = await next()
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response
    const html = await response.text()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(stripServerTheme(html), { status: response.status, statusText: response.statusText, headers })
}

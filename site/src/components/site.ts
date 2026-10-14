// Site-wide settings for the guide's own components.

/**
 * Where readers report a mistake on a page: a URL template, or undefined for no link. When it is set, every page's footer shows "Report a mistake on this
 * page" (src/components/overrides/Footer.astro), linking to this URL with `{url}` replaced by the page's address
 * and `{title}` by its title (both URL-encoded). For example:
 *
 *   'https://github.com/<owner>/<repo>/issues/new?title=Mistake%20on%20%22{title}%22&body=Page:%20{url}'
 *   'mailto:someone@example.org?subject=SCCharts%20guide:%20{title}&body={url}'
 *
 * A template without `{url}` gets `?page=<url>` (or `&page=`) appended, so the report always says which page.
 */
export const REPORT_URL: string | undefined = 'https://github.com/Fallstop/sccharts-lab/issues/new?title=Guide:%20mistake%20on%20%22{title}%22&body=Page:%20{url}%0A%0AWhat%20is%20wrong:%0A'

/** The report link for a page, from a template (REPORT_URL); undefined when there is no template. */
export function reportHref(template: string | undefined, pageUrl: string, title: string): string | undefined {
    if (!template) return undefined
    const url = encodeURIComponent(pageUrl)
    const filled = template.replaceAll('{url}', url).replaceAll('{title}', encodeURIComponent(title))
    if (template.includes('{url}')) return filled
    return `${filled}${filled.includes('?') ? '&' : '?'}page=${url}`
}

// A tiny inline-Markdown renderer for widget props (quiz options, captions, scenario notes): `code`, **bold**,
// *italic*, [links](url) and backslash escapes (\*, \_, \`, \\, \[ ...: the character itself, never markup;
// inside a code span a backslash is literal, as in CommonMark). Everything else is escaped. Block Markdown
// belongs in MDX children instead.

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ESCAPABLE = '\\`*_[]()#+-.!{}|~<>'
// Escaped characters are parked in the Unicode private use area while the markup is parsed, then put back.
const PARK = 0xe000
const unpark = (s: string) => s.replace(/[-]/g, (c) => esc(String.fromCharCode(c.charCodeAt(0) - PARK)))

// Code spans are parked too, one character each (from U+E100), so that the markup around them is parsed in one
// piece: a link label may contain code, and a quote right after code closes ("`Off`'s" is an apostrophe).
const CODE = 0xe100
const CODE_CHAR = /[\ue100-\uf8ff]/g

/** Curly quotes and apostrophes in prose, as Astro's Markdown (smartypants) gives the pages: "region's" reads
 *  as on the page around the widget. Code spans and escaped characters are not touched; a parked code span
 *  counts as a word, so a quote after it closes. */
const smart = (s: string) =>
    s
        .replace(/([\w\ue100-\uf8ff])'(?=\w)/g, '$1\u2019')
        .replace(/(^|[\s([\u2014\u2013-])'/g, '$1\u2018')
        .replace(/'/g, '\u2019')
        .replace(/(^|[\s([\u2014\u2013-])"/g, '$1\u201c')
        .replace(/"/g, '\u201d')

function format(text: string): string {
    let s = esc(smart(text))
    s = s.replace(/\[([^\]]+)\]\(([^)\s\ue100-\uf8ff]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    return unpark(s)
}

export function inlineMd(text: string): string {
    const codes: string[] = []
    let plain = ''
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
            plain += String.fromCharCode(PARK + text.charCodeAt(i + 1))
            i++
            continue
        }
        if (c === '`') {
            const close = text.indexOf('`', i + 1)
            if (close > i + 1 && CODE + codes.length <= 0xf8ff) {
                const code = text.slice(i + 1, close)
                // Short code never breaks inside (`->` would split after the hyphen); see astro.config.mjs.
                codes.push(shortCode(code) ? `<code class="sc-nobr">${esc(code)}</code>` : `<code>${esc(code)}</code>`)
                plain += String.fromCharCode(CODE + codes.length - 1)
                i = close
                continue
            }
        }
        plain += c
    }
    return format(plain).replace(CODE_CHAR, (c) => codes[c.charCodeAt(0) - CODE] ?? '')
}

/** Code that never breaks inside: up to 12 characters, spaces or not (`go to`, `x += 1`, `if d != 0`), or up to 16
 *  without spaces (`->`, `pre(x)`, `Speed.HIGH`). The same rule as the Markdown pages' (astro.config.mjs). */
export function shortCode(code: string): boolean {
    return code.length <= 12 || (code.length <= 16 && !/\s/.test(code))
}

const codeHtml = (code: string) => (shortCode(code) ? `<code class="sc-nobr">${esc(code)}</code>` : `<code>${esc(code)}</code>`)

/**
 * Compiler messages and hints: `code` spans and links to the site or the web (`[label](/reference/errors/#x)`, a
 * label may hold code); everything else as plain text, as written (`x *= 3` stays as it is, quotes stay straight).
 */
export function inlineCode(text: string): string {
    const codes: string[] = []
    let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
        if (CODE + codes.length > 0xf8ff) return `\`${code}\``
        codes.push(codeHtml(code))
        return String.fromCharCode(CODE + codes.length - 1)
    })
    s = esc(s).replace(/\[([^\]\n]+)\]\(((?:\/|https?:\/\/)[^)\s\ue100-\uf8ff]*)\)/g, (_, label: string, href: string) => `<a href="${href}">${label}</a>`)
    return s.replace(CODE_CHAR, (c) => codes[c.charCodeAt(0) - CODE] ?? '')
}

/** A message or hint without its "See [label](href)." pointer, for a widget that links `href` already (its
 *  *About this message*). */
export function withoutLinkTo(text: string, href: string | undefined): string {
    if (!href) return text
    const target = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const link = `\\[[^\\]]+\\]\\(${target}\\)`
    // "(see [x](href))" inside a sentence, else a sentence of its own, "See [x](href)."
    return text.replace(new RegExp(`\\s*\\([Ss]ee ${link}\\)`), '').replace(new RegExp(`\\s*\\b[Ss]ee ${link}\\.?`), '').trim()
}

// The comparison report (comparisonMarkdown of @sccharts-lab/trace) as HTML for the Trace tab: the Markdown it writes
// and nothing more, so the panel shows exactly the report the reader downloads. Headings (#, ##, ###), paragraphs,
// pipe tables (a `\|` inside a cell is a bar), and the inline Markdown of the guide's widgets (code, bold, italic).

import { inlineMd } from '../frame/inline-md'

/** A table row's cells (the leading and trailing bars dropped; `\|` is a bar inside a cell). */
function cells(line: string): string[] {
    const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    const out: string[] = []
    let cell = ''
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '\\' && inner[i + 1] === '|') {
            cell += '|'
            i++
        } else if (inner[i] === '|') {
            out.push(cell.trim())
            cell = ''
        } else cell += inner[i]
    }
    out.push(cell.trim())
    return out
}

const isRule = (line: string) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/.test(line.trim())

/** The report's Markdown as HTML; headings are shifted by `level` (a page has its own h1 and h2). */
export function reportHtml(markdown: string, level = 2): string {
    const lines = markdown.split(/\r?\n/)
    const out: string[] = []
    let para: string[] = []
    const flush = () => {
        if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`)
        para = []
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
            flush()
            const h = Math.min(6, heading[1].length + level)
            out.push(`<h${h}>${inlineMd(heading[2])}</h${h}>`)
        } else if (line.trim().startsWith('|') && isRule(lines[i + 1] ?? '')) {
            flush()
            const head = cells(line)
            const rows: string[][] = []
            for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]))
            i--
            // A row marked " ≠" in its first cell differs: the table marks it (not by colour alone: the sign stays).
            out.push(
                `<div class="sc-pg-report__table"><table><thead><tr>${head.map(c => `<th scope="col">${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows
                    .map(r => `<tr${/≠/.test(r[0] ?? '') ? ' class="is-different"' : ''}>${r.map((c, k) => (k === 0 ? `<th scope="row">${inlineMd(c)}</th>` : `<td>${inlineMd(c)}</td>`)).join('')}</tr>`)
                    .join('')}</tbody></table></div>`,
            )
        } else if (!line.trim()) {
            flush()
        } else {
            para.push(line.trim())
        }
    }
    flush()
    return out.join('\n')
}

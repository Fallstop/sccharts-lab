// The guide's exercises, for the playground's task banner: every `<TryIt example="…" solution="…" title="…">task</TryIt>`
// of the guide's pages, with the page and the section it is in. Built at build time (playground.astro) from the docs
// collection: the page's MDX source and the headings Astro gave it (their anchors). A TryIt link opens
// /playground/?example=<starter>&solution=<solution>; the banner shows the task the reader came from, with a link
// back to it.

import { inlineMd } from '../frame/inline-md'

export interface Exercise {
    /** The starter chart's example id. */
    starter: string
    /** The model solution's example id. */
    solution?: string
    /** The exercise's name (the TryIt's `title`, else "Try it"). */
    title: string
    /** The task, as HTML: paragraphs and lists of inline Markdown. */
    task: string
    /** The guide page and the section of it that has the exercise (`/learn/actions/#try-it`). */
    page: string
    href: string
    /** The model solution has a test run recorded with KIELER: the playground offers the comparison (set by
     *  playground.astro, which knows the examples). */
    compare?: boolean
}

export interface ExerciseDoc {
    id: string
    title: string
    body?: string
    /** Astro's headings of the page (render(entry).headings): their anchors. */
    headings?: { depth: number; slug: string; text: string }[]
}

const ATTR = /\b(example|solution|title)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:'([^']*)'|"([^"]*)")\s*\})/g

const normaliseId = (id: string) => id.trim().replace(/^\/+/, '').replace(/^src\/examples\//, '').replace(/\.sctx$/, '')

/** A heading's text as Astro gives it: without Markdown's code ticks, emphasis and link targets. */
function plainHeading(md: string): string {
    return md
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/** GitHub's slug of a heading (what Astro's heading ids use), for a heading Astro's list does not have. */
function slug(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/** The task's Markdown as HTML: blank lines separate paragraphs, a block of `- ` lines is a list. */
export function taskHtml(markdown: string): string {
    const blocks = markdown.trim().split(/\n\s*\n/)
    return blocks
        .map(block => {
            const lines = block.split('\n')
            if (/^\s*[-*]\s/.test(lines[0])) {
                const items: string[] = []
                for (const line of lines) {
                    if (/^\s*[-*]\s/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ''))
                    else if (items.length) items[items.length - 1] += ` ${line.trim()}`
                }
                return `<ul>${items.map(i => `<li>${inlineMd(i.trim())}</li>`).join('')}</ul>`
            }
            return `<p>${inlineMd(lines.map(l => l.trim()).join(' '))}</p>`
        })
        .join('')
}

/** Every exercise of the pages, in page order. The design pages (widget tests) are left out. */
export function findExercises(docs: ExerciseDoc[]): Exercise[] {
    const out: Exercise[] = []
    for (const doc of docs) {
        if (!doc.body || doc.id.startsWith('design/')) continue
        const slugPath = doc.id.replace(/\/index$/, '')
        const href = `/${slugPath}/`
        // The headings of the body, outside code fences, paired with Astro's (by text, in order).
        const astro = [...(doc.headings ?? [])]
        const used = new Set<number>()
        const anchorOf = (text: string) => {
            const i = astro.findIndex((h, k) => !used.has(k) && plainHeading(h.text) === text)
            if (i < 0) return slug(text)
            used.add(i)
            return astro[i].slug
        }
        let fence: string | undefined
        let offset = 0
        const sections: { at: number; anchor: string }[] = []
        for (const line of doc.body.split('\n')) {
            const f = line.match(/^\s*(`{3,}|~{3,})/)
            if (f) {
                if (!fence) fence = f[1]
                else if (f[1].startsWith(fence)) fence = undefined
            } else if (!fence) {
                const h = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/)
                if (h) sections.push({ at: offset, anchor: anchorOf(plainHeading(h[2])) })
            }
            offset += line.length + 1
        }
        for (const m of doc.body.matchAll(/<TryIt\b([^>]*)>([\s\S]*?)<\/TryIt>/g)) {
            const attrs: Record<string, string> = {}
            for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? a[5] ?? ''
            if (!attrs.example) continue
            const at = m.index ?? 0
            const anchor = sections.filter(s => s.at < at).at(-1)?.anchor
            out.push({
                starter: normaliseId(attrs.example),
                ...(attrs.solution ? { solution: normaliseId(attrs.solution) } : {}),
                title: attrs.title?.trim() || 'Try it',
                task: taskHtml(m[2]),
                page: doc.title,
                href: anchor ? `${href}#${anchor}` : href,
            })
        }
    }
    return out
}

/** The exercise of a TryIt link (`?example=<starter>&solution=<solution>`): the one with both, else the one with
 *  that model solution (an edited exercise's address keeps only `?solution=`). */
export function exerciseFor(exercises: Exercise[], starter: string | undefined, solution: string | undefined): Exercise | undefined {
    if (!solution) return undefined
    return exercises.find(e => e.starter === starter && e.solution === solution) ?? exercises.find(e => e.solution === solution)
}

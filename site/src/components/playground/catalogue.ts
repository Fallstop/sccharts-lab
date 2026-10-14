// The playground's example menu: every chart in src/examples (grouped by guide section and page, in the order the
// page uses them, with the page's title) and the playground's own showcase charts. Built at build time from the
// docs collection and the pages' MDX; the browser receives this list as JSON and loads a chart's source lazily
// (sources.ts).
//
// Solutions of exercises (`<TryIt solution="...">`) are left out of the menu, so browsing it gives nothing away;
// ?example=<id> still opens them.

export interface CatalogueItem {
    /** `learn/first-chart/toggle` or `showcase/abro`. */
    id: string
    /** The chart's name (the first `scchart`), else the file name. */
    title: string
    /** File name without `.sctx`. */
    file: string
    /** One line about the chart (showcase charts only). */
    blurb?: string
    /** A starter chart of an exercise. */
    starter?: boolean
    /** The chart is meant to be rejected by the compiler (its scenario says `"expect": "error"`). */
    rejected?: boolean
}

export interface CataloguePage {
    /** `learn/first-chart`, or '' for a section's loose examples. */
    slug: string
    title: string
    href?: string
    items: CatalogueItem[]
}

export interface CatalogueGroup {
    id: string
    label: string
    pages: CataloguePage[]
}

export interface DocEntry {
    id: string
    title: string
    order?: number
    /** The page's MDX source, for the order of its examples and its exercises. */
    body?: string
}

export interface ShowcaseEntry {
    id: string
    title: string
    file: string
    blurb: string
}

/** Sections in the sidebar's order. */
const SECTIONS: [string, string][] = [
    ['start', 'Start here'],
    ['learn', 'Learn'],
    ['advanced', 'Going further'],
    ['patterns', 'Patterns'],
    ['reference', 'Reference'],
]

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** The chart the simulator runs by default: the first `scchart` (as KIELER). */
export function firstChartName(source: string): string | undefined {
    return stripComments(source).match(/\bscchart\s+\^?([A-Za-z_]\w*)/)?.[1]
}

/** The names of every `scchart` of a source, also one that does not parse. */
export function chartNames(source: string): string[] {
    return [...stripComments(source).matchAll(/\bscchart\s+\^?([A-Za-z_]\w*)/g)].map(m => m[1])
}

const ATTR = /\b(example|solution|a|b)\s*=\s*["']([^"']+)["']/g

/** Example ids a page's MDX mentions, in order, and those it uses as exercise starters and solutions. */
export function examplesInPage(body: string): { order: string[]; starters: Set<string>; solutions: Set<string> } {
    const order: string[] = []
    const starters = new Set<string>()
    const solutions = new Set<string>()
    for (const tag of body.matchAll(/<(TryIt|Sim|Chart|Compare|Predict|Playground)\b[^>]*>/g)) {
        for (const m of tag[0].matchAll(ATTR)) {
            const id = m[2].replace(/^\/+/, '').replace(/^src\/examples\//, '').replace(/\.sctx$/, '')
            if (!order.includes(id)) order.push(id)
            if (tag[1] === 'TryIt' && m[1] === 'solution') solutions.add(id)
            if (tag[1] === 'TryIt' && m[1] === 'example') starters.add(id)
        }
    }
    return { order, starters, solutions }
}

export function buildCatalogue(
    sources: Record<string, string>,
    docs: DocEntry[],
    showcase: ShowcaseEntry[],
    rejected: Set<string> = new Set(),
): CatalogueGroup[] {
    const pagesBySlug = new Map(docs.map(d => [d.id.replace(/\/index$/, ''), d]))
    const solutions = new Set<string>()
    const starters = new Set<string>()
    const pageOrder = new Map<string, string[]>()
    for (const d of docs) {
        // The design specimen reuses examples to show the components; it says nothing about them.
        if (!d.body || d.id.startsWith('design/')) continue
        const found = examplesInPage(d.body)
        pageOrder.set(d.id.replace(/\/index$/, ''), found.order)
        found.solutions.forEach(s => solutions.add(s))
        found.starters.forEach(s => starters.add(s))
    }
    // An exercise's starter that another page shows as an ordinary example is still listed (it is not a solution).
    const ids = Object.keys(sources).sort()
    const groups = new Map<string, CatalogueGroup>()
    const groupFor = (id: string, label: string) => {
        let g = groups.get(id)
        if (!g) groups.set(id, (g = { id, label, pages: [] }))
        return g
    }

    if (showcase.length) {
        groupFor('showcase', 'Showcase').pages.push({
            slug: '',
            title: 'Complete charts to explore',
            items: showcase.map(s => ({ id: s.id, title: s.title, file: s.file, blurb: s.blurb })),
        })
    }

    for (const id of ids) {
        if (solutions.has(id)) continue
        const parts = id.split('/')
        const section = parts[0]
        const slug = parts.length > 2 ? parts.slice(0, -1).join('/') : ''
        const file = parts.at(-1)!
        const label = SECTIONS.find(([s]) => s === section)?.[1] ?? section.charAt(0).toUpperCase() + section.slice(1)
        const group = groupFor(section, label)
        const doc = slug ? pagesBySlug.get(slug) : undefined
        let page = group.pages.find(p => p.slug === slug)
        if (!page) {
            page = { slug, title: doc?.title ?? (slug ? slug.split('/').at(-1)! : label), href: doc ? `/${slug}/` : undefined, items: [] }
            group.pages.push(page)
        }
        page.items.push({
            id,
            title: firstChartName(sources[id]) ?? file,
            file,
            starter: starters.has(id) || undefined,
            rejected: rejected.has(id) || undefined,
        })
    }

    // Order: sections as in the sidebar, pages by their sidebar order, examples in the order the page shows them.
    const rank = (g: CatalogueGroup) => (g.id === 'showcase' ? -1 : (i => (i < 0 ? SECTIONS.length : i))(SECTIONS.findIndex(([s]) => s === g.id)))
    const out = [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    for (const g of out) {
        if (g.id === 'showcase') continue
        g.pages.sort((a, b) => {
            const oa = pagesBySlug.get(a.slug)?.order ?? Infinity
            const ob = pagesBySlug.get(b.slug)?.order ?? Infinity
            return oa - ob || a.slug.localeCompare(b.slug)
        })
        for (const p of g.pages) {
            const order = pageOrder.get(p.slug) ?? []
            const pos = (id: string) => (i => (i < 0 ? Infinity : i))(order.indexOf(id))
            p.items.sort((a, b) => pos(a.id) - pos(b.id) || a.file.localeCompare(b.file))
        }
    }
    return out
}

/** Every item, flat. */
export function allItems(groups: CatalogueGroup[]): CatalogueItem[] {
    return groups.flatMap(g => g.pages.flatMap(p => p.items))
}

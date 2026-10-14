// "About this message" links (src/components/frame/error-links.ts) against the page they point to,
// src/content/docs/reference/errors.mdx: every anchor must be a heading of the page (slugged as Astro's
// heading-ids plugin does, with github-slugger), every message heading of the page must be reachable from
// its own words, and the page's own examples must link to the section that shows them.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANCHORS, CODES, ERRORS_PAGE, MESSAGES, errorAnchor, errorLink } from '../../src/components/frame/error-links'
import { compile } from '~engine/index'

const root = fileURLToPath(new URL('../..', import.meta.url))
const page = readFileSync(join(root, 'src/content/docs/reference/errors.mdx'), 'utf8')

// github-slugger is what Astro's Markdown pipeline (@astrojs/markdown-satteri, under @astrojs/mdx) slugs headings
// with; it is not a direct dependency of the site, so resolve it the way that package does.
async function loadSlugger(): Promise<new () => { slug(s: string): string }> {
    const tries: (() => string)[] = [
        () => createRequire(import.meta.url).resolve('github-slugger'),
        () => {
            const astro = createRequire(import.meta.url).resolve('astro/package.json')
            const mdx = createRequire(astro).resolve('@astrojs/markdown-satteri/package.json')
            return createRequire(mdx).resolve('github-slugger')
        },
        () => {
            const store = join(root, 'node_modules/.pnpm')
            const dir = readdirSync(store).find((d) => d.startsWith('github-slugger@'))!
            return join(store, dir, 'node_modules/github-slugger/index.js')
        },
    ]
    for (const t of tries) {
        try {
            return (await import(t())).default
        } catch {
            /* next */
        }
    }
    throw new Error('github-slugger not found')
}
const Slugger = await loadSlugger()

interface Heading {
    depth: number
    /** 0-based line in the page body (after the frontmatter). */
    line: number
    text: string
    /** The heading is a message in a code span: `### \`The state is not reachable.\`` */
    message?: string
    slug: string
}

const body = (mdx: string) => mdx.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')

/** The page's headings in order, outside fenced code, with their text as the heading-ids plugin sees it. */
function headings(mdx: string): Heading[] {
    const slugger = new Slugger()
    const out: Heading[] = []
    let fence: string | undefined
    const lines = body(mdx)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const f = /^\s*(```+|~~~+)/.exec(line)
        if (f) {
            if (!fence) fence = f[1]
            else if (line.trim().startsWith(fence)) fence = undefined
            continue
        }
        if (fence) continue
        const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (!h) continue
        const raw = h[2]
        const message = /^`([^`]+)`$/.exec(raw)?.[1]
        // Text content: code spans keep their text, links their label, emphasis markers go.
        const text = raw
            .split(/(`[^`]*`)/)
            .map((part) => (part.startsWith('`') ? part.slice(1, -1) : part.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|\*|__)/g, '')))
            .join('')
        out.push({ depth: h[1].length, line: i, text, message, slug: slugger.slug(text) })
    }
    return out
}

const all = headings(page)
const slugs = new Set(all.map((h) => h.slug))

describe('error links', () => {
    it('point at headings that exist on the errors page', () => {
        const missing = ANCHORS.filter((a) => !slugs.has(a))
        expect(missing, `error-links.ts names anchors that ${ERRORS_PAGE} no longer has; update them to the new headings`).toEqual([])
        for (const a of Object.values(CODES)) expect(slugs.has(a)).toBe(true)
        for (const [, a] of MESSAGES) expect(slugs.has(a)).toBe(true)
    })

    it('reach every message heading of the page from its own words', () => {
        // Headings that are not one message (a list of several) are linked by the messages they list.
        const lists = new Set(['c-compiler-warnings-in-sccharts-lab'])
        const messages = all.filter((h) => h.message && !lists.has(h.slug))
        expect(messages.length).toBeGreaterThan(60)
        const wrong = messages.filter((h) => errorAnchor(h.message!) !== h.slug).map((h) => `${h.message} -> ${errorAnchor(h.message!) ?? 'nothing'} (want ${h.slug})`)
        expect(wrong, 'a heading of the errors page that error-links.ts does not link to: add a pattern to MESSAGES').toEqual([])
    })

    it('read diagnostics, codes and KIELER words', () => {
        expect(errorLink({ code: 'causality-cycle', message: 'x and y depend on each other within one tick', kieler: 'The SCG is NOT asc-schedulable!' })).toBe(
            '/reference/errors/#the-scg-is-not-asc-schedulable',
        )
        expect(errorLink('instantaneous-loop')).toBe('/reference/errors/#the-scg-is-not-asc-schedulable')
        expect(errorLink("no viable alternative at input 'output'")).toBe('/reference/errors/#no-viable-alternative-at-input-x')
        // KIELER's line:column prefix (recorded "errors" lists) is ignored.
        expect(errorAnchor("5:20 The required feature 'valuedObject' of 'x' must be set")).toBe('fix-the-first-message-first')
        expect(errorAnchor({ code: 'parse', message: "Expected 'to' after 'go'" })).toBe('missing-to-at-done')
        expect(errorAnchor({ code: 'parse', message: 'Unexpected name x after the trigger' })).toBe('syntax-errors')
        expect(errorAnchor('parse')).toBe('syntax-errors')
        // A crash: the Java exception's name comes first.
        expect(errorAnchor({ code: 'kieler-crash', message: 'KIELER cannot compile a for-region inside another for-region', kieler: "java.lang.IllegalArgumentException: Can't copy valued object. Valued object is null!" })).toBe(
            'cant-copy-valued-object-valued-object-is-null',
        )
        // C compiler errors: the specific cause wins over the generic message.
        expect(errorAnchor({ code: 'duplicate-declaration', message: 'count is declared twice in the same scope', kieler: 'duplicate member ‘count’\nCompiler did not return success (exit value != 0)' })).toBe(
            'the-variable-is-declared-multiple-times-in-this-scope',
        )
        expect(errorAnchor('expected expression before ‘>’ token')).toBe('compiler-did-not-return-success-exit-value--0')
        // The guide's own notes are not compiler messages.
        for (const code of ['kieler-quirk', 'kieler-bug', 'kieler-divergence', 'kieler-nondeterministic', 'unsupported', 'ternary-grouping']) {
            expect(errorLink({ code, message: 'Something the guide says' }), code).toBeUndefined()
        }
        expect(errorLink(undefined)).toBeUndefined()
        expect(errorLink('')).toBeUndefined()
    })

    it("link the engine's newer codes, from the charts that give them", () => {
        // What the engine says about the probes recorded with KIELER (tests/engine/kieler): each first error links to the
        // section that explains KIELER's words for it.
        const first = (file: string) => {
            const r = compile(readFileSync(join(root, 'tests/engine/kieler', file), 'utf8'), { files: {} })
            const d = r.diagnostics.find((x) => x.severity === 'error')
            expect(d, file).toBeDefined()
            return d!
        }
        const asc = 'the-scg-is-not-asc-schedulable'
        const gcc = 'compiler-did-not-return-success-exit-value--0'
        expect(first('preemption/probe-count-reset-weak.sctx').code).toBe('count-delay-reset')
        expect(errorAnchor(first('preemption/probe-count-reset-weak.sctx'))).toBe(asc)
        for (const probe of ['rare/probe-prime-output.sctx', 'rare/probe-caret-output.sctx', 'rare/probe-d-local.sctx']) {
            expect(first(probe).code, probe).toBe('c-name')
            expect(errorAnchor(first(probe)), probe).toBe(gcc)
        }
        // `scchart(C).X`: gcc's error for an array element; KIELER's copy error has no section of its own yet.
        expect(first('rare/probe-static-access-array.sctx').code).toBe('static-access')
        expect(errorAnchor(first('rare/probe-static-access-array.sctx'))).toBe(gcc)
        expect(first('rare/probe-static-access-chained.sctx').code).toBe('static-access')
        expect(errorAnchor(first('rare/probe-static-access-chained.sctx'))).toBeUndefined()
        // Names: a label nobody declared is a name error like the others.
        expect(errorAnchor({ code: 'unknown-label', message: 'There is no label `done` in this block', kieler: "Couldn't resolve reference to Label 'done'." })).toBe('name-errors')
        expect(errorAnchor("Couldn't resolve reference to Label 'done'.")).toBe('name-errors')
        // Enums and structs given a whole value at their declaration.
        expect(errorAnchor('enum-initial-value')).toBe('enums-structs-classes-and-methods')
        expect(errorAnchor('An enum typed variable can only be initialized with a value of the correct enum type.')).toBe('enums-structs-classes-and-methods')
        expect(errorAnchor('Composed types (class/struct) cannot be initialized. Please initialize each field individually.')).toBe('enums-structs-classes-and-methods')
        // A crash without a section of its own: the internal errors as a whole.
        expect(errorAnchor({ code: 'kieler-crash', message: "KIELER's compiler crashes on this chart", kieler: 'java.lang.NullPointerException: Cannot invoke "Link.getTarget()"' })).toBe('internal-errors')
    })

    it("link each of the page's examples to the section that opens it", () => {
        // `[Open `name`](/playground/?example=reference/errors/name)` under a heading: the example's first
        // error (or warning) links back to that heading's section.
        const lines = body(page)
        const top = all.filter((h) => h.depth <= 3)
        const sections = top.map((h, i) => ({
            slug: h.slug,
            examples: lines
                .slice(h.line, top[i + 1]?.line ?? lines.length)
                .flatMap((l) => [...l.matchAll(/\[Open `[a-z0-9-]+`[^\]]*\]\(\/playground\/\?example=reference\/errors\/([a-z0-9-]+)\)/g)].map((m) => m[1])),
        }))
        const dir = join(root, 'src/examples/reference/errors')
        const checked: string[] = []
        const wrong: string[] = []
        // The guide never shows KIELER's VariableStore bookkeeping (frame/prepare.ts, NOISE).
        const silent = new Set(['history-warning'])
        for (const s of sections) {
            for (const ex of s.examples.filter((e) => !silent.has(e))) {
                const source = readFileSync(join(dir, `${ex}.sctx`), 'utf8')
                const r = compile(source, { files: {} })
                const ds = r.diagnostics.filter((d) => d.severity !== 'info' || d.code === 'kieler-loop-warning')
                const linked = ds.map((d) => errorAnchor(d))
                checked.push(ex)
                // A section may open an example for a follow-on message: any of the chart's messages may link there.
                if (!linked.includes(s.slug)) wrong.push(`${ex} (under #${s.slug}): ${ds.map((d, i) => `${d.code}: ${d.message.split('\n')[0]} -> ${linked[i] ?? 'nothing'}`).join(' | ') || 'no diagnostics'}`)
            }
        }
        expect(checked.length).toBeGreaterThan(40)
        expect(wrong).toEqual([])
    })
})

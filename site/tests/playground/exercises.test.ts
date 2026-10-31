// The exercises of the guide's pages (exercises.ts), for the playground's task banner: the TryIt's title and task,
// the section it is in (Astro's heading anchors), and the lookup of a TryIt link's exercise.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { exerciseFor, findExercises, taskHtml } from '../../src/components/playground/exercises'

const body = `
Intro.

## Try it

\`\`\`sctx
## not a heading
\`\`\`

<TryIt example="learn/x/start" solution="learn/x/solution" title="Count \`presses\`">
Count the presses, not the ticks: \`count\` goes up once per press.

- First, find the edge.
- Then count it, in a
  second region.
</TryIt>

### The \`pre\` operator again

<TryIt title={'Two'} example="/src/examples/learn/x/other.sctx">
Plain.
</TryIt>
`

describe('the exercises of the pages', () => {
    test('title, task, page and the section anchor Astro gave the heading', () => {
        const found = findExercises([
            {
                id: 'learn/x',
                title: 'Chapter X',
                body,
                headings: [
                    { depth: 2, slug: 'try-it', text: 'Try it' },
                    { depth: 3, slug: 'the-pre-operator-again', text: 'The pre operator again' },
                ],
            },
            { id: 'design/specimen', title: 'Specimen', body },
        ])
        expect(found).toEqual([
            {
                starter: 'learn/x/start',
                solution: 'learn/x/solution',
                title: 'Count `presses`',
                task: '<p>Count the presses, not the ticks: <code class="sc-nobr">count</code> goes up once per press.</p><ul><li>First, find the edge.</li><li>Then count it, in a second region.</li></ul>',
                page: 'Chapter X',
                href: '/learn/x/#try-it',
            },
            { starter: 'learn/x/other', title: 'Two', task: '<p>Plain.</p>', page: 'Chapter X', href: '/learn/x/#the-pre-operator-again' },
        ])
    })

    test("without Astro's headings, GitHub's slug of the heading", () => {
        const [first] = findExercises([{ id: 'learn/x', title: 'X', body }])
        expect(first.href).toBe('/learn/x/#try-it')
    })

    test('a TryIt link finds its exercise by starter and solution, or by the solution alone (an edited exercise)', () => {
        const all = findExercises([{ id: 'learn/x', title: 'X', body }])
        expect(exerciseFor(all, 'learn/x/start', 'learn/x/solution')?.title).toBe('Count `presses`')
        expect(exerciseFor(all, undefined, 'learn/x/solution')?.title).toBe('Count `presses`')
        expect(exerciseFor(all, 'learn/x/start', undefined)).toBeUndefined()
    })

    test('task text: paragraphs and lists of inline Markdown, everything else escaped', () => {
        expect(taskHtml('One *two*\nthree.\n\nFour <b>.')).toBe('<p>One <em>two</em> three.</p><p>Four &lt;b&gt;.</p>')
    })
})

describe("the guide's own exercises", () => {
    const docs = path.resolve('src/content/docs')
    const files = (fs.readdirSync(docs, { recursive: true }) as string[]).filter(f => f.endsWith('.mdx'))
    const all = findExercises(files.map(f => ({ id: f.replace(/\.mdx$/, ''), title: f, body: fs.readFileSync(path.join(docs, f), 'utf8') })))

    test('every TryIt is found, with a title, a task and its section', () => {
        const count = files.filter(f => !f.startsWith('design/')).reduce((n, f) => n + (fs.readFileSync(path.join(docs, f), 'utf8').match(/<TryIt\b/g)?.length ?? 0), 0)
        expect(all.length).toBe(count)
        for (const e of all) {
            expect(e.title, e.starter).not.toBe('Try it')
            expect(e.task, e.starter).toMatch(/^<(p|ul)>/)
            expect(e.href, e.starter).toMatch(/^\/[\w/-]+\/#[\w-]+$/)
        }
    })

    test('their starters and model solutions are examples, and a model solution belongs to one exercise', () => {
        const exists = (id: string) => fs.existsSync(path.resolve('src/examples', `${id}.sctx`))
        for (const e of all) {
            expect(exists(e.starter), e.starter).toBe(true)
            if (e.solution) expect(exists(e.solution), e.solution).toBe(true)
        }
        const solutions = all.flatMap(e => (e.solution ? [e.solution] : []))
        expect(new Set(solutions).size).toBe(solutions.length)
    })
})

// The API reference pages of the packages' documentation (src/content/docs/packages/<package>/api.mdx) say what
// the packages' sources say:
//
//   - a heading `### \`name()\`` or `### \`Name\`` names an export, and its first `ts` fence is the export's
//     signature (a function's parameters, optional marks and result; a type alias's definition; a constant's type);
//   - a table under it whose first header is "Property" lists exactly the type's own members, each with its `?`,
//     and, with a second header "Type", each member's type as the source declares it; a table headed "Member"
//     may list some of them;
//   - every export of every published entry point (publishConfig.exports, not `./internal`) is named on the page.
//
// Where a parameter's type has no public name, PUBLIC_SIGNATURE gives the signature the page writes instead.
//
// And the diagram's CSS custom properties: the pages and samples name only ones diagram.css reads, and the
// diagram's API page names every one of them.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { apiPage, exportsOf, same, type PackageName } from './api-model'
import { PAGES, SAMPLES, SITE } from './support'

/** Signatures the pages write with a public type where the source uses one it does not export. */
const PUBLIC_SIGNATURE: Record<string, string> = {
    // SimulationInput: the part of a CompileResult the simulator reads.
    'engine:createSimulation': 'function createSimulation(result: CompileResult, options?: SimulationOptions): Simulation',
    // RootLike: the `querySelectorAll` of an element or a document.
    'diagram:applyClasses': 'function applyClasses(root: ParentNode, classes: ClassMap, managed?: readonly string[]): void',
    // Compiled: the part of a CompileResult the trace functions read.
    'trace:traceFromRun': 'function traceFromRun(result: CompileResult, run: EngineRun, options?: TraceOptions): TraceRecord',
    'trace:traceColumns': 'function traceColumns(result: CompileResult): TraceVariable[]',
    'trace:poolVariables': 'function poolVariables(result: CompileResult): PoolVariable[]',
    'trace:compareRuns': 'function compareRuns(runs: ({ label: string; result: CompileResult; run: EngineRun } & TraceOptions)[]): TraceComparison',
}

const PACKAGES: PackageName[] = ['engine', 'diagram', 'trace', 'embed']

describe.each(PACKAGES)('the API reference of @sccharts-lab/%s', (pkg) => {
    const load = () => ({ exported: exportsOf(pkg), page: apiPage(pkg) })

    it('documents only what the package exports, with its signature', { timeout: 120_000 }, () => {
        const { exported, page } = load()
        const problems: string[] = []
        for (const entry of page.entries) {
            const real = exported.get(entry.name)
            const at = `api.mdx:${entry.line} \`${entry.name}\``
            if (!real) {
                problems.push(`${at}: the package does not export it`)
                continue
            }
            if (entry.call !== (real.kind === 'function')) problems.push(`${at}: ${real.kind === 'function' ? 'a function: write `' + entry.name + '()`' : 'not a function: write `' + entry.name + '`'}`)
            const expected = PUBLIC_SIGNATURE[`${pkg}:${entry.name}`] ?? real.signature
            if (real.kind === 'function' && entry.signature === undefined) problems.push(`${at}: no \`ts\` fence with its signature. The source's:\n${expected}`)
            else if (expected && entry.signature !== undefined && !same(entry.signature, expected)) problems.push(`${at}: the signature differs from the source's:\n${expected}`)
        }
        expect(problems).toEqual([])
    })

    it('lists the members of its types as the source declares them', { timeout: 120_000 }, () => {
        const { exported, page } = load()
        const problems: string[] = []
        for (const entry of page.entries) {
            const members = exported.get(entry.name)?.members
            for (const table of entry.tables) {
                const first = table.header[0]
                if (first !== 'Property' && first !== 'Member') continue
                const at = `api.mdx:${entry.line} \`${entry.name}\``
                if (!members) {
                    problems.push(`${at}: has a ${first} table but is not a type with members`)
                    continue
                }
                const typed = table.header[1] === 'Type'
                const listed = new Set<string>()
                for (const row of table.rows) {
                    const member = members.find((m) => m.label === row[0])
                    listed.add(row[0])
                    if (!member) problems.push(`${at}: \`${row[0]}\` is not a member (its members: ${members.map((m) => m.label).join(', ')})`)
                    else if (typed && !same(row[1], member.type)) problems.push(`${at}: \`${row[0]}\` has the type \`${member.type}\`, not \`${row[1]}\``)
                }
                if (first === 'Property') for (const m of members) if (!listed.has(m.label)) problems.push(`${at}: its member \`${m.label}\` (\`${m.type}\`) is not in the table`)
            }
        }
        expect(problems).toEqual([])
    })

    it('names every export', { timeout: 120_000 }, () => {
        const { exported, page } = load()
        expect([...exported.keys()].filter((name) => !page.mentioned.has(name)).sort()).toEqual([])
    })
})

describe('the CSS custom properties of the diagram', () => {
    const properties = (text: string) => new Set(text.match(/--sc-[a-z0-9-]+/g) ?? [])
    const real = properties(fs.readFileSync(path.join(SITE, 'packages/diagram/src/diagram.css'), 'utf8'))
    const files = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())

    it('the pages and the samples name only properties diagram.css reads', () => {
        const unknown: string[] = []
        for (const file of [...files(PAGES), ...files(SAMPLES)]) {
            for (const name of properties(fs.readFileSync(file, 'utf8'))) if (!real.has(name)) unknown.push(`${path.relative(SITE, file)}: ${name}`)
        }
        expect(unknown).toEqual([])
    })

    it('the API page names every property', () => {
        const named = properties(fs.readFileSync(path.join(PAGES, 'diagram/api.mdx'), 'utf8'))
        expect([...real].filter((name) => !named.has(name)).sort()).toEqual([])
    })
})

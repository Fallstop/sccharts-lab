// Example sources in the browser, loaded on demand: each chart is its own small chunk, so the playground does
// not download the whole library to open one chart. Likewise their scenarios (guided tours, the inputs of a model
// solution's test run) and KIELER's recordings of them (what a model solution's outputs are).

import type { OracleRecording, Scenario } from '../frame/examples'

const examples = import.meta.glob('/src/examples/**/*.sctx', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const showcase = import.meta.glob('./showcase/*.sctx', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>

/** The loader of an example (`learn/x/y`) or a showcase chart (`showcase/abro`), if it exists. */
function loaderFor(id: string): (() => Promise<string>) | undefined {
    const clean = id.trim().replace(/^\/+/, '').replace(/^src\/examples\//, '').replace(/\.sctx$/, '')
    if (clean.startsWith('showcase/')) return showcase[`./${clean}.sctx`]
    return examples[`/src/examples/${clean}.sctx`]
}

export function hasExample(id: string): boolean {
    return !!loaderFor(id)
}

export async function loadExampleSource(id: string): Promise<string | undefined> {
    const load = loaderFor(id)
    return load ? load() : undefined
}

/** Normalised id, as the catalogue and links write it. */
export function normaliseId(id: string): string {
    return id.trim().replace(/^\/+/, '').replace(/^src\/examples\//, '').replace(/\.sctx$/, '')
}

/** KIELER's recording of a scenario, with the interface it reports (`name: { type, properties }`). */
export interface Recording extends OracleRecording {
    interface?: Record<string, { type: string; properties: string[] }>
}

const scenarios = import.meta.glob('/src/examples/**/*.scenario.json', { import: 'default' }) as Record<string, () => Promise<Scenario>>
const showcaseScenarios = import.meta.glob('./showcase/*.scenario.json', { import: 'default' }) as Record<string, () => Promise<Scenario>>
const recordings = import.meta.glob('/src/examples/**/*.oracle.json', { import: 'default' }) as Record<string, () => Promise<Recording>>
const showcaseRecordings = import.meta.glob('./showcase/*.oracle.json', { import: 'default' }) as Record<string, () => Promise<Recording>>

function jsonLoader<T>(id: string, kind: 'scenario' | 'oracle', lib: Record<string, () => Promise<T>>, own: Record<string, () => Promise<T>>) {
    const clean = normaliseId(id)
    return clean.startsWith('showcase/') ? own[`./${clean}.${kind}.json`] : lib[`/src/examples/${clean}.${kind}.json`]
}

/**
 * The files an example imports, by file name (`{ "push-switch.sctx": "..." }`), for `compile(source, { files })`:
 * its scenario's `imports`, else every `import "name"` of the source that names an example next to it (as the
 * widgets do, src/components/frame/examples.ts). Showcase charts import nothing.
 */
export async function loadImports(id: string, source: string, scenario?: Scenario): Promise<Record<string, string>> {
    const clean = normaliseId(id)
    if (clean.startsWith('showcase/')) return {}
    const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : ''
    const names = scenario?.imports?.length
        ? scenario.imports
        : [...source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').matchAll(/^\s*import\s+"([^"]+)"/gm)].map(m => m[1])
    const files: Record<string, string> = {}
    for (const name of names) {
        const rel = name.replace(/^\.\//, '').replace(/\.sctx$/, '')
        const text = await loadExampleSource(`${dir}${rel}`)
        if (text !== undefined) files[`${rel.split('/').at(-1)}.sctx`] = text
    }
    return files
}

/** The example's scenario, if it has one. */
export async function loadScenario(id: string): Promise<Scenario | undefined> {
    try {
        return await jsonLoader(id, 'scenario', scenarios, showcaseScenarios)?.()
    } catch {
        return undefined
    }
}

/** KIELER's recording of the example's scenario, if there is one. */
export async function loadRecording(id: string): Promise<Recording | undefined> {
    try {
        return await jsonLoader(id, 'oracle', recordings, showcaseRecordings)?.()
    } catch {
        return undefined
    }
}

/** The scenario as a guided tour, if it is one (some ticks, and not a chart KIELER rejects). */
export function tourOf(s: Scenario | undefined): Scenario | undefined {
    return s && s.expect !== 'error' && s.ticks?.length ? s : undefined
}

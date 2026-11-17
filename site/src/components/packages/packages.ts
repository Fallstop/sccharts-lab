// The npm packages, for the components of their documentation (/packages/): names, versions and links come from
// each package's own package.json, so a release shows on the pages without an edit.
import diagram from '../../../packages/diagram/package.json'
import embed from '../../../packages/embed/package.json'
import engine from '../../../packages/engine/package.json'
import trace from '../../../packages/trace/package.json'

export type PackageKey = 'engine' | 'diagram' | 'trace' | 'embed'

export interface PackageInfo {
    key: PackageKey
    /** `@sccharts-lab/engine` */
    name: string
    version: string
    license: string
    /** What it is for, in a sentence (the overview's list). */
    summary: string
    /** The packages to install to use it: itself, after the engine it works on. */
    install: string
    docs: string
    api: string
    npm: string
    source: string
}

const SUMMARY: Record<PackageKey, string> = {
    engine: 'Compile SCTX, get diagnostics a person can act on, run the chart tick by tick, and generate C.',
    diagram: 'Draw a chart as SVG in KIELER’s notation, and highlight a running simulation in it.',
    trace: 'Save a run as a KTrace, CSV, JSON or XML file, replay a file into a chart, and compare runs.',
    embed: 'Put a live chart on any web page with one element, and drive it from the page.',
}

const info = (key: PackageKey, manifest: { name: string; version: string; license: string; repository: { url: string; directory: string }; peerDependencies?: Record<string, string> }): PackageInfo => ({
    key,
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    summary: SUMMARY[key],
    install: [...Object.keys(manifest.peerDependencies ?? {}), manifest.name].join(' '),
    docs: `/packages/${key}/`,
    api: `/packages/${key}/api/`,
    npm: `https://www.npmjs.com/package/${manifest.name}`,
    source: `${manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}/tree/main/${manifest.repository.directory}`,
})

export const PACKAGES: PackageInfo[] = [info('engine', engine), info('diagram', diagram), info('trace', trace), info('embed', embed)]

export function packageInfo(key: PackageKey): PackageInfo {
    const found = PACKAGES.find((p) => p.key === key)
    if (!found) throw new Error(`No package "${key}" (engine, diagram, trace, embed)`)
    return found
}

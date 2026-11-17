// Shared by the tests of the packages' documentation: where its samples and pages are.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE = fileURLToPath(new URL('../../', import.meta.url))
export const SAMPLES = path.join(SITE, 'src/components/packages/samples')
export const PAGES = path.join(SITE, 'src/content/docs/packages')

/** The samples with this extension, as paths under the samples folder (`quick-start/compile.mjs`), sorted. */
export function sampleFiles(extension: string): string[] {
    return (fs.readdirSync(SAMPLES, { recursive: true }) as string[])
        .map((f) => f.split(path.sep).join('/'))
        .filter((f) => f.endsWith(extension))
        .sort()
}

/**
 * Samples that only run against the built packages, with the reason: the workspace's sources have no
 * `@sccharts-lab/diagram/fonts.css` (the build makes it). The packages' smoke test runs them, with the others.
 */
export const BUILT_ONLY = new Map<string, string>([['quick-start/draw.mjs', 'reads fonts.css of the built diagram package']])

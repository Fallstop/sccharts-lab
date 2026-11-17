// The npm packages point at their documentation, and the documentation at the packages as released: each
// package.json's `homepage` is its guide page, its README links to the guide and the API reference, both pages exist,
// the sidebar's packages section keeps to itself, and a jsDelivr address written in the pages, samples or READMEs
// names the released minor version.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPackagesPage, packagesNav, PACKAGES_GROUP } from '../../src/components/overrides/packages-nav'
import { PAGES, SAMPLES, SITE } from './support'

const NAMES = ['engine', 'diagram', 'trace', 'embed']
const manifest = (name: string) => JSON.parse(fs.readFileSync(path.join(SITE, 'packages', name, 'package.json'), 'utf8')) as { version: string; homepage: string }
const filesIn = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())

describe.each(NAMES)('@sccharts-lab/%s links to its documentation', (name) => {
    const guide = `https://sccharts.jmw.nz/packages/${name}/`

    it('its homepage is its guide page, which exists with its API reference', () => {
        expect(manifest(name).homepage).toBe(guide)
        expect(fs.existsSync(path.join(PAGES, name, 'index.mdx'))).toBe(true)
        expect(fs.existsSync(path.join(PAGES, name, 'api.mdx'))).toBe(true)
    })

    it('its README links to the guide and the API reference', () => {
        const readme = fs.readFileSync(path.join(SITE, 'packages', name, 'README.md'), 'utf8')
        expect(readme).toContain(`(${guide})`)
        expect(readme).toContain(`(${guide}api/)`)
    })
})

describe('the documentation names the released version', () => {
    it('jsDelivr addresses of the embed name its minor version', () => {
        const [major, minor] = manifest('embed').version.split('.')
        const wrong: string[] = []
        for (const file of [...filesIn(PAGES), ...filesIn(SAMPLES), ...NAMES.map((n) => path.join(SITE, 'packages', n, 'README.md'))]) {
            for (const m of fs.readFileSync(file, 'utf8').matchAll(/@sccharts-lab\/embed@(\d+\.\d+)/g)) {
                if (m[1] !== `${major}.${minor}`) wrong.push(`${path.relative(SITE, file)}: ${m[0]}`)
            }
        }
        expect(wrong).toEqual([])
    })
})

describe('the packages section of the sidebar', () => {
    const link = (label: string, href: string) => ({ type: 'link' as const, label, href, isCurrent: false, badge: undefined, attrs: {} })
    const group = (label: string, entries: ReturnType<typeof link>[] | unknown[]) => ({ type: 'group' as const, label, entries: entries as never[], collapsed: false, badge: undefined })
    const last = link('Troubleshooting', '/reference/troubleshooting/')
    const overview = link('Overview', '/packages/')
    const quick = link('Quick start', '/packages/quick-start/')
    const engineGuide = link('Guide', '/packages/engine/')
    const engineApi = link('API reference', '/packages/engine/api/')
    const sidebar = [group('Reference', [last]), group(PACKAGES_GROUP, [overview, quick, group('Engine', [engineGuide, engineApi])])]

    it('a guide page lists the packages as one collapsed group, a link per entry', () => {
        const nav = packagesNav(sidebar, { prev: undefined, next: overview }, false)
        const packages = nav.sidebar.at(-1)
        expect(packages).toMatchObject({ type: 'group', label: 'npm packages', collapsed: true })
        expect(packages?.type === 'group' && packages.entries.map((e) => [e.label, e.type === 'link' && e.href])).toEqual([
            ['Overview', '/packages/'],
            ['Quick start', '/packages/quick-start/'],
            ['Engine', '/packages/engine/'],
        ])
        // The guide's last page does not lead on into the packages.
        expect(nav.pagination.next).toBeUndefined()
    })

    it('a packages page has only the packages, a way back, and neighbours named with their package', () => {
        const nav = packagesNav(sidebar, { prev: last, next: quick }, true)
        expect(nav.sidebar.map((e) => e.label)).toEqual(['The guide', 'Overview', 'Quick start', 'Engine'])
        expect(nav.pagination.prev).toBeUndefined()
        expect(nav.pagination.next?.label).toBe('Quick start')
        expect(packagesNav(sidebar, { prev: quick, next: engineApi }, true).pagination.next?.label).toBe('Engine: API reference')
    })

    it('knows its pages by their route', () => {
        expect(['packages', 'packages/engine/api'].map(isPackagesPage)).toEqual([true, true])
        expect(['reference/embed', 'packagesx'].map(isPackagesPage)).toEqual([false, false])
    })
})

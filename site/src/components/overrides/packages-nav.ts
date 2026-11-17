// The npm packages' documentation (/packages/) is a section of its own: its pages get a sidebar of only the
// packages' pages (and a way back to the guide), and the guide's pages get one short group that links into it. Both
// come from the one "Packages" group of the sidebar in astro.config.mjs, so the pages are listed in one place.
// Their code blocks are set a little smaller (CODE_SIZE).
//
// Registered as Starlight's `routeMiddleware` (astro.config.mjs); `packagesNav` is the whole of it, without Astro.
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data'

type Entry = StarlightRouteData['sidebar'][number]
type Link = Extract<Entry, { type: 'link' }>
type Group = Extract<Entry, { type: 'group' }>
type Pagination = StarlightRouteData['pagination']

/** The label of the sidebar group that holds the packages' pages (astro.config.mjs). */
export const PACKAGES_GROUP = 'Packages'
export const PACKAGES_ROOT = '/packages/'

const link = (label: string, href: string, cls?: string): Link => ({ type: 'link', label, href, isCurrent: false, badge: undefined, attrs: cls ? { class: cls } : {} })
const firstLink = (entry: Entry): Link | undefined => (entry.type === 'link' ? entry : entry.entries.map(firstLink).find(Boolean))
const links = (entries: Entry[]): Link[] => entries.flatMap((e) => (e.type === 'link' ? [e] : links(e.entries)))

/** "Engine: API reference" for a page inside a package's group: on its own, "API reference" names four pages. */
function qualified(group: Group, target: Link | undefined): Link | undefined {
    if (!target) return undefined
    const parent = group.entries.find((e): e is Group => e.type === 'group' && e.entries.includes(target))
    return parent ? { ...target, label: `${parent.label}: ${target.label}` } : target
}

/**
 * The sidebar and the previous / next links of a page. Inside /packages/: a link back to the guide, then the
 * packages' pages. Elsewhere: the guide's groups, then the packages as one collapsed group with a link per package
 * (its guide page). Previous and next never cross between the guide and the packages.
 */
export function packagesNav(sidebar: Entry[], pagination: Pagination, inPackages: boolean): { sidebar: Entry[]; pagination: Pagination } {
    const group = sidebar.find((e): e is Group => e.type === 'group' && e.label === PACKAGES_GROUP)
    if (!group) return { sidebar, pagination }
    const inside = new Set(links(group.entries))
    const kept = (target: Link | undefined) => (target && inside.has(target) === inPackages ? target : undefined)
    if (inPackages) {
        return {
            sidebar: [link('The guide', '/', 'sc-sidebar-back'), ...group.entries],
            pagination: { ...pagination, prev: qualified(group, kept(pagination.prev)), next: qualified(group, kept(pagination.next)) },
        }
    }
    const summary: Group = {
        type: 'group',
        label: 'npm packages',
        collapsed: true,
        badge: undefined,
        entries: group.entries.flatMap((e) => {
            const target = firstLink(e)
            return target ? [{ ...target, label: e.label, isCurrent: false }] : []
        }),
    }
    return {
        sidebar: [...sidebar.filter((e) => e !== group), summary],
        pagination: { ...pagination, prev: kept(pagination.prev), next: kept(pagination.next) },
    }
}

/** Whether a page (by its route id: `packages`, `packages/engine/api`) belongs to the packages' documentation. */
export const isPackagesPage = (id: string) => id === 'packages' || id.startsWith('packages/')

/**
 * On the packages' pages code is set a size smaller than in the guide (13 px for 14): their code is programs, not
 * chart fragments, and at this size a line of 74 characters fits the column without scrolling sideways
 * (tests/packages-docs keeps the samples to that).
 */
const CODE_SIZE = ':root{--ec-codeFontSize:0.8125rem}'

export const onRequest = defineRouteMiddleware((context) => {
    const route = context.locals.starlightRoute
    const inPackages = isPackagesPage(route.id)
    const nav = packagesNav(route.sidebar, route.pagination, inPackages)
    route.sidebar = nav.sidebar
    route.pagination = nav.pagination
    if (inPackages) route.head.push({ tag: 'style', attrs: {}, content: CODE_SIZE })
})

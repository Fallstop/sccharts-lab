// The playground's first script: small and eager. It decides which project to open (a shared link, ?example=, the
// reader's last project in this browser, the scratch buffer, or the default), shows its active file at once with
// the editor's highlighting, wires the menus, the phone tabs and the guide's menu, and then loads the editor, the
// compiler and the diagram (app.ts) without blocking the first paint, fetching the example's scenario (its guided
// tour) meanwhile. An exercise's &solution=<id> is handed to the app (Compare). Later, a link opened in the same tab
// (a pasted #code= or #run=, Back and Forward) opens its project the same way.

import { highlightLines } from './static-highlight'
import { chartFromHash, hasRun, hasSharedChart, projectFromHash, runFromHash, SCRATCH_KEY, sourceFromHash, storageGet, type SharedRun } from './share'
import { firstChartName } from './catalogue'
import type { LinkTarget, Origin, Playground, ProjectSpec } from './app'
import { setupTabs } from './tabs'
import { createDiagramView } from './diagram-view'
import { baseOf, exampleFile, sortedPaths } from './project'
import { currentProject } from './project-store'
import { loadFailed, one } from './boot-inline'

interface PageData {
    defaultId: string
    defaultSource: string
    defaultFile: string
}

/** What the app bar says about an example: its title and its guide page, from the example menu. */
function describeFrom(root: HTMLElement, id: string): Origin | undefined {
    const a = root.querySelector<HTMLAnchorElement>(`a[data-example="${CSS.escape(id)}"]`)
    if (!a) return undefined
    const page = a.closest<HTMLElement>('.sc-pg-examples__page')
    const title = a.querySelector('.sc-pg-examples__name')?.textContent ?? id
    const pageTitle = page?.dataset.pageTitle
    const starter = !!a.querySelector('.sc-pg-examples__tag.is-exercise')
    return { kind: 'example', id, title, page: pageTitle ? { title: pageTitle, href: page?.dataset.pageHref } : undefined, ...(starter ? { starter } : {}) }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const fileFor = (text: string) => `${(firstChartName(text) ?? 'chart').replace(/[^\w.-]+/g, '') || 'chart'}.sctx`

/** The build-time code, files and tabs show the project's active file until the editor takes over. */
function renderStatic(root: HTMLElement, project: ProjectSpec) {
    const pre = root.querySelector('[data-pg-editor] [data-pg-static] code')
    if (pre) {
        pre.innerHTML = highlightLines(project.files[project.active] ?? '')
            .map((l, i) => `<span class="sc-pg-static__line"><span class="sc-pg-static__no" aria-hidden="true">${i + 1}</span><span class="sc-pg-static__text">${l || ' '}</span></span>`)
            .join('')
    }
    for (const el of root.querySelectorAll('[data-pg-static-file]')) el.textContent = baseOf(project.active)
    const list = root.querySelector('[data-pg-files-tree] ul')
    if (list) {
        list.replaceChildren(
            ...sortedPaths(Object.keys(project.files)).map(p => {
                const li = document.createElement('li')
                li.className = `sc-pg-files__item${p === project.active ? ' is-active' : ''}`
                li.innerHTML = '<span class="sc-pg-file"><span class="sc-pg-file__glyph" aria-hidden="true"></span><span class="sc-pg-file__name"></span></span>'
                li.querySelector('.sc-pg-file__name')!.textContent = p
                return li
            }),
        )
    }
}

/** `<details>` popovers: one open at a time, closed by Escape and by a click elsewhere. */
function setupPopovers(root: HTMLElement) {
    const pops = [...root.querySelectorAll<HTMLDetailsElement>('details.sc-pg-pop')]
    for (const d of pops) {
        d.addEventListener('toggle', () => {
            if (d.open) for (const o of pops) if (o !== d) o.open = false
            if (d.open) d.querySelector<HTMLInputElement>('[data-pg-filter]')?.focus()
        })
        d.addEventListener('keydown', e => {
            if (e.key === 'Escape' && d.open) {
                e.preventDefault()
                d.open = false
                d.querySelector('summary')?.focus()
            }
        })
    }
    document.addEventListener('pointerdown', e => {
        for (const d of pops) if (d.open && !d.contains(e.target as Node)) d.open = false
    })
    if (isMac) for (const k of root.querySelectorAll('kbd[data-mod]')) k.textContent = '⌘'
}

/**
 * The guide's menu: Starlight's sidebar, as a popover at every width (Starlight makes it one only on phones; here it
 * is a drawer under the app bar, opened by the Guide button, closed by Escape or a click elsewhere).
 */
function setupGuide() {
    const pane = document.getElementById('starlight__sidebar')
    if (!pane) return
    const keep = () => {
        if (pane.getAttribute('popover') !== 'auto') pane.setAttribute('popover', 'auto')
    }
    keep()
    void customElements.whenDefined('sl-sidebar-pane').then(keep)
    matchMedia('(min-width: 50em)').addEventListener('change', () => queueMicrotask(keep))
    // A page of the guide chosen in it is left for: nothing to restore.
    pane.addEventListener('toggle', e => {
        const open = (e as ToggleEvent).newState === 'open'
        document.querySelector('[data-pg-guide]')?.setAttribute('aria-expanded', String(open))
        if (open) pane.querySelector<HTMLElement>('[aria-current="page"], a')?.focus()
    })
}
function setupExamples(root: HTMLElement, open: (id: string) => boolean, current: () => string | undefined) {
    const menu = root.querySelector<HTMLDetailsElement>('[data-pg-examples]')
    if (!menu) return
    const filter = menu.querySelector<HTMLInputElement>('[data-pg-filter]')!
    const links = [...menu.querySelectorAll<HTMLAnchorElement>('a[data-example]')]
    const none = menu.querySelector<HTMLElement>('[data-pg-none]')
    const visible = () => links.filter(a => !a.closest('li')!.hidden)
    // What a filter matches: the chart's name, its file, its page and its section.
    const haystack = new Map(
        links.map(a => {
            const page = a.closest('.sc-pg-examples__page')?.querySelector('h3')?.textContent ?? ''
            const group = a.closest('.sc-pg-examples__group')?.querySelector('h2')?.textContent ?? ''
            return [a, `${a.textContent} ${page} ${group}`.toLowerCase()]
        }),
    )
    const apply = () => {
        const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean)
        for (const a of links) a.closest('li')!.hidden = !words.every(w => haystack.get(a)!.includes(w))
        for (const page of menu.querySelectorAll<HTMLElement>('.sc-pg-examples__page')) page.hidden = !page.querySelector('li:not([hidden])')
        for (const group of menu.querySelectorAll<HTMLElement>('.sc-pg-examples__group')) group.hidden = !group.querySelector('li:not([hidden])')
        if (none) none.hidden = visible().length > 0
    }
    filter.addEventListener('input', apply)
    filter.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault()
            visible()[0]?.click()
        } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            visible()[0]?.focus()
        }
    })
    menu.addEventListener('keydown', e => {
        const a = (e.target as Element).closest?.('a[data-example]') as HTMLAnchorElement | null
        if (!a || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
        e.preventDefault()
        const list = visible()
        const i = list.indexOf(a)
        if (e.key === 'ArrowUp' && i === 0) filter.focus()
        else list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    })
    menu.addEventListener('toggle', () => {
        if (!menu.open) return
        const id = current()
        for (const a of links) {
            if (a.dataset.example === id) a.setAttribute('aria-current', 'true')
            else a.removeAttribute('aria-current')
        }
        menu.querySelector<HTMLElement>('a[aria-current]')?.scrollIntoView({ block: 'nearest' })
    })
    menu.addEventListener('click', e => {
        const a = (e.target as Element).closest?.('a[data-example]') as HTMLAnchorElement | null
        if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
        // Until the editor has loaded, the link itself opens the example.
        if (!open(a.dataset.example!)) return
        e.preventDefault()
        menu.open = false
    })
}

/** What a playground address opens: a shared project (`#project=`) or chart (`#code=`), an example (`?example=`, with
 *  the files it imports), any of them with a shared run (`&run=`, `&chart=`), and an exercise's model solution
 *  (`&solution=`); `notice` says what could not be read. Without a chart in the address, `project` is undefined
 *  (boot then opens the reader's last project or the default). */
async function linkTarget(loc: Location, describe: (id: string) => Origin | undefined): Promise<Partial<LinkTarget> & { notice?: string; param?: string }> {
    let project: ProjectSpec | undefined
    let origin: Origin | undefined
    let scenario: LinkTarget['scenario']
    let notice: string | undefined
    const shared = projectFromHash(loc.hash)
    const code = shared ? null : sourceFromHash(loc.hash)
    // A shared run (`&run=`): the inputs of every tick, replayed as a tour through them.
    const run = runFromHash(loc.hash) ?? undefined
    if (!run && hasRun(loc.hash)) notice = 'This link is damaged: its run could not be read. Here is the chart without it.'
    const query = new URLSearchParams(loc.search)
    const param = query.get('example') ?? undefined
    // An exercise's TryIt link names its model solution (it stays in the address bar while the reader edits).
    const solutionParam = query.get('solution')?.trim() || undefined
    // The example library's loaders, only when the address names an example.
    const lib = param || solutionParam ? await import('./sources') : undefined
    if (shared) {
        project = { name: shared.name, files: shared.files, active: shared.active }
        origin = { kind: 'shared', title: shared.name }
    } else if (code) {
        project = one('Shared chart', fileFor(code), code)
        origin = { kind: 'shared', title: 'Shared chart' }
    } else if (param && lib) {
        const id = lib.normaliseId(param)
        const [text, sc] = await Promise.all([lib.loadExampleSource(id), lib.loadScenario(id)])
        if (text !== undefined) {
            // Exercise solutions are not in the menu; name them after their chart.
            origin = describe(id) ?? { kind: 'example', id, title: firstChartName(text) ?? id }
            const imports = await lib.loadImports(id, text, sc)
            const main = exampleFile(id)
            project = { name: origin.title, files: { [main]: text, ...imports }, active: main }
            scenario = sc
        } else {
            notice = `There is no example called ${id}. Here is the default chart instead.`
        }
    } else if (hasSharedChart(loc.hash)) {
        notice = 'This link is damaged: its chart could not be read. Here is the default chart instead.'
    }
    // A run without its chart (a damaged link) is not replayed on another chart.
    const replay: SharedRun | undefined = run && project ? run : undefined
    return { project, origin, scenario, notice, param, run: replay, chart: replay ? chartFromHash(loc.hash) : undefined, solution: solutionParam && lib ? lib.normaliseId(solutionParam) : undefined }
}

/** Without a chart in the address: the reader's last project in this browser, else the scratch buffer (the last
 *  chart edited, in local storage), else the default chart. */
async function lastProject(data: PageData, describe: (id: string) => Origin | undefined): Promise<{ project: ProjectSpec; origin: Origin }> {
    const stored = await currentProject()
    if (stored && Object.keys(stored.files).length) {
        const origin: Origin = stored.folder ? { kind: 'folder', title: stored.name } : { kind: 'scratch', title: stored.name }
        return { project: { name: stored.name, files: stored.files, active: stored.active, open: stored.open, id: stored.id, folder: stored.folder }, origin }
    }
    const saved = storageGet(SCRATCH_KEY)
    if (saved?.trim() && saved !== data.defaultSource) return { project: one('Your last chart', fileFor(saved), saved), origin: { kind: 'scratch', title: 'Your last chart' } }
    return defaultProject(data, describe)
}

function defaultProject(data: PageData, describe: (id: string) => Origin | undefined): { project: ProjectSpec; origin: Origin } {
    const origin = describe(data.defaultId) ?? { kind: 'default' as const, id: data.defaultId, title: 'ABRO' }
    return { project: one(origin.title, data.defaultFile, data.defaultSource), origin }
}

export async function bootPage() {
    const root = document.querySelector<HTMLElement>('[data-sc-playground]')
    if (!root || root.dataset.pgBooted !== undefined) return
    root.dataset.pgBooted = ''
    const data = JSON.parse(root.querySelector('[data-pg-data]')?.textContent ?? '{}') as PageData
    const describe = (id: string) => describeFrom(root, id)
    setupPopovers(root)
    setupTabs(root)
    setupGuide()

    let app: Playground | undefined
    setupExamples(
        root,
        id => {
            if (!app) return false
            void app.loadExample(id)
            return true
        },
        () => app?.currentExample,
    )

    // Which project to open.
    const target = await linkTarget(location, describe)
    const { notice, param, run: replay, solution } = target
    let { project, origin } = target
    // A link that names a chart it cannot give (a damaged one, an example that is not there) opens the default chart.
    if (!project || !origin) ({ project, origin } = param || hasSharedChart(location.hash) ? defaultProject(data, describe) : await lastProject(data, describe))
    if (project.files[project.active] !== data.defaultSource || Object.keys(project.files).length > 1) {
        renderStatic(root, project)
        root.querySelector<HTMLElement>('[data-pg-static-diagram]')?.setAttribute('hidden', '')
        const name = root.querySelector('[data-pg-title-name]')
        if (name) name.textContent = project.name
    }

    // The diagram stage works at once (fitted, pan and zoom) with the build-time diagram.
    const diagram = createDiagramView(root, 'page')
    let mod: typeof import('./app')
    // The example's guided tour (its scenario), fetched while the app loads.
    const exampleId = origin.kind === 'example' || origin.kind === 'default' ? origin.id ?? data.defaultId : undefined
    const scenario = target.scenario
        ? Promise.resolve(target.scenario)
        : exampleId ? import('./sources').then(m => m.loadScenario(exampleId)).catch(() => undefined) : Promise.resolve(undefined)
    try {
        mod = await import('./app')
    } catch {
        loadFailed(root)
        return
    }
    app = new mod.Playground({ root, mode: 'page', project, origin, describe, diagram, scenario: await scenario, solution, run: replay, chart: target.chart })
    if (notice) app.toast(notice)

    // A link opened in this tab later (a #code= or #run= pasted into the address bar, Back and Forward between
    // them): only the hash changes, so the page does not load again. Open its project as above. The app's own address
    // updates replace the entry and fire neither event; the two events of one navigation are handled once.
    let handled = location.href
    const follow = async () => {
        if (location.href === handled || !app) return
        handled = location.href
        const next = await linkTarget(location, describe)
        if (location.href !== handled) return
        if (!next.project && !next.param && !hasSharedChart(location.hash)) Object.assign(next, await lastProject(data, describe))
        if (!next.project || !next.origin) {
            if (next.notice) app.toast(next.notice.replace(/ Here is the default chart instead\.$/, ''))
            return
        }
        const id = next.origin.kind === 'example' || next.origin.kind === 'default' ? next.origin.id ?? data.defaultId : undefined
        const tour = next.scenario ?? (id ? await import('./sources').then(m => m.loadScenario(id)).catch(() => undefined) : undefined)
        if (location.href !== handled) return
        app.openLink({ project: next.project, origin: next.origin, scenario: tour, run: next.run, chart: next.chart, solution: next.solution }, next.notice)
    }
    window.addEventListener('hashchange', () => void follow())
    window.addEventListener('popstate', () => void follow())
}

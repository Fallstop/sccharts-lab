// The playground's first script: small and eager. It decides which chart to open (a shared link, ?example=, the
// scratch buffer or the default), shows its source at once with the editor's highlighting, wires the menus, and
// then loads the editor, the compiler and the diagram (app.ts) without blocking the first paint, fetching the
// example's scenario (its guided tour) meanwhile. An exercise's &solution=<id> is handed to the app (Compare).
// Later, a link opened in the same tab (a pasted #code= or #run=, Back and Forward) opens its chart the same way.

import { highlightLines } from './static-highlight'
import { chartFromHash, hasRun, runFromHash, SCRATCH_KEY, sourceFromHash, storageGet, type SharedRun } from './share'
import { firstChartName } from './catalogue'
import type { LinkTarget, Origin, Playground } from './app'
import { setupTabs } from './tabs'
import { createDiagramView } from './diagram-view'

interface PageData {
    defaultId: string
    defaultSource: string
}

/** What the toolbar says about an example: its title and its guide page, from the example menu. */
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

function renderStatic(host: HTMLElement | null, source: string) {
    const pre = host?.querySelector('[data-pg-static] code')
    if (!pre) return
    pre.innerHTML = highlightLines(source)
        .map((l, i) => `<span class="sc-pg-static__line"><span class="sc-pg-static__no" aria-hidden="true">${i + 1}</span><span class="sc-pg-static__text">${l || ' '}</span></span>`)
        .join('')
}

/** The editor did not load (offline, a blocked script): say so where the compiler's status would be. */
function loadFailed(root: HTMLElement) {
    const summary = root.querySelector('[data-pg-problems-summary]')
    if (summary) summary.textContent = 'The editor could not be loaded. Reload the page to try again.'
    root.querySelector('[data-pg-problems]')?.setAttribute('data-state', 'error')
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

/** What a playground address opens: a shared chart (`#code=`), an example (`?example=`), either with a shared run
 *  (`&run=`, `&chart=`), and an exercise's model solution (`&solution=`); `notice` says what could not be read.
 *  Without a chart in the address, `source` is undefined (boot then opens the scratch buffer or the default). */
async function linkTarget(loc: Location, describe: (id: string) => Origin | undefined): Promise<Partial<LinkTarget> & { notice?: string; param?: string }> {
    let source: string | undefined
    let origin: Origin | undefined
    let notice: string | undefined
    const shared = sourceFromHash(loc.hash)
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
        source = shared
        origin = { kind: 'shared', title: 'Shared chart' }
    } else if (param && lib) {
        const { loadExampleSource, normaliseId } = lib
        const id = normaliseId(param)
        const text = await loadExampleSource(id)
        if (text !== undefined) {
            source = text
            // Exercise solutions are not in the menu; name them after their chart.
            origin = describe(id) ?? { kind: 'example', id, title: firstChartName(text) ?? id }
        } else {
            notice = `There is no example called ${id}. Here is the default chart instead.`
        }
    } else if (loc.hash.startsWith('#code=')) {
        notice = 'This link is damaged: its chart could not be read. Here is the default chart instead.'
    }
    // A run without its chart (a damaged link) is not replayed on another chart.
    const replay: SharedRun | undefined = run && source !== undefined ? run : undefined
    return { source, origin, notice, param, run: replay, chart: replay ? chartFromHash(loc.hash) : undefined, solution: solutionParam && lib ? lib.normaliseId(solutionParam) : undefined }
}

export async function bootPage() {
    const root = document.querySelector<HTMLElement>('[data-sc-playground]')
    if (!root || root.dataset.pgBooted !== undefined) return
    root.dataset.pgBooted = ''
    const data = JSON.parse(root.querySelector('[data-pg-data]')?.textContent ?? '{}') as PageData
    const describe = (id: string) => describeFrom(root, id)
    setupPopovers(root)
    setupTabs(root)
    // The app fills the first screen below the page title.
    const measure = () => root.style.setProperty('--pg-top', `${Math.max(0, Math.round(root.getBoundingClientRect().top + window.scrollY))}px`)
    measure()
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)

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

    // Which chart to open.
    const target = await linkTarget(location, describe)
    let { source, origin } = target
    const { notice, param, run: replay, solution } = target
    if (source === undefined && !param && !location.hash.startsWith('#code=')) {
        const saved = storageGet(SCRATCH_KEY)
        if (saved && saved.trim() && saved !== data.defaultSource) {
            source = saved
            origin = { kind: 'scratch', title: 'Your last chart' }
        }
    }
    if (source === undefined) {
        source = data.defaultSource
        origin = describe(data.defaultId) ?? { kind: 'default', title: 'ABRO' }
    }
    if (source !== data.defaultSource) {
        renderStatic(root.querySelector('[data-pg-editor]'), source)
        root.querySelector<HTMLElement>('[data-pg-static-diagram]')?.setAttribute('hidden', '')
        const name = root.querySelector('[data-pg-title-name]')
        if (name) {
            name.textContent = origin!.title
            name.classList.toggle('is-prose', origin!.kind === 'shared' || origin!.kind === 'scratch')
        }
    }

    // The diagram stage works at once (fitted, pan and zoom) with the build-time diagram.
    const diagram = createDiagramView(root, 'page')
    let mod: typeof import('./app')
    // The example's guided tour (its scenario), fetched while the app loads.
    const exampleId = origin!.kind === 'example' || origin!.kind === 'default' ? origin!.id ?? data.defaultId : undefined
    const scenario = exampleId ? import('./sources').then(m => m.loadScenario(exampleId)).catch(() => undefined) : Promise.resolve(undefined)
    try {
        mod = await import('./app')
    } catch {
        loadFailed(root)
        return
    }
    app = new mod.Playground({ root, mode: 'page', source, origin: origin!, describe, diagram, scenario: await scenario, solution, run: replay, chart: target.chart })
    requestAnimationFrame(measure)
    if (notice) app.toast(notice)

    // A link opened in this tab later (a #code= or #run= pasted into the address bar, Back and Forward between
    // them): only the hash changes, so the page does not load again. Open its chart as above. The app's own address
    // updates replace the entry and fire neither event; the two events of one navigation are handled once.
    let handled = location.href
    const follow = async () => {
        if (location.href === handled || !app) return
        handled = location.href
        const next = await linkTarget(location, describe)
        if (location.href !== handled) return
        if (next.source === undefined && !next.param && !location.hash.startsWith('#code=')) {
            // An address without a chart (Back to the bare /playground/): the reader's last chart, as on load.
            const saved = storageGet(SCRATCH_KEY)
            if (saved?.trim() && saved !== data.defaultSource) {
                next.source = saved
                next.origin = { kind: 'scratch', title: 'Your last chart' }
            } else {
                next.source = data.defaultSource
                next.origin = describe(data.defaultId) ?? { kind: 'default', title: 'ABRO' }
            }
        }
        if (next.source === undefined || !next.origin) {
            if (next.notice) app.toast(next.notice.replace(/ Here is the default chart instead\.$/, ''))
            return
        }
        const id = next.origin.kind === 'example' || next.origin.kind === 'default' ? next.origin.id ?? data.defaultId : undefined
        const tour = id ? await import('./sources').then(m => m.loadScenario(id)).catch(() => undefined) : undefined
        if (location.href !== handled) return
        app.openLink({ source: next.source, origin: next.origin, scenario: tour, run: next.run, chart: next.chart, solution: next.solution }, next.notice)
    }
    window.addEventListener('hashchange', () => void follow())
    window.addEventListener('popstate', () => void follow())
}

/** Inline playgrounds on guide pages: each starts when it comes near the viewport. */
export function bootInline() {
    const els = [...document.querySelectorAll<HTMLElement>('[data-sc-playground-inline]:not([data-pg-booted])')]
    for (const el of els) bootOneInline(el)
}

/** The way from `root` down to `el`, as indices among element children (undefined when `el` is not inside). */
function pathTo(root: Element, el: Element): number[] | undefined {
    const path: number[] = []
    for (let n: Element = el; n !== root; ) {
        const parent = n.parentElement
        if (!parent) return undefined
        path.unshift([...parent.children].indexOf(n))
        n = parent
    }
    return path
}

/** The element at the end of `path` under `root`. */
function atPath(root: Element, path: number[]): HTMLElement | undefined {
    let n: Element | undefined = root
    for (const i of path) n = n?.children[i]
    return n instanceof HTMLElement ? n : undefined
}

/** A press under way ends at the latest after this long (a pointer let go outside the window, say). */
const PRESS_LIMIT = 1500

/**
 * One inline playground. As the widgets' client:engage (src/components/sim/engage.ts), the app starts when the reader
 * engages with the frame (a click, a touch, a key, focus inside it), so a reader who only scrolls past loads none of
 * it; the pointer over the frame fetches the code ahead. The page already shows everything at its final size
 * (PlaygroundInline.astro renders the simulation panel too), so nothing moves when it starts. A click into the code
 * puts the cursor in the editor once it is there.
 *
 * The build-time panel looks ready: a click on one of its controls (Step, an input's switch) is held and made again
 * on the same control of the live panel, which the app mounts in its place (the two have the same shape), and
 * keyboard focus in the panel moves with it. The app takes over only once no press is under way in the panel
 * (between a pointer or a key going down and its click), so that no click lands on a control that is gone.
 */
function bootOneInline(el: HTMLElement) {
    // Once (bootInline runs again after a client-side navigation).
    if (el.dataset.pgArmed !== undefined) return
    el.dataset.pgArmed = ''
    const zone = el.closest<HTMLElement>('[data-sc-frame]') ?? el
    const sim = zone.querySelector<HTMLElement>('[data-pg-sim]')
    const TRIGGERS = ['pointerdown', 'touchstart', 'keydown', 'focusin'] as const
    let live = false
    let held: number[] | undefined
    let pressing = false
    let released: (() => void) | undefined
    const release = () => {
        if (!pressing) return
        pressing = false
        // After the click that ends the press has been dispatched.
        setTimeout(() => released?.())
    }
    const press = (e: Event) => {
        if (!live && sim?.contains(e.target as Node)) pressing = true
    }
    const idle = () =>
        pressing
            ? new Promise<void>(resolve => {
                  released = resolve
                  setTimeout(resolve, PRESS_LIMIT)
              })
            : Promise.resolve()
    const hold = (e: MouseEvent) => {
        if (live || !sim) return
        const control = e.target instanceof Element ? e.target.closest('button, label, input[type="checkbox"]') : null
        if (control && sim.contains(control)) {
            e.preventDefault()
            e.stopImmediatePropagation()
            held ??= pathTo(sim, control)
            go(e)
        }
        release()
    }
    const letGo = () => setTimeout(release, 50)
    const listen = (on: boolean) => {
        const method = on ? 'addEventListener' : 'removeEventListener'
        zone[method]('pointerdown', press, { capture: true })
        zone[method]('keydown', press, { capture: true })
        zone[method]('click', hold as EventListener, { capture: true })
        // A pointer or a key let go anywhere (without a click: a drag off the control) ends the press too.
        for (const t of ['pointerup', 'pointercancel', 'keyup'] as const) window[method](t, letGo, { capture: true })
    }
    const start = async () => {
        if (el.dataset.pgBooted !== undefined) return
        el.dataset.pgBooted = ''
        const source = JSON.parse(el.querySelector('[data-pg-source]')?.textContent ?? '""') as string
        const id = el.dataset.example
        let Playground: typeof import('./app').Playground
        try {
            ;({ Playground } = await import('./app'))
        } catch {
            loadFailed(el)
            listen(false)
            return
        }
        await idle()
        const focused = document.activeElement
        const focusPath = sim && focused && sim.contains(focused) ? pathTo(sim, focused) : undefined
        const inCode = !!focused && !!el.querySelector('[data-pg-editor]')?.contains(focused)
        // The whole widget frame is the app's root: the simulation sits in the frame's panel slot.
        const app = new Playground({ root: zone, mode: 'embed', source, origin: { kind: id ? 'example' : 'new', id, title: id ?? 'Chart' } })
        // Keyboard focus on the build-time code goes to the editor that took its place.
        if (inCode && !zone.contains(document.activeElement)) zone.querySelector<HTMLElement>('.cm-content')?.focus()
        await app.simulationReady()
        live = true
        listen(false)
        if (sim && focusPath && !zone.contains(document.activeElement)) atPath(sim, focusPath)?.focus()
        if (sim && held) atPath(sim, held)?.click()
    }
    const prefetch = () => {
        zone.removeEventListener('pointerover', prefetch)
        void import('./app').catch(() => undefined)
    }
    let going = false
    function go(e: Event) {
        if (going) return
        going = true
        for (const t of TRIGGERS) zone.removeEventListener(t, go)
        zone.removeEventListener('pointerover', prefetch)
        const target = e.target instanceof Element ? e.target : null
        const intoEditor = e.type !== 'keydown' && e.type !== 'focusin' && !!target?.closest('[data-pg-editor]')
        void start().then(() => {
            if (!intoEditor) return
            let tries = 0
            const focus = () => {
                const content = zone.querySelector<HTMLElement>('.cm-content')
                if (content) content.focus()
                else if (++tries < 120) requestAnimationFrame(focus)
            }
            focus()
        })
    }
    zone.addEventListener('pointerover', prefetch, { passive: true })
    listen(true)
    for (const t of TRIGGERS) zone.addEventListener(t, go, { passive: true })
}

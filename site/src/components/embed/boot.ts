// The embed's script (src/pages/embed.astro): takes commands from the framing page at once (bridge.ts, queued until
// the playground is live), reads the options and the chart from the address as the playground does (`?example=`,
// `#code=`, `#project=`, `#run=`, `&chart=`; `source=parent`: from the page), then starts the playground's
// controller (app.ts, the inline playground's 'embed' mode) on the embed's markup and reports it to the page.
//
// The embed never touches the reader's own playground: the page's first script gives it an in-memory storage in
// place of local storage and no IndexedDB, and the 'embed' mode saves nothing anyway.

import { parseEmbedQuery, VIEW_PARTS } from '@sccharts-lab/embed/options'
import { Bridge } from './bridge'
import { startSizing } from './sizing'
import { DiagramView } from '../playground/diagram-view'
import { wireOpenLink } from './open-link'
import { linkTarget } from '../playground/boot'
import { loadFailed, one } from '../playground/boot-inline'
import { firstChartName } from '../playground/catalogue'
import type { LinkTarget, Origin, ProjectSpec } from '../playground/app-types'
import type { Scenario } from '../frame/examples'
import { hasRun, runFromHash, type SharedRun } from '../playground/share'

const DEFAULT_EXAMPLE = 'showcase/abro'

const root = document.querySelector<HTMLElement>('[data-sc-embed]')!
const options = parseEmbedQuery(location.search)
const bridge = new Bridge(options.view)

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)

function layout() {
    const parts = VIEW_PARTS[options.view]
    const height = typeof options.height === 'number' ? 'fixed' : options.height
    root.dataset.view = options.view
    root.dataset.height = document.documentElement.dataset.embedHeight = height
    if (typeof options.height === 'number') root.style.setProperty('--embed-h', `${options.height}px`)
    if (options.controls) delete root.dataset.controls
    else root.dataset.controls = 'off'
    // Parts the view leaves out are not shown, nor reachable (the editor still holds the text the others follow).
    $('[data-embed-part="editor"]')!.hidden = !parts.editor
    $('[data-embed-part="sim"]')!.hidden = !parts.sim
    root.setAttribute('aria-label', parts.editor ? 'SCCharts Lab: editor' : parts.sim ? 'SCCharts Lab: simulation' : 'SCCharts Lab: diagram')
}

function notice(text: string) {
    const p = $('[data-embed-notice]')
    if (!p) return
    p.textContent = text
    p.hidden = false
}

function showName(name: string) {
    const el = $('[data-pg-chart-name]')
    if (el) el.textContent = el.title = name
    document.title = `${name} · SCCharts Lab`
}

/** The chart to open: from the page (`source=parent`), from the address, else the default example. */
async function chart(): Promise<Partial<LinkTarget> & { project: ProjectSpec; origin: Origin }> {
    if (options.source === 'parent') {
        const loading = $('[data-embed-loading]')
        if (loading) loading.textContent = 'Waiting for the chart from the page'
        const m = await bridge.waitForChart()
        // A run in the address (`#run=`, the element's `run`) replays on the page's chart.
        const run = runFromHash(location.hash) ?? undefined
        if (hasRun(location.hash) && !run) notice('The run in this address is damaged, so it is not replayed.')
        if (m.command === 'setSource') {
            const name = firstChartName(m.source) ?? 'Chart'
            return { project: one(name, `${name}.sctx`, m.source), origin: { kind: 'shared', title: name }, run }
        }
        const active = m.active ?? Object.keys(m.files)[0]
        const name = m.name ?? firstChartName(m.files[active] ?? '') ?? 'Chart'
        return { project: { name, files: m.files, active }, origin: { kind: 'shared', title: name }, run }
    }
    const target = await linkTarget(location, () => undefined)
    if (target.notice) notice(target.notice)
    if (target.project && target.origin) return { ...target, project: target.project, origin: target.origin }
    const lib = await import('../playground/sources')
    const text = (await lib.loadExampleSource(DEFAULT_EXAMPLE)) ?? ''
    return { project: one('ABRO', 'abro.sctx', text), origin: { kind: 'example', id: DEFAULT_EXAMPLE, title: 'ABRO' }, scenario: await lib.loadScenario(DEFAULT_EXAMPLE) }
}

async function boot() {
    layout()
    startSizing(root, height => bridge.post({ event: 'resize', height }))
    const appModule = import('../playground/app')
    const target = await chart()
    showName(firstChartName(target.project.files[target.project.active] ?? '') ?? target.project.name)
    const run: SharedRun | undefined = target.run && options.tick !== undefined ? { ...target.run, at: Math.min(options.tick, target.run.ticks.length) } : target.run
    const tour: Scenario | undefined = options.tour ? target.scenario : undefined
    let mod: typeof import('../playground/app')
    let watchMod: typeof import('../playground/model.svelte')
    try {
        ;[mod, watchMod] = await Promise.all([appModule, import('../playground/model.svelte')])
    } catch {
        loadFailed(root)
        $('[data-embed-loading]')?.setAttribute('hidden', '')
        return
    }
    // The stage as the inline playground's, but a chart opens whole down to a fifth of its size: an embed is often
    // small, and the whole chart, its active states marked, matters more there than its labels at a readable size.
    const stage = $('[data-pg-stage]')!
    const diagram = new DiagramView({ stage, maxFit: 1, padTop: 48, fitMin: 0.2 })
    const app = new mod.Playground({ root, mode: 'embed', project: target.project, origin: target.origin, scenario: tour, run, chart: options.chart ?? target.chart, diagram })
    // `tour`: open in the guided tour, the showcase's charts too (the playground opens those in free play).
    if (tour && app.sim.originTour) {
        app.sim.wantTour = true
        app.sim.tourActive = true
    }
    $('[data-embed-loading]')?.setAttribute('hidden', '')
    await app.simulationReady()
    // `tick`: a run opens at that tick (above); otherwise the tour's ticks, or ticks with the inputs as they are.
    const host = app.sim.host
    if (host && !run && options.tick && app.sim.ok) {
        for (let i = 0; i < options.tick; i++) {
            const at = host.stepQuietly()
            if (!at || at.tick?.error || at.tick?.terminated) break
        }
        host.settle()
    }
    const open = $<HTMLAnchorElement>('[data-embed-open]')
    if (open) wireOpenLink(open, app)
    // `ready` once the page shows the chart: its first layout is drawn (or failed, or there is nothing to draw).
    await drawn()
    bridge.attach(app, watchMod.watch)
}

/** Resolves once the diagram's layout is no longer under way (at most a few seconds: a huge chart still says ready). */
function drawn(): Promise<void> {
    return new Promise(resolve => {
        const done = () => root.dataset.layout !== 'busy'
        if (done()) return resolve()
        const mo = new MutationObserver(() => {
            if (!done()) return
            mo.disconnect()
            resolve()
        })
        mo.observe(root, { attributes: true, attributeFilter: ['data-layout'] })
        setTimeout(() => {
            mo.disconnect()
            resolve()
        }, 8000)
    })
}

void boot()

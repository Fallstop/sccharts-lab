// "Copy link to this run" (in the simulation's head): the inputs of every tick computed go into the link
// (share.ts), next to the chart: the example as it is (?example=), else its source (#code=, or #project= for several
// files). Whoever opens it gets the run as a tour through it, at the tick that was shown, with Take over.

import { plural } from './app-types'
import { runInputs } from './run-tour'
import { makeRun, runUrl, MAX_RUN_TICKS } from './share'
import type { Playground } from './app'

export async function shareRun(pg: Playground) {
    const sim = pg.sim
    const view = sim.view
    const a = sim.analysed
    if (!a || !view?.history.length) {
        pg.toast('Run the chart first: the link carries the inputs of every tick you run.')
        return
    }
    // The inputs each tick ran with (the engine's TickResult.ranWith; runInputs replays them to check).
    const found = runInputs(a.result, view.history)
    const run = makeRun(found.ticks, view.cursor)
    // The chart the run belongs to: the one in the panel (the source may have changed since the run started).
    const source = a.tracker.doc.toString()
    const project = pg.project
    const asLoaded = project.paths.every(p => (p === a.file ? source : project.text(p)) === project.loaded[p]) && project.paths.length === Object.keys(project.loaded).length
    const example = (pg.origin.kind === 'example' || pg.origin.kind === 'default') && pg.origin.id && asLoaded && a.file === project.mainFile ? pg.origin.id : undefined
    // Another chart of the file than the first: the link names it.
    const ran = a.result.chart?.name
    const name = ran && ran !== a.result.program?.charts[0]?.name ? ran : undefined
    const files = { ...project.texts(), [a.file]: source }
    const where = example ? { example, name } : project.paths.length > 1 ? { project: { name: project.name, files, active: a.file }, name } : { source, name }
    const url = runUrl(location.href, run, where)
    history.replaceState(history.state, '', url)
    let copied = false
    try {
        await navigator.clipboard.writeText(url)
        copied = true
    } catch {
        copied = false
    }
    const cut = found.ticks.length > run.ticks.length
    const what = cut
        ? `its first ${run.ticks.length.toLocaleString('en-NZ')} of ${found.ticks.length.toLocaleString('en-NZ')} ticks: a link carries at most ${MAX_RUN_TICKS.toLocaleString('en-NZ')}, and the Trace tab saves the whole run`
        : `${plural(run.ticks.length, 'tick')}${run.at < run.ticks.length ? `, opening at tick ${run.at}` : ''}`
    const stale = sim.stale && sim.started ? ' It has the chart as it was when this run started.' : ''
    // The inputs are the engine's own (TickResult.ranWith); a replay that still differs (it should not) is said.
    const inexact = found.exact < found.ticks.length ? ` Replayed here, the run differs from tick ${found.exact + 1} on, so the link may show another run from there.` : ''
    const long = url.length > 8000 ? ` It is ${url.length.toLocaleString('en-NZ')} characters long; some chat apps cut long links.` : ''
    pg.toast((copied ? `Link copied: it replays this run (${what}).` : `Copy the link from the address bar: it replays this run (${what}).`) + stale + inexact + long)
}

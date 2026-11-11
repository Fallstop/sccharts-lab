// "Open in SCCharts Lab": the playground with the embed's chart as it is now: the example (`?example=`) while it is
// as loaded, else its text (`#code=`, or `#project=` for several files); with the run so far (`&run=`, replayed there
// as a tour) once the reader has stepped. Worked out when the link is about to be followed, not on every tick.

import { sameFiles } from '../playground/project'
import { runInputs } from '../playground/run-tour'
import { hashForProject, makeRun, runUrl } from '../playground/share'
import type { Playground } from '../playground/app'

export function playgroundHref(app: Playground): string {
    const url = new URL('/playground/', location.origin)
    const project = app.project
    const texts = project.texts()
    const origin = app.origin
    const example = (origin.kind === 'example' || origin.kind === 'default') && origin.id && sameFiles(texts, project.loaded) ? origin.id : undefined
    const sim = app.sim
    const view = sim.view
    const a = sim.analysed
    // Another chart of the file than the first (the embed's `chart`, or one chosen in it): the link names it.
    const ran = a?.result.chart?.name
    const name = ran && ran !== a?.result.program?.charts[0]?.name ? ran : undefined
    const which = name ? `chart=${encodeURIComponent(name)}` : ''
    if (a && view?.history.length && sim.ok && !sim.stale) {
        const run = makeRun(runInputs(a.result, view.history).ticks, view.cursor)
        const several = Object.keys(texts).length > 1
        const where =
            example && a.file === project.mainFile
                ? { example, name }
                : several
                  ? { project: { name: project.name, files: texts, active: a.file }, name }
                  : { source: texts[a.file] ?? a.tracker.doc.toString(), name }
        return runUrl(url, run, where)
    }
    if (example) {
        url.search = `?example=${encodeURIComponent(example).replace(/%2F/g, '/')}`
        if (which) url.hash = which
        return url.href
    }
    url.hash = `${hashForProject({ name: project.name, files: texts, active: project.active })}${which ? `&${which}` : ''}`
    return url.href
}

/** Keeps the link's address current whenever it may be followed (a click, a middle click, the context menu, focus). */
export function wireOpenLink(link: HTMLAnchorElement, app: Playground) {
    const update = () => {
        link.href = playgroundHref(app)
    }
    for (const type of ['pointerdown', 'focus', 'contextmenu', 'click', 'auxclick'] as const) link.addEventListener(type, update)
    update()
}

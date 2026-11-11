// The live diagram: each compile that parses is laid out (ELK in a worker, latest request wins) and drawn; while the
// text has syntax errors the last good diagram stays, dimmed, with a badge; a diagram of another chart goes. The
// highlight classes of the simulation, the errors, the editor's cursor, the pointer and the panel are merged here.
// Its elements are linked with the source both ways (a click selects the source; the element under the cursor is
// outlined), and they are a tab stop for the keyboard, as in the guide's widgets (src/components/sim/link.ts).

import type { CompileResult } from '@sccharts-lab/engine'
import { elementsAt, mergeClasses, spanOf, type ClassMap } from '@sccharts-lab/diagram/highlight'
import type { DiagramLayout } from '@sccharts-lab/diagram/types'
import { $, escapeHtml, isSyntaxBroken, type Analysed } from './app-types'
import { chartNames } from './catalogue'
import { DiagramView, createDiagramView } from './diagram-view'
import { selectRange } from './editor'
import { LayoutService, type LayoutDone } from './layout-service'
import { Outline } from './outline'
import { copyCounters, enableDiagramKeys, markCopies, markErrors, pulseTransitions, refreshNames } from '../sim/link'
import { lineMap } from '../sim/lines'
import type { DocTracker } from './editor'
import type { Playground } from './app'

export interface Shown {
    layout: DiagramLayout
    tracker: DocTracker
    chart: string
    result: CompileResult
}

export class DiagramControl {
    view: DiagramView
    shown?: Shown
    readonly outline: Outline
    classes: { sim: ClassMap; cursor: ClassMap; hover: ClassMap; panel: ClassMap; errors: ClassMap } = { sim: {}, cursor: {}, hover: {}, panel: {}, errors: {} }
    /** The next layout fits the stage (a new chart or file). */
    refitNext = true
    private layouts: LayoutService
    private layoutTag = 0
    private wantedLayout = 0
    /** Layout results older than this are not shown (the text has no chart since, or another file is open). */
    private minLayout = 0
    private layoutJobs = new Map<number, Analysed>()
    private busyTimer?: ReturnType<typeof setTimeout>
    private keysOff?: () => void

    constructor(private pg: Playground, existing?: DiagramView) {
        this.view = existing ?? createDiagramView(pg.root, pg.mode)
        this.view.setHandlers({
            onSelect: (id: string) => this.selectElement(id),
            onHover: (id: string | null) => this.hoverElement(id),
        })
        this.layouts = new LayoutService(done => this.onLayout(done), pg.mode === 'embed' ? `pge${Math.random().toString(36).slice(2, 6)}` : 'pg')
        this.outline = new Outline(pg, this)
    }

    /** The trackers the diagram still needs (the rest can go). */
    trackers(): DocTracker[] {
        return [this.shown?.tracker, ...[...this.layoutJobs.values()].map(a => a.tracker)].filter(Boolean) as DocTracker[]
    }

    /** After a compile: draw it (or keep the last good diagram, dimmed), say when there is nothing to draw. */
    update(a: Analysed) {
        const result = a.result
        const broken = isSyntaxBroken(result)
        const source = a.tracker.doc.toString()
        // The diagram on the stage is another chart's: a chart loaded (a link, a file, an example) that has not parsed
        // yet, or a new chart typed over the old one. It goes: the stage waits for this chart to parse.
        const drawn = this.view.svg?.getAttribute('data-chart')
        const names = broken ? chartNames(source) : []
        if (broken && drawn && (!this.pg.parsedSinceLoad || (names.length > 0 && !names.includes(drawn)))) this.drop()
        this.updateCharts(result, names[0])
        const empty = $(this.pg.root, '[data-pg-empty]')
        if (empty) {
            // Nothing to show: no chart yet, or a chart that has never parsed (a shared link with a typo).
            const none = !broken && !result.program?.charts.length
            const neverParsed = broken && !this.view.svg
            empty.hidden = !(none || neverParsed)
            empty.innerHTML = neverParsed
                ? `<span>The diagram appears once ${names[0] ? `<code>${escapeHtml(names[0])}</code>` : 'the chart'} parses.</span>`
                : '<span>There is no <code>scchart</code> to draw yet.</span>'
        }
        if (!broken && result.chart && result.program) this.request(a)
        else if (!broken && !result.program?.charts.length) this.drop()
        else this.setStale(true, broken ? 'Showing the last diagram that parsed' : undefined)
    }

    private request(a: Analysed) {
        const tag = ++this.layoutTag
        this.wantedLayout = tag
        this.layoutJobs.set(tag, a)
        this.layouts.request({ chart: a.result.chart!, program: a.result.program!, tag })
        this.pg.root.dataset.layout = 'busy'
        // A large chart takes a moment: say so if it takes longer than a blink.
        clearTimeout(this.busyTimer)
        this.busyTimer = setTimeout(() => {
            const busy = $(this.pg.root, '[data-pg-busy]')
            if (busy && this.pg.root.dataset.layout === 'busy') busy.hidden = false
        }, 600)
    }

    private onLayout(done: LayoutDone) {
        const pg = this.pg
        const analysed = this.layoutJobs.get(done.tag)
        for (const t of [...this.layoutJobs.keys()]) if (t <= done.tag) this.layoutJobs.delete(t)
        if (done.tag === this.wantedLayout) {
            pg.root.dataset.layout = 'idle'
            clearTimeout(this.busyTimer)
            const busy = $(pg.root, '[data-pg-busy]')
            if (busy) busy.hidden = true
        }
        if (!analysed || done.tag < this.minLayout) return
        if (!done.layout || !done.svg) {
            this.setStale(true, done.error ? `The diagram could not be drawn: ${done.error}` : undefined)
            return
        }
        const chart = done.layout.chart
        const refit = this.refitNext || chart !== this.shown?.chart
        this.refitNext = false
        this.shown = { layout: done.layout, tracker: analysed.tracker, chart, result: analysed.result }
        // Keyboard focus on an element of the old diagram moves to the same element of the new one.
        const focused = this.view.svg?.contains(document.activeElement) ? (document.activeElement as Element).getAttribute('data-id') : null
        this.view.show(done.svg, refit)
        this.enableKeys(focused)
        this.outline.render()
        const name = $(pg.root, '[data-pg-chart-name]')
        if (name && !pg.chartChoice) name.textContent = name.title = chart
        // Up to date unless the text changed since this compile and the newest compile has syntax errors.
        this.setStale(!!pg.latest && isSyntaxBroken(pg.latest.result), 'Showing the last diagram that parsed')
        this.apply()
        this.followCursor()
        pg.pruneTrackers()
    }

    /** Takes the diagram off the stage (no chart, or another chart's); layouts still on their way are for older text. */
    drop() {
        this.keysOff?.()
        this.keysOff = undefined
        this.view.clear()
        this.shown = undefined
        this.minLayout = ++this.layoutTag
        this.setStale(false)
        this.outline.render()
    }

    /** Another file is in the editor: the diagram stays until the new one is drawn, but nothing links to it. */
    forgetSource() {
        this.shown = undefined
        this.minLayout = ++this.layoutTag
        this.refitNext = true
        this.classes.cursor = {}
        this.classes.hover = {}
    }

    setStale(stale: boolean, message?: string) {
        const panel = $(this.pg.root, '[data-pg-diagram]') ?? this.pg.root
        const badge = $(this.pg.root, '[data-pg-badge]')
        const hasDiagram = !!this.view.svg
        panel.classList.toggle('is-stale', stale && hasDiagram)
        if (badge) {
            badge.hidden = !(stale && hasDiagram)
            if (message) badge.textContent = message
        }
    }

    setErrors(errors: ClassMap) {
        this.classes.errors = errors
        this.apply()
    }

    pulse(ids: string[]) {
        if (this.view.svg) pulseTransitions(this.view.svg, ids)
    }

    apply() {
        const c = this.classes
        this.view.setClasses(mergeClasses(c.sim, c.errors, c.cursor, c.panel, c.hover))
        const svg = this.view.svg
        // As the guide's widgets do (link.ts, markDiagram; Sim.svelte): an element with an error gets its "!" marker,
        // and a for-region's states active in several copies get a "×n" badge and their marks per copy.
        markErrors(svg)
        const sim = this.pg.sim
        const view = sim.view
        const tick = view?.tick
        markCopies(svg, tick, tick?.copies ? { prev: view!.cursor > 1 ? view!.history[view!.cursor - 2] : null, counters: copyCounters(sim.analysed?.result) } : {})
        // The elements' accessible names say what the simulation marks ("active", "fired in this tick").
        if (svg?.hasAttribute('data-sc-keys')) refreshNames(svg)
        this.outline.mark(c.sim)
    }

    // ----- The chart picker -----------------------------------------------------------------------------------------

    /** The chart picker (a file with several charts) or the chart's name in the diagram's head; `typed`: the name
     *  of the chart in a text that does not parse. */
    private updateCharts(result: CompileResult, typed?: string) {
        const pg = this.pg
        const select = $<HTMLSelectElement>(pg.root, '[data-pg-chart]')
        const names = result.program?.charts.map(c => c.name).filter(Boolean) ?? []
        const label = $(pg.root, '[data-pg-chart-name]')
        if (label) {
            label.textContent = result.chart?.name ?? this.shown?.chart ?? typed ?? ''
            // A long name ends in an ellipsis on a phone: the whole name is its title.
            label.title = label.textContent
        }
        if (!select) return
        if (names.length < 2) {
            select.hidden = true
            if (label) label.hidden = false
            return
        }
        if ([...select.options].map(o => o.value).join('\n') !== names.join('\n')) select.replaceChildren(...names.map(n => new Option(n, n)))
        if (result.chart?.name) select.value = result.chart.name
        select.hidden = false
        if (label) label.hidden = true
        if (!select.dataset.wired) {
            select.dataset.wired = ''
            select.addEventListener('change', () => {
                pg.chartChoice = select.value
                this.refitNext = true
                pg.runCompile(false)
                pg.sim.force()
            })
        }
    }

    // ----- The diagram from the keyboard -----------------------------------------------------------------------------
    //
    // As in the guide's widgets (enableDiagramKeys): the diagram's states, named regions and transitions are one tab
    // stop after the stage's own (which pans and zooms); the arrow keys move between them in source order, Home and
    // End. Each has an accessible name with the simulation's marks. Focusing one marks it and its source; on
    // /playground Enter selects its source (on a guide page Space and Enter step the simulation, as in the widgets).

    private enableKeys(focus?: string | null) {
        this.keysOff?.()
        this.keysOff = undefined
        const svg = this.view.svg
        const shown = this.shown
        const chart = shown?.result.chart
        if (!svg || !shown || !chart) return
        const map = lineMap(chart, shown.tracker.doc.toString())
        const hint = $(this.pg.root, '[data-pg-diagram-keys]')
        this.keysOff = enableDiagramKeys(svg, map, chart.id, hint?.id || undefined)
        refreshNames(svg)
        const host = svg.parentElement
        if (host && !host.dataset.pgKeys) {
            host.dataset.pgKeys = ''
            const idOf = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-sc-nav]')?.getAttribute('data-id') : null) ?? null
            host.addEventListener('focusin', e => {
                const id = idOf(e)
                if (!id) return
                this.hoverElement(id)
                this.view.reveal(id)
            })
            host.addEventListener('focusout', e => {
                const next = (e as FocusEvent).relatedTarget
                if (!(next instanceof Element) || !next.closest('[data-sc-nav]')) this.hoverElement(null)
            })
            if (this.pg.mode === 'page') {
                host.addEventListener('keydown', e => {
                    const id = idOf(e)
                    if (!id || e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return
                    e.preventDefault()
                    this.selectElement(id)
                })
            }
        }
        if (focus) svg.querySelector<SVGElement>(`[data-sc-nav][data-id="${CSS.escape(focus)}"]`)?.focus()
    }

    // ----- Linked with the source ------------------------------------------------------------------------------------

    followCursor() {
        const shown = this.shown
        if (!shown) return
        const view = this.pg.view
        const at = shown.tracker.toSnapshot(view.state.selection.main.head)
        const map: ClassMap = {}
        if (at !== null && view.hasFocus) {
            const ids = elementsAt(shown.layout, at).filter(id => id !== shown.layout.root.id)
            if (ids[0]) {
                map[ids[0]] = ['is-focus']
                this.view.reveal(ids[0])
            }
        }
        this.classes.cursor = map
        this.apply()
    }

    selectElement(id: string) {
        const shown = this.shown
        if (!shown) return
        const span = spanOf(shown.layout, id) ?? this.lineSpan(id)
        if (!span) return
        // On a phone the editor is in another tab: select there, stay here.
        selectRange(this.pg.view, shown.tracker.fromSnapshot(span.start), shown.tracker.fromSnapshot(span.end), !this.pg.isNarrow())
    }

    /** Declaration and action lines carry their own ids (`Chart$x`, `Chart.S!entry0`); comment boxes and labels
     *  theirs (`<element id>#doc`, `#doc1`, ...): their doc comment. */
    private lineSpan(id: string) {
        const r = this.shown?.result
        if (!r) return undefined
        const doc = id.match(/^(.*)#doc(\d*)$/)
        if (doc) {
            const owner: { annotations: { name: string; span?: { start: number; end: number } }[] } | undefined =
                r.index?.states.get(doc[1]) ?? r.index?.regions.get(doc[1]) ?? [...(r.index?.states.values() ?? [])].flatMap(st => st.transitions).find(t => t.id === doc[1])
            return owner?.annotations.filter(a => a.name === 'comment')[Number(doc[2] || 0)]?.span
        }
        const vo = r.index?.vos.get(id)
        if (vo) return vo.decl?.span ?? vo.vo.span
        const m = id.match(/^(.*)!([a-z]+)(\d+)$/)
        if (m) {
            const state = r.index?.states.get(m[1])
            return state?.actions.filter(a => a.kind === m[2])[Number(m[3])]?.span
        }
        return undefined
    }

    hoverElement(id: string | null) {
        const shown = this.shown
        this.classes.hover = id ? { [id]: ['is-focus'] } : {}
        this.apply()
        const span = shown && id ? (spanOf(shown.layout, id) ?? this.lineSpan(id)) : undefined
        this.pg.setMarks({ focus: span && shown ? { from: shown.tracker.fromSnapshot(span.start), to: shown.tracker.fromSnapshot(span.end) } : undefined })
    }
}

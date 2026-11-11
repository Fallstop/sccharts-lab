// The simulation: the widgets' SimPanel (sim-host.svelte.ts), live until the first step; after that an edit shows
// Rebuild, which replays the recorded inputs on the edited chart when its inputs and outputs are unchanged. Also the
// Guided tour / Free play switch of examples with a scenario (and the tours of a comparison's test run and of a
// shared run), "Copy link to this run", the variables strip and the watch (variables-strip.ts, watch-strip.ts).

import type { ClassMap } from '@sccharts-lab/diagram/highlight'
import type { VariableInfo } from '@sccharts-lab/engine/types'
import { $, MOD, plural, type Analysed, type Origin } from './app-types'
import { setMarks } from './editor'
import { sharedRunTour } from './run-tour'
import { shareRun } from './run-share'
import type { SharedRun } from './share'
import { mountSim, type SimHost, type SimView } from './sim-host.svelte'
import { tourOf } from './sources'
import { VariablesStrip } from './variables-strip'
import { WatchStrip } from './watch-strip'
import type { Scenario } from '../frame/examples'
import type { Playground } from './app'

/** What the panel's tour is: the example's guided tour, the model solution's test run (Compare), or a shared run.
 *  The switch in the panel's head says what the panel says ("Test run, tick 3 of 7"). */
type TourKind = 'tour' | 'test' | 'shared'
const TOUR_NAMES: Record<TourKind, string> = { tour: 'Guided tour', test: 'Test run', shared: 'Shared run' }
const TOUR_TITLES: Record<TourKind, string> = {
    tour: "Step through the example's scripted inputs, with notes",
    test: "Step through the inputs of the model solution's test run",
    shared: 'Step through the inputs of the shared run',
}

/** A chart with errors reaches a simulation that has not started only after a pause in typing. */
const ERROR_DELAY = 1200

function sameInterface(a: VariableInfo[], b: VariableInfo[]): boolean {
    const key = (v: VariableInfo) => [v.name, v.type, v.signal, v.valued, v.input, v.output, v.const, v.dims.join('x')].join(':')
    const ka = a.filter(v => v.input || v.output).map(key).sort().join('|')
    const kb = b.filter(v => v.input || v.output).map(key).sort().join('|')
    return ka === kb
}

export class SimControl {
    host: SimHost | null = null
    /** What the panel simulates. */
    analysed?: Analysed
    view?: SimView
    /** The source changed since the run started (Rebuild). */
    stale = false
    /** Whether the chart in the panel compiles (the panel shows controls) or not (it shows the errors). */
    ok = false
    readonly vars: VariablesStrip
    readonly watch: WatchStrip
    private generation = 0
    private ready: Promise<void> | null = null
    private errorTimer?: ReturnType<typeof setTimeout>
    /** The loaded example's guided tour, if it has one; the panel is mounted with it. */
    private tour?: Scenario
    /** What the loaded chart's tour was (Revert brings it back). */
    originTour?: Scenario
    /** Whether the panel starts in the tour (else in free play, the tour one click away). */
    wantTour = false
    /** The panel's tour is in control (SimPanel's SimView.tour). */
    tourActive = false
    /** The panel replays other inputs than the example's tour: the comparison's test run, or a shared run. */
    private replay?: { scenario: Scenario; ticks: number; kind: 'test' | 'shared' }
    /** A shared run waiting for the chart to compile (its notes need the chart's inputs). */
    private sharedRun?: SharedRun
    private runAnnounced = false

    constructor(private pg: Playground) {
        this.vars = new VariablesStrip(pg, this)
        this.watch = new WatchStrip(pg, this)
        $(pg.root, '[data-action="rebuild"]')?.addEventListener('click', () => this.rebuild())
        $(pg.root, '[data-pg-mode]')?.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('button[data-mode]')
            if (b) this.setMode(b.dataset.mode === 'tour' ? 'tour' : 'free')
        })
    }

    /** Resolves once the panel is mounted. */
    whenReady(): Promise<void> {
        return this.ready ?? Promise.resolve()
    }

    get started() {
        return (this.view?.cursor ?? 0) > 0
    }

    /** Steps one tick (Ctrl/⌘+Enter), showing the simulation if another tab of the panel is shown. */
    step() {
        if (this.pg.panel && this.pg.panel.current !== 'sim') this.pg.panel.show('sim')
        this.host?.step()
    }

    // ----- Guided tour and free play ---------------------------------------------------------------------------------
    //
    // An example with a scenario offers its guided tour (SimPanel's `scenario`): the panel is always mounted with it,
    // and starts in free play for the showcase charts and exercise starters, in the tour for the guide's other
    // examples. The switch in the panel's head follows the panel (Take over and "Restart the guided tour" count too).

    setTour(scenario: Scenario | undefined, origin: Origin) {
        this.tour = tourOf(scenario)
        this.originTour = this.tour
        this.replay = undefined
        this.sharedRun = undefined
        const showcase = !!origin.id?.startsWith('showcase/')
        this.wantTour = !!this.tour && origin.kind === 'example' && !showcase && !origin.starter && !this.pg.exercise?.solution
        this.tourActive = this.wantTour
        this.updateModeSwitch()
    }

    setMode(mode: 'tour' | 'free') {
        const tours = this.toursFor(this.analysed?.file ?? this.pg.project.active)
        if (!(tours.tour || tours.replay)) return
        this.wantTour = mode === 'tour'
        // Not mounted yet: the panel starts in this mode.
        if (!this.host) return
        // A run of an older text: the tour (and free play) start on the chart as it is now.
        const latest = this.pg.latest
        if (this.stale && latest?.result.ok) {
            this.push(latest, 'reset')
            this.stale = false
            this.updateHead()
        }
        if (mode === 'tour') this.host.restartTour()
        else this.host.takeOver()
    }

    /** A shared run (a `&run=` link): the panel replays its inputs as a tour, from the tick that was shown. */
    setSharedRun(run: SharedRun) {
        this.sharedRun = run
        this.runAnnounced = false
        this.wantTour = true
        this.tourActive = true
    }

    /** The comparison's test run, as a tour, shown at `ticks`. */
    replayTest(scenario: Scenario, ticks: number) {
        this.replay = { scenario, ticks, kind: 'test' }
        this.sharedRun = undefined
        this.wantTour = true
        this.force()
    }

    private get tourKind(): TourKind {
        return this.replay?.kind ?? (this.sharedRun ? 'shared' : 'tour')
    }

    /** The tours belong to the project's main file (the example, the file a run was shared from). */
    private toursFor(file: string | undefined) {
        const main = file === this.pg.project.mainFile
        return { tour: main ? this.tour : undefined, replay: main ? this.replay : undefined }
    }

    updateModeSwitch() {
        const box = $(this.pg.root, '[data-pg-mode]')
        if (!box) return
        const { tour, replay } = this.toursFor(this.analysed?.file)
        box.hidden = !(tour || replay) || !this.ok
        const tourButton = box.querySelector<HTMLButtonElement>('[data-mode="tour"]')
        if (tourButton) {
            tourButton.textContent = TOUR_NAMES[this.tourKind]
            tourButton.title = TOUR_TITLES[this.tourKind]
        }
        for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-mode]')) b.setAttribute('aria-pressed', String((b.dataset.mode === 'tour') === this.tourActive))
    }

    // ----- Mounting and following the text ---------------------------------------------------------------------------

    /** A fresh panel for a chart (also when a chart becomes runnable or stops being so before the first step: the
     *  panel's controls and its error list are different blocks). */
    mount(a: Analysed): Promise<void> {
        const pg = this.pg
        const target = $(pg.root, '[data-pg-sim]')
        if (!target) return Promise.resolve()
        this.host?.destroy()
        this.host = null
        this.view = undefined
        pg.model.simView = undefined
        pg.diagram.classes.sim = {}
        target.replaceChildren()
        this.analysed = a
        this.ok = a.result.ok
        pg.model.simulation = { file: a.file, source: a.tracker.doc.toString(), result: a.result }
        // A shared run's notes say which inputs changed: they need the chart's inputs.
        if (this.sharedRun && !this.replay && a.result.ok && a.file === pg.project.mainFile) {
            this.replay = { scenario: sharedRunTour(this.sharedRun, a.result.interface), ticks: this.sharedRun.at, kind: 'shared' }
        }
        const kind = this.tourKind
        const { tour, replay } = this.toursFor(a.file)
        this.vars.setChoices(a.result)
        // A second mount before the first has reported back (two loads in a row) replaces it.
        const generation = ++this.generation
        this.ready = mountSim(target, a.result, a.tracker.doc.toString(), {
            onhighlight: (classes, view) => this.onHighlight(classes, view),
            onfire: ids => pg.diagram.pulse(ids),
            onfocus: ids => {
                pg.diagram.classes.panel = Object.fromEntries(ids.map(id => [id, ['is-focus']]))
                pg.diagram.apply()
            },
        }, {
            keys: pg.mode === 'page' ? $(pg.root, '[data-pg-sim-panel]') : (pg.root.closest('[data-sc-frame]') as HTMLElement | null),
            variant: 'full',
            label: 'Simulation',
            id: pg.mode === 'embed' ? `pge-sim-${Math.random().toString(36).slice(2, 7)}` : 'pg-sim',
            scenario: replay?.scenario ?? tour,
            initialTicks: replay?.ticks ?? 0,
            tourName: TOUR_NAMES[kind],
            intro: kind === 'test'
                ? "These are the inputs of the model solution's test run. Press **Next** to run tick 1."
                : kind === 'shared' && replay
                  ? `These are the inputs of a shared run (${plural(replay.scenario.ticks.length, 'tick')}). Press **Next** to run tick 1, or **Take over** to set the inputs yourself.`
                  : undefined,
            show: this.vars.show,
            verdict: pg.problems.verdictFor(a),
        }).then(host => {
            if (generation !== this.generation) {
                host?.destroy()
                return
            }
            this.host = host
            // Free play: the tour stays one click away ("Guided tour", or "Restart the guided tour" in the panel).
            if (host && tour && !replay && !this.wantTour) host.takeOver()
            pg.workspace?.observeSim()
            this.updateModeSwitch()
            if (host && replay?.kind === 'shared' && !this.runAnnounced) this.announceRun(replay)
        })
        return this.ready
    }

    private onHighlight(classes: ClassMap, view: SimView) {
        const pg = this.pg
        this.view = view
        // A fresh object each time: SimPanel reports the same one, its history grown in place.
        pg.model.simView = { ...view, history: view.history.slice() }
        if (view.tour !== this.tourActive) {
            this.tourActive = view.tour
            this.updateModeSwitch()
        }
        pg.diagram.classes.sim = classes
        pg.diagram.apply()
        // The lines of the active states and fired transitions, in the editor (when it shows the simulated file).
        const t = this.analysed?.tracker
        const doc = t?.doc
        const here = this.analysed?.file === pg.project.active
        const toOffsets = (lines: number[]) => (!doc || !t || !here ? [] : lines.filter(n => n >= 1 && n <= doc.lines).map(n => t.fromSnapshot(doc.line(n).from)))
        pg.marks.active = toOffsets(view.lines?.active ?? [])
        pg.marks.taken = toOffsets(view.lines?.taken ?? [])
        setMarks(pg.view, pg.marks)
        this.updateHead()
        this.watch.render()
    }

    /** The values of the tick shown, for the editor's hover cards. */
    values(): Record<string, unknown> | undefined {
        const tick = this.view?.tick
        if (!tick || this.stale || this.analysed?.file !== this.pg.project.active) return undefined
        return { ...tick.values, ...Object.fromEntries(Object.entries(tick.present ?? {}).filter(([k]) => !(k in tick.values))) }
    }

    /** After a compile: a panel that has not started follows the text (a chart with errors after a pause); one that
     *  has started keeps its run and offers Rebuild. */
    follow(a: Analysed, initial: boolean) {
        clearTimeout(this.errorTimer)
        if (!this.ready) {
            if (a.result.program || initial) void this.mount(a)
            return
        }
        if (this.started) {
            // The reader is in the middle of a run: never pull the chart from under them.
            // Another file in the editor, an edit, or an edit of a file it imports.
            this.stale = this.analysed?.file !== a.file || (this.analysed?.tracker.changed ?? true) || this.analysed.deps !== a.deps
            this.updateHead()
            return
        }
        const push = () => {
            this.stale = false
            if (a.result.ok !== this.ok || a.file !== this.analysed?.file) {
                void this.mount(a).then(() => this.updateHead())
                return
            }
            this.push(a, 'reset')
            this.updateHead()
        }
        if (a.result.ok) push()
        else this.errorTimer = setTimeout(push, ERROR_DELAY)
    }

    /** The panel simulates `a` from now on (with the variables chosen for its chart, and its verdict). */
    private push(a: Analysed, mode: 'reset' | 'replay') {
        const pg = this.pg
        this.analysed = a
        pg.model.simulation = { file: a.file, source: a.tracker.doc.toString(), result: a.result }
        this.vars.setChoices(a.result)
        this.host?.setShow(this.vars.show)
        this.host?.setVerdict(pg.problems.verdictFor(a))
        this.host?.setCompiled(a.result, a.tracker.doc.toString(), mode)
    }

    updateVerdict() {
        this.host?.setVerdict(this.pg.problems.verdictFor(this.analysed))
    }

    /** A new chart was loaded (or another chart or file chosen): a fresh simulation of it. */
    force() {
        const a = this.pg.latest
        if (!a) return
        clearTimeout(this.errorTimer)
        this.stale = false
        void this.mount(a).then(() => this.updateHead())
    }

    rebuild() {
        const pg = this.pg
        const a = pg.latest
        if (!a || !this.host || !this.stale) return
        if (!a.result.ok) {
            pg.toast('Fix the errors first: the edited chart does not compile.')
            return
        }
        const keep = !!this.analysed && sameInterface(this.analysed.result.interface, a.result.interface) && this.started
        if (a.file !== this.analysed?.file) {
            this.force()
            pg.toast(`Rebuilt. The simulation runs ${a.file} now.`)
            return
        }
        this.push(a, keep ? 'replay' : 'reset')
        this.stale = false
        this.updateHead()
        pg.toast(keep ? 'Rebuilt. The recorded inputs were replayed on the edited chart.' : 'Rebuilt. The inputs or outputs changed, so the simulation starts again.')
    }

    updateHead() {
        const pg = this.pg
        const btn = $<HTMLButtonElement>(pg.root, '[data-action="rebuild"]')
        const note = $(pg.root, '[data-pg-sim-note]')
        const stale = this.stale && this.started
        pg.root.classList.toggle('is-sim-stale', stale)
        if (btn) {
            btn.hidden = !stale
            const ok = !!pg.latest?.result.ok
            btn.setAttribute('aria-disabled', String(!ok))
            const other = !!this.analysed && this.analysed.file !== pg.project.active
            btn.title = !ok ? 'The edited chart has errors; fix them to rebuild' : other ? `Simulate ${pg.project.active} instead (${MOD}+Shift+Enter)` : `Compile the edited chart and continue (${MOD}+Shift+Enter)`
        }
        if (note) {
            note.hidden = !stale
            const other = this.analysed && this.analysed.file !== pg.project.active
            note.textContent = !stale ? '' : other ? `This run is of ${this.analysed!.file}.` : 'The source changed since this simulation started.'
        }
        const bar = $(pg.root, '[data-pg-simbar]')
        if (bar) bar.hidden = !stale
        // "Copy link to this run" needs a tick to share.
        const run = $<HTMLButtonElement>(pg.root, '[data-action="share-run"]')
        if (run) {
            const ticks = this.view?.history.length ?? 0
            // Nothing to run while the chart is rejected: the tools go (the panel lists the problems instead).
            run.hidden = !this.ok
            run.setAttribute('aria-disabled', String(!ticks || !this.ok))
            run.title = ticks ? `Copy a link that replays ${ticks === 1 ? 'this tick' : `these ${ticks} ticks`}` : 'Run the chart first: the link replays the ticks you run'
        }
        $(pg.root, '[data-pg-vars-toggle]')?.toggleAttribute('hidden', !this.ok)
        if (!this.ok) this.vars.toggle(false)
    }

    /** "Copy link to this run" (run-share.ts). */
    shareRun() {
        return shareRun(this.pg)
    }

    /** Says that the page replays a shared run, with Take over. */
    private announceRun(replay: { scenario: Scenario; ticks: number }) {
        this.runAnnounced = true
        const n = replay.scenario.ticks.length
        this.pg.toast(`This link replays a run of ${plural(n, 'tick')}${replay.ticks < n ? `, shown at tick ${replay.ticks}` : ''}. Step through it with Previous and Next.`, {
            label: 'Take over',
            run: () => this.setMode('free'),
        })
    }
}

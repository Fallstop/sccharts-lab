// The playground controller: ties the editor, the compiler, the live diagram and the simulation together, for
// the /playground page and for the inline <Playground> on guide pages. Loaded lazily by boot.ts once the page has
// painted (CodeMirror, the engine and ELK's client are in this chunk's imports; ELK itself runs in a worker).
//
//   edit ──debounce──► compile ──► diagnostics (squiggles, problems list, is-error in the diagram)
//                          │
//                          ├──► layout (worker, latest wins) ──► diagram (kept, dimmed, while the source has
//                          │                                      syntax errors)
//                          └──► simulation: live until the first step; after that "Rebuild" (the trace is
//                               replayed when the interface is unchanged)
//
// Offsets: every compile, layout and simulation keeps a DocTracker, so a click in a diagram that is a few
// keystrokes old still selects the right text.
//
// Also here: the simulation panel's height (it fits its timing diagram), the guided tour / free play switch of
// examples with a scenario, "Compare with the model solution" for exercises (compare.ts), the variables the timing
// diagram traces (variables.ts), "Copy link to this run" and its replay (share.ts, run-tour.ts), KIELER's words in
// the problems list (recorded.ts), and the diagram for the keyboard and screen readers (its elements, as in the
// widgets, and the outline). README.md describes each.

import type { ViewUpdate } from '@codemirror/view'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { compile, type CompileResult } from '../../engine/index'
import type { State, VariableInfo } from '../../engine/types'
import { elementsAt, mergeClasses, spanOf, type ClassMap } from '../../diagram/highlight'
import type { DiagramLayout, RegionLayout, StateLayout, TransitionLayout } from '../../diagram/types'
import { DiagramView, createDiagramView } from './diagram-view'
import { DocTracker, createEditor, replaceText, selectRange, setMarks, showDiagnostics, type Marks } from './editor'
import { applySuggestion, problemLink, renderDiagnostic, suggestionOf, toLintDiagnostics, type AnalysisView } from './editor-features'
import { LayoutService, type LayoutDone } from './layout-service'
import { fileNameFor, hashForSource, makeRun, runUrl, SCRATCH_KEY, shareUrl, storageGet, storageSet, type SharedRun } from './share'
import { mountSim, type SimHost, type SimView, type Verdict } from './sim-host.svelte'
import { copyCounters, enableDiagramKeys, markCopies, markErrors, pulseTransitions, refreshNames } from '../sim/link'
import { lineMap } from '../sim/lines'
import { loadExampleSource, loadImports, loadRecording, loadScenario, tourOf, type Recording } from './sources'
import { withRecording, type Problem } from './recorded'
import { runInputs, sharedRunTour } from './run-tour'
import { GROUP_TITLES, defaultShow, loadChoice, resolveShow, saveChoice, variableChoices, type VarChoice, type VarGroup } from './variables'
import { chartNames, firstChartName } from './catalogue'
import { pgIcons } from './icons'
import { showTab } from './tabs'
import { compareWithSolution, summary, type Comparison } from './compare'
import { highlightLines } from './static-highlight'
import { exerciseFor, type Exercise } from './exercises'
import { compileWatch, holds, type Watch, type WatchTick } from './watch'
import { inlineMd } from '../frame/inline-md'
import type { Scenario } from '../frame/examples'

export interface Origin {
    kind: 'example' | 'shared' | 'scratch' | 'default' | 'file' | 'new'
    /** Example id. */
    id?: string
    /** What the toolbar calls it. */
    title: string
    /** The guide page the example comes from. */
    page?: { title: string; href?: string }
    /** The starter chart of an exercise. */
    starter?: boolean
}

export interface PlaygroundInit {
    root: HTMLElement
    mode: 'page' | 'embed'
    source: string
    origin: Origin
    /** Lookup of example titles for the menu (page mode). */
    describe?: (id: string) => Origin | undefined
    /** The diagram stage, if boot.ts already made it (it shows the build-time diagram, fitted, before the app loads). */
    diagram?: DiagramView
    /** The example's scenario (its guided tour). */
    scenario?: Scenario
    /** An exercise's model solution (`&solution=<id>`): offers "Compare with the model solution". */
    solution?: string
    /** A shared run (`&run=`): replayed as a tour through it. */
    run?: SharedRun
    /** The chart of the file to show and simulate (`&chart=` of a shared run), when not the first. */
    chart?: string
}

/** A chart that a link opens (boot.ts reads it from the address): its source and origin, the example's tour, a
 *  shared run of it (and the chart of the file it ran), and an exercise's model solution. */
export interface LinkTarget {
    source: string
    origin: Origin
    scenario?: Scenario
    run?: SharedRun
    chart?: string
    solution?: string
}

/** What the panel's tour is: the example's guided tour, the model solution's test run (Compare), or a shared run.
 *  The switch in the panel's head says what the panel says ("Test run, tick 3 of 7"): the name is passed as
 *  SimPanel's `tourName`, and the switch's title and the panel's intro say what the tour replays. */
type TourKind = 'tour' | 'test' | 'shared'
const TOUR_NAMES: Record<TourKind, string> = { tour: 'Guided tour', test: 'Test run', shared: 'Shared run' }
const TOUR_TITLES: Record<TourKind, string> = {
    tour: "Step through the example's scripted inputs, with notes",
    test: "Step through the inputs of the model solution's test run",
    shared: 'Step through the inputs of the shared run',
}

const COMPILE_DELAY = 180
const SAVE_DELAY = 400
/** A chart with errors reaches a simulation that has not started only after a pause in typing. */
const SIM_ERROR_DELAY = 1200
/** How long an inline editor focused without a pointer lets Tab move on, unless the reader presses another key first. */
const TAB_THROUGH_MS = 10 * 60_000

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD = isMac ? '⌘' : 'Ctrl'

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T & Element>(sel) as T | null

const isSyntaxBroken = (r: CompileResult) => !r.program || r.diagnostics.some(d => d.severity === 'error' && (d.code === 'parse' || d.code === 'missing-semicolon' || d.code === 'internal'))

function sameInterface(a: VariableInfo[], b: VariableInfo[]): boolean {
    const key = (v: VariableInfo) => [v.name, v.type, v.signal, v.valued, v.input, v.output, v.const, v.dims.join('x')].join(':')
    const ka = a.filter(v => v.input || v.output).map(key).sort().join('|')
    const kb = b.filter(v => v.input || v.output).map(key).sort().join('|')
    return ka === kb
}

/** How the outline says what the simulation marks (the words of the widgets' diagrams, src/components/sim/link.ts). */
const OUTLINE_STATUS: [string, string][] = [
    ['is-error', 'has an error'],
    ['is-active', 'active'],
    ['is-entered', 'entered in this tick'],
    ['is-exited', 'left in this tick'],
    ['is-taken', 'fired in this tick'],
]

function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function plural(n: number, word: string) {
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

interface Analysed {
    result: CompileResult
    tracker: DocTracker
}

export class Playground {
    readonly root: HTMLElement
    readonly mode: 'page' | 'embed'
    view!: EditorView
    private diagram!: DiagramView
    private layouts!: LayoutService
    private trackers = new Set<DocTracker>()
    private latest?: Analysed
    private good?: Analysed
    private shown?: { layout: DiagramLayout; tracker: DocTracker; chart: string; result: CompileResult }
    private layoutTag = 0
    private wantedLayout = 0
    private chartChoice?: string
    private compileTimer?: ReturnType<typeof setTimeout>
    private saveTimer?: ReturnType<typeof setTimeout>
    private simErrorTimer?: ReturnType<typeof setTimeout>
    private sim: SimHost | null = null
    private simGeneration = 0
    private simReady: Promise<void> | null = null
    private simAnalysed?: Analysed
    private simView?: SimView
    private simStale = false
    /** Whether the chart in the simulation panel compiles (the panel shows controls) or not (it shows the errors). */
    private simOk = false
    private classes: { sim: ClassMap; cursor: ClassMap; hover: ClassMap; panel: ClassMap; errors: ClassMap } = { sim: {}, cursor: {}, hover: {}, panel: {}, errors: {} }
    private marks: Marks = {}
    private origin: Origin
    private loadedText: string
    private problems: Problem[] = []
    private problemsOpen = false
    private toastTimer?: ReturnType<typeof setTimeout>
    private describe?: (id: string) => Origin | undefined
    private refitNext = true
    /** The loaded example's guided tour, if it has one; the panel is mounted with it. */
    private tour?: Scenario
    /** What the loaded chart's tour was (Revert brings it back). */
    private originTour?: Scenario
    /** Whether the panel starts in the tour (else in free play, the tour one click away). */
    private wantTour = false
    /** The panel's tour is in control (SimPanel's SimView.tour). */
    private tourActive = false
    /** The model solution of the exercise, if the playground was opened with &solution=. */
    private solution?: { id: string; scenario: Scenario; recording: Recording; source?: string; reveal: boolean }
    /** The exercise of a TryIt link (its task banner); `starter`: the starter's source, and whether it already
     *  behaves as the model solution on its test run (an exercise that asks for a new structure, not new behaviour). */
    private exercise?: { ex: Exercise; starter?: string; starterMatches?: boolean }
    /** The panel replays other inputs than the example's tour: the comparison's test run, or a shared run. */
    private replay?: { scenario: Scenario; ticks: number; kind: 'test' | 'shared' }
    /** A shared run waiting for the chart to compile (its notes need the chart's inputs). */
    private sharedRun?: SharedRun
    /** The shared run has been announced (the toast with Take over). */
    private runAnnounced = false
    /** KIELER's recording of the open example: its diagnostics are paired with the engine's while the text is as
     *  recorded, and the panel's verdict is 'recorded'. */
    private recording?: { id: string; text: string; rec: Recording }
    /** The variables the timing diagram traces, and the choices they come from (the simulated chart's). */
    private simChoices: VarChoice[] = []
    /** How many of the chart's variables the panel cannot trace yet (not offered). */
    private simUntraceable = 0
    private simShow?: string[]
    private keysOff?: () => void
    /** The files the open example imports (`import "push-switch"`), passed to every compile; empty for other charts. */
    private files: Record<string, string> = {}
    /** The text has parsed since the chart was loaded (until then a diagram on the stage is the previous chart's). */
    private parsedSinceLoad = false

    constructor(init: PlaygroundInit) {
        this.root = init.root
        this.mode = init.mode
        this.origin = init.origin
        this.loadedText = init.source
        this.describe = init.describe
        this.root.dataset.pgReady = ''
        this.setTour(init.scenario, init.origin)
        if (init.run) this.setSharedRun(init.run)
        if (init.chart) this.chartChoice = init.chart
        this.setupEditor(init.source)
        this.setupDiagram(init.diagram)
        this.setupProblems()
        this.setupSim()
        this.setupActions()
        if (this.mode === 'page') {
            this.root.addEventListener('sc-pg-tab', e => {
                if ((e as CustomEvent).detail.tab === 'code') requestAnimationFrame(() => this.view.requestMeasure())
            })
            this.setupSplitter()
            this.setupDrop()
            this.setupGlobalKeys()
        }
        this.updateTitle()
        this.runCompile(true)
        void this.fetchImports(init.source, init.scenario)
        void this.fetchRecording()
        if (init.solution && this.mode === 'page') {
            this.showTask(init.solution)
            void this.setupSolution(init.solution)
        }
        // A handle for tests and for poking around in the console.
        ;(this.root as HTMLElement & { playground?: Playground }).playground = this
    }

    /** Resolves once the simulation panel is mounted (the inline playground then replays a click held before). */
    simulationReady(): Promise<void> {
        return this.simReady ?? Promise.resolve()
    }

    /** The example that is open (for the menu's current item). */
    get currentExample(): string | undefined {
        return this.origin.kind === 'example' || this.origin.kind === 'default' ? this.origin.id : undefined
    }

    // ----- Editor ------------------------------------------------------------------------------------------------

    private setupEditor(source: string) {
        const host = $(this.root, '[data-pg-editor]')!
        host.replaceChildren()
        const keys: KeyBinding[] = [
            { key: 'Mod-Enter', run: () => (this.sim?.step(), true), preventDefault: true },
            { key: 'Mod-Shift-Enter', run: () => (this.rebuild(), true), preventDefault: true },
        ]
        if (this.mode === 'page') {
            keys.push(
                { key: 'Mod-s', run: () => (this.download(), true), preventDefault: true },
                { key: 'Mod-o', run: () => (this.openFile(), true), preventDefault: true },
                { key: 'Mod-Shift-s', run: () => (void this.share(), true), preventDefault: true },
            )
        }
        this.view = createEditor(host, {
            doc: source,
            analysis: () => this.analysisView(),
            values: () => this.simValues(),
            onUpdate: u => this.onEditorUpdate(u),
            keys,
            label: 'SCTX source',
            compact: this.mode === 'embed',
        })
        if (this.mode === 'embed') {
            // In a page, a reader tabbing past the chart must not end up indenting it: when the editor gets the focus
            // other than by a pointer (Tab, or the build-time code's focus handed over when the app starts), Tab and
            // Shift+Tab move on, as everywhere else on the page, until the reader presses another key or clicks into the
            // code (CodeMirror's tab-focus mode). /playground keeps the editor's own Tab, with Escape then Tab to leave
            // (its help says so).
            const content = this.view.contentDOM
            let pointer = false
            let passing = false
            const passTab = (on: boolean) => {
                this.view.setTabFocusMode(on ? TAB_THROUGH_MS : false)
                passing = on
            }
            content.addEventListener('pointerdown', () => {
                pointer = true
                if (passing) passTab(false)
            }, { capture: true })
            content.addEventListener('focus', () => {
                if (!pointer) passTab(true)
                pointer = false
            })
            if (document.activeElement === content) passTab(true)
        }
    }

    private track(t: DocTracker): DocTracker {
        this.trackers.add(t)
        return t
    }

    /** Drops trackers nothing refers to any more. */
    private pruneTrackers() {
        const live = new Set([this.latest?.tracker, this.good?.tracker, this.shown?.tracker, this.simAnalysed?.tracker, ...[...this.layoutJobs.values()].map(a => a.tracker)].filter(Boolean) as DocTracker[])
        for (const t of this.trackers) if (!live.has(t)) this.trackers.delete(t)
    }

    private onEditorUpdate(u: ViewUpdate) {
        if (u.docChanged) {
            for (const t of this.trackers) t.add(u.changes)
            clearTimeout(this.compileTimer)
            this.compileTimer = setTimeout(() => this.runCompile(false), COMPILE_DELAY)
            // The reader's edits are saved (the scratch buffer) and put in the URL; loading a chart keeps its own URL
            // (?example=...) and leaves the scratch buffer to the reader's last edits.
            if (!u.transactions.some(tr => tr.isUserEvent('input.load'))) this.scheduleSave()
            this.updateTitle()
        }
        if (u.selectionSet || u.docChanged) {
            this.updateCursor()
            this.followCursor()
        }
    }

    private analysisView(): AnalysisView | undefined {
        // Completion and hover read the newest model that parsed (a half-typed transition does not parse).
        const a = this.latest && !isSyntaxBroken(this.latest.result) ? this.latest : this.good
        if (!a) return undefined
        const tracker = a.tracker
        return {
            result: a.result,
            toSource: (pos, exact) => tracker.toSnapshot(pos, exact),
            fromSource: pos => tracker.fromSnapshot(pos),
            lineOf: pos => this.view.state.doc.lineAt(Math.min(tracker.fromSnapshot(pos), this.view.state.doc.length)).number,
        }
    }

    private updateCursor() {
        const out = $(this.root, '[data-pg-cursor]')
        if (!out) return
        const head = this.view.state.selection.main.head
        const line = this.view.state.doc.lineAt(head)
        out.textContent = `Line ${line.number}, column ${head - line.from + 1}`
    }

    // ----- Compile -----------------------------------------------------------------------------------------------

    private runCompile(initial: boolean) {
        clearTimeout(this.compileTimer)
        const doc = this.view.state.doc
        const source = doc.toString()
        const files = this.files
        let result = compile(source, { files })
        if (this.chartChoice && this.chartChoice !== result.chart?.name && result.program?.charts.some(c => c.name === this.chartChoice)) {
            result = compile(source, { chart: this.chartChoice, files })
        }
        const analysed: Analysed = { result, tracker: this.track(new DocTracker(doc)) }
        this.latest = analysed
        const broken = isSyntaxBroken(result)
        if (!broken) {
            this.good = analysed
            this.parsedSinceLoad = true
        }
        // The diagram on the stage is another chart's: a chart loaded (a link, a file, an example) that has not parsed
        // yet, or a new chart typed over the old one. It goes: the stage waits for this chart to parse.
        const drawn = this.diagram.svg?.getAttribute('data-chart')
        const names = broken ? chartNames(source) : []
        if (broken && drawn && (!this.parsedSinceLoad || (names.length > 0 && !names.includes(drawn)))) this.dropDiagram()
        this.showProblems(result)
        this.updateCharts(result, names[0])
        const empty = $(this.root, '[data-pg-empty]')
        if (empty) {
            // Nothing to show: no chart yet, or a chart that has never parsed (a shared link with a typo).
            const none = !broken && !result.program?.charts.length
            const neverParsed = broken && !this.diagram.svg
            empty.hidden = !(none || neverParsed)
            empty.innerHTML = neverParsed
                ? `<span>The diagram appears once ${names[0] ? `<code>${escapeHtml(names[0])}</code>` : 'the chart'} parses.</span>`
                : '<span>There is no <code>scchart</code> to draw yet.</span>'
        }
        if (!broken && result.chart && result.program) {
            this.requestLayout(analysed)
        } else if (!broken && !result.program?.charts.length) {
            // Nothing to draw: no chart in the file.
            this.dropDiagram()
        } else {
            this.setStale(true, broken ? 'Showing the last diagram that parsed' : undefined)
        }
        this.updateSim(analysed, initial)
        if ($<HTMLDetailsElement>(this.root, '[data-pg-compare]')?.open) this.renderComparison()
        this.pruneTrackers()
    }

    private showProblems(result: CompileResult) {
        const tracker = this.latest!.tracker
        this.problems = this.withKieler(result, tracker.doc.toString())
        showDiagnostics(this.view, toLintDiagnostics(this.problems, { fromSource: p => tracker.fromSnapshot(p) }, this.view.state.doc.length))
        const errors: ClassMap = {}
        for (const d of result.diagnostics) if (d.severity === 'error') for (const id of d.related ?? []) errors[id] = ['is-error']
        this.classes.errors = errors
        this.applyClasses()
        this.renderProblems()
    }

    /** The problems of a compile: the engine's, and for an example opened as it is, paired with what KIELER's
     *  recording of it says (KIELER's own wording, and what only KIELER reports). */
    private withKieler(result: CompileResult, text: string): Problem[] {
        const r = this.recording
        return r && text === r.text && this.recordingApplies(result) ? withRecording(result.diagnostics, r.rec, text) : result.diagnostics
    }

    /** The recording is of the chart shown: the file's first (KIELER simulates rootStates.head). */
    private recordingApplies(result: CompileResult) {
        return !this.chartChoice || this.chartChoice === result.program?.charts[0]?.name
    }

    /** Loads KIELER's recording of the open example (its diagnostics and the verdict depend on it). */
    private async fetchRecording() {
        const origin = this.origin
        const id = origin.kind === 'example' || origin.kind === 'default' ? origin.id : undefined
        const text = this.loadedText
        this.recording = undefined
        if (!id) return
        const rec = await loadRecording(id)
        if (this.origin !== origin || !rec) return
        this.recording = { id, text, rec }
        if (this.latest) this.showProblems(this.latest.result)
        this.updateVerdict()
    }

    /** SimPanel's verdict: 'recorded' for an example as written, whose recording agrees with what the panel shows
     *  (so "KIELER rejects this chart" is KIELER's word); 'engine' for everything else (the reader's charts and
     *  edits: only the guide's checker has seen them). */
    private verdictFor(a: Analysed | undefined): Verdict {
        const r = this.recording
        return r && a && a.tracker.doc.toString() === r.text && this.recordingApplies(a.result) && r.rec.ok === a.result.ok ? 'recorded' : 'engine'
    }

    private updateVerdict() {
        this.sim?.setVerdict(this.verdictFor(this.simAnalysed))
    }

    // ----- Problems list -----------------------------------------------------------------------------------------

    private setupProblems() {
        const toggle = $(this.root, '[data-pg-problems-toggle]')
        toggle?.addEventListener('click', () => {
            if (!this.problems.length) return
            this.problemsOpen = !this.problemsOpen
            this.renderProblems()
        })
    }

    private renderProblems() {
        const box = $(this.root, '[data-pg-problems]')
        if (!box) return
        const toggle = $(box, '[data-pg-problems-toggle]')!
        const list = $(box, '[data-pg-problems-list]')!
        const errors = this.problems.filter(d => d.severity === 'error').length
        const warnings = this.problems.filter(d => d.severity === 'warning').length
        const infos = this.problems.length - errors - warnings
        box.dataset.state = errors ? 'error' : warnings ? 'warning' : this.problems.length ? 'info' : 'ok'
        const summary = $(toggle, '[data-pg-problems-summary]')!
        const first = this.problems[0]
        if (!this.problems.length) {
            summary.textContent = 'No problems'
            toggle.setAttribute('aria-disabled', 'true')
            this.problemsOpen = false
        } else {
            const counts = [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning'), infos && plural(infos, 'note')].filter(Boolean).join(', ')
            const line = first.span ? this.view.state.doc.lineAt(Math.min(this.latest!.tracker.fromSnapshot(first.span.start), this.view.state.doc.length)).number : undefined
            summary.replaceChildren(
                Object.assign(document.createElement('b'), { textContent: counts }),
                document.createTextNode(this.problemsOpen ? '' : `: ${line ? `line ${line}, ` : ''}${first.message}`),
            )
            toggle.removeAttribute('aria-disabled')
        }
        toggle.setAttribute('aria-expanded', String(this.problemsOpen))
        list.hidden = !this.problemsOpen
        list.replaceChildren(
            ...this.problems.map(d => {
                const li = document.createElement('li')
                li.className = `sc-pg-problem is-${d.severity}`
                const btn = document.createElement('button')
                btn.type = 'button'
                const at = d.span ? this.latest!.tracker.fromSnapshot(d.span.start) : 0
                const line = this.view.state.doc.lineAt(Math.min(at, this.view.state.doc.length)).number
                const where = document.createElement('span')
                where.className = 'sc-pg-problem__where'
                where.textContent = `${d.severity === 'error' ? 'Error' : d.severity === 'warning' ? 'Warning' : 'Note'}${d.span ? `, line ${line}` : ''}`
                btn.append(where, renderDiagnostic(d))
                btn.addEventListener('click', () => {
                    const t = this.latest!.tracker
                    if (d.span) selectRange(this.view, t.fromSnapshot(d.span.start), t.fromSnapshot(d.span.end), true)
                    this.showTab('code')
                })
                li.append(btn)
                // "About this message": the error reference's section about it (beside the button: a link cannot be in one).
                const more = problemLink(d)
                if (more) li.append(more)
                const word = suggestionOf(d)
                if (word && d.span) {
                    const fix = document.createElement('button')
                    fix.type = 'button'
                    fix.className = 'sc-pg-problem__fix'
                    fix.textContent = `Change to ${word}`
                    fix.addEventListener('click', () => {
                        const t = this.latest!.tracker
                        if (applySuggestion(this.view, t.fromSnapshot(d.span!.start), t.fromSnapshot(d.span!.end), word)) this.view.focus()
                    })
                    li.append(fix)
                }
                return li
            }),
        )
    }

    // ----- Charts in the file ------------------------------------------------------------------------------------

    /** The chart picker (a file with several charts) or the chart's name in the diagram's head; `typed`: the name
     *  of the chart in a text that does not parse. */
    private updateCharts(result: CompileResult, typed?: string) {
        const select = $<HTMLSelectElement>(this.root, '[data-pg-chart]')
        const names = result.program?.charts.map(c => c.name).filter(Boolean) ?? []
        const label = $(this.root, '[data-pg-chart-name]')
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
        const current = result.chart?.name
        const options = names.map(n => n)
        if ([...select.options].map(o => o.value).join('\n') !== options.join('\n')) {
            select.replaceChildren(...options.map(n => new Option(n, n)))
        }
        if (current) select.value = current
        select.hidden = false
        if (label) label.hidden = true
        if (!select.dataset.wired) {
            select.dataset.wired = ''
            select.addEventListener('change', () => {
                this.chartChoice = select.value
                this.refitNext = true
                this.runCompile(false)
                this.forceSim()
            })
        }
    }

    // ----- Diagram -----------------------------------------------------------------------------------------------

    private setupDiagram(existing?: DiagramView) {
        const handlers = {
            onSelect: (id: string) => this.selectElement(id),
            onHover: (id: string | null) => this.hoverElement(id),
        }
        this.diagram = existing ?? createDiagramView(this.root, this.mode)
        this.diagram.setHandlers(handlers)
        this.layouts = new LayoutService(done => this.onLayout(done), this.mode === 'embed' ? `pge${Math.random().toString(36).slice(2, 6)}` : 'pg')
    }

    private requestLayout(analysed: Analysed) {
        const tag = ++this.layoutTag
        this.wantedLayout = tag
        this.layoutJobs.set(tag, analysed)
        this.layouts.request({ chart: analysed.result.chart!, program: analysed.result.program!, tag })
        this.root.dataset.layout = 'busy'
        // A large chart takes a moment: say so if it takes longer than a blink.
        clearTimeout(this.busyTimer)
        this.busyTimer = setTimeout(() => {
            const busy = $(this.root, '[data-pg-busy]')
            if (busy && this.root.dataset.layout === 'busy') busy.hidden = false
        }, 600)
    }

    private busyTimer?: ReturnType<typeof setTimeout>

    private layoutJobs = new Map<number, Analysed>()
    /** Layout results older than this are not shown (the text has no chart since). */
    private minLayout = 0

    private onLayout(done: LayoutDone) {
        const analysed = this.layoutJobs.get(done.tag)
        for (const t of [...this.layoutJobs.keys()]) if (t <= done.tag) this.layoutJobs.delete(t)
        if (done.tag === this.wantedLayout) {
            this.root.dataset.layout = 'idle'
            clearTimeout(this.busyTimer)
            const busy = $(this.root, '[data-pg-busy]')
            if (busy) busy.hidden = true
        }
        if (!analysed || done.tag < this.minLayout) return
        if (!done.layout || !done.svg) {
            this.setStale(true, done.error ? `The diagram could not be drawn: ${done.error}` : undefined)
            return
        }
        // An older layout than the one shown (cannot happen with latest-wins, but stay safe).
        const chart = done.layout.chart
        const refit = this.refitNext || chart !== this.shown?.chart
        this.refitNext = false
        this.shown = { layout: done.layout, tracker: analysed.tracker, chart, result: analysed.result }
        // Keyboard focus on an element of the old diagram moves to the same element of the new one.
        const focused = this.diagram.svg?.contains(document.activeElement) ? (document.activeElement as Element).getAttribute('data-id') : null
        this.diagram.show(done.svg, refit)
        this.enableKeys(focused)
        this.renderOutline()
        const name = $(this.root, '[data-pg-chart-name]')
        if (name && !this.chartChoice) name.textContent = name.title = chart
        // Up to date unless the text changed since this compile and the newest compile has syntax errors.
        this.setStale(!!this.latest && isSyntaxBroken(this.latest.result), 'Showing the last diagram that parsed')
        this.applyClasses()
        this.followCursor()
        this.pruneTrackers()
    }

    /** Takes the diagram off the stage (no chart, or another chart's); layouts still on their way are for older text. */
    private dropDiagram() {
        this.keysOff?.()
        this.keysOff = undefined
        this.diagram.clear()
        this.shown = undefined
        this.minLayout = ++this.layoutTag
        this.setStale(false)
        this.renderOutline()
    }

    private setStale(stale: boolean, message?: string) {
        const panel = $(this.root, '[data-pg-diagram]') ?? this.root
        const badge = $(this.root, '[data-pg-badge]')
        const hasDiagram = !!this.diagram?.svg
        panel.classList.toggle('is-stale', stale && hasDiagram)
        if (badge) {
            badge.hidden = !(stale && hasDiagram)
            if (message) badge.textContent = message
        }
    }

    private applyClasses() {
        const c = this.classes
        const merged = mergeClasses(c.sim, c.errors, c.cursor, c.panel, c.hover)
        this.diagram?.setClasses(merged)
        const svg = this.diagram?.svg
        // As the guide's widgets do (link.ts, markDiagram; Sim.svelte): an element with an error gets its "!" marker
        // (an error is told by its shape too), and a for-region's states active in several copies get a "×n" badge
        // and their marks per copy, named by the region's counter (`i = 2`), against the tick before.
        markErrors(svg)
        const view = this.simView
        const tick = view?.tick
        markCopies(svg, tick, tick?.copies ? { prev: view!.cursor > 1 ? view!.history[view!.cursor - 2] : null, counters: copyCounters(this.simAnalysed?.result) } : {})
        // The elements' accessible names say what the simulation marks ("active", "fired in this tick", "active in
        // 3 of 4 copies").
        if (svg?.hasAttribute('data-sc-keys')) refreshNames(svg)
        this.markOutline(c.sim)
    }

    // ----- The diagram from the keyboard -------------------------------------------------------------------------
    //
    // As in the guide's widgets (src/components/sim/link.ts, enableDiagramKeys): the diagram's states, named regions
    // and transitions are one tab stop after the stage's own (which pans and zooms); the arrow keys move between them
    // in the order they are written, Home and End to the first and last. Each has an accessible name with the
    // simulation's marks. Focusing one marks it and its source, as hovering does; on /playground Enter selects its
    // source (on a guide page Space and Enter step the simulation, as in the widgets).

    private enableKeys(focus?: string | null) {
        this.keysOff?.()
        this.keysOff = undefined
        const svg = this.diagram.svg
        const shown = this.shown
        const chart = shown?.result.chart
        if (!svg || !shown || !chart) return
        const map = lineMap(chart, shown.tracker.doc.toString())
        const hint = $(this.root, '[data-pg-diagram-keys]')
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
                this.diagram.reveal(id)
            })
            host.addEventListener('focusout', e => {
                const next = (e as FocusEvent).relatedTarget
                if (!(next instanceof Element) || !next.closest('[data-sc-nav]')) this.hoverElement(null)
            })
            if (this.mode === 'page') {
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

    // ----- Outline: the chart as a list (keyboard and screen readers) ----------------------------------------
    //
    // The diagram is a picture (its <svg> has a title and a description, as in the guide's widgets). The outline
    // lists its regions, states and transitions as buttons: focusing (or pointing at) one marks it in the diagram
    // and in the source, as hovering the diagram does; activating one selects its source, as a click does. The
    // states the simulation marks active, and the transitions it marks taken, are marked in the list too.

    private toggleOutline(open?: boolean) {
        const nav = $(this.root, '[data-pg-outline]')
        const btn = $(this.root, '[data-action="outline"]')
        if (!nav) return
        const show = open ?? !!nav.hidden
        nav.hidden = !show
        btn?.setAttribute('aria-expanded', String(show))
        btn?.classList.toggle('is-on', show)
        if (show) {
            this.renderOutline()
            // Before the first layout has arrived the list is empty: the list itself holds focus until it fills.
            nav.tabIndex = -1
            ;(nav.querySelector<HTMLButtonElement>('button') ?? nav).focus()
        } else {
            this.hoverElement(null)
        }
    }

    private renderOutline() {
        const nav = $(this.root, '[data-pg-outline]')
        const layout = this.shown?.layout
        if (!nav || nav.hidden) return
        if (!layout) {
            nav.replaceChildren(Object.assign(document.createElement('p'), { className: 'sc-pg-outline__region', textContent: 'There is no diagram yet.' }))
            return
        }
        const names = new Map<string, string>()
        const collect = (st: StateLayout) => {
            names.set(st.id, st.name)
            for (const r of st.regions) r.states.forEach(collect)
        }
        collect(layout.root)
        // What a screen reader hears: the names the widgets' diagrams give their elements ("initial state Off",
        // "transition Off to On: if button go to On"; src/components/sim/lines.ts), the simulation's marks after it.
        const chart = this.shown?.result.chart
        const spoken = chart ? lineMap(chart, this.shown!.tracker.doc.toString()).names ?? {} : {}
        const item = (id: string, name: string, kind: string, label?: string, fallback?: string) => {
            const li = document.createElement('li')
            const b = document.createElement('button')
            b.type = 'button'
            b.dataset.id = id
            b.dataset.name = spoken[id] ?? fallback ?? name
            b.setAttribute('aria-label', b.dataset.name)
            b.innerHTML = `<span class="sc-pg-outline__name">${escapeHtml(name)}</span>${kind ? `<span class="sc-pg-outline__kind">${escapeHtml(kind)}</span>` : ''}${label ? `<span class="sc-pg-outline__label">${escapeHtml(label)}</span>` : ''}`
            li.append(b)
            return li
        }
        const textOf = (t: TransitionLayout) => t.label?.lines.map(l => l.runs.map(r => r.text).join('')).join(' ') ?? ''
        const transition = (t: TransitionLayout) => {
            const flags = [t.immediate && 'immediate', t.preemption === 'strong' && 'strong abort', t.preemption === 'termination' && 'termination', t.history && `${t.history} history`].filter(Boolean).join(', ')
            const label = textOf(t)
            const from = names.get(t.source) ?? t.source, to = names.get(t.target) ?? t.target
            return item(t.id, `${from} → ${to}`, flags, label, `transition ${from} to ${to}${label ? `: ${label}` : ''}`)
        }
        const region = (r: RegionLayout, index: number, count: number): HTMLLIElement => {
            const li = document.createElement('li')
            const title = r.name ?? r.label?.runs.map(x => x.text).join('') ?? (count > 1 ? `Region ${index + 1}` : '')
            // The region's own button, then its states and transitions (a list item holds no list item).
            if (title || count > 1) li.append(item(r.id, title || `Region ${index + 1}`, r.dataflow ? 'dataflow region' : 'region', undefined, `${r.dataflow ? 'dataflow region' : 'region'} ${title || index + 1}`).firstElementChild!)
            const ul = document.createElement('ul')
            for (const st of r.states) ul.append(state(st))
            for (const t of r.transitions) ul.append(transition(t))
            li.append(ul)
            return li
        }
        const state = (st: StateLayout): HTMLLIElement => {
            const kind = [st.initial && 'initial', st.final && 'final', st.shape === 'connector' && 'connector', st.reference && 'reference', st.regions.some(r => r.states.length || r.dataflow) && !st.reference && 'superstate'].filter(Boolean).join(', ')
            const li = item(st.id, st.name || '(unnamed)', kind, undefined, st.id === layout.root.id ? `chart ${st.name}` : `${kind ? `${kind} ` : ''}state ${st.name}`)
            if (st.regions.length) {
                const ul = document.createElement('ul')
                st.regions.forEach((r, i) => ul.append(region(r, i, st.regions.length)))
                li.append(ul)
            }
            return li
        }
        const top = document.createElement('ul')
        top.append(state(layout.root))
        // A new layout while the reader is in the list (typing elsewhere, a late first layout): keep their place.
        const inside = nav.contains(document.activeElement)
        const focused = inside ? (document.activeElement as HTMLElement).dataset.id : undefined
        nav.replaceChildren(top)
        if (inside) (nav.querySelector<HTMLButtonElement>(focused ? `button[data-id="${CSS.escape(focused)}"]` : 'button') ?? nav.querySelector('button'))?.focus()
        if (!nav.dataset.wired) {
            nav.dataset.wired = ''
            const idOf = (e: Event) => (e.target as Element).closest<HTMLElement>('button[data-id]')?.dataset.id
            nav.addEventListener('focusin', e => {
                const id = idOf(e)
                if (!id) return
                this.hoverElement(id)
                this.diagram.reveal(id)
            })
            nav.addEventListener('focusout', () => this.hoverElement(null))
            nav.addEventListener('pointerover', e => {
                const id = idOf(e)
                if (id) this.hoverElement(id)
            })
            nav.addEventListener('pointerleave', () => this.hoverElement(null))
            nav.addEventListener('click', e => {
                const id = idOf(e)
                if (id) this.selectElement(id)
            })
            nav.addEventListener('keydown', e => {
                const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button[data-id]')]
                const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
                let next: HTMLButtonElement | undefined
                if (e.key === 'ArrowDown') next = buttons[Math.min(buttons.length - 1, i + 1)]
                else if (e.key === 'ArrowUp') next = buttons[Math.max(0, i - 1)]
                else if (e.key === 'Home') next = buttons[0]
                else if (e.key === 'End') next = buttons[buttons.length - 1]
                else if (e.key === 'Escape') {
                    e.preventDefault()
                    this.toggleOutline(false)
                    $(this.root, '[data-action="outline"]')?.focus()
                    return
                }
                if (!next) return
                e.preventDefault()
                next.focus()
            })
        }
        this.markOutline(this.classes.sim)
    }

    /** The simulation's marks (and errors), in the outline: shown, and said after the name, as the widgets do; a
     *  for-region's state with the number of copies it is active in (the diagram's badge, markCopies). */
    private markOutline(sim: ClassMap) {
        const nav = $(this.root, '[data-pg-outline]')
        if (!nav || nav.hidden) return
        const errors = this.classes.errors
        const svg = this.diagram?.svg
        for (const b of nav.querySelectorAll<HTMLButtonElement>('button[data-id]')) {
            const id = b.dataset.id!
            const cls = [...(errors[id] ?? []), ...(sim[id] ?? [])]
            b.classList.toggle('is-active', cls.includes('is-active'))
            b.classList.toggle('is-taken', cls.includes('is-taken'))
            // A for-region's state: its marks per copy (markCopies) in place of the union's, as the diagram names it.
            const g = svg?.querySelector(`.sc-state[data-id="${CSS.escape(id)}"]`)
            const detail = g?.getAttribute('data-sc-copy-detail') || g?.getAttribute('data-sc-copies') || ''
            const replaced = detail ? (g?.getAttribute('data-sc-copy-replaces') ?? '').split(' ') : []
            const status = OUTLINE_STATUS.filter(([c]) => cls.includes(c) && !replaced.includes(c)).map(([, text]) => text)
            const n = /^active in (\d+) of/.exec(g?.getAttribute('data-sc-copies') ?? '')?.[1]
            let badge = b.querySelector<HTMLElement>('.sc-pg-outline__copies')
            if (n && !badge) {
                badge = Object.assign(document.createElement('span'), { className: 'sc-pg-outline__copies' })
                badge.setAttribute('aria-hidden', 'true')
                b.querySelector('.sc-pg-outline__name')?.after(badge)
            }
            if (badge) {
                badge.hidden = !n
                badge.textContent = n ? `×${n}` : ''
            }
            b.setAttribute('aria-label', [b.dataset.name, ...status, detail].filter(Boolean).join(', '))
        }
    }

    private followCursor() {
        const shown = this.shown
        if (!shown) return
        const head = this.view.state.selection.main.head
        const at = shown.tracker.toSnapshot(head)
        const map: ClassMap = {}
        if (at !== null && this.view.hasFocus) {
            const ids = elementsAt(shown.layout, at).filter(id => id !== shown.layout.root.id)
            if (ids[0]) {
                map[ids[0]] = ['is-focus']
                this.diagram.reveal(ids[0])
            }
        }
        this.classes.cursor = map
        this.applyClasses()
    }

    private selectElement(id: string) {
        const shown = this.shown
        if (!shown) return
        const span = spanOf(shown.layout, id) ?? this.lineSpan(id)
        if (!span) return
        const from = shown.tracker.fromSnapshot(span.start)
        const to = shown.tracker.fromSnapshot(span.end)
        // On a phone the editor is in another tab: select there, stay here.
        selectRange(this.view, from, to, !this.isNarrow())
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
            const actions = state?.actions.filter(a => a.kind === m[2])
            return actions?.[Number(m[3])]?.span
        }
        return undefined
    }

    private hoverElement(id: string | null) {
        const shown = this.shown
        this.classes.hover = id ? { [id]: ['is-focus'] } : {}
        this.applyClasses()
        if (!shown || !id) {
            this.marks.focus = undefined
        } else {
            const span = spanOf(shown.layout, id) ?? this.lineSpan(id)
            this.marks.focus = span ? { from: shown.tracker.fromSnapshot(span.start), to: shown.tracker.fromSnapshot(span.end) } : undefined
        }
        setMarks(this.view, this.marks)
    }

    // ----- Simulation --------------------------------------------------------------------------------------------

    private setupSim() {
        const target = $(this.root, '[data-pg-sim]')
        if (!target) return
        $(this.root, '[data-action="rebuild"]')?.addEventListener('click', () => this.rebuild())
        $(this.root, '[data-pg-mode]')?.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('button[data-mode]')
            if (b) this.setMode(b.dataset.mode === 'tour' ? 'tour' : 'free')
        })
        this.setupVariables()
    }

    // ----- Guided tour and free play ---------------------------------------------------------------------------
    //
    // An example with a scenario offers its guided tour (SimPanel's `scenario`): the panel is always mounted with it,
    // and starts in free play (Take over at once) for the showcase charts and exercise starters, in the tour for the
    // guide's other examples. The switch in the panel's head follows the panel (Take over and "Restart the guided
    // tour" inside it count too).

    private setTour(scenario: Scenario | undefined, origin: Origin) {
        this.tour = tourOf(scenario)
        this.originTour = this.tour
        this.replay = undefined
        this.sharedRun = undefined
        const showcase = !!origin.id?.startsWith('showcase/')
        this.wantTour = !!this.tour && origin.kind === 'example' && !showcase && !origin.starter && !this.solution
        this.tourActive = this.wantTour
        this.updateModeSwitch()
    }

    private setMode(mode: 'tour' | 'free') {
        if (!(this.tour || this.replay)) return
        this.wantTour = mode === 'tour'
        // Not mounted yet: the panel starts in this mode.
        if (!this.sim) return
        // A run of an older text: the tour (and free play) start on the chart as it is now.
        if (this.simStale && this.latest?.result.ok) {
            this.pushCompiled(this.latest, 'reset')
            this.simStale = false
            this.updateSimHead()
        }
        if (mode === 'tour') this.sim.restartTour()
        else this.sim.takeOver()
    }

    /** A shared run (a `&run=` link): the panel replays its inputs as a tour, from the tick that was shown. */
    private setSharedRun(run: SharedRun) {
        this.sharedRun = run
        this.runAnnounced = false
        this.wantTour = true
        this.tourActive = true
    }

    private get tourKind(): TourKind {
        return this.replay?.kind ?? (this.sharedRun ? 'shared' : 'tour')
    }

    private updateModeSwitch() {
        const box = $(this.root, '[data-pg-mode]')
        if (!box) return
        box.hidden = !(this.tour || this.replay) || !this.simOk
        const tourButton = box.querySelector<HTMLButtonElement>('[data-mode="tour"]')
        if (tourButton) {
            tourButton.textContent = TOUR_NAMES[this.tourKind]
            tourButton.title = TOUR_TITLES[this.tourKind]
        }
        for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
            b.setAttribute('aria-pressed', String((b.dataset.mode === 'tour') === this.tourActive))
        }
    }

    private ensureSim(analysed: Analysed): Promise<void> {
        if (this.simReady) return this.simReady
        return this.mountSimFor(analysed)
    }

    /** A fresh simulation panel for a chart (also when a chart becomes runnable or stops being so before the first
     *  step: the panel's controls and its error list are different blocks). */
    private mountSimFor(analysed: Analysed): Promise<void> {
        const target = $(this.root, '[data-pg-sim]')
        if (!target) return Promise.resolve()
        this.sim?.destroy()
        this.sim = null
        this.simView = undefined
        this.classes.sim = {}
        target.replaceChildren()
        this.simAnalysed = analysed
        this.simOk = analysed.result.ok
        // A shared run's notes say which inputs changed: they need the chart's inputs.
        if (this.sharedRun && !this.replay && analysed.result.ok) {
            this.replay = { scenario: sharedRunTour(this.sharedRun, analysed.result.interface), ticks: this.sharedRun.at, kind: 'shared' }
        }
        const kind = this.tourKind
        const replay = this.replay
        this.setChoices(analysed.result)
        // A second mount before the first has reported back (two loads in a row) replaces it.
        const generation = ++this.simGeneration
        this.simReady = mountSim(target, analysed.result, analysed.tracker.doc.toString(), {
            onhighlight: (classes, view) => this.onSimHighlight(classes, view),
            onfire: ids => this.pulse(ids),
            onfocus: ids => {
                this.classes.panel = Object.fromEntries(ids.map(id => [id, ['is-focus']]))
                this.applyClasses()
            },
        }, {
            keys: this.mode === 'page' ? $(this.root, '[data-pg-sim-panel]') : (this.root.closest('[data-sc-frame]') as HTMLElement | null),
            variant: 'full',
            label: 'Simulation',
            id: this.mode === 'embed' ? `pge-sim-${Math.random().toString(36).slice(2, 7)}` : 'pg-sim',
            scenario: replay?.scenario ?? this.tour,
            initialTicks: replay?.ticks ?? 0,
            tourName: TOUR_NAMES[kind],
            intro: kind === 'test'
                ? 'These are the inputs of the model solution\'s test run. Press **Next** to run tick 1.'
                : kind === 'shared' && replay
                  ? `These are the inputs of a shared run (${plural(replay.scenario.ticks.length, 'tick')}). Press **Next** to run tick 1, or **Take over** to set the inputs yourself.`
                  : undefined,
            show: this.simShow,
            verdict: this.verdictFor(analysed),
        }).then(host => {
            if (generation !== this.simGeneration) {
                host?.destroy()
                return
            }
            this.sim = host
            // Free play: the tour stays one click away ("Guided tour", or "Restart the guided tour" in the panel).
            if (host && this.tour && !this.replay && !this.wantTour) host.takeOver()
            if (this.mode === 'page') this.observeSim()
            this.updateModeSwitch()
            if (host && replay?.kind === 'shared' && !this.runAnnounced) this.announceRun(replay)
        })
        return this.simReady
    }

    private pulse(ids: string[]) {
        if (this.diagram.svg) pulseTransitions(this.diagram.svg, ids)
    }

    private onSimHighlight(classes: ClassMap, view: SimView) {
        this.simView = view
        if (view.tour !== this.tourActive) {
            this.tourActive = view.tour
            this.updateModeSwitch()
        }
        this.classes.sim = classes
        this.applyClasses()
        const t = this.simAnalysed?.tracker
        const doc = t?.doc
        const toOffsets = (lines: number[]) =>
            !doc || !t ? [] : lines.filter(n => n >= 1 && n <= doc.lines).map(n => t.fromSnapshot(doc.line(n).from))
        this.marks.active = toOffsets(view.lines?.active ?? [])
        this.marks.taken = toOffsets(view.lines?.taken ?? [])
        setMarks(this.view, this.marks)
        this.updateSimHead()
        this.renderWatch()
    }

    private simValues(): Record<string, unknown> | undefined {
        const tick = this.simView?.tick
        if (!tick || this.simStale) return undefined
        return { ...tick.values, ...Object.fromEntries(Object.entries(tick.present ?? {}).filter(([k]) => !(k in tick.values))) }
    }

    private get simStarted() {
        return (this.simView?.cursor ?? 0) > 0
    }

    private updateSim(analysed: Analysed, initial: boolean) {
        clearTimeout(this.simErrorTimer)
        if (!this.simReady) {
            if (analysed.result.program || initial) void this.ensureSim(analysed)
            return
        }
        if (this.simStarted) {
            // The reader is in the middle of a run: never pull the chart from under them.
            this.simStale = this.simAnalysed?.tracker.changed ?? true
            this.updateSimHead()
            return
        }
        const push = () => {
            this.simStale = false
            if (analysed.result.ok !== this.simOk) {
                void this.mountSimFor(analysed).then(() => this.updateSimHead())
                return
            }
            this.pushCompiled(analysed, 'reset')
            this.updateSimHead()
        }
        if (analysed.result.ok) push()
        else this.simErrorTimer = setTimeout(push, SIM_ERROR_DELAY)
    }

    /** The panel simulates `a` from now on (with the variables chosen for its chart, and its verdict). */
    private pushCompiled(a: Analysed, mode: 'reset' | 'replay') {
        this.simAnalysed = a
        this.setChoices(a.result)
        this.sim?.setShow(this.simShow)
        this.sim?.setVerdict(this.verdictFor(a))
        this.sim?.setCompiled(a.result, a.tracker.doc.toString(), mode)
    }

    /** A new chart was loaded (or another chart of the file chosen): a fresh simulation of it. */
    private forceSim() {
        const a = this.latest
        if (!a) return
        clearTimeout(this.simErrorTimer)
        this.simStale = false
        void this.mountSimFor(a).then(() => this.updateSimHead())
    }

    rebuild() {
        const a = this.latest
        if (!a || !this.sim) return
        if (!this.simStale) return
        if (!a.result.ok) {
            this.toast('Fix the errors first: the edited chart does not compile.')
            return
        }
        const keep = !!this.simAnalysed && sameInterface(this.simAnalysed.result.interface, a.result.interface) && this.simStarted
        this.pushCompiled(a, keep ? 'replay' : 'reset')
        this.simStale = false
        this.updateSimHead()
        this.toast(keep ? 'Rebuilt. The recorded inputs were replayed on the edited chart.' : 'Rebuilt. The inputs or outputs changed, so the simulation starts again.')
    }

    private updateSimHead() {
        const btn = $<HTMLButtonElement>(this.root, '[data-action="rebuild"]')
        const note = $(this.root, '[data-pg-sim-note]')
        const stale = this.simStale && this.simStarted
        this.root.classList.toggle('is-sim-stale', stale)
        if (btn) {
            btn.hidden = !stale
            const ok = !!this.latest?.result.ok
            btn.setAttribute('aria-disabled', String(!ok))
            btn.title = ok ? `Compile the edited chart and continue (${MOD}+Shift+Enter)` : 'The edited chart has errors; fix them to rebuild'
        }
        if (note) {
            note.hidden = !stale
            note.textContent = stale ? 'The source changed since this simulation started.' : ''
        }
        const bar = $(this.root, '[data-pg-simbar]')
        if (bar) bar.hidden = !stale
        // "Copy link to this run" needs a tick to share.
        const run = $<HTMLButtonElement>(this.root, '[data-action="share-run"]')
        if (run) {
            const ticks = this.simView?.history.length ?? 0
            // Nothing to run while the chart is rejected: the tools go (the panel lists the problems instead).
            run.hidden = !this.simOk
            run.setAttribute('aria-disabled', String(!ticks || !this.simOk))
            run.title = ticks ? `Copy a link that replays ${ticks === 1 ? 'this tick' : `these ${ticks} ticks`}` : 'Run the chart first: the link replays the ticks you run'
        }
        $(this.root, '[data-pg-vars-toggle]')?.toggleAttribute('hidden', !this.simOk)
        if (!this.simOk) this.toggleVariables(false)
    }

    // ----- Variables: what the timing diagram traces -----------------------------------------------------------
    //
    // "Variables" in the simulation's head opens a strip of check boxes under it, one per variable of the chart
    // (variables.ts), grouped as inputs, outputs, locals, members and time. The trace follows every change at once, so the
    // strip stays open next to it; the choice is remembered per chart. The default is KIELER's data pool: the
    // inputs, the outputs and the chart's top-level locals.

    /** The simulated chart's variables, and what to trace of them (the reader's choice for the chart, else the default). */
    private setChoices(result: CompileResult) {
        const found = result.chart && result.ok ? variableChoices(result) : { choices: [], untraceable: 0 }
        this.simChoices = found.choices
        this.simUntraceable = found.untraceable
        const chart = result.chart?.name
        this.simShow = chart && this.simChoices.length ? resolveShow(this.simChoices, loadChoice(chart)) : undefined
        this.setWatchChart(result)
        this.renderVariables()
    }

    private setupVariables() {
        const toggle = $<HTMLButtonElement>(this.root, '[data-pg-vars-toggle]')
        const strip = $(this.root, '[data-pg-vars]')
        if (!toggle || !strip) return
        toggle.addEventListener('click', () => this.toggleVariables())
        strip.addEventListener('change', e => {
            const box = e.target as HTMLInputElement
            if (box.type !== 'checkbox') return
            const on = new Set(this.simShow ?? defaultShow(this.simChoices))
            if (box.checked) on.add(box.value)
            else on.delete(box.value)
            this.applyShow(this.simChoices.filter(c => on.has(c.name)).map(c => c.name))
        })
        strip.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('button[data-vars]')
            if (!b) return
            this.applyShow(b.dataset.vars === 'all' ? this.simChoices.map(c => c.name) : b.dataset.vars === 'none' ? [] : defaultShow(this.simChoices))
        })
        strip.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            this.toggleVariables(false)
            toggle.focus()
        })
        this.setupWatch(strip)
    }

    // ----- Watch and Run until ----------------------------------------------------------------------------------
    //
    // Under the variables' check boxes: an expression over the chart's data pool, evaluated for the tick shown by the
    // guide's engine (watch.ts), remembered per chart; and "Run until", which steps (as Step does, with the inputs
    // as they are set) until the watch holds or a state is active, at most UNTIL_MAX ticks, stopping where the chart
    // terminates, fails or the guided tour ends.

    private static readonly UNTIL_MAX = 1000
    private watch?: Watch
    private watchError?: string
    private watchChart?: string
    private watchTimer?: ReturnType<typeof setTimeout>
    private untilRunning = false
    private untilStop = false

    private watchKey(chart: string) {
        return `sccharts-guide:playground:watch:${chart}`
    }

    private setupWatch(strip: HTMLElement) {
        const input = $<HTMLInputElement>(strip, '[data-pg-watch-input]')
        // The reader's watch: remembered for the chart, and (once it is one) what Run until runs until.
        const apply = () => {
            clearTimeout(this.watchTimer)
            if (this.watchChart) storageSet(this.watchKey(this.watchChart), input!.value.trim() || null)
            const had = this.watch?.text
            this.compileWatchFor(this.simAnalysed?.result)
            const select = $<HTMLSelectElement>(this.root, '[data-pg-until]')
            if (select && this.watch && this.watch.text !== had) {
                select.value = 'watch'
                this.renderUntil()
            }
        }
        input?.addEventListener('input', () => {
            clearTimeout(this.watchTimer)
            this.watchTimer = setTimeout(apply, 250)
        })
        input?.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            apply()
        })
        const run = $(strip, '[data-pg-until-run]')
        run?.addEventListener('click', () => {
            if (this.untilRunning) this.untilStop = true
            else if (run.getAttribute('aria-disabled') !== 'true') void this.runUntil()
        })
    }

    /** The chart in the panel changed: its remembered watch, compiled for it. */
    private setWatchChart(result: CompileResult) {
        const input = $<HTMLInputElement>(this.root, '[data-pg-watch-input]')
        const chart = result.ok ? result.chart?.name : undefined
        if (input && chart !== this.watchChart) {
            this.watchChart = chart
            input.value = (chart && storageGet(this.watchKey(chart))) || ''
        }
        this.compileWatchFor(result)
    }

    private compileWatchFor(result: CompileResult | undefined) {
        const input = $<HTMLInputElement>(this.root, '[data-pg-watch-input]')
        const text = input?.value.trim() ?? ''
        this.watch = undefined
        this.watchError = undefined
        if (text && result?.ok) {
            const w = compileWatch(text, result)
            if ('error' in w) this.watchError = w.error
            else this.watch = w
        }
        this.renderWatch()
        this.renderUntil()
    }

    /** What the watch reads of each tick of the panel's run: KIELER's data pool and the engine's trace. */
    private watchTicks(): WatchTick[] {
        return (this.simView?.history ?? []) as WatchTick[]
    }

    private renderWatch() {
        const out = $(this.root, '[data-pg-watch-value]')
        const input = $<HTMLInputElement>(this.root, '[data-pg-watch-input]')
        if (!out || !input) return
        out.classList.remove('is-error', 'is-true', 'is-false')
        input.removeAttribute('aria-invalid')
        if (this.watchError) {
            out.classList.add('is-error')
            input.setAttribute('aria-invalid', 'true')
            out.innerHTML = inlineMd(this.watchError)
            return
        }
        if (!this.watch) {
            out.textContent = ''
            return
        }
        const cursor = this.simView?.cursor ?? 0
        const v = this.watch.at(this.watchTicks(), cursor)
        if ('error' in v) {
            out.classList.add('is-error')
            out.textContent = `In tick ${cursor}: ${v.error}`
        } else if ('none' in v) {
            out.innerHTML = inlineMd(v.none)
        } else {
            const shown = typeof v.value === 'string' ? JSON.stringify(v.value) : Array.isArray(v.value) ? JSON.stringify(v.value) : String(v.value)
            if (typeof v.value === 'boolean') out.classList.add(v.value ? 'is-true' : 'is-false')
            out.innerHTML = `In tick ${cursor}: <code>${escapeHtml(shown)}</code>`
        }
    }

    /** The goals of Run until: the watch, and every state of the chart in the panel. */
    private renderUntil() {
        const select = $<HTMLSelectElement>(this.root, '[data-pg-until]')
        const run = $<HTMLButtonElement>(this.root, '[data-pg-until-run]')
        if (!select || !run) return
        const chart = this.simAnalysed?.result.ok ? this.simAnalysed.result.chart : undefined
        const states: { id: string; label: string }[] = []
        const visit = (st: State, path: string[]) => {
            for (const r of st.regions) for (const c of r.states) {
                const name = [...path, c.name].join('.')
                states.push({ id: c.id, label: `${name} is active` })
                visit(c, [...path, c.name])
            }
        }
        if (chart) visit(chart, [])
        const options = [{ id: 'watch', label: 'the watch holds' }, ...states]
        const key = options.map(o => `${o.id}=${o.label}`).join('|')
        if (select.dataset.key !== key) {
            const before = select.value
            select.replaceChildren(...options.map(o => new Option(o.label, o.id)))
            select.dataset.key = key
            if (options.some(o => o.id === before)) select.value = before
        }
        const watchOption = select.querySelector<HTMLOptionElement>('option[value="watch"]')
        if (watchOption) watchOption.disabled = !this.watch
        if (select.value === 'watch' && !this.watch && states.length) select.value = states[0].id
        const can = this.untilRunning || (!!chart && (select.value !== 'watch' || !!this.watch))
        run.setAttribute('aria-disabled', String(!can))
        run.textContent = this.untilRunning ? 'Stop' : 'Run'
        select.disabled = this.untilRunning
    }

    /** Steps until the goal is reached (a later tick than the one shown). */
    async runUntil() {
        const select = $<HTMLSelectElement>(this.root, '[data-pg-until]')
        const host = this.sim
        if (!select || !host || this.untilRunning || !this.simOk) return
        const goal = select.value
        const watch = this.watch
        if (goal === 'watch' && !watch) return
        const label = select.selectedOptions[0]?.textContent ?? ''
        const reached = () => {
            const v = this.simView
            if (!v?.tick) return false
            return goal === 'watch' ? holds(watch!.at(this.watchTicks(), v.cursor)) : v.tick.active.includes(goal)
        }
        this.untilRunning = true
        this.untilStop = false
        this.renderUntil()
        let message = `Not within ${Playground.UNTIL_MAX} ticks: ${label.replace(/ is active$/, ' was never active').replace(/^the watch holds$/, 'the watch never held')}.`
        try {
            for (let i = 0; i < Playground.UNTIL_MAX; i++) {
                const before = this.simView?.cursor ?? 0
                host.stepNow()
                const v = this.simView
                if (!v?.tick || v.cursor === before) {
                    message = this.tourActive ? `The guided tour ends in tick ${before}. Take over to run further.` : `The simulation stopped in tick ${before}.`
                    break
                }
                if (v.tick.error) {
                    message = `Stopped in tick ${v.cursor}: ${v.tick.error.message}`
                    break
                }
                if (reached()) {
                    message = `Stopped in tick ${v.cursor}: ${goal === 'watch' ? `the watch holds (${watch!.text})` : label}.`
                    break
                }
                if (v.tick.terminated) {
                    message = `The chart has terminated (tick ${v.cursor}), and ${goal === 'watch' ? 'the watch has not held' : label.replace(/ is active$/, ' has not been active')}.`
                    break
                }
                // Let the page breathe on a long run (and the reader press Stop).
                if (i % 20 === 19) await new Promise(r => setTimeout(r))
                if (this.sim !== host) return
                if (this.untilStop) {
                    message = `Stopped in tick ${this.simView?.cursor ?? 0}, before ${goal === 'watch' ? 'the watch held' : label.replace(/ is active$/, ' was active')}.`
                    break
                }
            }
        } finally {
            this.untilRunning = false
            this.renderUntil()
        }
        this.toast(message)
    }

    private toggleVariables(open?: boolean) {
        const toggle = $<HTMLButtonElement>(this.root, '[data-pg-vars-toggle]')
        const strip = $(this.root, '[data-pg-vars]')
        if (!toggle || !strip) return
        const show = open ?? strip.hidden === true
        strip.hidden = !show
        toggle.setAttribute('aria-expanded', String(show))
        toggle.classList.toggle('is-on', show)
        if (show) {
            this.renderVariables()
            strip.querySelector<HTMLInputElement>('input')?.focus()
        }
    }

    /** Traces `show` from now on and remembers it for the chart. */
    private applyShow(show: string[]) {
        this.simShow = show
        const chart = this.simAnalysed?.result.chart?.name
        if (chart) saveChoice(chart, this.simChoices, show)
        this.sim?.setShow(show)
        this.renderVariables()
    }

    private renderVariables() {
        const strip = $(this.root, '[data-pg-vars]')
        const toggle = $(this.root, '[data-pg-vars-toggle]')
        if (!strip || !toggle) return
        const list = $(strip, '[data-pg-vars-list]') ?? strip
        const choices = this.simChoices
        const on = new Set(this.simShow ?? defaultShow(choices))
        const count = $(toggle, '[data-pg-vars-count]')
        // "Variables 4 of 5" (and, for screen readers, "shown in the timing diagram").
        if (count) count.textContent = choices.length ? ` ${choices.filter(c => on.has(c.name)).length} of ${choices.length}` : ''
        if (strip.hidden) return
        const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLInputElement | HTMLButtonElement) : null
        const focusKey = focused instanceof HTMLInputElement ? `v:${focused.value}` : focused?.dataset.vars ? `b:${focused.dataset.vars}` : undefined
        const parts: HTMLElement[] = []
        if (!choices.length) {
            parts.push(Object.assign(document.createElement('p'), { className: 'sc-pg-vars__none', textContent: 'This chart has no variables: the timing diagram shows its regions.' }))
        } else {
            const groups = document.createElement('div')
            groups.className = 'sc-pg-vars__groups'
            for (const group of Object.keys(GROUP_TITLES) as VarGroup[]) {
                const items = choices.filter(c => c.group === group)
                if (!items.length) continue
                const g = document.createElement('div')
                g.className = 'sc-pg-vars__group'
                g.setAttribute('role', 'group')
                const title = document.createElement('span')
                title.className = 'sc-pg-vars__title'
                title.id = `sc-pg-vars-${group}`
                title.textContent = GROUP_TITLES[group]
                g.setAttribute('aria-labelledby', title.id)
                g.append(title)
                for (const c of items) {
                    const label = document.createElement('label')
                    label.className = 'sc-pg-vars__item'
                    label.title = c.detail
                    const scope = c.scope ? `<span class="sc-pg-vars__scope" aria-hidden="true">${escapeHtml(c.scope)}</span>` : ''
                    label.innerHTML = `<input type="checkbox" value="${escapeHtml(c.name)}"${on.has(c.name) ? ' checked' : ''}><code>${escapeHtml(c.label)}</code>${scope}<span class="sc-visually-hidden">, ${escapeHtml(c.detail)}</span>`
                    g.append(label)
                }
                groups.append(g)
            }
            parts.push(groups)
            const foot = document.createElement('div')
            foot.className = 'sc-pg-vars__foot'
            const more = this.simUntraceable ? ` The simulator cannot trace ${plural(this.simUntraceable, 'more variable')} of this chart yet.` : ''
            foot.innerHTML = `<span class="sc-pg-vars__note">Every region has a lane too.${more}</span><span class="sc-pg-vars__buttons"><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="default" title="Inputs, outputs and the chart's own locals, as KIELER's data pool lists them">Default</button><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="all">All</button><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="none">None</button></span>`
            parts.push(foot)
        }
        list.replaceChildren(...parts)
        if (focusKey) {
            const sel = focusKey.startsWith('v:') ? `input[value="${CSS.escape(focusKey.slice(2))}"]` : `button[data-vars="${CSS.escape(focusKey.slice(2))}"]`
            ;(list.querySelector<HTMLElement>(sel) ?? list.querySelector<HTMLElement>('input, button'))?.focus()
        }
        this.renderUntil()
    }

    // ----- Share a run: its inputs in the link -------------------------------------------------------------------
    //
    // "Copy link to this run" puts the inputs of every tick computed in the link (share.ts), next to the chart: the
    // example as it is (?example=), else its source (#code=). Whoever opens it gets the run as a tour through it
    // (SimPanel's scenario, as "Show tick N" of the comparison does), at the tick that was shown, with Take over.

    async shareRun() {
        const view = this.simView
        const a = this.simAnalysed
        if (!a || !view?.history.length) {
            this.toast('Run the chart first: the link carries the inputs of every tick you run.')
            return
        }
        // The inputs each tick ran with (the engine's TickResult.ranWith; runInputs replays them to check).
        const found = runInputs(a.result, view.history)
        const run = makeRun(found.ticks, view.cursor)
        // The chart the run belongs to: the one in the panel (the source may have changed since the run started).
        const source = a.tracker.doc.toString()
        const example = (this.origin.kind === 'example' || this.origin.kind === 'default') && this.origin.id && source === this.loadedText ? this.origin.id : undefined
        // Another chart of the file than the first: the link names it.
        const ran = a.result.chart?.name
        const name = ran && ran !== a.result.program?.charts[0]?.name ? ran : undefined
        const url = runUrl(location.href, run, example ? { example, name } : { source, name })
        history.replaceState(history.state, '', url)
        let copied = false
        try {
            await navigator.clipboard.writeText(url)
            copied = true
        } catch {
            copied = false
        }
        const what = `${plural(run.ticks.length, 'tick')}${run.at < run.ticks.length ? `, opening at tick ${run.at}` : ''}`
        const stale = this.simStale && this.simStarted ? ' It has the chart as it was when this run started.' : ''
        // The inputs are the engine's own (TickResult.ranWith); a replay that still differs (it should not) is said.
        const inexact = found.exact < found.ticks.length ? ` Replayed here, the run differs from tick ${found.exact + 1} on, so the link may show another run from there.` : ''
        const long = url.length > 8000 ? ` It is ${url.length.toLocaleString('en-NZ')} characters long; some chat apps cut long links.` : ''
        this.toast((copied ? `Link copied: it replays this run (${what}).` : `Copy the link from the address bar: it replays this run (${what}).`) + stale + inexact + long)
    }

    /** Says that the page replays a shared run, with Take over. */
    private announceRun(replay: { scenario: Scenario; ticks: number }) {
        this.runAnnounced = true
        const n = replay.scenario.ticks.length
        this.toast(`This link replays a run of ${plural(n, 'tick')}${replay.ticks < n ? `, shown at tick ${replay.ticks}` : ''}. Step through it with Previous and Next.`, {
            label: 'Take over',
            run: () => this.setMode('free'),
        })
    }

    // ----- Compare with the model solution ----------------------------------------------------------------------
    //
    // Exercises open as /playground/?example=<starter>&solution=<id>. When the solution has a scenario and KIELER's
    // recording of it, the toolbar offers the comparison: the reader's chart (as it is now: it follows the edits
    // while the panel is open) runs on the scenario's inputs and every output of the solution is compared, tick by
    // tick (compare.ts). The solution's source stays hidden until the reader asks for it.

    private async setupSolution(id: string) {
        const [scenario, recording] = await Promise.all([loadScenario(id), loadRecording(id)])
        const tour = tourOf(scenario)
        // Recorded with KIELER's netlist compiler, as the guide's simulator runs charts.
        const system = (scenario as { system?: string } | undefined)?.system
        const pop = $<HTMLDetailsElement>(this.root, '[data-pg-compare]')
        if (!tour || (system && system !== 'netlist') || !recording?.ok || !recording.ticks?.length || !recording.interface) {
            if (pop) pop.hidden = true
            return
        }
        this.solution = { id, scenario: tour, recording, reveal: false }
        // An exercise starts in free play: the reader is about to edit.
        if (this.wantTour) this.setMode('free')
        void this.checkStarter()
        if (!pop) return
        pop.hidden = false
        if (!pop.dataset.wired) {
            pop.dataset.wired = ''
            pop.addEventListener('toggle', () => {
                if (pop.open) this.renderComparison()
            })
        }
    }

    private dropSolution() {
        this.solution = undefined
        this.showTask(undefined)
        const pop = $<HTMLDetailsElement>(this.root, '[data-pg-compare]')
        if (pop) {
            pop.open = false
            pop.hidden = true
        }
    }

    /** The comparison of the chart as it is now, in the toolbar's panel. */
    renderComparison(): Comparison | undefined {
        const panel = $(this.root, '[data-pg-compare-panel]')
        const sol = this.solution
        const a = this.latest
        if (!panel || !sol || !a) return undefined
        const c = compareWithSolution(a.result, sol.scenario, sol.recording)
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
            const e = document.createElement(tag)
            if (cls) e.className = cls
            if (html !== undefined) e.innerHTML = html
            return e
        }
        const parts: HTMLElement[] = []
        parts.push(el('p', 'sc-pg-compare__lead', inlineMd(`Runs your chart on the inputs of the model solution's test run (${sol.scenario.ticks.length} ticks) and compares the outputs, tick by tick, with what the model solution does in KIELER.`)))
        // An exercise that keeps the behaviour and changes the structure: the starter already "matches".
        const still = this.isStillStarter() && c.status === 'match'
        const result = el('div', `sc-pg-compare__result is-${still ? 'starter' : c.unsupported ? 'unsupported' : c.status}`)
        result.setAttribute('role', 'status')
        result.append(el('p', '', inlineMd(still ? `This is still the starter. It already behaves as the model solution does in all ${c.total} ticks of the test run: the exercise asks for the same behaviour, built another way.` : summary(c))))
        parts.push(result)
        if (c.errors?.length) {
            const list = el('ul', 'sc-pg-compare__errors')
            for (const d of c.errors.slice(0, 4)) {
                const li = el('li', '', `${d.span ? `<span class="sc-pg-compare__where">Line ${d.span.line}</span> ` : ''}${inlineMd(d.message)}`)
                list.append(li)
            }
            parts.push(list)
        }
        if (c.interface.length) {
            parts.push(el('p', 'sc-pg-compare__subhead', 'Inputs and outputs'))
            const list = el('ul', 'sc-pg-compare__interface')
            for (const p of c.interface) list.append(el('li', '', inlineMd(p.message)))
            parts.push(list)
        }
        if (c.status !== 'cannot' && c.ticks.length) {
            const strip = el('ol', 'sc-pg-compare__ticks')
            strip.setAttribute('aria-label', 'Ticks of the test run')
            c.ticks.forEach((ok, i) => {
                const li = el('li', ok ? 'is-same' : 'is-different')
                li.innerHTML = `<span aria-hidden="true">${i + 1}</span><span class="sc-visually-hidden">Tick ${i + 1}: ${ok ? 'the same' : 'different'}</span>`
                li.title = `Tick ${i + 1}: ${ok ? 'the same outputs' : 'different outputs'}`
                strip.append(li)
            })
            for (let i = c.ticks.length; i < c.total; i++) {
                const li = el('li', 'is-not-run', `<span aria-hidden="true">${i + 1}</span><span class="sc-visually-hidden">Tick ${i + 1}: not run</span>`)
                strip.append(li)
            }
            parts.push(strip)
        }
        if (c.firstTick) {
            const table = el('table', 'sc-pg-compare__table')
            table.innerHTML = `<caption>Outputs in tick ${c.firstTick.tick}</caption><thead><tr><th scope="col">Output</th><th scope="col">Your chart</th><th scope="col">Model solution</th></tr></thead>`
            const body = el('tbody')
            for (const r of c.firstTick.rows) {
                const tr = el('tr', r.same ? '' : 'is-different')
                tr.innerHTML = `<th scope="row"><code>${escapeHtml(r.name)}</code></th><td>${escapeHtml(r.yours)}</td><td>${escapeHtml(r.theirs)}</td>`
                body.append(tr)
            }
            table.append(body)
            parts.push(table)
        }
        const actions = el('div', 'sc-pg-compare__actions')
        if (c.status !== 'cannot') {
            const replay = el('button', 'sc-btn sc-btn--sm', c.firstTick ? `Show tick ${c.firstTick.tick} in the simulator` : 'Replay the test run in the simulator')
            ;(replay as HTMLButtonElement).type = 'button'
            replay.addEventListener('click', () => this.replayComparison(c))
            actions.append(replay)
        }
        const show = el('button', 'sc-btn sc-btn--sm sc-btn--quiet', sol.reveal ? 'Hide the model solution' : 'Show the model solution')
        ;(show as HTMLButtonElement).type = 'button'
        show.setAttribute('aria-expanded', String(sol.reveal))
        show.addEventListener('click', async () => {
            sol.reveal = !sol.reveal
            if (sol.reveal && sol.source === undefined) sol.source = (await loadExampleSource(sol.id)) ?? ''
            this.renderComparison()
            $<HTMLButtonElement>(this.root, '.sc-pg-compare__actions .sc-btn--quiet')?.focus()
        })
        actions.append(show)
        parts.push(actions)
        if (sol.reveal && sol.source) {
            const box = el('div', 'sc-pg-compare__solution')
            box.innerHTML = `<pre class="sc-pg-static"><code>${highlightLines(sol.source).map(l => `<span class="sc-pg-static__line"><span class="sc-pg-static__text">${l || ' '}</span></span>`).join('')}</code></pre>`
            const open = el('a', 'sc-pg-compare__open', 'Open the model solution in a new tab') as HTMLAnchorElement
            open.href = `/playground/?example=${encodeURIComponent(sol.id).replace(/%2F/g, '/')}`
            open.target = '_blank'
            open.rel = 'noopener'
            box.append(open)
            parts.push(box)
        }
        parts.push(el('p', 'sc-pg-compare__note', 'A comparison, not a grade: another chart can solve the exercise its own way, and one run of inputs cannot show that a chart is right. Check what the exercise asks for, too.'))
        panel.replaceChildren(...parts)
        return c
    }

    /** Puts the comparison's inputs in the simulation panel, at the first tick that differs. */
    private replayComparison(c: Comparison) {
        const sol = this.solution
        if (!sol) return
        const first = c.differences[0]
        const ticks = sol.scenario.ticks.map((t, i) => {
            const diffs = c.differences.filter(d => d.tick === i + 1)
            return { inputs: t.inputs, note: diffs.length ? diffs.map(d => d.message.replace(/^In tick \d+ y/, 'Y')).join(' ') : undefined }
        })
        this.replay = { scenario: { ticks, expect: 'ok' }, ticks: first ? first.tick : 0, kind: 'test' }
        this.sharedRun = undefined
        this.wantTour = true
        $<HTMLDetailsElement>(this.root, '[data-pg-compare]')!.open = false
        this.forceSim()
        this.showTab('sim')
        this.toast(first ? `The simulator shows tick ${first.tick} of the test run, where your outputs first differ.` : 'The simulator replays the test run: press Next.')
    }

    // ----- The exercise's task -----------------------------------------------------------------------------------
    //
    // A TryIt link (&solution=) shows the exercise above the editor: its title and task, as on the guide's page
    // (exercises.ts collects them at build time), with a link back to that section. It folds to its title row; the
    // choice is remembered (folded on a phone at first). For an exercise whose starter already behaves as the model
    // solution (one that asks for a new structure), "This is still the starter" says so while the chart is unchanged.

    private static readonly TASK_KEY = 'sccharts-guide:playground:task-open'

    private allExercises(): Exercise[] {
        try {
            return JSON.parse($(this.root, '[data-pg-exercises]')?.textContent ?? '[]') as Exercise[]
        } catch {
            return []
        }
    }

    /** Shows the task of the exercise with this model solution (or hides the banner). */
    private showTask(solution: string | undefined) {
        const box = $(this.root, '[data-pg-task]')
        if (!box) return
        const ex = exerciseFor(this.allExercises(), this.origin.id, solution)
        this.exercise = ex ? { ex } : undefined
        const was = box.hidden
        box.hidden = !ex
        if (!ex) {
            if (!was) requestAnimationFrame(() => this.applySimHeight())
            return
        }
        $(box, '[data-pg-task-title]')!.textContent = ex.title
        const text = $(box, '[data-pg-task-text]')!
        text.innerHTML = ex.task
        $(box, '[data-pg-task-page]')!.textContent = ex.page
        const back = $<HTMLAnchorElement>(box, '[data-pg-task-back]')!
        back.href = ex.href
        back.title = `The exercise on the guide's page ${ex.page}`
        const toggle = $<HTMLButtonElement>(box, '[data-pg-task-toggle]')!
        let open = !matchMedia('(max-width: 40rem)').matches
        try {
            const saved = localStorage.getItem(Playground.TASK_KEY)
            if (saved) open = saved === 'open'
        } catch {
            // storage blocked: the default
        }
        const set = (on: boolean) => {
            toggle.setAttribute('aria-expanded', String(on))
            box.classList.toggle('is-open', on)
            text.hidden = !on
            // A long task scrolls inside (on a phone): then it is a tab stop, for the keyboard.
            requestAnimationFrame(() => {
                const scrolls = on && text.scrollHeight > text.clientHeight + 1
                if (scrolls) text.tabIndex = 0
                else text.removeAttribute('tabindex')
            })
        }
        set(open)
        // The grid below starts lower now.
        requestAnimationFrame(() => this.applySimHeight())
        if (!toggle.dataset.wired) {
            toggle.dataset.wired = ''
            toggle.addEventListener('click', () => {
                const on = toggle.getAttribute('aria-expanded') !== 'true'
                set(on)
                try {
                    localStorage.setItem(Playground.TASK_KEY, on ? 'open' : 'closed')
                } catch {
                    // not essential
                }
                // The grid below has another height now.
                requestAnimationFrame(() => this.applySimHeight())
            })
        }
        void this.checkStarter()
    }

    /** Finds out whether the exercise's starter already behaves as its model solution (once both are loaded). */
    private async checkStarter() {
        const task = this.exercise
        const sol = this.solution
        if (!task || (task.starter !== undefined && task.starterMatches !== undefined)) return
        if (task.starter === undefined) task.starter = (await loadExampleSource(task.ex.starter)) ?? ''
        if (this.exercise !== task || !sol || sol.id !== task.ex.solution || !task.starter) {
            this.updateTaskState()
            return
        }
        const files = await loadImports(task.ex.starter, task.starter)
        if (this.exercise !== task) return
        const c = compareWithSolution(compile(task.starter, { files }), sol.scenario, sol.recording)
        task.starterMatches = c.status === 'match' && !c.interface.length
        this.updateTaskState()
        if ($<HTMLDetailsElement>(this.root, '[data-pg-compare]')?.open) this.renderComparison()
    }

    /** The reader's chart is the starter of an exercise whose starter already behaves as the model solution. */
    private isStillStarter(): boolean {
        const task = this.exercise
        return !!task?.starterMatches && !!this.view && this.view.state.doc.toString() === task.starter
    }

    private updateTaskState() {
        const pill = $(this.root, '[data-pg-task-starter]')
        if (pill) pill.hidden = !this.isStillStarter()
    }

    // ----- Toolbar actions ---------------------------------------------------------------------------------------

    private setupActions() {
        this.root.addEventListener('click', e => {
            const btn = (e.target as Element).closest<HTMLElement>('[data-action]')
            if (!btn || !this.root.contains(btn) || btn.getAttribute('aria-disabled') === 'true') return
            switch (btn.dataset.action) {
                case 'zoom-in': this.diagram.zoom(1.25); break
                case 'zoom-out': this.diagram.zoom(0.8); break
                case 'fit': this.diagram.fit(); break
                case 'outline': this.toggleOutline(); break
                case 'zoom-reset': this.diagram.actualSize(); break
                case 'download': this.download(); break
                case 'open': this.openFile(); break
                case 'share': void this.share(); break
                case 'share-run': void this.shareRun(); break
                case 'new': this.newChart(); break
                case 'restore': this.restore(); break
                case 'export-svg': void this.exportSvg(); break
                default: return
            }
        })
        const fileInput = $<HTMLInputElement>(this.root, '[data-pg-file]')
        fileInput?.addEventListener('change', async () => {
            const file = fileInput.files?.[0]
            fileInput.value = ''
            if (file) await this.loadFile(file)
        })
    }

    /** The chart's file name for downloads. */
    private fileName() {
        return fileNameFor(this.latest?.result.chart?.name ?? this.good?.result.chart?.name)
    }

    download() {
        const blob = new Blob([this.view.state.doc.toString()], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = this.fileName()
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        this.toast(`Downloaded ${a.download}.`)
    }

    /** The diagram as a standalone SVG file in the light colours. */
    async exportSvg() {
        const svg = this.diagram.svg
        if (!svg) {
            this.toast('There is no diagram to download yet.')
            return
        }
        const name = fileNameFor(svg.getAttribute('data-chart') ?? this.shown?.chart).replace(/\.sctx$/, '.svg')
        const { standaloneSvg } = await import('./export-svg')
        const blob = new Blob([await standaloneSvg(svg)], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        this.toast(`Downloaded ${name}.`)
    }

    openFile() {
        $<HTMLInputElement>(this.root, '[data-pg-file]')?.click()
    }

    private async loadFile(file: File) {
        if (file.size > 2_000_000) {
            this.toast(`${file.name} is too large for the playground.`)
            return
        }
        const text = await file.text()
        this.load(text, { kind: 'file', title: file.name.replace(/\.sctx?$/i, '') }, `Opened ${file.name}.`)
    }

    async share() {
        const url = shareUrl(location.href, this.view.state.doc.toString())
        history.replaceState(history.state, '', url)
        let copied = false
        try {
            await navigator.clipboard.writeText(url)
            copied = true
        } catch {
            copied = false
        }
        const long = url.length > 8000 ? ` It is ${url.length.toLocaleString('en-NZ')} characters long; some chat apps cut long links, so send the .sctx file if it does not open.` : ''
        this.toast((copied ? 'Link copied. It contains the whole chart, so it works without an account.' : 'Copy the link from the address bar: it contains the whole chart.') + long)
    }

    newChart() {
        const text = `scchart MyChart {\n  input bool start\n  output bool running = false\n\n  initial state Idle\n    if start do running = true go to Busy\n\n  state Busy\n    if !start do running = false go to Idle\n}\n`
        this.load(text, { kind: 'new', title: 'New chart' }, 'Started a new chart.')
    }

    restore() {
        this.load(this.loadedText, this.origin, 'Back to the original chart.', this.originTour)
    }

    /** Loads the files the open example imports, then compiles again (the first compile runs without them). */
    private async fetchImports(source: string, scenario?: Scenario) {
        const origin = this.origin
        const id = origin.kind === 'example' || origin.kind === 'default' ? origin.id : undefined
        const files = id ? await loadImports(id, source, scenario) : {}
        if (this.origin !== origin) return
        const had = Object.keys(this.files).length
        this.files = files
        if (had || Object.keys(files).length) {
            this.runCompile(false)
            this.forceSim()
        }
    }

    /** Replaces the source (one undoable change) and starts a fresh simulation. `scenario`: the example's tour;
     *  `link`: the chart comes from the address bar (a shared run of it, the chart of the file it ran; the address
     *  stays as it is). */
    load(text: string, origin: Origin, message?: string, scenario?: Scenario, link?: { run?: SharedRun; chart?: string }) {
        // The reader's last edits go to the scratch buffer first (the address keeps them only until the load).
        this.flushSave(!link)
        const before = { text: this.view.state.doc.toString(), origin: this.origin, loaded: this.loadedText, url: location.href, tour: this.originTour }
        this.files = {}
        this.origin = origin
        this.loadedText = text
        this.setTour(scenario, origin)
        if (link?.run) this.setSharedRun(link.run)
        this.chartChoice = link?.chart
        this.refitNext = true
        this.parsedSinceLoad = false
        replaceText(this.view, text)
        this.runCompile(false)
        this.forceSim()
        this.updateTitle()
        if (this.mode === 'page' && !link) {
            const url = new URL(location.href)
            url.hash = ''
            url.search = this.searchFor(origin)
            if (origin.kind !== 'example') url.hash = hashForSource(text)
            history.replaceState(history.state, '', url)
        }
        if (message) this.toast(message, before.text !== text ? { label: 'Undo', icon: pgIcons.undo, run: () => this.undoLoad(before) } : undefined)
        this.showTab('code')
        void this.fetchImports(text, scenario)
    }

    /** Puts back what was there before a load (the toast's Undo). */
    private undoLoad(before: { text: string; origin: Origin; loaded: string; url: string; tour?: Scenario }) {
        this.flushSave(true)
        this.files = {}
        this.origin = before.origin
        this.loadedText = before.loaded
        this.setTour(before.tour, before.origin)
        this.chartChoice = undefined
        this.refitNext = true
        this.parsedSinceLoad = false
        replaceText(this.view, before.text, 'input.load')
        this.runCompile(false)
        this.forceSim()
        this.updateTitle()
        if (this.mode === 'page') history.replaceState(history.state, '', before.url)
        void this.fetchImports(before.text, before.tour)
    }

    /**
     * Opens the chart of a link followed in this tab (boot.ts: a pasted `#code=` or `#run=`, Back and Forward): as
     * the page opens it on load, with Undo. The reader's edits are in the scratch buffer (saved before the load)
     * and in the entry of the address bar's history they were made in, so Back returns to them too.
     */
    openLink(t: LinkTarget, notice?: string) {
        if (this.mode !== 'page') return
        const edited = this.view.state.doc.toString() !== this.loadedText
        if (t.source === this.view.state.doc.toString() && !t.run) {
            if (notice) this.toast(notice)
            return
        }
        // The exercise of the address: its model solution (the same unless Back crossed into another exercise).
        if (t.solution !== this.solution?.id) {
            this.dropSolution()
            if (t.solution) void this.setupSolution(t.solution)
        }
        const what = t.origin.kind === 'example' || t.origin.kind === 'default' ? t.origin.title : t.origin.kind === 'scratch' ? 'your last chart' : 'the chart in the link'
        const message = notice ?? `Opened ${what}.${edited ? ' Your edits are kept: Back or Undo returns to them.' : ''}`
        this.load(t.source, t.origin, message, t.scenario, { run: t.run, chart: t.chart })
    }

    async loadExample(id: string) {
        const [text, scenario] = await Promise.all([loadExampleSource(id), loadScenario(id)])
        if (text === undefined) {
            this.toast(`There is no example called ${id}.`)
            return
        }
        // Another chart than the exercise's starter: its model solution no longer applies.
        if (this.solution && id !== this.solution.id && id !== this.origin.id) this.dropSolution()
        const origin = this.describe?.(id) ?? { kind: 'example' as const, id, title: firstChartName(text) ?? id }
        this.load(text, origin, `Opened ${origin.title}.`, scenario)
    }

    /** The address bar's query for a chart: its example id, and the exercise's model solution. */
    private searchFor(origin: Origin): string {
        const q = new URLSearchParams()
        if (origin.kind === 'example' && origin.id) q.set('example', origin.id)
        if (this.solution) q.set('solution', this.solution.id)
        const text = q.toString().replace(/%2F/g, '/')
        return text ? `?${text}` : ''
    }

    private updateTitle() {
        const edited = !!this.view && this.view.state.doc.toString() !== this.loadedText
        const title = $(this.root, '[data-pg-title]')
        if (title) {
            const name = $(title, '[data-pg-title-name]')
            const page = $<HTMLAnchorElement>(title, '[data-pg-title-page]')
            const mark = $(title, '[data-pg-title-edited]')
            if (name) {
                name.textContent = this.origin.title
                // A chart's or a file's name is an identifier (monospaced); "Shared chart" is not.
                name.classList.toggle('is-prose', this.origin.kind === 'shared' || this.origin.kind === 'scratch' || this.origin.kind === 'new')
            }
            if (page) {
                page.hidden = !this.origin.page
                if (this.origin.page) {
                    page.textContent = this.origin.page.title
                    if (this.origin.page.href) page.href = this.origin.page.href
                    else page.removeAttribute('href')
                }
            }
            if (mark) mark.hidden = !edited
        }
        const restore = $(this.root, '[data-action="restore"]')
        if (restore) restore.hidden = !edited
        this.updateTaskState()
        // The inline playground's "Open in the playground" carries the edited source.
        if (this.mode === 'embed') {
            const open = this.root.querySelector<HTMLAnchorElement>('.sc-frame__open')
            if (open) {
                if (!open.dataset.original) open.dataset.original = open.getAttribute('href') ?? '/playground/'
                open.href = edited ? `/playground/${hashForSource(this.view.state.doc.toString())}` : open.dataset.original
            }
        }
    }

    // ----- Autosave and the URL ----------------------------------------------------------------------------------

    /** After an edit: the scratch buffer and the address bar get the source, after a pause in typing. */
    private scheduleSave() {
        if (this.mode !== 'page') return
        clearTimeout(this.saveTimer)
        this.savePending = true
        this.saveTimer = setTimeout(() => this.flushSave(true), SAVE_DELAY)
    }

    /** Saves edits not saved yet: in the scratch buffer, and (`url`) in the address bar's entry. */
    private flushSave(url: boolean) {
        clearTimeout(this.saveTimer)
        if (!this.savePending) return
        this.savePending = false
        const text = this.view.state.doc.toString()
        storageSet(SCRATCH_KEY, text)
        if (!url || text === this.loadedText) return
        const next = new URL(location.href)
        // An edited exercise keeps its model solution (a reload can still compare).
        next.search = this.solution ? `?solution=${this.solution.id}` : ''
        next.hash = hashForSource(text)
        history.replaceState(history.state, '', next)
    }

    private savePending = false

    // ----- Phone tabs, splitter, drop, keys --------------------------------------------------------------------

    private isNarrow() {
        return this.mode === 'page' && matchMedia('(max-width: 59.99rem)').matches
    }

    showTab(tab: string) {
        if (this.mode === 'page') showTab(this.root, tab)
    }

    private setupSplitter() {
        const grid = $(this.root, '[data-pg-grid]')
        if (!grid) return
        const split = $(this.root, '[data-pg-split]')
        const hsplit = $(this.root, '[data-pg-hsplit]')
        if (split) {
            this.splitter(grid, split, {
                key: 'sccharts-guide:playground:split',
                axis: 'x',
                min: 0.2,
                max: 0.8,
                initial: 0.48,
                apply: f => grid.style.setProperty('--pg-split', `${(f * 100).toFixed(2)}%`),
                at: ev => {
                    const r = grid.getBoundingClientRect()
                    return (ev.clientX - r.left) / r.width
                },
            })
        }
        if (hsplit) this.setupSimHeight(grid, hsplit)
    }

    // ----- The simulation's height (desktop) ------------------------------------------------------------------
    //
    // By default the simulation panel is as tall as its controls and its timing diagram, so every lane is in view
    // (up to 36rem; more scrolls inside). The editor and the diagram open with MAIN_SHARE of the first screen (at
    // least 18rem), tall enough to show a chart whole; when the screen is too short for both, the page grows.
    // Dragging the splitter above the panel (or its arrow keys) sets a height of the reader's own, remembered (the
    // editor and the diagram may then shrink to 18rem); a double click (or Enter on it) goes back to fitting.

    private simUser?: number
    private simNeed = 0
    private simObserver?: ResizeObserver
    private static readonly SIM_KEY = 'sccharts-guide:playground:sim-height'
    /** The share of the first screen the editor and the diagram open with (playground.css has the same number). */
    private static readonly MAIN_SHARE = 0.62

    private rem() {
        return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    }

    /** The grid's height when the app just fills the screen (without the growth the simulation may cause). */
    private gridFill() {
        const grid = $(this.root, '[data-pg-grid]')
        const fill = parseFloat(getComputedStyle(this.root).minHeight) || 0
        return grid ? fill - (grid.getBoundingClientRect().top - this.root.getBoundingClientRect().top) : 0
    }

    /** The editor's and the diagram's least height: 18rem, and while the simulation fits its content, MAIN_SHARE of
     *  the first screen, so that they open tall enough to show a chart whole (the page grows for the simulation). */
    private mainMin(fitted: boolean) {
        const rem = this.rem()
        return fitted ? Math.max(18 * rem, Math.round(Playground.MAIN_SHARE * this.gridFill())) : 18 * rem
    }

    /** The simulation's height limits: [min, the most the default may take, the most the splitter may set]. */
    private simLimits(): [number, number, number] {
        const rem = this.rem()
        const room = this.gridFill() - this.mainMin(false) - 0.375 * rem - 0.5 * rem
        return [8 * rem, 36 * rem, Math.max(36 * rem, this.simNeed, room)]
    }

    private applySimHeight() {
        const grid = $(this.root, '[data-pg-grid]')
        const handle = $(this.root, '[data-pg-hsplit]')
        if (!grid) return
        const [min, autoMax, max] = this.simLimits()
        const fitted = this.simUser === undefined
        const h = Math.round(fitted ? Math.min(autoMax, Math.max(min, this.simNeed)) : Math.min(max, Math.max(min, this.simUser!)))
        grid.style.setProperty('--pg-main-min', `${this.mainMin(fitted)}px`)
        if (!this.simNeed && fitted) grid.style.removeProperty('--pg-sim-h')
        else grid.style.setProperty('--pg-sim-h', `${h}px`)
        if (handle) {
            const total = grid.getBoundingClientRect().height || 1
            handle.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round((h / total) * 100)))))
            handle.setAttribute('aria-valuetext', `Simulation ${h} pixels high${fitted ? ', fitted to its content' : ''}`)
        }
    }

    /** What the panel needs: its head, the controls and the timing diagram (or the list of errors). */
    private measureSim() {
        const panel = $(this.root, '[data-pg-sim-panel]')
        const body = $(this.root, '[data-pg-sim]')
        if (!panel || !body) return
        const head = panel.querySelector<HTMLElement>(':scope > .sc-pg__head')
        const vars = panel.querySelector<HTMLElement>(':scope > [data-pg-vars]')
        const sim = body.querySelector<HTMLElement>('.sc-sim')
        let content: number
        if (sim?.dataset.state === 'ready') {
            content = ['.sc-sim__controls', '.sc-sim__trace'].reduce((n, sel) => n + (sim.querySelector<HTMLElement>(`:scope > ${sel}`)?.offsetHeight ?? 0), 0)
        } else {
            content = (sim ?? (body.firstElementChild as HTMLElement | null))?.offsetHeight ?? 0
        }
        if (!content) return
        const need = (head?.offsetHeight ?? 0) + (vars?.offsetHeight ?? 0) + content + 2
        if (Math.abs(need - this.simNeed) < 1) return
        this.simNeed = need
        this.applySimHeight()
    }

    /** Watches the panel's parts (SimPanel replaces them when it mounts again). */
    private observeSim() {
        const body = $(this.root, '[data-pg-sim]')
        if (!body || typeof ResizeObserver === 'undefined') return
        this.simObserver?.disconnect()
        const ro = new ResizeObserver(() => {
            // The panel's blocks change with the chart (controls, trace) and when it is rejected (errors).
            const sim = body.querySelector('.sc-sim')
            for (const el of sim ? [sim, ...sim.children] : [...body.children]) ro.observe(el)
            this.measureSim()
        })
        this.simObserver = ro
        ro.observe(body.querySelector('.sc-sim') ?? body.firstElementChild ?? body)
        // The head too: its note and Rebuild can wrap to a second row; and the variables strip under it.
        const head = $(this.root, '[data-pg-sim-panel] > .sc-pg__head')
        if (head) ro.observe(head)
        const vars = $(this.root, '[data-pg-sim-panel] > [data-pg-vars]')
        if (vars) ro.observe(vars)
    }

    private setupSimHeight(grid: HTMLElement, handle: HTMLElement) {
        try {
            const saved = Number(localStorage.getItem(Playground.SIM_KEY))
            if (saved > 0) this.simUser = saved
        } catch {
            // storage blocked: fit the content
        }
        handle.setAttribute('aria-valuemin', '0')
        handle.setAttribute('aria-valuemax', '100')
        const current = () => parseFloat(grid.style.getPropertyValue('--pg-sim-h')) || $(this.root, '[data-pg-sim-panel]')?.getBoundingClientRect().height || this.simNeed
        const set = (h: number | undefined, save = true) => {
            const [min, , max] = this.simLimits()
            this.simUser = h === undefined ? undefined : Math.min(max, Math.max(min, h))
            this.applySimHeight()
            if (!save) return
            try {
                if (this.simUser === undefined) localStorage.removeItem(Playground.SIM_KEY)
                else localStorage.setItem(Playground.SIM_KEY, String(Math.round(this.simUser)))
            } catch {
                // not essential
            }
        }
        handle.addEventListener('pointerdown', e => {
            e.preventDefault()
            handle.setPointerCapture(e.pointerId)
            grid.classList.add('is-resizing-y')
            // Relative to where the drag started, so a page that grows under the pointer does not feed back.
            const start = { y: e.clientY, h: current() }
            const move = (ev: PointerEvent) => set(start.h + (start.y - ev.clientY), false)
            const up = (ev: PointerEvent) => {
                if (Math.abs(ev.clientY - start.y) > 2) set(start.h + (start.y - ev.clientY))
                grid.classList.remove('is-resizing-y')
                handle.removeEventListener('pointermove', move)
                handle.removeEventListener('pointerup', up)
                handle.removeEventListener('pointercancel', up)
                this.view.requestMeasure()
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
        })
        handle.addEventListener('dblclick', () => set(undefined))
        handle.addEventListener('keydown', e => {
            const [min, , max] = this.simLimits()
            const step = e.shiftKey ? 96 : 32
            let h: number | undefined | null = null
            // Up makes the simulation taller.
            if (e.key === 'ArrowUp') h = current() + step
            else if (e.key === 'ArrowDown') h = current() - step
            else if (e.key === 'Home') h = min
            else if (e.key === 'End') h = max
            else if (e.key === 'Enter') h = undefined
            if (h === null) return
            e.preventDefault()
            set(h)
        })
        window.addEventListener('resize', () => this.applySimHeight())
        this.applySimHeight()
    }

    private splitter(
        grid: HTMLElement,
        handle: HTMLElement,
        o: { key: string; axis: 'x' | 'y'; min: number; max: number; initial: number; apply: (f: number) => void; at: (e: PointerEvent) => number; invertKeys?: boolean },
    ) {
        const set = (fraction: number) => {
            const f = Math.max(o.min, Math.min(o.max, fraction))
            o.apply(f)
            handle.setAttribute('aria-valuenow', String(Math.round(f * 100)))
            return f
        }
        const save = (f: number) => {
            try {
                localStorage.setItem(o.key, String(f))
            } catch {
                // not essential
            }
        }
        try {
            const saved = Number(localStorage.getItem(o.key))
            if (saved > 0) set(saved)
        } catch {
            // storage blocked: the default
        }
        const cls = o.axis === 'x' ? 'is-resizing-x' : 'is-resizing-y'
        handle.addEventListener('pointerdown', e => {
            e.preventDefault()
            handle.setPointerCapture(e.pointerId)
            grid.classList.add(cls)
            const move = (ev: PointerEvent) => set(o.at(ev))
            const up = (ev: PointerEvent) => {
                save(set(o.at(ev)))
                grid.classList.remove(cls)
                handle.removeEventListener('pointermove', move)
                handle.removeEventListener('pointerup', up)
                handle.removeEventListener('pointercancel', up)
                this.view.requestMeasure()
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
        })
        handle.addEventListener('dblclick', () => save(set(o.initial)))
        handle.addEventListener('keydown', e => {
            const now = Number(handle.getAttribute('aria-valuenow') ?? o.initial * 100) / 100
            const dec = o.axis === 'x' ? 'ArrowLeft' : o.invertKeys ? 'ArrowDown' : 'ArrowUp'
            const inc = o.axis === 'x' ? 'ArrowRight' : o.invertKeys ? 'ArrowUp' : 'ArrowDown'
            let f: number | undefined
            if (e.key === dec) f = now - 0.05
            else if (e.key === inc) f = now + 0.05
            else if (e.key === 'Home') f = o.min
            else if (e.key === 'End') f = o.max
            if (f === undefined) return
            e.preventDefault()
            save(set(f))
        })
    }

    private setupDrop() {
        const zone = $(this.root, '[data-pg-editor]')
        if (!zone) return
        zone.addEventListener('dragover', e => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault()
                zone.classList.add('is-drop')
            }
        })
        zone.addEventListener('dragleave', () => zone.classList.remove('is-drop'))
        zone.addEventListener(
            'drop',
            e => {
                zone.classList.remove('is-drop')
                const file = e.dataTransfer?.files?.[0]
                if (!file) return
                e.preventDefault()
                e.stopPropagation()
                void this.loadFile(file)
            },
            true,
        )
    }

    private setupGlobalKeys() {
        document.addEventListener('keydown', e => {
            if (e.defaultPrevented) return
            const mod = isMac ? e.metaKey : e.ctrlKey
            const inField = (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
            if (mod && !e.altKey && e.key.toLowerCase() === 's' && !e.shiftKey) {
                e.preventDefault()
                this.download()
            } else if (mod && !e.altKey && e.key.toLowerCase() === 's' && e.shiftKey) {
                e.preventDefault()
                void this.share()
            } else if (mod && !e.altKey && e.key.toLowerCase() === 'o' && !e.shiftKey) {
                e.preventDefault()
                this.openFile()
            } else if (mod && e.key === 'Enter' && !inField) {
                e.preventDefault()
                if (e.shiftKey) this.rebuild()
                else this.sim?.step()
            } else if (e.key === '?' && !mod && !e.altKey && !inField && !(e.target as Element | null)?.closest?.('.cm-editor')) {
                const help = $<HTMLDetailsElement>(this.root, '[data-pg-help]')
                if (help) {
                    e.preventDefault()
                    help.open = !help.open
                }
            }
        })
    }

    // ----- Toast -------------------------------------------------------------------------------------------------

    toast(message: string, action?: { label: string; run: () => void; icon?: string }) {
        const box = $(this.root, '[data-pg-toast]')
        if (!box) return
        clearTimeout(this.toastTimer)
        box.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }))
        if (action) {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = 'sc-pg-toast__action'
            b.innerHTML = `${action.icon ?? ''}<span>${escapeHtml(action.label)}</span>`
            b.addEventListener('click', () => {
                action.run()
                box.hidden = true
            })
            box.append(b)
        }
        box.hidden = false
        this.toastTimer = setTimeout(() => (box.hidden = true), action ? 7000 : 4000)
    }
}

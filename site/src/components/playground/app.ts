// The playground's controller: ties the project, the editor, the compiler, the live diagram and the simulation
// together, for /playground and for the inline <Playground> on guide pages. Loaded lazily by boot.ts once the page
// has painted (CodeMirror, the engine and ELK's client are in this chunk's imports; ELK itself runs in a worker).
//
//   edit ──debounce──► compile (the active file, with the files it imports)
//                          ├──► problems: squiggles, the status, the list, is-error in the diagram   (problems.ts)
//                          ├──► layout (worker, latest wins) ──► diagram                              (diagram-control.ts)
//                          └──► simulation: live until the first step, then Rebuild                   (sim-control.ts)
//
// Offsets: every compile, layout and simulation keeps a DocTracker, so a click in a diagram that is a few keystrokes
// old still selects the right text. The parts: the project and its files (project-control.ts), the bottom panel and
// its tabs (panel.ts, panel-tabs.ts), the workspace's splitters (workspace.ts), the actions and keys
// (file-actions.ts), exercises (exercise.ts). What tabs and Svelte parts read is in `model` (model.svelte.ts).
// README.md describes each feature.

import type { ViewUpdate } from '@codemirror/view'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { compile } from '@sccharts-lab/engine'
import { $, isSyntaxBroken, type Analysed, type LinkTarget, type Origin, type PlaygroundInit, type ProjectSpec } from './app-types'
import { DiagramControl } from './diagram-control'
import { DocTracker, createEditor, selectRange, setMarks, tabThrough, type Marks } from './editor'
import type { AnalysisView } from './editor-features'
import { ExerciseControl } from './exercise'
import { FileActions } from './file-actions'
import { firstChartName } from './catalogue'
import { pgIcons } from './icons'
import { PlaygroundModel } from './model.svelte'
import { BottomPanel } from './panel'
import { Problems } from './problems'
import { exampleProject, sameFiles } from './project'
import { ProjectControl } from './project-control'
import { setupProjectMenu } from './project-menu'
import { setCurrent, type StoredProject } from './project-store'
import { hashForProject, hashForSource } from './share'
import { SimControl } from './sim-control'
import { loadExampleSource, loadImports, loadScenario } from './sources'
import { showTab } from './tabs'
import { Toast, type ToastAction } from './toast'
import { Workspace } from './workspace'
import type { Scenario } from '../frame/examples'

export type { LinkTarget, Origin, PlaygroundInit, ProjectSpec } from './app-types'
export { MOD } from './app-types'

const COMPILE_DELAY = 180

/** A short key of the files a compile imports (a run is stale when they change). */
function depsKey(files: Record<string, string>): string {
    let h = 2166136261
    for (const [k, v] of Object.entries(files)) for (const s of [k, v]) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return `${Object.keys(files).length}:${(h >>> 0).toString(36)}`
}

export class Playground {
    readonly root: HTMLElement
    readonly mode: 'page' | 'embed'
    view!: EditorView
    /** What the Svelte parts and the bottom panel's tabs read. */
    readonly model = new PlaygroundModel()
    readonly project: ProjectControl
    readonly sim: SimControl
    readonly problems: Problems
    diagram!: DiagramControl
    exercise?: ExerciseControl
    panel?: BottomPanel
    workspace?: Workspace
    actions!: FileActions
    origin: Origin
    latest?: Analysed
    /** The newest compile that parsed (completion and hover read it while the text has a syntax error). */
    good?: Analysed
    /** The chart of the file to show and simulate, when not the first. */
    chartChoice?: string
    /** The text has parsed since the file was loaded or shown (until then a diagram on the stage is another's). */
    parsedSinceLoad = false
    marks: Marks = {}
    private describe?: (id: string) => Origin | undefined
    private toaster: Toast
    /** Every tracker, with the file it follows (only the active file's get the editor's changes). */
    private trackers = new Map<DocTracker, string>()
    private compileTimer?: ReturnType<typeof setTimeout>

    constructor(init: PlaygroundInit) {
        this.root = init.root
        this.mode = init.mode
        this.origin = init.origin
        this.describe = init.describe
        this.root.dataset.pgReady = ''
        this.toaster = new Toast(this.root)
        this.project = new ProjectControl(this, init.project)
        if (this.mode === 'page') this.exercise = new ExerciseControl(this)
        this.sim = new SimControl(this)
        this.problems = new Problems(this)
        this.sim.setTour(init.scenario, init.origin)
        if (init.run) this.sim.setSharedRun(init.run)
        this.chartChoice = init.chart
        this.setupEditor(this.project.text(this.project.active))
        this.diagram = new DiagramControl(this, init.diagram)
        if (this.mode === 'page') {
            const panel = $(this.root, '[data-pg-panel]')
            if (panel) this.panel = new BottomPanel(this, panel)
            this.workspace = new Workspace(this)
            this.project.mountUi()
            setupProjectMenu(this)
            this.workspace.applyFiles()
        }
        this.actions = new FileActions(this)
        this.updateTitle()
        this.runCompile(true)
        void this.problems.fetchRecording()
        if (init.solution && this.exercise) void this.exercise.setup(init.solution)
        if (this.project.folder?.handle) void this.project.checkFolder(false)
        // A handle for tests and for poking around in the console.
        ;(this.root as HTMLElement & { playground?: Playground }).playground = this
    }

    /** Resolves once the simulation panel is mounted (the inline playground then replays a click held before). */
    simulationReady(): Promise<void> {
        return this.sim.whenReady()
    }

    /** The example that is open (for the menu's current item). */
    get currentExample(): string | undefined {
        return this.origin.kind === 'example' || this.origin.kind === 'default' ? this.origin.id : undefined
    }

    // ----- Editor ----------------------------------------------------------------------------------------------------

    private setupEditor(source: string) {
        const host = $(this.root, '[data-pg-editor]')!
        host.replaceChildren()
        const keys: KeyBinding[] = [
            { key: 'Mod-Enter', run: () => (this.sim.step(), true), preventDefault: true },
            { key: 'Mod-Shift-Enter', run: () => (this.sim.rebuild(), true), preventDefault: true },
        ]
        if (this.mode === 'page') {
            keys.push(
                { key: 'Mod-s', run: () => (void this.actions.save(), true), preventDefault: true },
                { key: 'Mod-o', run: () => (this.actions.chooseFiles(), true), preventDefault: true },
                { key: 'Mod-Shift-s', run: () => (void this.actions.share(), true), preventDefault: true },
            )
        }
        this.view = createEditor(host, {
            doc: source,
            analysis: () => this.analysisView(),
            values: () => this.sim.values(),
            onUpdate: u => this.onEditorUpdate(u),
            keys,
            label: 'SCTX source',
            compact: this.mode === 'embed',
        })
        if (this.mode === 'embed') tabThrough(this.view)
    }

    private onEditorUpdate(u: ViewUpdate) {
        if (u.docChanged) {
            const active = this.project.active
            for (const [t, file] of this.trackers) if (file === active) t.add(u.changes)
            clearTimeout(this.compileTimer)
            this.compileTimer = setTimeout(() => this.runCompile(false), COMPILE_DELAY)
            this.project.typed()
            this.updateTitle()
        }
        if (u.selectionSet || u.docChanged) {
            this.updateCursor()
            this.diagram.followCursor()
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

    setMarks(m: Marks) {
        Object.assign(this.marks, m)
        setMarks(this.view, this.marks)
    }

    // ----- Compile ---------------------------------------------------------------------------------------------------

    runCompile(initial: boolean) {
        clearTimeout(this.compileTimer)
        const doc = this.view.state.doc
        const source = doc.toString()
        const file = this.project.active
        const files = this.project.imports()
        let result = compile(source, { files })
        if (this.chartChoice && this.chartChoice !== result.chart?.name && result.program?.charts.some(c => c.name === this.chartChoice)) {
            result = compile(source, { chart: this.chartChoice, files })
        }
        const tracker = new DocTracker(doc)
        this.trackers.set(tracker, file)
        const analysed: Analysed = { result, tracker, file, deps: depsKey(files) }
        this.latest = analysed
        if (!isSyntaxBroken(result)) {
            this.good = analysed
            this.parsedSinceLoad = true
        }
        this.model.compiled = { file, source, result }
        this.problems.show(analysed)
        this.diagram.update(analysed)
        this.sim.follow(analysed, initial)
        if (this.exercise?.comparing) this.exercise.render()
        this.exercise?.updateState()
        this.pruneTrackers()
    }

    /** Drops trackers nothing refers to any more. */
    pruneTrackers() {
        const live = new Set([this.latest?.tracker, this.good?.tracker, this.sim.analysed?.tracker, ...this.diagram.trackers()].filter(Boolean) as DocTracker[])
        for (const t of this.trackers.keys()) if (!live.has(t)) this.trackers.delete(t)
    }

    /** Another file is in the editor (shown, loaded, or read again from disk): everything follows it. The simulation
     *  keeps a run under way (Rebuild switches it); before the first step it follows too. */
    fileSwitched() {
        clearTimeout(this.compileTimer)
        this.latest = this.good = undefined
        this.diagram.forgetSource()
        this.parsedSinceLoad = false
        this.chartChoice = undefined
        this.marks = {}
        this.runCompile(false)
        this.updateTitle()
        this.updateCursor()
    }

    // ----- Loading ---------------------------------------------------------------------------------------------------

    /** Opens a project in place of this one and starts a fresh simulation. `scenario`: the example's tour; `link`: it
     *  comes from the address bar (a shared run of it, the chart of the file it ran; the address stays as it is). */
    loadProject(spec: ProjectSpec, origin: Origin, message?: string, scenario?: Scenario, link?: { run?: LinkTarget['run']; chart?: string }) {
        // The reader's last edits are saved first (the address keeps them only until the load).
        this.project.flush(!link)
        const before = { spec: this.project.snapshot(), origin: this.origin, url: location.href, tour: this.sim.originTour }
        const changed = !sameFiles(before.spec.files, spec.files)
        this.origin = origin
        this.project.replace(spec)
        if (spec.id) setCurrent(spec.id)
        this.sim.setTour(scenario, origin)
        if (link?.run) this.sim.setSharedRun(link.run)
        this.latest = this.good = undefined
        this.trackers.clear()
        this.diagram.forgetSource()
        this.parsedSinceLoad = false
        this.chartChoice = link?.chart
        this.marks = {}
        this.runCompile(false)
        this.sim.force()
        this.updateTitle()
        if (this.mode === 'page' && !link) {
            const url = new URL(location.href)
            url.hash = ''
            url.search = this.searchFor(origin)
            if (origin.kind !== 'example' && !spec.folder) url.hash = hashForProject({ name: spec.name, files: spec.files, active: this.project.active })
            history.replaceState(history.state, '', url)
        }
        if (message) this.toast(message, changed ? { label: 'Undo', icon: pgIcons.undo, run: () => this.undoLoad(before) } : undefined)
        this.showTab('code')
        void this.problems.fetchRecording()
        this.workspace?.applyFiles()
    }

    /** Puts back what was there before a load (the toast's Undo). */
    private undoLoad(before: { spec: ProjectSpec; origin: Origin; url: string; tour?: Scenario }) {
        this.loadProject(before.spec, before.origin, undefined, before.tour)
        if (this.mode === 'page') history.replaceState(history.state, '', before.url)
    }

    /** A project the reader saved in this browser (the recent projects). */
    openStored(p: StoredProject) {
        const origin: Origin = p.folder ? { kind: 'folder', title: p.name } : { kind: 'scratch', title: p.name }
        this.loadProject({ name: p.name, files: p.files, active: p.active, open: p.open, id: p.id, folder: p.folder }, origin, `Opened ${p.name}.`)
    }

    /** Back to the project as it was loaded. */
    restore() {
        const p = this.project
        this.loadProject({ name: p.name, files: { ...p.loaded }, active: p.mainFile, id: p.id, folder: p.folder && { name: p.folder.name, handle: p.folder.handle, disk: p.folder.disk } }, this.origin, 'Back to the original chart.', this.sim.originTour)
    }

    /**
     * Opens the chart of a link followed in this tab (boot.ts: a pasted `#code=` or `#run=`, Back and Forward): as
     * the page opens it on load, with Undo. The reader's edits are saved (in the browser and the scratch buffer)
     * before the load, and in the entry of the address bar's history they were made in, so Back returns to them too.
     */
    openLink(t: LinkTarget, notice?: string) {
        if (this.mode !== 'page') return
        const edited = this.project.edited()
        if (sameFiles(t.project.files, this.project.texts()) && !t.run) {
            if (notice) this.toast(notice)
            return
        }
        // The exercise of the address: its model solution (the same unless Back crossed into another exercise).
        if (t.solution !== this.exercise?.solution?.id) {
            this.exercise?.drop()
            if (t.solution) void this.exercise?.setup(t.solution)
        }
        const what = t.origin.kind === 'example' || t.origin.kind === 'default' ? t.origin.title : t.origin.kind === 'scratch' ? 'your last chart' : 'the chart in the link'
        const message = notice ?? `Opened ${what}.${edited ? ' Your edits are kept: Back or Undo returns to them.' : ''}`
        this.loadProject(t.project, t.origin, message, t.scenario, { run: t.run, chart: t.chart })
    }

    async loadExample(id: string) {
        const [text, scenario] = await Promise.all([loadExampleSource(id), loadScenario(id)])
        if (text === undefined) {
            this.toast(`There is no example called ${id}.`)
            return
        }
        const files = await loadImports(id, text, scenario)
        // Another chart than the exercise's starter: its model solution no longer applies.
        const sol = this.exercise?.solution
        if (sol && id !== sol.id && id !== this.origin.id) this.exercise!.drop()
        const origin = this.describe?.(id) ?? { kind: 'example' as const, id, title: firstChartName(text) ?? id }
        this.loadProject(exampleProject(id, text, files, origin.title), origin, `Opened ${origin.title}.`, scenario)
    }

    /** The address bar's query for a chart: its example id, and the exercise's model solution. */
    private searchFor(origin: Origin): string {
        const q = new URLSearchParams()
        if (origin.kind === 'example' && origin.id) q.set('example', origin.id)
        if (this.exercise?.solution) q.set('solution', this.exercise.solution.id)
        const text = q.toString().replace(/%2F/g, '/')
        return text ? `?${text}` : ''
    }

    updateTitle() {
        const edited = !!this.view && this.project.edited()
        const title = $(this.root, '[data-pg-title]')
        if (title) {
            const name = $(title, '[data-pg-title-name]')
            const page = $<HTMLAnchorElement>(this.root, '[data-pg-title-page]')
            const mark = $(title, '[data-pg-title-edited]')
            if (name) {
                name.textContent = this.project.name
                // A chart's or a file's name is an identifier (monospaced); "Shared chart" is not.
                name.classList.toggle('is-prose', !/^[\w.-]+$/.test(this.project.name))
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
        for (const restore of this.root.querySelectorAll<HTMLElement>('[data-action="restore"]')) restore.hidden = !edited
        this.exercise?.updateState()
        // The inline playground's "Open in the playground" carries the edited source.
        if (this.mode === 'embed') {
            const open = this.root.querySelector<HTMLAnchorElement>('.sc-frame__open')
            if (open) {
                if (!open.dataset.original) open.dataset.original = open.getAttribute('href') ?? '/playground/'
                open.href = edited ? `/playground/${hashForSource(this.view.state.doc.toString())}` : open.dataset.original
            }
        }
    }

    // ----- Shared services -------------------------------------------------------------------------------------------

    /** Selects a range of a file in the editor (offsets in its text now), showing the file. */
    reveal(path: string, from: number, to = from) {
        this.project.switchTo(path, false)
        selectRange(this.view, from, to, true)
        this.showTab('code')
    }

    isNarrow() {
        return this.mode === 'page' && matchMedia('(max-width: 59.99rem)').matches
    }

    showTab(tab: string) {
        if (this.mode === 'page') showTab(this.root, tab)
    }

    toast(message: string, action?: ToastAction) {
        this.toaster.show(message, action)
    }
}

// The open project (project.ts is its model): its files, each with its own editor state (undo history, selection)
// while the project is open, the active one in the editor; the tabs; new, rename and delete; and saving. Every edit
// is saved after a pause in typing: in the browser (IndexedDB, project-store.ts, under the project's id, given on
// its first edit, so that loading an example never overwrites the reader's work), in the scratch buffer of local
// storage (the active file's text, which also works without IndexedDB), and in the address bar (#code= for one file,
// #project= for several), so a reload never loses work. A project from a folder on disk saves back into it on
// Ctrl/⌘+S (folder.ts); its unsaved files are marked.

import type { EditorState } from '@codemirror/state'
import { mount } from 'svelte'
import { $, type ProjectSpec } from './app-types'
import { stateFor } from './editor'
import { permitted, readFolder, removeFile, writeFile } from './folder'
import { baseOf, checkName, freeName, importedFiles, makeProject, sameFiles, sortedPaths } from './project'
import { newProjectId, putProject, setCurrent, type StoredProject } from './project-store'
import { hashForProject, SCRATCH_KEY, storageSet } from './share'
import { pgIcons } from './icons'
import FileTree from './FileTree.svelte'
import FileTabs from './FileTabs.svelte'
import type { Playground } from './app'

const SAVE_DELAY = 400

export class ProjectControl {
    name = ''
    /** Its key in the browser's store, once it has been saved there. */
    id?: string
    active = ''
    open: string[] = []
    /** The file that was active when the project was loaded (an example's own chart; its recording is of it). */
    mainFile = ''
    /** The files as loaded (Revert, the "edited" mark). */
    loaded: Record<string, string> = {}
    folder?: { name: string; handle?: FileSystemDirectoryHandle; disk: Record<string, string>; connected: boolean }
    private files: Record<string, string> = {}
    private states = new Map<string, EditorState>()
    private saveTimer?: ReturnType<typeof setTimeout>
    private publishTimer?: ReturnType<typeof setTimeout>
    private pending = false

    constructor(private pg: Playground, spec: ProjectSpec) {
        this.set(spec)
    }

    /** Every file, sorted as a file explorer lists them. */
    get paths(): string[] {
        return sortedPaths(Object.keys(this.files))
    }

    /** A file's text now: the active file's from the editor; the others' as they were when last shown (a file is
     *  edited only while it is active, and its text is kept when another file is shown). */
    text(path: string): string {
        if (path === this.active && this.pg.view) return this.pg.view.state.doc.toString()
        return this.files[path] ?? ''
    }

    /** Every file's text now. */
    texts(): Record<string, string> {
        const out: Record<string, string> = {}
        for (const p of Object.keys(this.files)) out[p] = this.text(p)
        return out
    }

    syncActive() {
        if (this.active && this.pg.view) this.files[this.active] = this.pg.view.state.doc.toString()
    }

    /** What `compile` gets for the active file: the files it imports, transitively, as KIELER sees them. */
    imports(): Record<string, string> {
        return importedFiles(this.texts(), this.active)
    }

    /** The project differs from what was loaded (a file's text, or the files). */
    edited(): boolean {
        return !sameFiles(this.texts(), this.loaded)
    }

    /** A folder project's files whose text is not what the folder holds. */
    unsaved(): string[] {
        const disk = this.folder?.disk
        return disk ? this.paths.filter(p => disk[p] !== this.text(p)) : []
    }

    snapshot(): ProjectSpec {
        return { name: this.name, files: this.texts(), active: this.active, open: [...this.open], id: this.id, folder: this.folder && { name: this.folder.name, handle: this.folder.handle, disk: { ...this.folder.disk } } }
    }

    private set(spec: ProjectSpec) {
        const p = makeProject(spec.name, { ...spec.files }, spec.active, spec.open)
        this.name = p.name
        this.files = p.files
        this.active = p.active
        this.mainFile = p.active
        this.open = p.open
        this.id = spec.id
        this.loaded = { ...p.files }
        this.folder = spec.folder ? { ...spec.folder, disk: { ...spec.folder.disk }, connected: false } : undefined
        this.states.clear()
    }

    /** Opens another project (the controller's load); the editor gets its active file. */
    replace(spec: ProjectSpec) {
        clearTimeout(this.saveTimer)
        this.pending = false
        this.set(spec)
        const view = this.pg.view
        view.setState(stateFor(view, this.files[this.active] ?? ''))
        if (this.folder?.handle) void this.checkFolder(false)
        this.publish()
    }

    /** Mounts the files sidebar and the editor's tabs (/playground). */
    mountUi() {
        const pg = this.pg
        const tree = $(pg.root, '[data-pg-files-tree]')
        const tabs = $(pg.root, '[data-pg-file-tabs]')
        const actions = {
            open: (path: string) => {
                this.switchTo(path)
                // On a phone the files are a sheet over the editor: it closes once a file is chosen.
                if (pg.isNarrow()) pg.workspace?.applyFiles(false)
            },
            close: (path: string) => this.closeTab(path),
            rename: (path: string, name: string) => this.rename(path, name),
            remove: (path: string) => this.remove(path),
            create: (name: string) => this.create(name),
            suggest: () => freeName('untitled', this.paths),
            save: () => void this.saveToFolder(),
            reconnect: () => void this.checkFolder(true),
        }
        if (tree) {
            tree.replaceChildren()
            mount(FileTree, { target: tree, props: { model: pg.model, actions, icons: pgIcons } })
        }
        if (tabs) {
            tabs.replaceChildren()
            mount(FileTabs, { target: tabs, props: { model: pg.model, actions, icons: pgIcons } })
        }
        this.publish()
    }

    /** The model's view of the project (the sidebar, the tabs, and tabs of the bottom panel read it). */
    publish() {
        const pg = this.pg
        const loaded = this.loaded
        pg.model.project = {
            name: this.name,
            files: this.paths,
            active: this.active,
            open: [...this.open],
            unsaved: this.folder ? this.unsaved() : this.paths.filter(p => loaded[p] !== this.text(p)),
            folder: this.folder?.name,
            disconnected: !!this.folder && !this.folder.connected,
        }
    }

    // ----- Files -----------------------------------------------------------------------------------------------------

    /** Shows another file in the editor (its own state: undo history, selection, scroll). */
    switchTo(path: string, focus = true) {
        const pg = this.pg
        if (!(path in this.files)) return
        if (path !== this.active) {
            this.states.set(this.active, pg.view.state)
            this.syncActive()
            this.active = path
            if (!this.open.includes(path)) this.open.push(path)
            pg.view.setState(this.states.get(path) ?? stateFor(pg.view, this.files[path]))
            pg.fileSwitched()
            if (this.id) this.scheduleSave(false)
        }
        this.publish()
        if (focus && !pg.isNarrow()) pg.view.focus()
        if (pg.isNarrow()) pg.showTab('code')
    }

    closeTab(path: string) {
        if (this.open.length < 2 || !this.open.includes(path)) return
        const i = this.open.indexOf(path)
        this.open = this.open.filter(p => p !== path)
        if (path === this.active) this.switchTo(this.open[Math.min(i, this.open.length - 1)])
        this.publish()
    }

    /** A new file from the name typed in the sidebar; an error message when the name will not do. */
    create(input: string): string | undefined {
        const checked = checkName(input, this.paths)
        if ('error' in checked) return checked.error
        const chart = baseOf(checked.path).replace(/\.sctx$/i, '').replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1') || 'Chart'
        this.files[checked.path] = `scchart ${chart[0].toUpperCase()}${chart.slice(1)} {\n  initial state Start\n}\n`
        this.edit()
        this.switchTo(checked.path)
        this.pg.toast(`Created ${checked.path}. Another file uses its charts after import "${checked.path.replace(/\.sctx$/i, '')}".`)
        return undefined
    }

    /** "New file" from a menu: the sidebar opens with the name field. */
    startNewFile() {
        this.pg.workspace?.applyFiles(true)
        requestAnimationFrame(() => $<HTMLButtonElement>(this.pg.root, '[data-pg-files] [data-new-file]')?.click())
    }

    rename(path: string, input: string): string | undefined {
        const checked = checkName(input, this.paths, path)
        if ('error' in checked) return checked.error
        const to = checked.path
        if (to === path) return undefined
        const text = this.text(path)
        const state = path === this.active ? this.pg.view.state : this.states.get(path)
        const files: Record<string, string> = {}
        for (const [p, t] of Object.entries(this.files)) files[p === path ? to : p] = p === path ? text : t
        this.files = files
        this.states.delete(path)
        if (state) this.states.set(to, state)
        this.open = this.open.map(p => (p === path ? to : p))
        if (this.mainFile === path) this.mainFile = to
        if (this.active === path) this.active = to
        this.edit()
        this.publish()
        // What the active file imports may have changed.
        this.pg.runCompile(false)
        if (this.folder) this.pg.toast(`Renamed to ${to}. Save (${pgMod()}+S) writes it to the folder; the old file stays there until then.`)
        return undefined
    }

    remove(path: string) {
        const paths = this.paths
        if (paths.length < 2 || !(path in this.files)) return
        const text = this.text(path)
        const before = { files: { ...this.texts() }, open: [...this.open], active: this.active }
        delete this.files[path]
        this.states.delete(path)
        this.open = this.open.filter(p => p !== path)
        if (this.active === path) {
            const next = this.open[0] ?? this.paths[0]
            if (!this.open.includes(next)) this.open.push(next)
            this.active = next
            this.pg.view.setState(this.states.get(next) ?? stateFor(this.pg.view, this.files[next]))
            this.pg.fileSwitched()
        } else {
            this.pg.runCompile(false)
        }
        this.edit()
        this.publish()
        const disk = this.folder ? ' It is still in the folder until you save.' : ''
        this.pg.toast(`Deleted ${path}.${disk}`, {
            label: 'Undo',
            icon: pgIcons.undo,
            run: () => {
                this.files = { ...this.texts(), [path]: before.files[path] ?? text }
                this.open = before.open.filter(p => p in this.files)
                this.publish()
                this.switchTo(before.active)
                this.edit()
            },
        })
    }

    // ----- Saving ----------------------------------------------------------------------------------------------------

    /** After typing in the editor: saved, and the files' marks updated, after a pause. */
    typed() {
        this.scheduleSave(true)
        clearTimeout(this.publishTimer)
        this.publishTimer = setTimeout(() => this.publish(), 150)
    }

    /** After an edit (of a text, or of the files): saved after a pause in typing. */
    edit() {
        this.scheduleSave(true)
        this.publish()
    }

    scheduleSave(url: boolean) {
        if (this.pg.mode !== 'page') return
        clearTimeout(this.saveTimer)
        this.pending = true
        this.saveTimer = setTimeout(() => this.flush(url), SAVE_DELAY)
    }

    /** Saves what is not saved yet: in the browser, the scratch buffer and (`url`) the address bar's entry. */
    flush(url: boolean) {
        clearTimeout(this.saveTimer)
        if (!this.pending) return
        this.pending = false
        this.syncActive()
        const files = this.texts()
        storageSet(SCRATCH_KEY, files[this.active] ?? '')
        this.id ??= newProjectId()
        setCurrent(this.id)
        const pg = this.pg
        const o = pg.origin
        const stored: StoredProject = {
            id: this.id,
            name: this.name,
            files,
            active: this.active,
            open: [...this.open],
            updated: Date.now(),
            origin: { kind: o.kind, id: o.id, title: o.title },
            folder: this.folder && { name: this.folder.name, handle: this.folder.handle, disk: { ...this.folder.disk } },
        }
        void putProject(stored)
        if (!url || sameFiles(files, this.loaded)) return
        const next = new URL(location.href)
        // An edited exercise keeps its model solution (a reload can still compare).
        const solution = pg.exercise?.solution
        next.search = solution ? `?solution=${solution.id}` : ''
        // A folder's files stay on the reader's disk: the address carries no copy of them.
        next.hash = this.folder ? '' : hashForProject({ name: this.name, files, active: this.active })
        history.replaceState(history.state, '', next)
    }

    /** Writes the files that differ from the folder (and removes those deleted since), asking for permission once. */
    async saveToFolder() {
        const pg = this.pg
        const folder = this.folder
        if (!folder?.handle) return
        if (!(await permitted(folder.handle, true))) {
            pg.toast(`The browser did not allow writing to ${folder.name}.`)
            return
        }
        folder.connected = true
        this.syncActive()
        const files = this.texts()
        const write = Object.keys(files).filter(p => folder.disk[p] !== files[p])
        const gone = Object.keys(folder.disk).filter(p => !(p in files))
        try {
            for (const p of write) await writeFile(folder.handle, p, files[p])
            for (const p of gone) await removeFile(folder.handle, p)
        } catch (e) {
            pg.toast(`Saving to ${folder.name} failed: ${(e as Error).message}`)
            return
        }
        folder.disk = { ...files }
        this.pending = true
        this.flush(false)
        this.publish()
        const n = write.length + gone.length
        pg.toast(n ? `Saved ${n === 1 ? (write[0] ?? `the removal of ${gone[0]}`) : `${n} files`} to ${folder.name}.` : `Everything is saved in ${folder.name}.`)
    }

    /** A folder project after a reload: the browser asks again before the playground may read or write it. Reads
     *  it again then: a file the reader has not edited here takes the folder's text. */
    async checkFolder(ask: boolean) {
        const folder = this.folder
        if (!folder?.handle) return
        if (!(await permitted(folder.handle, ask))) {
            folder.connected = false
            this.publish()
            if (ask) this.pg.toast(`The browser did not allow access to ${folder.name}.`)
            return
        }
        folder.connected = true
        let read
        try {
            read = await readFolder(folder.handle)
        } catch {
            this.publish()
            return
        }
        let changed = false
        for (const [p, text] of Object.entries(read.files)) {
            const mine = this.text(p)
            const untouched = !(p in this.files) || mine === folder.disk[p]
            if (untouched && mine !== text) {
                this.files[p] = text
                this.states.delete(p)
                if (p === this.active) this.pg.view.setState(stateFor(this.pg.view, text))
                changed = true
            }
        }
        folder.disk = read.files
        this.publish()
        if (changed) this.pg.fileSwitched()
        if (ask) this.pg.toast(`Connected to ${folder.name}.`)
    }
}

const pgMod = () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl')

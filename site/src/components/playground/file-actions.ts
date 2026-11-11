// The playground's actions (`[data-action]` buttons anywhere in its root) and keys: New, Open files (a .zip too),
// Open folder (File System Access), Save (to the folder; elsewhere a download: the .sctx, or the project as a .zip),
// Copy link (the whole project in the link), Revert, the diagram's zoom and SVG export, a file dropped on the editor.

import { $, isMac } from './app-types'
import { canOpenFolder, downloadBlob, pickFolder, readFiles, zipFiles } from './folder'
import { hashForProject, fileNameFor } from './share'
import type { Playground } from './app'

const NEW_CHART = `scchart MyChart {\n  input bool start\n  output bool running = false\n\n  initial state Idle\n    if start do running = true go to Busy\n\n  state Busy\n    if !start do running = false go to Idle\n}\n`

export class FileActions {
    constructor(private pg: Playground) {
        pg.root.addEventListener('click', e => {
            const btn = (e.target as Element).closest<HTMLElement>('[data-action]')
            if (!btn || !pg.root.contains(btn) || btn.getAttribute('aria-disabled') === 'true') return
            if (this.run(btn.dataset.action!)) btn.closest<HTMLDetailsElement>('details.sc-pg-pop')?.removeAttribute('open')
        })
        const input = $<HTMLInputElement>(pg.root, '[data-pg-file]')
        input?.addEventListener('change', async () => {
            const files = [...(input.files ?? [])]
            input.value = ''
            if (files.length) await this.openFiles(files)
        })
        if (pg.mode === 'page') {
            for (const b of pg.root.querySelectorAll<HTMLElement>('[data-action="open-folder"]')) b.hidden = !canOpenFolder()
            this.setupDrop()
            this.setupKeys()
        }
    }

    /** Runs an action; false when it is not one of these. */
    run(action: string): boolean {
        const pg = this.pg
        const d = pg.diagram
        switch (action) {
            case 'zoom-in': d.view.zoom(1.25); break
            case 'zoom-out': d.view.zoom(0.8); break
            case 'fit': d.view.fit(); break
            case 'outline': d.outline.toggle(); break
            case 'zoom-reset': d.view.actualSize(); break
            case 'export-svg': void this.exportSvg(); break
            case 'download': void this.download(); break
            case 'download-zip': void this.download(true); break
            case 'save': void this.save(); break
            case 'open': this.chooseFiles(); break
            case 'open-folder': void this.openFolder(); break
            case 'share': void this.share(); break
            case 'share-run': void pg.sim.shareRun(); break
            case 'new': this.newChart(); break
            case 'new-file': pg.project.startNewFile(); break
            case 'restore': pg.restore(); break
            case 'rebuild': return false
            default: return false
        }
        return true
    }

    /** Ctrl/⌘+S: into the folder the project came from; else a download. */
    async save() {
        const p = this.pg.project
        if (p.folder?.handle) await p.saveToFolder()
        else await this.download()
    }

    /** The active chart as a .sctx file; a project of several files as a .zip. */
    async download(zip = false) {
        const p = this.pg.project
        p.syncActive()
        const paths = p.paths
        if (paths.length === 1 && !zip) {
            const name = paths[0].split('/').pop() || fileNameFor(this.pg.latest?.result.chart?.name)
            downloadBlob(new Blob([p.text(paths[0])], { type: 'text/plain;charset=utf-8' }), name)
            this.pg.toast(`Downloaded ${name}.`)
            return
        }
        const name = `${p.name.replace(/[^\w .-]+/g, '').trim() || 'project'}.zip`
        downloadBlob(await zipFiles(p.name, p.texts()), name)
        this.pg.toast(`Downloaded ${name} (${paths.length} files).`)
    }

    /** The diagram as a standalone SVG file in the light colours. */
    async exportSvg() {
        const pg = this.pg
        const svg = pg.diagram.view.svg
        if (!svg) {
            pg.toast('There is no diagram to download yet.')
            return
        }
        const name = fileNameFor(svg.getAttribute('data-chart') ?? pg.diagram.shown?.chart).replace(/\.sctx$/, '.svg')
        const { standaloneSvg } = await import('./export-svg')
        downloadBlob(new Blob([await standaloneSvg(svg)], { type: 'image/svg+xml' }), name)
        pg.toast(`Downloaded ${name}.`)
    }

    chooseFiles() {
        $<HTMLInputElement>(this.pg.root, '[data-pg-file]')?.click()
    }

    /** Files chosen or dropped: one opens as a chart, several (or a .zip) as a project. */
    async openFiles(list: File[]) {
        const pg = this.pg
        const { files, skipped } = await readFiles(list)
        const paths = Object.keys(files)
        const note = skipped.length ? ` Left out (not .sctx files, or too large): ${skipped.join(', ')}.` : ''
        if (!paths.length) {
            pg.toast(`There is no .sctx file to open.${note}`)
            return
        }
        const zip = list.find(f => /\.zip$/i.test(f.name))
        const name = paths.length === 1 ? paths[0].replace(/\.sctx$/i, '') : zip ? zip.name.replace(/\.zip$/i, '') : 'Opened files'
        pg.loadProject({ name, files, active: paths[0] }, { kind: 'file', title: name }, `Opened ${paths.length === 1 ? paths[0] : `${paths.length} files`}.${note}`)
    }

    async openFolder() {
        const pg = this.pg
        let read
        try {
            read = await pickFolder()
        } catch (e) {
            pg.toast(`The folder could not be opened: ${(e as Error).message}`)
            return
        }
        if (!read) return
        let files = read.files
        let active = Object.keys(files)[0]
        let note = read.skipped ? ` ${read.skipped} files were left out (too large, or too many).` : ''
        if (!active) {
            // An empty folder: a chart to start with, saved there with Ctrl/⌘+S.
            active = 'main.sctx'
            files = { [active]: NEW_CHART }
            note = ` It has no .sctx files yet: ${isMac ? '⌘' : 'Ctrl'}+S saves main.sctx there.`
        }
        pg.loadProject(
            { name: read.name, files, active, folder: { name: read.name, handle: read.handle, disk: read.files } },
            { kind: 'folder', title: read.name },
            `Opened the folder ${read.name}.${note}`,
        )
    }

    async share() {
        const pg = this.pg
        const p = pg.project
        p.syncActive()
        const url = new URL(location.href)
        url.search = ''
        url.hash = hashForProject({ name: p.name, files: p.texts(), active: p.active })
        const link = url.toString()
        if (!p.folder) history.replaceState(history.state, '', link)
        let copied = false
        try {
            await navigator.clipboard.writeText(link)
            copied = true
        } catch {
            copied = false
        }
        const what = p.paths.length > 1 ? `all ${p.paths.length} files` : 'the whole chart'
        const long = link.length > 8000 ? ` It is ${link.length.toLocaleString('en-NZ')} characters long; some chat apps cut long links, so send the files if it does not open.` : ''
        pg.toast((copied ? `Link copied. It contains ${what}, so it works without an account.` : `Copy the link from the address bar: it contains ${what}.`) + long)
    }

    newChart() {
        this.pg.loadProject({ name: 'New chart', files: { 'MyChart.sctx': NEW_CHART }, active: 'MyChart.sctx' }, { kind: 'new', title: 'New chart' }, 'Started a new chart.')
    }

    private setupDrop() {
        const zone = $(this.pg.root, '[data-pg-editor]')
        if (!zone) return
        zone.addEventListener('dragover', e => {
            if (!e.dataTransfer?.types.includes('Files')) return
            e.preventDefault()
            zone.classList.add('is-drop')
        })
        zone.addEventListener('dragleave', () => zone.classList.remove('is-drop'))
        zone.addEventListener(
            'drop',
            e => {
                zone.classList.remove('is-drop')
                const files = [...(e.dataTransfer?.files ?? [])]
                if (!files.length) return
                e.preventDefault()
                e.stopPropagation()
                void this.openFiles(files)
            },
            true,
        )
    }

    private setupKeys() {
        const pg = this.pg
        document.addEventListener('keydown', e => {
            if (e.defaultPrevented) return
            const mod = isMac ? e.metaKey : e.ctrlKey
            const key = e.key.toLowerCase()
            const inField = (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
            if (mod && !e.altKey && key === 's') {
                e.preventDefault()
                if (e.shiftKey) void this.share()
                else void this.save()
            } else if (mod && !e.altKey && key === 'o' && !e.shiftKey) {
                e.preventDefault()
                this.chooseFiles()
            } else if (mod && e.key === 'Enter' && !inField) {
                e.preventDefault()
                if (e.shiftKey) pg.sim.rebuild()
                else pg.sim.step()
            } else if (e.key === '?' && !mod && !e.altKey && !inField && !(e.target as Element | null)?.closest?.('.cm-editor')) {
                const help = $<HTMLDetailsElement>(pg.root, '[data-pg-help]')
                if (help) {
                    e.preventDefault()
                    help.open = !help.open
                }
            }
        })
    }
}

// The problems of the active file: the engine's diagnostics as squiggles and gutter marks, a status in the editor's
// footer, and the list (/playground: the bottom panel's Problems tab; the inline playground: under its editor,
// folding). For a guide example opened as it is, KIELER's recording of it (recorded.ts) is paired with the engine's
// problems (KIELER's own words, and what only KIELER reports), and the simulation's verdict is 'recorded'.

import type { CompileResult } from '@sccharts-lab/engine'
import type { ClassMap } from '@sccharts-lab/diagram/highlight'
import { $, plural, type Analysed } from './app-types'
import { selectRange, showDiagnostics } from './editor'
import { applySuggestion, problemLink, renderDiagnostic, suggestionOf, toLintDiagnostics } from './editor-features'
import { withRecording, type Problem } from './recorded'
import { loadRecording, type Recording } from './sources'
import type { Verdict } from './sim-host.svelte'
import type { Playground } from './app'

export class Problems {
    list: Problem[] = []
    /** The inline playground's list is open. */
    private open = false
    /** KIELER's recording of the open example's main file: paired with the engine's problems while the text is as recorded. */
    private recording?: { id: string; file: string; text: string; rec: Recording }

    constructor(private pg: Playground) {
        $(pg.root, '[data-pg-problems-toggle]')?.addEventListener('click', () => {
            if (pg.mode === 'page') {
                pg.panel?.show('problems', { focus: true })
                return
            }
            if (!this.list.length) return
            this.open = !this.open
            this.render()
        })
    }

    /** The compile's problems: squiggles, the errors marked in the diagram, the summary and the list. */
    show(a: Analysed) {
        const pg = this.pg
        const tracker = a.tracker
        this.list = this.withKieler(a.result, tracker.doc.toString(), a.file)
        showDiagnostics(pg.view, toLintDiagnostics(this.list, { fromSource: p => tracker.fromSnapshot(p) }, pg.view.state.doc.length))
        const errors: ClassMap = {}
        for (const d of a.result.diagnostics) if (d.severity === 'error') for (const id of d.related ?? []) errors[id] = ['is-error']
        pg.diagram.setErrors(errors)
        pg.model.problems = this.list
        this.render()
    }

    private withKieler(result: CompileResult, text: string, file: string): Problem[] {
        const r = this.recording
        return r && file === r.file && text === r.text && this.recordingApplies(result) ? withRecording(result.diagnostics, r.rec, text) : result.diagnostics
    }

    /** The recording is of the chart shown: the file's first (KIELER simulates rootStates.head). */
    private recordingApplies(result: CompileResult) {
        const choice = this.pg.chartChoice
        return !choice || choice === result.program?.charts[0]?.name
    }

    /** Loads KIELER's recording of the open example (its diagnostics and the verdict depend on it). */
    async fetchRecording() {
        const pg = this.pg
        const origin = pg.origin
        const id = origin.kind === 'example' || origin.kind === 'default' ? origin.id : undefined
        const file = pg.project.mainFile
        const text = pg.project.loaded[file] ?? ''
        this.recording = undefined
        if (!id) return
        const rec = await loadRecording(id)
        if (pg.origin !== origin || !rec) return
        this.recording = { id, file, text, rec }
        if (pg.latest) this.show(pg.latest)
        pg.sim.updateVerdict()
    }

    /** SimPanel's verdict: 'recorded' for an example as written, whose recording agrees with what the panel shows
     *  (so "KIELER rejects this chart" is KIELER's word); 'engine' for everything else (the reader's charts and
     *  edits: only the guide's checker has seen them). */
    verdictFor(a: Analysed | undefined): Verdict {
        const r = this.recording
        return r && a && a.file === r.file && a.tracker.doc.toString() === r.text && this.recordingApplies(a.result) && r.rec.ok === a.result.ok ? 'recorded' : 'engine'
    }

    render() {
        const pg = this.pg
        const box = $(pg.root, '[data-pg-problems]')
        const list = $(pg.root, '[data-pg-problems-list]')
        const problems = this.list
        const errors = problems.filter(d => d.severity === 'error').length
        const warnings = problems.filter(d => d.severity === 'warning').length
        const infos = problems.length - errors - warnings
        const counts = [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning'), infos && plural(infos, 'note')].filter(Boolean).join(', ')
        const state = errors ? 'error' : warnings ? 'warning' : problems.length ? 'info' : 'ok'
        pg.panel?.setBadge('problems', problems.length || undefined, counts || 'No problems', state)
        const listed = pg.mode === 'page' || this.open
        if (box) {
            const toggle = $(box, '[data-pg-problems-toggle]')!
            box.dataset.state = state
            const summary = $(toggle, '[data-pg-problems-summary]')!
            const first = problems[0]
            if (!problems.length) {
                summary.textContent = 'No problems'
                toggle.setAttribute('aria-disabled', String(pg.mode !== 'page'))
                this.open = false
            } else {
                const line = first.span ? this.lineOf(first.span.start) : undefined
                summary.replaceChildren(
                    Object.assign(document.createElement('b'), { textContent: counts }),
                    document.createTextNode(this.open ? '' : `: ${line ? `line ${line}, ` : ''}${first.message}`),
                )
                toggle.removeAttribute('aria-disabled')
            }
            if (pg.mode === 'embed') toggle.setAttribute('aria-expanded', String(this.open))
        }
        if (!list) return
        list.hidden = !listed
        const empty = $(pg.root, '[data-pg-problems-empty]')
        if (empty) empty.hidden = problems.length > 0
        list.replaceChildren(...problems.map(d => this.item(d)))
    }

    private lineOf(snapshotPos: number) {
        const pg = this.pg
        const at = pg.latest!.tracker.fromSnapshot(snapshotPos)
        return pg.view.state.doc.lineAt(Math.min(at, pg.view.state.doc.length)).number
    }

    private item(d: Problem): HTMLLIElement {
        const pg = this.pg
        const li = document.createElement('li')
        li.className = `sc-pg-problem is-${d.severity}`
        const btn = document.createElement('button')
        btn.type = 'button'
        const where = document.createElement('span')
        where.className = 'sc-pg-problem__where'
        const file = pg.project.paths.length > 1 ? `${pg.project.active}, ` : ''
        where.textContent = `${d.severity === 'error' ? 'Error' : d.severity === 'warning' ? 'Warning' : 'Note'}${d.span ? `, ${file}line ${this.lineOf(d.span.start)}` : ''}`
        btn.append(where, renderDiagnostic(d))
        btn.addEventListener('click', () => {
            const t = pg.latest!.tracker
            if (d.span) selectRange(pg.view, t.fromSnapshot(d.span.start), t.fromSnapshot(d.span.end), true)
            pg.showTab('code')
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
                const t = pg.latest!.tracker
                if (applySuggestion(pg.view, t.fromSnapshot(d.span!.start), t.fromSnapshot(d.span!.end), word)) pg.view.focus()
            })
            li.append(fix)
        }
        return li
    }
}

// The project menu (the project's name in the app bar): its name (rename it there), the file actions (New, Open,
// Save, Download: `[data-action]` buttons, file-actions.ts), and the reader's recent projects in this browser
// (project-store.ts): open one, or remove it (with Undo).

import { $, el, escapeHtml, plural } from './app-types'
import { deleteProject, listProjects, putProject, type StoredProject } from './project-store'
import { pgIcons } from './icons'
import type { Playground } from './app'

function ago(ms: number): string {
    const s = Math.max(0, (Date.now() - ms) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)} min ago`
    if (s < 86400) return plural(Math.round(s / 3600), 'hour') + ' ago'
    if (s < 86400 * 30) return plural(Math.round(s / 86400), 'day') + ' ago'
    return new Date(ms).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function setupProjectMenu(pg: Playground) {
    const pop = $<HTMLDetailsElement>(pg.root, '[data-pg-project]')
    if (!pop) return
    const input = $<HTMLInputElement>(pop, '[data-pg-project-name]')
    input?.addEventListener('change', () => {
        const name = input.value.trim()
        if (!name || name === pg.project.name) {
            input.value = pg.project.name
            return
        }
        pg.project.name = name
        pg.project.edit()
        pg.updateTitle()
    })
    input?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault()
            input.blur()
        }
    })
    pop.addEventListener('toggle', () => {
        if (!pop.open) return
        if (input) input.value = pg.project.name
        void renderRecent()
    })

    async function renderRecent() {
        const box = $(pop!, '[data-pg-recent]')
        if (!box) return
        const all = (await listProjects()).filter(p => p.id !== pg.project.id)
        const head = $(pop!, '[data-pg-recent-head]')
        if (head) head.hidden = !all.length
        box.hidden = !all.length
        box.replaceChildren(
            ...all.slice(0, 12).map(p => {
                const li = el('li', 'sc-pg-recent__item')
                const open = el('button', 'sc-pg-recent__open')
                open.type = 'button'
                const files = Object.keys(p.files).length
                open.innerHTML = `<span class="sc-pg-recent__name">${escapeHtml(p.name)}</span><span class="sc-pg-recent__meta">${p.folder ? `folder ${escapeHtml(p.folder.name)}, ` : files > 1 ? `${files} files, ` : ''}${ago(p.updated)}</span>`
                open.addEventListener('click', () => {
                    pop!.open = false
                    pg.openStored(p)
                })
                const remove = el('button', 'sc-pg__tool sc-pg-recent__remove', pgIcons.trash)
                remove.type = 'button'
                remove.setAttribute('aria-label', `Remove ${p.name} from this browser`)
                remove.title = 'Remove it from this browser'
                remove.addEventListener('click', async () => {
                    await deleteProject(p.id)
                    await renderRecent()
                    pg.toast(`Removed ${p.name} from this browser.`, { label: 'Undo', icon: pgIcons.undo, run: () => void restore(p) })
                })
                li.append(open, remove)
                return li
            }),
        )
    }

    async function restore(p: StoredProject) {
        await putProject(p)
        if (pop?.open) await renderRecent()
    }
}

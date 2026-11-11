// The bottom panel (/playground): ARIA tabs over its panels, one per entry of PANEL_TABS (panel-tabs.ts), the markup
// made by playground.astro. Each tab's content is mounted the first time it is shown (or at start, `eager`); a
// tab's tools sit in the panel's head and show with it; badges (counts) sit next to the names.

import { $ } from './app-types'
import { PANEL_TABS, type PanelTab, type PanelTabContext } from './panel-tabs'
import type { Playground } from './app'

export class BottomPanel {
    current = 'sim'
    private mounted = new Set<string>()
    private listeners = new Map<string, (() => void)[]>()
    private tabs: HTMLButtonElement[]

    constructor(private pg: Playground, private root: HTMLElement) {
        this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-pg-panel-tabs] [role="tab"]')]
        const list = $(root, '[data-pg-panel-tabs]')
        list?.addEventListener('click', e => {
            const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]')
            if (tab?.dataset.panelTab) this.show(tab.dataset.panelTab)
        })
        list?.addEventListener('keydown', e => {
            const i = this.tabs.indexOf(document.activeElement as HTMLButtonElement)
            if (i < 0) return
            const n = this.tabs.length
            const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
            if (j < 0) return
            e.preventDefault()
            this.show(this.tabs[j].dataset.panelTab!, { focus: true })
        })
        for (const spec of PANEL_TABS) if (spec.eager) void this.mount(spec)
    }

    /** Shows a tab (on a phone, in the Simulate view); `focus`: moves the keyboard to its button. */
    show(id: string, o: { focus?: boolean } = {}) {
        const spec = PANEL_TABS.find(t => t.id === id)
        if (!spec) return
        this.current = id
        for (const t of this.tabs) {
            const on = t.dataset.panelTab === id
            t.setAttribute('aria-selected', String(on))
            t.tabIndex = on ? 0 : -1
            if (on && o.focus) t.focus()
            if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        for (const p of this.root.querySelectorAll<HTMLElement>('[data-pg-panel-body]')) p.hidden = p.dataset.pgPanelBody !== id
        for (const p of this.root.querySelectorAll<HTMLElement>('[data-pg-panel-tools]')) p.hidden = p.dataset.pgPanelTools !== id
        this.root.dataset.current = id
        if (this.pg.isNarrow()) this.pg.showTab('sim')
        void this.mount(spec)
        for (const l of this.listeners.get(id) ?? []) l()
    }

    setBadge(id: string, value: string | number | undefined, label?: string, state?: string) {
        const tab = this.tabs.find(t => t.dataset.panelTab === id)
        const badge = tab?.querySelector<HTMLElement>('[data-pg-badge-count]')
        if (!tab || !badge) return
        badge.textContent = value === undefined ? '' : String(value)
        badge.hidden = value === undefined
        if (state) badge.dataset.state = state
        else delete badge.dataset.state
        const words = tab.querySelector<HTMLElement>('[data-pg-badge-words]')
        if (words) words.textContent = label ? `, ${label}` : ''
    }

    private async mount(spec: PanelTab) {
        if (spec.builtin || !spec.mount || this.mounted.has(spec.id)) return
        this.mounted.add(spec.id)
        const host = $(this.root, `[data-pg-panel-body="${spec.id}"]`)
        const tools = $(this.root, `[data-pg-panel-tools="${spec.id}"]`)
        if (!host || !tools) return
        const pg = this.pg
        const panel = this
        const ctx: PanelTabContext = {
            model: pg.model,
            tools,
            setBadge: (value, label, state) => this.setBadge(spec.id, value, label, state),
            reveal: (path, from, to) => pg.reveal(path, from, to),
            toast: message => pg.toast(message),
            get visible() {
                return panel.current === spec.id
            },
            onShow: listener => this.listeners.set(spec.id, [...(this.listeners.get(spec.id) ?? []), listener]),
            showTab: id => this.show(id),
            sim: {
                tour: t => pg.sim.playTour(t),
                step: () => pg.sim.host?.step(),
                back: () => pg.sim.host?.back(),
                run: () => pg.sim.host?.run(),
                pause: () => pg.sim.host?.pause(),
                goto: tick => pg.sim.host?.goto(tick),
            },
            folder: () => pg.project.folderAccess(),
        }
        try {
            await spec.mount(host, ctx)
        } catch (e) {
            host.textContent = `This tab could not be loaded: ${(e as Error).message}`
        }
    }
}

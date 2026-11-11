// The bottom panel's tabs: the one place to add a tab. playground.astro renders a tab button, a tools slot and an
// empty panel for each entry (so the strip is there at first paint), and panel.ts mounts each tab's content the
// first time it is shown (or at start, `eager`). A tab reads the playground through its context: `ctx.model`
// (model.svelte.ts: the project, the newest compile of the active file, its problems, what the simulation runs and
// its ticks) is reactive, so a Svelte component re-renders as it changes; plain code uses `watch` from there.
//
// To add a tab ("Trace", "C code"): write its component and a `mount` that imports it lazily, then add an entry here:
//
//   { id: 'c', label: 'C code', mount: (host, ctx) => import('./c-code-tab').then(m => m.mount(host, ctx)) },
//
// This module is imported at build time too: keep it free of browser code at its top level.

import type { PlaygroundModel } from './model.svelte'

export interface PanelTabContext {
    /** The playground's state, reactive (read only). */
    model: PlaygroundModel
    /** The tab's tools: an element in the panel's head, right of the tabs, shown while the tab is. */
    tools: HTMLElement
    /** Says something next to the tab's name (a count), with words for screen readers and a state for its colour. */
    setBadge(value: string | number | undefined, label?: string, state?: 'ok' | 'info' | 'warning' | 'error'): void
    /** Selects a range of a file (offsets in its text now) in the editor, opening the file. */
    reveal(path: string, from: number, to?: number): void
    /** Shows a short message (the playground's toast). */
    toast(message: string): void
    /** Whether the tab is shown now; `onShow` is called each time it is. */
    readonly visible: boolean
    onShow(listener: () => void): void
}

export interface PanelTab {
    id: string
    /** The tab's name, short (the strip has room for a word or two per tab). */
    label: string
    /** Content the playground renders itself (the simulation, the problems): no `mount`. */
    builtin?: boolean
    /** Mounts the tab's content into `host` (import it lazily here). Returns its cleanup, if it has one. */
    mount?(host: HTMLElement, ctx: PanelTabContext): void | (() => void) | Promise<void | (() => void)>
    /** Mount when the playground starts, not when the tab is first shown (to keep its badge up to date). */
    eager?: boolean
}

export const PANEL_TABS: PanelTab[] = [
    { id: 'sim', label: 'Simulation', builtin: true },
    { id: 'problems', label: 'Problems', builtin: true },
    { id: 'console', label: 'Console', eager: true, mount: (host, ctx) => import('./console-tab').then(m => m.mountConsole(host, ctx)) },
]

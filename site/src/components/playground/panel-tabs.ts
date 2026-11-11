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
import type { Scenario } from '../frame/examples'

/** A tour of inputs for the simulation panel (as a guided tour: per tick its inputs and a note). */
export interface PanelTour {
    scenario: Scenario
    /** What the panel calls it ("Replay": "Replay, tick 3 of 12"), and the switch's title. */
    name: string
    title: string
    /** The panel's words before tick 1 (inline Markdown). */
    intro: string
}

/** The project's folder on disk (Open folder), while the browser lets the playground use it. */
export interface ProjectFolder {
    name: string
    /** Paths of the folder's files whose names match (two levels down). */
    list(match: RegExp): Promise<string[]>
    read(path: string): Promise<string>
    /** Writes a new file, never over one: under the first name `pick` gives that is free (`pick` gets the names found
     *  taken); resolves to the name. */
    create(pick: (taken: string[]) => string, text: string): Promise<string>
}

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
    /** Shows another tab of the panel ('sim', 'problems', ...). */
    showTab(id: string): void
    /** The simulation panel: plays a tour of inputs on the file in the editor (`model.tour` says it is in
     *  control while `model.simView.tour`), and its transport. */
    sim: {
        tour(t: PanelTour): void
        step(): void
        back(): void
        run(): void
        pause(): void
        goto(tick: number): void
    }
    /** The project's folder on disk, when it is one (asks the browser for permission if need be). */
    folder(): Promise<ProjectFolder | undefined>
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
    { id: 'trace', label: 'Trace', mount: (host, ctx) => import('./trace-tab').then(m => m.mountTrace(host, ctx)) },
    { id: 'c', label: 'C code', mount: (host, ctx) => import('./c-code-tab').then(m => m.mountCCode(host, ctx)) },
]

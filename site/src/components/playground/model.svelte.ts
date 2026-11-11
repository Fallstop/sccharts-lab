// What the playground shows, as reactive state (Svelte 5 runes) for its Svelte parts (the files sidebar, the editor's
// tabs, the console) and for bottom-panel tabs (panel-tabs.ts): the project, the newest compile of the active file,
// its problems, and what the simulation runs with its ticks. The controller (app.ts and its parts) writes it; tabs
// only read it. A Svelte component reads the fields directly; plain TypeScript subscribes with `watch`.

import { untrack } from 'svelte'
import type { CompileResult } from '@sccharts-lab/engine'
import type { Problem } from './recorded'
import type { SimView } from './sim-host.svelte'

export interface ProjectView {
    name: string
    /** Every file, sorted as a file explorer lists them. */
    files: string[]
    /** The file in the editor (diagrammed, and simulated unless a run of another file is under way). */
    active: string
    /** The files open in the editor's tabs, in order. */
    open: string[]
    /** Files whose text differs from the folder on disk (a folder project), or from the link or example loaded. */
    unsaved: string[]
    /** The project is backed by a folder on disk (its name). */
    folder?: string
    /** The folder needs the reader's permission again (after a reload). */
    disconnected?: boolean
}

export interface Compiled {
    /** The file compiled, and its text then. */
    file: string
    source: string
    /** `compile(source, { files })`, with the files it imports. */
    result: CompileResult
}

export class PlaygroundModel {
    project = $state.raw<ProjectView>({ name: '', files: [], active: '', open: [], unsaved: [] })
    /** The newest compile of the active file. */
    compiled = $state.raw<Compiled | undefined>()
    /** Its problems (the engine's diagnostics, with KIELER's words for an example as recorded). */
    problems = $state.raw<Problem[]>([])
    /** What the simulation panel runs (it may be another file than the active one, while a run of it lasts). */
    simulation = $state.raw<Compiled | undefined>()
    /** Where its run stands: the tick shown (`cursor`), every tick computed (`history`, with `printed`). */
    simView = $state.raw<SimView | undefined>()
    /** The tour the panel was mounted with, if any: the example's guided tour, a test run, a shared run, a trace
     *  replayed ('trace'). It is in control while `simView.tour`. */
    tour = $state.raw<{ kind: 'tour' | 'test' | 'shared' | 'trace'; name: string } | undefined>()
}

/** Calls `then` with `read()` now and whenever what it reads changes. Returns the unsubscribe. */
export function watch<T>(read: () => T, then: (value: T) => void): () => void {
    return $effect.root(() => {
        $effect(() => {
            const value = read()
            untrack(() => then(value))
        })
    })
}

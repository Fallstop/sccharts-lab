// Types and small helpers shared by the playground's controller (app.ts) and its parts.

import type { CompileResult } from '@sccharts-lab/engine'
import type { DocTracker } from './editor'
import type { DiagramView } from './diagram-view'
import type { Scenario } from '../frame/examples'
import type { SharedRun } from './share'
import type { StoredProject } from './project-store'

export interface Origin {
    kind: 'example' | 'shared' | 'scratch' | 'default' | 'file' | 'new' | 'folder'
    /** Example id. */
    id?: string
    /** What the app bar calls it. */
    title: string
    /** The guide page the example comes from. */
    page?: { title: string; href?: string }
    /** The starter chart of an exercise. */
    starter?: boolean
}

/** A project to open: its files and the active one; `id` when it is stored in the browser, `folder` when it is
 *  backed by a folder on disk. */
export interface ProjectSpec {
    name: string
    files: Record<string, string>
    active: string
    open?: string[]
    id?: string
    /** The stored version opened (`StoredProject.rev`; null: stored before versions). */
    rev?: string | null
    folder?: StoredProject['folder']
}

export interface PlaygroundInit {
    root: HTMLElement
    mode: 'page' | 'embed'
    /** The project to open (a single file for the inline playground). */
    project: ProjectSpec
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

/** A project that a link opens (boot.ts reads it from the address): its files and origin, the example's tour, a
 *  shared run of it (and the chart of the file it ran), and an exercise's model solution. */
export interface LinkTarget {
    project: ProjectSpec
    origin: Origin
    scenario?: Scenario
    run?: SharedRun
    chart?: string
    solution?: string
}

/** A compile of the active file, with the tracker that maps its offsets to the text as it is now. */
export interface Analysed {
    result: CompileResult
    tracker: DocTracker
    /** The file compiled. */
    file: string
    /** The files it imports, as a key: a run is stale when they change. */
    deps: string
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD = isMac ? '⌘' : 'Ctrl'

export const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T & Element>(sel) as T | null

export const isSyntaxBroken = (r: CompileResult) =>
    !r.program || r.diagnostics.some(d => d.severity === 'error' && (d.code === 'parse' || d.code === 'missing-semicolon' || d.code === 'internal'))

export function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function plural(n: number, word: string) {
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** An element with a class and, optionally, inner HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (html !== undefined) e.innerHTML = html
    return e
}

/** Local storage that never throws (the playground works without it). */
export function remember(key: string, value: string | null) {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {
        // not essential
    }
}

export function recall(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

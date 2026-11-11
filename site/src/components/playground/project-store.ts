// The reader's projects in the browser (IndexedDB), never required: every call is guarded and resolves to an empty
// answer when storage is blocked, full or missing, so the playground works the same without it (the address bar
// and the scratch buffer in local storage still keep the edits). A project is saved once the reader edits it;
// loading an example saves nothing, so it never overwrites the reader's work. Small and dependency-free: boot.ts
// reads the last project before the app loads.

import { sameFiles, type ProjectData } from './project'
import { storageGet, storageSet } from './share'

/** Where a stored project came from (the toolbar's title and the example's guided tour after a reload). */
export interface StoredOrigin {
    kind: 'example' | 'shared' | 'scratch' | 'default' | 'file' | 'new' | 'folder'
    id?: string
    title: string
}

export interface StoredProject extends ProjectData {
    id: string
    updated: number
    origin?: StoredOrigin
    /** A project backed by a folder on the reader's disk (File System Access): its handle and the texts on disk. */
    folder?: { name: string; handle?: FileSystemDirectoryHandle; disk: Record<string, string> }
    /** New with every save: a tab saves over the project only while it is the version that tab opened or saved. */
    rev?: string
}

const DB = 'sccharts-lab-playground'
const STORE = 'projects'
/** The id of the project the reader last worked on (local storage). */
export const CURRENT_KEY = 'sccharts-guide:playground:project'
/** The list keeps this many; older ones go when a new one is saved. */
export const KEEP = 40

let opening: Promise<IDBDatabase | null> | undefined

function openDb(): Promise<IDBDatabase | null> {
    opening ??= new Promise<IDBDatabase | null>(resolve => {
        try {
            if (typeof indexedDB === 'undefined') return resolve(null)
            const req = indexedDB.open(DB, 1)
            req.onupgradeneeded = () => {
                const db = req.result
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated')
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => resolve(null)
            req.onblocked = () => resolve(null)
            // A browser that never answers (some private modes) does not hold the playground up.
            setTimeout(() => resolve(null), 1500)
        } catch {
            resolve(null)
        }
    })
    return opening
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await openDb()
    return new Promise<T | undefined>(resolve => {
        if (!db) return resolve(undefined)
        try {
            const tx = db.transaction(STORE, mode)
            const req = work(tx.objectStore(STORE))
            tx.oncomplete = () => resolve(req ? req.result : undefined)
            tx.onerror = tx.onabort = () => resolve(undefined)
        } catch {
            resolve(undefined)
        }
    })
}

export function newProjectId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
    return run<StoredProject>('readonly', s => s.get(id))
}

/**
 * Saves the project (a copy) and drops the oldest beyond KEEP. `base`: the version (`rev`) this tab opened or last
 * saved (null: one saved before versions; undefined: not checked). When another tab has saved the project since, it
 * is saved as a new project instead, so that neither tab's edits are lost. Resolves to where it was stored, else
 * undefined.
 */
export async function putProject(p: StoredProject, base?: string | null): Promise<{ id: string; rev: string } | undefined> {
    let copy: StoredProject
    try {
        copy = structuredClone({ ...p, files: { ...p.files }, open: [...p.open] })
    } catch {
        // A handle that cannot be cloned (an older browser): the project without its folder's handle.
        copy = { ...p, files: { ...p.files }, open: [...p.open], folder: p.folder ? { name: p.folder.name, disk: { ...p.folder.disk } } : undefined }
    }
    // The version this save writes (the caller's: a record put back as it was keeps its own).
    copy.rev = p.rev ?? newProjectId()
    const db = await openDb()
    const done = await new Promise<boolean>(resolve => {
        if (!db) return resolve(false)
        try {
            const tx = db.transaction(STORE, 'readwrite')
            const store = tx.objectStore(STORE)
            // Read and written in one transaction: no other tab's save comes between.
            const now = store.get(copy.id)
            now.onsuccess = () => {
                const other = now.result as StoredProject | undefined
                if (base !== undefined && other && (other.rev ?? null) !== base) copy.id = newProjectId()
                store.put(copy)
            }
            tx.oncomplete = () => resolve(true)
            tx.onerror = tx.onabort = () => resolve(false)
        } catch {
            resolve(false)
        }
    })
    if (!done) return undefined
    void trim()
    return { id: copy.id, rev: copy.rev }
}

export async function deleteProject(id: string): Promise<void> {
    await run('readwrite', s => s.delete(id))
}

/** The stored projects, the most recent first. */
export async function listProjects(): Promise<StoredProject[]> {
    const all = (await run<StoredProject[]>('readonly', s => s.getAll())) ?? []
    return all.sort((a, b) => b.updated - a.updated)
}

/** A folder project with edits not saved into its folder: the browser holds the only copy of them. */
export const unsavedInFolder = (p: StoredProject): boolean => !!p.folder && !sameFiles(p.files, p.folder.disk)

async function trim() {
    const all = await listProjects()
    for (const p of all.slice(KEEP)) if (!unsavedInFolder(p)) await deleteProject(p.id)
}

export function setCurrent(id: string | undefined) {
    storageSet(CURRENT_KEY, id ?? null)
}

// ----- The last save, kept at once (session and local storage) -----------------------------------------------------
//
// The browser's store saves asynchronously, and a page that is going away (a reload or a closed tab right after
// typing) may not finish. A reload also loads the address as it was before the last save updated it. So every save
// also keeps the project, at once, in session storage (this tab's only; it survives a reload) and in local storage
// (the last save of any tab). Boot opens this tab's copy when the address loaded is one this tab saved it at, and
// the last save when it is newer than the store's copy of the reader's last project.

const TAB_KEY = 'sccharts-guide:playground:tab'
const LAST_KEY = 'sccharts-guide:playground:last'

export interface SavedCopy {
    /** The addresses the project was saved at (before and after the save's own update of the address). */
    at: string[]
    project: Omit<StoredProject, 'updated' | 'folder'> & { folder?: { name: string; disk: Record<string, string> } }
    /** The versions the store may hold: what this save writes, and what it writes over. */
    accept: (string | null)[]
}

/** A project to open from the store or a copy: `base`, the version to save over; `resave`, the store is behind. */
export type Newest = StoredProject & { base?: string | null; resave?: boolean }

export function rememberSave(t: SavedCopy) {
    const text = JSON.stringify(t)
    for (const [area, key] of [['sessionStorage', TAB_KEY], ['localStorage', LAST_KEY]] as const) {
        try {
            globalThis[area]?.setItem(key, text)
        } catch {
            // Blocked or full: the store and the address still have the save before.
        }
    }
}

/** Another project opened in this tab: its copy goes (the page lives on, so the store's save of it finishes), so
 *  that a reload never opens it in place of the address. */
export function forgetTab() {
    try {
        globalThis.sessionStorage?.removeItem(TAB_KEY)
    } catch {
        // Blocked: there is no copy either.
    }
}

function copyIn(area: 'sessionStorage' | 'localStorage', key: string): SavedCopy | undefined {
    try {
        const t = JSON.parse(globalThis[area]?.getItem(key) ?? 'null') as SavedCopy | null
        return t && Array.isArray(t.at) && Array.isArray(t.accept) && t.project?.id && t.project.files ? t : undefined
    } catch {
        return undefined
    }
}

/** The newer of a saved copy and the store's project: the store's when it has that save; the copy (to be saved
 *  again) when the store is a save behind or lacks it; the copy as a project of its own when another tab saved
 *  since (its next save makes a copy). */
function newest(t: SavedCopy, stored: StoredProject | undefined): Newest {
    if (stored && stored.rev === t.project.rev) return { ...stored, base: stored.rev }
    const folder = t.project.folder && { ...t.project.folder, handle: stored?.folder?.handle }
    const copy = { ...t.project, updated: Date.now(), folder, resave: true }
    if (!stored) return copy
    return { ...copy, base: t.accept.includes(stored.rev ?? null) ? (stored.rev ?? null) : 'another tab' }
}

/** This tab's last save, when `href` is an address this tab saved it at (a reload). */
export async function tabProject(href: string): Promise<Newest | undefined> {
    const t = copyIn('sessionStorage', TAB_KEY)
    if (!t || !t.at.includes(href)) return undefined
    return newest(t, await getProject(t.project.id))
}

/** The project the reader last worked on: the store's, or the last save when the store did not finish it. */
export async function lastSaved(): Promise<Newest | undefined> {
    const id = storageGet(CURRENT_KEY)
    if (!id) return undefined
    const stored = await getProject(id)
    const t = copyIn('localStorage', LAST_KEY)
    if (t?.project.id === id) return newest(t, stored)
    return stored && { ...stored, base: stored.rev ?? null }
}

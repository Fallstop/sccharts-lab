// The reader's projects in the browser (IndexedDB), never required: every call is guarded and resolves to an empty
// answer when storage is blocked, full or missing, so the playground works the same without it (the address bar
// and the scratch buffer in local storage still keep the edits). A project is saved once the reader edits it;
// loading an example saves nothing, so it never overwrites the reader's work. Small and dependency-free: boot.ts
// reads the last project before the app loads.

import type { ProjectData } from './project'
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
    // A record put back as it was (Undo of a removal) keeps its version.
    copy.rev = base === undefined && p.rev ? p.rev : newProjectId()
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

async function trim() {
    const all = await listProjects()
    for (const p of all.slice(KEEP)) await deleteProject(p.id)
}

/** The project the reader last worked on, if the browser still has it. */
export async function currentProject(): Promise<StoredProject | undefined> {
    const id = storageGet(CURRENT_KEY)
    return id ? getProject(id) : undefined
}

export function setCurrent(id: string | undefined) {
    storageSet(CURRENT_KEY, id ?? null)
}

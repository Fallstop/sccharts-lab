// Files on the reader's disk. A local folder (the File System Access API, Chromium): its .sctx files are read into a
// project and saved back in place. Elsewhere: several files opened at once (a .zip too), and the project downloaded
// as a .zip (fflate, loaded on demand). Everything here is guarded: a refusal or an unsupported browser is an
// answer, never a crash.

import { EXT, sortedPaths } from './project'

/** The parts of the File System Access API the playground uses (not all of it is in TypeScript's DOM library). */
type Permission = 'granted' | 'denied' | 'prompt'
interface PermissionHandle {
    queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Permission>
    requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Permission>
}
type DirHandle = FileSystemDirectoryHandle & PermissionHandle & { values(): AsyncIterable<FileSystemHandle> }

/** At most this many files are read from a folder (a folder of thousands is not an SCCharts project). */
export const MAX_FILES = 200
/** A file larger than this is not read (no chart is this long). */
export const MAX_BYTES = 2_000_000
const SKIP = /^(?:\.|node_modules$|target$|bin$|out$|kieler-gen$)/

export const canOpenFolder = (): boolean => typeof window !== 'undefined' && 'showDirectoryPicker' in window

export interface FolderRead {
    name: string
    handle: FileSystemDirectoryHandle
    /** The .sctx files by path, as they are on disk. */
    files: Record<string, string>
    /** Files left out: too large, or beyond MAX_FILES. */
    skipped: number
}

/** Asks for a folder and reads it; undefined when the reader cancels. Throws on other failures. */
export async function pickFolder(): Promise<FolderRead | undefined> {
    const picker = (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    let handle: FileSystemDirectoryHandle
    try {
        handle = await picker.call(window, { id: 'sccharts-lab', mode: 'readwrite' })
    } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return undefined
        throw e
    }
    return readFolder(handle)
}

/** The folder's .sctx files (and those of its subfolders, two levels down). */
export async function readFolder(handle: FileSystemDirectoryHandle): Promise<FolderRead> {
    const files: Record<string, string> = {}
    let skipped = 0
    const walk = async (dir: DirHandle, prefix: string, depth: number) => {
        for await (const entry of dir.values()) {
            if (SKIP.test(entry.name)) continue
            if (entry.kind === 'directory') {
                if (depth < 2) await walk(entry as DirHandle, `${prefix}${entry.name}/`, depth + 1)
            } else if (entry.name.toLowerCase().endsWith(EXT)) {
                const file = await (entry as FileSystemFileHandle).getFile()
                if (file.size > MAX_BYTES || Object.keys(files).length >= MAX_FILES) skipped++
                else files[`${prefix}${entry.name}`] = await file.text()
            }
        }
    }
    await walk(handle as DirHandle, '', 0)
    // In the order a file explorer lists them.
    const ordered: Record<string, string> = {}
    for (const p of sortedPaths(Object.keys(files))) ordered[p] = files[p]
    return { name: handle.name, handle, files: ordered, skipped }
}

/** Whether the playground may write to the folder; asks (it needs a click or a key) when `ask`. */
export async function permitted(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
    const h = handle as DirHandle
    try {
        if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
        return ask && (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
    } catch {
        return false
    }
}

async function dirFor(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create })
    return { dir, name: parts[parts.length - 1] }
}

/** Writes a file of the folder (creating it, and its subfolder, if need be). */
export async function writeFile(root: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
    const { dir, name } = await dirFor(root, path, true)
    const file = await dir.getFileHandle(name, { create: true })
    const out = await file.createWritable()
    await out.write(text)
    await out.close()
}

/** Removes a file of the folder (gone already is fine). */
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
    try {
        const { dir, name } = await dirFor(root, path, false)
        await dir.removeEntry(name)
    } catch (e) {
        if ((e as DOMException)?.name !== 'NotFoundError') throw e
    }
}

// ----- Without folder access: several files, and .zip ----------------------------------------------------------

/** The .sctx files among `files` (a .zip's .sctx files too), by name; and what was left out. */
export async function readFiles(list: Iterable<File>): Promise<{ files: Record<string, string>; skipped: string[] }> {
    const files: Record<string, string> = {}
    const skipped: string[] = []
    for (const file of list) {
        if (/\.zip$/i.test(file.name)) {
            const { unzipSync, strFromU8 } = await import('fflate')
            try {
                const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: f => f.name.toLowerCase().endsWith(EXT) && f.originalSize <= MAX_BYTES })
                // A .zip of a folder has that folder as the first part of every path: drop it.
                const names = Object.keys(entries).filter(n => !n.startsWith('__MACOSX/'))
                const top = names.length && names.every(n => n.includes('/') && n.split('/')[0] === names[0].split('/')[0]) ? names[0].split('/')[0].length + 1 : 0
                for (const n of names) files[n.slice(top)] = strFromU8(entries[n])
            } catch {
                skipped.push(file.name)
            }
        } else if (/\.sctx?$/i.test(file.name) && file.size <= MAX_BYTES) {
            files[file.name.replace(/\.sct$/i, EXT)] = await file.text()
        } else {
            skipped.push(file.name)
        }
    }
    return { files, skipped }
}

/** The project as a .zip (in a folder named after it). */
export async function zipFiles(name: string, files: Record<string, string>): Promise<Blob> {
    const { zipSync, strToU8 } = await import('fflate')
    const folder = name.replace(/[^\w .-]+/g, '').trim() || 'project'
    const entries: Record<string, Uint8Array> = {}
    for (const [path, text] of Object.entries(files)) entries[`${folder}/${path}`] = strToU8(text)
    return new Blob([zipSync(entries, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
}

/** Saves a blob as a download. */
export function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
}

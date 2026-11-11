// Files on the reader's disk. A local folder (the File System Access API, Chromium): its .sctx files are read into a
// project and saved back in place. Elsewhere: several files opened at once (a .zip too), and the project downloaded
// as a .zip (fflate, loaded on demand). Everything here is guarded: a refusal or an unsupported browser is an
// answer, never a crash.

import { EXT, normalisePath, projectPath, sortedPaths } from './project'

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

/** The paths of the folder's files whose names match (two levels down, as readFolder), sorted. */
export async function listFiles(handle: FileSystemDirectoryHandle, match: RegExp): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: DirHandle, prefix: string, depth: number) => {
        for await (const entry of dir.values()) {
            if (SKIP.test(entry.name)) continue
            if (entry.kind === 'directory') {
                if (depth < 2) await walk(entry as DirHandle, `${prefix}${entry.name}/`, depth + 1)
            } else if (match.test(entry.name) && out.length < MAX_FILES) out.push(`${prefix}${entry.name}`)
        }
    }
    await walk(handle as DirHandle, '', 0)
    return sortedPaths(out)
}

/** A file of the folder, as text. */
export async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string> {
    const { dir, name } = await dirFor(root, path, false)
    return (await (await dir.getFileHandle(name)).getFile()).text()
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
    // Only a path inside the folder, as the project keeps them (`a/../b`, `../x`, `/x` never reach the disk).
    if (!path || normalisePath(path) !== path) throw new Error(`${path} is not a path inside the folder.`)
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

/** A file of the folder as text; undefined when there is none. */
async function textOrNone(root: FileSystemDirectoryHandle, path: string): Promise<string | undefined> {
    try {
        return await readText(root, path)
    } catch (e) {
        const name = (e as DOMException)?.name
        if (name === 'NotFoundError' || name === 'TypeMismatchError') return undefined
        throw e
    }
}

export interface FolderSave {
    /** The texts the folder holds now, as far as the playground knows: the next save's starting point. */
    disk: Record<string, string>
    written: string[]
    removed: string[]
    /** Files changed in the folder since they were read (another editor, `git checkout`), or there already under a
     *  name made here: left as they are. */
    conflicts: string[]
    /** Why the save stopped (what was done before is in `disk`). */
    error?: string
}

/**
 * Saves `files` into the folder, which held `disk` when the playground last read or saved it: the files that differ
 * are written, and those no longer in `files` (deleted or renamed here) removed. Each is read first: one the folder
 * changed since is a conflict and left alone, unless `force`. Nothing else in the folder is touched.
 */
export async function saveFolder(root: FileSystemDirectoryHandle, disk: Record<string, string>, files: Record<string, string>, force = false): Promise<FolderSave> {
    const has = (o: Record<string, string>, p: string) => Object.hasOwn(o, p)
    const write = Object.keys(files).filter(p => !has(disk, p) || disk[p] !== files[p])
    const gone = Object.keys(disk).filter(p => !has(files, p))
    // A rename that changes only the case (`abc.sctx` to `ABC.sctx`): on a disk that ignores case (macOS, Windows) both
    // names are one file, so the old name goes first; written first, then removed, the file would be lost.
    const recased = new Map<string, string>()
    for (const p of gone) {
        const q = write.find(w => !has(disk, w) && w.toLowerCase() === p.toLowerCase())
        if (q) recased.set(q, p)
    }
    const conflicts: string[] = []
    const next = { ...disk }
    const written: string[] = []
    const removed: string[] = []
    const remove = async (p: string) => {
        await removeFile(root, p)
        delete next[p]
        removed.push(p)
    }
    try {
        if (!force) {
            for (const p of [...write, ...gone]) {
                const now = await textOrNone(root, p)
                const base = has(disk, p) ? disk[p] : undefined
                const ok = now === base || (has(files, p) && now === files[p]) || (!has(files, p) && now === undefined) || (recased.has(p) && now === disk[recased.get(p)!])
                if (!ok) conflicts.push(p)
            }
        }
        const skip = new Set(conflicts)
        for (const [q, p] of recased) if (!skip.has(p) && !skip.has(q)) await remove(p)
        for (const p of write) {
            if (skip.has(p)) continue
            await writeFile(root, p, files[p])
            next[p] = files[p]
            written.push(p)
        }
        for (const p of gone) if (!skip.has(p) && has(next, p)) await remove(p)
    } catch (e) {
        return { disk: next, written, removed, conflicts, error: (e as Error).message }
    }
    return { disk: next, written, removed, conflicts }
}

/**
 * The folder read again (Reconnect, a reload) against the project: `take`, the files that take the folder's text (those
 * not edited here, and files new in the folder, empty ones too), and the folder's texts to save against next. A file
 * edited here keeps its text and the text it was edited from, and a file deleted or renamed here stays so, so that a
 * change in the folder meanwhile is a conflict when saving, not lost.
 */
export function mergeFolder(mine: Record<string, string>, disk: Record<string, string>, read: Record<string, string>): { take: Record<string, string>; disk: Record<string, string> } {
    const has = (o: Record<string, string>, p: string) => Object.hasOwn(o, p)
    const take: Record<string, string> = {}
    const next: Record<string, string> = {}
    for (const [p, text] of Object.entries(read)) {
        const known = has(disk, p)
        const edited = has(mine, p) ? !known || mine[p] !== disk[p] : known
        if (!edited) {
            if (!has(mine, p) || mine[p] !== text) take[p] = text
            next[p] = text
        } else if (has(mine, p) && mine[p] === text) next[p] = text
        else if (known) next[p] = disk[p]
    }
    return { take, disk: next }
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
                for (const n of names) {
                    // An entry named to climb out of the folder (`../x.sctx`) is left out.
                    const path = projectPath(n.slice(top))
                    if (path) files[path] = strFromU8(entries[n])
                }
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
    for (const [path, text] of Object.entries(files)) {
        const inside = normalisePath(path)
        if (inside) entries[`${folder}/${inside}`] = strToU8(text)
    }
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

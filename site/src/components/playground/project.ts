// The playground's project model (pure, no DOM): a set of .sctx files by path ("abro.sctx", "lib/beep.sctx"),
// one of them active (shown in the editor, drawn and simulated). Paths, names and KIELER's import rules live
// here; the controller (project-control.ts) keeps the editor states and saves.
//
// KIELER's imports (docs-internal/semantics/structure.md S-20): `import "beep"` and `import "beep.sctx"` load
// beep.sctx from the importing file's folder, `import "dir/*"` every .sctx file in dir, `import "*"` the file's
// own folder; a file never imports itself, and charts of a file that is not imported are not visible. The engine
// makes every file it is given visible, so the playground passes only the files the active file imports,
// transitively (`importedFiles`), keyed relative to the active file's folder (as the engine checks imports).

/** A project as it is stored and shared. */
export interface ProjectData {
    /** Its key in the browser's store, once saved there. */
    id?: string
    name: string
    /** The files by path, in the order they were added. */
    files: Record<string, string>
    /** The path of the active file. */
    active: string
    /** The files open in the editor's tabs (the active one among them). */
    open: string[]
    /** Last saved (ms since 1970), for the list of recent projects. */
    updated?: number
}

export const EXT = '.sctx'

/** Sorted as a file explorer lists them: by folder, then by name, ignoring case. */
export function sortedPaths(paths: Iterable<string>): string[] {
    return [...paths].sort((a, b) => {
        const da = dirOf(a)
        const db = dirOf(b)
        if (da !== db) return da.localeCompare(db, 'en', { sensitivity: 'base' })
        return a.localeCompare(b, 'en', { sensitivity: 'base' })
    })
}

/** The folder part of a path, with its trailing slash ("" at the top). */
export function dirOf(path: string): string {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i + 1)
}

/** The file name of a path. */
export function baseOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
}

/** Whether `files` has a file at `path` (its own: `toString` or `__proto__` is no file). */
export const hasFile = (files: Record<string, string>, path: string): boolean => Object.hasOwn(files, path)

/** `a/./b/../c` → `a/c`; null when it climbs out of the project. */
export function normalisePath(path: string): string | null {
    const out: string[] = []
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (!out.length) return null
            out.pop()
        } else out.push(part)
    }
    return out.join('/')
}

/** A path from outside (a link, a .zip, a page): normalised, a `.sctx` file, inside the project; else null. */
export function projectPath(path: string): string | null {
    const p = normalisePath(path)
    return p && /\.sctx$/i.test(p) && baseOf(p) !== EXT ? p : null
}

/**
 * A file name the reader typed, as a path: trimmed, `.sctx` appended when missing, no leading slash. An error
 * message (plain words) when it cannot be one: empty, outside the project, odd characters, or taken.
 */
export function checkName(input: string, taken: Iterable<string>, self?: string): { path: string } | { error: string } {
    let name = input.trim().replace(/^\/+/, '')
    if (!name) return { error: 'Type a name for the file.' }
    if (!/\.sctx$/i.test(name)) name += EXT
    const path = normalisePath(name)
    if (!path || path.endsWith('/') || baseOf(path) === EXT) return { error: 'That is not a file name.' }
    if (!/^[\w ./+-]+$/.test(path)) return { error: 'Use letters, digits, spaces, dots, dashes and underscores.' }
    const lower = path.toLowerCase()
    for (const t of taken) if (t !== self && t.toLowerCase() === lower) return { error: `There is already a file called ${path}.` }
    return { path }
}

/** A free name like `untitled.sctx`, `untitled-2.sctx`. */
export function freeName(stem: string, taken: Iterable<string>): string {
    const all = new Set([...taken].map(t => t.toLowerCase()))
    for (let i = 1; ; i++) {
        const name = `${stem}${i > 1 ? `-${i}` : ''}${EXT}`
        if (!all.has(name.toLowerCase())) return name
    }
}

/** The names of a source's `import "…"` lines (comments ignored). */
export function importsOf(source: string): string[] {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
    return [...text.matchAll(/^\s*import\s+"([^"]*)"/gm)].map(m => m[1])
}

/** The paths `import "name"` in the file `from` loads (S-20), among `paths`. */
export function resolveImport(name: string, from: string, paths: string[]): string[] {
    const dir = dirOf(from)
    if (name.endsWith('*')) {
        const folder = normalisePath(dir + name.slice(0, -1))
        if (folder === null) return []
        const prefix = folder ? `${folder}/` : ''
        return paths.filter(p => p !== from && p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p.endsWith(EXT))
    }
    const target = normalisePath(dir + (name.endsWith(EXT) ? name : name + EXT))
    return target && target !== from && paths.includes(target) ? [target] : []
}

/** `to` relative to the folder `dir` ("lib/" + "lib/x.sctx" → "x.sctx"; "lib/" + "y.sctx" → "../y.sctx"). */
export function relativeTo(dir: string, to: string): string {
    const a = dir.split('/').filter(Boolean)
    const b = to.split('/')
    let i = 0
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

/**
 * The files the active file imports, transitively, by path relative to its folder: what `compile(source, { files })`
 * gets, so that a chart of a file that is not imported stays invisible, as in KIELER.
 */
export function importedFiles(files: Record<string, string>, active: string): Record<string, string> {
    const paths = Object.keys(files)
    const seen = new Set<string>([active])
    const queue = [active]
    const out: Record<string, string> = {}
    while (queue.length) {
        const from = queue.shift()!
        for (const name of importsOf(files[from] ?? '')) {
            for (const p of resolveImport(name, from, paths)) {
                if (seen.has(p)) continue
                seen.add(p)
                queue.push(p)
                out[relativeTo(dirOf(active), p)] = files[p]
            }
        }
    }
    return out
}

/** The file name of an example (`learn/actions/during` → `during.sctx`). */
export function exampleFile(id: string): string {
    return `${baseOf(id.replace(/\.sctx$/, '')) || 'chart'}${EXT}`
}

/** An example as a project: its own chart, active, and the files it imports beside it. */
export function exampleProject(id: string, source: string, imports: Record<string, string>, name: string): ProjectData {
    const main = exampleFile(id)
    return { name, files: { [main]: source, ...imports }, active: main, open: [main] }
}

/** A project of one file. */
export function singleFile(path: string, text: string, name: string): ProjectData {
    return { name, files: { [path]: text }, active: path, open: [path] }
}

/** The project with `files`, `active` among them (else the first), `open` cleaned up. */
export function makeProject(name: string, files: Record<string, string>, active?: string, open?: string[]): ProjectData {
    const paths = Object.keys(files)
    const act = active && hasFile(files, active) ? active : sortedPaths(paths)[0] ?? ''
    const tabs = (open ?? [act]).filter((p, i, all) => hasFile(files, p) && all.indexOf(p) === i)
    if (act && !tabs.includes(act)) tabs.push(act)
    return { name, files, active: act, open: tabs }
}

/** Whether two file maps hold the same files with the same texts. */
export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => hasFile(b, k) && a[k] === b[k])
}

// Which files an `import` loads (structure.md S-20), as KIELER resolves them: relative to the importing file's folder;
// `import "beep"` and `import "beep.sctx"` load beep.sctx, `import "dir/*"` the .sctx files directly in dir (not in
// its subfolders, probe tests/engine/kieler/imports/probe-import-folder-nested). A file never imports itself.

/** The paths among `files` that `import "name"` in the file `from` loads (`from` is '' for the main file). */
export function importTargets(name: string, from: string, files: string[]): string[] {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    if (name.endsWith('*')) {
        const folder = normalise(dir + name.slice(0, -1))
        const prefix = folder ? `${folder}/` : ''
        return files.filter(f => f !== from && f.startsWith(prefix) && !f.slice(prefix.length).includes('/') && f.endsWith('.sctx'))
    }
    const target = normalise(dir + (name.endsWith('.sctx') ? name : `${name}.sctx`))
    return target !== from && files.includes(target) ? [target] : []
}

/** `a/./b/../c` as `a/c`. Paths are relative to the main file, so they may start with `..` (a file above it). */
function normalise(path: string): string {
    const out: string[] = []
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop()
        else out.push(part)
    }
    return out.join('/')
}

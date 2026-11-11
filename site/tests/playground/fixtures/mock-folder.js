// A folder on disk as the File System Access API hands it out (FileSystemDirectoryHandle), in memory: what folder.ts
// uses of it. `caseInsensitive`: names match ignoring case, as on macOS and Windows (a file keeps the name it was
// made with). Plain JavaScript, so that a test can load it into a page too (`page.addInitScript({ path })`), where it
// is `window.mockFolder`. `folder.files()` lists every file by path; `folder.put(path, text)` and
// `folder.remove(path)` change it behind the playground's back.
;(() => {
    function mockFolder(initial = {}, { caseInsensitive = false, name = 'project' } = {}) {
        const key = n => (caseInsensitive ? n.toLowerCase() : n)
        const notFound = n => new DOMException(`${n} is not there`, 'NotFoundError')
        const dir = n => ({ kind: 'directory', name: n, entries: new Map() })
        const top = dir(name)

        function handle(node) {
            if (node.kind === 'file') {
                return {
                    kind: 'file',
                    name: node.name,
                    async getFile() {
                        return new File([node.text], node.name)
                    },
                    async createWritable() {
                        let next = ''
                        return {
                            async write(t) {
                                next += String(t)
                            },
                            async close() {
                                node.text = next
                            },
                        }
                    },
                }
            }
            const child = (n, kind, create) => {
                if (typeof n !== 'string' || !n || n === '.' || n === '..' || n.includes('/')) throw new TypeError(`Name is not allowed: ${n}`)
                let c = node.entries.get(key(n))
                if (!c) {
                    if (!create) throw notFound(n)
                    c = kind === 'file' ? { kind: 'file', name: n, text: '' } : dir(n)
                    node.entries.set(key(n), c)
                }
                if (c.kind !== kind) throw new DOMException(`${n} is a ${c.kind}`, 'TypeMismatchError')
                return handle(c)
            }
            return {
                kind: 'directory',
                name: node.name,
                async *values() {
                    for (const c of [...node.entries.values()]) yield handle(c)
                },
                async getFileHandle(n, o = {}) {
                    return child(n, 'file', !!o.create)
                },
                async getDirectoryHandle(n, o = {}) {
                    return child(n, 'directory', !!o.create)
                },
                async removeEntry(n) {
                    if (!node.entries.delete(key(n))) throw notFound(n)
                },
                async queryPermission() {
                    return 'granted'
                },
                async requestPermission() {
                    return 'granted'
                },
            }
        }

        function nodeAt(path, create) {
            const parts = path.split('/')
            let node = top
            for (const p of parts.slice(0, -1)) {
                let c = node.entries.get(key(p))
                if (!c && create) node.entries.set(key(p), (c = dir(p)))
                if (!c || c.kind !== 'directory') return undefined
                node = c
            }
            return { node, name: parts[parts.length - 1] }
        }

        const folder = handle(top)
        folder.put = (path, text) => {
            const at = nodeAt(path, true)
            const f = at.node.entries.get(key(at.name))
            if (f) f.text = text
            else at.node.entries.set(key(at.name), { kind: 'file', name: at.name, text })
        }
        folder.remove = path => {
            const at = nodeAt(path, false)
            at?.node.entries.delete(key(at.name))
        }
        folder.files = () => {
            const out = {}
            const walk = (node, prefix) => {
                for (const c of node.entries.values()) {
                    if (c.kind === 'file') out[prefix + c.name] = c.text
                    else walk(c, `${prefix}${c.name}/`)
                }
            }
            walk(top, '')
            return out
        }
        for (const [p, t] of Object.entries(initial)) folder.put(p, t)
        return folder
    }
    globalThis.mockFolder = mockFolder
})()

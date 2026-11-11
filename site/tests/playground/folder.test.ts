// A folder on the reader's disk (folder.ts): Save writes what differs and removes what was deleted or renamed, and
// never touches what it should not: a file the folder changed meanwhile, a file it never read, a file that is not a
// chart, anything outside the folder. Driven on an in-memory FileSystemDirectoryHandle (fixtures/mock-folder.js),
// one that matches names exactly and one that ignores case (macOS, Windows).
import { describe, expect, test } from 'vitest'
import { createFile, listFiles, mergeFolder, readFolder, saveFolder } from '../../src/components/playground/folder'
import { traceFileName } from '../../src/components/playground/trace-actions'
import './fixtures/mock-folder.js'

interface Mock extends FileSystemDirectoryHandle {
    files(): Record<string, string>
    put(path: string, text: string): void
    remove(path: string): void
}
const mockFolder = (globalThis as unknown as { mockFolder: (files: Record<string, string>, o?: { caseInsensitive?: boolean }) => Mock }).mockFolder

const A = 'scchart A {}\n'
const B = 'scchart B {}\n'

/** A folder as the playground opened it: the handle and the texts it read. */
async function opened(files: Record<string, string>, caseInsensitive = false) {
    const folder = mockFolder(files, { caseInsensitive })
    const read = await readFolder(folder)
    return { folder, disk: read.files }
}

describe('Save', () => {
    test('writes the files that differ, removes those deleted or renamed here, leaves everything else', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B, 'lib/c.sctx': A, 'notes.txt': 'mine', 'lib/run.csv': 'tick' })
        const saved = await saveFolder(folder, disk, { 'a.sctx': A + '// edited\n', 'lib/d.sctx': A, 'new/e.sctx': B })
        expect(saved).toMatchObject({ written: ['a.sctx', 'lib/d.sctx', 'new/e.sctx'], removed: ['b.sctx', 'lib/c.sctx'], conflicts: [] })
        expect(folder.files()).toEqual({ 'a.sctx': A + '// edited\n', 'notes.txt': 'mine', 'lib/run.csv': 'tick', 'lib/d.sctx': A, 'new/e.sctx': B })
        expect(saved.disk).toEqual({ 'a.sctx': A + '// edited\n', 'lib/d.sctx': A, 'new/e.sctx': B })
        // Nothing to do the second time.
        expect(await saveFolder(folder, saved.disk, { 'a.sctx': A + '// edited\n', 'lib/d.sctx': A, 'new/e.sctx': B })).toMatchObject({ written: [], removed: [], conflicts: [] })
    })

    test('a file changed in the folder since it was read is neither written over nor removed, unless forced', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B })
        folder.put('a.sctx', 'theirs a')
        folder.put('b.sctx', 'theirs b')
        const saved = await saveFolder(folder, disk, { 'a.sctx': 'mine a', 'c.sctx': B })
        expect(saved.conflicts).toEqual(['a.sctx', 'b.sctx'])
        expect(folder.files()).toEqual({ 'a.sctx': 'theirs a', 'b.sctx': 'theirs b', 'c.sctx': B })
        // Still unsaved: the next save starts from the texts as they were read.
        expect(saved.disk).toEqual({ 'a.sctx': A, 'b.sctx': B, 'c.sctx': B })
        const forced = await saveFolder(folder, saved.disk, { 'a.sctx': 'mine a', 'c.sctx': B }, true)
        expect(forced).toMatchObject({ written: ['a.sctx'], removed: ['b.sctx'], conflicts: [] })
        expect(folder.files()).toEqual({ 'a.sctx': 'mine a', 'c.sctx': B })
    })

    test('a file in the folder that it never read is not written over by one made here under its name', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A })
        folder.put('helper.sctx', 'theirs')
        expect((await saveFolder(folder, disk, { 'a.sctx': A, 'helper.sctx': 'mine' })).conflicts).toEqual(['helper.sctx'])
        expect(folder.files()['helper.sctx']).toBe('theirs')
    })

    test('the same text on both sides is no conflict; a file removed on both sides neither', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B })
        folder.put('a.sctx', 'same')
        folder.remove('b.sctx')
        expect(await saveFolder(folder, disk, { 'a.sctx': 'same' })).toMatchObject({ conflicts: [], disk: { 'a.sctx': 'same' } })
    })

    test.each([false, true])('a rename that changes only the case keeps the file (a disk that ignores case: %s)', async caseInsensitive => {
        const { folder, disk } = await opened({ 'abc.sctx': A, 'lib/x.sctx': B }, caseInsensitive)
        const saved = await saveFolder(folder, disk, { 'ABC.sctx': A, 'lib/X.sctx': B + '// edited\n' })
        expect(saved.conflicts).toEqual([])
        expect(folder.files()).toEqual({ 'ABC.sctx': A, 'lib/X.sctx': B + '// edited\n' })
    })

    test('a path that would leave the folder is refused, and nothing is written for it', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A })
        for (const bad of ['../x.sctx', 'a/../../x.sctx', '/x.sctx', 'a//x.sctx']) {
            const saved = await saveFolder(folder, disk, { 'a.sctx': A, [bad]: 'x' })
            expect(saved.error).toMatch(/not a path inside the folder/)
            expect(folder.files()).toEqual({ 'a.sctx': A })
        }
    })

    test('a failure midway: what was written counts as saved, the rest stays unsaved', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B })
        const failing = Object.assign(Object.create(folder), {
            async getFileHandle(name: string, o?: { create?: boolean }) {
                if (name === 'b.sctx' && o?.create) throw new DOMException('The disk is full.', 'QuotaExceededError')
                return folder.getFileHandle(name, o)
            },
        }) as FileSystemDirectoryHandle
        const saved = await saveFolder(failing, disk, { 'a.sctx': 'a2', 'b.sctx': 'b2' })
        expect(saved).toMatchObject({ written: ['a.sctx'], error: 'The disk is full.', disk: { 'a.sctx': 'a2', 'b.sctx': B } })
    })
})

describe("a panel tab's new file (a run saved into the folder)", () => {
    test.each([false, true])('never written over a file there, beyond the listing too (a disk that ignores case: %s)', async caseInsensitive => {
        const files: Record<string, string> = {}
        for (let i = 0; i < 250; i++) files[`old-${i}.csv`] = 'tick\n'
        files[caseInsensitive ? 'lamp-RUN.csv' : 'Lamp-run.csv'] = 'precious'
        files['Lamp-run-2.csv'] = 'precious 2'
        const folder = mockFolder(files, { caseInsensitive })
        const listed = await listFiles(folder, /\.csv$/i)
        expect(listed).toHaveLength(200)
        const name = await createFile(folder, seen => traceFileName('Lamp', 'csv', false, [...listed, ...seen]), 'tick,lit\n')
        expect(name).toBe('Lamp-run-3.csv')
        expect(Object.values(folder.files()).filter(t => t.startsWith('precious'))).toHaveLength(2)
    })
})

describe('the folder read again (Reconnect, a reload)', () => {
    test('files not edited here take the folder\'s text; files new in the folder come in, empty ones too', () => {
        const merged = mergeFolder({ 'a.sctx': A, 'b.sctx': B }, { 'a.sctx': A, 'b.sctx': B }, { 'a.sctx': 'theirs', 'b.sctx': B, 'new.sctx': '', 'lib/n.sctx': A })
        expect(merged.take).toEqual({ 'a.sctx': 'theirs', 'new.sctx': '', 'lib/n.sctx': A })
        expect(merged.disk).toEqual({ 'a.sctx': 'theirs', 'b.sctx': B, 'new.sctx': '', 'lib/n.sctx': A })
    })

    test('a file edited here keeps its text and what it was edited from, so that Save sees the change as a conflict', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A })
        folder.put('a.sctx', 'theirs')
        const mine = { 'a.sctx': 'mine' }
        const merged = mergeFolder(mine, disk, (await readFolder(folder)).files)
        expect(merged).toEqual({ take: {}, drop: [], disk: { 'a.sctx': A } })
        expect((await saveFolder(folder, merged.disk, mine)).conflicts).toEqual(['a.sctx'])
    })

    test('a file the folder deleted leaves the project unless edited here; an edited one is a conflict, never written back unasked', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B, 'c.sctx': A })
        folder.remove('a.sctx')
        folder.remove('c.sctx')
        const mine = { 'a.sctx': A, 'b.sctx': B, 'c.sctx': 'mine' }
        const merged = mergeFolder(mine, disk, (await readFolder(folder)).files)
        expect(merged.drop).toEqual(['a.sctx'])
        expect(merged.take).toEqual({})
        // The project as Reconnect leaves it: without the file the folder deleted.
        const saved = await saveFolder(folder, merged.disk, { 'b.sctx': B, 'c.sctx': 'mine' })
        expect(saved.conflicts).toEqual(['c.sctx'])
        expect(folder.files()).toEqual({ 'b.sctx': B })
        // Overwrite, the reader's choice, writes it back.
        expect((await saveFolder(folder, merged.disk, { 'b.sctx': B, 'c.sctx': 'mine' }, true)).written).toEqual(['c.sctx'])
    })

    test('a file deleted or renamed here stays so; changed in the folder meanwhile, Save keeps it', async () => {
        const { folder, disk } = await opened({ 'a.sctx': A, 'b.sctx': B })
        const mine = { 'a2.sctx': A }
        let merged = mergeFolder(mine, disk, (await readFolder(folder)).files)
        expect(merged.take).toEqual({})
        folder.put('b.sctx', 'theirs')
        merged = mergeFolder(mine, merged.disk, (await readFolder(folder)).files)
        const saved = await saveFolder(folder, merged.disk, mine)
        expect(saved.conflicts).toEqual(['b.sctx'])
        expect(folder.files()).toEqual({ 'a2.sctx': A, 'b.sctx': 'theirs' })
    })
})

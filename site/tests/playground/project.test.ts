// The playground's projects: paths and names, KIELER's import rules (structure.md S-20) as the files the active file
// is compiled with, and share links for projects of several files.
import { describe, expect, test } from 'vitest'
import { compile } from '@sccharts-lab/engine'
import { checkName, exampleFile, exampleProject, freeName, importedFiles, importsOf, makeProject, normalisePath, relativeTo, resolveImport, sameFiles, sortedPaths } from '../../src/components/playground/project'
import { decodeProject, encodeProject, hashForProject, projectFromHash, runUrl, sourceFromHash } from '../../src/components/playground/share'

const beep = 'scchart Beep {\n  input bool on\n  output bool tone = false\n  initial state Quiet\n    if on do tone = true go to Loud\n  state Loud\n}\n'
const main = (imp: string) => `${imp}\n\nscchart Main {\n  input bool b\n  output bool t\n  initial state S is Beep(b to on, t to tone)\n}\n`

describe('paths and names', () => {
    test('normalised paths stay in the project', () => {
        expect(normalisePath('a/./b/../c.sctx')).toBe('a/c.sctx')
        expect(normalisePath('../x.sctx')).toBeNull()
        expect(normalisePath('\\lib\\x.sctx')).toBe('lib/x.sctx')
    })

    test('a name typed becomes a .sctx path, or says why not', () => {
        expect(checkName(' beep ', [])).toEqual({ path: 'beep.sctx' })
        expect(checkName('lib/Beep.SCTX', [])).toEqual({ path: 'lib/Beep.SCTX' })
        expect(checkName('', [])).toEqual({ error: 'Type a name for the file.' })
        expect(checkName('a?b', [])).toHaveProperty('error')
        expect(checkName('../up', [])).toHaveProperty('error')
        expect(checkName('Beep', ['beep.sctx'])).toEqual({ error: 'There is already a file called Beep.sctx.' })
        // Renaming a file to itself (another case) is not a clash.
        expect(checkName('Beep', ['beep.sctx'], 'beep.sctx')).toEqual({ path: 'Beep.sctx' })
    })

    test('free names, sorting, examples', () => {
        expect(freeName('untitled', ['untitled.sctx', 'Untitled-2.sctx'])).toBe('untitled-3.sctx')
        expect(sortedPaths(['lib/b.sctx', 'Main.sctx', 'a.sctx', 'lib/A.sctx'])).toEqual(['a.sctx', 'Main.sctx', 'lib/A.sctx', 'lib/b.sctx'])
        expect(exampleFile('learn/actions/during')).toBe('during.sctx')
        expect(exampleProject('advanced/references/import-main', 'x', { 'push-switch.sctx': 'y' }, 'HallLights')).toEqual({
            name: 'HallLights',
            files: { 'import-main.sctx': 'x', 'push-switch.sctx': 'y' },
            active: 'import-main.sctx',
            open: ['import-main.sctx'],
        })
        const p = makeProject('P', { 'b.sctx': '', 'a.sctx': '' }, 'gone.sctx', ['gone.sctx', 'b.sctx'])
        expect(p.active).toBe('a.sctx')
        expect(p.open).toEqual(['b.sctx', 'a.sctx'])
        expect(sameFiles({ a: '1' }, { a: '1' })).toBe(true)
        expect(sameFiles({ a: '1' }, { a: '1', b: '' })).toBe(false)
    })
})

describe("KIELER's imports (S-20)", () => {
    test('import lines, comments ignored', () => {
        expect(importsOf('import "a"\n// import "b"\n/* import "c" */\n  import "d.sctx"\nscchart X {}')).toEqual(['a', 'd.sctx'])
    })

    test('an import loads a file of the importing file\'s folder; dir/* every file of dir; never the file itself', () => {
        const paths = ['main.sctx', 'beep.sctx', 'lib/x.sctx', 'lib/y.sctx', 'lib/deep/z.sctx']
        expect(resolveImport('beep', 'main.sctx', paths)).toEqual(['beep.sctx'])
        expect(resolveImport('beep.sctx', 'main.sctx', paths)).toEqual(['beep.sctx'])
        expect(resolveImport('lib/*', 'main.sctx', paths)).toEqual(['lib/x.sctx', 'lib/y.sctx'])
        expect(resolveImport('*', 'main.sctx', paths)).toEqual(['beep.sctx'])
        expect(resolveImport('x', 'lib/y.sctx', paths)).toEqual(['lib/x.sctx'])
        expect(resolveImport('../beep', 'lib/y.sctx', paths)).toEqual(['beep.sctx'])
        expect(resolveImport('main', 'main.sctx', paths)).toEqual([])
        expect(relativeTo('lib/', 'beep.sctx')).toBe('../beep.sctx')
        expect(relativeTo('lib/', 'lib/x.sctx')).toBe('x.sctx')
    })

    test('the files the active file is compiled with: what it imports, transitively, and nothing else', () => {
        const files = { 'main.sctx': main('import "a"'), 'a.sctx': 'import "b"\nscchart A {\n  initial state S\n}\n', 'b.sctx': beep, 'other.sctx': 'scchart Other {\n  initial state S\n}\n' }
        expect(Object.keys(importedFiles(files, 'main.sctx')).sort()).toEqual(['a.sctx', 'b.sctx'])
        expect(importedFiles(files, 'other.sctx')).toEqual({})
    })

    test('a chart in a file that is not imported stays invisible, as in KIELER', () => {
        const files = { 'main.sctx': main(''), 'beep.sctx': beep }
        const without = compile(files['main.sctx'], { files: importedFiles(files, 'main.sctx') })
        expect(without.ok).toBe(false)
        expect(without.diagnostics.some(d => d.severity === 'error')).toBe(true)
        const imported = { ...files, 'main.sctx': main('import "beep"') }
        const withImport = compile(imported['main.sctx'], { files: importedFiles(imported, 'main.sctx') })
        expect(withImport.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    })

    test('a file in a folder imports by a path relative to it', () => {
        const files = { 'app/main.sctx': main('import "../lib/beep"'), 'lib/beep.sctx': beep }
        const imported = importedFiles(files, 'app/main.sctx')
        expect(Object.keys(imported)).toEqual(['../lib/beep.sctx'])
        const result = compile(files['app/main.sctx'], { files: imported })
        expect(result.diagnostics.filter(d => d.severity !== 'info')).toEqual([])
    })
})

describe('share links of projects', () => {
    const project = { name: 'Two files', files: { 'main.sctx': main('import "beep"'), 'beep.sctx': beep }, active: 'main.sctx' }

    test('round trip; a project of one file is a #code= link', () => {
        expect(decodeProject(encodeProject(project))).toEqual(project)
        expect(projectFromHash(hashForProject(project))).toEqual(project)
        const single = { name: 'One', files: { 'beep.sctx': beep }, active: 'beep.sctx' }
        expect(hashForProject(single)).toMatch(/^#code=/)
        expect(sourceFromHash(hashForProject(single))).toBe(beep)
    })

    test('damaged links give null; an unknown active file falls back to the first', () => {
        expect(decodeProject('xyz')).toBeNull()
        expect(projectFromHash('#project=')).toBeNull()
        const odd = decodeProject(encodeProject({ ...project, active: 'gone.sctx' }))
        expect(odd?.active).toBe('main.sctx')
    })

    test('a run of a project carries the project', () => {
        const url = runUrl('https://x.test/playground/', { ticks: [{ b: true }], at: 1 }, { project })
        expect(url).toMatch(/#project=.+&run=/)
        expect(projectFromHash(new URL(url).hash)).toEqual(project)
    })
})

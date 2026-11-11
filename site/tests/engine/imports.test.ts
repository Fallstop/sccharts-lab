// Which files an import loads (S-20): relative to the importing file, ".sctx" optional, a folder's files one level
// down only, paths relative to the main file (so they may start with ".."), never the importing file itself.
import { describe, expect, test } from 'vitest'
import { importTargets } from '@sccharts-lab/engine/parser/imports'
import { compile } from '@sccharts-lab/engine'

const files = ['beep.sctx', 'lib/a.sctx', 'lib/b.sctx', 'lib/deep/c.sctx', '../common.sctx', '../up/u.sctx']

describe('import targets', () => {
    test('a file, with or without .sctx, relative to the importing file', () => {
        expect(importTargets('beep', '', files)).toEqual(['beep.sctx'])
        expect(importTargets('beep.sctx', '', files)).toEqual(['beep.sctx'])
        expect(importTargets('b', 'lib/a.sctx', files)).toEqual(['lib/b.sctx'])
        expect(importTargets('../beep', 'lib/a.sctx', files)).toEqual(['beep.sctx'])
        expect(importTargets('nothere', '', files)).toEqual([])
        expect(importTargets('a', 'lib/a.sctx', files)).toEqual([])
    })
    test('a folder: its files, not those of its subfolders', () => {
        expect(importTargets('lib/*', '', files)).toEqual(['lib/a.sctx', 'lib/b.sctx'])
        expect(importTargets('*', 'lib/a.sctx', files)).toEqual(['lib/b.sctx'])
    })
    test('above the main file (the playground passes a subfolder file\'s imports relative to it)', () => {
        expect(importTargets('../common', '', files)).toEqual(['../common.sctx'])
        expect(importTargets('u', '../up/u.sctx', files)).toEqual([])
        expect(importTargets('../common', 'lib/a.sctx', files)).toEqual([])
        expect(importTargets('../../common', 'lib/a.sctx', files)).toEqual(['../common.sctx'])
    })
    test('a chart importing a file above it compiles without a broken-import warning', () => {
        const r = compile('import "../common"\nscchart Main {\n  initial state A is Common\n}\n', { files: { '../common.sctx': 'scchart Common {\n  initial state C\n}\n' } })
        expect(r.diagnostics.filter(d => d.code === 'broken-import' || d.severity === 'error')).toEqual([])
    })
})

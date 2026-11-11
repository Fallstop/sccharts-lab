// The postMessage protocol (packages/embed/src/protocol.ts): what the embed takes as a command, what it answers with an
// error, and what it ignores.
import { describe, expect, test } from 'vitest'
import { checkInputs, checkPath, envelope, isValue, LIMITS, parseCommand, parseEvent, PROTOCOL, VERSION } from '@sccharts-lab/embed/protocol'

const cmd = (body: Record<string, unknown>) => ({ type: PROTOCOL, version: VERSION, ...body })

describe('messages that are not commands are ignored', () => {
    test.each([
        ['nothing', undefined],
        ['a string', 'step'],
        ['a number', 1],
        ['an array', [cmd({ command: 'step' })]],
        ['another protocol', { type: 'other', version: 1, command: 'step' }],
        ['no command', { type: PROTOCOL, version: 1 }],
        ['an event (our own echo)', { type: PROTOCOL, version: 1, event: 'tick' }],
        ['a command that is not a string', cmd({ command: { toString: () => 'step' } })],
    ])('%s', (_, data) => {
        expect(parseCommand(data)).toEqual({ kind: 'ignore' })
    })
})

describe('commands in the envelope that cannot run are answered', () => {
    test('another version', () => {
        const p = parseCommand({ type: PROTOCOL, version: 2, command: 'step', id: 7 })
        expect(p).toMatchObject({ kind: 'invalid', id: 7, command: 'step' })
        if (p.kind === 'invalid') expect(p.error).toMatch(/version 1/)
    })

    test('an unknown command names the commands', () => {
        const p = parseCommand(cmd({ command: 'eval', code: 'alert(1)' }))
        expect(p).toMatchObject({ kind: 'invalid', command: 'eval' })
        if (p.kind === 'invalid') expect(p.error).toMatch(/setSource/)
    })

    test.each([
        ['setSource without text', { command: 'setSource', source: 42 }],
        ['setSource too long', { command: 'setSource', source: 'x'.repeat(LIMITS.source + 1) }],
        ['setFiles without files', { command: 'setFiles', files: {} }],
        ['setFiles with a path out of the project', { command: 'setFiles', files: { '../x.sctx': 'scchart X {}' } }],
        ['setFiles with an absolute path', { command: 'setFiles', files: { '/x.sctx': '' } }],
        ['setFiles with a file that is not .sctx', { command: 'setFiles', files: { 'x.js': '' } }],
        ['setFiles with a text that is not a string', { command: 'setFiles', files: { 'x.sctx': 1 } }],
        ['setFiles whose active file is not there', { command: 'setFiles', files: { 'x.sctx': '' }, active: 'y.sctx' }],
        ['setFiles whose active file is a key of every object', { command: 'setFiles', files: { 'x.sctx': '' }, active: 'toString' }],
        ['setFiles whose active file is __proto__', { command: 'setFiles', files: { 'x.sctx': '' }, active: '__proto__' }],
        ['setFiles with a __proto__ file', { command: 'setFiles', files: JSON.parse('{"__proto__": "x", "x.sctx": ""}') }],
        ['selectChart without a name', { command: 'selectChart', chart: 'not a name' }],
        ['step with inputs that are not an object', { command: 'step', inputs: [true] }],
        ['step with a value that is an object', { command: 'step', inputs: { A: { valueOf: 1 } } }],
        ['step with an infinite number', { command: 'step', inputs: { n: Infinity } }],
        ['step with a name that is not an identifier', { command: 'step', inputs: { 'a-b': true } }],
        ['step with __proto__', { command: 'step', inputs: JSON.parse('{"__proto__": true}') }],
        ['setInputs without inputs', { command: 'setInputs' }],
        ['rewind to a negative tick', { command: 'rewind', tick: -1 }],
        ['rewind to half a tick', { command: 'rewind', tick: 1.5 }],
    ])('%s', (_, body) => {
        const p = parseCommand(cmd({ ...body, id: 'q1' }))
        expect(p.kind).toBe('invalid')
        if (p.kind === 'invalid') {
            expect(p.id).toBe('q1')
            expect(p.error.length).toBeGreaterThan(5)
        }
    })

    test('an id that is not a short string or a number is dropped', () => {
        expect(parseCommand(cmd({ command: 'reset', id: { x: 1 } }))).toEqual({ kind: 'command', message: cmd({ command: 'reset' }) })
        expect(parseCommand(cmd({ command: 'reset', id: 'x'.repeat(LIMITS.id + 1) }))).toEqual({ kind: 'command', message: cmd({ command: 'reset' }) })
    })
})

describe('commands', () => {
    test('each one, copied with only the fields it uses', () => {
        expect(parseCommand(cmd({ command: 'setSource', source: 'scchart A {}', extra: 1, id: 3 }))).toEqual({ kind: 'command', message: cmd({ command: 'setSource', source: 'scchart A {}', id: 3 }) })
        expect(parseCommand(cmd({ command: 'setFiles', files: { 'main.sctx': 'a', 'lib/b.sctx': 'b' }, active: 'lib/b.sctx', name: ' P ' }))).toEqual({
            kind: 'command',
            message: cmd({ command: 'setFiles', files: { 'main.sctx': 'a', 'lib/b.sctx': 'b' }, active: 'lib/b.sctx', name: 'P' }),
        })
        expect(parseCommand(cmd({ command: 'selectChart', chart: 'Main' }))).toEqual({ kind: 'command', message: cmd({ command: 'selectChart', chart: 'Main' }) })
        expect(parseCommand(cmd({ command: 'step' }))).toEqual({ kind: 'command', message: cmd({ command: 'step' }) })
        expect(parseCommand(cmd({ command: 'step', inputs: { A: true, V_val: 3, s: 'x', arr: [1, 2], none: null } }))).toEqual({
            kind: 'command',
            message: cmd({ command: 'step', inputs: { A: true, V_val: 3, s: 'x', arr: [1, 2], none: null } }),
        })
        expect(parseCommand(cmd({ command: 'setInputs', inputs: {} }))).toEqual({ kind: 'command', message: cmd({ command: 'setInputs', inputs: {} }) })
        expect(parseCommand(cmd({ command: 'reset' }))).toEqual({ kind: 'command', message: cmd({ command: 'reset' }) })
        expect(parseCommand(cmd({ command: 'rewind', tick: 0 }))).toEqual({ kind: 'command', message: cmd({ command: 'rewind', tick: 0 }) })
        expect(parseCommand(cmd({ command: 'getState' }))).toEqual({ kind: 'command', message: cmd({ command: 'getState' }) })
    })

    test('the copy shares nothing with the message', () => {
        const inputs = { A: true }
        const p = parseCommand(cmd({ command: 'step', inputs }))
        if (p.kind !== 'command' || p.message.command !== 'step') throw new Error('not a step')
        expect(p.message.inputs).not.toBe(inputs)
        inputs.A = false
        expect(p.message.inputs).toEqual({ A: true })
    })
})

describe('values, inputs and paths', () => {
    test('values a chart can take', () => {
        for (const v of [true, 0, -2.5, 'x', null, [], [1, [2, [3]]]]) expect(isValue(v)).toBe(true)
        for (const v of [undefined, NaN, Infinity, {}, () => 1, [[[[[1]]]]], new Array(LIMITS.array + 1).fill(0)]) expect(isValue(v)).toBe(false)
    })

    test('inputs and paths', () => {
        expect(checkInputs({ A: true, V_val: 2 })).toBeUndefined()
        expect(checkInputs(null)).toMatch(/object/)
        expect(checkPath('lib/beep.sctx')).toBeUndefined()
        expect(checkPath('lib//beep.sctx')).toMatch(/not a file name/)
        expect(checkPath('./beep.sctx')).toMatch(/not a file name/)
    })
})

describe('events', () => {
    test('in the envelope', () => {
        expect(envelope({ event: 'resize', height: 3 })).toEqual({ type: 'sccharts-lab', version: 1, event: 'resize', height: 3 })
        expect(parseEvent(envelope({ event: 'tick', tick: 1 }))).toMatchObject({ event: 'tick', tick: 1 })
        expect(parseEvent({ type: PROTOCOL, version: 2, event: 'tick' })).toBeUndefined()
        expect(parseEvent(cmd({ command: 'step' }))).toBeUndefined()
        expect(parseEvent('tick')).toBeUndefined()
    })
})

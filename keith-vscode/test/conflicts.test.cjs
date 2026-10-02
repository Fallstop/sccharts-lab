const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({ vscode: {} })('src/conflicts.ts')

test('the upstream KIELER extension is reported as a conflict', () => {
    const { findConflictingExtensions } = load()
    const installed = new Set(['kieler.keith-vscode', 'kieler.klighd-vscode'])
    const conflicts = findConflictingExtensions({ getExtension: id => (installed.has(id) ? { id } : undefined) })
    assert.deepEqual(conflicts.map(extension => extension.id), ['kieler.keith-vscode'])
    assert.deepEqual(findConflictingExtensions({ getExtension: () => undefined }), [])
})

test('activation stops and offers to show the conflicting extension', async () => {
    const { reportConflictingExtensions } = load()
    const executed = []
    const window = { showErrorMessage: async (message) => { assert.match(message, /KIELER VS Code/); return 'Show conflicting extension' } }
    const commands = { executeCommand: async (...args) => { executed.push(args) } }
    assert.equal(await reportConflictingExtensions([{ id: 'kieler.keith-vscode', name: 'KIELER VS Code' }], window, commands), true)
    assert.deepEqual(executed, [['workbench.extensions.search', '@id:kieler.keith-vscode']])
    assert.equal(await reportConflictingExtensions([], window, commands), false)
})

test('one click uninstalls the conflicting extension and reloads', async () => {
    const { reportConflictingExtensions } = load()
    const executed = []
    const window = { showErrorMessage: async (_message, ...actions) => actions[0] }
    const commands = { executeCommand: async (...args) => { executed.push(args) } }
    await reportConflictingExtensions([{ id: 'kieler.keith-vscode', name: 'KIELER VS Code' }], window, commands)
    assert.deepEqual(executed, [
        ['workbench.extensions.uninstallExtension', 'kieler.keith-vscode'],
        ['workbench.action.reloadWindow'],
    ])
})

test('a failed uninstall reports why and shows the extension instead of reloading', async () => {
    const { reportConflictingExtensions } = load()
    const executed = []
    const messages = []
    const window = { showErrorMessage: async (message, ...actions) => { messages.push(message); return actions[0] } }
    const commands = {
        executeCommand: async (...args) => {
            executed.push(args)
            if (args[0] === 'workbench.extensions.uninstallExtension') throw new Error('denied')
        },
    }
    await reportConflictingExtensions([{ id: 'kieler.keith-vscode', name: 'KIELER VS Code' }], window, commands)
    assert.match(messages[1], /Could not uninstall KIELER VS Code: denied/)
    assert.deepEqual(executed.at(-1), ['workbench.extensions.search', '@id:kieler.keith-vscode'])
    assert.ok(!executed.some(([command]) => command === 'workbench.action.reloadWindow'))
})

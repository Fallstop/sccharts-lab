const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

/**
 * The language client never stores the process it is handed (see src/runtime/server-process.ts), so
 * RuntimeManager is the only thing that can end the server. These tests pin that it holds on to it,
 * signals it on the way out, and does not start a second JVM on top of one that would not go away.
 */

/** A spawned process that only does what RuntimeManager asks of it. */
function fakeSpawn(calls) {
    return (command, args, options) => {
        const listeners = new Map()
        const child = {
            pid: 5000 + calls.length,
            exitCode: null,
            signalCode: null,
            command,
            args,
            options,
            kill(signal) {
                this.kills.push(signal)
                return true
            },
            kills: [],
            on(event, listener) {
                listeners.set(event, [...(listeners.get(event) ?? []), listener])
                return this
            },
            once(event, listener) {
                return this.on(event, listener)
            },
            off(event, listener) {
                listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
                return this
            },
            emitExit(code = 0) {
                this.exitCode = code
                for (const listener of listeners.get('exit') ?? []) listener(code, null)
            },
            hasHandlerFor: (event) => (listeners.get(event) ?? []).length > 0,
        }
        calls.push(child)
        return child
    }
}

function createManager() {
    const spawned = []
    const log = []
    const context = {
        extensionPath: '/extension',
        globalStorageUri: { fsPath: '/storage' },
        // Nothing on disk, so the startup cache bows out and no archive dump interferes.
        asAbsolutePath: (relative) => `/extension/${relative}`,
        globalState: { update: async () => undefined },
        subscriptions: [],
    }
    const vscode = {
        window: {
            createOutputChannel: () => ({ appendLine: (line) => log.push(line), show() {}, dispose() {} }),
            showErrorMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            setStatusBarMessage() {},
        },
        commands: { registerCommand: () => ({ dispose() {} }), executeCommand() {} },
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        env: { openExternal() {} },
        Uri: { parse: (value) => value },
    }
    const load = createLoader({
        vscode,
        child_process: { spawn: fakeSpawn(spawned) },
        './java-runtime': {
            REQUIRED_JAVA: 21,
            findJava: async () => ({
                runtime: { command: '/jre/bin/java', home: '/jre', version: 21, source: 'bundled', description: 'T21' },
                rejected: [],
            }),
            explainMissingJava: () => '',
            hasJavaCompiler: () => true,
        },
        './c-toolchain': {
            findCCompiler: () => undefined,
            installHint: () => '',
            serverEnvironment: (env) => env,
            whichProgram: () => undefined,
            W64DevkitInstaller: class {},
        },
    })
    const { RuntimeManager } = load('src/runtime/runtime-manager.ts')
    return { manager: new RuntimeManager(context), spawned, log }
}

/** Runs `body` with process.kill replaced, so the signals can be observed instead of delivered. */
async function withCapturedSignals(body) {
    const sent = []
    const real = process.kill
    process.kill = (pid, signal) => {
        sent.push([pid, signal])
        return true
    }
    try {
        return await body(sent)
    } finally {
        process.kill = real
    }
}

test('the spawned server is kept and signalled when the extension shuts down', async () => {
    const { manager, spawned } = createManager()
    const server = await manager.launchServer()
    assert.equal(spawned.length, 1)
    await withCapturedSignals(async (sent) => {
        const stopping = manager.stopServer()
        // The whole group: the server plus the compilers and simulations it started.
        assert.deepEqual(sent, [[-server.pid, 'SIGTERM']])
        server.emitExit(0)
        await stopping
        assert.deepEqual(sent, [[-server.pid, 'SIGTERM']])
    })
})

test('the server is spawned into its own process group so its children can be reached', async () => {
    const { manager, spawned } = createManager()
    await manager.launchServer()
    assert.equal(spawned[0].options.detached, process.platform !== 'win32')
})

test('a spawn failure is handled instead of taking the extension host down', async () => {
    const { manager, spawned } = createManager()
    await manager.launchServer()
    // Without a listener, a ChildProcess 'error' event is an unhandled exception in the host.
    assert.ok(spawned[0].hasHandlerFor('error'))
})

test('starting a server ends one that a timed-out restart left behind', async () => {
    const { manager, spawned } = createManager()
    const first = await manager.launchServer()
    await withCapturedSignals(async (sent) => {
        const starting = manager.launchServer()
        assert.deepEqual(sent, [[-first.pid, 'SIGTERM']], 'the predecessor should be asked to stop first')
        first.emitExit(0)
        await starting
    })
    assert.equal(spawned.length, 2, 'the new server should start once the old one is gone')
})

test('a server that exited on its own is not signalled again', async () => {
    const { manager } = createManager()
    const server = await manager.launchServer()
    server.emitExit(0)
    await withCapturedSignals(async (sent) => {
        await manager.stopServer()
        assert.deepEqual(sent, [])
    })
})

test('disposing kills a server that is somehow still running', async () => {
    const { manager } = createManager()
    const server = await manager.launchServer()
    await withCapturedSignals(async (sent) => {
        manager.dispose()
        assert.deepEqual(sent, [[-server.pid, 'SIGKILL']])
    })
})

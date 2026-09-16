const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const load = () => createLoader({})('src/runtime/server-process.ts')

/**
 * A stand-in for the spawned server. `exit(...)` is what the real process does when it honours the
 * signal; a process that never calls it is one that ignored the shutdown, which is the case the
 * whole module exists for.
 */
function fakeProcess(overrides = {}) {
    const { exitCode = null, signalCode = null } = overrides
    // Spelled out rather than destructured with a default, so a test can ask for a process without a pid.
    const pid = 'pid' in overrides ? overrides.pid : 4242
    const listeners = new Set()
    return {
        pid,
        exitCode,
        signalCode,
        killed: false,
        kills: [],
        kill(signal) {
            this.kills.push(signal)
            this.killed = true
            return true
        },
        once(event, listener) {
            if (event === 'exit') listeners.add(listener)
            return this
        },
        off(event, listener) {
            if (event === 'exit') listeners.delete(listener)
            return this
        },
        listenerCount: () => listeners.size,
        exit(code = 0, signal = null) {
            this.exitCode = code
            this.signalCode = signal
            for (const listener of [...listeners]) {
                listeners.delete(listener)
                listener(code, signal)
            }
        },
    }
}

/** Collects the signals sent, and runs timers by hand so the tests do not wait on real clocks. */
function harness(overrides = {}) {
    const sent = []
    const timers = []
    return {
        sent,
        runTimers() {
            const pending = timers.splice(0)
            for (const timer of pending) timer.callback()
        },
        options: {
            platform: 'linux',
            graceMs: 3000,
            sendSignal: (pid, signal) => sent.push([pid, signal]),
            setTimer: (callback, ms) => {
                const timer = { callback, ms }
                timers.push(timer)
                return timer
            },
            clearTimer: (handle) => {
                const index = timers.indexOf(handle)
                if (index >= 0) timers.splice(index, 1)
            },
            ...overrides,
        },
    }
}

test('a server that exits on SIGTERM is never killed', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess()
    const { sent, options } = harness()
    const stopping = stopProcessTree(child, options)
    // The signal goes to the negated pid: the process group, so the server's own compilers go too.
    assert.deepEqual(sent, [[-4242, 'SIGTERM']])
    child.exit(0)
    assert.equal(await stopping, 'exited')
    assert.deepEqual(sent, [[-4242, 'SIGTERM']])
})

test('a server that ignores SIGTERM is killed once the grace period runs out', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess()
    const harnessed = harness()
    const stopping = stopProcessTree(child, harnessed.options)
    assert.deepEqual(harnessed.sent, [[-4242, 'SIGTERM']])
    harnessed.runTimers() // the grace period expires with the server still running
    await Promise.resolve()
    assert.deepEqual(harnessed.sent, [
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL'],
    ])
    harnessed.runTimers() // and the wait after the kill
    assert.equal(await stopping, 'killed')
})

test('a process that has already exited is not signalled at all', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess({ exitCode: 0 })
    const { sent, options } = harness()
    assert.equal(await stopProcessTree(child, options), 'gone')
    assert.deepEqual(sent, [])
})

test('a process killed by a signal counts as exited', async () => {
    const { stopProcessTree, hasExited } = load()
    const child = fakeProcess({ signalCode: 'SIGSEGV' })
    assert.equal(hasExited(child), true)
    const { sent, options } = harness()
    assert.equal(await stopProcessTree(child, options), 'gone')
    assert.deepEqual(sent, [])
})

test('a process that disappeared between the check and the signal is not waited for', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess()
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    const problems = []
    const { options } = harness({
        sendSignal: () => {
            throw esrch
        },
        onProblem: (message) => problems.push(message),
    })
    assert.equal(await stopProcessTree(child, options), 'gone')
    // ESRCH is the outcome the shutdown wanted, so it is not reported as a problem.
    assert.deepEqual(problems, [])
})

test('Windows has no SIGTERM to send, so the tree is killed with taskkill', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess()
    const killed = []
    const harnessed = harness({
        platform: 'win32',
        killTree: (pid) => killed.push(pid),
    })
    const stopping = stopProcessTree(child, harnessed.options)
    assert.deepEqual(killed, [4242])
    assert.deepEqual(harnessed.sent, [])
    harnessed.runTimers()
    assert.equal(await stopping, 'killed')
})

test('a failing taskkill still ends the process we know about', async () => {
    const { forceKill } = load()
    const child = fakeProcess()
    const problems = []
    const outcome = forceKill(child, {
        platform: 'win32',
        killTree: () => {
            throw new Error('Access is denied.')
        },
        onProblem: (message) => problems.push(message),
    })
    assert.equal(outcome, 'sent')
    assert.deepEqual(child.kills, ['SIGKILL'])
    assert.match(problems[0], /taskkill could not end the language server \(pid 4242\)/)
})

test('signalling the group can be turned off, so only the server itself is addressed', () => {
    const { requestStop } = load()
    const sent = []
    const sendSignal = (pid, signal) => sent.push([pid, signal])
    requestStop(fakeProcess(), { platform: 'linux', group: false, sendSignal })
    assert.deepEqual(sent, [[4242, 'SIGTERM']])
})

test('the exit listener is dropped when the grace period wins, so a stuck server retains nothing', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess()
    const harnessed = harness()
    const stopping = stopProcessTree(child, harnessed.options)
    assert.equal(child.listenerCount(), 1)
    harnessed.runTimers()
    await Promise.resolve()
    harnessed.runTimers()
    await stopping
    assert.equal(child.listenerCount(), 0)
})

test('the server is spawned into its own process group everywhere but Windows', () => {
    const { spawnDetached } = load()
    assert.equal(spawnDetached('linux'), true)
    assert.equal(spawnDetached('darwin'), true)
    assert.equal(spawnDetached('win32'), false)
})

/** True once no process with this pid is left. A reparented grandchild takes a moment to be reaped. */
async function waitUntilGone(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            process.kill(pid, 0)
        } catch {
            return true
        }
        if (Date.now() > deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

// The unit tests above pin the decisions; this one pins that the signals actually land, on a process
// that ignores SIGTERM and has started a child of its own -- which is what the language server does
// every time it runs a compiler.
test(
    'a real server that ignores SIGTERM is killed together with the child it started',
    { skip: process.platform === 'win32' ? 'POSIX process groups only' : false },
    async () => {
        const { stopProcessTree, spawnDetached } = load()
        const { spawn } = require('node:child_process')
        const script = [
            "process.on('SIGTERM', () => {})",
            "const child = require('child_process').spawn(process.execPath,",
            "    ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'console.log(child.pid)',
            'setInterval(() => {}, 1000)',
        ].join('\n')
        const server = spawn(process.execPath, ['-e', script], {
            detached: spawnDetached(),
            stdio: ['ignore', 'pipe', 'ignore'],
        })
        const compiler = Number(
            await new Promise((resolve) => server.stdout.once('data', (data) => resolve(data.toString().trim())))
        )
        assert.ok(Number.isInteger(compiler) && compiler > 0, 'the child should have reported its pid')

        assert.equal(await stopProcessTree(server, { graceMs: 250 }), 'killed')
        assert.ok(await waitUntilGone(server.pid), 'the server should be gone')
        assert.ok(await waitUntilGone(compiler), 'the child it started should be gone too')
    }
)

test('a spawn that produced no process is not waited on', async () => {
    const { stopProcessTree } = load()
    const child = fakeProcess({ pid: undefined })
    const { sent, options } = harness()
    assert.equal(await stopProcessTree(child, options), 'gone')
    assert.deepEqual(sent, [])
})

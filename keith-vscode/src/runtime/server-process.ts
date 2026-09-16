/*
 * SCCharts Lab: shutting the language server down for good.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { execFileSync } from 'child_process'

/**
 * `vscode-languageclient` only tracks (and force-kills) a server it spawned itself from a command or
 * module. We hand it a ready-made `ChildProcess` instead, so that a restart picks up a toolchain that
 * was configured in the meantime -- and on that path the client never stores the process: its
 * `stop()` sends the LSP `shutdown`/`exit` over stdin and nothing else. A server that does not act on
 * them (wedged in a compile, or waiting on a simulation it started) therefore survives the client,
 * gets reparented to init, and keeps its whole JVM heap until the machine is rebooted. Every restart
 * then adds another one.
 *
 * So the extension has to end the process itself. That is what this module does: ask politely, wait,
 * and kill what is still standing -- including the compilers and simulation binaries the server
 * spawned, which would otherwise be orphaned a second time when their parent dies.
 */

/** A server that ignored `SIGTERM` for this long is not going to exit on its own. */
export const DEFAULT_GRACE_MS = 3000

/** The part of a `ChildProcess` a shutdown needs. Narrow enough that a test can pass a plain object. */
export interface TerminableProcess {
    readonly pid?: number
    readonly exitCode: number | null
    readonly signalCode: NodeJS.Signals | null
    kill(signal?: NodeJS.Signals | number): boolean
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface TerminateOptions {
    /**
     * Whether the process leads a process group of its own (see `spawnDetached` below). Signalling the
     * group takes the server's own children -- gcc, javac, the simulation executable -- down with it.
     */
    group?: boolean
    platform?: NodeJS.Platform
    /** `process.kill`; a negative pid addresses a process group. */
    sendSignal?: (pid: number, signal: NodeJS.Signals | number) => void
    /** Windows has no signals worth the name: the tree is killed with `taskkill`. */
    killTree?: (pid: number) => void
    /** Diagnostics for the output channel. Shutdown failures are reported, never thrown. */
    onProblem?: (message: string) => void
}

export interface StopOptions extends TerminateOptions {
    graceMs?: number
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
}

export type SignalOutcome =
    /** The signal was delivered. */
    | 'sent'
    /** There was no such process any more; nothing is left to wait for. */
    | 'gone'
    /** Nothing was sent: no pid to address, or no meaningful signal on this platform. */
    | 'skipped'

export type StopOutcome =
    /** The process had already exited; nothing was signalled. */
    | 'gone'
    /** It exited after being asked to. */
    | 'exited'
    /** It had to be killed. */
    | 'killed'

/**
 * On POSIX the server is spawned in a session of its own, which makes it a process-group leader and
 * lets {@link stopProcessTree} signal it together with everything it started. Windows has no such
 * thing and `detached` there only buys a stray console window, so the tree is walked by `taskkill`.
 */
export function spawnDetached(platform: NodeJS.Platform = process.platform): boolean {
    return platform !== 'win32'
}

export function hasExited(child: TerminableProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null
}

function target(child: TerminableProcess, options: TerminateOptions): number | undefined {
    const { pid } = child
    if (pid === undefined || pid <= 0 || hasExited(child)) return undefined
    const group = options.group ?? spawnDetached(options.platform ?? process.platform)
    return group ? -pid : pid
}

/**
 * Asks the server to exit. Returns whether anything was signalled: on Windows there is nothing
 * graceful to send, so the caller goes straight to {@link forceKill}.
 */
export function requestStop(child: TerminableProcess, options: TerminateOptions = {}): SignalOutcome {
    const platform = options.platform ?? process.platform
    if (platform === 'win32') return 'skipped'
    const pid = target(child, options)
    if (pid === undefined) return 'skipped'
    const sendSignal = options.sendSignal ?? ((to, signal) => process.kill(to, signal))
    try {
        sendSignal(pid, 'SIGTERM')
        return 'sent'
    } catch (error) {
        if (isGone(error)) return 'gone'
        report(options, `could not ask the language server (pid ${child.pid}) to stop`, error)
        return 'skipped'
    }
}

/** Kills the server and everything it started. Returns whether the kill was delivered. */
export function forceKill(child: TerminableProcess, options: TerminateOptions = {}): SignalOutcome {
    const platform = options.platform ?? process.platform
    if (child.pid === undefined || hasExited(child)) return 'skipped'
    if (platform === 'win32') {
        const killTree = options.killTree ?? taskkill
        try {
            killTree(child.pid)
            return 'sent'
        } catch (error) {
            report(options, `taskkill could not end the language server (pid ${child.pid})`, error)
            // Better a leftover gcc than a leftover JVM: end at least the process we know.
            return killDirectly(child, options)
        }
    }
    const pid = target(child, options)
    if (pid === undefined) return 'skipped'
    const sendSignal = options.sendSignal ?? ((to, signal) => process.kill(to, signal))
    try {
        sendSignal(pid, 'SIGKILL')
        return 'sent'
    } catch (error) {
        if (isGone(error)) return 'gone'
        report(options, `could not kill the language server process group (pid ${child.pid})`, error)
        return killDirectly(child, options)
    }
}

function killDirectly(child: TerminableProcess, options: TerminateOptions): SignalOutcome {
    try {
        return child.kill('SIGKILL') ? 'sent' : 'skipped'
    } catch (error) {
        if (isGone(error)) return 'gone'
        report(options, `could not kill the language server (pid ${child.pid})`, error)
        return 'skipped'
    }
}

/** `ESRCH` means the process is already gone, which is exactly what the shutdown was after. */
function isGone(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

function taskkill(pid: number): void {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 })
}

function report(options: TerminateOptions, message: string, error: unknown): void {
    options.onProblem?.(`${message}: ${error instanceof Error ? error.message : String(error)}`)
}

/** Resolves true when the process exits within `ms`, false when the wait runs out. */
function waitForExit(child: TerminableProcess, ms: number, options: StopOptions): Promise<boolean> {
    const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    return new Promise((resolve) => {
        let timer: unknown
        const onExit = () => {
            clearTimer(timer)
            resolve(true)
        }
        child.once('exit', onExit)
        timer = setTimer(() => {
            // Dropping the listener keeps a server that never exits from retaining this promise.
            child.off('exit', onExit)
            resolve(false)
        }, ms)
    })
}

/**
 * Ends the server: `SIGTERM` to its process group, then `SIGKILL` to whatever is still there. Resolves
 * once the process is gone or the kill has been delivered, and never rejects -- it runs on the way out
 * of the extension, where a rejection would only hide the fact that something was left behind.
 */
export async function stopProcessTree(child: TerminableProcess, options: StopOptions = {}): Promise<StopOutcome> {
    if (hasExited(child)) return 'gone'
    // A spawn that failed outright (an 'error' event, no pid) left nothing behind to signal, and waiting
    // out the grace period for it would only delay the window closing.
    if (child.pid === undefined) return 'gone'
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    const asked = requestStop(child, options)
    if (asked === 'gone') return 'gone'
    if (asked === 'sent' && (await waitForExit(child, graceMs, options))) return 'exited'
    if (hasExited(child)) return 'exited'
    if (forceKill(child, options) === 'gone') return 'exited'
    await waitForExit(child, graceMs, options)
    return 'killed'
}

// Compiling and running generated C: gcc as KIELER's simulation calls it (kicool/deploy/processor/CCompiler.xtend:
// -std=c99 -Wall, no optimisation, -lm) plus -fwrapv, which makes the int overflow that unoptimised code shows anyway
// defined. Unoptimised matters: an index outside an array reads and writes its neighbour in the struct
// (basics.md B-28), which the optimiser may assume never happens. Jobs run in parallel, in temporary directories that
// are removed afterwards.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const GCC_FLAGS = ['-std=c99', '-Wall', '-O0', '-fwrapv']

export interface RunResult {
    /** gcc failed (its output), or the program was not built. */
    compileError?: string
    /** gcc's warnings. */
    warnings: string
    stdout: string
    /** The program died of a signal (SIGFPE for a division by zero) or exited with this code. */
    signal?: string
    code?: number
    timedOut?: boolean
}

function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
        child.stdout.on('data', c => { if (stdout.length < 20_000_000) stdout += c })
        child.stderr.on('data', c => { if (stderr.length < 200_000) stderr += c })
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ stdout, stderr, code, signal, timedOut }) })
        child.on('error', e => { clearTimeout(timer); resolve({ stdout, stderr: stderr + String(e), code: -1, signal: null, timedOut }) })
    })
}

/** Writes the files, compiles them with main.c and runs the program. */
export async function compileAndRun(files: Record<string, string>, main: string, options: { keep?: string; timeout?: number } = {}): Promise<RunResult> {
    const dir = options.keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgen-'))
    try {
        fs.mkdirSync(dir, { recursive: true })
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
        fs.writeFileSync(path.join(dir, 'main.c'), main)
        const sources = Object.keys(files).filter(f => f.endsWith('.c'))
        const cc = await exec('gcc', [...GCC_FLAGS, '-o', 'sim', 'main.c', ...sources, '-lm'], dir, 120_000)
        if (cc.code !== 0) return { compileError: cc.stderr || `gcc exited with ${cc.code}`, warnings: '', stdout: '' }
        const run = await exec('./sim', [], dir, options.timeout ?? 20_000)
        return { warnings: cc.stderr, stdout: run.stdout, signal: run.signal ?? undefined, code: run.code ?? undefined, timedOut: run.timedOut }
    } finally {
        if (!options.keep) fs.rmSync(dir, { recursive: true, force: true })
    }
}

/** Runs `jobs` with at most `limit` at a time; results in order. */
export async function pool<T, R>(items: T[], limit: number, job: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const i = next++
            out[i] = await job(items[i], i)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

export function hasGcc(): Promise<boolean> {
    return new Promise(resolve => {
        const child = spawn('gcc', ['--version'], { stdio: 'ignore' })
        child.on('error', () => resolve(false))
        child.on('close', code => resolve(code === 0))
    })
}

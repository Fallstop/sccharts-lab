// One KIELER oracle (tools/oracle/oracle.mjs) for many charts, with a per-chart time limit: a chart KIELER does not
// finish compiling in time is reported as a timeout and the language server is restarted (its JVM killed).

import { execFileSync } from 'node:child_process'
// @ts-ignore: plain JavaScript module (typed by inference under allowJs, untyped elsewhere).
import { startOracle } from '../oracle/oracle.mjs'
import type { OracleResult } from './compare'

export interface OracleJob {
    name: string
    model: string
    inputs: Record<string, unknown>[]
    /** Other files next to the model ({ "file.sctx": text }). */
    imports?: Record<string, string>
}

interface Oracle {
    run(s: object): Promise<OracleResult>
    stop(): Promise<void>
    kill(): void
}

export class OracleRunner {
    private oracle?: Oracle
    private starts = 0

    constructor(private readonly timeoutMs = 40000) {}

    async run(job: OracleJob): Promise<OracleResult & { timedOut?: boolean }> {
        if (!this.oracle) {
            this.oracle = (await startOracle()) as Oracle
            this.starts++
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.timeoutMs) })
        const result = await Promise.race([this.oracle.run({ name: job.name, model: job.model, inputs: job.inputs, imports: job.imports }), timeout])
        clearTimeout(timer)
        if (result === 'timeout') {
            this.kill()
            return { ok: false, errors: [`Timeout: KIELER did not finish within ${this.timeoutMs / 1000} s`], ticks: [], timedOut: true }
        }
        return result
    }

    /** Kills the language server (a busy JVM does not answer `shutdown`). */
    kill() {
        const o = this.oracle
        this.oracle = undefined
        o?.kill()
        try {
            execFileSync('pkill', ['-KILL', '-P', String(process.pid), 'java'], { stdio: 'ignore' })
        } catch {
            // No such process.
        }
    }

    async close() {
        const o = this.oracle
        this.oracle = undefined
        if (!o) return
        await Promise.race([o.stop(), new Promise(resolve => setTimeout(resolve, 3000))])
        this.kill()
    }

    get restarts(): number {
        return Math.max(0, this.starts - 1)
    }
}

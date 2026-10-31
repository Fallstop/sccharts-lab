// Diagram layout off the main thread: layoutChart builds the ELK graph (cheap) and ELK itself runs in a Web
// Worker (elkjs's elk-worker), as src/diagram/README.md describes. Requests are latest-wins: while one layout
// runs, only the newest request waits; older ones are dropped. A layout that hangs is cut off and the worker
// replaced.

import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
// Not ../../diagram/index: that one falls back to elkjs's 1.4 MB bundled build. These modules need the worker.
import { layoutChart } from '../../diagram/layout'
import { renderSvg } from '../../diagram/render'
import type { DiagramLayout, ElkLike, LayoutOptions } from '../../diagram/types'
import type { Program, State } from '../../engine/types'

export interface LayoutJob {
    chart: State
    program: Program
    /** Passed back with the result. */
    tag: number
    options?: Omit<LayoutOptions, 'elk' | 'program'>
}

export interface LayoutDone {
    tag: number
    layout?: DiagramLayout
    svg?: string
    error?: string
    ms: number
}

const TIMEOUT_MS = 20000

type ElkInstance = ElkLike & { terminateWorker?: () => void }

/** One ELK worker for every playground on the page (several inline playgrounds share it). */
let sharedElk: ElkInstance | undefined

function elkInstance(): ElkInstance {
    sharedElk ??= new ELK({ workerFactory: () => new Worker(elkWorkerUrl, { name: 'elk-layout' }) }) as unknown as ElkInstance
    return sharedElk
}

function restartElk() {
    try {
        sharedElk?.terminateWorker?.()
    } catch {
        // already gone
    }
    sharedElk = undefined
}

export class LayoutService {
    private running = false
    private pending: LayoutJob | undefined
    private idPrefix: string
    private count = 0

    constructor(private onDone: (result: LayoutDone) => void, idPrefix = 'pg') {
        this.idPrefix = idPrefix
    }

    request(job: LayoutJob) {
        this.pending = job
        if (!this.running) void this.pump()
    }

    private async pump() {
        while (this.pending) {
            const job = this.pending
            this.pending = undefined
            this.running = true
            const t0 = performance.now()
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('The layout took too long.')), TIMEOUT_MS)
                })
                const layout = await Promise.race([layoutChart(job.chart, { ...job.options, elk: elkInstance(), program: job.program }), timeout])
                const svg = renderSvg(layout, { fit: 'none', idPrefix: `${this.idPrefix}${++this.count}` })
                this.onDone({ tag: job.tag, layout, svg, ms: performance.now() - t0 })
            } catch (error) {
                if (error instanceof Error && error.message === 'The layout took too long.') restartElk()
                this.onDone({ tag: job.tag, error: error instanceof Error ? error.message : String(error), ms: performance.now() - t0 })
            } finally {
                clearTimeout(timer)
                this.running = false
            }
        }
    }

    destroy() {
        this.pending = undefined
    }
}

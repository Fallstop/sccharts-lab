// The embed's postMessage API (protocol: packages/embed/src/protocol.ts): commands from the page that frames the embed
// drive the playground (Playground, app.ts) as a reader would, and what the playground shows goes back as events
// (`compiled`, `tick`). Commands are taken from the embed's first script on and queued until the playground is live;
// they run one after another. Only the frame's parent is listened to; a message that is not a command in the envelope
// is ignored, and nothing in a message is ever evaluated.

import { envelope, parseCommand, type CommandMessage, type CompiledInfo, type DiagnosticInfo, type EmbedEvent, type Inputs, type ReadyInfo, type TickInfo, type VariableInfo } from '@sccharts-lab/embed/protocol'
import type { CompileResult } from '@sccharts-lab/engine'
import type { TickResult, Value } from '@sccharts-lab/engine/types'
import { controlsFor } from '../sim/inputs'
import type { Playground } from '../playground/app'
import type { SimView } from '../playground/sim-host.svelte'
import type { Problem } from '../playground/recorded'

type ChartCommand = Extract<CommandMessage, { command: 'setSource' | 'setFiles' }>

/** A copy that survives postMessage's structured clone and holds nothing of the engine's. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T

export function compiledInfo(file: string, result: CompileResult, problems: Problem[]): CompiledInfo {
    const vars = (pick: (v: CompileResult['interface'][number]) => boolean): VariableInfo[] =>
        result.interface.filter(pick).map(v => ({ name: v.name, type: v.type, signal: v.signal, valued: v.valued, dims: [...v.dims] }))
    const diagnostics: DiagnosticInfo[] = problems.map(d => ({
        severity: d.severity,
        message: d.message,
        ...(d.code ? { code: d.code } : {}),
        ...(d.hint ? { hint: d.hint } : {}),
        ...(d.span ? { line: d.span.line, column: d.span.col, endLine: d.span.endLine, endColumn: d.span.endCol } : {}),
    }))
    return {
        ok: result.ok,
        file,
        ...(result.chart?.name ? { chart: result.chart.name } : {}),
        charts: result.program?.charts.map(c => c.name).filter(Boolean) ?? [],
        diagnostics,
        inputs: vars(v => v.input && !v.const),
        outputs: vars(v => v.output),
    }
}

export function tickInfo(view: SimView | undefined): TickInfo {
    const t = view?.tick as (TickResult & { pool?: Record<string, Value> }) | undefined
    return {
        tick: view?.cursor ?? 0,
        ticks: view?.history.length ?? 0,
        tour: !!view?.tour,
        values: t ? plain(t.pool ?? t.values) : {},
        present: t ? plain(t.present) : {},
        active: t ? [...t.active] : [],
        entered: t ? [...t.entered] : [],
        taken: t ? [...t.taken] : [],
        printed: t ? [...t.printed] : [],
        terminated: !!t?.terminated,
        ...(t?.error ? { error: t.error.message } : {}),
    }
}

/**
 * Inputs from the page, checked against the chart's inputs and given the controls' types: a bool or a signal's
 * presence takes true or false, a number field a number (an int truncated and kept to 32 bits, as KIELER reads it), a
 * string field a string. Returns the values, or why they cannot be set.
 */
export function coerceInputs(iface: CompileResult['interface'], inputs: Inputs): { values: Record<string, Value> } | { error: string } {
    const controls = controlsFor(iface)
    const kinds = new Map<string, { kind: 'bool' | 'number' | 'string' | 'array'; int: boolean }>()
    for (const c of controls) {
        kinds.set(c.name, { kind: c.kind, int: c.int })
        if (c.valueKey) kinds.set(c.valueKey, { kind: c.valueKind === 'string' ? 'string' : 'number', int: c.int })
    }
    const values: Record<string, Value> = {}
    for (const [k, v] of Object.entries(inputs)) {
        const want = kinds.get(k)
        if (!want) {
            const names = [...kinds.keys()]
            return { error: `\`${k}\` is not an input of this chart${names.length ? ` (its inputs: ${names.join(', ')})` : ', which has no inputs'}.` }
        }
        if (want.kind === 'bool') {
            if (typeof v !== 'boolean') return { error: `\`${k}\` takes true or false.` }
            values[k] = v
        } else if (want.kind === 'number') {
            if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `\`${k}\` takes a number.` }
            values[k] = want.int ? Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(v))) : v
        } else if (want.kind === 'string') {
            if (typeof v !== 'string' && v !== null) return { error: `\`${k}\` takes a string.` }
            values[k] = v
        } else {
            if (!Array.isArray(v)) return { error: `\`${k}\` takes an array.` }
            values[k] = v
        }
    }
    return { values }
}

export class Bridge {
    private queue: CommandMessage[] = []
    private app?: Playground
    private running = false
    private chartWaiter?: (m: ChartCommand) => void
    /** The first chart of a `source=parent` embed: answered once the playground runs it. */
    private firstChart?: ChartCommand
    private lastCompiled = ''
    private lastTick?: { cursor: number; ticks: number; tour: boolean; tick?: TickResult }
    private readonly framed = window.parent !== window

    constructor(private readonly view: string) {
        window.addEventListener('message', e => {
            if (!this.framed || e.source !== window.parent) return
            const parsed = parseCommand(e.data)
            if (parsed.kind === 'ignore') return
            if (parsed.kind === 'invalid') {
                if (parsed.id !== undefined) this.post({ event: 'reply', id: parsed.id, ok: false, error: parsed.error })
                else this.post({ event: 'error', message: parsed.error, ...(parsed.command ? { command: parsed.command } : {}) })
                return
            }
            const m = parsed.message
            if (this.chartWaiter && (m.command === 'setSource' || m.command === 'setFiles')) {
                const take = this.chartWaiter
                this.chartWaiter = undefined
                this.firstChart = m
                take(m)
                return
            }
            this.queue.push(m)
            void this.drain()
        })
    }

    post(event: EmbedEvent) {
        if (this.framed) window.parent.postMessage(envelope(event), '*')
    }

    /** `source=parent`: the first chart the page sends (it may already be waiting in the queue). */
    waitForChart(): Promise<ChartCommand> {
        const i = this.queue.findIndex(m => m.command === 'setSource' || m.command === 'setFiles')
        if (i >= 0) {
            this.firstChart = this.queue.splice(i, 1)[0] as ChartCommand
            return Promise.resolve(this.firstChart)
        }
        return new Promise(resolve => (this.chartWaiter = resolve))
    }

    /** The playground is live: say so, report what it shows from now on, and run what waited. */
    attach(app: Playground, watch: <T>(read: () => T, then: (v: T) => void) => () => void) {
        this.app = app
        const ready: ReadyInfo = { view: this.view, compiled: this.compiled(), tick: this.tick() }
        this.lastCompiled = this.compiledKey()
        this.rememberTick(app.sim.view)
        this.post({ event: 'ready', ...ready })
        if (this.firstChart?.id !== undefined) this.post({ event: 'reply', id: this.firstChart.id, ok: true, result: ready.compiled })
        watch(
            () => app.model.compiled,
            () => {
                const key = this.compiledKey()
                if (key === this.lastCompiled) return
                this.lastCompiled = key
                const info = this.compiled()
                if (info) this.post({ event: 'compiled', ...info })
            },
        )
        watch(
            () => app.model.simView,
            view => {
                if (!view || this.sameTick(view)) return
                this.rememberTick(view)
                this.post({ event: 'tick', ...tickInfo(view) })
            },
        )
        void this.drain()
    }

    private compiledKey(): string {
        const c = this.app?.model.compiled
        return c ? `${c.file}\0${c.result.chart?.name ?? ''}\0${c.source}` : ''
    }

    private compiled(): CompiledInfo | undefined {
        const app = this.app
        const c = app?.model.compiled
        return c && app ? compiledInfo(c.file, c.result, app.model.problems) : undefined
    }

    private tick(): TickInfo {
        return tickInfo(this.app?.sim.view)
    }

    private sameTick(v: SimView): boolean {
        const l = this.lastTick
        return !!l && l.cursor === v.cursor && l.ticks === v.history.length && l.tour === v.tour && l.tick === v.tick
    }

    private rememberTick(v: SimView | undefined) {
        this.lastTick = v ? { cursor: v.cursor, ticks: v.history.length, tour: v.tour, tick: v.tick } : undefined
    }

    private async drain() {
        if (!this.app || this.running) return
        this.running = true
        try {
            for (let m = this.queue.shift(); m; m = this.queue.shift()) {
                let result: unknown
                let error: string | undefined
                try {
                    result = await this.run(this.app, m)
                } catch (e) {
                    error = e instanceof Error ? e.message : String(e)
                }
                if (m.id !== undefined) this.post(error === undefined ? { event: 'reply', id: m.id, ok: true, ...(result !== undefined ? { result } : {}) } : { event: 'reply', id: m.id, ok: false, error })
                else if (error !== undefined) this.post({ event: 'error', message: error, command: m.command })
            }
        } finally {
            this.running = false
        }
    }

    /** Runs a command as the reader's own actions would; returns what its reply carries. Throws why it cannot. */
    private async run(app: Playground, m: CommandMessage): Promise<unknown> {
        switch (m.command) {
            case 'setSource': {
                const view = app.view
                if (view.state.doc.toString() !== m.source) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: m.source } })
                app.runCompile(false)
                app.sim.force()
                await app.simulationReady()
                return this.compiled()
            }
            case 'setFiles': {
                const active = m.active ?? Object.keys(m.files)[0]
                const name = m.name ?? active.replace(/^.*\//, '').replace(/\.sctx$/i, '')
                app.loadProject({ name, files: m.files, active }, { kind: 'shared', title: name }, undefined, undefined, {})
                await app.simulationReady()
                return this.compiled()
            }
            case 'selectChart': {
                const charts = app.latest?.result.program?.charts.map(c => c.name) ?? []
                if (!charts.includes(m.chart)) throw new Error(`There is no chart \`${m.chart}\` in ${app.project.active}${charts.length ? ` (its charts: ${charts.join(', ')})` : ''}.`)
                app.chartChoice = m.chart
                app.diagram.refitNext = true
                app.runCompile(false)
                app.sim.force()
                await app.simulationReady()
                return this.compiled()
            }
            case 'step':
            case 'setInputs': {
                const host = this.host(app)
                if (m.inputs && Object.keys(m.inputs).length) {
                    const checked = coerceInputs(app.sim.analysed?.result.interface ?? [], m.inputs)
                    if ('error' in checked) throw new Error(checked.error)
                    const why = host.setInputs(checked.values)
                    if (why) throw new Error(why)
                }
                if (m.command === 'step') host.step()
                host.flush()
                return this.tick()
            }
            case 'reset': {
                const host = this.host(app)
                host.reset()
                host.flush()
                return this.tick()
            }
            case 'rewind': {
                const host = this.host(app)
                const computed = app.sim.view?.history.length ?? 0
                if (m.tick > computed) throw new Error(`Only ${computed} ${computed === 1 ? 'tick has' : 'ticks have'} been computed.`)
                host.goto(m.tick)
                host.flush()
                return this.tick()
            }
            case 'getState':
                return { compiled: this.compiled(), tick: this.tick() }
        }
    }

    /** The simulation panel, when the chart can run. */
    private host(app: Playground) {
        const host = app.sim.host
        const result = app.sim.analysed?.result
        if (!host || !result) throw new Error('The simulation is not ready.')
        if (!app.sim.ok || result.diagnostics.some(d => d.code === 'unsupported')) {
            const first = result.diagnostics.find(d => d.severity === 'error' || d.code === 'unsupported')
            throw new Error(`The chart cannot run${first ? `: ${first.message.replace(/`/g, '')}` : '.'}`)
        }
        return host
    }
}

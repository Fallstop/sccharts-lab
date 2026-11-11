// <sccharts-lab-chart>: a live SCCharts chart in any page. It makes the iframe of SCCharts Lab's embed (/embed/),
// sizes it to its content, and turns the postMessage protocol (protocol.ts) into methods and DOM events.
//
//   <script src="https://sccharts.jmw.nz/embed.js" async></script>
//   <sccharts-lab-chart example="learn/hierarchy/abro" view="sim"></sccharts-lab-chart>
//   <sccharts-lab-chart view="full"><pre>scchart Toggle { ... }</pre></sccharts-lab-chart>
//
// The chart: `example` (a guide example), else `src` (a .sctx file the element fetches), else the element's own
// `<pre>`, `<textarea>` or `<script type="text/sctx">` children (several with `data-file="lib/beep.sctx"` make a
// project). A `<pre>` reads as code before the script runs, and stays the page's fallback without JavaScript.
// `run` replays a run (the playground's "Copy link to this run" encoding).
// Dependency-free: built on its own into /embed.js.

import { DEFAULT_BASE, embedUrl, estimateHeight, targetFromAttributes, type EmbedTarget } from './options'
import { envelope, parseEvent, type CommandId, type CompiledInfo, type EmbedCommand, type Inputs, type ReadyInfo, type TickInfo } from './protocol'

export const TAG = 'sccharts-lab-chart'

/** Attributes that change the embed's address (the frame loads again). */
const ADDRESS = ['example', 'src', 'view', 'height', 'tick', 'tour', 'controls', 'chart', 'run', 'base']
const REPLY_TIMEOUT = 15000
const VIEW_WORDS: Record<string, string> = { diagram: 'diagram', sim: 'simulation', editor: 'editor', full: 'editor and simulation' }

/** Source text written inside HTML: the first and last blank lines and the indentation they share go. */
export function dedent(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    while (lines.length && !lines[0].trim()) lines.shift()
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)![0].length))
    return lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n') + '\n'
}

/** The files written inside the element: `<pre>`, `<textarea>` and `<script type="text/sctx">` children, each its
 *  `data-file` (else `main.sctx`, `main-2.sctx`, ...). Undefined when there are none. */
export function inlineFiles(host: Element): { files: Record<string, string>; active: string } | undefined {
    const blocks = [...host.children].filter(c => c.matches('pre, textarea, script[type="text/sctx"]'))
    if (!blocks.length) return undefined
    const files: Record<string, string> = {}
    let active: string | undefined
    blocks.forEach((b, i) => {
        const named = b.getAttribute('data-file')?.trim()
        const path = named && /^[\w ./+-]+$/.test(named) ? (named.endsWith('.sctx') ? named : `${named}.sctx`) : `main${i ? `-${i + 1}` : ''}.sctx`
        files[path] = dedent(b.tagName === 'TEXTAREA' ? (b as HTMLTextAreaElement).value : (b.textContent ?? ''))
        if (b.hasAttribute('data-active')) active = path
    })
    return { files, active: active ?? Object.keys(files)[0] }
}

interface Pending {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
}

const STYLE = `
:host { display: block; position: relative; }
:host([hidden]) { display: none; }
:host([data-height='fill']) { height: 480px; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: light; }
.sclab-error { margin: 0; padding: 0.75em 1em; border: 1px solid #d4c23a; border-radius: 6px; background: #fffbd1; color: #2b2a1e; font: 0.875rem/1.5 system-ui, sans-serif; }
`

// Importable where there is no DOM (the site's build, tests): the class is only defined, never made, there.
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement

export class SCChartsLabChart extends Base {
    /** Where /embed/ is: the site the loader came from (set by `define`), else sccharts.jmw.nz. */
    static base = DEFAULT_BASE
    static get observedAttributes() {
        return [...ADDRESS, 'label', 'loading']
    }

    private frame?: HTMLIFrameElement
    private message?: HTMLParagraphElement
    private pending = new Map<CommandId, Pending>()
    /** Commands waiting for the embed to be ready. */
    private queue: { send: () => void; reject: (error: Error) => void }[] = []
    private nextId = 1
    private live = false
    private renderQueued = false
    private generation = 0
    private origin = ''
    private chartName?: string
    private resolveReady!: (info: ReadyInfo) => void
    private readyPromise!: Promise<ReadyInfo>
    private readySettled = true
    private lastTick?: TickInfo
    private lastCompiled?: CompiledInfo
    private onMessage = (e: MessageEvent) => this.receive(e)

    constructor() {
        super()
        this.resetReady()
    }

    // ----- Lifecycle ------------------------------------------------------------------------------------------------

    connectedCallback() {
        window.addEventListener('message', this.onMessage)
        // Parsed before its children (the script ran first): read them once the document is parsed.
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => this.scheduleRender(), { once: true })
        else this.scheduleRender()
    }

    disconnectedCallback() {
        window.removeEventListener('message', this.onMessage)
        const error = new Error('The chart was removed from the page.')
        this.fail(error)
        for (const q of this.queue.splice(0)) q.reject(error)
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null) {
        // Before the first render (the element being made or upgraded, its inline code perhaps not parsed yet) the
        // render reads every attribute; after it, a change renders again, also while a chart is fetched or after a
        // fetch failed (render's generation drops the fetch it replaces).
        if (old === value || !this.isConnected || !this.generation) return
        if (ADDRESS.includes(name)) {
            this.invalidate()
            this.scheduleRender()
        }
        else if (name === 'label') this.updateTitle()
        else if (name === 'loading' && this.frame) this.frame.loading = value === 'eager' ? 'eager' : 'lazy'
    }

    private scheduleRender() {
        if (this.renderQueued) return
        this.renderQueued = true
        queueMicrotask(() => {
            this.renderQueued = false
            if (this.isConnected) void this.render()
        })
    }

    /** The embed's address for the attributes now, and the chart to send it (inline or fetched). */
    private async render() {
        const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
        if (!root.firstChild) root.innerHTML = `<style>${STYLE}</style>`
        const target = this.target()
        const base = this.getAttribute('base') || SCChartsLabChart.base
        this.origin = new URL(base, location.href).origin
        this.dataset.height = typeof target.height === 'number' ? 'fixed' : (target.height ?? 'auto')
        this.invalidate()
        const generation = ++this.generation
        this.message?.remove()
        this.message = undefined

        let files: { files: Record<string, string>; active: string } | undefined
        if (!target.example) {
            const src = this.getAttribute('src')
            if (src) {
                try {
                    const url = new URL(src, document.baseURI)
                    const res = await fetch(url)
                    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim())
                    const name = decodeURIComponent(url.pathname.split('/').pop() || 'main.sctx')
                    const path = /^[\w ./+-]+\.sctx$/.test(name) ? name : 'main.sctx'
                    files = { files: { [path]: await res.text() }, active: path }
                } catch (error) {
                    if (generation === this.generation) this.showError(`The chart ${src} could not be loaded (${error instanceof Error ? error.message : String(error)}).`)
                    return
                }
                // The attributes changed while the file was on its way: a later render has it.
                if (generation !== this.generation) return
            } else files = inlineFiles(this)
        }
        // A run to replay (the playground's `run=`, lz-string's URL-safe letters only).
        const run = this.getAttribute('run')?.trim()
        const url = embedUrl(base, { ...target, ...(files ? { source: 'parent' as const } : {}) }, run && /^[\w+$-]+$/.test(run) ? `run=${run}` : undefined)
        const old = this.frame
        const frame = document.createElement('iframe')
        frame.setAttribute('part', 'frame')
        frame.loading = this.getAttribute('loading') === 'eager' ? 'eager' : 'lazy'
        frame.allow = 'clipboard-write'
        frame.src = url
        if (typeof target.height === 'number') frame.style.height = `${target.height}px`
        else if (target.height === 'auto') frame.style.height = `${old?.offsetHeight || estimateHeight(target.view ?? 'sim', this.clientWidth || 640)}px`
        frame.addEventListener('load', () => {
            // The embed listens from its first script on: send the chart the page holds, then what waited.
            if (files) this.post({ command: 'setFiles', files: files.files, active: files.active })
        })
        this.frame = frame
        this.live = false
        this.updateTitle()
        if (old) old.replaceWith(frame)
        else root.append(frame)
    }

    private target(): EmbedTarget {
        return targetFromAttributes(n => this.getAttribute(n))
    }

    private showError(text: string) {
        this.frame?.remove()
        this.frame = undefined
        const p = document.createElement('p')
        p.className = 'sclab-error'
        p.setAttribute('role', 'alert')
        p.textContent = text
        this.message = p
        this.shadowRoot?.append(p)
        for (const q of this.queue.splice(0)) q.reject(new Error(text))
        this.emit('error', { message: text })
    }

    private updateTitle() {
        if (!this.frame) return
        const view = VIEW_WORDS[this.target().view ?? 'sim']
        this.frame.title = this.getAttribute('label') || `SCCharts Lab: ${this.chartName ?? this.target().example?.split('/').pop() ?? 'chart'} (${view})`
    }

    // ----- Messages -------------------------------------------------------------------------------------------------

    private receive(e: MessageEvent) {
        if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.origin) return
        const msg = parseEvent(e.data)
        if (!msg) return
        switch (msg.event) {
            case 'ready': {
                const { type: _t, version: _v, event: _e, ...info } = msg
                this.live = true
                this.lastCompiled = info.compiled
                this.lastTick = info.tick
                this.chartName = info.compiled?.chart ?? this.chartName
                this.updateTitle()
                this.readySettled = true
                this.resolveReady(info)
                for (const q of this.queue.splice(0)) q.send()
                this.emit('ready', info)
                break
            }
            case 'compiled': {
                const { type: _t, version: _v, event: _e, ...info } = msg
                this.lastCompiled = info
                if (info.chart && info.chart !== this.chartName) {
                    this.chartName = info.chart
                    this.updateTitle()
                }
                this.emit('compiled', info)
                break
            }
            case 'tick': {
                const { type: _t, version: _v, event: _e, ...info } = msg
                this.lastTick = info
                this.emit('tick', info)
                break
            }
            case 'resize': {
                const h = Number(msg.height)
                if (this.dataset.height === 'auto' && Number.isFinite(h) && h > 0) this.frame.style.height = `${Math.ceil(h)}px`
                this.emit('resize', { height: h })
                break
            }
            case 'error':
                this.emit('error', { message: msg.message, command: msg.command })
                break
            case 'reply': {
                const p = this.pending.get(msg.id)
                if (!p) break
                this.pending.delete(msg.id)
                clearTimeout(p.timer)
                if (msg.ok) p.resolve(msg.result)
                else p.reject(new Error(msg.error ?? 'The embed could not do that.'))
                break
            }
        }
    }

    private emit(name: string, detail: unknown) {
        this.dispatchEvent(new CustomEvent(name, { detail }))
    }

    private post(command: EmbedCommand & { id?: CommandId }) {
        this.frame?.contentWindow?.postMessage(envelope(command), this.origin)
    }

    /** Sends a command once the embed is ready; resolves with its reply's result. */
    private request<T>(command: EmbedCommand): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const send = () => {
                const id = this.nextId++
                const timer = setTimeout(() => {
                    this.pending.delete(id)
                    reject(new Error(`The embed did not answer ${command.command}.`))
                }, REPLY_TIMEOUT)
                this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
                this.post({ ...command, id })
            }
            if (this.live) send()
            else this.queue.push({ send, reject })
        })
    }

    /** The frame is about to load again: commands sent to it are lost with it (those still waiting go to the next one
     *  once it is ready), and `ready` is a new promise, at once (a pending one is kept for the next frame). */
    private invalidate() {
        this.fail(new Error('The chart was loaded again.'))
        if (this.readySettled) this.resetReady()
    }

    /** A new `ready` for the next frame. */
    private resetReady() {
        this.readySettled = false
        this.readyPromise = new Promise(resolve => (this.resolveReady = resolve))
    }

    /** Rejects the commands sent to the frame that are not answered yet. */
    private fail(error: Error) {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer)
            p.reject(error)
        }
        this.pending.clear()
        this.live = false
    }

    // ----- API ------------------------------------------------------------------------------------------------------

    /** Resolves once the chart is live (its first compile and tick 0). */
    get ready(): Promise<ReadyInfo> {
        return this.readyPromise
    }
    /** The latest compile and tick the embed reported. */
    get compiled(): CompiledInfo | undefined {
        return this.lastCompiled
    }
    get tick(): TickInfo | undefined {
        return this.lastTick
    }
    get iframe(): HTMLIFrameElement | undefined {
        return this.frame
    }

    /** Replaces the chart's text; resolves with its compile. */
    setSource(source: string): Promise<CompiledInfo> {
        return this.request({ command: 'setSource', source })
    }
    /** Opens a project of several files; resolves with the compile of the active one. */
    setFiles(files: Record<string, string>, active?: string): Promise<CompiledInfo> {
        return this.request({ command: 'setFiles', files, ...(active ? { active } : {}) })
    }
    selectChart(chart: string): Promise<CompiledInfo> {
        return this.request({ command: 'selectChart', chart })
    }
    /** Sets these inputs (they keep their values afterwards) and runs one tick; resolves with it. */
    step(inputs?: Inputs): Promise<TickInfo> {
        return this.request({ command: 'step', ...(inputs ? { inputs } : {}) })
    }
    setInputs(inputs: Inputs): Promise<TickInfo> {
        return this.request({ command: 'setInputs', inputs })
    }
    reset(): Promise<TickInfo> {
        return this.request({ command: 'reset' })
    }
    /** Shows tick `tick` of the ticks computed (0: before the first). */
    rewind(tick: number): Promise<TickInfo> {
        return this.request({ command: 'rewind', tick })
    }
    getState(): Promise<{ compiled?: CompiledInfo; tick: TickInfo }> {
        return this.request({ command: 'getState' })
    }
}

/** Registers <sccharts-lab-chart> (once), with the site its embeds come from. */
export function define(base?: string) {
    if (base) SCChartsLabChart.base = base
    if (!customElements.get(TAG)) customElements.define(TAG, SCChartsLabChart)
}

declare global {
    interface HTMLElementTagNameMap {
        'sccharts-lab-chart': SCChartsLabChart
    }
}

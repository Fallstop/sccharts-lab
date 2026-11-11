// Watch and Run until, under the variables' check boxes: an expression over the chart's data pool, evaluated for the
// tick shown by the guide's engine (watch.ts), remembered per chart; and "Run until", which steps (as Step does, with
// the inputs as they are set) until the watch holds or a state is active, at most UNTIL_MAX ticks, stopping where
// the chart terminates, fails or the guided tour ends. The ticks run without drawing (SimHost.stepQuietly); the
// panel and the diagram catch up every DRAW_EVERY ms and at the end.

import type { CompileResult } from '@sccharts-lab/engine'
import type { State } from '@sccharts-lab/engine/types'
import { $, escapeHtml } from './app-types'
import { storageGet, storageSet } from './share'
import { compileWatch, holds, type Watch, type WatchTick } from './watch'
import { inlineMd } from '../frame/inline-md'
import type { QuietStep } from './sim-host.svelte'
import type { SimControl } from './sim-control'
import type { Playground } from './app'

const UNTIL_MAX = 1000
const DRAW_EVERY = 100
const keyFor = (chart: string) => `sccharts-guide:playground:watch:${chart}`

export class WatchStrip {
    private watch?: Watch
    private error?: string
    private chart?: string
    private timer?: ReturnType<typeof setTimeout>
    private running = false
    private stop = false

    constructor(private pg: Playground, private sim: SimControl) {
        const strip = $(pg.root, '[data-pg-vars]')
        const input = strip && $<HTMLInputElement>(strip, '[data-pg-watch-input]')
        if (!strip || !input) return
        // The reader's watch: remembered for the chart, and (once it is one) what Run until runs until.
        const apply = () => {
            clearTimeout(this.timer)
            if (this.chart) storageSet(keyFor(this.chart), input.value.trim() || null)
            const had = this.watch?.text
            this.compile(this.sim.analysed?.result)
            const select = $<HTMLSelectElement>(pg.root, '[data-pg-until]')
            if (select && this.watch && this.watch.text !== had) {
                select.value = 'watch'
                this.renderUntil()
            }
        }
        input.addEventListener('input', () => {
            clearTimeout(this.timer)
            this.timer = setTimeout(apply, 250)
        })
        input.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            apply()
        })
        const run = $(strip, '[data-pg-until-run]')
        run?.addEventListener('click', () => {
            if (this.running) this.stop = true
            else if (run.getAttribute('aria-disabled') !== 'true') void this.runUntil()
        })
    }

    /** The chart in the panel changed: its remembered watch, compiled for it. */
    setChart(result: CompileResult) {
        const input = $<HTMLInputElement>(this.pg.root, '[data-pg-watch-input]')
        const chart = result.ok ? result.chart?.name : undefined
        if (input && chart !== this.chart) {
            this.chart = chart
            input.value = (chart && storageGet(keyFor(chart))) || ''
        }
        this.compile(result)
    }

    private compile(result: CompileResult | undefined) {
        const input = $<HTMLInputElement>(this.pg.root, '[data-pg-watch-input]')
        const text = input?.value.trim() ?? ''
        this.watch = undefined
        this.error = undefined
        if (text && result?.ok) {
            const w = compileWatch(text, result)
            if ('error' in w) this.error = w.error
            else this.watch = w
        }
        this.render()
        this.renderUntil()
    }

    render() {
        const out = $(this.pg.root, '[data-pg-watch-value]')
        const input = $<HTMLInputElement>(this.pg.root, '[data-pg-watch-input]')
        if (!out || !input) return
        out.classList.remove('is-error', 'is-true', 'is-false')
        input.removeAttribute('aria-invalid')
        if (this.error) {
            out.classList.add('is-error')
            input.setAttribute('aria-invalid', 'true')
            out.innerHTML = inlineMd(this.error)
            return
        }
        if (!this.watch) {
            out.textContent = ''
            return
        }
        const cursor = this.sim.view?.cursor ?? 0
        // What the watch reads of each tick of the panel's run: KIELER's data pool and the engine's trace.
        const v = this.watch.at((this.sim.view?.history ?? []) as WatchTick[], cursor)
        if ('error' in v) {
            out.classList.add('is-error')
            out.textContent = `In tick ${cursor}: ${v.error}`
        } else if ('none' in v) {
            out.innerHTML = inlineMd(v.none)
        } else {
            const shown = typeof v.value === 'string' || Array.isArray(v.value) ? JSON.stringify(v.value) : String(v.value)
            if (typeof v.value === 'boolean') out.classList.add(v.value ? 'is-true' : 'is-false')
            out.innerHTML = `In tick ${cursor}: <code>${escapeHtml(shown)}</code>`
        }
    }

    /** The goals of Run until: the watch, and every state of the chart in the panel. */
    renderUntil() {
        const select = $<HTMLSelectElement>(this.pg.root, '[data-pg-until]')
        const run = $<HTMLButtonElement>(this.pg.root, '[data-pg-until-run]')
        if (!select || !run) return
        const a = this.sim.analysed
        const chart = a?.result.ok ? a.result.chart : undefined
        const states: { id: string; label: string }[] = []
        const visit = (st: State, path: string[]) => {
            for (const r of st.regions) for (const c of r.states) {
                states.push({ id: c.id, label: `${[...path, c.name].join('.')} is active` })
                visit(c, [...path, c.name])
            }
        }
        if (chart) visit(chart, [])
        const options = [{ id: 'watch', label: 'the watch holds' }, ...states]
        const key = options.map(o => `${o.id}=${o.label}`).join('|')
        if (select.dataset.key !== key) {
            const before = select.value
            select.replaceChildren(...options.map(o => new Option(o.label, o.id)))
            select.dataset.key = key
            if (options.some(o => o.id === before)) select.value = before
        }
        const watchOption = select.querySelector<HTMLOptionElement>('option[value="watch"]')
        if (watchOption) watchOption.disabled = !this.watch
        if (select.value === 'watch' && !this.watch && states.length) select.value = states[0].id
        const can = this.running || (!!chart && (select.value !== 'watch' || !!this.watch))
        run.setAttribute('aria-disabled', String(!can))
        run.textContent = this.running ? 'Stop' : 'Run'
        select.disabled = this.running
    }

    /** Steps until the goal is reached (a later tick than the one shown). */
    async runUntil() {
        const select = $<HTMLSelectElement>(this.pg.root, '[data-pg-until]')
        const host = this.sim.host
        if (!select || !host || this.running || !this.sim.ok) return
        const goal = select.value
        const watch = this.watch
        if (goal === 'watch' && !watch) return
        const label = select.selectedOptions[0]?.textContent ?? ''
        const reached = (v: QuietStep) => (goal === 'watch' ? holds(watch!.at(v.history as WatchTick[], v.cursor)) : !!v.tick?.active.includes(goal))
        this.running = true
        this.stop = false
        this.renderUntil()
        let message = `Not within ${UNTIL_MAX} ticks: ${label.replace(/ is active$/, ' was never active').replace(/^the watch holds$/, 'the watch never held')}.`
        let drawn = performance.now()
        let cursor = this.sim.view?.cursor ?? 0
        try {
            for (let i = 0; i < UNTIL_MAX; i++) {
                const before = cursor
                const v = host.stepQuietly()
                if (!v?.tick || v.cursor === before) {
                    message = this.sim.tourActive ? `The guided tour ends in tick ${before}. Take over to run further.` : `The simulation stopped in tick ${before}.`
                    break
                }
                cursor = v.cursor
                if (v.tick.error) {
                    message = `Stopped in tick ${v.cursor}: ${v.tick.error.message}`
                    break
                }
                if (reached(v)) {
                    message = `Stopped in tick ${v.cursor}: ${goal === 'watch' ? `the watch holds (${watch!.text})` : label}.`
                    break
                }
                if (v.tick.terminated) {
                    message = `The chart has terminated (tick ${v.cursor}), and ${goal === 'watch' ? 'the watch has not held' : label.replace(/ is active$/, ' has not been active')}.`
                    break
                }
                // Show the progress, and let the page breathe (and the reader press Stop).
                if (performance.now() - drawn > DRAW_EVERY) {
                    host.settle()
                    await new Promise(r => setTimeout(r))
                    drawn = performance.now()
                    if (this.sim.host !== host) return
                    if (this.stop) {
                        message = `Stopped in tick ${cursor}, before ${goal === 'watch' ? 'the watch held' : label.replace(/ is active$/, ' was active')}.`
                        break
                    }
                }
            }
        } finally {
            if (this.sim.host === host) host.settle()
            this.running = false
            this.renderUntil()
        }
        this.pg.toast(message)
    }
}

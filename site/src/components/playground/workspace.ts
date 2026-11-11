// The workspace's geometry (/playground, from 60rem): the files sidebar (its width, and folded away), the editor |
// diagram splitter, and the bottom panel's height. Each is remembered in local storage (guarded).
//
// The bottom panel is as tall as the simulation needs (its controls and timing diagram, every lane in view), up to
// AUTO_SHARE of the workspace; dragging the splitter above it (or its arrow keys) sets a height of the reader's own,
// and a double click (or Enter on it) goes back to fitting.

import { $, recall, remember } from './app-types'
import type { Playground } from './app'

const SIM_KEY = 'sccharts-guide:playground:sim-height'
const SPLIT_KEY = 'sccharts-guide:playground:split'
const FILES_KEY = 'sccharts-guide:playground:files'
const FILES_W_KEY = 'sccharts-guide:playground:files-width'
/** The most of the workspace the fitted panel takes. */
const AUTO_SHARE = 0.55

export class Workspace {
    private user?: number
    private need = 0
    private observer?: ResizeObserver
    private grid: HTMLElement | null

    constructor(private pg: Playground) {
        this.grid = $(pg.root, '[data-pg-grid]')
        const split = $(pg.root, '[data-pg-split]')
        const hsplit = $(pg.root, '[data-pg-hsplit]')
        const top = $(pg.root, '[data-pg-top]')
        if (split && top) {
            this.splitter(top, split, {
                key: SPLIT_KEY,
                min: 0.2,
                max: 0.8,
                initial: 0.5,
                apply: f => top.style.setProperty('--pg-split', `${(f * 100).toFixed(2)}%`),
                at: ev => {
                    const r = top.getBoundingClientRect()
                    return (ev.clientX - r.left) / r.width
                },
            })
        }
        if (hsplit && this.grid) this.setupPanelHeight(this.grid, hsplit)
        this.setupFiles()
        pg.root.addEventListener('sc-pg-tab', e => {
            if ((e as CustomEvent).detail.tab === 'code') requestAnimationFrame(() => pg.view.requestMeasure())
        })
    }

    // ----- The files sidebar -----------------------------------------------------------------------------------------

    /** Whether the sidebar is shown: the reader's choice, else open for a project of several files. */
    filesOpen(): boolean {
        const saved = recall(FILES_KEY)
        return saved ? saved === 'open' : this.pg.project.paths.length > 1
    }

    applyFiles(open = this.filesOpen()) {
        this.pg.root.dataset.files = open ? 'open' : 'closed'
        for (const b of this.pg.root.querySelectorAll<HTMLElement>('[data-action="toggle-files"]')) b.setAttribute('aria-expanded', String(open))
    }

    toggleFiles(open = this.pg.root.dataset.files !== 'open') {
        remember(FILES_KEY, open ? 'open' : 'closed')
        this.applyFiles(open)
        // On a phone the sidebar is a sheet over the editor: focus moves into it and back.
        if (open) requestAnimationFrame(() => $(this.pg.root, '[data-pg-files] [aria-current="true"], [data-pg-files] button')?.focus())
        requestAnimationFrame(() => this.pg.view.requestMeasure())
    }

    private setupFiles() {
        const pg = this.pg
        pg.root.addEventListener('click', e => {
            const b = (e.target as Element).closest('[data-action="toggle-files"]')
            if (b && pg.root.contains(b)) this.toggleFiles()
        })
        // On a phone the sheet closes on Escape, and after a file is chosen.
        $(pg.root, '[data-pg-files]')?.addEventListener('keydown', e => {
            if (e.key === 'Escape' && pg.isNarrow() && pg.root.dataset.files === 'open') {
                e.preventDefault()
                this.applyFiles(false)
                $(pg.root, '[data-action="toggle-files"]')?.focus()
            }
        })
        const work = $(pg.root, '[data-pg-work]')
        const handle = $(pg.root, '[data-pg-fsplit]')
        if (!work || !handle) return
        const set = (px: number, save: boolean) => {
            const w = Math.round(Math.max(160, Math.min(420, px)))
            work.style.setProperty('--pg-files-w', `${w}px`)
            handle.setAttribute('aria-valuenow', String(w))
            if (save) remember(FILES_W_KEY, String(w))
            return w
        }
        const saved = Number(recall(FILES_W_KEY))
        if (saved > 0) set(saved, false)
        handle.addEventListener('pointerdown', e => {
            e.preventDefault()
            handle.setPointerCapture(e.pointerId)
            work.classList.add('is-resizing-x')
            const left = work.getBoundingClientRect().left
            const move = (ev: PointerEvent) => set(ev.clientX - left, false)
            const up = (ev: PointerEvent) => {
                set(ev.clientX - left, true)
                work.classList.remove('is-resizing-x')
                handle.removeEventListener('pointermove', move)
                handle.removeEventListener('pointerup', up)
                handle.removeEventListener('pointercancel', up)
                pg.view.requestMeasure()
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
        })
        handle.addEventListener('keydown', e => {
            const now = Number(handle.getAttribute('aria-valuenow')) || 208
            const step = e.shiftKey ? 64 : 16
            const next = e.key === 'ArrowLeft' ? now - step : e.key === 'ArrowRight' ? now + step : null
            if (next === null) return
            e.preventDefault()
            set(next, true)
        })
        handle.addEventListener('dblclick', () => {
            work.style.removeProperty('--pg-files-w')
            remember(FILES_W_KEY, null)
        })
    }

    // ----- The bottom panel's height ---------------------------------------------------------------------------------

    private rem() {
        return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    }

    /** The panel's height limits: [min, the most fitting may take, the most the splitter may set]. */
    private limits(): [number, number, number] {
        const rem = this.rem()
        const total = this.grid?.getBoundingClientRect().height || 600
        return [7 * rem, Math.max(10 * rem, total * AUTO_SHARE), Math.max(10 * rem, total - 10 * rem)]
    }

    apply() {
        const grid = this.grid
        const handle = $(this.pg.root, '[data-pg-hsplit]')
        if (!grid) return
        const [min, autoMax, max] = this.limits()
        const fitted = this.user === undefined
        const h = Math.round(fitted ? Math.min(autoMax, Math.max(min, this.need)) : Math.min(max, Math.max(min, this.user!)))
        if (!this.need && fitted) grid.style.removeProperty('--pg-sim-h')
        else grid.style.setProperty('--pg-sim-h', `${h}px`)
        if (handle) {
            const total = grid.getBoundingClientRect().height || 1
            handle.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round((h / total) * 100)))))
            handle.setAttribute('aria-valuetext', `Panel ${h} pixels high${fitted ? ', fitted to the simulation' : ''}`)
        }
    }

    /** What the simulation needs: the panel's head, the variables strip, the controls and the timing diagram (or the
     *  list of errors). Measured only while the Simulation tab is shown (another tab keeps the height). */
    private measure() {
        const panel = $(this.pg.root, '[data-pg-panel]')
        const body = $(this.pg.root, '[data-pg-sim]')
        if (!panel || !body || !body.offsetParent) return
        const head = panel.querySelector<HTMLElement>('.sc-pg-panel__head')
        const vars = $(this.pg.root, '[data-pg-vars]')
        const sim = body.querySelector<HTMLElement>('.sc-sim')
        const content = sim?.dataset.state === 'ready'
            ? ['.sc-sim__controls', '.sc-sim__trace'].reduce((n, sel) => n + (sim.querySelector<HTMLElement>(`:scope > ${sel}`)?.offsetHeight ?? 0), 0)
            : ((sim ?? (body.firstElementChild as HTMLElement | null))?.offsetHeight ?? 0)
        if (!content) return
        const need = (head?.offsetHeight ?? 0) + (vars?.offsetHeight ?? 0) + content + 2
        if (Math.abs(need - this.need) < 1) return
        this.need = need
        this.apply()
    }

    /** Watches the simulation's parts (SimPanel replaces them when it mounts again). */
    observeSim() {
        const body = $(this.pg.root, '[data-pg-sim]')
        if (!body || typeof ResizeObserver === 'undefined' || this.pg.mode !== 'page') return
        this.observer?.disconnect()
        const ro = new ResizeObserver(() => {
            // The panel's blocks change with the chart (controls, trace) and when it is rejected (errors).
            const sim = body.querySelector('.sc-sim')
            for (const el of sim ? [sim, ...sim.children] : [...body.children]) ro.observe(el)
            this.measure()
        })
        this.observer = ro
        ro.observe(body.querySelector('.sc-sim') ?? body.firstElementChild ?? body)
        const vars = $(this.pg.root, '[data-pg-vars]')
        if (vars) ro.observe(vars)
        const head = $(this.pg.root, '[data-pg-panel] .sc-pg-panel__head')
        if (head) ro.observe(head)
    }

    private setupPanelHeight(grid: HTMLElement, handle: HTMLElement) {
        const saved = Number(recall(SIM_KEY))
        if (saved > 0) this.user = saved
        const current = () => parseFloat(grid.style.getPropertyValue('--pg-sim-h')) || $(this.pg.root, '[data-pg-panel]')?.getBoundingClientRect().height || this.need
        const set = (h: number | undefined, save = true) => {
            const [min, , max] = this.limits()
            this.user = h === undefined ? undefined : Math.min(max, Math.max(min, h))
            this.apply()
            if (save) remember(SIM_KEY, this.user === undefined ? null : String(Math.round(this.user)))
        }
        handle.addEventListener('pointerdown', e => {
            e.preventDefault()
            handle.setPointerCapture(e.pointerId)
            grid.classList.add('is-resizing-y')
            const start = { y: e.clientY, h: current() }
            const move = (ev: PointerEvent) => set(start.h + (start.y - ev.clientY), false)
            const up = (ev: PointerEvent) => {
                if (Math.abs(ev.clientY - start.y) > 2) set(start.h + (start.y - ev.clientY))
                grid.classList.remove('is-resizing-y')
                handle.removeEventListener('pointermove', move)
                handle.removeEventListener('pointerup', up)
                handle.removeEventListener('pointercancel', up)
                this.pg.view.requestMeasure()
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
        })
        handle.addEventListener('dblclick', () => set(undefined))
        handle.addEventListener('keydown', e => {
            const [min, , max] = this.limits()
            const step = e.shiftKey ? 96 : 32
            let h: number | undefined | null = null
            // Up makes the panel taller.
            if (e.key === 'ArrowUp') h = current() + step
            else if (e.key === 'ArrowDown') h = current() - step
            else if (e.key === 'Home') h = min
            else if (e.key === 'End') h = max
            else if (e.key === 'Enter') h = undefined
            if (h === null) return
            e.preventDefault()
            set(h)
        })
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.apply()).observe(grid)
        this.apply()
    }

    private splitter(
        box: HTMLElement,
        handle: HTMLElement,
        o: { key: string; min: number; max: number; initial: number; apply: (f: number) => void; at: (e: PointerEvent) => number },
    ) {
        const set = (fraction: number) => {
            const f = Math.max(o.min, Math.min(o.max, fraction))
            o.apply(f)
            handle.setAttribute('aria-valuenow', String(Math.round(f * 100)))
            return f
        }
        const save = (f: number) => remember(o.key, String(f))
        const saved = Number(recall(o.key))
        if (saved > 0) set(saved)
        handle.addEventListener('pointerdown', e => {
            e.preventDefault()
            handle.setPointerCapture(e.pointerId)
            box.classList.add('is-resizing-x')
            const move = (ev: PointerEvent) => set(o.at(ev))
            const up = (ev: PointerEvent) => {
                save(set(o.at(ev)))
                box.classList.remove('is-resizing-x')
                handle.removeEventListener('pointermove', move)
                handle.removeEventListener('pointerup', up)
                handle.removeEventListener('pointercancel', up)
                this.pg.view.requestMeasure()
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
        })
        handle.addEventListener('dblclick', () => save(set(o.initial)))
        handle.addEventListener('keydown', e => {
            const now = Number(handle.getAttribute('aria-valuenow') ?? o.initial * 100) / 100
            let f: number | undefined
            if (e.key === 'ArrowLeft') f = now - 0.05
            else if (e.key === 'ArrowRight') f = now + 0.05
            else if (e.key === 'Home') f = o.min
            else if (e.key === 'End') f = o.max
            if (f === undefined) return
            e.preventDefault()
            save(set(f))
        })
    }
}

// The playground's diagram stage: shows a rendered chart and lets the reader pan (drag, wheel, arrow keys), zoom
// (Ctrl/Cmd + wheel, pinch, + and -) and fit it. Clicks and hovers on model elements are reported by data-id.
//
// A chart opens whole, fitted to the stage in both dimensions, as long as its text can still be read that way
// (FIT_MIN); one a little larger opens at FIT_MIN from its top left, nearly whole, and a large one at READABLE from
// its top left (the reader pans; Fit shows it all). Fit (the button, 0) shows the whole chart however small. Either
// view is sticky until the reader pans or zooms, so a diagram that changes while one types stays in view.
//
// Zooming resizes the SVG instead of scaling it with a CSS transform, so text stays crisp at every zoom.

import { applyClasses, type ClassMap } from '../../diagram/highlight'

export interface DiagramViewOptions {
    /** The stage element (position: relative; overflow: hidden). */
    stage: HTMLElement
    onSelect?: (id: string, event: MouseEvent) => void
    onHover?: (id: string | null) => void
    /** Called when the zoom changes (for a zoom read-out). */
    onZoom?: (scale: number, fitted: boolean) => void
    /** Largest scale `fit` may choose (1 = the natural size). */
    maxFit?: number
    /** Room to keep free above the chart when fitting (for controls that float over the stage). */
    padTop?: number
}

const MIN = 0.1
const MAX = 4
const PAD = 16
/** A chart opens fitted when that zoom is at least FIT_MIN: KIELER's 11 px names at about 7 px (renderSvg draws
 *  them 1.25 times as large), small but legible; on a 1280 × 900 screen every chart of the guide up to ABRO's size
 *  opens whole. A chart that would fit at NEARLY opens at FIT_MIN (at least 80 % of it in view); a larger one at
 *  READABLE (names at about 10 px), from its top left. */
export const FIT_MIN = 0.5
export const NEARLY = 0.4
export const READABLE = 0.7

export class DiagramView {
    readonly stage: HTMLElement
    readonly canvas: HTMLDivElement
    svg: SVGSVGElement | null = null
    private natural = { w: 0, h: 0 }
    private k = 1
    private x = 0
    private y = 0
    /** The sticky view: 'auto' (readable), 'fit' (the whole chart), or null once the reader pans or zooms. */
    private mode: 'auto' | 'fit' | null = 'auto'
    private classes: ClassMap = {}
    private pointers = new Map<number, { x: number; y: number }>()
    private drag: { x: number; y: number; moved: boolean; id: string | null } | null = null
    private pinch: { dist: number; k: number; cx: number; cy: number } | null = null
    private hovered: string | null = null
    private resize: ResizeObserver
    private opts: DiagramViewOptions

    constructor(opts: DiagramViewOptions) {
        this.opts = opts
        this.stage = opts.stage
        this.canvas = document.createElement('div')
        this.canvas.className = 'sc-pg-canvas'
        this.stage.append(this.canvas)
        this.stage.tabIndex = 0
        this.stage.addEventListener('pointerdown', this.onPointerDown)
        this.stage.addEventListener('pointermove', this.onPointerMove)
        this.stage.addEventListener('pointerup', this.onPointerUp)
        this.stage.addEventListener('pointercancel', this.onPointerUp)
        this.stage.addEventListener('pointerleave', this.onPointerLeave)
        this.stage.addEventListener('wheel', this.onWheel, { passive: false })
        this.stage.addEventListener('keydown', this.onKey)
        this.resize = new ResizeObserver(() => this.refit())
        this.resize.observe(this.stage)
    }

    /** Shows new SVG markup. `refit`: fit it even if the reader had zoomed (a different chart). */
    show(markup: string, refit = false) {
        const tpl = document.createElement('template')
        tpl.innerHTML = markup.trim()
        const svg = tpl.content.firstElementChild as SVGSVGElement | null
        if (!svg) return
        const w = Number(svg.getAttribute('data-natural-width')) || Number(svg.getAttribute('width')) || 100
        const h = Number(svg.getAttribute('data-natural-height')) || Number(svg.getAttribute('height')) || 100
        const old = this.natural
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        svg.style.maxWidth = 'none'
        svg.classList.add('sc-pg-svg')
        if (this.svg) this.svg.replaceWith(svg)
        else this.canvas.append(svg)
        this.svg = svg
        this.natural = { w, h }
        applyClasses(svg, this.classes)
        if (refit || !old.w) this.autoFit()
        else if (this.mode) this.refit()
        else {
            // Keep the top-left corner of the chart where it was.
            this.apply()
        }
    }

    /** Re-applies the sticky view (after a resize or a new diagram). */
    private refit() {
        if (this.mode === 'auto') this.autoFit()
        else if (this.mode === 'fit') this.fit()
        else this.apply()
    }

    /** Adopts an SVG already in the stage (pre-rendered at build time). */
    adopt(svg: SVGSVGElement) {
        this.show(svg.outerHTML, true)
        if (svg.isConnected && svg !== this.svg) svg.remove()
    }

    clear() {
        this.svg?.remove()
        this.svg = null
        this.natural = { w: 0, h: 0 }
    }

    setClasses(classes: ClassMap) {
        this.classes = classes
        if (this.svg) applyClasses(this.svg, classes)
    }

    get scale() {
        return this.k
    }

    get isFitted() {
        return this.mode !== null
    }

    /** The zoom at which the whole chart fits the stage (at most maxFit). */
    private fitScale(W: number, H: number) {
        const top = this.opts.padTop ?? PAD
        return Math.max(MIN, Math.min((W - 2 * PAD) / this.natural.w, (H - top - PAD) / this.natural.h, this.opts.maxFit ?? 1))
    }

    /** Shows the whole chart, centred, however small that makes it. */
    fit() {
        this.mode = 'fit'
        const { width: W, height: H } = this.stage.getBoundingClientRect()
        if (!this.natural.w || !W || !H) return
        this.place(this.fitScale(W, H), W, H)
    }

    /** The view a chart opens with: the whole chart if it is readable that way, else readable from its top left. */
    autoFit() {
        this.mode = 'auto'
        const { width: W, height: H } = this.stage.getBoundingClientRect()
        if (!this.natural.w || !W || !H) return
        const k = this.fitScale(W, H)
        this.place(k >= FIT_MIN ? k : k >= NEARLY ? FIT_MIN : READABLE, W, H)
    }

    /** Zoom k; centred where the chart fits, else from its top (and its left). */
    private place(k: number, W: number, H: number) {
        const top = this.opts.padTop ?? PAD
        const w = this.natural.w * k, h = this.natural.h * k
        this.k = k
        this.x = w <= W - 2 * PAD ? (W - w) / 2 : PAD
        this.y = h <= H - top - PAD ? top + (H - top - PAD - h) / 2 : top
        this.apply()
    }

    /** Zooms by `factor` around a point of the stage (default: its centre). */
    zoom(factor: number, cx?: number, cy?: number) {
        const rect = this.stage.getBoundingClientRect()
        const px = cx ?? rect.width / 2
        const py = cy ?? rect.height / 2
        const k = Math.max(MIN, Math.min(MAX, this.k * factor))
        const f = k / this.k
        this.x = px - (px - this.x) * f
        this.y = py - (py - this.y) * f
        this.k = k
        this.mode = null
        this.apply()
    }

    /** Natural size (100 %), keeping the centre. */
    actualSize() {
        this.zoom(1 / this.k)
    }

    pan(dx: number, dy: number) {
        this.x += dx
        this.y += dy
        this.mode = null
        this.apply()
    }

    /** Scrolls an element into view if it is outside the stage. */
    reveal(id: string) {
        const target = this.svg?.querySelector(`[data-id="${CSS.escape(id)}"]`) as SVGGraphicsElement | null
        if (!target) return
        const r = target.getBoundingClientRect()
        const s = this.stage.getBoundingClientRect()
        // Hidden (another tab on a phone), or larger than the stage: leave it.
        if (!s.width || !s.height || r.width > s.width - 2 * PAD || r.height > s.height - 2 * PAD) return
        let dx = 0, dy = 0
        if (r.right > s.right - PAD) dx = s.right - PAD - r.right
        if (r.left + dx < s.left + PAD) dx = s.left + PAD - r.left
        if (r.bottom > s.bottom - PAD) dy = s.bottom - PAD - r.bottom
        if (r.top + dy < s.top + PAD) dy = s.top + PAD - r.top
        if (dx || dy) {
            this.x += dx
            this.y += dy
            this.apply()
        }
    }

    /** Sets the callbacks (the app sets them once it has loaded; boot.ts creates the view earlier). */
    setHandlers(handlers: Pick<DiagramViewOptions, 'onSelect' | 'onHover' | 'onZoom'>) {
        Object.assign(this.opts, handlers)
        this.opts.onZoom?.(this.k, this.mode !== null)
    }

    destroy() {
        this.resize.disconnect()
    }

    private apply() {
        if (!this.svg) return
        // Keep at least a corner of the chart on the stage.
        const { width: W, height: H } = this.stage.getBoundingClientRect()
        const w = this.natural.w * this.k
        const h = this.natural.h * this.k
        if (W && H) {
            this.x = Math.min(W - 40, Math.max(40 - w, this.x))
            this.y = Math.min(H - 40, Math.max(40 - h, this.y))
        }
        this.svg.style.width = `${w}px`
        this.svg.style.height = `${h}px`
        this.canvas.style.transform = `translate(${Math.round(this.x)}px, ${Math.round(this.y)}px)`
        this.opts.onZoom?.(this.k, this.mode === 'fit')
    }

    private idAt(target: EventTarget | null): string | null {
        const el = (target as Element | null)?.closest?.('[data-id]')
        if (!el || !this.svg?.contains(el)) return null
        // A declaration or action line belongs to its state for selection purposes; keep its own id.
        return el.getAttribute('data-id')
    }

    private onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.pointers.size === 1) {
            this.drag = { x: e.clientX, y: e.clientY, moved: false, id: this.idAt(e.target) }
        } else if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()]
            const rect = this.stage.getBoundingClientRect()
            this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: this.k, cx: (a.x + b.x) / 2 - rect.left, cy: (a.y + b.y) / 2 - rect.top }
            this.drag = null
        }
    }

    private onPointerMove = (e: PointerEvent) => {
        if (!this.pointers.has(e.pointerId)) {
            if (e.pointerType === 'mouse') this.setHover(this.idAt(e.target))
            return
        }
        const last = this.pointers.get(e.pointerId)!
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.pinch && this.pointers.size >= 2) {
            const [a, b] = [...this.pointers.values()]
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            if (this.pinch.dist > 0) this.zoom((this.pinch.k * dist) / this.pinch.dist / this.k, this.pinch.cx, this.pinch.cy)
            return
        }
        if (!this.drag) return
        if (!this.drag.moved && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) {
            this.drag.moved = true
            this.stage.setPointerCapture(e.pointerId)
            this.stage.classList.add('is-panning')
        }
        if (this.drag.moved) this.pan(e.clientX - last.x, e.clientY - last.y)
    }

    private onPointerUp = (e: PointerEvent) => {
        const drag = this.drag
        this.pointers.delete(e.pointerId)
        if (this.pointers.size < 2) this.pinch = null
        if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId)
        this.stage.classList.remove('is-panning')
        if (e.type === 'pointerup' && drag && !drag.moved && this.pointers.size === 0) {
            const id = drag.id
            if (id) this.opts.onSelect?.(id, e)
        }
        if (this.pointers.size === 0) this.drag = null
    }

    private onPointerLeave = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && !this.pointers.size) this.setHover(null)
    }

    private setHover(id: string | null) {
        if (id === this.hovered) return
        this.hovered = id
        this.opts.onHover?.(id)
    }

    private onWheel = (e: WheelEvent) => {
        if (!this.svg) return
        const rect = this.stage.getBoundingClientRect()
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            this.zoom(Math.exp((-e.deltaY * scale) / 300), e.clientX - rect.left, e.clientY - rect.top)
            return
        }
        // Plain wheel pans while the chart is larger than the stage; otherwise the page scrolls.
        const w = this.natural.w * this.k
        const h = this.natural.h * this.k
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale
        const canX = w > rect.width - 2 * PAD
        const canY = h > rect.height - 2 * PAD
        if ((dx && canX) || (dy && canY)) {
            e.preventDefault()
            this.pan(canX ? -dx : 0, canY ? -dy : 0)
        }
    }

    private onKey = (e: KeyboardEvent) => {
        if (e.target !== this.stage || e.altKey || e.ctrlKey || e.metaKey) return
        const step = e.shiftKey ? 120 : 40
        switch (e.key) {
            case 'ArrowLeft': this.pan(step, 0); break
            case 'ArrowRight': this.pan(-step, 0); break
            case 'ArrowUp': this.pan(0, step); break
            case 'ArrowDown': this.pan(0, -step); break
            case '+': case '=': this.zoom(1.25); break
            case '-': case '_': this.zoom(0.8); break
            case '0': case 'f': case 'F': this.fit(); break
            case '1': this.actualSize(); break
            default: return
        }
        e.preventDefault()
    }
}

/** The playground's stage: a DiagramView on `[data-pg-stage]` that adopts the build-time diagram if there is one. */
export function createDiagramView(root: HTMLElement, mode: 'page' | 'embed'): DiagramView {
    const stage = root.querySelector<HTMLElement>('[data-pg-stage]')!
    const holder = stage.querySelector<HTMLElement>('[data-pg-static-diagram]')
    const pre = holder && !holder.hidden ? holder.querySelector('svg') : null
    const zoom = root.querySelector<HTMLElement>('[data-pg-zoom]')
    const view = new DiagramView({
        stage,
        maxFit: mode === 'embed' ? 1 : 1.25,
        padTop: mode === 'embed' ? 48 : PAD,
        onZoom: (k, fitted) => {
            if (!zoom) return
            zoom.textContent = `${Math.round(k * 100)} %`
            zoom.setAttribute('aria-label', `Zoom ${Math.round(k * 100)} percent${fitted ? ', fitted' : ''}. Show at 100 percent`)
        },
    })
    if (pre) view.adopt(pre as SVGSVGElement)
    holder?.remove()
    return view
}

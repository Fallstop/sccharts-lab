// DOM helpers shared by the widgets: highlight classes on a pre-rendered diagram (with a one-shot pulse along
// transitions that fire), line classes on Expressive Code's source view, and hover / focus linking between
// diagram elements and source lines. Plain DOM, no framework; nothing here imports the layout (elkjs).

import { applyClasses, type ClassMap } from '~diagram/highlight'
import type { TickResult } from '~engine/types'
import type { LineMap } from './lines'
import { copyMarks, copyPhrase } from './trace'

/** The classes a simulation owns on the diagram. `is-focus` belongs to hover linking and is left alone. */
export const SIM_CLASSES = ['is-active', 'is-entered', 'is-exited', 'is-taken', 'is-error'] as const

/** What markCopies needs besides the tick to name a for-region's states per copy. */
export interface CopyOptions {
    /** The tick before (`null` before tick 1): with it, the states left in each copy are known. */
    prev?: TickResult | null
    /** Each for-region's counter name by region id (CompileResult.forCopies), to name the copies (`i = 2`). */
    counters?: Record<string, string>
}

/** Applies a tick's classes (and, given the tick, its for-region copies: markCopies) to a diagram. */
export function markDiagram(svg: Element | null | undefined, classes: ClassMap, tick?: TickResult, copies?: CopyOptions): void {
    if (!svg) return
    applyClasses(svg, classes, SIM_CLASSES)
    markErrors(svg)
    markCopies(svg, tick, copies)
    if (svg.hasAttribute('data-sc-keys')) refreshNames(svg)
}

/** The counter names of a compiled chart's for-regions, by region id (for markCopies). */
export function copyCounters(compiled: { forCopies?: { region: string; counter: string }[] } | undefined): Record<string, string> {
    return Object.fromEntries((compiled?.forCopies ?? []).map((f) => [f.region, f.counter]))
}

/**
 * For-region copies on the diagram, which draws a for-region once: each of its states that is active in some copy
 * gets a badge with the number of copies it is active in (×3, `data-sc-copies`: "active in 3 of 4 copies"). Its
 * accessible name says what it did per copy instead of for all of them at once (`data-sc-copy-detail`, copyPhrase:
 * "active in 3 of 4 copies (i = 0, 1 and 3), entered in this tick in the copy i = 3, left in this tick in the copy
 * i = 2"); the states left are known only given `prev` (the tick before), else the name keeps "left in this tick"
 * for the union of the copies. Needs the engine's `TickResult.copies`; without it (or without a tick) any old badges
 * and names are removed.
 */
export function markCopies(svg: Element | null | undefined, tick?: TickResult, options: CopyOptions = {}): void {
    if (!svg) return
    for (const old of svg.querySelectorAll('.sc-copy-badge')) old.remove()
    for (const el of svg.querySelectorAll('[data-sc-copies], [data-sc-copy-detail]')) {
        el.removeAttribute('data-sc-copies')
        el.removeAttribute('data-sc-copy-detail')
        el.removeAttribute('data-sc-copy-replaces')
    }
    const marks = tick ? copyMarks(tick, options.prev, options.counters) : undefined
    if (!marks?.size) return
    const layer = svg.querySelector('.sc-root')?.parentNode ?? svg
    for (const [id, m] of marks) {
        const g = svg.querySelector(`.sc-state[data-id="${CSS.escape(id)}"]`)
        const shape = g && [...g.children].find((c) => c.classList.contains('sc-shape'))
        if (!g || !shape) continue
        g.setAttribute('data-sc-copy-detail', copyPhrase(m))
        // The marks of the union that the name gives per copy instead (elementLabel).
        g.setAttribute('data-sc-copy-replaces', m.left ? 'is-active is-entered is-exited' : 'is-active is-entered')
        const n = m.active.length
        if (!n) continue
        g.setAttribute('data-sc-copies', `active in ${n} of ${m.of} copies`)
        const [x, y, w] = [num(shape, 'x'), num(shape, 'y'), num(shape, 'width')]
        if (!Number.isFinite(x + y + w)) continue
        const label = `×${n}`
        const bw = 9 + label.length * 6
        const badge = document.createElementNS(SVG_NS, 'g')
        badge.setAttribute('class', 'sc-copy-badge')
        badge.setAttribute('aria-hidden', 'true')
        badge.innerHTML = `<rect x="${x + w - bw + 4}" y="${y - 7}" width="${bw}" height="14" rx="7"/><text x="${x + w - bw / 2 + 4}" y="${y}">${label}</text>`
        layer.appendChild(badge)
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const num = (el: Element | null | undefined, name: string) => Number(el?.getAttribute(name) ?? NaN)

/** Where an element's error marker goes (diagrams are drawn in one coordinate system): a state's top-right
 *  corner (on its rounded outline), a transition's label (top right) or else its arrowhead, a region's corner. */
function errorMarkerAt(el: Element): [number, number] | undefined {
    const own = (cls: string) => [...el.children].find((c) => c.classList.contains(cls))
    if (el.classList.contains('sc-state')) {
        const r = own('sc-shape')
        const [x, y, w, rx] = [num(r, 'x'), num(r, 'y'), num(r, 'width'), num(r, 'rx') || 0]
        return Number.isFinite(x + y + w) ? [x + w - 0.29 * rx, y + 0.29 * rx] : undefined
    }
    if (el.classList.contains('sc-transition')) {
        const bg = el.querySelector('.sc-label-bg')
        if (bg) return [num(bg, 'x') + num(bg, 'width'), num(bg, 'y')]
        const tip = /([-\d.]+)[ ,]([-\d.]+)\s*Z?\s*$/i.exec(own('sc-arrow')?.getAttribute('d') ?? '')
        return tip ? [Number(tip[1]), Number(tip[2]) - 9] : undefined
    }
    if (el.classList.contains('sc-region')) {
        const f = own('sc-region-frame')
        return Number.isFinite(num(f, 'x')) ? [num(f, 'x') + num(f, 'width') - 8, num(f, 'y') + 8] : undefined
    }
    return undefined
}

/**
 * A marker (a small disc with "!") on every state, region and transition marked `is-error`, so an error is told by
 * its shape as well as by its colour; old markers are removed. markDiagram calls it; DiagramView does for the
 * errors drawn at build time. The markers sit on top of the diagram and ignore the pointer.
 */
export function markErrors(svg: Element | null | undefined): void {
    if (!svg) return
    for (const old of svg.querySelectorAll('.sc-error-marker')) old.remove()
    const layer = svg.querySelector('.sc-root')?.parentNode ?? svg
    for (const el of svg.querySelectorAll('.is-error[data-id]:is(.sc-state, .sc-transition, .sc-region)')) {
        const at = errorMarkerAt(el)
        if (!at || !at.every(Number.isFinite)) continue
        const [cx, cy] = at
        const g = document.createElementNS(SVG_NS, 'g')
        g.setAttribute('class', 'sc-error-marker')
        g.setAttribute('aria-hidden', 'true')
        g.innerHTML = `<circle cx="${cx}" cy="${cy}" r="6.5"/><path d="M${cx} ${cy - 3.4}V${cy + 0.8}M${cx} ${cy + 3.2}v0.01"/>`
        layer.appendChild(g)
    }
}

/**
 * Scrolls a timing diagram (a sideways-scrolling `.sc-trace`) only when the tick shown (its `.wv-cursor` column)
 * is out of view, beside the sticky lane names, and then only as far as needed (plus a little context).
 */
export function keepTickInView(trace: Element | null | undefined): void {
    const cur = trace?.querySelector('.wv-cursor')
    if (!trace || !cur) return
    const box = trace.getBoundingClientRect()
    const names = trace.querySelector('.sc-wave__labels')?.getBoundingClientRect().width ?? 0
    const r = cur.getBoundingClientRect()
    const left = box.left + trace.clientLeft + names
    const right = box.left + trace.clientLeft + trace.clientWidth
    const margin = Math.min(r.width / 2, 24)
    if (r.left < left - 0.5) trace.scrollLeft -= left - r.left + margin
    else if (r.right > right + 0.5) trace.scrollLeft += r.right - right + margin
}

export const reducedMotion = (): boolean =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const byId = (root: Element, id: string) => root.querySelectorAll(`[data-id="${CSS.escape(id)}"], [data-ids~="${CSS.escape(id)}"]`)

/**
 * A pulse runs along each transition, in firing order (a chain of immediate transitions is visibly a chain).
 * Nothing happens under prefers-reduced-motion.
 */
export function pulseTransitions(svg: Element | null | undefined, ids: string[], stagger = 160): void {
    if (!svg || !ids.length || reducedMotion()) return
    for (const old of svg.querySelectorAll('.sc-edge-pulse')) old.remove()
    ids.forEach((id, i) => {
        const g = svg.querySelector(`.sc-transition[data-id="${CSS.escape(id)}"]`)
        const edge = g?.querySelector('.sc-edge')
        if (!g || !edge) return
        const pulse = edge.cloneNode() as SVGPathElement
        pulse.setAttribute('class', 'sc-edge-pulse')
        pulse.setAttribute('pathLength', '100')
        pulse.style.animationDelay = `${i * stagger}ms`
        pulse.addEventListener('animationend', () => pulse.remove(), { once: true })
        g.appendChild(pulse)
    })
}

export interface CodeMarks {
    active?: number[]
    taken?: number[]
    error?: number[]
}

const LINE_CLASSES = ['is-active', 'is-taken', 'is-error'] as const
/** What a screen reader hears after a marked line (the marks themselves are visual). */
const LINE_STATUS: Record<(typeof LINE_CLASSES)[number], string> = {
    'is-active': 'active state',
    'is-taken': 'fired in this tick',
    'is-error': 'error',
}

function codeLines(container: Element): Element[] {
    return [...container.querySelectorAll('.ec-line')]
}

/** Marks lines (1-based) of a source view: active states' head lines, fired transitions, errors. Each marked
 *  line also gets its mark as visually hidden text ("(active state)"), for screen readers. */
export function markCode(container: Element | null | undefined, marks: CodeMarks): void {
    if (!container) return
    const lines = codeLines(container)
    for (const l of lines) l.classList.remove(...LINE_CLASSES)
    for (const old of container.querySelectorAll('.sc-line-status')) old.remove()
    const set = (nums: number[] | undefined, cls: string) => nums?.forEach((n) => lines[n - 1]?.classList.add(cls))
    set(marks.active, 'is-active')
    set(marks.taken, 'is-taken')
    set(marks.error, 'is-error')
    for (const l of lines) {
        const said = LINE_CLASSES.filter((c) => l.classList.contains(c)).map((c) => LINE_STATUS[c])
        if (!said.length) continue
        const status = document.createElement('span')
        status.className = 'sc-visually-hidden sc-line-status'
        status.textContent = ` (${said.join(', ')})`
        ;(l.querySelector('.code') ?? l).appendChild(status)
    }
}

/** Puts is-focus on the diagram elements and their source lines (and removes it everywhere else). */
export function focusElements(svg: Element | null | undefined, code: Element | null | undefined, map: LineMap | undefined, ids: string[]): void {
    if (svg) {
        for (const el of svg.querySelectorAll('.is-focus')) el.classList.remove('is-focus')
        for (const id of ids) for (const el of byId(svg, id)) el.classList.add('is-focus')
    }
    if (code) {
        const lines = codeLines(code)
        for (const l of lines) l.classList.remove('is-focus')
        if (map) {
            for (const id of ids) {
                const span = map.spans[id]
                if (span) for (let n = span[0]; n <= span[1]; n++) lines[n - 1]?.classList.add('is-focus')
            }
        }
    }
}

/**
 * Hover and focus linking. Pointing at a diagram element marks it and its source lines; pointing at a source
 * line marks the element written there. The chart itself and implicit regions are not linked (their
 * background is everywhere). `pinned` ids keep is-focus throughout (a Chart's `highlight`). Returns a function
 * that removes the listeners.
 */
export function linkHover(diagram: Element | null, code: Element | null, map: LineMap, root: string, pinned: string[] = []): () => void {
    const offs: (() => void)[] = []
    const on = (el: Element, type: string, fn: (e: Event) => void) => {
        el.addEventListener(type, fn)
        offs.push(() => el.removeEventListener(type, fn))
    }
    const svg = diagram?.querySelector('svg.sc-diagram') ?? null
    let current = ''
    const show = (id: string) => {
        if (id === current) return
        current = id
        focusElements(svg, code, map, id ? [...pinned, id] : pinned)
    }
    const elementOf = (target: EventTarget | null): string => {
        let el = target instanceof Element ? target.closest('[data-id]') : null
        while (el && svg?.contains(el)) {
            const id = el.getAttribute('data-id') ?? ''
            if (id && id !== root && map.spans[id]) return id
            el = el.parentElement?.closest('[data-id]') ?? null
        }
        return ''
    }
    // Leaving by keyboard: forget the element unless focus moved to another one in the same view.
    const left = (view: Element) => (e: Event) => {
        const next = (e as FocusEvent).relatedTarget
        if (!(next instanceof Node) || !view.contains(next)) show('')
    }
    if (svg) {
        on(svg, 'pointerover', (e) => show(elementOf(e.target)))
        on(svg, 'pointerleave', () => show(''))
        // Keyboard focus (enableDiagramKeys) links like the pointer, also for elements without source lines.
        // Listened to on the SVG's parent: Chrome makes an SVG element with focus listeners a tab stop.
        const host = svg.parentElement ?? svg
        on(host, 'focusin', (e) => {
            const el = e.target instanceof Element ? e.target.closest(NAV) : null
            const id = el?.getAttribute('data-id') ?? ''
            show(id && id !== root ? id : '')
        })
        on(host, 'focusout', left(host))
    }
    if (code) {
        const lines = () => codeLines(code)
        const lineOf = (target: EventTarget | null) => {
            const line = target instanceof Element ? target.closest('.ec-line') : null
            return line ? lines().indexOf(line) + 1 : 0
        }
        const owner = (e: Event) => {
            const n = lineOf(e.target)
            const id = n ? map.owners[n] ?? '' : ''
            show(id && id !== root ? id : '')
        }
        on(code, 'pointerover', owner)
        on(code, 'pointerleave', () => show(''))
        on(code, 'focusin', owner)
        on(code, 'focusout', left(code))
    }
    return () => offs.forEach((f) => f())
}

// ----- Keyboard and screen readers --------------------------------------------------------------------------

/** The diagram elements a reader can move between (set by enableDiagramKeys). */
const NAV = '[data-sc-nav]'

const ELEMENT_STATUS: [string, string][] = [
    ['is-error', 'has an error'],
    ['is-active', 'active'],
    ['is-entered', 'entered in this tick'],
    ['is-exited', 'left in this tick'],
    ['is-taken', 'fired in this tick'],
]

/** "state Off, active": the element's name and how the simulation marks it (for a for-region's state: per copy,
 *  markCopies, in place of the marks the diagram shows for all copies at once). */
export function elementLabel(el: Element): string {
    const detail = el.getAttribute('data-sc-copy-detail')
    const replaced = detail ? (el.getAttribute('data-sc-copy-replaces') ?? '').split(' ') : []
    const status = ELEMENT_STATUS.filter(([c]) => el.classList.contains(c) && !replaced.includes(c)).map(([, text]) => text)
    return [el.getAttribute('data-sc-name') ?? '', ...status, detail || el.getAttribute('data-sc-copies') || ''].filter(Boolean).join(', ')
}

/** Updates the accessible names of a diagram's elements after its highlight classes changed. */
export function refreshNames(svg: Element): void {
    for (const el of svg.querySelectorAll(NAV)) {
        const label = elementLabel(el)
        if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label)
    }
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** A name from what the diagram draws, for elements the line map does not know (an expanded reference). */
function drawnName(g: Element): string {
    if (g.classList.contains('sc-transition')) {
        const label = [...g.querySelectorAll(':scope > .sc-label .sc-text')].map(text).join(' ')
        return `transition${label ? `: ${label}` : ''}`
    }
    if (g.classList.contains('sc-region')) {
        const label = text(g.querySelector(':scope > .sc-region-label'))
        return label ? `region ${label}` : ''
    }
    const name = text(g.querySelector(':scope > :is(.sc-title, .sc-state-label)'))
    if (g.classList.contains('sc-connector')) return 'connector'
    const kind = [g.classList.contains('sc-initial') && 'initial', g.classList.contains('sc-final') && 'final', g.classList.contains('sc-superstate') ? 'superstate' : 'state']
    return `${kind.filter(Boolean).join(' ')}${name ? ` ${name}` : ''}`
}

/**
 * Moves focus between `items` of `container` with the arrow keys (one tab stop: a roving tabindex). `keys`
 * 'vertical' uses Up and Down (Left and Right stay free for the simulation's Back and Step), 'both' all four.
 * Home and End go to the first and last item. Items may change (a list re-rendered after each tick): the tab
 * stop is the last item focused while it exists, else the first. Returns a function that removes the listeners.
 */
export function rovingFocus(container: Element, items: string, keys: 'vertical' | 'both' = 'vertical'): () => void {
    let current: Element | null = null
    const all = () => [...container.querySelectorAll<HTMLElement | SVGElement>(items)]
    const sync = () => {
        const list = all()
        if (!current || !list.includes(current as HTMLElement)) current = list[0] ?? null
        for (const el of list) {
            const want = el === current ? '0' : '-1'
            if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want)
        }
    }
    const onFocus = (e: Event) => {
        const el = e.target instanceof Element ? e.target.closest(items) : null
        if (el && container.contains(el)) {
            current = el
            sync()
        }
    }
    const onKey = (e: Event) => {
        const k = e as KeyboardEvent
        if (k.defaultPrevented || k.altKey || k.ctrlKey || k.metaKey) return
        const list = all()
        const from = list.findIndex((el) => el === document.activeElement)
        if (from < 0) return
        const next = k.key === 'ArrowDown' || (keys === 'both' && k.key === 'ArrowRight') ? from + 1
            : k.key === 'ArrowUp' || (keys === 'both' && k.key === 'ArrowLeft') ? from - 1
            : k.key === 'Home' ? 0
            : k.key === 'End' ? list.length - 1
            : -2
        if (next === -2) return
        k.preventDefault()
        const target = list[Math.max(0, Math.min(list.length - 1, next))]
        target?.focus()
    }
    sync()
    container.addEventListener('focusin', onFocus)
    container.addEventListener('keydown', onKey)
    // Items come and go (childList), or start and stop matching (the attributes the selector names).
    const attributes = [...items.matchAll(/\[([\w-]+)/g)].map((m) => m[1])
    const watch = typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : undefined
    watch?.observe(container, { childList: true, subtree: true, ...(attributes.length ? { attributes: true, attributeFilter: attributes } : {}) })
    return () => {
        container.removeEventListener('focusin', onFocus)
        container.removeEventListener('keydown', onKey)
        watch?.disconnect()
    }
}

/** A Svelte action: `use:roving={'li[data-ids]'}` (rovingFocus with Up and Down). */
export function roving(node: HTMLElement, items: string) {
    let off = rovingFocus(node, items)
    return {
        update(next: string) {
            off()
            off = rovingFocus(node, next)
        },
        destroy: () => off(),
    }
}

/**
 * A Svelte action for a button that can disable itself when used (Back and Previous at tick 0, Next at the end
 * of a tour, Reset, Step and Run at a run-time error): the browser would drop keyboard focus to the page, so focus
 * goes to `to()` when that is an enabled button (Step and Run: the Restart button the error brings), else to the
 * nearest enabled button beside it (the next one, else the one before). Only while the button has focus, or right
 * after it was used (a click or a key on it) when focus has already dropped to the page, so focus is never pulled
 * into the widget from elsewhere.
 */
export function keepFocus(button: HTMLButtonElement, to?: () => Element | null | undefined) {
    let usedAt = -Infinity
    let target = to
    const used = () => (usedAt = performance.now())
    const enabled = (n: Element | null | undefined): n is HTMLButtonElement => n instanceof HTMLButtonElement && !n.disabled && n.isConnected
    const watch = new MutationObserver(() => {
        if (!button.disabled) return
        const recent = performance.now() - usedAt <= 1000
        usedAt = -Infinity
        const focus = document.activeElement
        if (focus !== button && !(recent && (!focus || focus === document.body))) return
        const wanted = target?.()
        if (enabled(wanted)) return wanted.focus()
        let n = button.nextElementSibling
        while (n && !enabled(n)) n = n.nextElementSibling
        if (!n) for (n = button.previousElementSibling; n && !enabled(n); ) n = n.previousElementSibling
        ;(n as HTMLElement | null)?.focus()
    })
    button.addEventListener('click', used)
    button.addEventListener('keydown', used)
    watch.observe(button, { attributes: true, attributeFilter: ['disabled'] })
    return {
        update(next?: () => Element | null | undefined) {
            target = next
        },
        destroy() {
            button.removeEventListener('click', used)
            button.removeEventListener('keydown', used)
            watch.disconnect()
        },
    }
}

/**
 * Keyboard and screen-reader access to a pre-rendered diagram. Its states, named regions and transitions get
 * an accessible name ("initial state Off", "transition Off to On: if button go to On", from the line map, else
 * from the text drawn) with the simulation's marks ("active", "fired in this tick"; markDiagram keeps them up
 * to date), and form one tab stop: the arrow keys move between them in the order they are written, Home and
 * End to the first and last. Focus links like hover (linkHover). The SVG becomes a graphics document (it was
 * a single image). Returns a function that undoes the listeners.
 */
export function enableDiagramKeys(svg: SVGSVGElement, map: LineMap | undefined, root: string, hintId?: string): () => void {
    const groups = [...svg.querySelectorAll('g.sc-state[data-id], g.sc-region[data-id], g.sc-transition[data-id]')]
    const named: { el: Element; line: number; order: number }[] = []
    groups.forEach((g, order) => {
        const id = g.getAttribute('data-id') ?? ''
        if (!id || id === root || g.classList.contains('sc-root') || g.classList.contains('sc-method')) return
        const name = map?.names?.[id] ?? drawnName(g)
        if (!name) return // an implicit region
        // Source order; an element of an expanded reference sorts with its reference state.
        const base = id.includes('/') ? id.slice(0, id.indexOf('/')) : id
        const line = map?.spans[id]?.[0] ?? map?.spans[base]?.[0] ?? Number.MAX_SAFE_INTEGER
        named.push({ el: g, line, order })
        const container = g.classList.contains('sc-superstate') || g.classList.contains('sc-region')
        g.setAttribute('role', container ? 'graphics-object' : 'graphics-symbol')
        g.setAttribute('data-sc-name', name)
        g.setAttribute('aria-label', elementLabel(g))
        g.setAttribute('tabindex', '-1')
        // The name says it: the title of a state or region and a transition's label are not read a second time.
        for (const t of g.querySelectorAll(':scope > :is(.sc-title, .sc-state-label, .sc-region-label, .sc-label)')) t.setAttribute('aria-hidden', 'true')
    })
    // The SVG's own name is the chart's ("Diagram of Toggle"): the root's title drawn on it is the same.
    for (const t of svg.querySelectorAll(':scope > g.sc-root > .sc-title')) t.setAttribute('aria-hidden', 'true')
    named.sort((a, b) => a.line - b.line || a.order - b.order)
    // Document order is what querySelectorAll sees: keep a navigation index instead.
    named.forEach((n, i) => n.el.setAttribute('data-sc-nav', String(i)))
    const title = svg.querySelector(':scope > title')
    const desc = svg.querySelector(':scope > desc')
    svg.setAttribute('role', 'graphics-document')
    if (title?.id) svg.setAttribute('aria-labelledby', title.id)
    svg.setAttribute('aria-describedby', [desc?.id, hintId].filter(Boolean).join(' '))
    svg.setAttribute('data-sc-keys', '')
    const order = () => named.map((n) => n.el)
    let current: Element | null = order()[0] ?? null
    current?.setAttribute('tabindex', '0')
    // The focus ring is drawn by hand, a rectangle around the element's geometry: Chrome draws CSS outlines of
    // SVG groups around a generous estimate of their strokes (a transition's ring would cover half the region).
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    ring.setAttribute('class', 'sc-focus-ring')
    ring.setAttribute('aria-hidden', 'true')
    ring.setAttribute('rx', '6')
    const showRing = (el: Element | null) => {
        if (!el || !(el as Element & { matches(s: string): boolean }).matches(':focus-visible')) {
            ring.remove()
            return
        }
        const box = (el as SVGGraphicsElement).getBBox?.()
        if (!box) return
        const pad = 4
        ring.setAttribute('x', String(box.x - pad))
        ring.setAttribute('y', String(box.y - pad))
        ring.setAttribute('width', String(box.width + 2 * pad))
        ring.setAttribute('height', String(box.height + 2 * pad))
        svg.appendChild(ring)
    }
    const onFocus = (e: Event) => {
        const el = e.target instanceof Element ? e.target.closest(NAV) : null
        if (!el) return
        current?.setAttribute('tabindex', '-1')
        current = el
        el.setAttribute('tabindex', '0')
        el.setAttribute('aria-label', elementLabel(el))
        showRing(el)
    }
    const onBlur = () => ring.remove()
    const onKey = (event: Event) => {
        const e = event as KeyboardEvent
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
        const list = order()
        const from = list.findIndex((el) => el === document.activeElement)
        if (from < 0) return
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
        const to = step !== undefined ? from + step : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : undefined
        if (to === undefined) return
        // Also when there is nowhere to go: the simulation's arrow keys (Back, Step) do not apply in here.
        e.preventDefault()
        ;(list[Math.max(0, Math.min(list.length - 1, to))] as SVGElement | undefined)?.focus()
    }
    // On the SVG's parent: Chrome makes an SVG element with focus listeners a tab stop of its own.
    const host = svg.parentElement ?? svg
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    host.addEventListener('keydown', onKey)
    return () => {
        host.removeEventListener('focusin', onFocus)
        host.removeEventListener('focusout', onBlur)
        host.removeEventListener('keydown', onKey)
        ring.remove()
    }
}

/**
 * Keyboard access to a source view linked with a diagram: its lines (those with text) form one tab stop,
 * Up and Down move between them, Home and End to the first and last; focusing a line marks the element
 * written there, as hovering does (linkHover).
 */
export function enableCodeKeys(code: Element): () => void {
    for (const line of codeLines(code)) if (text(line)) line.setAttribute('data-sc-line', '')
    return rovingFocus(code, '.ec-line[data-sc-line]')
}

/** Reads a LineMap that Astro serialised into a frame (`<script type="application/json" data-sc-map>`). */
export function readMap(frame: Element, key?: string): LineMap | undefined {
    const el = frame.querySelector(key ? `script[data-sc-map="${CSS.escape(key)}"]` : 'script[data-sc-map]')
    if (!el?.textContent) return undefined
    try {
        return JSON.parse(el.textContent) as LineMap
    } catch {
        return undefined
    }
}

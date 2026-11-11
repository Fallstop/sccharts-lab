// The outline: the chart as a list (keyboard and screen readers). The diagram is a picture (its <svg> has a title
// and a description, as in the guide's widgets); the outline lists its regions, states and transitions as buttons.
// Focusing (or pointing at) one marks it in the diagram and in the source, as hovering the diagram does; activating
// one selects its source. What the simulation marks (active states, taken transitions, a for-region's copies) is
// marked in the list too, and said in each button's name.

import type { ClassMap } from '@sccharts-lab/diagram/highlight'
import type { RegionLayout, StateLayout, TransitionLayout } from '@sccharts-lab/diagram/types'
import { $, escapeHtml } from './app-types'
import { lineMap } from '../sim/lines'
import type { DiagramControl } from './diagram-control'
import type { Playground } from './app'

/** How the outline says what the simulation marks (the words of the widgets' diagrams, src/components/sim/link.ts). */
const STATUS: [string, string][] = [
    ['is-error', 'has an error'],
    ['is-active', 'active'],
    ['is-entered', 'entered in this tick'],
    ['is-exited', 'left in this tick'],
    ['is-taken', 'fired in this tick'],
]

export class Outline {
    constructor(private pg: Playground, private diagram: DiagramControl) {}

    private get nav() {
        return $(this.pg.root, '[data-pg-outline]')
    }

    toggle(open?: boolean) {
        const nav = this.nav
        const btn = $(this.pg.root, '[data-action="outline"]')
        if (!nav) return
        const show = open ?? !!nav.hidden
        nav.hidden = !show
        btn?.setAttribute('aria-expanded', String(show))
        btn?.classList.toggle('is-on', show)
        if (show) {
            this.render()
            // Before the first layout has arrived the list is empty: the list itself holds focus until it fills.
            nav.tabIndex = -1
            ;(nav.querySelector<HTMLButtonElement>('button') ?? nav).focus()
        } else {
            this.diagram.hoverElement(null)
        }
    }

    render() {
        const nav = this.nav
        const shown = this.diagram.shown
        const layout = shown?.layout
        if (!nav || nav.hidden) return
        if (!layout || !shown) {
            nav.replaceChildren(Object.assign(document.createElement('p'), { className: 'sc-pg-outline__region', textContent: 'There is no diagram yet.' }))
            return
        }
        const names = new Map<string, string>()
        const collect = (st: StateLayout) => {
            names.set(st.id, st.name)
            for (const r of st.regions) r.states.forEach(collect)
        }
        collect(layout.root)
        // What a screen reader hears: the names the widgets' diagrams give their elements ("initial state Off",
        // "transition Off to On: if button go to On"; src/components/sim/lines.ts), the simulation's marks after it.
        const chart = shown.result.chart
        const spoken = chart ? lineMap(chart, shown.tracker.doc.toString()).names ?? {} : {}
        const item = (id: string, name: string, kind: string, label?: string, fallback?: string) => {
            const li = document.createElement('li')
            const b = document.createElement('button')
            b.type = 'button'
            b.dataset.id = id
            b.dataset.name = spoken[id] ?? fallback ?? name
            b.setAttribute('aria-label', b.dataset.name)
            b.innerHTML = `<span class="sc-pg-outline__name">${escapeHtml(name)}</span>${kind ? `<span class="sc-pg-outline__kind">${escapeHtml(kind)}</span>` : ''}${label ? `<span class="sc-pg-outline__label">${escapeHtml(label)}</span>` : ''}`
            li.append(b)
            return li
        }
        const textOf = (t: TransitionLayout) => t.label?.lines.map(l => l.runs.map(r => r.text).join('')).join(' ') ?? ''
        const transition = (t: TransitionLayout) => {
            const flags = [t.immediate && 'immediate', t.preemption === 'strong' && 'strong abort', t.preemption === 'termination' && 'termination', t.history && `${t.history} history`].filter(Boolean).join(', ')
            const label = textOf(t)
            const from = names.get(t.source) ?? t.source
            const to = names.get(t.target) ?? t.target
            return item(t.id, `${from} → ${to}`, flags, label, `transition ${from} to ${to}${label ? `: ${label}` : ''}`)
        }
        const region = (r: RegionLayout, index: number, count: number): HTMLLIElement => {
            const li = document.createElement('li')
            const title = r.name ?? r.label?.runs.map(x => x.text).join('') ?? (count > 1 ? `Region ${index + 1}` : '')
            // The region's own button, then its states and transitions (a list item holds no list item).
            if (title || count > 1) li.append(item(r.id, title || `Region ${index + 1}`, r.dataflow ? 'dataflow region' : 'region', undefined, `${r.dataflow ? 'dataflow region' : 'region'} ${title || index + 1}`).firstElementChild!)
            const ul = document.createElement('ul')
            for (const st of r.states) ul.append(state(st))
            for (const t of r.transitions) ul.append(transition(t))
            li.append(ul)
            return li
        }
        const state = (st: StateLayout): HTMLLIElement => {
            const kind = [st.initial && 'initial', st.final && 'final', st.shape === 'connector' && 'connector', st.reference && 'reference', st.regions.some(r => r.states.length || r.dataflow) && !st.reference && 'superstate'].filter(Boolean).join(', ')
            const li = item(st.id, st.name || '(unnamed)', kind, undefined, st.id === layout.root.id ? `chart ${st.name}` : `${kind ? `${kind} ` : ''}state ${st.name}`)
            if (st.regions.length) {
                const ul = document.createElement('ul')
                st.regions.forEach((r, i) => ul.append(region(r, i, st.regions.length)))
                li.append(ul)
            }
            return li
        }
        const top = document.createElement('ul')
        top.append(state(layout.root))
        // A new layout while the reader is in the list (typing elsewhere, a late first layout): keep their place.
        const inside = nav.contains(document.activeElement)
        const focused = inside ? (document.activeElement as HTMLElement).dataset.id : undefined
        nav.replaceChildren(top)
        if (inside) (nav.querySelector<HTMLButtonElement>(focused ? `button[data-id="${CSS.escape(focused)}"]` : 'button') ?? nav.querySelector('button'))?.focus()
        if (!nav.dataset.wired) this.wire(nav)
        this.mark(this.diagram.classes.sim)
    }

    private wire(nav: HTMLElement) {
        nav.dataset.wired = ''
        const d = this.diagram
        const idOf = (e: Event) => (e.target as Element).closest<HTMLElement>('button[data-id]')?.dataset.id
        nav.addEventListener('focusin', e => {
            const id = idOf(e)
            if (!id) return
            d.hoverElement(id)
            d.view.reveal(id)
        })
        nav.addEventListener('focusout', () => d.hoverElement(null))
        nav.addEventListener('pointerover', e => {
            const id = idOf(e)
            if (id) d.hoverElement(id)
        })
        nav.addEventListener('pointerleave', () => d.hoverElement(null))
        nav.addEventListener('click', e => {
            const id = idOf(e)
            if (id) d.selectElement(id)
        })
        nav.addEventListener('keydown', e => {
            const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button[data-id]')]
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
            let next: HTMLButtonElement | undefined
            if (e.key === 'ArrowDown') next = buttons[Math.min(buttons.length - 1, i + 1)]
            else if (e.key === 'ArrowUp') next = buttons[Math.max(0, i - 1)]
            else if (e.key === 'Home') next = buttons[0]
            else if (e.key === 'End') next = buttons[buttons.length - 1]
            else if (e.key === 'Escape') {
                e.preventDefault()
                this.toggle(false)
                $(this.pg.root, '[data-action="outline"]')?.focus()
                return
            }
            if (!next) return
            e.preventDefault()
            next.focus()
        })
    }

    /** The simulation's marks (and errors), in the outline: shown, and said after the name, as the widgets do; a
     *  for-region's state with the number of copies it is active in (the diagram's badge, markCopies). */
    mark(sim: ClassMap) {
        const nav = this.nav
        if (!nav || nav.hidden) return
        const errors = this.diagram.classes.errors
        const svg = this.diagram.view.svg
        for (const b of nav.querySelectorAll<HTMLButtonElement>('button[data-id]')) {
            const id = b.dataset.id!
            const cls = [...(errors[id] ?? []), ...(sim[id] ?? [])]
            b.classList.toggle('is-active', cls.includes('is-active'))
            b.classList.toggle('is-taken', cls.includes('is-taken'))
            // A for-region's state: its marks per copy (markCopies) in place of the union's, as the diagram names it.
            const g = svg?.querySelector(`.sc-state[data-id="${CSS.escape(id)}"]`)
            const detail = g?.getAttribute('data-sc-copy-detail') || g?.getAttribute('data-sc-copies') || ''
            const replaced = detail ? (g?.getAttribute('data-sc-copy-replaces') ?? '').split(' ') : []
            const status = STATUS.filter(([c]) => cls.includes(c) && !replaced.includes(c)).map(([, text]) => text)
            const n = /^active in (\d+) of/.exec(g?.getAttribute('data-sc-copies') ?? '')?.[1]
            let badge = b.querySelector<HTMLElement>('.sc-pg-outline__copies')
            if (n && !badge) {
                badge = Object.assign(document.createElement('span'), { className: 'sc-pg-outline__copies' })
                badge.setAttribute('aria-hidden', 'true')
                b.querySelector('.sc-pg-outline__name')?.after(badge)
            }
            if (badge) {
                badge.hidden = !n
                badge.textContent = n ? `×${n}` : ''
            }
            b.setAttribute('aria-label', [b.dataset.name, ...status, detail].filter(Boolean).join(', '))
        }
    }
}

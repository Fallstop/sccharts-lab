// "Variables" in the simulation's head opens a strip of check boxes under it, one per variable of the chart
// (variables.ts), grouped as inputs, outputs, locals, members and time. The trace follows every change at once, so
// the strip stays open next to it; the choice is remembered per chart. The default is KIELER's data pool: the
// inputs, the outputs and the chart's top-level locals. The watch and Run until sit under the check boxes.

import type { CompileResult } from '@sccharts-lab/engine'
import { $, escapeHtml, plural } from './app-types'
import { GROUP_TITLES, defaultShow, loadChoice, resolveShow, saveChoice, variableChoices, type VarChoice, type VarGroup } from './variables'
import type { SimControl } from './sim-control'
import type { Playground } from './app'

export class VariablesStrip {
    /** The variables the timing diagram traces (undefined: SimPanel's default). */
    show?: string[]
    private choices: VarChoice[] = []
    /** How many of the chart's variables the panel cannot trace yet (not offered). */
    private untraceable = 0

    constructor(private pg: Playground, private sim: SimControl) {
        const toggle = $<HTMLButtonElement>(pg.root, '[data-pg-vars-toggle]')
        const strip = $(pg.root, '[data-pg-vars]')
        if (!toggle || !strip) return
        toggle.addEventListener('click', () => this.toggle())
        strip.addEventListener('change', e => {
            const box = e.target as HTMLInputElement
            if (box.type !== 'checkbox') return
            const on = new Set(this.show ?? defaultShow(this.choices))
            if (box.checked) on.add(box.value)
            else on.delete(box.value)
            this.apply(this.choices.filter(c => on.has(c.name)).map(c => c.name))
        })
        strip.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('button[data-vars]')
            if (!b) return
            this.apply(b.dataset.vars === 'all' ? this.choices.map(c => c.name) : b.dataset.vars === 'none' ? [] : defaultShow(this.choices))
        })
        strip.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            this.toggle(false)
            toggle.focus()
        })
    }

    /** The simulated chart's variables, and what to trace of them (the reader's choice for the chart, else the default). */
    setChoices(result: CompileResult) {
        const found = result.chart && result.ok ? variableChoices(result) : { choices: [], untraceable: 0 }
        this.choices = found.choices
        this.untraceable = found.untraceable
        const chart = result.chart?.name
        this.show = chart && this.choices.length ? resolveShow(this.choices, loadChoice(chart)) : undefined
        this.sim.watch.setChart(result)
        this.render()
    }

    toggle(open?: boolean) {
        const toggle = $<HTMLButtonElement>(this.pg.root, '[data-pg-vars-toggle]')
        const strip = $(this.pg.root, '[data-pg-vars]')
        if (!toggle || !strip) return
        const show = open ?? strip.hidden === true
        strip.hidden = !show
        toggle.setAttribute('aria-expanded', String(show))
        toggle.classList.toggle('is-on', show)
        if (show) {
            this.render()
            strip.querySelector<HTMLInputElement>('input')?.focus()
        }
    }

    /** Traces `show` from now on and remembers it for the chart. */
    private apply(show: string[]) {
        this.show = show
        const chart = this.sim.analysed?.result.chart?.name
        if (chart) saveChoice(chart, this.choices, show)
        this.sim.host?.setShow(show)
        this.render()
    }

    render() {
        const strip = $(this.pg.root, '[data-pg-vars]')
        const toggle = $(this.pg.root, '[data-pg-vars-toggle]')
        if (!strip || !toggle) return
        const list = $(strip, '[data-pg-vars-list]') ?? strip
        const choices = this.choices
        const on = new Set(this.show ?? defaultShow(choices))
        const count = $(toggle, '[data-pg-vars-count]')
        // "Variables 4 of 5" (and, for screen readers, "shown in the timing diagram").
        if (count) count.textContent = choices.length ? ` ${choices.filter(c => on.has(c.name)).length} of ${choices.length}` : ''
        if (strip.hidden) return
        const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLInputElement | HTMLButtonElement) : null
        const focusKey = focused instanceof HTMLInputElement ? `v:${focused.value}` : focused?.dataset.vars ? `b:${focused.dataset.vars}` : undefined
        const parts: HTMLElement[] = []
        if (!choices.length) {
            parts.push(Object.assign(document.createElement('p'), { className: 'sc-pg-vars__none', textContent: 'This chart has no variables: the timing diagram shows its regions.' }))
        } else {
            const groups = document.createElement('div')
            groups.className = 'sc-pg-vars__groups'
            for (const group of Object.keys(GROUP_TITLES) as VarGroup[]) {
                const items = choices.filter(c => c.group === group)
                if (!items.length) continue
                const g = document.createElement('div')
                g.className = 'sc-pg-vars__group'
                g.setAttribute('role', 'group')
                const title = document.createElement('span')
                title.className = 'sc-pg-vars__title'
                title.id = `sc-pg-vars-${group}`
                title.textContent = GROUP_TITLES[group]
                g.setAttribute('aria-labelledby', title.id)
                g.append(title)
                for (const c of items) {
                    const label = document.createElement('label')
                    label.className = 'sc-pg-vars__item'
                    label.title = c.detail
                    const scope = c.scope ? `<span class="sc-pg-vars__scope" aria-hidden="true">${escapeHtml(c.scope)}</span>` : ''
                    label.innerHTML = `<input type="checkbox" value="${escapeHtml(c.name)}"${on.has(c.name) ? ' checked' : ''}><code>${escapeHtml(c.label)}</code>${scope}<span class="sc-visually-hidden">, ${escapeHtml(c.detail)}</span>`
                    g.append(label)
                }
                groups.append(g)
            }
            parts.push(groups)
            const foot = document.createElement('div')
            foot.className = 'sc-pg-vars__foot'
            const more = this.untraceable ? ` The simulator cannot trace ${plural(this.untraceable, 'more variable')} of this chart yet.` : ''
            foot.innerHTML = `<span class="sc-pg-vars__note">Every region has a lane too.${more}</span><span class="sc-pg-vars__buttons"><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="default" title="Inputs, outputs and the chart's own locals, as KIELER's data pool lists them">Default</button><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="all">All</button><button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" data-vars="none">None</button></span>`
            parts.push(foot)
        }
        list.replaceChildren(...parts)
        if (focusKey) {
            const sel = focusKey.startsWith('v:') ? `input[value="${CSS.escape(focusKey.slice(2))}"]` : `button[data-vars="${CSS.escape(focusKey.slice(2))}"]`
            ;(list.querySelector<HTMLElement>(sel) ?? list.querySelector<HTMLElement>('input, button'))?.focus()
        }
        this.sim.watch.renderUntil()
    }
}

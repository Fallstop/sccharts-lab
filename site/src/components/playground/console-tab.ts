// The Console tab of the bottom panel (panel-tabs.ts): Console.svelte, with Clear and Copy in the panel's head and
// the number of lines printed up to the tick shown as the tab's badge.

import { mount, unmount } from 'svelte'
import Console from './Console.svelte'
import { pgIcons } from './icons'
import type { PanelTabContext } from './panel-tabs'

export function mountConsole(host: HTMLElement, ctx: PanelTabContext): () => void {
    const tool = (label: string, icon: string, title: string) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'sc-btn sc-btn--sm sc-btn--quiet sc-pg__simtool'
        b.innerHTML = `${icon}<span class="sc-pg__simtool-label">${label}</span>`
        b.title = title
        return b
    }
    const clear = tool('Clear', pgIcons.clear, 'Hide the lines printed so far')
    const copy = tool('Copy', pgIcons.copy, 'Copy the lines shown, each with its tick')
    ctx.tools.replaceChildren(clear, copy)
    let count = 0
    const app = mount(Console, {
        target: host,
        props: {
            model: ctx.model,
            onchange: (s: { count: number }) => {
                count = s.count
                ctx.setBadge(count || undefined, count === 1 ? '1 line printed' : `${count} lines printed`)
                for (const b of [clear, copy]) b.setAttribute('aria-disabled', String(!count))
            },
        },
    }) as { clear(): void; text(): string }
    clear.addEventListener('click', () => {
        if (count) app.clear()
    })
    copy.addEventListener('click', async () => {
        if (!count) return
        try {
            await navigator.clipboard.writeText(app.text())
            ctx.toast(count === 1 ? 'Copied the line printed.' : `Copied ${count} lines printed.`)
        } catch {
            ctx.toast('The browser did not let the playground copy.')
        }
    })
    return () => void unmount(app as Record<string, unknown>)
}

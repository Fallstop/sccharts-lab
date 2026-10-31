// The playground's phone tabs (Code, Diagram, Simulate). Wired by boot.ts as soon as the page runs scripts, so the
// tabbed layout is there from the first paint; the app switches tabs too (a click on a problem shows the code).

export function showTab(root: HTMLElement, tab: string, focus = false) {
    root.dataset.tab = tab
    for (const t of root.querySelectorAll<HTMLButtonElement>('[data-pg-tabs] [role="tab"]')) {
        const on = t.dataset.tab === tab
        t.setAttribute('aria-selected', String(on))
        t.tabIndex = on ? 0 : -1
        if (on && focus) t.focus()
    }
    root.dispatchEvent(new CustomEvent('sc-pg-tab', { detail: { tab } }))
}

export function setupTabs(root: HTMLElement) {
    const list = root.querySelector<HTMLElement>('[data-pg-tabs]')
    if (!list) return
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    list.addEventListener('click', e => {
        const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]')
        if (tab?.dataset.tab) showTab(root, tab.dataset.tab)
    })
    list.addEventListener('keydown', e => {
        const i = tabs.indexOf(document.activeElement as HTMLButtonElement)
        if (i < 0) return
        let j = -1
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length
        else if (e.key === 'Home') j = 0
        else if (e.key === 'End') j = tabs.length - 1
        if (j < 0) return
        e.preventDefault()
        showTab(root, tabs[j].dataset.tab!, true)
    })
    showTab(root, root.dataset.tab ?? 'code')
}

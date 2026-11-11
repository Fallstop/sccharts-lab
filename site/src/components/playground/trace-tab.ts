// The Trace tab of the bottom panel (panel-tabs.ts): TraceTab.svelte. Its badge counts the ticks where a replay
// differs from its file.

import { mount, unmount } from 'svelte'
import TraceTab from './TraceTab.svelte'
import { pgIcons } from './icons'
import type { PanelTabContext } from './panel-tabs'

export function mountTrace(host: HTMLElement, ctx: PanelTabContext): () => void {
    const app = mount(TraceTab, { target: host, props: { ctx, icons: pgIcons } })
    return () => void unmount(app)
}

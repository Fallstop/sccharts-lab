// The C code tab of the bottom panel (panel-tabs.ts): CCode.svelte, loaded the first time the tab is shown (with
// CodeMirror's C mode).

import { mount, unmount } from 'svelte'
import CCode from './CCode.svelte'
import { pgIcons } from './icons'
import type { PanelTabContext } from './panel-tabs'

export function mountCCode(host: HTMLElement, ctx: PanelTabContext): () => void {
    const app = mount(CCode, { target: host, props: { ctx, icons: pgIcons } })
    return () => void unmount(app)
}

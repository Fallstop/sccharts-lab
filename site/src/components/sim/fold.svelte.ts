// The fold in a simulation's foot: whether a tick's details ("What happened", "Explain this tick") are shown, and the
// height the unfolded details keep while the reader steps. Only the reader's own click unfolds a widget of the guide:
// a choice remembered and applied as the widget hydrates (on load, on a hover) would move the page under the reader.

import { tick } from 'svelte'

/** Panels that start unfolded (the playground, whose panel has a size of its own) remember the reader's choice;
 *  panels that start folded (the guide's widgets, the landing chart, embeds) always start folded. */
const KEYS = { folded: undefined, open: 'sc-sim-details-open' } as const

export type FoldStart = keyof typeof KEYS

export class Fold {
    open = $state(false)
    /** The unfolded details' min-height in px (0: none): the tallest they have been since the last reset, so stepping
     *  to a shorter tick does not shrink them and move the page. */
    min = $state(0)
    private node: HTMLElement | undefined
    private readonly key: string | undefined

    constructor(start: FoldStart) {
        this.key = KEYS[start]
        this.open = start === 'open'
    }

    /** The reader's earlier choice, if any (on mount: the server renders the default). */
    restore() {
        if (!this.key) return
        try {
            const v = localStorage.getItem(this.key)
            if (v === 'open' || v === 'folded') this.open = v === 'open'
        } catch {
            /* no storage: the default */
        }
    }

    /** The reader's click: fold or unfold, and remember it. */
    toggle() {
        this.open = !this.open
        this.min = 0
        if (!this.key) return
        try {
            localStorage.setItem(this.key, this.open ? 'open' : 'folded')
        } catch {
            /* no storage: for this page only */
        }
    }

    /** Let the details shrink to what they hold now (Restart, a fold inside them). */
    reset() {
        this.min = 0
        tick().then(() => {
            if (this.node) this.min = this.node.getBoundingClientRect().height
        })
    }

    /** Svelte action on the details' content (not on the box that gets `min`): raises `min` to its height. A new
     *  width lays the text out anew, so `min` starts again from the height at that width. */
    ratchet = (node: HTMLElement) => {
        this.node = node
        let width = -1
        const ro = new ResizeObserver(() => {
            // Not offsetHeight: rounded, it would let the box shrink by a fraction of a pixel.
            const { width: w, height: h } = node.getBoundingClientRect()
            if (w !== width) {
                width = w
                this.min = h
            } else if (h > this.min) this.min = h
        })
        ro.observe(node)
        return {
            destroy: () => {
                ro.disconnect()
                if (this.node === node) this.node = undefined
            },
        }
    }
}

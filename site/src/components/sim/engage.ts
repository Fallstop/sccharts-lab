// `client:engage`, the guide's own Astro client directive (registered in astro.config.mjs): a widget's island
// hydrates when the reader first engages with its frame (the pointer over it, a touch, focus inside it, a key)
// instead of as soon as it scrolls into view. Until then a page loads none of the islands' JavaScript (the
// engine and Svelte, about 140 kB gzipped); what the reader sees first is server-rendered anyway: the diagram,
// the controls, the timing diagram and the tour's first note. All islands share one engine chunk, loaded once.
//
// A click made before hydration has finished (a tap on Step, a submitted Predict form) is held and replayed on
// the same element once the island is live, so the first tap is never lost. Hydration reuses the server-rendered
// nodes, so nothing moves when it happens.

import type { ClientDirective } from 'astro'
import { showLoadFailure } from '../frame/load-failure'

const TRIGGERS = ['pointerover', 'pointerdown', 'touchstart', 'focusin', 'keydown'] as const

const engage: ClientDirective = (load, _options, el) => {
    // The island's frame (diagram, code and controls); an island outside a frame engages with itself.
    const zone: Element = el.closest('.sc-frame') ?? el
    let state: 'waiting' | 'loading' | 'live' = 'waiting'
    let held: MouseEvent | undefined

    const replay = () => {
        const e = held
        held = undefined
        if (!e || !(e.target instanceof Element) || !e.target.isConnected) return
        e.target.dispatchEvent(
            new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: e.clientX,
                clientY: e.clientY,
                screenX: e.screenX,
                screenY: e.screenY,
                button: e.button,
                detail: e.detail,
                altKey: e.altKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                shiftKey: e.shiftKey,
            })
        )
    }

    // Astro's island retries a failed import once itself, then reports `astro:hydration-error` and hands back a
    // hydrate that does nothing: that event is the failure to load (an island nested in one not yet hydrated keeps
    // `ssr` for a while, so the attribute is no sign). Each load() imports anew (Astro adds a cache-busting
    // `astro-retry`), so Retry works without a reload.
    const hydrateNow = async () => {
        let failed: unknown
        const onError = (e: Event) => {
            e.preventDefault()
            failed = (e as CustomEvent<{ error?: unknown }>).detail?.error ?? new Error('The island did not hydrate')
        }
        el.addEventListener('astro:hydration-error', onError)
        try {
            const hydrate = await load()
            await hydrate()
        } finally {
            el.removeEventListener('astro:hydration-error', onError)
        }
        if (failed) throw failed
    }

    const start = async () => {
        if (state !== 'waiting') return
        state = 'loading'
        for (const type of TRIGGERS) zone.removeEventListener(type, start)
        try {
            await hydrateNow()
        } catch {
            // The island's code did not arrive (offline, say): say so in the widget, with Retry, instead of leaving
            // controls that do nothing. The held click is dropped: the reader clicks again once it works.
            held = undefined
            el.removeEventListener('click', hold, true)
            state = 'live'
            showLoadFailure(zone, 'The simulation', hydrateNow)
            return
        }
        state = 'live'
        el.removeEventListener('click', hold, true)
        replay()
    }

    // Clicks inside the island before it is live: keep the first one (a checkbox's toggle is undone by
    // preventDefault and done again by the replay), drop the rest.
    function hold(e: Event) {
        if (state === 'live' || !(e instanceof MouseEvent)) return
        // Links (in a tour note) work without the island: let them.
        if (e.target instanceof Element && e.target.closest('a[href]')) return void start()
        e.preventDefault()
        e.stopImmediatePropagation()
        held ??= e
        void start()
    }

    el.addEventListener('click', hold, true)
    for (const type of TRIGGERS) zone.addEventListener(type, start, { passive: true })
}

export default engage

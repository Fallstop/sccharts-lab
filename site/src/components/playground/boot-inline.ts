// The inline <Playground> of guide pages (PlaygroundInline.astro): it starts when the reader first engages with its
// frame, as the widgets' client:engage does, and a click on its build-time simulation panel before then is replayed
// on the live one.

import type { ProjectSpec } from './app'
import { exampleFile } from './project'

/** The editor did not load (offline, a blocked script): say so where the compiler's status would be. */
export function loadFailed(root: HTMLElement) {
    const summary = root.querySelector('[data-pg-problems-summary]')
    if (summary) summary.textContent = 'The editor could not be loaded. Reload the page to try again.'
    root.querySelector('[data-pg-problems]')?.setAttribute('data-state', 'error')
}

export const one = (name: string, file: string, text: string): ProjectSpec => ({ name, files: { [file]: text }, active: file })

/** Inline playgrounds on guide pages: each starts when it comes near the viewport. */
export function bootInline() {
    const els = [...document.querySelectorAll<HTMLElement>('[data-sc-playground-inline]:not([data-pg-booted])')]
    for (const el of els) bootOneInline(el)
}

/** The way from `root` down to `el`, as indices among element children (undefined when `el` is not inside). */
function pathTo(root: Element, el: Element): number[] | undefined {
    const path: number[] = []
    for (let n: Element = el; n !== root; ) {
        const parent = n.parentElement
        if (!parent) return undefined
        path.unshift([...parent.children].indexOf(n))
        n = parent
    }
    return path
}

/** The element at the end of `path` under `root`. */
function atPath(root: Element, path: number[]): HTMLElement | undefined {
    let n: Element | undefined = root
    for (const i of path) n = n?.children[i]
    return n instanceof HTMLElement ? n : undefined
}

/** A press under way ends at the latest after this long (a pointer let go outside the window, say). */
const PRESS_LIMIT = 1500

/**
 * One inline playground. As the widgets' client:engage (src/components/sim/engage.ts), the app starts when the reader
 * engages with the frame (a click, a touch, a key, focus inside it), so a reader who only scrolls past loads none of
 * it; the pointer over the frame fetches the code ahead. The page already shows everything at its final size
 * (PlaygroundInline.astro renders the simulation panel too), so nothing moves when it starts. A click into the code
 * puts the cursor in the editor once it is there.
 *
 * The build-time panel looks ready: a click on one of its controls (Step, an input's switch) is held and made again
 * on the same control of the live panel, which the app mounts in its place (the two have the same shape), and
 * keyboard focus in the panel moves with it. The app takes over only once no press is under way in the panel
 * (between a pointer or a key going down and its click), so that no click lands on a control that is gone.
 */
function bootOneInline(el: HTMLElement) {
    // Once (bootInline runs again after a client-side navigation).
    if (el.dataset.pgArmed !== undefined) return
    el.dataset.pgArmed = ''
    const zone = el.closest<HTMLElement>('[data-sc-frame]') ?? el
    const sim = zone.querySelector<HTMLElement>('[data-pg-sim]')
    const TRIGGERS = ['pointerdown', 'touchstart', 'keydown', 'focusin'] as const
    let live = false
    let held: number[] | undefined
    let pressing = false
    let released: (() => void) | undefined
    const release = () => {
        if (!pressing) return
        pressing = false
        // After the click that ends the press has been dispatched.
        setTimeout(() => released?.())
    }
    const press = (e: Event) => {
        if (!live && sim?.contains(e.target as Node)) pressing = true
    }
    const idle = () =>
        pressing
            ? new Promise<void>(resolve => {
                  released = resolve
                  setTimeout(resolve, PRESS_LIMIT)
              })
            : Promise.resolve()
    const hold = (e: MouseEvent) => {
        if (live || !sim) return
        const control = e.target instanceof Element ? e.target.closest('button, label, input[type="checkbox"]') : null
        if (control && sim.contains(control)) {
            e.preventDefault()
            e.stopImmediatePropagation()
            held ??= pathTo(sim, control)
            go(e)
        }
        release()
    }
    const letGo = () => setTimeout(release, 50)
    const listen = (on: boolean) => {
        const method = on ? 'addEventListener' : 'removeEventListener'
        zone[method]('pointerdown', press, { capture: true })
        zone[method]('keydown', press, { capture: true })
        zone[method]('click', hold as EventListener, { capture: true })
        // A pointer or a key let go anywhere (without a click: a drag off the control) ends the press too.
        for (const t of ['pointerup', 'pointercancel', 'keyup'] as const) window[method](t, letGo, { capture: true })
    }
    const start = async () => {
        if (el.dataset.pgBooted !== undefined) return
        el.dataset.pgBooted = ''
        const source = JSON.parse(el.querySelector('[data-pg-source]')?.textContent ?? '""') as string
        const id = el.dataset.example
        let Playground: typeof import('./app').Playground
        // The files the example imports, as the guide's widgets compile it (fetched while the app loads).
        const imports = id ? import('./sources').then(m => m.loadImports(id, source)).catch(() => ({})) : Promise.resolve({})
        try {
            ;({ Playground } = await import('./app'))
        } catch {
            loadFailed(el)
            listen(false)
            return
        }
        await idle()
        const focused = document.activeElement
        const focusPath = sim && focused && sim.contains(focused) ? pathTo(sim, focused) : undefined
        const inCode = !!focused && !!el.querySelector('[data-pg-editor]')?.contains(focused)
        // The whole widget frame is the app's root: the simulation sits in the frame's panel slot.
        const file = id ? exampleFile(id) : 'Untitled.sctx'
        const project = one(id ?? 'Chart', file, source)
        Object.assign(project.files, await imports)
        const app = new Playground({ root: zone, mode: 'embed', project, origin: { kind: id ? 'example' : 'new', id, title: id ?? 'Chart' } })
        // Keyboard focus on the build-time code goes to the editor that took its place.
        if (inCode && !zone.contains(document.activeElement)) zone.querySelector<HTMLElement>('.cm-content')?.focus()
        await app.simulationReady()
        live = true
        listen(false)
        if (sim && focusPath && !zone.contains(document.activeElement)) atPath(sim, focusPath)?.focus()
        if (sim && held) atPath(sim, held)?.click()
    }
    const prefetch = () => {
        zone.removeEventListener('pointerover', prefetch)
        void import('./app').catch(() => undefined)
    }
    let going = false
    function go(e: Event) {
        if (going) return
        going = true
        for (const t of TRIGGERS) zone.removeEventListener(t, go)
        zone.removeEventListener('pointerover', prefetch)
        const target = e.target instanceof Element ? e.target : null
        const intoEditor = e.type !== 'keydown' && e.type !== 'focusin' && !!target?.closest('[data-pg-editor]')
        void start().then(() => {
            if (!intoEditor) return
            let tries = 0
            const focus = () => {
                const content = zone.querySelector<HTMLElement>('.cm-content')
                if (content) content.focus()
                else if (++tries < 120) requestAnimationFrame(focus)
            }
            focus()
        })
    }
    zone.addEventListener('pointerover', prefetch, { passive: true })
    listen(true)
    for (const t of TRIGGERS) zone.addEventListener(t, go, { passive: true })
}

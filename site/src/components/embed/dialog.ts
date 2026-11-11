// The playground's Embed dialog (the app bar's Embed, wired by embed-button.ts): what the embed shows, how tall it is,
// the guided tour or the run so far, a live preview (the embed itself) and the code to paste, as the web component or
// an iframe. The chart is the example as it is (`example=`), else the project's text as it is now. The preview comes
// last in the dialog's order (the keyboard reaches the code first: the preview has many stops of its own).

import { MAX_HEIGHT, MIN_HEIGHT, embedUrl, type EmbedTarget, type EmbedView } from '@sccharts-lab/embed/options'
import { parseEvent } from '@sccharts-lab/embed/protocol'
import { elementSnippet, iframeSnippet, iframeSrc, type EmbedChoice } from './snippet'
import { plural } from '../playground/app-types'
import { sameFiles } from '../playground/project'
import { runInputs } from '../playground/run-tour'
import { encodeRun, makeRun } from '../playground/share'
import type { Playground } from '../playground/app'
import './styles/dialog.css'

const VIEWS: { id: EmbedView; label: string; title: string }[] = [
    { id: 'diagram', label: 'Diagram', title: 'The diagram alone' },
    { id: 'sim', label: 'Simulation', title: 'The diagram and the simulation' },
    { id: 'editor', label: 'Editor', title: 'The code and the diagram' },
    { id: 'full', label: 'Everything', title: 'The code, the diagram and the simulation' },
]

interface State {
    view: EmbedView
    auto: boolean
    px: number
    tour: boolean
    run: boolean
    kind: 'element' | 'iframe'
}

/** What the dialog offers for the playground as it is now. */
function snapshot(app: Playground) {
    const project = app.project
    const texts = project.texts()
    const o = app.origin
    const example = (o.kind === 'example' || o.kind === 'default') && o.id && sameFiles(texts, project.loaded) ? o.id : undefined
    const chart: EmbedChoice['chart'] = example ? { example } : { name: project.name, files: texts, active: project.active }
    const sim = app.sim
    const view = sim.view
    const a = sim.analysed
    // A run of the file the embed opens, as it is now.
    const run = a && view?.history.length && sim.ok && !sim.stale && a.file === project.active ? { code: encodeRun(makeRun(runInputs(a.result, view.history).ticks, view.cursor)), ticks: view.history.length, at: view.cursor } : undefined
    const name = app.latest?.result.chart?.name ?? project.name
    return { chart, example, run, tour: !!(example && sim.originTour), chartChoice: app.chartChoice, name }
}

let open: { dialog: HTMLDialogElement; close: () => void } | undefined

export function openEmbedDialog(app: Playground) {
    open?.close()
    const snap = snapshot(app)
    const state: State = { view: 'sim', auto: true, px: 480, tour: false, run: false, kind: 'element' }
    const base = `${location.origin}/`
    let measured: number | undefined

    const dialog = document.createElement('dialog')
    dialog.className = 'sc-embed-dialog'
    dialog.setAttribute('aria-labelledby', 'sc-embed-dialog-title')
    const what = snap.example ? 'the example as it is in the guide' : 'your chart as it is now (the code carries its text)'
    dialog.innerHTML = `
        <div class="sc-embed-dialog__head">
            <h2 id="sc-embed-dialog-title">Embed this chart</h2>
            <button type="button" class="sc-embed-dialog__close" data-close aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
        </div>
        <div class="sc-embed-dialog__body">
            <div class="sc-embed-dialog__options">
                <p class="sc-embed-dialog__what">Put <b data-name></b> on your own page, a course page or a blog: ${what}, live.</p>
                <fieldset class="sc-embed-dialog__views">
                    <legend>Show</legend>
                    <div class="sc-embed-dialog__seg">${VIEWS.map(v => `<label title="${v.title}"><input type="radio" name="sc-embed-view" value="${v.id}"${v.id === state.view ? ' checked' : ''}><span>${v.label}</span></label>`).join('')}</div>
                </fieldset>
                <fieldset class="sc-embed-dialog__height">
                    <legend>Height</legend>
                    <label><input type="radio" name="sc-embed-height" value="auto" checked> As tall as its content</label>
                    <label class="sc-embed-dialog__px"><input type="radio" name="sc-embed-height" value="px"> <input type="number" data-px min="${MIN_HEIGHT}" max="${MAX_HEIGHT}" step="10" value="${state.px}" aria-label="Height in pixels"> pixels</label>
                </fieldset>
                <label class="sc-embed-dialog__check" data-if-tour><input type="checkbox" data-tour> Start in the guided tour</label>
                <label class="sc-embed-dialog__check" data-if-run><input type="checkbox" data-run> Replay this run <span class="sc-embed-dialog__muted" data-run-words></span></label>
            </div>
            <div class="sc-embed-dialog__code">
                <div class="sc-embed-dialog__codehead">
                    <fieldset class="sc-embed-dialog__kinds">
                        <legend class="sc-visually-hidden">Code</legend>
                        <div class="sc-embed-dialog__seg">
                            <label><input type="radio" name="sc-embed-kind" value="element" checked><span>Web component</span></label>
                            <label><input type="radio" name="sc-embed-kind" value="iframe"><span>iframe</span></label>
                        </div>
                    </fieldset>
                    <button type="button" class="sc-btn sc-btn--sm" data-copy>Copy</button>
                </div>
                <pre class="sc-embed-dialog__snippet" tabindex="0" aria-label="The code to paste into your page"><code data-snippet></code></pre>
                <p class="sc-embed-dialog__note" data-note></p>
                <p class="sc-embed-dialog__status" role="status" data-status></p>
            </div>
            <figure class="sc-embed-dialog__preview">
                <figcaption id="sc-embed-dialog-preview">Preview</figcaption>
                <div class="sc-embed-dialog__frame" role="region" aria-labelledby="sc-embed-dialog-preview" tabindex="0"><iframe data-preview loading="eager"></iframe></div>
            </figure>
        </div>`

    const $ = <T extends Element = HTMLElement>(sel: string) => dialog.querySelector(sel) as T
    $('[data-name]').textContent = snap.name
    $<HTMLElement>('[data-if-tour]').hidden = !snap.tour
    $<HTMLElement>('[data-if-run]').hidden = !snap.run
    if (snap.run) $('[data-run-words]').textContent = `(${plural(snap.run.ticks, 'tick')}${snap.run.at < snap.run.ticks ? `, at tick ${snap.run.at}` : ''})`
    const preview = $<HTMLIFrameElement>('[data-preview]')
    const px = $<HTMLInputElement>('[data-px]')
    const status = $('[data-status]')

    const choice = (auto: boolean): EmbedChoice => {
        const target: EmbedTarget = {
            view: state.view,
            height: auto ? 'auto' : state.px,
            ...(state.tour && snap.tour && !state.run ? { tour: true } : {}),
            ...(snap.chartChoice ? { chart: snap.chartChoice } : {}),
        }
        return { base, target, chart: snap.chart, ...(state.run && snap.run ? { run: snap.run.code } : {}), title: `${snap.name} in SCCharts Lab` }
    }

    const render = () => {
        const c = choice(state.auto)
        $('[data-snippet]').textContent = state.kind === 'element' ? elementSnippet(c) : iframeSnippet(c, measured)
        $('[data-note]').textContent =
            state.kind === 'element'
                ? `The script defines <sccharts-lab-chart>; ${state.auto ? 'the element takes the height its content needs' : `it is ${state.px} pixels tall`}. Without JavaScript the page shows ${'example' in snap.chart ? 'nothing in its place' : 'the code'}.`
                : `An iframe keeps the height it is given${state.auto ? ' (here, what the preview needs at its width)' : ''}. It works where scripts are not allowed, such as most course pages.`
        $<HTMLInputElement>('[data-tour]').disabled = state.run
    }

    let reload: ReturnType<typeof setTimeout> | undefined
    let shown = ''
    const reloadPreview = () => {
        clearTimeout(reload)
        reload = setTimeout(() => {
            const c = choice(state.auto)
            const src = state.auto ? embedUrl(base, { ...c.target, ...('example' in c.chart ? { example: c.chart.example } : {}) }, iframeSrc(c).split('#')[1]) : iframeSrc(c)
            if (src === shown) return
            shown = src
            measured = undefined
            preview.style.height = `${state.auto ? 320 : state.px}px`
            preview.title = `Preview: ${c.title}`
            preview.src = src
        }, 200)
    }

    const onMessage = (e: MessageEvent) => {
        if (e.source !== preview.contentWindow) return
        const m = parseEvent(e.data)
        if (m?.event !== 'resize' || !state.auto) return
        measured = m.height
        preview.style.height = `${Math.ceil(m.height)}px`
        render()
    }
    window.addEventListener('message', onMessage)

    dialog.addEventListener('change', e => {
        const t = e.target as HTMLInputElement
        if (t.name === 'sc-embed-view') state.view = t.value as EmbedView
        else if (t.name === 'sc-embed-height') state.auto = t.value === 'auto'
        else if (t.name === 'sc-embed-kind') state.kind = t.value as State['kind']
        else if (t.matches('[data-tour]')) state.tour = t.checked
        else if (t.matches('[data-run]')) state.run = t.checked
        render()
        if (t.name !== 'sc-embed-kind') reloadPreview()
    })
    px.addEventListener('input', () => {
        const n = Math.round(Number(px.value))
        if (!Number.isFinite(n)) return
        state.px = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, n))
        if (state.auto) {
            state.auto = false
            dialog.querySelector<HTMLInputElement>('input[name="sc-embed-height"][value="px"]')!.checked = true
        }
        render()
        reloadPreview()
    })
    $('[data-copy]').addEventListener('click', async () => {
        const code = $('[data-snippet]').textContent ?? ''
        try {
            await navigator.clipboard.writeText(code)
            status.textContent = state.kind === 'element' ? 'Copied the web component.' : 'Copied the iframe.'
        } catch {
            const range = document.createRange()
            range.selectNodeContents($('[data-snippet]'))
            getSelection()?.removeAllRanges()
            getSelection()?.addRange(range)
            status.textContent = 'Select the code and copy it (the browser did not allow copying from here).'
        }
    })
    const close = () => dialog.close()
    $('[data-close]').addEventListener('click', close)
    // A click on the backdrop closes it too.
    dialog.addEventListener('click', e => {
        if (e.target === dialog) close()
    })
    dialog.addEventListener('close', () => {
        window.removeEventListener('message', onMessage)
        clearTimeout(reload)
        dialog.remove()
        open = undefined
    })

    document.body.append(dialog)
    open = { dialog, close }
    render()
    reloadPreview()
    dialog.showModal()
    dialog.querySelector<HTMLInputElement>('input[name="sc-embed-view"]:checked')?.focus()
}


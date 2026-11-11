// The browser half of the consumer smoke test (tools/packages/smoke.mjs bundles it with Vite and loads it in
// headless Chromium): a plain page with only the packages' stylesheets. ABRO is compiled and drawn twice, with the
// bundled ELK on the main thread and with ELK in a Web Worker, then stepped with its diagram highlighted. The results
// go to window.smoke.

import { compile, createSimulation } from '@sccharts-lab/engine'
import { applyClasses, chartToSvg, layoutChart, measureWithTable, renderSvg, tickClasses } from '@sccharts-lab/diagram'
import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import '@sccharts-lab/diagram/fonts.css'
import '@sccharts-lab/diagram/diagram.css'
import source from './abro.sctx?raw'

declare global {
    interface Window { smoke?: Record<string, unknown> }
}

async function run() {
    const result = compile(source)
    if (!result.ok || !result.chart) throw new Error(`ABRO did not compile: ${JSON.stringify(result.diagnostics)}`)
    const chart = result.chart
    const program = result.program

    // The bundled ELK, on this thread (loaded on first use).
    const host = document.getElementById('main-thread')!
    host.innerHTML = await chartToSvg(chart, { program, idPrefix: 'main' })

    // ELK in a Web Worker: the same layout.
    const elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) })
    const layout = await layoutChart(chart, { program, elk })
    document.getElementById('worker')!.innerHTML = renderSvg(layout, { idPrefix: 'worker' })
    const svgs = [...document.querySelectorAll('svg.sc-diagram')]
    const sameLayout = svgs[0].innerHTML.replaceAll('main', 'X') === svgs[1].innerHTML.replaceAll('worker', 'X')

    // Before any highlight (an active state's name is bolder): the text renders exactly as wide as the layout
    // measured it, so the fonts arrived.
    await document.fonts.ready
    const family = getComputedStyle(svgs[0].querySelector('text')!).fontFamily
    let worst = 0
    let measured = 0
    const deviations: string[] = []
    for (const text of svgs[0].querySelectorAll('text')) {
        const size = Number(text.getAttribute('font-size'))
        for (const span of text.querySelectorAll('tspan')) {
            const style = getComputedStyle(span)
            const expected = measureWithTable(span.textContent ?? '', { size, bold: Number(style.fontWeight) >= 700, mono: text.classList.contains('sc-mono') })
            const error = Math.abs(span.getComputedTextLength() - expected)
            if (error > 0.05) deviations.push(`${span.textContent} ${style.fontWeight} ${size}: ${span.getComputedTextLength()} vs ${expected}`)
            worst = Math.max(worst, error)
            measured++
        }
    }

    // Step and highlight.
    const simulation = createSimulation(result)
    const ticks = [{ A: false, B: false, R: false }, { A: true }, { A: false, B: true }]
    const outputs: unknown[] = []
    for (const inputs of ticks) {
        const tick = simulation.step(inputs)
        outputs.push(tick.values.O)
        applyClasses(svgs[0], tickClasses(tick))
    }
    const active = [...svgs[0].querySelectorAll('.is-active')].map(el => el.getAttribute('data-id'))
    const taken = [...svgs[0].querySelectorAll('.is-taken')].map(el => el.getAttribute('data-id'))

    // ABRO has no monospaced text: load that face explicitly.
    const fonts = await Promise.all(['Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible Mono Variable'].map(async f => (await document.fonts.load(`11px "${f}"`)).length > 0))
    // After diagram.css's 120 ms transition.
    await new Promise(resolve => setTimeout(resolve, 400))
    const stroke = getComputedStyle(svgs[0].querySelector('.sc-simple.is-active > .sc-shape')!).stroke
    window.smoke = { ok: true, sameLayout, outputs, active, taken, family, worstWidthError: worst, measured, deviations, fonts, stroke }
    document.getElementById('log')!.textContent = JSON.stringify(window.smoke, null, 2)
}

run().catch(error => {
    window.smoke = { ok: false, error: String(error?.stack ?? error) }
})

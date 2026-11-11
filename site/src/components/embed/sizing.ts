// The embed's height. `height=auto`: the parts take the height their content needs (the diagram as tall as the chart
// drawn as wide as the stage allows, at most at 100 %, between a floor and a ceiling; the editor its lines), and the
// embed reports that height to the page (`resize`), which sizes the frame to it. Otherwise the embed fills its frame
// (`fill`) or the height it was given, and reports that.

export function startSizing(root: HTMLElement, report: (height: number) => void) {
    const stage = root.querySelector<HTMLElement>('[data-pg-stage]')
    const diagram = root.querySelector<HTMLElement>('[data-pg-diagram]')
    // The chart's natural size (DiagramView keeps it on the SVG it shows), for the auto height's diagram.
    const natural = () => {
        const svg = stage?.querySelector('svg.sc-pg-svg')
        const w = Number(svg?.getAttribute('data-natural-width'))
        const h = Number(svg?.getAttribute('data-natural-height'))
        if (!diagram || !(w > 0 && h > 0)) return
        diagram.style.setProperty('--embed-nat-h', `${h}px`)
        diagram.style.setProperty('--embed-ratio', (h / w).toFixed(4))
    }
    if (stage) new MutationObserver(natural).observe(stage, { childList: true, subtree: true })

    let last = -1
    const measure = () => {
        const h = Math.ceil(root.getBoundingClientRect().height)
        if (h > 0 && h !== last) {
            last = h
            report(h)
        }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    measure()
}

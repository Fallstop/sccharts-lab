// renderSvg: draws a DiagramLayout as SVG markup in KIELER's notation. Pure and deterministic.
//
// Colours are not in the markup: every element carries stable classes (sc-state, sc-transition, ...) that
// diagram.css colours through the --sc-* custom properties, and a simulation highlights by toggling classes
// (is-active, is-taken, ...) on the elements with the matching data-id. The only definition, a fade mask for
// KIELER's state gradients, is theme-independent.

import { endTangent, flatten, pathData, place, r2, sampleAt } from './geometry'
import { MONO_FAMILY, SANS_FAMILY } from './measure'
import type {
    CommentLayout, DataflowLayout, DiagramLayout, Point, RegionLayout, RenderOptions, StateLayout, TextLine,
    TransitionLabelLayout, TransitionLayout,
} from './types'

const MARGIN = 6

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => String(r2(n))

function hash(s: string): string {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(36)
}

function cls(base: string[], id: string | undefined, extra: Record<string, string[]> | undefined): string {
    const all = id && extra?.[id] ? [...base, ...extra[id]] : base
    return all.join(' ')
}

function polygon(points: Point[]): string {
    return 'M' + points.map(p => `${num(p.x)} ${num(p.y)}`).join('L') + 'Z'
}

/** A rounded rectangle as a path (so a stroke can be drawn inside a highlight without SVG rx quirks). */
function rect(x: number, y: number, w: number, h: number, r: number): string {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2))
    return `x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rr ? ` rx="${num(rr)}"` : ''}`
}

function textLine(line: TextLine, extraClass = ''): string {
    const classes = ['sc-text', `sc-${line.role}`]
    if (line.bold) classes.push('sc-bold')
    if (line.mono) classes.push('sc-mono')
    if (extraClass) classes.push(extraClass)
    const ids = line.ids?.length ? ` data-id="${esc(line.ids[0])}"${line.ids.length > 1 ? ` data-ids="${esc(line.ids.join(' '))}"` : ''}` : ''
    const spans = line.runs.map(run => {
        const runCls = run.format === 'keyword' ? 'sc-kw' : run.format === 'highlight' ? 'sc-hl' : run.format === 'schedule' ? 'sc-sd' : ''
        return `<tspan x="${num(line.x + run.dx)}"${runCls ? ` class="${runCls}"` : ''}>${esc(run.text)}</tspan>`
    }).join('')
    return `<text class="${classes.join(' ')}" y="${num(line.y)}" font-size="${line.size}"${ids}>${spans}</text>`
}

interface Ctx {
    prefix: string
    classes?: Record<string, string[]>
    regionCorner: boolean
    shadows: boolean
}

function renderState(s: StateLayout, ctx: Ctx): string {
    const base = ['sc-state']
    if (s.shape === 'root') base.push('sc-root', 'sc-superstate')
    else if (s.shape === 'superstate') base.push('sc-superstate')
    else if (s.shape === 'connector') base.push('sc-connector')
    else base.push('sc-simple')
    if (s.initial) base.push('sc-initial')
    if (s.final) base.push('sc-final')
    if (s.reference) base.push('sc-reference')
    if (s.violation) base.push('sc-violation')
    if (s.violation && s.finalInset && !s.final) base.push('sc-halt')
    const out: string[] = [`<g class="${cls(base, s.id, ctx.classes)}" data-id="${esc(s.id)}">`]
    if (s.shape === 'connector') {
        out.push(`<circle class="sc-shape" cx="${num(s.x + s.width / 2)}" cy="${num(s.y + s.height / 2)}" r="${num(s.width / 2 - 0.5)}"/>`)
        out.push('</g>')
        return out.join('')
    }
    if (ctx.shadows) out.push(`<rect class="sc-shadow" ${rect(s.x + 3, s.y + 3, s.width, s.height, s.radius)}/>`)
    // KIELER's vertical gradient: the end colour, the top colour faded out by a (theme-independent) mask, then
    // the border on top. Colours come from CSS, so the markup is the same in every theme.
    const figure = (x: number, y: number, w: number, h: number, r: number, extra = '') => {
        const g = rect(x, y, w, h, r)
        return `<rect class="sc-fill" ${g}/><rect class="sc-fill-top" ${g} mask="url(#${ctx.prefix}-fade)"/><rect class="sc-shape${extra}" ${g}/>`
    }
    const inset = s.finalInset ?? 0
    if (s.shape === 'root') {
        out.push(`<rect class="sc-shape" ${rect(s.x, s.y, s.width, s.height, s.radius)}/>`)
    } else if (inset) {
        // Final state: an outer border, then the figure `inset` inside it.
        out.push(`<rect class="sc-shape sc-final-outer" ${rect(s.x, s.y, s.width, s.height, s.radius)}/>`)
        out.push(figure(s.x + inset, s.y + inset, s.width - 2 * inset, s.height - 2 * inset, s.radius - inset, ' sc-final-inner'))
    } else {
        out.push(figure(s.x, s.y, s.width, s.height, s.radius))
    }
    for (const line of s.lines) out.push(textLine(line))
    for (const r of s.regions) out.push(renderRegion(r, ctx))
    out.push('</g>')
    return out.join('')
}

function renderRegion(r: RegionLayout, ctx: Ctx): string {
    const base = ['sc-region']
    if (r.dataflow) base.push('sc-dataflow')
    if (r.collapsed) base.push('sc-collapsed')
    if (r.final) base.push('sc-final-region')
    if (r.abort) base.push('sc-abort-region')
    if (r.override) base.push('sc-override-region')
    if (r.reference) base.push('sc-reference-region')
    if (r.method) base.push('sc-method', `sc-method-${r.method}`)
    const out: string[] = [`<g class="${cls(base, r.id, ctx.classes)}" data-id="${esc(r.id)}">`]
    out.push(`<rect class="sc-region-frame" ${rect(r.x, r.y, r.width, r.height, 0)}/>`)
    if (r.final) out.push(`<rect class="sc-region-frame sc-region-frame-inner" ${rect(r.x + 3, r.y + 3, r.width - 6, r.height - 6, 0)}/>`)
    if (ctx.regionCorner && !r.empty) {
        // KIELER's expand/collapse button: "-" when expanded, "+" when collapsed, blank for an abstract method.
        const x = r.x + 0.5, y = r.y + 0.5
        out.push(`<path class="sc-region-corner" d="M${num(x)} ${num(y)}L${num(x)} ${num(y + 19.5)}L${num(x + 19.5)} ${num(y)}Z"/>`)
        if (r.method !== 'abstract') {
            const mark = r.collapsed || r.reference ? `M${num(x + 2.5)} ${num(y + 5.5)}h6M${num(x + 5.5)} ${num(y + 2.5)}v6` : `M${num(x + 2.5)} ${num(y + 5.5)}h5`
            out.push(`<path class="sc-region-corner-mark" d="${mark}"/>`)
        }
    }
    if (r.label) out.push(textLine(r.label))
    for (const line of r.lines) out.push(textLine(line))
    if (r.circuit) out.push(renderCircuit(r.circuit))
    for (const s of r.states) out.push(renderState(s, ctx))
    for (const t of r.transitions) out.push(renderTransition(t, ctx))
    for (const c of r.comments) out.push(renderComment(c))
    out.push('</g>')
    return out.join('')
}

// KLighD's head arrow (KPolylineExtensions.addHeadArrowDecorator): 8 long, 6 wide, notched, its tip 2 px
// past the decorator's origin.
const ARROW: [number, number][] = [[-6, -3], [-2.8, 0], [-6, 3], [2, 0]]
// TransitionStyles.addNormalTerminationDecorator: an 11 × 11 triangle pointing along the edge.
const TRIANGLE: [number, number][] = [[-5.5, -5.5], [5.5, 0], [-5.5, 5.5]]

function renderTransition(t: TransitionLayout, ctx: Ctx): string {
    const base = ['sc-transition']
    if (t.immediate) base.push('sc-immediate')
    if (t.preemption === 'strong') base.push('sc-strong')
    if (t.preemption === 'termination') base.push('sc-termination')
    if (t.history) base.push('sc-history', `sc-history-${t.history}`)
    if (t.deferred) base.push('sc-deferred')
    if (t.nondeterministic) base.push('sc-nondeterministic')
    else if (t.probability !== undefined && t.probability > 0) base.push('sc-probabilistic')
    const d = pathData(t.points)
    const poly = flatten(t.points)
    const out: string[] = [`<g class="${cls(base, t.id, ctx.classes)}" data-id="${esc(t.id)}">`]
    if (t.points.length < 2) {
        // ELK found no route (should not happen); keep the element so highlighting still finds it.
        if (t.label) out.push(renderLabel(t.label))
        out.push('</g>')
        return out.join('')
    }
    out.push(`<path class="sc-edge-hit" d="${d}"/>`)
    out.push(`<path class="sc-edge" d="${d}"/>`)
    // Head decorators (TransitionStyles): the arrow moves back to make room for history/deferred markers.
    let arrowAt = -2
    if (t.history) arrowAt = t.deferred ? -26 : -17
    else if (t.deferred) arrowAt = -11
    const head = arrowAt === -2 ? { point: sampleAt(poly, -2).point, tangent: endTangent(t.points) } : sampleAt(poly, arrowAt)
    out.push(`<path class="sc-arrow" d="${polygon(place(head.point, head.tangent, ARROW))}"/>`)
    if (t.history) {
        const at = sampleAt(poly, -6).point
        const deep = t.history === 'deep'
        // The circled H (H* for deep history), KLighD's polyline letter.
        const hx = deep ? -5 : -3, hw = 6
        const letter = `M${num(at.x + hx)} ${num(at.y - 4)}V${num(at.y + 4)}M${num(at.x + hx)} ${num(at.y)}H${num(at.x + hx + hw)}M${num(at.x + hx + hw)} ${num(at.y - 4)}V${num(at.y + 4)}`
        const star = deep ? `<path class="sc-history-star" d="M${num(at.x + 4)} ${num(at.y - 5)}v4M${num(at.x + 2.27)} ${num(at.y - 4)}l3.46 2M${num(at.x + 2.27)} ${num(at.y - 2)}l3.46 -2"/>` : ''
        out.push(`<g class="sc-history-marker"><circle cx="${num(at.x)}" cy="${num(at.y)}" r="8"/><path class="sc-history-letter" d="${letter}"/>${star}</g>`)
    }
    if (t.deferred) {
        const at = sampleAt(poly, t.history ? -19 : -4).point
        const star = t.deferred === 'deep' ? `<path class="sc-deferred-star" d="M${num(at.x)} ${num(at.y - 3)}v6M${num(at.x - 2.6)} ${num(at.y - 1.5)}l5.2 3M${num(at.x - 2.6)} ${num(at.y + 1.5)}l5.2 -3"/>` : ''
        out.push(`<g class="sc-deferred-marker"><circle cx="${num(at.x)}" cy="${num(at.y)}" r="5"/>${star}</g>`)
    }
    // Tail decorators.
    if (t.preemption === 'strong') {
        const at = sampleAt(poly, 4).point
        out.push(`<circle class="sc-strong-marker" cx="${num(at.x)}" cy="${num(at.y)}" r="5"/>`)
    } else if (t.preemption === 'termination') {
        const at = sampleAt(poly, 5)
        out.push(`<path class="sc-termination-marker" d="${polygon(place(at.point, at.tangent, TRIANGLE))}"/>`)
    }
    for (const c of t.comments ?? []) out.push(renderLabel(c, 'sc-label sc-label-comment'))
    if (t.label) out.push(renderLabel(t.label))
    out.push('</g>')
    return out.join('')
}

function renderLabel(l: TransitionLabelLayout, className = 'sc-label'): string {
    const { x, y, width: w, height: h } = l
    const out: string[] = [`<g class="${className}">`]
    out.push(`<rect class="sc-label-bg" ${rect(x, y, w, h, 0)}/>`)
    // LabelPlacementSideHook (on-edge labels): bars across the edge at both ends, a small arrow pointing on.
    let bars: string, arrow: Point[]
    if (l.direction === 'right' || l.direction === 'left') {
        bars = `M${num(x + 0.5)} ${num(y)}V${num(y + h)}M${num(x + w - 0.5)} ${num(y)}V${num(y + h)}`
        const cy = y + h / 2
        arrow = l.direction === 'right'
            ? [{ x: x + w, y: cy - 4 }, { x: x + w + 4, y: cy }, { x: x + w, y: cy + 4 }]
            : [{ x, y: cy - 4 }, { x: x - 4, y: cy }, { x, y: cy + 4 }]
    } else {
        bars = `M${num(x)} ${num(y + 0.5)}H${num(x + w)}M${num(x)} ${num(y + h - 0.5)}H${num(x + w)}`
        const cx = x + w / 2
        arrow = l.direction === 'down'
            ? [{ x: cx - 4, y: y + h }, { x: cx, y: y + h + 4 }, { x: cx + 4, y: y + h }]
            : [{ x: cx - 4, y }, { x: cx, y: y - 4 }, { x: cx + 4, y }]
    }
    out.push(`<path class="sc-label-bars" d="${bars}"/>`)
    out.push(`<path class="sc-label-arrow" d="${polygon(arrow)}"/>`)
    for (const line of l.lines) out.push(textLine(line))
    out.push('</g>')
    return out.join('')
}

function renderComment(c: CommentLayout): string {
    const out: string[] = [`<g class="sc-comment" data-id="${esc(c.id)}">`]
    if (c.points?.length) out.push(`<path class="sc-comment-edge" d="${pathData(c.points)}"/>`)
    // CommentStyles.addCommentFigure: a rectangle with 1 px corners.
    out.push(`<rect class="sc-comment-box" ${rect(c.x, c.y, c.width, c.height, 1)}/>`)
    for (const line of c.lines) out.push(textLine(line))
    out.push('</g>')
    return out.join('')
}

function renderCircuit(c: DataflowLayout): string {
    const out: string[] = ['<g class="sc-circuit">']
    for (const w of c.wires) out.push(`<path class="sc-wire" data-id="${esc(w.id)}" d="${pathData(w.points)}"/>`)
    for (const n of c.nodes) {
        const { x, y, width: w, height: h } = n
        let shape: string
        if (n.kind === 'input') shape = `<path class="sc-df-shape" d="M${num(x)} ${num(y)}H${num(x + w - 6)}L${num(x + w)} ${num(y + h / 2)}L${num(x + w - 6)} ${num(y + h)}H${num(x)}Z"/>`
        else if (n.kind === 'output') shape = `<path class="sc-df-shape" d="M${num(x)} ${num(y)}H${num(x + w - 6)}L${num(x + w)} ${num(y + h / 2)}L${num(x + w - 6)} ${num(y + h)}H${num(x)}L${num(x + 6)} ${num(y + h / 2)}Z"/>`
        else if (n.kind === 'actor') shape = `<rect class="sc-df-shape" ${rect(x, y, w, h, 4)}/><path class="sc-df-divider" d="M${num(x)} ${num(n.lines[0].y + 4)}H${num(x + w)}"/>`
        else shape = `<rect class="sc-df-shape" ${rect(x, y, w, h, n.kind === 'constant' ? 0 : 3)}/>`
        out.push(`<g class="sc-df-node sc-df-${n.kind}" data-id="${esc(n.id)}">${shape}${n.lines.map((l, i) => textLine(l, n.kind === 'actor' && i > 0 ? 'sc-df-port' : '')).join('')}</g>`)
    }
    out.push('</g>')
    return out.join('')
}

function describe(layout: DiagramLayout): string {
    const states: string[] = []
    const transitions: string[] = []
    const name = (id: string) => id.slice(id.lastIndexOf('.') + 1)
    const walk = (s: StateLayout) => {
        for (const r of s.regions) {
            for (const c of r.states) {
                const kind = [c.initial && 'initial', c.final && 'final', c.shape === 'connector' && 'connector', c.shape === 'superstate' && 'superstate'].filter(Boolean)
                states.push(name(c.id) + (kind.length ? ` (${kind.join(', ')})` : ''))
                walk(c)
            }
            for (const t of r.transitions) {
                const label = t.label ? ': ' + t.label.lines.map(l => l.runs.map(x => x.text).join(' ')).join(' ') : ''
                transitions.push(`${name(t.source)} to ${name(t.target)}${label}`)
            }
        }
    }
    walk(layout.root)
    return `States: ${states.join(', ') || 'none'}. Transitions: ${transitions.join('; ') || 'none'}.`
}

/** Draws a laid-out chart. The result is an <svg> element as a string, sized by `options.fit`. */
export function renderSvg(layout: DiagramLayout, options: RenderOptions = {}): string {
    const scale = options.scale ?? 1.25
    const fit = options.fit ?? 'natural'
    const prefix = options.idPrefix ?? `sc-${layout.chart.replace(/[^A-Za-z0-9_-]/g, '_')}-${hash(JSON.stringify(layout.root)).slice(0, 6)}`
    const ctx: Ctx = { prefix, classes: options.classes, regionCorner: options.regionCorner ?? true, shadows: options.shadows ?? layout.shadows ?? true }
    const vw = layout.width + 2 * MARGIN, vh = layout.height + 2 * MARGIN
    const naturalW = r2(vw * scale), naturalH = r2(vh * scale)
    let size: string
    let style = `--sc-font-fallback:'${SANS_FAMILY}';--sc-mono-fallback:'${MONO_FAMILY}'`
    if (fit === 'none') size = `width="${naturalW}" height="${naturalH}"`
    else {
        size = 'width="100%"'
        style += `;height:auto;display:block${fit === 'natural' ? `;max-width:${naturalW}px` : ''}`
        if (options.minScale !== undefined) style += `;min-width:${r2(naturalW * options.minScale)}px`
    }
    const title = options.title ?? `SCChart ${layout.chart}`
    const defs = `<linearGradient id="${prefix}-fade-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>`
        + `<mask id="${prefix}-fade" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1"><rect width="1" height="1" fill="url(#${prefix}-fade-g)"/></mask>`
    const classes = ['sc-diagram', options.className].filter(Boolean).join(' ')
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" class="${esc(classes)}" viewBox="${-MARGIN} ${-MARGIN} ${num(vw)} ${num(vh)}" ${size}`,
        ` role="img" aria-labelledby="${prefix}-title ${prefix}-desc" data-chart="${esc(layout.chart)}" data-natural-width="${naturalW}"`,
        ` data-natural-height="${naturalH}" style="${esc(style)}">`,
        `<title id="${prefix}-title">${esc(title)}</title><desc id="${prefix}-desc">${esc(describe(layout))}</desc>`,
        `<defs>${defs}</defs>`,
        renderState(layout.root, ctx),
        layout.root.comments.map(renderComment).join(''),
        '</svg>',
    ].join('')
}

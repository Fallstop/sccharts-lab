// layoutChart: KIELER's SCCharts diagram synthesis, reduced to what the guide needs, laid out with ELK.
//
// The ELK graph mirrors the one KIELER builds (sccharts.ui/.../synthesis/: StateSynthesis,
// ControlflowRegionSynthesis, TransitionSynthesis, the styles/ and hooks/ LayoutHook, ModelOrderHook,
// LabelPlacementSideHook, LabelShorteningHook), with the same layout options:
//   - a state lays out its regions with rectpacking (regions expanded to fill, 5 apart);
//   - a control-flow region lays out its states with ELK Layered, spline edges, inline ("on edge") labels,
//     model order respected, the initial state in the first layer, and the direction alternating with the
//     nesting depth (KIELER's default "HV": top level left to right, the next level top to bottom, ...);
//   - sizes and paddings are KIELER's (simple states 34 px minimum with 10/8 px text padding, superstate title
//     rows, 20 px region headers, ...). Text is measured with the guide's diagram font instead of KIELER's.

import type { ElkExtendedEdge, ElkLabel, ElkNode } from 'elkjs/lib/elk-api'
import {
    actionSegments, createFormatContext, declarationLines, formatEquation, formatExpression, isImplicitlyImmediate, mergeComponents,
    regionLabelSegments, stateDisplayName, stateTitleSegments, transitionLabelLines,
    type FormatContext, type TextSegment,
} from '../engine/format'
import type { Annotation, Declaration, Region, State, Transition } from '../engine/types'
import { buildCircuit, type CircuitBuild } from './dataflow'
import { flatten, nearest, r2 } from './geometry'
import { lineMetrics, measureWithTable, type TextMeasurer, type TextStyle } from './measure'
import type {
    Box, CommentLayout, DiagramLayout, ElkLike, LabelDirection, LayoutDirection, LayoutOptions, Point, RegionLayout,
    StateLayout, StateShape, TextLine, TextRole, TextRun, TransitionLabelLayout, TransitionLayout,
} from './types'

// ----- KIELER's constants ----------------------------------------------------------------------------

const STATE_LABEL: TextStyle = { size: 11, bold: true }      // StateStyles.addSimpleStateLabel
const TITLE: TextStyle = { size: 11 }                        // StateStyles.addMacroStateLabel
const DECLARATION: TextStyle = { size: 10 }                  // KLighD's default font size
const REGION_LABEL: TextStyle = { size: 10 }                 // ControlflowRegionStyles.addRegionButton
const EDGE_LABEL: TextStyle = { size: 11, bold: true }       // TransitionStyles.configureTransitionLabelRendering
const EQUATION: TextStyle = { size: 10, mono: true }
// CommentStyles.addCommentText draws comment text at 7 pt; 9 here, so that it stays legible at the guide's scale.
const COMMENT: TextStyle = { size: 9 }
const COMMENT_PAD = 4             // CommentStyles: from(LEFT 4, TOP 4).to(RIGHT 4, BOTTOM 4)
const COMMENT_MIN = 16            // CommentStyles: setMinimalNodeSize(16, 16)

const CORNER = 17                 // DEFAULT_FIGURE_CORNER_RADIUS
const MIN_SIZE = 2 * CORNER       // DEFAULT_FIGURE_MIN_NODE_SIZE
const CONNECTOR_SIZE = 10
const MACRO_CORNER = 8
const LABEL_PAD_X = 10            // simple state label and superstate title: from(LEFT 10, TOP 8).to(RIGHT 10, BOTTOM 8)
const LABEL_PAD_Y = 8
const EMPTY_TITLE = 10            // addEmptyStateLabel
const BLOCK_PAD_X = 8             // declaration/action containers: from(LEFT 8, TOP -4).to(RIGHT 8, BOTTOM 6)
const BLOCK_PAD_TOP = -4
const BLOCK_PAD_BOTTOM = 6
const INDENT = 10
const REGION_LABEL_X = 16.5
const REGION_LABEL_Y = 1
const REGION_HEADER = 20
const REGION_PAD = 10
const EDGE_LABEL_PAD = 2
const DEFAULT_LABEL_WIDTH = 200   // LabelShorteningHook.SHORTEN_LABEL_WIDTH
const SOFTWRAP_FUZZINESS = 0.3

// ----- ELK -------------------------------------------------------------------------------------------
//
// This module never loads ELK itself: the caller passes an instance (`options.elk`). `layoutChart` in
// ./index.ts supplies elkjs's bundled build (1.4 MB) when none is given, for Node and build-time rendering;
// the playground imports this module directly with a Web Worker behind elk-api, so its bundle never contains
// (or fetches) the bundled build.

const opt = (o: Record<string, string | number | boolean | undefined>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k.startsWith('org.') ? k : `org.eclipse.elk.${k}`] = String(v)
    return out
}
const padding = (top: number, right: number, bottom: number, left: number) => `[top=${r2(top)},left=${r2(left)},bottom=${r2(bottom)},right=${r2(right)}]`

/** StateSynthesis.configureLayout */
const STATE_LAYOUT = opt({
    algorithm: 'org.eclipse.elk.rectpacking',
    expandNodes: true,
    'rectpacking.whiteSpaceElimination.strategy': 'EQUAL_BETWEEN_STRUCTURES',
    omitNodeMicroLayout: true,
    'spacing.nodeNode': 5,
})

/** ControlflowRegionSynthesis (KLay layered branch) + ModelOrderHook (tie-breaker) + LabelPlacementSideHook. */
const REGION_LAYOUT = opt({
    algorithm: 'org.eclipse.elk.layered',
    contentAlignment: 'V_TOP H_CENTER',
    'layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'layered.edgeLabels.centerLabelPlacementStrategy': 'TAIL_LAYER',
    'nodeSize.constraints': 'MINIMUM_SIZE',
    'spacing.nodeSelfLoop': 18,
    edgeRouting: 'SPLINES',
    separateConnectedComponents: false,
    'layered.cycleBreaking.strategy': 'MODEL_ORDER',
    'layered.considerModelOrder.strategy': 'PREFER_EDGES',
    'layered.considerModelOrder.crossingCounterPortInfluence': 0.01,
    'layered.considerModelOrder.crossingCounterNodeInfluence': 0.01,
})

const LABEL_LAYOUT = opt({ 'edgeLabels.inline': true, 'edgeLabels.placement': 'CENTER' })

// ----- Synthesis model (what is drawn, with sizes; positions come from ELK) -----------------------------

interface VLine {
    role: TextRole
    style: TextStyle
    runs: TextRun[]
    width: number
    indent: number
    ids?: string[]
}

interface VState {
    ast: State
    id: string
    shape: StateShape
    initial: boolean
    final: boolean
    reference: boolean
    lineWidth: number
    radius: number
    finalInset: number
    /** Title/name and content rows (relative to the inner figure's top-left; y = baseline). */
    lines: { line: VLine; y: number; align: 'centre' | 'left' }[]
    regions: VRegion[]
    /** Fixed size (simple states, superstates without regions) or minimum size. */
    width: number
    height: number
    /** Insets of the child area (superstates with regions). */
    pad?: { top: number; right: number; bottom: number; left: number }
    comments: VComment[]
}

interface VRegion {
    ast: Region
    id: string
    dataflow: boolean
    collapsed: boolean
    empty?: boolean
    method?: 'implemented' | 'abstract'
    label?: VLine
    lines: { line: VLine; y: number }[]
    states: VState[]
    edges: VEdge[]
    direction: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP'
    pad: { top: number; right: number; bottom: number; left: number }
    minWidth: number
    minHeight: number
    priority: number
    circuit?: CircuitBuild
    comments: VComment[]
}

interface VEdge {
    ast: Transition
    id: string
    source: string
    target: string
    immediate: boolean
    lines: VLine[]
    labelWidth: number
    labelHeight: number
    /** TransitionSynthesis: each doc comment of the transition as an extra label, in front of the main one. */
    comments: { id: string; lines: VLine[]; width: number; height: number }[]
}

interface VComment {
    id: string
    lines: VLine[]
    width: number
    height: number
    /** Element the comment documents (a state in the same region graph), if any. */
    attachTo?: string
}

interface Ctx {
    measure: TextMeasurer
    format: FormatContext
    userLabels: boolean
    comments: boolean
    declarations: boolean
    actions: boolean
    labelWidth: number
    collapsed: Set<string>
    direction: LayoutDirection
    globalDirection?: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP'
    circuit: boolean
    chartOf: (name: string) => State | undefined
    references: 'collapsed' | 'expanded' | Set<string>
    /** Charts being expanded (guards against a chart that references itself). */
    expanding: string[]
    /** `@diagram[initiallycollapseregions] true` */
    collapseAll: boolean
}

function makeLine(ctx: Ctx, role: TextRole, style: TextStyle, segments: TextSegment[], indent = 0, ids?: string[]): VLine {
    const runs: TextRun[] = []
    let dx = 0
    for (const seg of segments) {
        if (!seg.text) continue
        const bold = style.bold || seg.format === 'keyword'
        const width = ctx.measure(seg.text, { ...style, bold })
        const text = seg.text.replace(/\s+$/, '')
        if (text) runs.push({ text, dx: r2(dx), width: r2(ctx.measure(text, { ...style, bold })), format: seg.format })
        dx += width
    }
    const last = runs[runs.length - 1]
    return { role, style, runs, width: last ? last.dx + last.width : 0, indent, ids }
}

function plainLine(ctx: Ctx, role: TextRole, style: TextStyle, text: string): VLine {
    // Leading spaces (indentation of continued effect lines) become an offset.
    const lead = /^ */.exec(text)![0]
    const offset = lead ? ctx.measure(lead, style) : 0
    const body = text.slice(lead.length).replace(/\s+$/, '')
    const width = body ? ctx.measure(body, style) : 0
    return { role, style, runs: body ? [{ text: body, dx: r2(offset), width: r2(width), format: 'text' }] : [], width: offset + width, indent: 0 }
}

/** KLighD's SoftWrappingLabelManager (approximately): wrap at spaces so lines stay within `target`, and
 *  pull a short remainder (< fuzziness × target) back onto the previous line. */
function softWrap(ctx: Ctx, text: string, style: TextStyle, target: number): string[] {
    if (target <= 0 || ctx.measure(text, style) <= target) return [text]
    const lead = /^ */.exec(text)![0]
    const words = text.slice(lead.length).split(' ').filter(w => w.length > 0)
    const width = (s: string) => ctx.measure(s, style)
    const limit = Math.max(target, ...words.map(width))
    const lines: string[] = []
    let i = 0
    while (i < words.length) {
        let line = (lines.length === 0 ? lead : '') + words[i++]
        while (i < words.length && width(line + ' ' + words[i]) <= limit) line += ' ' + words[i++]
        const rest = words.slice(i).join(' ')
        if (rest && width(rest) < limit * SOFTWRAP_FUZZINESS && width(line + ' ' + rest) <= limit * (1 + SOFTWRAP_FUZZINESS)) {
            line += ' ' + rest
            i = words.length
        }
        lines.push(line)
    }
    return lines
}

function hasAnnotation(annotations: Annotation[] | undefined, name: string): boolean {
    return !!annotations?.some(a => a.name.toLowerCase() === name.toLowerCase())
}

function directionAnnotation(annotations: Annotation[] | undefined): 'RIGHT' | 'DOWN' | 'LEFT' | 'UP' | undefined {
    for (const a of annotations ?? []) {
        if (a.name !== 'layout') continue
        const key = (a.type ?? a.values[0] ?? '').toLowerCase()
        const value = (a.type ? a.values[0] : a.values[1])?.toUpperCase()
        if (/(^|\.)direction$/.test(key) && (value === 'RIGHT' || value === 'DOWN' || value === 'LEFT' || value === 'UP')) return value
    }
    return undefined
}

function alternating(annotations: Annotation[] | undefined): boolean | undefined {
    for (const a of [...(annotations ?? [])].reverse()) {
        const n = a.name.toLowerCase()
        if (n === 'hvlayout') return true
        if (n === 'vhlayout') return false
    }
    return undefined
}

/** LayoutHook.setDepthDirection */
function depthDirection(isHV: boolean, depth: number): 'RIGHT' | 'DOWN' {
    return isHV !== (depth % 2 === 0) ? 'DOWN' : 'RIGHT'
}

/** KIELER's StateSynthesis.isMacroState */
function isMacro(s: State): boolean {
    return s.regions.some(r => (r.regionType === 'controlflow' && r.states.length > 0) || r.regionType === 'dataflow')
        || s.actions.length > 0 || s.declarations.length > 0 || !!s.reference || !!s.baseStates?.length
}

function hasChildArea(s: State): boolean {
    return s.regions.some(r => (r.regionType === 'controlflow' && r.states.length > 0) || r.regionType === 'dataflow') || !!s.reference
        || s.declarations.some(d => d.declKind === 'method')
}

interface HV { isHV: boolean; depth: number }

function synthState(ctx: Ctx, s: State, hv: HV): VState {
    const shape: StateShape = s.isRoot ? 'root' : s.connector ? 'connector' : isMacro(s) ? 'superstate' : 'simple'
    const initial = s.initial && !s.isRoot
    let lineWidth = initial ? 3 : 1
    // StateStyles.setFinalStyle: a second border, `offset` inside.
    let finalInset = s.final && shape !== 'connector' ? lineWidth + (lineWidth === 1 ? 2 : 1) : 0
    // StateStyles.setViolationStyle: a violation state that cannot be left gets a double, 2 px border.
    if (s.violation && shape !== 'connector' && !s.final && s.transitions.every(t => t.target === s.id)) {
        finalInset = lineWidth + (lineWidth === 1 ? 3 : 1)
        lineWidth = 2
    }
    const v: VState = {
        ast: s, id: s.id, shape, initial, final: s.final, reference: !!s.reference, lineWidth,
        radius: shape === 'simple' ? CORNER : MACRO_CORNER, finalInset, lines: [], regions: [], width: 0, height: 0, comments: [],
    }
    // CommentSynthesis: a comment node next to the state, joined to it by an edge (laid out as an ELK comment box),
    // one per doc comment. The root's comments are placed in layoutChart.
    if (ctx.comments && !s.isRoot) docComments(s).forEach((text, i) => v.comments.push(synthComment(ctx, commentId(s.id, i), text, s.id)))
    if (shape === 'connector') {
        v.width = v.height = CONNECTOR_SIZE
        v.radius = 7
        return v
    }
    const nameMetrics = lineMetrics(STATE_LABEL)
    if (shape === 'simple') {
        const name = stateDisplayName(s, ctx.format)
        const line = makeLine(ctx, 'state-label', STATE_LABEL, [{ text: name, format: 'text' }])
        const inner = { w: Math.max(MIN_SIZE, line.width + 2 * LABEL_PAD_X), h: Math.max(MIN_SIZE, nameMetrics.lineHeight + 2 * LABEL_PAD_Y) }
        v.width = inner.w + 2 * finalInset
        v.height = inner.h + 2 * finalInset
        v.radius = CORNER + finalInset
        // An empty label (`state S ""`) leaves the state blank (addEmptyStateLabel).
        if (name) v.lines.push({ line, y: finalInset + (inner.h - nameMetrics.lineHeight) / 2 + nameMetrics.baseline, align: 'centre' })
        return v
    }

    // Superstate (macro state) or the root: rows in a one-column grid.
    const titleMetrics = lineMetrics(TITLE)
    const declMetrics = lineMetrics(DECLARATION)
    let y = 0
    let minWidth = 0
    const titleSegments = stateTitleSegments(s, ctx.format)
    if (titleSegments.some(t => t.text.trim())) {
        const line = makeLine(ctx, 'title', TITLE, titleSegments)
        v.lines.push({ line, y: y + LABEL_PAD_Y + titleMetrics.baseline, align: 'centre' })
        y += LABEL_PAD_Y + titleMetrics.lineHeight + LABEL_PAD_Y
        minWidth = Math.max(minWidth, line.width + 2 * LABEL_PAD_X)
    } else {
        y += EMPTY_TITLE
    }
    const block = (lines: VLine[]) => {
        if (!lines.length) return
        y += BLOCK_PAD_TOP
        for (const line of lines) {
            v.lines.push({ line, y: y + declMetrics.baseline, align: 'left' })
            y += declMetrics.lineHeight
            minWidth = Math.max(minWidth, line.width + line.indent * INDENT + 2 * BLOCK_PAD_X)
        }
        y += BLOCK_PAD_BOTTOM
    }
    if (ctx.declarations) {
        const lines: VLine[] = []
        for (const d of s.declarations) {
            // KIELER draws methods as (collapsed) method regions, not as declaration lines.
            if (hasAnnotation(d.annotations, 'hide') || d.declKind === 'method') continue
            for (const dl of declarationLines(d, ctx.format)) {
                lines.push(makeLine(ctx, 'declaration', DECLARATION, mergeComponents(dl.components), dl.indent, d.valuedObjects.map(vo => vo.id)))
            }
        }
        block(lines)
    }
    if (ctx.actions) {
        block(s.actions.filter(a => !hasAnnotation(a.annotations, 'hide'))
            .map(a => makeLine(ctx, 'action', DECLARATION, actionSegments(a, { ...ctx.format, userLabels: ctx.userLabels }), 0, [a.id])))
    }

    if (hasChildArea(s)) {
        // StateStyles.addRegionsArea: from(LEFT s, TOP -4).to(RIGHT s, BOTTOM s), s = 9 for initial states.
        const side = (initial ? 9 : 7) + finalInset
        v.pad = { top: y - 4 + finalInset, right: side, bottom: side, left: side }
        const regionDepth = hv.depth
        // StateSynthesis: methods come first among the state's children, then the regions.
        for (const d of s.declarations) if (d.declKind === 'method' && !hasAnnotation(d.annotations, 'hide')) v.regions.push(methodRegion(ctx, d, s))
        for (const region of s.regions) {
            if (hasAnnotation(region.annotations, 'hide')) continue
            v.regions.push(synthRegion(ctx, region, s, { isHV: hv.isHV, depth: regionDepth }))
        }
        if (s.reference && v.regions.length === 0) v.regions.push(referenceRegion(ctx, s, { isHV: hv.isHV, depth: regionDepth }))
        v.width = Math.max(MIN_SIZE, minWidth + 2 * finalInset)
        v.height = Math.max(MIN_SIZE, v.pad.top + 20 + v.pad.bottom)
    } else {
        v.width = Math.max(MIN_SIZE, minWidth + 2 * finalInset)
        v.height = Math.max(MIN_SIZE, y + 2 * finalInset)
    }
    for (const entry of v.lines) entry.y += finalInset
    v.radius = MACRO_CORNER + finalInset
    return v
}

/** The id prefix of a referenced chart drawn inside a reference state (`references: 'expanded'`). */
export const REFERENCE_SEPARATOR = '/'

/** A copy of a chart whose element ids are prefixed, so it can be drawn inside a reference state. */
function prefixedCopy(chart: State, prefix: string): State {
    const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit)
        if (!value || typeof value !== 'object') return value
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) out[k] = k === 'span' || k === 'nameSpan' || k === 'targetSpan' ? v : visit(v)
        if (typeof obj.id === 'string' && obj.id) out.id = prefix + obj.id
        if (obj.kind === 'transition') {
            if (typeof obj.source === 'string') out.source = prefix + obj.source
            if (typeof obj.target === 'string') out.target = prefix + obj.target
        }
        if (obj.kind === 'ref' && typeof obj.decl === 'string') out.decl = prefix + obj.decl
        return out
    }
    return { ...(visit(chart) as State), isRoot: false, initial: false, final: false }
}

/** ControlflowRegionSynthesis.createReferenceRegion: the body of a reference state, collapsed as KIELER
 *  shows it at first, or with the referenced chart inside (KIELER's ReferenceExpandAction). */
function referenceRegion(ctx: Ctx, s: State, hv: HV): VRegion {
    const region: VRegion = {
        ast: { kind: 'region', id: `${s.id}:ref`, regionType: 'controlflow', implicit: true, annotations: [], declarations: [], actions: [], states: [], equations: [], span: s.span } as Region,
        id: `${s.id}:ref`, dataflow: false, collapsed: true, lines: [], states: [], edges: [], direction: 'RIGHT',
        pad: { top: REGION_PAD, right: REGION_PAD, bottom: REGION_PAD, left: REGION_PAD }, minWidth: 20, minHeight: 20, priority: 1, comments: [],
    }
    const target = s.reference ? ctx.chartOf(s.reference.target) : undefined
    const expand = ctx.references === 'expanded' || (ctx.references instanceof Set && ctx.references.has(s.id))
    if (target && expand && !ctx.expanding.includes(target.name) && ctx.expanding.length < 4) {
        ctx.expanding.push(target.name)
        try {
            const inner = prefixedCopy(target, s.id + REFERENCE_SEPARATOR)
            region.ast = { ...region.ast, states: [inner] }
            region.collapsed = false
            region.direction = ctx.direction === 'down' ? 'DOWN' : ctx.direction === 'right' ? 'RIGHT' : depthDirection(hv.isHV, hv.depth)
            region.states.push(synthState(ctx, inner, { isHV: hv.isHV, depth: hv.depth + 1 }))
        } finally {
            ctx.expanding.pop()
        }
    }
    return region
}

/** MethodSynthesis: a method as a grey region, collapsed (KIELER shows its SCG when expanded), labelled with
 *  its signature; dashed when it has no body. */
function methodRegion(ctx: Ctx, d: Declaration, s: State): VRegion {
    const label = makeLine(ctx, 'region-label', REGION_LABEL, mergeComponents(declarationLines(d, ctx.format)[0]?.components ?? []))
    const id = d.valuedObjects[0]?.id || `${s.id}$${d.valuedObjects[0]?.name ?? 'method'}`
    return {
        ast: { kind: 'region', id, name: d.valuedObjects[0]?.name, regionType: 'controlflow', implicit: false, annotations: d.annotations, declarations: [], actions: [], states: [], equations: [], span: d.span } as Region,
        // KIELER lays the (hidden) SCG of a method out top to bottom.
        id, dataflow: false, collapsed: true, method: d.body ? 'implemented' : 'abstract', label, lines: [], states: [], edges: [], direction: 'DOWN',
        pad: { top: REGION_HEADER, right: 4, bottom: 0, left: 4 }, minWidth: label.width + REGION_LABEL_X + 4,
        minHeight: lineMetrics(REGION_LABEL).lineHeight + 4, priority: 0, comments: [],
    }
}

/** The doc comments of a state, region or transition (KIELER's CommentAnnotations), in source order. */
function docComments(e: { annotations: Annotation[]; doc?: string }): string[] {
    const texts = e.annotations.filter(a => a.name === 'comment' && a.values[0] !== undefined).map(a => a.values[0])
    return texts.length ? texts : e.doc !== undefined ? [e.doc] : []
}

/** `<element id>#doc` for the first doc comment, `#doc1`, `#doc2`, ... for further ones. */
const commentId = (id: string, i: number) => `${id}#doc${i ? i : ''}`

/** CommentSynthesis + CommentStyles: the comment's text as written (KIELER does not wrap it; blank lines stay),
 *  4 px inside a box of at least 16 × 16. */
function synthComment(ctx: Ctx, id: string, text: string, attachTo?: string): VComment {
    const metrics = lineMetrics(COMMENT)
    const lines = text.split('\n').map(l => plainLine(ctx, 'comment', COMMENT, l.trim()))
    const width = Math.max(COMMENT_MIN, Math.max(0, ...lines.map(l => l.width)) + 2 * COMMENT_PAD)
    const height = Math.max(COMMENT_MIN, lines.length * metrics.lineHeight + 2 * COMMENT_PAD)
    return { id, lines, width, height, attachTo }
}

function synthRegion(ctx: Ctx, r: Region, parent: State, hv: HV): VRegion {
    const labelSegments = r.reference
        ? [{ text: `${r.label ?? r.name ? `${r.label ?? r.name}@` : ''}${r.reference.target}${r.reference.parameters.length ? `(${r.reference.parameters.map(p => formatExpression(p.expression, ctx.format)).join(', ')})` : ''}`, format: 'text' as const }]
        : regionLabelSegments(r, ctx.format)
    // ControlflowRegionSynthesis: a referencing region (`region R is Other(...)`) is drawn collapsed, labelled
    // `R@Other(...)`; a region without states is a bare frame, without label or button.
    const collapsed = (ctx.collapsed.has(r.id) || hasAnnotation(r.annotations, 'collapse') || !!r.reference
        || (ctx.collapseAll && !hasAnnotation(r.annotations, 'expand'))) && !(r.regionType === 'controlflow' && r.states.length === 0 && !r.reference)
    const empty = r.regionType === 'controlflow' && r.states.length === 0 && !r.reference && !collapsed
    const label = labelSegments.length && !empty ? makeLine(ctx, 'region-label', REGION_LABEL, labelSegments) : undefined
    const index = parent.regions.indexOf(r)
    const v: VRegion = {
        ast: r, id: r.id, dataflow: r.regionType === 'dataflow', collapsed, label, lines: [], states: [], edges: [],
        direction: 'RIGHT', pad: { top: label ? REGION_HEADER : REGION_PAD, right: REGION_PAD, bottom: REGION_PAD, left: REGION_PAD },
        minWidth: label ? label.width + REGION_LABEL_X : 20, minHeight: 20,
        // LayoutHook.processRegion: earlier regions get a higher priority.
        priority: parent.regions.length - index, comments: [], empty,
    }
    // Direction: an explicit @layout[direction] wins, then a chart-wide one, then HV/VH alternation.
    const alt = alternating(r.annotations)
    const local: HV = alt !== undefined ? { isHV: alt, depth: 0 } : hv
    v.direction = directionAnnotation(r.annotations) ?? ctx.globalDirection ?? (
        ctx.direction === 'down' ? 'DOWN' : ctx.direction === 'right' ? 'RIGHT' : depthDirection(local.isHV, local.depth))
    if (collapsed) {
        v.pad = { top: label ? REGION_HEADER : REGION_PAD, right: 4, bottom: 0, left: 4 }
        v.minHeight = label ? lineMetrics(REGION_LABEL).lineHeight + 4 : 20
        return v
    }
    const declMetrics = lineMetrics(DECLARATION)
    // Region-level declarations and actions (addStatesAndDeclarationsAndActionsArea, vertical variant).
    const extra: VLine[] = []
    if (ctx.declarations) for (const d of r.declarations) for (const dl of declarationLines(d, ctx.format)) extra.push(makeLine(ctx, 'declaration', DECLARATION, mergeComponents(dl.components), dl.indent, d.valuedObjects.map(vo => vo.id)))
    if (ctx.actions) for (const a of r.actions) extra.push(makeLine(ctx, 'action', DECLARATION, actionSegments(a, { ...ctx.format, userLabels: ctx.userLabels }), 0, [a.id]))
    if (extra.length) {
        let y = label ? REGION_HEADER : 6
        for (const line of extra) {
            v.lines.push({ line, y: y + declMetrics.baseline })
            y += declMetrics.lineHeight
            v.minWidth = Math.max(v.minWidth, line.width + line.indent * INDENT + 3 + 8)
        }
        v.pad.top = y + REGION_PAD
    }
    if (v.dataflow) {
        if (ctx.circuit) {
            v.circuit = buildCircuit(r, { measure: ctx.measure, format: ctx.format, chartOf: ctx.chartOf })
        } else {
            const metrics = lineMetrics(EQUATION)
            let y = v.pad.top
            for (const eq of r.equations) {
                const line = plainLine(ctx, 'equation', EQUATION, formatEquation(eq, ctx.format))
                v.lines.push({ line, y: y + metrics.baseline })
                y += metrics.lineHeight
                v.minWidth = Math.max(v.minWidth, line.width + 2 * REGION_PAD)
            }
            v.minHeight = Math.max(v.minHeight, y + REGION_PAD)
        }
        return v
    }
    const depth: HV = { isHV: local.isHV, depth: local.depth + 1 }
    for (const s of r.states) {
        if (hasAnnotation(s.annotations, 'hide')) continue
        v.states.push(synthState(ctx, s, alternating(s.annotations) !== undefined ? { isHV: alternating(s.annotations)!, depth: 0 } : depth))
    }
    const visible = new Set(v.states.map(s => s.id))
    for (const s of r.states) {
        if (!visible.has(s.id)) continue
        for (const t of s.transitions) {
            if (!t.target || !visible.has(t.target) || hasAnnotation(t.annotations, 'hide')) continue
            v.edges.push(synthEdge(ctx, t, s))
        }
    }
    if (ctx.comments) {
        // ControlflowRegionSynthesis: the region's own comments are nodes of its graph, without an edge.
        docComments(r).forEach((text, i) => v.comments.push(synthComment(ctx, commentId(r.id, i), text)))
        for (const s of v.states) v.comments.push(...s.comments)
    }
    return v
}

function synthEdge(ctx: Ctx, t: Transition, source: State): VEdge {
    const raw = transitionLabelLines(t, source.transitions.length, { ...ctx.format, userLabels: ctx.userLabels })
    // SemanticSoftWrappingLabelManager: one line per semantic part, each soft-wrapped.
    const text = raw.join('\n').trim() ? raw.flatMap(line => softWrap(ctx, line, EDGE_LABEL, ctx.labelWidth)) : []
    const lines = text.map(l => plainLine(ctx, 'edge-label', EDGE_LABEL, l))
    const metrics = lineMetrics(EDGE_LABEL)
    const size = (ls: VLine[]) => ({
        width: ls.length ? Math.max(...ls.map(l => l.width)) + 2 * EDGE_LABEL_PAD : 0,
        height: ls.length ? ls.length * metrics.lineHeight + 2 * EDGE_LABEL_PAD + 1 : 0,
    })
    // TransitionSynthesis (SHOW_COMMENTS): a label per doc comment. KIELER asks for 7 pt text on a comment-coloured
    // background, but KLighD's edge label decoration gives these labels the transition label's style (11 pt bold),
    // and that is what its diagrams show; the label manager soft-wraps them like any label.
    const comments = ctx.comments
        ? docComments(t).map((text, i) => {
            const ls = text.split('\n').flatMap(line => softWrap(ctx, line.trim(), EDGE_LABEL, ctx.labelWidth)).map(l => plainLine(ctx, 'edge-label', EDGE_LABEL, l))
            return { id: commentId(t.id, i), lines: ls, ...size(ls) }
        }).filter(c => c.lines.length)
        : []
    const main = size(lines)
    return {
        ast: t, id: t.id, source: source.id, target: t.target!, immediate: isImplicitlyImmediate(t, source), lines,
        labelWidth: main.width, labelHeight: main.height, comments,
    }
}

// ----- ELK graph -------------------------------------------------------------------------------------

/** `links`: the drawn transitions of the state's region that leave or enter the state (`loops`: to itself, `others`:
 *  to or from another state). `twoSides`: states whose self-loops go on two sides only (crowdedLoops). */
function elkState(v: VState, isFirstInRegion: boolean, twoSides: ReadonlySet<string>, links: { loops: number; others: number } = { loops: 0, others: 0 }): ElkNode {
    const node: ElkNode = { id: v.id, layoutOptions: { ...STATE_LAYOUT } }
    if (v.initial && isFirstInRegion) node.layoutOptions!['org.eclipse.elk.layered.layering.layerConstraint'] = 'FIRST'
    // Several self-loops: ELK stacks them on one side of the state, each inside the next with its label on top, but
    // makes each loop only as wide as its ports, so an outer loop runs through the labels of the loops inside it
    // (KIELER's diagrams show this tangle); side by side on one side they are so narrow that a label is hard to match
    // with its loop. They are spread over the two sides across the flow (above and below in a left-to-right region),
    // or over all four when no other transition needs a side (one loop to a side for up to four), each with its
    // label next to it; crowdedLoops catches the four-side layouts whose labels collide.
    if (links.loops > 1) {
        node.layoutOptions!['org.eclipse.elk.layered.edgeRouting.selfLoopDistribution'] = links.others || twoSides.has(v.id) ? 'NORTH_SOUTH' : 'EQUALLY'
        node.layoutOptions!['org.eclipse.elk.layered.edgeRouting.selfLoopOrdering'] = 'SEQUENCED'
    }
    if (v.regions.length && v.pad) {
        node.children = v.regions.map(r => elkRegion(r, twoSides))
        Object.assign(node.layoutOptions!, opt({
            padding: padding(v.pad.top, v.pad.right, v.pad.bottom, v.pad.left),
            'nodeSize.constraints': 'MINIMUM_SIZE',
            'nodeSize.minimum': `(${r2(v.width)},${r2(v.height)})`,
        }))
    } else {
        node.width = r2(v.width)
        node.height = r2(v.height)
    }
    return node
}

function elkRegion(v: VRegion, twoSides: ReadonlySet<string>): ElkNode {
    const node: ElkNode = {
        id: v.id,
        layoutOptions: {
            ...REGION_LAYOUT,
            ...opt({
                direction: v.direction,
                padding: padding(v.pad.top, v.pad.right, v.pad.bottom, v.pad.left),
                'nodeSize.minimum': `(${r2(v.minWidth)},${r2(v.minHeight)})`,
                priority: v.priority,
            }),
        },
        children: [],
        edges: [],
    }
    if (v.collapsed || (v.empty && !v.circuit)) {
        // No children: ELK would not size the node before packing it, so give it its size.
        node.width = r2(v.minWidth)
        node.height = r2(Math.max(v.minHeight, v.pad.top + v.pad.bottom))
        delete node.children
        delete node.edges
        return node
    }
    if (v.circuit) {
        node.children = v.circuit.nodes
        node.edges = v.circuit.edges
        Object.assign(node.layoutOptions!, v.circuit.layoutOptions)
        return node
    }
    const first = v.ast.states[0]?.id
    const links = (id: string) => ({
        loops: v.edges.filter(e => e.source === id && e.target === id).length,
        others: v.edges.filter(e => (e.source === id) !== (e.target === id)).length,
    })
    node.children = v.states.map(s => elkState(s, s.id === first, twoSides, links(s.id)))
    node.edges = v.edges.map(e => {
        const edge: ElkExtendedEdge = {
            id: e.id, sources: [e.source], targets: [e.target],
            layoutOptions: opt({ 'spacing.edgeLabel': 3, 'layered.priority.direction': e.immediate ? 6 : undefined }),
        }
        const text = (ls: VLine[]) => ls.map(l => l.runs.map(r => r.text).join(' ')).join('\n')
        const labels: ElkLabel[] = e.comments.map(c => ({ id: c.id, text: text(c.lines), width: r2(c.width), height: r2(c.height), layoutOptions: { ...LABEL_LAYOUT } }))
        if (e.lines.length) labels.push({ id: `${e.id}#label`, text: text(e.lines), width: r2(e.labelWidth), height: r2(e.labelHeight), layoutOptions: { ...LABEL_LAYOUT } })
        if (labels.length) edge.labels = labels
        return edge
    })
    for (const c of v.comments) {
        node.children.push(commentNode(c))
        if (c.attachTo) node.edges.push(commentEdge(c))
    }
    return node
}

/** A comment box for ELK (CommentSynthesis: `CoreOptions.COMMENT_BOX`). */
function commentNode(c: VComment): ElkNode {
    return { id: c.id, width: r2(c.width), height: r2(c.height), layoutOptions: opt({ commentBox: true }) }
}

/** CommentSynthesis: the edge from the documented state to its comment box. */
function commentEdge(c: VComment): ElkExtendedEdge {
    return { id: `${c.id}#edge`, sources: [c.attachTo!], targets: [c.id] }
}

/** The states whose self-loops, spread over all four sides, came back with a label over another label: ELK places a
 *  side loop's label beside the state without looking at the label of the loop below it (Fan's wide labels). They
 *  are laid out again with their loops on two sides. */
function crowdedLoops(node: ElkNode, out = new Set<string>()): Set<string> {
    const boxes: { state?: string; x: number; y: number; width: number; height: number }[] = []
    for (const e of (node.edges ?? []) as ElkExtendedEdge[]) {
        const loop = e.sources[0] === e.targets[0] ? e.sources[0] : undefined
        for (const l of e.labels ?? []) boxes.push({ state: loop, x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 })
    }
    // Only loops on four sides can move (those on two already are).
    const four = new Set((node.children ?? []).filter(c => c.layoutOptions?.['org.eclipse.elk.layered.edgeRouting.selfLoopDistribution'] === 'EQUALLY').map(c => c.id))
    const apart = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
        a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j]
            if (!apart(a, b)) for (const st of [a.state, b.state]) if (st && four.has(st)) out.add(st)
        }
    }
    for (const c of node.children ?? []) crowdedLoops(c, out)
    return out
}

// ----- Read back -------------------------------------------------------------------------------------

function textLine(line: VLine, x: number, y: number): TextLine {
    const out: TextLine = { x: r2(x), y: r2(y), width: r2(line.width), size: line.style.size, runs: line.runs, role: line.role }
    if (line.style.bold) out.bold = true
    if (line.style.mono) out.mono = true
    if (line.ids?.length) out.ids = line.ids
    return out
}

function readState(v: VState, n: ElkNode, ox: number, oy: number): StateLayout {
    const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0)
    const width = n.width ?? v.width, height = n.height ?? v.height
    const lines: TextLine[] = v.lines.map(({ line, y: ly, align }) => {
        if (align === 'centre') {
            const innerX = x + v.finalInset + (v.shape === 'simple' ? 0 : LABEL_PAD_X)
            const innerW = width - 2 * v.finalInset - (v.shape === 'simple' ? 0 : 2 * LABEL_PAD_X)
            return textLine(line, innerX + (innerW - line.width) / 2, y + ly)
        }
        return textLine(line, x + v.finalInset + BLOCK_PAD_X + line.indent * INDENT, y + ly)
    })
    const regions: RegionLayout[] = []
    const byId = new Map((n.children ?? []).map(c => [c.id, c]))
    for (const r of v.regions) {
        const rn = byId.get(r.id)
        if (rn) regions.push(readRegion(r, rn, x, y))
    }
    const out: StateLayout = {
        kind: 'state', id: v.id, name: v.ast.name, shape: v.shape, initial: v.initial, final: v.final,
        violation: v.ast.violation, reference: v.reference,
        x: r2(x), y: r2(y), width: r2(width), height: r2(height), radius: v.radius, lineWidth: v.lineWidth,
        lines, regions, comments: [], span: v.ast.span,
    }
    if (v.finalInset) out.finalInset = v.finalInset
    return out
}

function readComments(comments: VComment[], byId: Map<string, ElkNode>, edges: Map<string, ElkExtendedEdge>, x: number, y: number): CommentLayout[] {
    const out: CommentLayout[] = []
    const m = lineMetrics(COMMENT)
    for (const c of comments) {
        const cn = byId.get(c.id)
        if (!cn) continue
        const cx = x + (cn.x ?? 0), cy = y + (cn.y ?? 0)
        const comment: CommentLayout = {
            id: c.id, x: r2(cx), y: r2(cy), width: r2(cn.width ?? c.width), height: r2(cn.height ?? c.height),
            lines: c.lines.map((l, i) => textLine(l, cx + COMMENT_PAD, cy + COMMENT_PAD + i * m.lineHeight + m.baseline)),
        }
        const section = edges.get(`${c.id}#edge`)?.sections?.[0]
        if (section) comment.points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(p => ({ x: r2(x + p.x), y: r2(y + p.y) }))
        out.push(comment)
    }
    return out
}

function labelDirection(points: Point[], box: Box): LabelDirection {
    const poly = flatten(points)
    const { tangent } = nearest(poly, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    if (Math.abs(tangent.x) >= Math.abs(tangent.y)) return tangent.x >= 0 ? 'right' : 'left'
    return tangent.y >= 0 ? 'down' : 'up'
}

function readRegion(v: VRegion, n: ElkNode, ox: number, oy: number): RegionLayout {
    const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0)
    const out: RegionLayout = {
        kind: 'region', id: v.id, name: v.ast.name, dataflow: v.dataflow, collapsed: v.collapsed,
        final: !!v.ast.final, abort: !!v.ast.abort, override: !!v.ast.override, direction: v.direction,
        ...(v.ast.reference ? { reference: true } : {}),
        ...(v.method ? { method: v.method } : {}),
        ...(v.empty ? { empty: true } : {}),
        x: r2(x), y: r2(y), width: r2(n.width ?? v.minWidth), height: r2(n.height ?? v.minHeight),
        lines: v.lines.map(({ line, y: ly }) => textLine(line, x + (line.role === 'equation' ? REGION_PAD : 3 + line.indent * INDENT), y + ly)),
        states: [], transitions: [], comments: [], span: v.ast.span,
    }
    if (v.label) {
        const m = lineMetrics(REGION_LABEL)
        out.label = textLine(v.label, x + REGION_LABEL_X, y + REGION_LABEL_Y + m.baseline)
    }
    const byId = new Map((n.children ?? []).map(c => [c.id, c]))
    if (v.circuit) {
        out.circuit = v.circuit.read(n, x, y)
        return out
    }
    for (const s of v.states) {
        const sn = byId.get(s.id)
        if (sn) out.states.push(readState(s, sn, x, y))
    }
    const edges = new Map((n.edges ?? []).map(e => [e.id, e]))
    for (const e of v.edges) {
        const en = edges.get(e.id)
        if (!en) continue
        const points: Point[] = []
        for (const section of en.sections ?? []) {
            if (!points.length) points.push(section.startPoint)
            points.push(...(section.bendPoints ?? []), section.endPoint)
        }
        const abs = points.map(p => ({ x: r2(x + p.x), y: r2(y + p.y) }))
        const t: TransitionLayout = {
            kind: 'transition', id: e.id, source: e.source, target: e.target, priority: e.ast.priority, points: abs,
            immediate: e.immediate, preemption: e.ast.preemption, span: e.ast.span,
        }
        if (e.ast.history && e.ast.history !== 'reset') t.history = e.ast.history
        if (e.ast.deferred) t.deferred = e.ast.deferred
        if (e.ast.nondeterministic) t.nondeterministic = true
        if (e.ast.probability !== undefined) t.probability = e.ast.probability
        const readLabel = (id: string, lines: VLine[], width: number, height: number): TransitionLabelLayout | undefined => {
            const label = en.labels?.find(l => l.id === id)
            if (!label || !lines.length) return undefined
            const box = { x: r2(x + (label.x ?? 0)), y: r2(y + (label.y ?? 0)), width: r2(label.width ?? width), height: r2(label.height ?? height) }
            const m = lineMetrics(EDGE_LABEL)
            const top = box.y + (box.height - lines.length * m.lineHeight) / 2
            return { ...box, lines: lines.map((l, i) => textLine(l, box.x + EDGE_LABEL_PAD, top + i * m.lineHeight + m.baseline)), direction: labelDirection(abs, box) }
        }
        const label = readLabel(`${e.id}#label`, e.lines, e.labelWidth, e.labelHeight)
        if (label) t.label = label
        const comments = e.comments.map(c => readLabel(c.id, c.lines, c.width, c.height)).filter((c): c is TransitionLabelLayout => !!c)
        if (comments.length) t.comments = comments
        out.transitions.push(t)
    }
    out.comments.push(...readComments(v.comments, byId, edges, x, y))
    return out
}

// ----- Entry point -----------------------------------------------------------------------------------

function referencesOption(value: LayoutOptions['references']): Ctx['references'] {
    if (value === undefined || value === 'collapsed') return 'collapsed'
    if (value === 'expanded') return 'expanded'
    return new Set(value)
}

/** Lays out a chart (a root state from `parse`/`compile`) in KIELER's notation. Deterministic: the same chart
 *  and options always give the same layout. */
/**
 * SynthesisAnnotationHook: `@diagram[<option>] <value>` (or `@diagram <option>` for true) on the chart sets a
 * synthesis option, matched by prefix of its name without spaces, case-insensitively, and wins over the
 * options passed in, as in KIELER. Supported: Comment Nodes, User Labels, Declarations, State Actions,
 * Initially Collapse Regions, Direction, Shadows.
 */
function diagramAnnotations(chart: State, options: LayoutOptions): LayoutOptions & { collapseAll?: boolean; shadows?: boolean } {
    const out: LayoutOptions & { collapseAll?: boolean; shadows?: boolean } = { ...options }
    const names: Record<string, (value: string) => void> = {
        commentnodes: v => (out.comments = bool(v) ?? out.comments),
        userlabels: v => (out.userLabels = bool(v) ?? out.userLabels),
        declarations: v => (out.declarations = bool(v) ?? out.declarations),
        stateactions: v => (out.actions = bool(v) ?? out.actions),
        initiallycollapseregions: v => (out.collapseAll = bool(v) ?? out.collapseAll),
        direction: v => {
            const d = v.toLowerCase()
            if (d === 'hv' || d === 'vh') out.direction = d.toUpperCase() as LayoutDirection
            else if (d === 'down' || d === 'right') out.direction = d
        },
        shadows: v => (out.shadows = bool(v) ?? out.shadows),
    }
    function bool(v: string): boolean | undefined {
        const l = v.toLowerCase()
        return ['true', 'on', 'checked'].includes(l) ? true : ['false', 'off', 'unchecked'].includes(l) ? false : undefined
    }
    for (const a of chart.annotations) {
        if (a.name.toLowerCase() !== 'diagram') continue
        const key = (a.type ?? a.values[0] ?? '').toLowerCase().replace(/\s+/g, '')
        const value = a.type !== undefined ? a.values[0] ?? '' : 'true'
        if (!key || !value) continue
        for (const [name, apply] of Object.entries(names)) if (name.startsWith(key)) apply(value)
    }
    return out
}

export async function layoutChart(chart: State, givenOptions: LayoutOptions = {}): Promise<DiagramLayout> {
    const options = diagramAnnotations(chart, givenOptions)
    const direction = options.direction ?? 'HV'
    const ctx: Ctx = {
        measure: options.measure ?? measureWithTable,
        format: options.format ?? createFormatContext(options.program ?? { charts: [chart], pragmas: [] }),
        userLabels: options.userLabels ?? true,
        // GeneralSynthesisOptions.SHOW_COMMENTS ("Comment Nodes") is on by default.
        comments: options.comments ?? true,
        declarations: options.declarations ?? true,
        actions: options.actions ?? true,
        labelWidth: options.labelWidth ?? DEFAULT_LABEL_WIDTH,
        collapsed: new Set(options.collapsed ?? []),
        direction,
        globalDirection: directionAnnotation(chart.annotations),
        circuit: options.dataflowCircuit ?? true,
        chartOf: name => options.program?.charts.find(c => c.name === name) ?? options.charts?.find(c => c.name === name),
        references: referencesOption(options.references),
        expanding: [chart.name],
        collapseAll: !!options.collapseAll,
    }
    const alt = alternating(chart.annotations)
    // LayoutHook: the diagram root has depth 1, the root state 2; regions share their state's depth.
    const hv: HV = alt !== undefined ? { isHV: alt, depth: 0 } : { isHV: direction !== 'VH', depth: 2 }
    const root = synthState(ctx, { ...chart, isRoot: true }, hv)
    // CommentSynthesis on the root: its comment boxes are nodes of the diagram's top level, which KLighD lays out
    // with ELK Layered (no algorithm set there; padding 0), so they sit above the root, joined to it by an edge.
    const rootComments = ctx.comments ? docComments(chart).map((text, i) => synthComment(ctx, commentId(chart.id, i), text, chart.id)) : []
    const graph = (twoSides: ReadonlySet<string>): ElkNode => ({
        id: '__diagram',
        layoutOptions: rootComments.length
            ? opt({ algorithm: 'org.eclipse.elk.layered', padding: padding(0, 0, 0, 0) })
            : opt({ algorithm: 'org.eclipse.elk.rectpacking', padding: padding(0, 0, 0, 0), omitNodeMicroLayout: true }),
        children: [elkState(root, false, twoSides), ...rootComments.map(commentNode)],
        edges: rootComments.map(commentEdge),
    })
    const elk = options.elk
    if (!elk) throw new Error('layoutChart needs an ELK instance (options.elk); src/diagram/index.ts supplies elkjs\'s bundled build')
    let result = await elk.layout(graph(new Set()))
    // Self-loops on four sides whose labels collide: once more, with those loops on two sides.
    const crowded = crowdedLoops(result)
    if (crowded.size) result = await elk.layout(graph(crowded))
    const rootNode = result.children![0]
    if (!rootComments.length) {
        rootNode.x = 0
        rootNode.y = 0
    }
    const layout = readState(root, rootNode, 0, 0)
    let width = layout.width
    let height = layout.height
    if (rootComments.length) {
        const byId = new Map((result.children ?? []).map(c => [c.id, c]))
        const edges = new Map((result.edges ?? []).map(e => [e.id, e as ElkExtendedEdge]))
        layout.comments.push(...readComments(rootComments, byId, edges, 0, 0))
        width = result.width ?? width
        height = result.height ?? height
    }
    const diagram: DiagramLayout = { version: 1, chart: chart.id, width: r2(width), height: r2(height), root: layout, direction }
    if (options.shadows === false) diagram.shadows = false
    return diagram
}

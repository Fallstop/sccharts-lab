// The diagram's data: options and the laid-out diagram that renderSvg draws. Plain JSON, so a layout can be
// computed in a Web Worker or at build time and cached.

import type { ElkNode } from 'elkjs/lib/elk-api'
import type { FormatContext, TextFormat } from '../engine/format'
import type { Program, Span, State } from '../engine/types'
import type { TextMeasurer } from './measure'

export interface Point {
    x: number
    y: number
}

export interface Box {
    x: number
    y: number
    width: number
    height: number
}

/** A run of text on a line, `dx` from the line's start. Keywords are bold and coloured. */
export interface TextRun {
    text: string
    dx: number
    width: number
    format: TextFormat
}

export type TextRole = 'title' | 'state-label' | 'declaration' | 'action' | 'region-label' | 'edge-label' | 'equation' | 'comment'

/** One line of text. Coordinates are absolute: `x` is the left end, `y` the baseline. */
export interface TextLine {
    x: number
    y: number
    width: number
    /** Font size in diagram units. */
    size: number
    /** The whole line is bold (state names, transition labels). Keyword runs are bold anyway. */
    bold?: boolean
    mono?: boolean
    runs: TextRun[]
    role: TextRole
    /** Model elements the line shows: the action's id, or the ids of a declaration's valued objects. */
    ids?: string[]
}

export type StateShape = 'root' | 'superstate' | 'simple' | 'connector'

export interface StateLayout extends Box {
    kind: 'state'
    id: string
    name: string
    shape: StateShape
    initial: boolean
    final: boolean
    violation: boolean
    /** `state S is Other(...)`. */
    reference: boolean
    /** Corner radius of the outer figure. */
    radius: number
    /** Border width of the outer figure: 1, or 3 for an initial state. */
    lineWidth: number
    /** Final states (and violation states that cannot be left): distance between the outer and the inner
     *  border. */
    finalInset?: number
    /** The name (simple states) or the title row and the declaration and action lines (superstates). */
    lines: TextLine[]
    regions: RegionLayout[]
    comments: CommentLayout[]
    span?: Span
}

export interface RegionLayout extends Box {
    kind: 'region'
    id: string
    name?: string
    dataflow: boolean
    /** Drawn as a closed box with only its label (`@collapse`, or the region of a reference state). */
    collapsed: boolean
    final: boolean
    abort: boolean
    override: boolean
    /** `region R is Other(...)`: drawn collapsed with KIELER's reference style. */
    reference?: boolean
    /** A control-flow region without states: KIELER draws a bare frame, without label or button. */
    empty?: boolean
    /** A method of the state, drawn as KIELER does: a collapsed grey region labelled with the signature (its
     *  id is the method's valued object id). 'abstract' when it has no body. */
    method?: 'implemented' | 'abstract'
    /** ELK layout direction of the region's states. */
    direction: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP'
    label?: TextLine
    /** Region-level declarations and actions; for a dataflow region drawn as a list, its equations. */
    lines: TextLine[]
    states: StateLayout[]
    transitions: TransitionLayout[]
    /** Dataflow regions drawn as a circuit. */
    circuit?: DataflowLayout
    comments: CommentLayout[]
    span?: Span
}

export type LabelDirection = 'right' | 'left' | 'down' | 'up'

export interface TransitionLabelLayout extends Box {
    lines: TextLine[]
    /** Direction of the edge at the label, for KIELER's on-edge label decoration. */
    direction: LabelDirection
}

export interface TransitionLayout {
    kind: 'transition'
    id: string
    source: string
    target: string
    priority: number
    /** ELK's routing points: start, cubic Bézier control points, end (1 + 3k points when splines are used). */
    points: Point[]
    immediate: boolean
    preemption: 'weak' | 'strong' | 'termination'
    history?: 'shallow' | 'deep'
    deferred?: 'shallow' | 'deep'
    nondeterministic?: boolean
    probability?: number
    label?: TransitionLabelLayout
    /** The transition's doc comments, each an extra label stacked in front of the main one (KIELER's
     *  "Comment Nodes" option). */
    comments?: TransitionLabelLayout[]
    span?: Span
}

export interface CommentLayout extends Box {
    id: string
    lines: TextLine[]
    /** Connection from the element it documents to the comment (a state's comments; a region's have none). */
    points?: Point[]
}

/** A dataflow region as a small circuit: inputs, operators and outputs joined by wires. */
export interface DataflowLayout {
    nodes: DataflowNodeLayout[]
    wires: { id: string; points: Point[] }[]
}

export interface DataflowNodeLayout extends Box {
    id: string
    kind: 'input' | 'output' | 'operator' | 'constant' | 'actor'
    text: string
    lines: TextLine[]
}

export interface DiagramLayout {
    /** Bumped when the shape of this data changes. */
    version: 1
    /** Id (and name) of the chart. */
    chart: string
    width: number
    height: number
    root: StateLayout
    /** The direction setting the layout was made with. */
    direction: LayoutDirection
    /** `@diagram[shadows] false` on the chart: renderSvg draws no shadows unless told otherwise. */
    shadows?: false
}

export type LayoutDirection = 'HV' | 'VH' | 'down' | 'right'

/** What `layoutChart` needs from ELK: elkjs's `ELK` instance, possibly backed by a Web Worker. */
export interface ElkLike {
    layout(graph: ElkNode): Promise<ElkNode>
}

export interface LayoutOptions {
    /** The ELK instance. `layoutChart` from `src/diagram/index` defaults to a shared `elkjs/lib/elk.bundled.js`
     *  instance (loaded on first use); the one in `src/diagram/layout` needs it (the playground passes elk-api
     *  backed by a Web Worker, so its bundle never contains the bundled build). */
    elk?: ElkLike
    /** Text measurement. Default: the generated width table of the diagram font (identical in Node and the
     *  browser). */
    measure?: TextMeasurer
    /** The program the chart belongs to: its other charts give referenced instances in dataflow regions their
     *  ports, and its declarations and pragmas the formatter's context. */
    program?: Program
    /** Charts of other files (`import`ed), for references to them (e.g. `compile(...).index.programs`' charts).
     *  `program`'s own charts come first. */
    charts?: State[]
    /** Declaration lookup and symbol table for the formatter. Default: built from `program`, or from the chart
     *  itself. */
    format?: FormatContext
    /** KIELER's "User Labels": show `label "..."` instead of trigger and effects. Default true. */
    userLabels?: boolean
    /** KIELER's "Comment Nodes": `/** doc comments *\/` of the chart, states and regions as comment boxes, those of
     *  transitions as extra labels. Default true (as in KIELER). */
    comments?: boolean
    /** Show declarations. Default true. */
    declarations?: boolean
    /** Show entry/during/exit/suspend actions. Default true. */
    actions?: boolean
    /** Layout direction: 'HV' (KIELER's default: top level left to right, alternating with depth), 'VH',
     *  'down' or 'right'. */
    direction?: LayoutDirection
    /** Soft-wrap width of transition label lines (KIELER: 200). 0 disables wrapping. */
    labelWidth?: number
    /** Region ids to draw collapsed, in addition to regions annotated `@collapse`. */
    collapsed?: Iterable<string>
    /** Reference states (`state S is Other(...)`): 'collapsed' (KIELER's initial view, default), 'expanded'
     *  (the referenced chart drawn inside, needs `program`), or the ids of the reference states to expand.
     *  Elements of an expanded chart get ids `<reference state id>/<id in the referenced chart>`. */
    references?: 'collapsed' | 'expanded' | Iterable<string>
    /** Draw dataflow regions as a circuit (true, default) or as a list of equations (false). */
    dataflowCircuit?: boolean
}

export interface RenderOptions {
    /** How the SVG sizes itself: 'natural' (default: width 100%, at most the natural width), 'width'
     *  (always fills the container's width), or 'none' (fixed natural size, for a scrolling frame). */
    fit?: 'natural' | 'width' | 'none'
    /** With fit 'natural' or 'width': never shrink below this fraction of the natural size (sets min-width), so
     *  a wide chart scrolls inside an `overflow-x: auto` frame instead of becoming unreadable on a phone. */
    minScale?: number
    /** Natural size relative to diagram units. Default 1.25 (KIELER's 11 px names show at about 14 px). */
    scale?: number
    /** Prefix for ids inside the SVG (gradients). Default derived from the chart name. Must be unique
     *  among different charts on one page. */
    idPrefix?: string
    /** Accessible name. Default "SCChart <name>". */
    title?: string
    /** Extra classes on the root <svg>. */
    className?: string
    /** Initial highlight classes per element id, e.g. { 'ABRO.WaitAB': ['is-active'] }. */
    classes?: Record<string, string[]>
    /** Draw the KIELER region "collapse" corner (default true). */
    regionCorner?: boolean
    /** Draw state shadows (default true). */
    shadows?: boolean
}

// Dataflow regions as a small circuit, in the spirit of KIELER's EquationSynthesis: every variable read is an
// input (a pentagon), every assigned variable an output, every operator a box with one input port per operand,
// and every referenced chart instance (`ref Other A`) an actor box with its inputs on the left and outputs on
// the right, wired left to right with orthogonal edges. KIELER's full synthesis (inlining, sequential
// constraints, skins) is richer; this covers the equations the guide teaches.

import type { ElkExtendedEdge, ElkLabel, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import { formatExpression, type FormatContext } from '../engine/format'
import type { Expression, Reference, Region, State } from '../engine/types'
import { r2 } from './geometry'
import { lineMetrics, type TextMeasurer, type TextStyle } from './measure'
import type { DataflowLayout, DataflowNodeLayout, Point, TextLine } from './types'

const TEXT: TextStyle = { size: 10 }
const OP: TextStyle = { size: 10, bold: true }
const PORT: TextStyle = { size: 8 }

export interface CircuitBuild {
    nodes: ElkNode[]
    edges: ElkExtendedEdge[]
    layoutOptions: Record<string, string>
    read(node: ElkNode, ox: number, oy: number): DataflowLayout
}

interface CNode {
    id: string
    kind: DataflowNodeLayout['kind']
    text: string
    style: TextStyle
    width: number
    height: number
    /** Input ports in order (operators: one per operand; actors: by interface name). */
    inputs: string[]
    outputs: string[]
}

const OP_TEXT: Record<string, string> = { neg: '-', '?:': '?', pre: 'pre', val: 'val' }

export interface CircuitContext {
    measure: TextMeasurer
    format: FormatContext
    /** Finds a chart by name, to name the ports of referenced instances by their interface. */
    chartOf?: (name: string) => State | undefined
}

export function buildCircuit(region: Region, { measure, format, chartOf }: CircuitContext): CircuitBuild {
    const nodes: CNode[] = []
    const edges: ElkExtendedEdge[] = []
    const inputs = new Map<string, CNode>()
    const outputs = new Map<string, CNode>()
    const actors = new Map<string, CNode>()
    let counter = 0
    const base = region.id
    const metrics = lineMetrics(TEXT)
    const portMetrics = lineMetrics(PORT)

    function add(kind: CNode['kind'], text: string, style: TextStyle = TEXT): CNode {
        const node: CNode = { id: `${base}~${kind}${counter++}`, kind, text, style, inputs: [], outputs: [], width: 0, height: 0 }
        nodes.push(node)
        return node
    }
    const port = (node: CNode, side: 'in' | 'out', name: string) => {
        const list = side === 'in' ? node.inputs : node.outputs
        if (!list.includes(name)) list.push(name)
        return `${node.id}.${side}.${name}`
    }
    const wire = (from: string, to: string) => edges.push({ id: `${base}~wire${edges.length}`, sources: [from], targets: [to] })

    /** The referenced chart instance a reference names, if it is one (`ref Other A`). */
    function actorOf(ref: Reference): CNode | undefined {
        const found = ref.decl ? format.lookup?.(ref.decl) : undefined
        if (found?.declaration.declKind !== 'reference') return undefined
        let actor = actors.get(ref.name)
        if (!actor) {
            const target = found.declaration.referenceTarget
            // KIELER labels the instance box with the instance's name.
            actor = add('actor', ref.name)
            const chart = target ? chartOf?.(target) : undefined
            if (chart) {
                // Ports in interface order, as KIELER lists them.
                for (const d of chart.declarations) for (const vo of d.valuedObjects) {
                    if (d.input) port(actor, 'in', vo.name)
                    if (d.output) port(actor, 'out', vo.name)
                }
            }
            actors.set(ref.name, actor)
        }
        return actor
    }

    /** Builds the node(s) computing `e`; returns the port that carries its value. */
    function build(e: Expression): string {
        switch (e.kind) {
            case 'ref': {
                const actor = actorOf(e)
                if (actor && e.sub) return port(actor, 'out', e.sub.name)
                const text = formatExpression(e, format)
                let node = inputs.get(text)
                if (!node) inputs.set(text, (node = add('input', text)))
                return port(node, 'out', 'value')
            }
            case 'op': {
                const node = add('operator', OP_TEXT[e.op] ?? e.op, OP)
                e.args.forEach((arg, i) => wire(build(arg), port(node, 'in', String(i))))
                return port(node, 'out', 'value')
            }
            case 'call': {
                const node = add('operator', e.name)
                e.args.forEach((arg, i) => wire(build(arg), port(node, 'in', String(i))))
                return port(node, 'out', 'value')
            }
            default: {
                const node = add('constant', formatExpression(e, format))
                return port(node, 'out', 'value')
            }
        }
    }

    for (const eq of region.equations) {
        const actor = actorOf(eq.target)
        if (actor && eq.target.sub) {
            // `A.I = e`: into the instance's input I.
            wire(build(eq.expression), port(actor, 'in', eq.target.sub.name))
        } else if (actor && eq.expression.kind === 'vector') {
            // `A = {x, _, y}`: the instance's inputs in order; `_` leaves one unconnected.
            eq.expression.values.forEach((value, i) => {
                if (value.kind === 'ignore') return
                const name = actor.inputs[i] ?? String(i)
                wire(build(value), port(actor, 'in', name))
            })
        } else {
            const target = formatExpression(eq.target, format)
            let out = outputs.get(target)
            if (!out) outputs.set(target, (out = add('output', target)))
            wire(build(eq.expression), port(out, 'in', 'value'))
        }
    }

    // Sizes.
    for (const n of nodes) {
        const w = measure(n.text, n.style)
        if (n.kind === 'input' || n.kind === 'output') {
            n.width = r2(Math.max(22, w + 16))
            n.height = r2(metrics.lineHeight + 4)
        } else if (n.kind === 'actor') {
            const widest = (names: string[]) => Math.max(0, ...names.map(p => measure(p, PORT)))
            const rows = Math.max(n.inputs.length, n.outputs.length, 1)
            n.width = r2(Math.max(w + 12, widest(n.inputs) + widest(n.outputs) + 20, 40))
            n.height = r2(metrics.lineHeight + 6 + rows * (portMetrics.lineHeight + 2) + 4)
        } else {
            n.width = r2(Math.max(20, w + 10))
            n.height = r2(Math.max(20, 6 * n.inputs.length + 8))
        }
    }

    const elkNodes: ElkNode[] = nodes.map(n => {
        const ports: ElkPort[] = []
        const actorPortY = (i: number) => r2(metrics.lineHeight + 6 + i * (portMetrics.lineHeight + 2) + (portMetrics.lineHeight + 2) / 2)
        n.inputs.forEach((name, i) => {
            const p: ElkPort = { id: `${n.id}.in.${name}`, width: 0, height: 0, layoutOptions: { 'org.eclipse.elk.port.side': 'WEST', 'org.eclipse.elk.port.index': String(n.inputs.length - 1 - i) } }
            if (n.kind === 'actor') { p.x = 0; p.y = actorPortY(i) }
            ports.push(p)
        })
        n.outputs.forEach((name, i) => {
            const p: ElkPort = { id: `${n.id}.out.${name}`, width: 0, height: 0, layoutOptions: { 'org.eclipse.elk.port.side': 'EAST', 'org.eclipse.elk.port.index': String(i) } }
            if (n.kind === 'actor') { p.x = n.width; p.y = actorPortY(i) }
            ports.push(p)
        })
        const layoutOptions: Record<string, string> = { 'org.eclipse.elk.portConstraints': n.kind === 'actor' ? 'FIXED_POS' : 'FIXED_ORDER' }
        if (n.kind === 'input') layoutOptions['org.eclipse.elk.layered.layering.layerConstraint'] = 'FIRST'
        if (n.kind === 'output') layoutOptions['org.eclipse.elk.layered.layering.layerConstraint'] = 'LAST'
        const labels: ElkLabel[] = []
        return { id: n.id, width: n.width, height: n.height, ports, layoutOptions, labels }
    })

    return {
        nodes: elkNodes,
        edges,
        layoutOptions: {
            'org.eclipse.elk.direction': 'RIGHT',
            'org.eclipse.elk.edgeRouting': 'ORTHOGONAL',
            'org.eclipse.elk.spacing.nodeNode': '8',
            'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers': '18',
            'org.eclipse.elk.layered.spacing.edgeNodeBetweenLayers': '8',
            'org.eclipse.elk.layered.cycleBreaking.strategy': 'GREEDY',
        },
        read(node, ox, oy) {
            const byId = new Map((node.children ?? []).map(c => [c.id, c]))
            const out: DataflowLayout = { nodes: [], wires: [] }
            const line = (text: string, style: TextStyle, x: number, top: number, height: number): TextLine => {
                const m = lineMetrics(style)
                const w = measure(text, style)
                const l: TextLine = {
                    x: r2(x), y: r2(top + (height - m.lineHeight) / 2 + m.baseline), width: r2(w), size: style.size,
                    runs: [{ text, dx: 0, width: r2(w), format: 'text' }], role: 'equation',
                }
                if (style.bold) l.bold = true
                return l
            }
            for (const n of nodes) {
                const en = byId.get(n.id)
                if (!en) continue
                const x = ox + (en.x ?? 0), y = oy + (en.y ?? 0)
                const w = en.width ?? n.width, h = en.height ?? n.height
                const tw = measure(n.text, n.style)
                const lines: TextLine[] = []
                if (n.kind === 'actor') {
                    lines.push(line(n.text, n.style, x + (w - tw) / 2, y + 2, metrics.lineHeight + 2))
                    const rowH = portMetrics.lineHeight + 2
                    n.inputs.forEach((p, i) => lines.push(line(p, PORT, x + 4, y + metrics.lineHeight + 6 + i * rowH, rowH)))
                    n.outputs.forEach((p, i) => lines.push(line(p, PORT, x + w - 4 - measure(p, PORT), y + metrics.lineHeight + 6 + i * rowH, rowH)))
                } else {
                    // Pentagons point right; their text sits in the rectangular part.
                    const textX = n.kind === 'input' ? x + (w - 6 - tw) / 2 : n.kind === 'output' ? x + 6 + (w - 6 - tw) / 2 : x + (w - tw) / 2
                    lines.push(line(n.text, n.style, textX, y, h))
                }
                out.nodes.push({ id: n.id, kind: n.kind, text: n.text, x: r2(x), y: r2(y), width: r2(w), height: r2(h), lines })
            }
            for (const e of node.edges ?? []) {
                const points: Point[] = []
                for (const s of e.sections ?? []) {
                    if (!points.length) points.push(s.startPoint)
                    points.push(...(s.bendPoints ?? []), s.endPoint)
                }
                out.wires.push({ id: e.id, points: points.map(p => ({ x: r2(ox + p.x), y: r2(oy + p.y) })) })
            }
            return out
        },
    }
}

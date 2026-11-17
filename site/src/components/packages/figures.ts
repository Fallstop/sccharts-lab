// Build-time helpers of the figures on the packages' documentation: each figure is what the packages' own calls
// give for a chart (compiled with the engine, drawn with the diagram package, run and traced as the page's code
// does), so a figure cannot disagree with the code beside it. Astro frontmatter only.
import { compile, createSimulation, type CompileResult, type SimTickResult, type State, type Value } from '@sccharts-lab/engine'
import { layoutChart, renderSvg, type DiagramLayout, type LayoutOptions } from '@sccharts-lab/diagram'
import { nextId } from '../frame/ids'
import { lanesFor, traceSvg } from '../sim/trace'

/** `layoutChart`'s options that are plain data, as a figure's `layout` prop takes them. */
export type FigureLayout = Pick<LayoutOptions, 'direction' | 'references' | 'declarations' | 'actions' | 'comments' | 'userLabels' | 'labelWidth' | 'dataflowCircuit'>

export type Inputs = Record<string, Value>

export interface Compiled {
    result: CompileResult
    chart: State
}

/**
 * Compiles a figure's chart; a figure of a chart that does not compile is a build error naming the figure, unless
 * the figure is about a chart with errors (`rejected`: then it must have errors, and still parse).
 */
export function compiled(code: string, files: Record<string, string> | undefined, figure: string, rejected = false): Compiled {
    const result = compile(code, { files })
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    if (!result.chart) throw new Error(`${figure}: the text is not a chart: ${errors.map((d) => d.message).join('; ')}`)
    if (result.ok === rejected) throw new Error(rejected ? `${figure}: the chart compiles, but the figure shows its errors` : `${figure}: the chart does not compile: ${errors.map((d) => d.message).join('; ')}`)
    return { result, chart: result.chart }
}

/** `is-error` for every element the chart's errors name (`Diagnostic.related`), as a page marks them. */
export function errorClasses(result: CompileResult): Record<string, string[]> {
    const classes: Record<string, string[]> = {}
    for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'error') for (const id of diagnostic.related ?? []) classes[id] = ['is-error']
    }
    return classes
}

/** Runs the chart with these inputs, one object per tick; a run that stops with an error is a build error. */
export function run(c: Compiled, steps: Inputs[], figure: string): SimTickResult[] {
    const simulation = createSimulation(c.result)
    for (const inputs of steps) {
        const tick = simulation.step(inputs)
        if (tick.error) throw new Error(`${figure}: the run stops in tick ${tick.tick}: ${tick.error.message}`)
    }
    return simulation.history
}

/** The chart's layout, with the charts of the files it imports (for references drawn expanded). */
export function layoutOf(c: Compiled, options: FigureLayout = {}): Promise<DiagramLayout> {
    const charts = c.result.index?.programs.flatMap((program) => program.charts)
    return layoutChart(c.chart, { program: c.result.program, charts, ...options })
}

/**
 * The layout as SVG with ids of its own (several drawings of one chart share a page). `shrink`: the drawing always
 * fits its box, however small (a tile of a grid); otherwise a wide one keeps 60 % of its size and its frame scrolls.
 */
export function svgOf(layout: DiagramLayout, classes: Record<string, string[]> | undefined, title: string, shrink = false): string {
    return renderSvg(layout, { idPrefix: nextId('scp').replace(/[^a-z0-9]/gi, ''), fit: 'natural', minScale: shrink ? undefined : 0.6, classes, title })
}

/** The run as a timing diagram: the chart's inputs and outputs, and the state it is in, tick by tick. */
export function waveOf(c: Compiled, history: SimTickResult[], width = 640): string {
    return traceSvg(lanesFor(c.result.interface, c.chart), { history, cursor: history.length, width, fill: false }, `Timing diagram of ${c.chart.name}, ticks 1 to ${history.length}`)
}

/** `{ coin: true }` as the code writes it; empty for no inputs. */
export function inputsText(inputs: Inputs): string {
    const entries = Object.entries(inputs)
    return entries.length ? `{ ${entries.map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join(', ')} }` : ''
}

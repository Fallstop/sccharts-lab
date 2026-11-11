// Type-checked by tools/packages/smoke.mjs in a fresh project (moduleResolution bundler, then node16; skipLibCheck
// off, so the packages' declarations are checked too). Each @ts-expect-error proves a type is real, not `any`.

import { compile, createSimulation, generateC, parse, type CompileResult, type Diagnostic, type SimTickResult, type State, type TickResult, type Value } from '@sccharts-lab/engine'
import type { Program, VariableInfo } from '@sccharts-lab/engine/types'
import { createFormatContext, formatExpression } from '@sccharts-lab/engine/format'
import { KEYWORDS, lex } from '@sccharts-lab/engine/lexer'
import { applyClasses, chartToSvg, layoutChart, renderSvg, tickClasses, type DiagramLayout, type ElkLike, type RenderOptions } from '@sccharts-lab/diagram'
import { layoutChart as layoutWith } from '@sccharts-lab/diagram/layout'
import { renderSvg as render } from '@sccharts-lab/diagram/render'
import { HIGHLIGHT_CLASSES, type ClassMap } from '@sccharts-lab/diagram/highlight'
import type { StateLayout } from '@sccharts-lab/diagram/types'
import { compareRuns, readTrace, replayTrace, traceFromRun, writeTrace, type TraceRecord } from '@sccharts-lab/trace'
import { TRACE_FORMATS, type TraceFormat } from '@sccharts-lab/trace/trace-file'
import { compareTraces } from '@sccharts-lab/trace/trace-compare'
import { comparisonMarkdown } from '@sccharts-lab/trace/comparison-report'
import { TraceReplay } from '@sccharts-lab/trace/trace-replay'
import { suggestRenames } from '@sccharts-lab/trace/trace-rename'
import { TimedSchedule } from '@sccharts-lab/trace/trace-timing'

export async function check(source: string, elk: ElkLike): Promise<string> {
    const result: CompileResult = compile(source, { files: { 'Other.sctx': 'scchart Other {}' } })
    const ok: boolean = result.ok
    const diagnostics: Diagnostic[] = result.diagnostics
    const chart: State | undefined = result.chart
    const program: Program | undefined = parse(source).program
    const inputs: VariableInfo[] = result.interface.filter(v => v.input)
    // @ts-expect-error ok is a boolean
    const notOk: string = result.ok

    const simulation = createSimulation(result)
    const tick: SimTickResult = simulation.step({ A: true })
    const plain: TickResult = tick
    const value: Value = tick.values.O
    // @ts-expect-error step takes a record of values
    simulation.step('A')

    const c = generateC(result, { naming: 'prefix', comments: false })
    const header: string = c.files[c.header]
    // @ts-expect-error naming is one of the documented choices
    generateC(result, { naming: 'camel' })

    if (!chart) return ''
    const layout: DiagramLayout = await layoutChart(chart, { program, direction: 'down' })
    const layoutToo: DiagramLayout = await layoutWith(chart, { elk })
    const root: StateLayout = layout.root
    const options: RenderOptions = { fit: 'none', idPrefix: 'x', stylesheet: '' }
    const svg: string = renderSvg(layout, options) + render(layoutToo) + (await chartToSvg(chart))
    // @ts-expect-error fit is one of the documented choices
    renderSvg(layout, { fit: 'cover' })
    const classes: ClassMap = tickClasses(tick)
    const managed: readonly string[] = HIGHLIGHT_CLASSES
    if (typeof document !== 'undefined') applyClasses(document.body, classes)

    const trace: TraceRecord = traceFromRun(result, simulation, { model: 'abro.sctx' })
    const format: TraceFormat = TRACE_FORMATS[0].format
    const text: string = writeTrace(trace, format)
    const outcome = replayTrace(result, readTrace(text, format))
    const mismatches: number = outcome.mismatches.length
    // @ts-expect-error writeTrace takes one of the four formats
    writeTrace(trace, 'yaml')
    const report: string = comparisonMarkdown(compareRuns([{ label: 'a', result, run: simulation }]))
    const report2: string = comparisonMarkdown(compareTraces([{ label: 'a', trace }]))
    void [TraceReplay, suggestRenames, TimedSchedule, KEYWORDS, lex, createFormatContext, formatExpression]
    void [ok, diagnostics, inputs, notOk, plain, value, header, root, managed, mismatches, report, report2]
    return svg
}

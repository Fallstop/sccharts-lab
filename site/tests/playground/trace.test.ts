// The Trace tab's logic: a run saved in each format reads back as the run; a saved run replays without a difference
// (as a tour for the simulation panel); a changed file is caught at its tick; names spelled differently are offered as
// renames; the comparison report renders as HTML.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compile, createSimulation, type CompileResult, type Simulation } from '@sccharts-lab/engine'
import { readTrace, traceFromRun, writeTrace, TRACE_FORMATS } from '@sccharts-lab/trace'
import { compareRun, planReplay, readTraceFile, replaySummary, runFile, tickNote, traceFileName } from '../../src/components/playground/trace-actions'
import { reportHtml } from '../../src/components/playground/report-md'

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8')
const stopwatch = compile(read('src/components/playground/showcase/stopwatch.sctx'))
const report = compile(read('src/examples/advanced/methods/report.sctx'))

/** A run of `result` on these inputs, tick by tick. */
function run(result: CompileResult, inputs: Record<string, unknown>[]): Simulation {
    const sim = createSimulation(result)
    for (const row of inputs) sim.step(row as Parameters<Simulation['step']>[0])
    return sim
}

const presses = [{}, { startStop: true }, { startStop: false }, {}, { lap: true }, { lap: false }, {}, { startStop: true }]

describe('save', () => {
    test('every format reads back as the run; inputs only is a sequence', () => {
        const sim = run(stopwatch, presses)
        const trace = traceFromRun(stopwatch, sim, { model: 'stopwatch.sctx' })
        for (const { format } of TRACE_FORMATS) {
            const text = runFile(stopwatch, sim.history, { format, inputs: false, model: 'stopwatch.sctx' })
            expect(text).toBe(writeTrace(trace, format))
            const back = readTrace(text, `x.${format === 'ktrace' ? 'ktrace' : format}`)
            expect(back.ticks).toHaveLength(presses.length)
            const sequence = readTrace(runFile(stopwatch, sim.history, { format, inputs: true, model: 'stopwatch.sctx' }), `x.${format}`)
            expect(sequence.variables.every(v => !v.role || v.role === 'input')).toBe(true)
        }
    })

    test('file names are free', () => {
        expect(traceFileName('Stopwatch', 'csv', false)).toBe('Stopwatch-run.csv')
        expect(traceFileName('Stopwatch', 'ktrace', true, ['stopwatch-inputs.ktrace'])).toBe('Stopwatch-inputs-2.ktrace')
    })
})

describe('replay', () => {
    test('a saved run replays without a difference, as a tour of the inputs each tick read', () => {
        const sim = run(stopwatch, presses)
        for (const { format, extension } of TRACE_FORMATS) {
            const file = readTraceFile(runFile(stopwatch, sim.history, { format, inputs: false, model: 'stopwatch.sctx' }), `run.${extension}`)
            if ('error' in file) throw new Error(file.error)
            const plan = planReplay(stopwatch, file.trace, `run.${extension}`)
            expect(plan.mismatches, format).toEqual([])
            expect(plan.scenario.ticks).toHaveLength(presses.length)
            expect(plan.scenario.ticks.every(t => t.note === 'The outputs are the same as in the file.')).toBe(true)
            expect(plan.inputs.sort()).toEqual(['clear', 'lap', 'startStop'])
            expect(plan.outputs.sort()).toEqual(['display', 'time'])
            expect(replaySummary(plan)).toBe(`The outputs match the file in all ${presses.length} ticks.`)
            // The tour's inputs give the same run in a fresh simulation (what the panel does with them).
            const again = createSimulation(stopwatch)
            plan.scenario.ticks.forEach((t, i) => expect(again.step(t.inputs as Parameters<Simulation['step']>[0]).pool).toEqual(sim.history[i].pool))
        }
    })

    test('a file that differs is caught at its tick, in words', () => {
        const sim = run(stopwatch, presses)
        const csv = runFile(stopwatch, sim.history, { format: 'csv', inputs: false, model: 'stopwatch.sctx' })
        // Tick 4's display, written as 99 in the file.
        const lines = csv.split('\n')
        const header = lines[0].split(',')
        const row = lines[4].split(',')
        row[header.indexOf('display')] = '99'
        lines[4] = row.join(',')
        const file = readTraceFile(lines.join('\n'), 'run.csv')
        if ('error' in file) throw new Error(file.error)
        const plan = planReplay(stopwatch, file.trace, 'run.csv')
        expect([...plan.byTick.keys()]).toEqual([4])
        expect(plan.scenario.ticks[3].note).toBe(tickNote(plan.byTick.get(4)!))
        expect(plan.scenario.ticks[3].note).toMatch(/^`display` is `\d+`; the file has `99`\.$/)
        expect(replaySummary(plan)).toMatch(/^1 of 8 ticks differ; first in tick 4: `display` is/)
    })

    test('names spelled another way are offered as renames, and a rename drives the input', () => {
        const sim = run(report, [{ level: 3 }, { level: 4 }, { level: 5 }])
        const csv = runFile(report, sim.history, { format: 'csv', inputs: false, model: 'report.sctx' }).replace(/\blevel\b/, 'LEVEL')
        const file = readTraceFile(csv, 'run.csv')
        if ('error' in file) throw new Error(file.error)
        const plain = planReplay(report, file.trace, 'run.csv')
        expect(plain.suggestions).toEqual([{ from: 'LEVEL', to: 'level', reason: 'spelling' }])
        expect(plain.inputs).not.toContain('level')
        const renamed = planReplay(report, file.trace, 'run.csv', { LEVEL: 'level' })
        expect(renamed.suggestions).toEqual([])
        expect(renamed.inputs).toContain('level')
        expect(renamed.mismatches).toEqual([])
    })

    test('a damaged file says where', () => {
        expect(readTraceFile('tick,a\n1,"x', 'bad.csv')).toHaveProperty('error')
        expect(readTraceFile('{"format": 1', 'bad.json')).toHaveProperty('error')
    })
})

describe('compare', () => {
    test('the run against a saved trace: the report, as HTML, and its CSV', () => {
        const mine = run(stopwatch, presses)
        const other = run(stopwatch, presses.slice(0, 4))
        const saved = readTrace(runFile(stopwatch, other.history, { format: 'json', inputs: false, model: 'stopwatch.sctx' }), 'other.json')
        const { markdown, csv, comparison } = compareRun(stopwatch, mine.history, 'This run', [{ label: 'other.json', trace: saved }])
        expect(comparison.traces.map(t => t.label)).toEqual(['This run', 'other.json'])
        expect(markdown).toMatch(/^# Trace comparison/)
        expect(csv.split('\n')[0]).toMatch(/,/)
        const html = reportHtml(markdown)
        expect(html).toContain('<h3>Trace comparison</h3>')
        expect(html).toContain('<table>')
        expect(html).toContain('<code')
        expect(html).not.toMatch(/\|\s*---/)
    })

    test('the Markdown subset: headings, tables with escaped bars, marked rows, paragraphs', () => {
        const html = reportHtml('# A\n\nSome **bold** and `code`\nwrapped.\n\n| x | y |\n|---|---|\n| 1 ≠ | a \\| b |\n| 2 | c |\n', 1)
        expect(html).toBe(
            '<h2>A</h2>\n<p>Some <strong>bold</strong> and <code class="sc-nobr">code</code> wrapped.</p>\n' +
                '<div class="sc-pg-report__table"><table><thead><tr><th scope="col">x</th><th scope="col">y</th></tr></thead><tbody>' +
                '<tr class="is-different"><th scope="row">1 ≠</th><td>a | b</td></tr><tr><th scope="row">2</th><td>c</td></tr></tbody></table></div>',
        )
    })
})

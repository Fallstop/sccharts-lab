// The Node half of the consumer smoke test (tools/packages/smoke.mjs copies this into a fresh project that installed
// the packed tarballs with npm): ABRO compiled, simulated on KIELER's recorded inputs and compared with KIELER's data
// pool, its C code compiled with gcc and run on the same inputs, its diagram drawn, its run saved and replayed as a
// trace. Prints one JSON line with what it found; throws on the first difference.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compile, createSimulation, describeTick, generateC } from '@sccharts-lab/engine'
import { formatExpression } from '@sccharts-lab/engine/format'
import { KEYWORDS } from '@sccharts-lab/engine/lexer'
import { chartToSvg, tickClasses } from '@sccharts-lab/diagram'
import { layoutChart } from '@sccharts-lab/diagram/layout'
import { renderSvg } from '@sccharts-lab/diagram/render'
import { readTrace, replayTrace, traceFromRun, writeTrace } from '@sccharts-lab/trace'
import { readTrace as readTraceOnly, TRACE_FORMATS } from '@sccharts-lab/trace/trace-file'

const here = path.dirname(new URL(import.meta.url).pathname)
const source = fs.readFileSync(path.join(here, 'abro.sctx'), 'utf8')
const kieler = JSON.parse(fs.readFileSync(path.join(here, 'abro.oracle.json'), 'utf8'))
const report = {}

// ----- Compile and simulate: the data pool of every tick is KIELER's ---------------------------------------------

const result = compile(source)
assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
assert.deepEqual(result.interface.map(v => v.name), ['A', 'B', 'R', 'O'])
const simulation = createSimulation(result)
for (const [i, tick] of kieler.ticks.entries()) {
    const step = simulation.step(tick.inputs)
    assert.deepEqual(step.pool, tick.values, `tick ${i + 1}: engine ${JSON.stringify(step.pool)}, KIELER ${JSON.stringify(tick.values)}`)
}
report.ticks = simulation.tick
report.tick3 = describeTick(simulation.history[2], result.program)
assert.ok(KEYWORDS.has('scchart'))
assert.equal(formatExpression(result.chart.regions[0].states[0].regions[0].states[0].regions[0].states[0].transitions[0].trigger), 'A')

// ----- C code: gcc, then the same inputs; every tick's pool is the engine's -------------------------------------

const c = generateC(result)
assert.equal(c.ok, true, JSON.stringify(c.diagnostics))
report.cFiles = Object.keys(c.files)
let gcc = true
try {
    execFileSync('gcc', ['--version'], { stdio: 'ignore' })
} catch {
    gcc = false
}
if (gcc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-lab-c-'))
    for (const [name, text] of Object.entries(c.files)) fs.writeFileSync(path.join(dir, name), text)
    const pooled = c.variables.filter(v => v.pool && !v.dims.length && ['bool', 'int'].includes(v.type))
    const main = [
        '#include <stdio.h>',
        `#include "${c.header}"`,
        `static ${c.names.struct} d;`,
        'int main(void) {',
        `  ${c.names.reset}(&d);`,
        ...kieler.ticks.flatMap(tick => [
            ...Object.entries(tick.inputs).map(([name, value]) => `  d.${c.variables.find(v => v.pool === name).member} = ${Number(value)};`),
            `  ${c.names.tick}(&d);`,
            `  printf("${pooled.map(v => `${v.pool}=%d`).join(' ')}\\n", ${pooled.map(v => `d.${v.member}`).join(', ')});`,
        ]),
        '  return 0;',
        '}',
    ]
    fs.writeFileSync(path.join(dir, 'main.c'), main.join('\n'))
    execFileSync('gcc', ['-std=c99', '-Wall', '-Werror', '-o', 'abro', 'main.c', c.source], { cwd: dir })
    const lines = execFileSync(path.join(dir, 'abro'), { encoding: 'utf8' }).trim().split('\n')
    lines.forEach((line, i) => {
        const fromC = Object.fromEntries(line.split(' ').map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]))
        const fromEngine = Object.fromEntries(pooled.map(v => [v.pool, Number(simulation.history[i].pool[v.pool])]))
        assert.deepEqual(fromC, fromEngine, `C tick ${i + 1}`)
    })
    report.cTicks = lines.length
    fs.rmSync(dir, { recursive: true })
}
report.gcc = gcc

// ----- Diagram: SVG markup in Node, with the bundled ELK and with an ELK passed in ------------------------------

const svg = await chartToSvg(result.chart, { program: result.program, idPrefix: 'abro', classes: tickClasses(simulation.history[2]) })
for (const id of ['ABRO', 'ABRO.ABO', 'ABRO.ABO.WaitAB', 'ABRO.ABO.WaitAB.WaitA', 'ABRO.ABO.WaitAB:HandleA']) assert.ok(svg.includes(`data-id="${id}"`), id)
assert.match(svg, /class="[^"]*is-taken/)
const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
const layout = await layoutChart(result.chart, { elk: new ELK(), program: result.program })
assert.equal(renderSvg(layout, { idPrefix: 'abro', classes: tickClasses(simulation.history[2]) }), svg)
// A standalone .svg file (the diagram README's recipe): diagram.css, and fonts.css with the fonts inlined.
const fontsCss = new URL(import.meta.resolve('@sccharts-lab/diagram/fonts.css'))
const fonts = fs.readFileSync(fontsCss, 'utf8').replace(/url\(\.\/([^)]+)\)/g, (_, file) => `url(data:font/woff2;base64,${fs.readFileSync(new URL(file, fontsCss)).toString('base64')})`)
const css = fs.readFileSync(new URL(import.meta.resolve('@sccharts-lab/diagram/diagram.css')), 'utf8')
const standalone = renderSvg(layout, { fit: 'none', stylesheet: fonts + css })
assert.ok(standalone.includes('<style><![CDATA[') && standalone.includes('.sc-diagram') && standalone.includes('data:font/woff2;base64,'))
fs.writeFileSync(path.join(here, 'abro.svg'), standalone)
report.svgBytes = svg.length

// ----- Trace: saved in every format, read back, replayed without a mismatch ---------------------------------------

const trace = traceFromRun(result, simulation, { model: 'abro.sctx' })
assert.equal(trace.ticks.length, kieler.ticks.length)
for (const { format, extension } of TRACE_FORMATS) {
    const text = writeTrace(trace, format)
    const read = readTraceOnly(text, `run.${extension}`)
    assert.equal(read.ticks.length, trace.ticks.length, format)
    const outcome = replayTrace(result, readTrace(text, format), { label: `run.${extension}` })
    assert.equal(outcome.mismatches.length, 0, `${format}: ${JSON.stringify(outcome.mismatches)}`)
}
report.ktrace = writeTrace(trace, 'ktrace').split('\n').slice(0, 3)

console.log(JSON.stringify(report))

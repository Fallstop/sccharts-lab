// The C code tab's download: the .zip holds the generated header and C file and a main.c; built with the command
// main.c names (gcc as KIELER's simulation calls it), the program runs and prints, tick by tick, what the engine's
// simulation computes for the same chart (inputs as reset leaves them). Skipped without gcc.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { unzipSync, strFromU8 } from 'fflate'
import { compile, createSimulation, generateC, type GeneratedC } from '@sccharts-lab/engine'
import { buildCommand, cProjectFiles, interfaceRows, mainC, mainFile } from '../../src/components/playground/c-project'
import { zipFiles } from '../../src/components/playground/folder'
import { hasGcc } from '../../tools/cgen/gcc'

const gcc = await hasGcc()
const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8')

const TERMINATES = `scchart Once {
  input bool start
  output int n = 0
  initial state A
    if start do n = 5 go to Done
    go to B
  state B
    do n++ go to Done
  final state Done
}
`

const CHARTS: [string, string][] = [
    ['ABRO', read('src/components/playground/showcase/abro.sctx')],
    ['Stopwatch', read('src/components/playground/showcase/stopwatch.sctx')],
    ['Report (print)', read('src/examples/advanced/methods/report.sctx')],
    ['Doorbell (valued signal)', read('src/examples/advanced/code-generation/doorbell.sctx')],
    ['Divide (initial input, float, string, valued input)', read('src/examples/design/widgets-test/divide.sctx')],
    ['Greeting (strings)', read('src/examples/learn/variables/greeting.sctx')],
    ['Once (terminates)', TERMINATES],
]

/** The zip's files (the folder it holds them in dropped). */
async function unzip(g: GeneratedC): Promise<Record<string, string>> {
    const blob = await zipFiles(g.chart, cProjectFiles(g))
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name.split('/').slice(1).join('/'), strFromU8(data)]))
}

/** Builds the files with main.c's own command and runs the program. */
function buildAndRun(files: Record<string, string>, g: GeneratedC): { built: boolean; stderr: string; stdout: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-c-'))
    try {
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
        const command = buildCommand(g)
        expect(files[mainFile(g)]).toContain(command)
        const out = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
        return { built: out.status === 0, stderr: out.stderr, stdout: out.stdout }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

/** What main.c prints per tick: the chart's printed text and the outputs. */
function ticksOf(stdout: string): { printed: string; values: Record<string, string> }[] {
    const out: { printed: string; values: Record<string, string> }[] = []
    const lines = stdout.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const m = /^tick \d+: (.*)$/.exec(lines[i])
        if (!m) continue
        const values: Record<string, string> = {}
        for (const part of (lines[i + 1] ?? '').trim().split(/, (?=\w+ = )/)) {
            const kv = /^(\w+) = (.*)$/.exec(part)
            if (kv) values[kv[1]] = kv[2]
        }
        out.push({ printed: m[1], values })
    }
    return out
}

describe('the C code tab: main.c and the .zip', () => {
    test('main.c resets, ticks, prints the outputs, and stops at termination', () => {
        const g = generateC(compile(TERMINATES))
        const main = mainC(g)
        expect(main).toContain('#include "Once.h"')
        expect(main).toContain('static TickData d;')
        expect(main).toContain('reset(&d);')
        expect(main).toContain('tick(&d);')
        expect(main).toContain('printf("\\n  n = %d\\n", d.n);')
        expect(main).toContain('if (d._TERM) {')
        expect(main).toContain('Set the input of this tick here: d.start (0 or 1).')
        const prefixed = mainC(generateC(compile(TERMINATES), { naming: 'prefix' }))
        expect(prefixed).toContain('static OnceTickData d;')
        expect(prefixed).toContain('Oncetick(&d);')
        expect(interfaceRows(g)).toEqual([
            { name: 'start', member: 'd->start', ctype: 'char', role: 'input' },
            { name: 'n', member: 'd->n', ctype: 'int', role: 'output' },
        ])
    })

    test('a chart named main (or Main): its own main.c stays, the program is in run.c, and it builds', async () => {
        for (const name of ['main', 'Main']) {
            const g = generateC(compile(`scchart ${name} {\n  output int x = 1\n  initial state A\n  do x = 2 go to B\n  state B\n}\n`))
            expect(g.ok).toBe(true)
            const files = cProjectFiles(g)
            expect(Object.keys(files).sort()).toEqual([`${name}.c`, `${name}.h`, 'run.c'])
            expect(files[`${name}.c`]).toBe(g.files[`${name}.c`])
            if (gcc) expect(buildAndRun(files, g).built).toBe(true)
        }
    })

    test('the .zip holds the header, the C file and main.c', async () => {
        const g = generateC(compile(CHARTS[0][1]))
        const files = await unzip(g)
        expect(Object.keys(files).sort()).toEqual(['ABRO.c', 'ABRO.h', 'main.c'])
        expect(files['ABRO.h']).toBe(g.files['ABRO.h'])
        expect(files['ABRO.c']).toBe(g.files['ABRO.c'])
    })

    describe.skipIf(!gcc)('built with gcc, the program runs as the engine simulates', () => {
        for (const [label, source] of CHARTS) {
            test(label, async () => {
                const result = compile(source)
                for (const naming of ['default', 'suffix'] as const) {
                    const g = generateC(result, { naming })
                    expect(g.ok).toBe(true)
                    const run = buildAndRun(await unzip(g), g)
                    expect(run.stderr.replace(/^.*warning.*$/gm, '').trim(), run.stderr).not.toMatch(/error/)
                    expect(run.built, run.stderr).toBe(true)
                    const ticks = ticksOf(run.stdout)
                    // The engine, with the inputs as reset leaves them.
                    const sim = createSimulation(result)
                    const outputs = g.variables.filter(v => v.output && v.signal !== 'curval' && !v.dims.length && v.pool)
                    ticks.forEach((t, i) => {
                        const tick = sim.step({})
                        expect(t.printed, `${label} tick ${i + 1}`).toBe(tick.printed.join(''))
                        for (const v of outputs) {
                            const expected = tick.pool[v.pool!]
                            const shown = typeof expected === 'boolean' ? String(Number(expected)) : typeof expected === 'string' ? JSON.stringify(expected) : String(expected)
                            const actual = v.type === 'float' ? String(Number(t.values[v.name])) : t.values[v.name]
                            expect(actual, `${label} tick ${i + 1}: ${v.name}`).toBe(v.type === 'float' ? String(Number(Number(expected).toPrecision(6))) : shown)
                        }
                    })
                    // Ten ticks, or fewer when the chart terminates.
                    expect(ticks.length === 10 || /terminated/.test(run.stdout), run.stdout).toBe(true)
                }
            }, 60_000)
        }

        test('host code builds too: the browser cannot run it, the C can', async () => {
            const g = generateC(compile(read('src/examples/advanced/host-code/gauge.sctx')))
            expect(g.hostCode).toBe(true)
            const run = buildAndRun(await unzip(g), g)
            expect(run.built, run.stderr).toBe(true)
            expect(ticksOf(run.stdout)).toHaveLength(10)
        }, 60_000)
    })
})

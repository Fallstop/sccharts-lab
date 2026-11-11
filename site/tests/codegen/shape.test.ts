// The generated C has KIELER's shape: compared with real output of KIELER's "Netlist-based Compilation (C)"
// (de.cau.cs.kieler.sccharts.netlist, dumped from the lab server, kieler/*.h|.c; kieler/tts/ is the simulation chain
// with Taken Transition Signaling). The struct's members for the chart's variables (names, types, order), the
// functions' signatures, reset()'s initial values, tick()'s shape, printf formats, class typedefs and host code
// placement must be KIELER's, so a main.c written against KIELER's code compiles against ours unchanged. The guards
// (`_g...`) are numbered differently and are not compared.

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, generateC, type GeneratedC } from '@sccharts-lab/engine'

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, '../..')
const kieler = path.join(here, 'kieler')

/** KIELER's dump -> the chart it was generated from. */
const CHARTS: Record<string, string> = {
    ABRO: 'src/components/playground/showcase/abro.sctx', Adder: 'src/components/playground/showcase/adder.sctx',
    Stopwatch: 'src/components/playground/showcase/stopwatch.sctx', Toggle: 'src/examples/advanced/code-generation/toggle.sctx',
    Doorbell: 'src/examples/advanced/code-generation/doorbell.sctx', StrongCancel: 'src/examples/learn/preemption/strong.sctx',
    Delays: 'src/examples/advanced/dataflow/delays.sctx', Greeting: 'src/examples/learn/variables/greeting.sctx',
    Dice: 'src/examples/advanced/methods/dice.sctx', Scoreboard: 'src/examples/advanced/data-types/scoreboard.sctx',
    BigCounter: 'src/examples/advanced/host-code/big-counter.sctx', Gauge: 'src/examples/advanced/host-code/gauge.sctx',
    Distance: 'src/examples/advanced/host-code/distance.sctx', Backticks: 'src/examples/advanced/host-code/backticks.sctx',
    Report: 'src/examples/advanced/methods/report.sctx', BlinkSleep: 'src/examples/advanced/time/blink-sleep.sctx',
    Logger: 'src/examples/advanced/data-types/logger.sctx', Limits: 'src/examples/learn/variables/limits.sctx',
    FloatLit: 'tests/codegen/kieler/FloatLit.sctx', Tick1Print: 'tests/codegen/kieler/Tick1Print.sctx',
}

const read = (f: string) => fs.readFileSync(f, 'utf8')

function gen(name: string, options: Parameters<typeof generateC>[1] = {}): GeneratedC {
    const g = generateC(compile(read(path.join(site, CHARTS[name]))), options)
    expect(g.ok, g.diagnostics.map(d => d.message).join('\n')).toBe(true)
    return g
}

/** The struct's members (`int x;`), whitespace normalised; `struct` names the typedef. */
function members(header: string, struct = 'TickData'): string[] {
    const body = new RegExp(`typedef struct \\{\\n([^}]*)\\} ${struct};`).exec(header)?.[1] ?? ''
    return body.split('\n').map(l => l.trim().replace(/,\s+/g, ', ')).filter(Boolean)
}

/** The members KIELER names after the chart's variables (not its helpers, which start with `_`). */
const chartMembers = (m: string[]) => m.filter(l => !/\s_\w+(\[\d+\])*;$/.test(l))

function body(source: string, fn: string): string[] {
    const m = new RegExp(`void ${fn}\\(TickData\\* d\\) \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)
    return (m?.[1] ?? '').split('\n').map(l => l.trim()).filter(Boolean)
}

/** reset()'s statements for the chart's own variables (KIELER's helpers start with `_`). */
const resetOf = (source: string) => body(source, 'reset').filter(l => !/^d->_/.test(l))

describe('the generated C has the shape of KIELER\'s netlist C code', () => {
    for (const name of Object.keys(CHARTS)) {
        it(name, () => {
            const g = gen(name)
            const kh = read(path.join(kieler, `${name}.h`))
            const kc = read(path.join(kieler, `${name}.c`))
            const h = g.files[g.header]
            const c = g.files[g.source]
            expect(g.header).toBe(`${name}.h`)
            expect(g.source).toBe(`${name}.c`)
            // The chart's variables: same members, same types, same order.
            expect(chartMembers(members(h))).toEqual(chartMembers(members(kh)))
            for (const helper of ['char _GO;', 'char _TERM;']) expect(members(h)).toContain(helper)
            // Classes and structs: KIELER's typedefs.
            for (const t of kh.matchAll(/typedef struct \{[^}]*\} (\w+);/g)) {
                if (t[1] === 'TickData') continue
                expect(members(h, t[1])).toEqual(members(kh, t[1]))
            }
            // The API: the same prototypes in the header, the include guard.
            for (const proto of ['void reset(TickData* d);', 'void logic(TickData* d);', 'void tick(TickData* d);']) {
                expect(kh).toContain(proto)
                expect(h).toContain(proto)
            }
            expect(h.split('\n')[0]).toBe(kh.split('\n')[0])
            expect(c).toContain(`#include "${name}.h"`)
            // reset(): `_GO` and `_TERM` first, then the same initial values of the chart's variables.
            expect(body(c, 'reset').slice(0, 2)).toEqual(['d->_GO = 1;', 'd->_TERM = 0;'])
            expect(resetOf(c)).toEqual(resetOf(kc))
            // tick(): logic, then the registers, then `_GO = 0`.
            const tick = body(c, 'tick')
            expect(tick[0]).toBe('logic(d);')
            expect(tick.at(-1)).toBe('d->_GO = 0;')
            expect(tick.slice(1, -1).every(l => /^d->_pg\w+ = d->_g\w+;$/.test(l))).toBe(true)
            // The includes KIELER adds (stdio.h for print, stdlib.h for random(), ...).
            for (const inc of kc.matchAll(/^#include <[^>]+>$/gm)) expect(c).toContain(inc[0])
            // print(): the same printf.
            for (const p of kc.matchAll(/printf\(.*\);/g)) expect(c).toContain(p[0])
            // Host code: the pragmas' text where KIELER puts it.
            for (const [file, ours] of [[kh, h], [kc, c]] as const) {
                for (const line of file.split('\n')) if (/^(typedef long|static int clamp|#include <stdlib.h>)/.test(line)) expect(ours).toContain(line)
            }
        })
    }

    it('reproduces KIELER\'s float literals, casts and printf conversions', () => {
        const c = gen('FloatLit').files['FloatLit.c']
        expect(c).toContain('d->y = d->x * 0.30000001192092896 + 150.0;')
        expect(c).toContain('d->n = (int)(d->y + d->k);')
        expect(c).toContain('printf("%X %f %d", (d->n + 1), d->x, d->k);')
        expect(c).toContain('d->x = 0.10000000149011612;')
    })

    it('puts the taken-transition counters where KIELER\'s simulation chain does', () => {
        const g = gen('Doorbell', { takenTransitions: true })
        const kh = read(path.join(kieler, 'tts', 'Doorbell.h'))
        const kept = (m: string[]) => m.filter(l => !/\s_(g|cg|pg|GO|TERM)\w*;$/.test(l))
        expect(kept(members(g.files['Doorbell.h']))).toEqual(kept(members(kh)))
        expect(g.files['Doorbell.c']).toContain('d->_taken_transitions[0] += 1;')
        expect(g.files['Doorbell.c']).toContain('d->_taken_transitions[0] = 0;')
        expect(g.takenTransitions).toEqual(['Doorbell.Quiet->1'])
    })

    it('names the functions as #code.naming does', () => {
        const source = read(path.join(site, CHARTS.Toggle))
        const prefix = generateC(compile(source), { naming: 'prefix' })
        expect(prefix.names).toEqual({ tick: 'Toggletick', reset: 'Togglereset', logic: 'Togglelogic', struct: 'ToggleTickData' })
        expect(prefix.files['Toggle.h']).toContain('void Toggletick(ToggleTickData* d);')
        expect(generateC(compile(source), { naming: 'suffix' }).names.tick).toBe('tickToggle')
        const pragma = generateC(compile(`#code.naming "step", "init", "logic", "ToggleData"\n${source}`))
        expect(pragma.names).toEqual({ tick: 'step', reset: 'init', logic: 'logic', struct: 'ToggleData' })
        expect(pragma.files['Toggle.c']).toContain('void init(ToggleData* d) {')
        expect(generateC(compile(source), { fileName: 'toggle_gen' }).header).toBe('toggle_gen.h')
    })

    it('lists the chart\'s variables with their members', () => {
        const g = gen('Doorbell')
        expect(g.variables.map(v => [v.name, v.member, v.ctype, v.pool])).toEqual([
            ['count', 'count', 'int', 'count'], ['button', 'button', 'char', 'button'], ['chime', 'chime', 'char', 'chime'],
            ['rings_val', 'rings_val', 'int', 'rings_val'], ['rings_curval', 'rings_curval', 'int', 'rings_curval'], ['rings', 'rings', 'char', 'rings'],
        ])
        expect(g.variables.find(v => v.name === 'button')).toMatchObject({ input: true, signal: 'presence' })
        const s = gen('Scoreboard')
        expect(s.variables.find(v => v.name === 'home.count')).toMatchObject({ member: 'home.count', pool: 'count', poolObject: 'home' })
    })

    it('carries host code through and says so', () => {
        const g = gen('Gauge')
        expect(g.hostCode).toBe(true)
        expect(g.files['Gauge.c']).toContain('d->needle = clamp(d->reading, 0, 100);')
        expect(gen('Toggle').hostCode).toBe(false)
    })

    it('reports why there is no code', () => {
        const rejected = generateC(compile('scchart Bad {\n  output int x\n  initial state A\n    immediate go to A\n}'))
        expect(rejected.ok).toBe(false)
        expect(rejected.diagnostics[0].severity).toBe('error')
        expect(rejected.files).toEqual({})
    })
})

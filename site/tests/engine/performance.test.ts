// The simulator's performance targets: a typical guide chart compiles and simulates in under 5 ms, runs at least
// 10,000 ticks per second, and the static analysis of a 50-state chart takes under 20 ms. Measured as medians;
// the assertions allow for a loaded machine (several agents and test runs share it), the log shows the numbers.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import { compileChart } from '../../src/engine/sim/compile'

const SLACK = Number(process.env.ENGINE_PERF_SLACK ?? 3)

const typical = `scchart Lamp {
  input bool press
  output bool light = false
  output int presses = 0

  initial state Off
    if press do light = true; presses++ go to On

  state On {
    int time = 0
    initial state Counting
      do time++ go to Counting
  }
    if press do light = false go to Off
}`

/** About 50 states in five superstates with entry actions, pre, signals and a weak-abort reset. */
function fiftyStates(): string {
    const out = ['scchart Bench {', '  input bool run, stop, clear', '  input int level', '  output int total = 0', '  output signal Tick', '  output signal int Load combine +']
    for (let r = 0; r < 5; r++) {
        out.push(`  region R${r} {`, `    initial state Run${r} {`, '      int c = 0')
        for (let s = 0; s < 10; s++) {
            out.push(`      ${s === 0 ? 'initial ' : ''}state S${s} {`, '        entry do c++', '      }')
            out.push(`      if run && level > ${s} do Load(${s}); total += 1 go to S${(s + 1) % 10}`)
            out.push(`      if pre(stop) go to S${(s + 2) % 10}`)
        }
        out.push('    }', `    if clear go to Run${r}`, '  }')
    }
    out.push('  region Ticker {', '    initial state T', '    do Tick go to T', '  }', '}')
    return out.join('\n')
}

function median(f: () => void, n = 15): number {
    for (let i = 0; i < 3; i++) f()
    const times: number[] = []
    for (let i = 0; i < n; i++) {
        const t0 = performance.now()
        f()
        times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    return times[Math.floor(n / 2)]
}

describe('performance', () => {
    it('compiles and simulates a typical chart in under 5 ms', () => {
        const ms = median(() => {
            const r = compile(typical)
            expect(r.ok).toBe(true)
            const s = createSimulation(r)
            for (let i = 0; i < 10; i++) s.step({ press: i % 3 === 0 })
        })
        console.log(`typical chart, compile + 10 ticks: ${ms.toFixed(2)} ms`)
        expect(ms).toBeLessThan(5 * SLACK)
    })

    it('runs at least 10,000 ticks per second', () => {
        const s = createSimulation(compile(fiftyStates()))
        const n = 5000
        const t0 = performance.now()
        for (let i = 0; i < n; i++) s.step({ run: i % 3 === 0, stop: i % 7 === 0, clear: i % 50 === 0, level: i % 12 })
        const perSecond = n / ((performance.now() - t0) / 1000)
        console.log(`50-state chart: ${Math.round(perSecond)} ticks/s`)
        expect(perSecond).toBeGreaterThan(10000 / SLACK)
    })

    it('analyses a 50-state chart in under 20 ms', () => {
        const r = compile(fiftyStates())
        expect(r.ok, r.diagnostics.map(d => d.message).join('\n')).toBe(true)
        const ms = median(() => compileChart(r.chart!, r.index), 9)
        console.log(`50-state chart, simulator compilation: ${ms.toFixed(2)} ms`)
        expect(ms).toBeLessThan(20 * SLACK)
    })
})

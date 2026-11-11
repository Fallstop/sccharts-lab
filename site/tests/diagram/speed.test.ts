// The diagram's speed target: a 30-state chart laid out and rendered well under 300 ms. In the vitest project `perf`
// (vitest.config.ts), which runs alone after the rest: inside the parallel suite wall time measures the machine's load.
import { describe, expect, it } from 'vitest'
import { layoutChart, renderSvg } from '@sccharts-lab/diagram'
import { chartOf } from './support'

function bigChart(n: number): string {
    const lines = ['scchart Big {', '  input bool a, b, c', '  output int x = 0']
    for (let i = 0; i < n; i++) {
        lines.push(`  ${i === 0 ? 'initial ' : ''}state S${i}${i % 6 === 3 ? ` {\n    entry do x = ${i}\n    initial state I${i}\n    if a go to J${i}\n    final state J${i}\n  }\n  join to S${i + 1}` : ''}`)
        if (i % 6 !== 3) {
            lines.push(`  if a && x < ${i} do x++ go to S${(i + 1) % n}`)
            if (i % 4 === 0) lines.push(`  if b go to S${(i + 7) % n}`)
            if (i % 5 === 1) lines.push(`  immediate if c do x = 0 abort to S${(i + 3) % n}`)
        }
    }
    lines.push('}')
    return lines.join('\n')
}

describe('speed', () => {
    it('lays out and renders a 30-state chart well under 300 ms', async () => {
        const { chart } = await chartOf(bigChart(30))
        await layoutChart(chart) // warm up the JIT and ELK
        // The fastest of seven runs, so that a busy machine (other test workers, oracles) does not fail the test.
        const times: number[] = []
        for (let i = 0; i < 7; i++) {
            const t0 = performance.now()
            renderSvg(await layoutChart(chart))
            times.push(performance.now() - t0)
        }
        times.sort((p, q) => p - q)
        // About 130 ms on an idle laptop (almost all of it in ELK); the budget is 300 ms.
        expect(times[0]).toBeLessThan(300)
    })
})

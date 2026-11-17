import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { readTrace, runOnSequence, writeTrace } from '@sccharts-lab/trace'

// An input sequence, written by hand: an empty cell keeps the value.
const sequence = readTrace(`tick,coin,push
1,false,false
2,true,
3,false,true
4,,false
5,true,
`, 'csv')

// Run a chart on it for six ticks.
const result = compile(readFileSync('turnstile.sctx', 'utf8'))
const { trace, notes } = runOnSequence(result, sequence, 6)
console.log(writeTrace(trace, 'csv'))
console.log(notes)

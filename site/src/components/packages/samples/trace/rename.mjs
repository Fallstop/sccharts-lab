import { readFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import {
  readTrace, renameTrace, replayTrace, suggestRenames, traceColumns,
} from '@sccharts-lab/trace'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))

// A file from someone who spells the names another way.
const file = readTrace(`tick,Coin,PUSH,un_locked
1,false,false,false
2,true,false,true
`, 'csv')

// Which of the file's names stand for which of the chart's?
const suggestions = suggestRenames(file.variables, traceColumns(result))
console.log(suggestions)

const renames = Object.fromEntries(suggestions.map((s) => [s.from, s.to]))
const outcome = replayTrace(result, renameTrace(file, renames))
console.log(outcome.state.checked, outcome.mismatches.length)

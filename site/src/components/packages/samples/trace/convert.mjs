// Only the file formats: this import does not load the engine.
import { readTrace, writeTrace } from '@sccharts-lab/trace/trace-file'

const trace = readTrace(`tick,press,count
1,false,0
2,true,1
3,true,2
`, 'csv')

const names = trace.variables.map((v) => v.name)
console.log(trace.ticks.length, 'ticks of', names)
console.log(writeTrace(trace, 'json'))

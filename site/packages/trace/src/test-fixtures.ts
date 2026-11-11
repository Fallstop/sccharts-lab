// Traces the tests share (ported from keith-vscode/test/traces.test.cjs). Test support only.

import { readTrace } from './trace-file'
import type { TraceRecord } from './trace-file'

/** A run of the Types fixture: every kind of value the data pool holds. */
export const run = (): TraceRecord => ({
    model: 'Types.sctx',
    variables: [
        { name: 'arr', role: 'input', type: 'int' },
        { name: 'f', role: 'input', type: 'float' },
        { name: 's', role: 'input', type: 'string' },
        { name: 'reset', role: 'input', type: 'bool' },
        { name: 'sum', role: 'output', type: 'int' },
        { name: 'g', role: 'output', type: 'float' },
        { name: 'hidden', role: 'local', type: 'int' },
    ],
    ticks: [
        { arr: [1, 2], f: 1.5, s: 'a "q", b', reset: true, sum: 0, g: 0, hidden: 0 },
        { arr: [1, 2], f: 1.5, s: 'a "q", b', reset: false, sum: 3, g: 3, hidden: 1 },
        { arr: [3, 4], f: 2, s: '12', reset: false, sum: 7, g: 4, hidden: 2 },
    ],
})

export const printedRun = (): TraceRecord => ({
    model: 'Camera.sctx',
    variables: [
        { name: 'snap', role: 'input', type: 'bool' },
        { name: 'busy', role: 'output', type: 'bool' },
    ],
    ticks: [
        { snap: true, busy: false },
        { snap: true, busy: true },
        { snap: false, busy: false },
        { snap: false, busy: false },
    ],
    printed: [[], ['Snapshot taken'], ['a, "quoted"', 'second line'], ['']],
})

/** Input changes at moments in seconds: a press at 0.3 s, released at 0.4 s. */
export const timedSequence = () => readTrace('time,press\n0,false\n0.3,true\n0.4,false\n', 'csv')

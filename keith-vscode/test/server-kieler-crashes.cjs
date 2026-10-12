// Charts that crash or hang the official KIELER compiler. The lab rejects exactly these charts too (official compiler
// parity), but with an error on the construct KIELER cannot compile instead of an internal compiler error, and it
// warns where it compiles a chart KIELER fails on.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')
const { java, serverArgs, sameFile } = require('./server-launch.cjs')

const SYSTEMS = {
    c: 'de.cau.cs.kieler.sccharts.netlist',
    java: 'de.cau.cs.kieler.sccharts.netlist.java',
    simulation: 'de.cau.cs.kieler.sccharts.simulation.netlist.c',
    simulationJava: 'de.cau.cs.kieler.sccharts.simulation.netlist.java',
    priority: 'de.cau.cs.kieler.sccharts.priority',
    priorityJava: 'de.cau.cs.kieler.sccharts.priority.java',
    statebased: 'de.cau.cs.kieler.sccharts.statebased',
}

// expect: 'error' (an issue with this code and message, located on `located`), 'warning' (compiles, with a
// kieler-divergence warning there) or 'compiles' (a near miss that KIELER compiles, which must keep compiling).
const CASES = [
    {
        name: 'for-region range without an end value',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'has a start value but no end value',
        located: '3',
        model: `scchart O06 {
  input bool a
  output int x[3]
  region R for i : 3 {
    initial state A
    if a do x[i] = i go to B
    state B
  }
}`,
    },
    {
        name: 'for-region range ending at a const',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'ends at N, which is not an integer literal',
        located: 'N',
        model: `scchart T {
  const int N = 2
  output int a[3]
  region R for i : 0 to N {
    initial state A
    do a[i] = 1 go to B
    state B
  }
}`,
    },
    {
        name: 'const int division by zero',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'Constant Q divides by zero',
        located: '1 / 0',
        model: `scchart T {
  const int Q = 1 / 0
  output int a = 0
  initial state A
  do a = Q go to B
  state B
}`,
    },
    {
        name: 'const string concatenation of three operands',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'chains three or more operands',
        located: '"a" + "b" + "c"',
        model: `scchart T {
  const string S = "a" + "b" + "c"
  output string x = ""
  initial state A
  do x = S go to B
  state B
}`,
    },
    {
        name: 'const float division by zero still compiles',
        systems: ['java'],
        expect: 'compiles',
        model: `scchart T {
  const float Q = 1.0 / 0.0
  output float a = 0.0
  initial state A
  do a = Q go to B
  state B
}`,
    },
    {
        name: 'during action trigger pre (u001)',
        systems: ['c', 'java', 'simulation'],
        expect: 'warning',
        code: 'kieler-divergence',
        message: 'used directly as the trigger of a during action',
        located: 'pre(x)',
        model: `scchart S {
  input bool x
  output int o = 0
  initial state A {
    during if pre(x) do o = o + 1
  }
}`,
    },
    {
        name: 'pre in print arguments (J1)',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'cannot be passed directly as an argument of print(...)',
        located: 'pre(i)',
        model: `scchart T {
  input int i
  initial state A
  do print(pre(i)) go to A
}`,
    },
    {
        name: 'portable form compiles cleanly (control, as in CS303 Task2)',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart S {
  input bool x, a
  output int o = 0
  initial state A {
    entry if pre(x) == true do o = 1
  }
  if a go to B
  state B
  if a go to A
}`,
    },
    {
        name: '@DefaultSleep without a value',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: '@DefaultSleep needs a value, e.g. @DefaultSleep 100',
        located: '@DefaultSleep',
        model: `@DefaultSleep
scchart A01 {
   input bool a
  output int x = 0
  
  initial state A
  if a do x = 1 go to B
  state B
  if !a go to A
}`,
    },
    {
        name: '#code.naming without values',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: '#code.naming needs values, e.g. #code.naming prefix',
        located: '#code.naming',
        model: `#code.naming

scchart A11 {
   input bool a
  output int x = 0
  
  initial state A
  if a do x = 1 go to B
  state B
  if !a go to A
}`,
    },
    {
        name: 'weak-suspend-without-trigger',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'This weak suspend has no trigger',
        located: 'weak suspend',
        model: `scchart P01 {
  input bool a
  output int x = 0
  initial state A {
    weak suspend
    initial state A1
    do x = 1 go to A2
    state A2
  }
  if a go to B
  state B
}`,
    },
    {
        name: 'suspend-without-trigger',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'This suspend has no trigger',
        located: 'suspend',
        model: `scchart O01 {
  input bool a
  output int x = 0
  initial state A {
    suspend
    initial state A1
    go to A2
    state A2
  }
  if a go to B
  state B
}`,
    },
    {
        name: 'triggerless-entry-during-exit-compile',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart C1 {
  input bool a
  output int x = 0, y = 0
  initial state A {
    entry do x = 1
    during do y = y + 1
    immediate during do x = x + 1
    exit do y = 0
    initial state A1
    if a go to A2
    state A2
  }
  if a go to B
  state B
}`,
    },
    {
        name: 'bool local emission (minimal model m01b)',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'b is a bool variable, not a signal, so it cannot be emitted',
        located: 'b',
        model: `scchart BoolEmitLocal {
  input signal a
  output signal o
  bool b
  initial state Idle
  if a do b go to Done
  final state Done
}`,
    },
    {
        name: 'emission in an unreachable state still compiles (condition not widened)',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart UnreachableEmit {
  input signal a
  output bool b
  initial state Idle
  if a go to Done
  final state Done
  state Never
  if a do b go to Done
}`,
    },
    {
        name: 'method without a body (Java)',
        systems: ['java'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'Method ext has no statements',
        located: 'method int ext()',
        model: `scchart O08 {
  input bool a
  output int x = 0
  method int ext()
  initial state A
  if a do x = ext() go to B
  state B
}`,
    },
    {
        name: 'empty chart - priority/statebased',
        systems: ['priority', 'priorityJava', 'statebased'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'Chart E has no states',
        located: 'scchart E',
        model: `scchart E {
}`,
    },
    {
        name: 'empty chart - netlist still compiles',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart E {
}`,
    },
    {
        name: 'two states alternating every tick',
        systems: ['statebased'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'hand control to each other on every tick',
        located: 'state B',
        model: `scchart Toggle {
  initial state A
  go to B
  state B
  go to A
}`,
    },
    {
        name: 'self-reference (t021)',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'Recursive reference: chart A uses itself (A -> A)',
        located: 'A(a, o)',
        model: `scchart A {
  input bool a
  output int o
  initial state X
  if a go to Y
  state Y is A(a, o)
}`,
    },
    {
        name: 'mutual recursion (t022)',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'chart B uses A, which leads back to B (A -> B -> A)',
        located: 'A(a, o)',
        model: `scchart A {
  input bool a
  output int o
  initial state X is B(a, o)
}
scchart B {
  input bool a
  output int o
  initial state Y is A(a, o)
}`,
    },
    {
        name: 'same chart used twice (no cycle)',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart A {
  input bool a
  output int o, p
  region R1:
  initial state X is B(a, o)
  region R2:
  initial state Y is B(a, p)
}
scchart B {
  input bool a
  output int o
  initial state P
  if a do o = o + 1 go to P
}`,
    },
    {
        name: 'diamond A uses B and C, both use D (no cycle)',
        systems: ['c', 'java', 'simulation'],
        expect: 'compiles',
        model: `scchart A {
  input bool a
  output int o, p
  region R1:
  initial state X is B(a, o)
  region R2:
  initial state Y is C(a, p)
}
scchart B {
  input bool a
  output int o
  initial state P is D(a, o)
}
scchart C {
  input bool a
  output int o
  initial state P
  if a go to Q
  state Q is D(a, o)
}
scchart D {
  input bool a
  output int o
  initial state P
  if a do o = o + 1 go to P
}`,
    },
    {
        name: 'recursive method',
        systems: ['c', 'java', 'simulation'],
        expect: 'error',
        code: 'compiler-stack-overflow',
        message: 'ran out of stack space',
        located: 'scchart T',
        model: `scchart T {
  output int x = 0
  method int fact(int n) {
    if (n <= 1) { return 1 }
    return n * fact(n - 1)
  }
  initial state A
  do x = fact(5) go to B
  state B
}`,
    },
    {
        name: 'initial final state left immediately (chart has states)',
        systems: ['priority', 'statebased'],
        expect: 'error',
        code: 'unsupported-construct',
        message: 'no state left to start in',
        located: 'scchart S',
        model: `scchart S {
  initial state P {
    initial final state F
  }
  immediate go to Q
  state Q
}`,
    },
]

async function main() {
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'sccharts-kieler-crashes-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const exited = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    const waiters = new Set()
    connection.onNotification((method, params) => {
        for (const waiter of [...waiters]) if (waiter.method === method && waiter.accept(params)) waiter.resolve(params)
    })
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    const waitFor = (method, accept, what) => new Promise((resolve, reject) => {
        const waiter = { method, accept, resolve: result => { clearTimeout(timer); waiters.delete(waiter); resolve(result) } }
        // A hang is one of the failures under test, so a compile that never finishes fails the case instead of the run.
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`No result for ${what} within 40 s\n${stderr}`)) }, 40000)
        waiters.add(waiter)
    })
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 600000)
    let sequence = 0
    try {
        await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, workspaceFolders: null })
        await connection.sendNotification('initialized', {})
        await connection.sendNotification('keith/diagnostics/configure', { enabled: false })
        for (const testCase of CASES) {
            const file = path.join(workspace, `case-${++sequence}.sctx`)
            fs.writeFileSync(file, testCase.model)
            const uri = pathToFileURL(file).href
            await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: testCase.model } })
            for (const system of testCase.systems) {
                const what = `${testCase.name} (${system})`
                const done = waitFor('keith/kicool/didCompile', result => result.finished && sameFile(result.uri, uri), what)
                await connection.sendNotification('keith/kicool/compile', { uri, command: SYSTEMS[system], clientId: 'keith-diagram_sprotty', inplace: false, showResultingModel: false, snapshot: false })
                const result = (await done).results
                const issues = result.files.flat().flatMap(stage => stage.diagnostics ?? [])
                const errors = issues.filter(issue => issue.severity === 'error')
                assert.ok(!issues.some(issue => issue.code === 'internal-compiler-error'), `${what}: ${JSON.stringify(issues)}`)
                if (testCase.expect === 'compiles') {
                    assert.deepEqual(errors, [], `${what}: KIELER compiles this, so the lab must too`)
                    continue
                }
                const found = issues.find(issue => issue.code === testCase.code && issue.message.includes(testCase.message))
                assert.ok(found, `${what}: expected ${testCase.code} "${testCase.message}" in ${JSON.stringify(issues)}`)
                assert.ok(found.hint, `${what}: the issue says how to fix the chart`)
                assert.ok(found.locations.some(location => sameFile(location.uri, uri)
                    && testCase.model.slice(location.offset, location.offset + location.length).includes(testCase.located)),
                    `${what}: located on "${testCase.located}": ${JSON.stringify(found.locations)}`)
                if (testCase.expect === 'warning') {
                    assert.equal(found.severity, 'warning', what)
                    assert.deepEqual(errors, [], `${what}: compiles`)
                } else {
                    assert.equal(found.severity, 'error', what)
                }
            }
            await connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
            const outcome = { error: 'is a located compile error', warning: 'compiles with a divergence warning', compiles: 'still compiles' }[testCase.expect]
            console.log(`KIELER crash: ${testCase.name} ${outcome} on ${testCase.systems.join(', ')}.`)
        }
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await exited
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
}

main().catch(error => { console.error(error); process.exit(1) })

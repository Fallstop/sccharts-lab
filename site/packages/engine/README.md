# @sccharts-lab/engine

An SCCharts compiler and simulator in TypeScript. It parses SCTX (the textual SCCharts language), accepts and rejects
charts exactly as KIELER's compiler does, with diagnostics written for people learning the language, runs a chart tick
by tick with KIELER's semantics, and generates C code in the shape of KIELER's netlist-based compilation. Pure
TypeScript with no dependencies and no DOM access: it runs in browsers, in Web Workers and in Node 20+.

It is the engine of [SCCharts Lab](https://sccharts.jmw.nz), whose interactive guide and in-browser IDE run every
example on it.

```sh
npm install @sccharts-lab/engine
```

## Quick start

```js
import { compile, createSimulation, describeTick, generateC } from '@sccharts-lab/engine'

const result = compile(`
scchart ABRO {
  input signal A, B, R
  output signal O

  initial state ABO {
    initial state WaitAB {
      region HandleA {
        initial state WaitA
          if A go to DoneA
        final state DoneA
      }
      region HandleB {
        initial state WaitB
          if B go to DoneB
        final state DoneB
      }
    }
    do O join to Done

    state Done
  }
  if R abort to ABO
}`)

if (!result.ok) throw new Error(result.diagnostics.map(d => d.message).join('\n'))

const simulation = createSimulation(result)
for (const inputs of [{}, { A: true }, { A: false, B: true }, { B: false }]) {
  const tick = simulation.step(inputs)             // inputs keep their value until changed, as in KIELER
  console.log(tick.values, describeTick(tick, result.program).join(' '))
}
// { A: false, B: false, R: false, O: false } The chart starts in WaitA and WaitB.
// { A: true, B: false, R: false, O: false } WaitA went to DoneA because A was present. A was present.
// { A: false, B: true, R: false, O: true } WaitB went to DoneB because B was present. WaitAB finished and joined to Done immediately. B and O were present.
// { A: false, B: false, R: false, O: false } No transition fired: ABO waits for R.

const c = generateC(result)
console.log(Object.keys(c.files), c.names)
// [ 'ABRO.h', 'ABRO.c' ] { tick: 'tick', reset: 'reset', logic: 'logic', struct: 'TickData' }
```

## API

`compile(source, options?)` parses, resolves and validates a file the way KIELER's front end does, then compiles the
first `scchart` in it (or `options.chart`) for simulation. It never throws. `options.files` holds other files by name
for `import`. The result:

| Field | |
| --- | --- |
| `ok` | false exactly when KIELER rejects the chart (the reasons are errors in `diagnostics`) |
| `diagnostics` | `{ severity, code, message, hint, kieler, span, related, suggestion }`: a stable `code`, a beginner's message and hint, KIELER's own words in `kieler`, the source span and the ids of the elements involved |
| `program`, `chart` | the parsed model (`Program`) and the simulated root `State`, also when `ok` is false (for diagrams) |
| `interface` | the variables of KIELER's simulation interface: inputs, outputs and top-level locals, with types and initial values |

The simulator's compilation (KIELER's transformations, causality and instantaneous-loop analysis) runs lazily, on the
first read of `ok`, `diagnostics` or `sim`; reading only `program` and `chart` stays cheap.

`createSimulation(result, { strict? })` gives a `Simulation`: `step(inputs?)` runs one tick (missing inputs keep their value; with `strict: true` a name that is no input of the chart, a typo, throws with the input it most likely meant) and
returns a `SimTickResult` with `values` (by interface name), `pool` (KIELER's data pool, KIELER's names), `active`,
`entered`, `exited` (state ids), `taken` (transition ids in firing order), `printed`, `terminated`, and `error` for a
runtime failure such as a division by zero. `history`, `reset()`, `rewind(tick)` and `takenCounts(tick)` (KIELER's
`taken` array) complete it. For a rejected chart every `step()` returns the first error.

`describeTick(tick, program, previous?, { markdown? })` says in plain English what happened in a tick;
`elementName(id, program)` names any state, transition, region or action id. `traceableVariables(result)` lists what
a timing diagram can show, inner locals included.

`generateC(result, options?)` returns `{ ok, files, header, source, names, variables, diagnostics, ... }`: `<Chart>.h`
with the `TickData` struct and `<Chart>.c` with `reset`, `logic` and `tick`, using KIELER's member names (`S`,
`S_val`, `_g<n>` guards, `_GO`, `_TERM`). Options: `naming` (`'prefix'`, `'suffix'` or explicit names, as KIELER's
`#code.naming`), `takenTransitions` (KIELER's `_taken_transitions` counters), `comments`, `fileName`. Host code
(backticks, `extern`, `#hostcode`) is carried into the C code.

`parse(source)` reads a file without compiling it; `parseExpression(source)` reads one expression or effect with
KIELER's grammar.

### Entry points

| Import | What |
| --- | --- |
| `@sccharts-lab/engine` | everything above, and the model's types (`State`, `Transition`, `Diagnostic`, `TickResult`, `Value`, ...) |
| `@sccharts-lab/engine/types` | the model's types alone |
| `@sccharts-lab/engine/format` | KIELER's label serialisers: `formatExpression`, `formatEffect`, `formatTransition`, `formatDeclaration`, ... (what its diagrams print) |
| `@sccharts-lab/engine/lexer` | `lex` and `KEYWORDS`, for syntax highlighters, without the compiler |
| `@sccharts-lab/engine/internal` | for the other `@sccharts-lab` packages only; no compatibility promise |

## Verification

- **Simulation:** more than 1,200 runs recorded from KIELER's own compiler and simulator (every example of the guide
  and a conformance suite that pins down each semantic rule) replay tick by tick with the same data pool, the same
  taken transitions and the same termination; charts KIELER rejects are rejected.
- **Differential fuzzing:** about 10,000 random charts compiled and run by both, agreeing on acceptance and on every
  tick.
- **Front end:** the diagnostics of the KIELER wiki's examples, lab exercises and some 230 parser probes match KIELER's.
- **C code:** the generated C of every recorded scenario and of thousands of fuzz charts is compiled with gcc and run,
  and every tick's data pool, printed output and taken counters equal the engine's and KIELER's recording.

## License and credit

SCCharts and KIELER are developed by the [Real-Time and Embedded Systems group](https://rtsys.informatik.uni-kiel.de)
at Kiel University. This engine reimplements KIELER's SCCharts compiler: its transformations, scheduling, simulation
and C code generation are ported from KIELER's EPL-2.0 sources, so it is a derivative work of KIELER and is licensed
under the [Eclipse Public License 2.0](./LICENSE). SCCharts Lab is an independent project, not affiliated with or
endorsed by Kiel University.

Source: [github.com/Fallstop/sccharts-lab](https://github.com/Fallstop/sccharts-lab/tree/main/site/packages/engine).

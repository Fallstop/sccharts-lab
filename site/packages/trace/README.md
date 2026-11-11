# @sccharts-lab/trace

Simulation traces for SCCharts: save a run, replay a trace into a model, compare runs. KIELER's KTrace format, plus
CSV, JSON and XML, the same files as the SCCharts Lab VS Code extension (Save, Replay and Compare in its trace drawer),
for runs of the in-browser engine [@sccharts-lab/engine](https://www.npmjs.com/package/@sccharts-lab/engine). A trace
saved here and one the extension saves for the same run on KIELER's own simulator are the same file. No DOM and no Node
APIs: it runs in browsers and in Node 20+.

```sh
npm install @sccharts-lab/engine @sccharts-lab/trace
```

## Quick start

```js
import { compile, createSimulation } from '@sccharts-lab/engine'
import { readTrace, replayTrace, traceFromRun, writeTrace } from '@sccharts-lab/trace'

const result = compile(`
scchart Beeper {
  input bool press
  output int count = 0
  output signal int beep

  initial state Idle
    if press do count++; beep(count); print("beep", count) go to Idle
}`)
const simulation = createSimulation(result)
for (const press of [false, true, true, false]) simulation.step({ press })

const trace = traceFromRun(result, simulation, { model: 'Beeper.sctx' })
console.log(writeTrace(trace, 'ktrace'))
// // Beeper.sctx: 4 ticks, saved by SCCharts Lab
// press = false => beep = false beep_val = 0 count = 0;
// press = true => beep = true beep_val = 1 count = 1; // printed "beep 1"
// => beep_val = 2 count = 2; // printed "beep 2"
// press = false => beep = false;
const csv = writeTrace(trace, 'csv')

// Replay the file into a fresh simulation: every output it holds is checked.
const outcome = replayTrace(result, readTrace(csv, 'run.csv'), { label: 'run.csv' })
console.log(outcome.mismatches)   // []
```

The format code, comparison, replay matching, timed sequences and renames are ported from the extension
(`keith-vscode/src/simulation/trace-*.ts`, with its tests); `engine.ts`, `engine-replay.ts` and `engine-sequence.ts`
connect them to the engine.

## API

```ts
import { compile, createSimulation } from '@sccharts-lab/engine'
import {
    traceFromRun, writeTrace, readTrace, inputsOnly, replayTrace, compareRuns, compareTraces,
    comparisonMarkdown, TRACE_FORMATS,
} from '@sccharts-lab/trace'

const result = compile(source)
const simulation = createSimulation(result)
simulation.step({ press: true })
// ...

// Save: the run so far (to the first runtime error), in KTrace, CSV, JSON or XML.
const trace = traceFromRun(result, simulation, { model: 'Beeper.sctx' })
const text = writeTrace(trace, 'csv')                 // TRACE_FORMATS has label and extension per format
const sequence = writeTrace(inputsOnly(trace), 'ktrace')   // an input sequence for another model

// Replay: a file into a fresh simulation (or `simulation` to go on from its current tick).
const file = readTrace(text, 'run.csv')               // a format, or a file name with its extension
const outcome = replayTrace(result, file, { label: 'run.csv' })
outcome.mismatches        // every checked output that differs: { tick, name, expected, actual }
outcome.state             // ReplayState: progress, checked, ignored, unset, firstMismatch, problems, notes
outcome.run               // the replayed run as a trace

// Compare: runs (the first is the reference), or traces read from files.
const comparison = compareRuns([
    { label: 'Mine', result, run: simulation },
    { label: 'Solution', result: other, run: otherSimulation },
])
const report = comparisonMarkdown(comparison)        // comparisonCsv(comparison): every value change
```

| Export | What |
| --- | --- |
| `traceFromRun(result, run, { model?, inputs? })` | A `TraceRecord` of a `Simulation` (or its `history`): KIELER's data pool after each tick and the printed lines. Ends before the first tick with a runtime error. `inputs: 'read'` records the inputs as the ticks read them (`ranWith`) instead of the pool's (see Replay) |
| `traceColumns(result)` | The columns `traceFromRun` gives: name, role (`input`, `output`, `local`), KIELER's type |
| `poolVariables(result)` | KIELER's data pool for the chart in KIELER's order, with input/output flags, dimensions and `late` (not in the pool before tick 1) |
| `writeTrace(trace, format)` / `readTrace(text, formatOrFileName)` | The four formats. `readTrace` throws `TraceFileError` with the line and the reason |
| `inputsOnly(trace)` | The inputs alone: an input sequence |
| `replayTrace(result, trace, options)` | Replays the whole file and reports. Options: `label`, `checkOutputs` (default true), `renames` (file name → model name), `simulation`, `stopAtMismatch`, `model` |
| `SimulationReplay` | Step by step, for a UI: `step()` (one tick: `{ tick, inputs, mismatches, pause }`), `run(stop?)`, `rewindTo(tick)`, `state()`, `done`, `error`; `replay` is the underlying `TraceReplay` (`driven`, `ignored`, `unset`, `checked`, `mismatchesOf(name)`) |
| `replayTargets(result)` | The model's variables as `TraceReplay` targets |
| `suggestRenames(fileVariables, traceColumns(result), aliases?)` | Names spelled alike (`NS_Green` and `nsGreen`) or matched before; `renameTrace`, `rememberAliases`, `forgetAliases`, `couldMatch`, `unmatched`, `describeRenames` |
| `runOnSequence(result, sequence, ticks, { label?, model? })` / `runOnTimedSequence(result, sequence, until, { mode? })` | The extension's "Run models on a sequence" without its dialogs: a fresh simulation on an input sequence for a number of ticks, or on a timed sequence for a number of seconds (a model with `deltaT` as its clock asks, another one as `mode` says); the trace and the notes for the report |
| `compareTraces(named)` / `compareRuns(runs)` | Tick by tick, or moment by moment when the traces have times; value changes lined up with their shift; printed lines too |
| `comparisonMarkdown(comparison, { maxRows?, preamble? })` / `comparisonCsv(comparison)` | The extension's reports |
| `TimedSchedule`, `timedEvents` | Ticks of a run on a timed sequence (a CSV with a `time` column and no `deltaT`): `clock`, `timer` or `events` |
| `traceTimes`, `timeDeltaOf`, `sameTraceValue`, `formatTraceValue`, `traceFormatOf`, `coerceInput` | Helpers |

## What a trace holds

The extension's columns are the variables of KIELER's data pool, so `traceFromRun` gives the same:

- **Names** are KIELER's: inputs, outputs and the chart's own locals; a valued signal `V` as `V` (presence), `V_val`
  (value, with V's role) and `V_curval` (local); `deltaT` and `sleepT` of a timed chart; clocks; a class or struct
  instance as one column holding an object; hoisted statics under KIELER's name. Not the compiler's helpers (`_` and
  `#` names). KIELER's `#interface` also lists the member declarations of classes and structs (`Counter.count`,
  `Point1.x` for a type moved out of an inner state, `C1.field` for a chart used as a class); the extension shows them
  as columns that never have a value, and so does the trace.
- **Order**: KIELER's `VARIABLE_ORDER` (inputs, in-outs, outputs, the rest; by name within each), the variables
  missing from the pool before tick 1 after the others (strings without a value, member declarations), then inputs,
  outputs and locals. Members of an instance are in name order, as KIELER sends them.
- **Types**: KIELER's type names (`bool` for a signal's presence, `int` for an enum, `float` for a clock).
- **Values**: the pool after each tick. A name the pool leaves out (an unset string) keeps its last value.

## Formats

The run of `if press do count++; beep(count); print("beep", count)` for four ticks, in each format.

**KTrace** (`.ktrace`), KIELER's format, written the way KIELER writes it and loaded by the official tools: one tick
per line, inputs, `=>`, outputs, each only when it changed; floats with a point; `reset`, `pause` and `goto` as names
escaped with `^`. Locals have no place in KTrace, printed lines go in a comment KIELER skips.

```
// Beeper.sctx: 4 ticks, saved by SCCharts Lab
press = false => beep = false beep_val = 0 count = 0;
press = true => beep = true beep_val = 1 count = 1; // printed "beep 1"
=> beep_val = 2 count = 2; // printed "beep 2"
press = false => beep = false;
```

Reading takes the literal part of KTrace: comments, `#` pragmas, named ticks, `pause`, `reset;` between traces (the
first is used); not `goto` or single array elements.

**CSV** (`.csv`): a row per tick, `tick`, `time` (with `deltaT`: the running sum), `printed` (when anything printed:
the tick's lines in one cell), then a column per variable. No roles. An empty cell keeps the row before's value
(`""` is the empty string), so a hand-written sequence only notes changes; a sequence with `time` and no `deltaT`
is timed.

```
tick,printed,press,beep,beep_val,count,beep_curval
1,,false,false,0,0,0
2,beep 1,true,true,1,1,1
3,beep 2,true,true,2,2,2
4,,false,false,2,2,2
```

**JSON** (`.json`): `format: "sccharts-lab-trace"`, `version`, `model`, the variables with role and type, then one
line per tick with `inputs`, `outputs`, `locals` (`values` for an unknown role), `time` and `printed`. Ticks may be
sparse when written by hand; a bare array of ticks is read too.

```json
{
  "format": "sccharts-lab-trace",
  "version": 1,
  "model": "Beeper.sctx",
  "variables": [
    { "name": "press", "role": "input", "type": "bool" }, ...
  ],
  "ticks": [
    {"tick":1,"inputs":{"press":false},"outputs":{"beep":false,"beep_val":0,"count":0},"locals":{"beep_curval":0}},
    {"tick":2,"printed":["beep 1"],"inputs":{"press":true},"outputs":{"beep":true,"beep_val":1,"count":1},"locals":{"beep_curval":1}},
    ...
  ]
}
```

(The file lists each variable over several lines; shortened here.)

**XML** (`.xml`): `<trace format="sccharts-lab-trace" version="1" model="...">`, a `<variable name role type/>` per
variable, then `<tick n="1" time="...">` with `<input>`, `<output>`, `<local>` (or `<value>`) elements and a
`<printed>` per line.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<trace format="sccharts-lab-trace" version="1" model="Beeper.sctx">
  <variable name="press" role="input" type="bool"/>
  ...
  <tick n="2">
    <input name="press">true</input>
    <output name="beep">true</output>
    <output name="beep_val">1</output>
    <output name="count">1</output>
    <local name="beep_curval">1</local>
    <printed>beep 1</printed>
  </tick>
  ...
</trace>
```

## Replay

As the extension's Replay: the file's first row drives the next tick. Its inputs are matched to the model's by name
(after `renames`) and converted to the model's types (`"12"` for a string input, `0`/`1` for a bool); inputs the
model lacks are `ignored`, the model's inputs the file does not set are `unset` and keep their values. After each
tick the file's outputs that the model also has are `checked` (a CSV, without roles: every column that is an output of
the model). KTrace `pause` sets `ReplayStep.pause`; the extension's Run stops there, at the end of the file and at
the first mismatch (`run(step => step.pause || step.mismatches.length > 0)`).

A trace holds each input as the pool has it after the tick. Where the chart writes its own input (basics.md B-10,
or an array index past the end), that is not what the tick read, and replaying the trace does not give the run
again, in the extension as here. `traceFromRun(..., { inputs: 'read' })` records what each tick read; that trace
replays such a run exactly (it is no longer the extension's file).

## Entry points

| Import | What |
| --- | --- |
| `@sccharts-lab/trace` | everything above |
| `@sccharts-lab/trace/trace-file` | the four formats: `readTrace`, `writeTrace`, `inputsOnly`, `TRACE_FORMATS`, ... |
| `@sccharts-lab/trace/trace-compare`, `/comparison-report` | `compareTraces`; `comparisonMarkdown`, `comparisonCsv` |
| `@sccharts-lab/trace/trace-replay`, `/trace-rename`, `/trace-timing` | `TraceReplay`, name matching, timed sequences |

The subpaths do not load the engine: a tool that only reads, writes or compares trace files (such as the VS Code
extension, whose runs come from KIELER's simulator) can import them alone.

## Verification

Every recorded KIELER run in the SCCharts Lab repository (the guide's examples and the conformance suites) is run on
the engine and saved: the trace has the columns and values the extension builds from KIELER's simulator, the four
files are byte for byte the extension's, and each reads back as the run and replays without a mismatch. Against the
lab's KIELER server, KIELER's saved KTrace matches the engine's run, printed lines included, and the engine's KTrace
loads in KIELER's own parser.

## License and credit

SCCharts, KIELER and the KTrace format are developed by the
[Real-Time and Embedded Systems group](https://rtsys.informatik.uni-kiel.de) at Kiel University. This package ports the
trace code of the SCCharts Lab VS Code extension, a fork of KIELER's VS Code extension, and is licensed under the
[Eclipse Public License 2.0](./LICENSE). SCCharts Lab is an independent project, not affiliated with or endorsed by
Kiel University.

Source: [github.com/Fallstop/sccharts-lab](https://github.com/Fallstop/sccharts-lab/tree/main/site/packages/trace).
Tests (in the repository): `pnpm exec vitest run packages/trace tests/trace`.

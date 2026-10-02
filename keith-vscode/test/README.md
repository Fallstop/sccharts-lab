Run the regression suite from `keith-vscode` with `npm test` (Node 18 or newer).
It covers simulation sequencing and failures, compiler progress, numeric input,
and DOM interactions using the existing TypeScript sources and a mocked VS Code host.

Run `npm run test:server` to exercise the bundled Java language server with the
small SCCharts fixture: compile, start, change boolean and uninitialized string
inputs, step, stop, and restart.
It also checks the full broken demo's scheduler cycle and exact source ranges,
the subsequent C array error and working element-copy quick fix, embedded C errors,
and recovery after failures. It requires Java 21, `gcc`, and `server/sccharts-lite-server.jar`
(`npm run build:server`). Set `SCCHARTS_SERVER_DIR` to a directory holding another
`sccharts-lite-server.jar` to test a different build, and `SCCHARTS_JAVA` to the launcher the
server should run on; `npm run build:jre` followed by
`SCCHARTS_JAVA=server/jre/bin/java npm run test:server` exercises the bundled runtime image
with exactly the modules that ship in the platform packages.

`node test/server-compiler-recovery.cjs` covers empty and malformed models, unresolved
states and variables, missing initial states, unknown compilation systems, cancellation,
multiple open models receiving live diagnostics and successful compilation after failures.
It also checks that internal compiler exceptions keep their processor, source and stack trace.

The server suite also generates C and Java through the real protocol, checks that source
files stay in memory, compiles exported fixtures with GCC and `javac`, and exercises invalid
input, incompatible host code, scheduler failure and recovery. Run `node test/server-codegen.cjs`
for just these checks. Client tests cover virtual preview lifetime,
Save As, grouped export, overwrite protection, save errors, cancellation and stale builds.

`node test/server-compile-ide.cjs` checks the per-processor progress notifications and the
timings in `didCompile` (order, status, skipped stages after a failure), and the SCTX editor
services on `test/fixtures/hover.sctx`: hover cards for declarations, references, states,
regions, transitions and actions, definition and reference ranges, and the hierarchical
outline. `test/compile-progress.test.cjs` covers the status bar and stage picker formatting.

Client tests cover diagnostic invalidation during edits, cancellation, restart,
file switching, source mapping, diagram trace selection, and the error panel.

`node test/server-startup.cjs` (part of `test:server`) exercises the AppCDS startup cache
against the real server: recording the class list, dumping the archive, starting from it
(the JVM must report `sharing`), a damaged archive being skipped with a warning while stdout
stays a clean LSP stream, and the crash guard. `test/startup-cache.test.cjs` covers the key
and state logic without a JVM.

`node test/server-cursor-sync.cjs` drives `keith/diagram/cursor` against the real server:
expand and focus modes, transitions and declarations, refused offsets and clients, the
diagram-to-editor reveal, and the snapshot guard. `test/cursor-sync.test.cjs` covers the
client's debounce, skip rules and de-duplication.

`node test/server-live-diagnostics.cjs` opens `broken-demo.sctx` without ever compiling and
checks the `keith/diagnostics/live` notifications: the scheduling cycle with exact ranges and
the analyzer's own message, the cycle clearing after an edit, a burst of edits yielding one
result for the last version, a syntax-broken document clearing the live issues, the
configure/analyze notifications, closing the document, and the shared-clock and inheritance
fixtures. It prints the cold and warm analysis times. `test/live-diagnostics.test.cjs` covers
the client's version checks, precedence of compile reports, configuration and clearing.

Build and check the extension with `npm run build`, `npm run lint`, and:

```sh
../node_modules/.bin/tsc --noEmit -p tsconfig.json
../node_modules/.bin/tsc --noEmit -p tsconfig.webview.json
```

`node test/server-workspace-kico.cjs` starts the server on a workspace with good, broken,
duplicate and root-level `.kico` files plus a folder outside the workspace: it checks that the
systems are listed with their source file, compile a model to C, are diagnosed on the file,
follow saved and unsaved edits, and disappear on delete. `test/workspace-systems.test.cjs`
covers the compile menu grouping, selection by id, the folders parameter and the messages.

`node test/server-simulation-debug.cjs` drives the simulation debugger through the protocol
with `test/fixtures/debug-counter.sctx`: state and condition breakpoints (accepted and
rejected), watch values across ticks, run to breakpoint, the tick history and a rewind whose
replayed pool must equal the earlier tick's. `test/simulation-debug.test.cjs` covers the client:
per-model persistence, breakpoint pauses of a running simulation, trace trimming after a rewind,
the commands, and the preview's breakpoint list, watch chips and rewindable tick headers.

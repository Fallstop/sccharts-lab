# Change Log

All notable changes to the "keith-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.9.3] - 2026-09-16

- **Simulating a model no longer fails on the diagram beside it.** Starting a simulation also
  refreshes the diagram, and when no open diagram matched the model the refresh threw
  `NullPointerException ... KGraphDiagramServer.getSourceUri()`, which surfaced as "An error
  occurred during simulation start" on a model that compiles and simulates perfectly well. The
  diagram is now found under either spelling of its URI -- diagrams are keyed by the client's,
  which percent-encodes a path with spaces, while the simulation carries the decoded one -- a model
  with no diagram open simply skips the refresh, and a refresh that fails can no longer take down
  the start, step or stop that triggered it. Closing a preview now also drops its view context
  under either spelling instead of leaving a stale one behind.
- **The language server is ended when the window closes or the server is restarted.** The client
  only asked the server to exit, so one that was busy compiling or simulating outlived the window
  and kept its whole JVM heap until the machine was rebooted, once more for every restart. The
  server is now ended for good, together with the compilers and simulations it started, and a
  restart whose shutdown timed out kills the old server and starts again instead of leaving a dead
  client behind.
- **A hanging compiler probe no longer freezes the window.** Looking for `gcc` runs before every
  build; `which` and `xcode-select` now give up after five seconds so a dead network mount cannot
  block the extension host.

## [0.9.2] - 2026-09-12

- **Shorter messages.** Popups and diagnostic hints (instantaneous loops, scheduling cycles,
  shared clocks, redeclared variables, missing Java or C compilers) are cut to one or two lines.
- **A quieter preview toolbar.** Icon buttons for Restart, Back, Step, Run and Stop, the tick,
  one speed slider (the value is its tooltip), a **Breakpoints** toggle with the count and a
  **Trace** toggle. **Continue** is the `C` key. **Stages** and **Code** stay in the editor title
  only. Saving and loading a trace and the **Generated** toggle moved into the trace drawer, next
  to what they act on.
- **Completion in the breakpoint and watch fields.** The state field completes against the
  model's states (type a few letters, Enter takes the first match); condition and watch
  expressions complete the word at the caret with the simulation's variables and `pre(`.
- **Shorter hover cards for variables.** The card shows the declaration as written, its comment,
  and how it is used ("Written 8 times, never read."); the kind, type, initial value and root
  scope are no longer repeated in prose.
- **Completion for SCTX.** Keywords carry a one-line summary and a Markdown card
  (`go to` is a weak abort, `pre(x)` reads the previous tick); triggers and effects propose
  the variables, signals and clocks in scope with their declaration kind and comment, and
  `go to`, `abort to` and `join to` propose the states of the enclosing region. `scchart`,
  `state`, `initial state`, `region`, `if ... go to` and `entry do` also come as snippets
  with tab stops. A half-typed keyword inside a state body and a variable inside a trigger
  used to return nothing at all; bare operators such as `%`, `>>>` and `Pr=` are gone.
- **Input edits register while the simulation runs.** The trace table was rebuilt from scratch
  on every tick, so a click whose press and release straddled a tick landed on two different
  buttons and did nothing, and the Generated, Save and Load buttons had the same problem. Rows,
  their Next controls and the drawer tools are now created once and updated in place; a switch
  shows the sent value at once so a second click toggles again before the server answers. The
  breakpoint popover and the watch field are likewise left alone by ticks that change nothing
  they show.
- **Picking a state from the breakpoint list no longer closes the popover.** The chosen entry
  removed itself from the list in its own mousedown handler, so the popover's outside-click check
  saw a detached target and closed. The check now uses the event's path as it was when the mouse
  went down.
- **Watch expressions moved to the top line of the trace drawer,** next to the Generated, Save
  and Load buttons; the tick summary (inputs, outputs, changed variables) sits directly above the
  table it describes.
- **Warnings are optional.** The preview's "Compiled with N warnings" panel has a **Hide
  warnings** button and, once hidden, reads "Compiled, N warnings hidden" next to **Show
  warnings**. The lightbulb on any KIELER warning offers **Hide KIELER warnings**;
  **Hide Compiler Warnings** and **Show Compiler Warnings** are in the Command Palette and an
  SCChart's editor title and context menus; while warnings are hidden a status bar item counts
  them for the active model and shows them again on click. All of these set
  `keith-vscode.diagnostics.showWarnings`, which keeps the compiler's warnings out of the editor
  both from a compile and from the live analysis; errors always show.
- **Code is back on the preview toolbar.** The editor-title entry only shows while the `.sctx`
  text editor is active, which left no way to generate code from the preview.
- **State breakpoints fire on entry only.** A breakpoint on a state that merely stayed active
  paused the simulation on every tick, because the server's state tracker compared the active
  states against a set that never held them.
- **No popup at the start of a compilation.** The "Compiling ... with ..." notification is gone;
  the status bar shows the progress.

## [0.9.1] - 2026-09-12

- **A click in the editor no longer pulls the cursor onto the state's name.** Sprotty fires its
  diagram selection listener for selections the server sends as well as for clicks, so the cursor
  sync's selection was answered with `diagram/openInTextEditor` and moved the editor cursor onto the
  selected element. Cursor-driven selections are now marked `preventOpenSelection`; clicking in the
  diagram still reveals the source when `keith-vscode.diagram.selectText` is on. The server cursor
  suite checks that no reveal follows a cursor request.
- **A running simulation keeps your zoom.** Every tick relays the diagram out to move the
  highlighting, and klighd-core refits the diagram after each model update because "Resize To Fit
  on Refresh" defaults to on and has had no switch since the sidebar went. Model updates that arrive
  while a simulation is running are now applied without the refit, so the viewport stays where you
  put it; the first layout after start and everything outside a simulation fit as before.

## [0.9.0] - 2026-09-11

- **Diagnostics while typing.** Open SCCharts are analysed after every edit (debounced,
  `keith-vscode.liveDiagnostics.debounceMs`, default 400 ms) through a new server-side
  system, `de.cau.cs.kieler.sccharts.live.analysis`, that runs the netlist chain as far as the
  scheduler and generates no code. Scheduling cycles, instantaneous loops and the other
  located findings appear as **KIELER · live** squiggles without pressing Compile; a compile
  report for the same document version takes precedence. `keith-vscode.liveDiagnostics.enabled`
  turns it off. Protocol: `keith/diagnostics/live` (server → client),
  `keith/diagnostics/configure` and `keith/diagnostics/analyze` (client → server).
- **Messages come from the analyzer that knows the cause.** The loop analyzer and the guard
  scheduler now emit structured issues themselves, naming the variables involved
  (`Circular dependency involving timeout_update prevents scheduling this tick.`); the
  extension no longer rewrites messages after the fact. The timed-automata expansion explains a
  clock shared between concurrent regions, the inheritance processor explains redeclared
  variables and regions, and the loop analyzer explains a sequential region re-entered in the
  same tick, each at its source range with a hint. Every other compiler message that names a
  model element now keeps its source location through the copies the compiler makes.

- **Simulation breakpoints, watch expressions and stepping back.** A breakpoint pauses the
  simulation when a state is entered (`Full`, or `Counter.Counting.Full` when names repeat) or
  when a condition over the variables holds after a tick (`count >= 3 && !done`, `pre(x) != x`
  reads the previous tick). **Continue** runs to the next breakpoint on the server; **Run**
  stops on one too. Watches show an expression's value after every tick, with the reason when
  it cannot be evaluated. **Back**, `Backspace`, or a click on an earlier tick rewinds the
  simulation for real: the program is restarted and the recorded inputs are replayed up to
  that tick (a few milliseconds for hundreds of ticks), so trace, diagram and watches match and
  stepping forward with a changed input takes a different path. Breakpoints and watches are
  remembered per model. New commands **Add simulation breakpoint...** (pick a state or type a
  condition), **Add simulation watch expression...**, **Step back one tick** and **Run to
  breakpoint**. Server methods `keith/simulation/setBreakpoints`, `setWatches`,
  `runToBreakpoint`, `pause`, `history`, `stepBack` and `states`; step messages carry `step`,
  `watches` and `breakpoint`; `keith/simulation/paused` announces a hit.
- **The diagram follows the editor cursor.** Moving the cursor in an SCChart expands the
  regions around it in the open diagram and selects the state, region or transition under it,
  as the Eclipse editor's smart collapse did. `keith-vscode.diagram.followCursor` chooses
  `focus` (default), `expand` (also collapse the regions the cursor is not in, unless you
  expanded them yourself) or `off`; **Reveal Cursor in Diagram** does it once from the palette
  or the editor context menu. Selecting an element in the diagram selects its text in the editor
  (`keith-vscode.diagram.selectText`). The server answers `keith/diagram/cursor` by mapping the
  offset to the model element and relaying out; it leaves compiler snapshots alone.
  The reverse direction (a click in the diagram selecting the source text) is upstream sprotty
  behaviour that is now switched on; on the Windows CI runners it is intermittently silent, so the
  server suite only warns about it there.
- **Hover cards, outline and timings from the language server.** Hovering a variable, signal,
  state, region, transition or action in an SCChart shows a Markdown card built from the model:
  declaration, type, initial value, scope, write/read counts, the comment above it, a state's
  regions and transitions, a transition's priority and preemption. Go to Definition, Find All
  References and Rename already worked and stay; the Outline now shows simple names with element
  kinds and details (`input bool`, `initial state`, `controlflow region, 2 states`) instead of a
  flat list of dotted paths. The compiler reports each processor as it starts
  (`keith/kicool/progress`) and, in `didCompile`, every processor's duration, start time and
  status, the total wall time and the stages that never ran; the status bar names the running
  processor and the compile time, and **Stages** shows each stage's duration and flags the
  slowest.
- **Compilation systems from the workspace.** Every `.kico` file in the workspace (outside
  build and dependency folders) is loaded by the language server and listed under a
  **Workspace** heading in **Compile current model with...**, with the file it comes from; saving
  the file, or editing it in the editor, replaces the system at once and deleting it removes the
  entry. Errors show as squiggles in the `.kico` editor and as a warning: syntax errors, unknown
  processor or system ids, and ids that shadow a built-in system. New command **New compilation
  system (.kico) in workspace** writes a commented template; new setting
  `keith-vscode.compilationSystems.folders` adds directories outside the workspace. `.kico` is
  now a language of the extension, served by the language server. This replaces the
  Eclipse-only system registration that the sccharts-lite server dropped.
- **The language server starts a third faster after the first two starts.** It now runs from
  an AppCDS archive built on your machine: start 1 records the loaded classes
  (`-XX:DumpLoadedClassList`), a detached low-priority `java -Xshare:dump` builds the archive
  (about 3 s, 65 MB under the extension's global storage, keyed to the exact jar and Java
  binary) when that server exits, and later starts map it with `-XX:SharedArchiveFile`,
  `-Xshare:auto` and `-XX:+VerifySharedSpaces`. The archive has to be built there because five
  of the six bundled runtimes are cross-linked and `jlink --generate-cds-archive` and
  `-XX:+AutoCreateSharedArchive` both need the target JVM to run. JVM logging now goes to
  stderr (`-Xlog:disable -Xlog:all=warning:stderr`): HotSpot prints its warnings to stdout,
  the LSP channel, and one `[warning][cds]` line was enough to stall the protocol. Without
  `VerifySharedSpaces` a damaged archive crashes the JVM (SIGSEGV) instead of being skipped. A
  crash within 20 s of a start with the archive discards it. New command **Clear language
  server startup cache**, new setting `keith-vscode.startupCache.enabled`, cache state in
  **Show Java runtime and C compiler in use**. Measured with `scripts/measure-startup.cjs`
  (medians of five starts, `test/fixtures/audit.sctx`, bundled Temurin 21.0.12.1 image):

  | configuration | initialize | compile menu ready | compile | RSS |
  |---|---|---|---|---|
  | as before | 1533 ms | 2578 ms | 498 ms | 699 MB |
  | `-XX:+AutoCreateSharedArchive` (dynamic) | 1525 ms | 2583 ms | 490 ms | 704 MB |
  | static archive (shipped) | 993 ms | 1815 ms | 486 ms | 564 MB |
  | static + `-XX:TieredStopAtLevel=1` | 853 ms | 2032 ms | 436 ms | 250 MB |
  | static + `-Xss512k` | 1104 ms | 2106 ms | 540 ms | 561 MB |

  The dynamic archive does nothing on the jlink image (no base archive). C1-only starts
  150 ms sooner and halves memory but warm compiles settle at 240 ms instead of 142 ms
  (six compiles of `broken-demo.sctx` in one session), so it stays off; `-Xss`, Serial and
  Parallel GC, `-XX:CICompilerCount=2` and `-Xmx2g` were within noise. `jlink
  --generate-cds-archive` would add 27 MB to the linux-x64 image only and is not used.
  `plan/native-launcher.md` measures jpackage (+0.6 MB for a native `sccharts-server`
  launcher, six OS-specific build jobs and signing) and lists the native-image blockers.
- **Three platform packages instead of six.** Marketplace builds with the bundled runtime now
  cover linux-x64, darwin-arm64 and win32-x64; Intel Macs and ARM Linux or Windows get the
  universal package and need a Java 21. The publish script uploads the universal package first,
  retries a package the Marketplace gateway drops (with the four-minute "Services Unavailable"
  page seen on 2026-09-11) instead of failing the whole release, and reports each call's duration.
- **Removed the languages the server no longer serves.** KGraph (`.kgt`, `.kgx`), ELK Graph
  (`.elkt`, `.elkj`), Esterel (`.strl`), KiVis (`.kviz`) and Lustre (`.lus`) were still registered
  as languages with grammars and activation events, although the sccharts-lite server dropped them
  in 0.8.0; opening such a file started the server for nothing. The extension now activates for
  `.sctx`, `.scl` and `.kico` only. The **Open KIELER visualization in browser** command and its
  toolbar button are gone with the KiVis visualization server they depended on.

## [0.8.3] - 2026-09-10

- Uninstalling the extension deletes the downloaded w64devkit toolchain. VS Code keeps an
  extension's global storage across an uninstall and reinstall in the same session, so a
  `vscode:uninstall` hook now removes it; the extension records its storage path for the hook on
  every activation.

## [0.8.2] - 2026-09-10

The release of the 0.8.0 and 0.8.1 pre-releases below, unchanged: a bundled Java runtime in every
platform package, a downloadable C toolchain on Windows, diagrams pinned to the light palette,
and the document-highlight fix. The Marketplace requires a version number of its own for the
release channel.

## [0.8.1] - 2026-09-10 (pre-release)

- Diagrams are drawn with KIELER's light palette regardless of the VS Code colour theme. The
  dark palette that KLighD derives from dark editor themes is low-contrast; new setting
  `keith-vscode.diagramColorTheme` (`light`, default, or `editor` to follow the theme again)
  applies to open diagrams immediately.
- Package metadata points at the `Fallstop/sccharts-lab` repository.

## [0.8.0] - 2026-09-10 (pre-release)

- **Runs on a new computer without installing anything.** Marketplace and Open VSX builds are
  now platform-specific (Linux, macOS and Windows, x64 and arm64) and include a Java runtime:
  a `jlink` image of Eclipse Temurin 21 reduced to the eleven modules the language server
  needs, 30 MB compressed. One Linux machine links all six from the pinned JDKs in
  `server/runtime-manifest.json`. Measured alternatives: JustJ's smallest ready-made JRE is
  48 MB and lacks the `jdk.zipfs` module the server copies its C templates with; a Java 25
  image of the same modules is 2 MB larger, so 21 stays. An uncompressed jimage deflates
  better inside the VSIX than jlink's own compression (30 MB against 38 MB) and starts faster.
- Java is looked up in order: bundled runtime, `keith-vscode.javaHome` (new setting),
  `JDK_HOME`, `JAVA_HOME`, PATH, each checked for version 21 or newer. Without one, activation
  stops with a message offering the Temurin download and the setting instead of failing every
  command with `spawn java ENOENT`. **Restart KIELER language server** re-resolves, so a
  changed `javaHome` needs no reload. The universal `.vsix` is still built and still needs a
  Java 21 on the machine.
- **Windows C simulation without a toolchain**: the first C simulation offers to download
  w64devkit 2.9.1 (portable GCC, 61 MB, sha256-verified, self-extracting) into the extension's
  global storage, then restarts the server to use it. New commands **Download C toolchain**,
  **Remove downloaded C toolchain** and **Show Java runtime and C compiler in use**; new
  setting `keith-vscode.cCompilerPath` for an existing compiler on any platform. macOS and
  Linux get an install hint for the Command Line Tools or the distribution's gcc package
  instead of a generic compile failure. Java simulation checks for `javac` first and explains
  that it needs a JDK.
- The server takes its compiler from `-Dsccharts.cc` and runs `java`, `javac` and `jar` from
  the JVM it is executing on, so the bundled runtime never depends on PATH. The server build
  was repaired after its last two commits had left it unable to start (OSGi service loading,
  content-assist bindings of the non-SCTX languages, ELK's `Plugin` subclass) and now keeps
  the Eclipse runtime jars on the classpath, unstarted; it is 31 MB.
- Release workflow: verify, then a seven-way package matrix, a Windows job that runs the server
  suites on the bundled runtime with a freshly downloaded w64devkit, and one publish step for
  all packages. `publish-marketplace.cjs` takes several files and skips versions already
  published for a target platform.
- The language server is now built from source: the sccharts-lite fork compiles KIELER's
  SCCharts compiler, simulation and KLighD diagram server with plain Maven and Maven Central
  dependencies, without Tycho, Eclipse or OSGi, into a 29 MB JAR (the trimmed upstream JAR was
  37 MB, the original 94 MB). Esterel, Lustre, KiVis, verification, the KGraph/ELK text languages,
  the Eclipse workbench code and the Jetty visualization server are gone. Everything the former
  bytecode patch added (structured diagnostics, source tracing, scheduler cycle witnesses, loop
  explanations, C compiler mapping, string ownership in simulations, KLighD concurrency fixes,
  virtual generated files) is now ordinary source in the fork; `server-src/` and the ASM patch
  step are removed, and the Jetty 10 classpath override is no longer needed.
- Requires Java 21 (KLighD 3.1 and upstream KIELER are compiled for it). The server tracks
  upstream master (KLighD 3.1.0, ELK 0.11, Xtext 2.37, lsp4j 0.23.1) instead of the 2024 release.
- **Simulation visualization server** (`startVisualizationServer`) is not available in this build.

## [0.7.1] - 2026-09-09

- Fixed a diagram hang: when a show-snapshot task on the language server's main thread found
  its layout already finished, the follow-up ran on the main thread and queued a second layout
  behind itself, so the server waited for itself forever. Work requested from the main thread
  now runs inline. The release tests caught this once on a slow runner.

## [0.7.0] - 2026-09-09

- The extension is 38 MB instead of 90 MB. The upstream KIELER language server JAR is an
  Eclipse product export that shades in the Eclipse workbench, JDT, ICU locale data,
  BouncyCastle, JNA natives for every platform and ELK's documentation images; none of it runs
  in a headless language server. `fetch-server` now trims those packages out of the JAR before
  it is packaged, keeping any class that surviving code still references so the JVM verifier
  is satisfied. The real-server tests and a check across Esterel, Lustre, SCL, KGraph and ELK
  models behave identically on the trimmed JAR.
- The KIELER sidebar (compiler tree, model checker, simulation table) is gone, and with it the
  broken activity bar icon. Compiler stages are browsed with **Show Compilation Stage...**
  (**Stages** above the preview, the editor title menu, or the Command Palette). The model
  checker and the STPA import that fed it are removed.
- Compiling with a code-producing system opens the generated C or Java as read-only editor
  tabs, like **Generate Code**, instead of drawing the code in the diagram. When a stage is
  shown, a **Model** button above the preview returns to the SCChart; a finished compilation
  also brings the diagram back to the model. Clicking the code view no longer sends an
  Eclipse-only action to the language server, which threw a `NullPointerException` at the
  user; it opens the generated files instead.
- **Generate Code** is discoverable: an icon in the editor title of `.sctx` files and a **Code**
  button above the preview.
- Editing the simulated model marks the running simulation as stale and turns **Restart** into
  **Rebuild**, which compiles the model again with the same simulation system before starting
  over. Unsaved edits are saved first.
- Instantaneous-loop warnings on timed transitions now say so: the warning names the clock and
  lists the timed transitions instead of the unrelated entry actions on the path, and explains
  that the compiler checks each timeout in the tick the state is entered, why a clock reset on
  entry makes the loop advisory, and when it is not.

## [0.6.0] - 2026-09-08

- Generate C, Java, or both from SCCharts into read-only virtual code tabs. Save individual
  files with Save As or export a target's complete set to a folder. Generation failures and
  incompatible host-language extensions report source diagnostics; cancelled and stale
  builds cannot replace previews or write project files.
- Marketplace publishing reports actionable authentication errors and only treats a
  conflicting upload as successful after confirming that the requested version exists.

## [0.5.1] - 2026-09-08

- Renamed to SCCharts Lab with a new icon and published under the `qinnovate` publisher as an
  independent fork of KIELER VS Code. `yarn fetch-server` downloads and verifies the
  untracked language server and Jetty libraries; pushing a `vX.Y.Z` tag builds, tests, and
  publishes a GitHub release, the Marketplace, and optionally Open VSX.
- Refuses to activate beside the original KIELER VS Code extension, which registers the same
  commands and views, and offers to show it so it can be disabled.
- The compiler's "Instantaneous loop detected!" warning now names the operations on the
  loop, links to them, explains when it is advisory (a clock or variable reset on every
  transition of a delayed cycle) and how to break a real loop. When the scheduler rejects
  the same loop, its cycle error replaces the warning. The scheduler's per-edge messages
  stay in Technical details instead of appearing as separate problems.
- Overlapping diagram requests, such as showing a compiler stage right after a build or
  highlighting a conflict, no longer deadlock the language server or fail with
  `KNode.getParent()` null-pointer errors. The bundled server waited for KLighD's main
  thread while holding the lock that thread needed, and let a synthesis rebuild a diagram
  another request was still traversing. Callers that hand work to KLighD's main thread now
  wait on their own completion flag, so a wake-up can no longer land on the wrong caller and
  stall every diagram request. Show requests are also sequenced on the client.

## [0.5.0] - 2026-09-08

- Compilation failures appear in the diagram preview and VS Code Problems, with
  source links and related locations. Errors stay with their model and become stale
  when the source changes.
- Scheduler failures show one short dependency cycle per conflict, explain the
  required order, and link to the participating source operations and diagram.
  Compilation stops after errors, before an incomplete executable can be emitted.
- GCC and Clang diagnostics link to generated C and, where provenance is available,
  the original SCCharts assignment or embedded host C. Full compiler output remains
  available under Technical details.
- A quick fix expands compatible fixed-size array assignments into element copies.
  Scheduling conflicts offer timing guidance rather than automatic semantic changes.
- Preview controls and traces follow the displayed file; switching files clears
  unfinished edits and prevents controlling another model's simulation.
- Uninitialized string inputs remain editable. The C simulation wrapper retains
  incoming strings so empty inputs and values copied into outputs survive later ticks.
- Source links reuse the existing editor tab. Diagram highlighting returns to the
  original SCCharts diagram and waits for its source links before selecting and
  fitting the involved operations. Queued refreshes safely skip closed diagram contexts.

## [0.4.0] - 2026-09-07

- The diagram preview tab (`[Preview] model.sctx`) now carries the whole simulation. Restart / Step /
  Run / Stop, the tick counter and the delay between ticks sit above the diagram; a resizable trace
  drawer below shows every variable per tick, grouped into Inputs / Outputs / Variables / Generated.
  Inputs are edited in the "Next" column. Space steps, R runs or pauses.
- One-line "what happened this tick" summary: inputs present, outputs emitted, values that changed,
  and inputs queued for the next tick. Explanations live in tooltips.
- Per-variable number format (dec / hex / bin / chr) on integer rows, applied to the trace, the
  summary and typed values. `0x` / `0b` prefixes and quoted characters are always accepted.
- `deltaT` is a normal input row and defaults to 1 when a simulation starts, so timed models advance
  on Step. Clocks are visible; the compiler's tick-time measurement stays behind the Generated toggle.
- Diagrams no longer need `kieler.klighd-vscode`: the diagram code is part of this extension, with a
  "Restart diagram" command and automatic rebuild after a language server restart.
- Simulation ticks are serialised until the server acknowledges them; inputs edited mid-tick are kept
  and run loops cancel on pause or restart. Numeric and array inputs are validated before sending.
- The KIELER Simulation sidebar view still works but is no longer revealed automatically.
- Icons are inline SVG and the webview policy allows fonts, so controls render in every theme.
- Fixes: toolbar that grew a pixel per frame, hover tint leaking through sticky trace columns,
  history order flipping every tick, browser visualization server failing to start (Jetty 10 is put
  ahead of the bundled jar), and the diagram not reopening after being closed.

## [0.3.2-cs303] - 2026-09-07

- Restart KIELER language server command; readable simulation table; step/run/stop in editor title
  bars; keybindings while simulating.

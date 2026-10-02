# SCCharts Lab

> SCCharts for VS Code: diagrams, tick-by-tick simulation, and compiler diagnostics that
> link back to your model.

SCCharts Lab is an independent fork of [KIELER VS Code](https://github.com/kieler/vscode) by the
[KIELER project](https://rtsys.informatik.uni-kiel.de/kieler) at Kiel University. It bundles
a cut-down build of their language server with source-level diagnostics additions, plus a
rewritten diagram, simulation, and error experience on the client. It is not affiliated with or endorsed by
the KIELER project; report problems with this extension at
[Fallstop/kieler-vscode](https://github.com/Fallstop/kieler-vscode/issues), not to KIELER.
Both the original and this fork are licensed under the Eclipse Public License 2.0.

## Features

Language support for SCCharts (`.sctx`), SCL (`.scl`) and KiCo compilation systems (`.kico`)
from the [KIELER project](https://rtsys.informatik.uni-kiel.de/kieler): syntax highlighting,
validation while typing, hover, go to definition, outline, diagrams, compilation and simulation.

Diagram visualization and simulation are included in this extension. Open a model's
preview to simulate, step through ticks, edit inputs, and inspect its variable trace.
Everything lives in the editor area: there is no sidebar. The preview's toolbar carries
**Simulate**, then the transport controls, and **Code** (generate C or Java) at its right end;
the editor title of an SCChart offers **Stages** (browse the compiler's intermediate models).
While a compiler stage is shown, **Model** brings the diagram back to the SCChart.

Editing a model while its simulation runs marks the run as out of date: **Restart** becomes
**Rebuild**, which compiles the model again with the same simulation system and starts over
from tick 0. Unsaved edits are saved first.

### Breakpoints, watches and stepping back

The simulation can pause itself. **Breakpoints** in the preview's toolbar opens a list where a
breakpoint is either a state, completed from the model's states and paused on when it is
entered, or a condition over the variables that pauses after any tick in which it holds
(`count >= 3 && !done`, `pre(x) != x`; the field completes variable names and `pre(`). The
server validates each one and shows why one was rejected next to it. `C` runs ticks as fast as
the model allows until a breakpoint fires; a running simulation (**Run**) stops on a breakpoint
as well. The tick the simulation paused at is marked in the trace.

**Watch** expressions, on the trace drawer's top line, are evaluated after every tick in the
same syntax and show their value or the reason they cannot be evaluated. The trace's own
controls sit at the right end of that line: **Generated** shows the compiler's own symbols, and
**Save** and **Load** write or replay a `.ktrace` file. What the last tick did (inputs present,
outputs emitted, variables changed) is summarised directly above the table. Both are remembered per
model, so a restarted or rebuilt simulation keeps them. The Command Palette has **Add
simulation breakpoint...** (a pick list of the model's states, or a condition) and **Add
simulation watch expression...**.

**Back** (`Backspace`) rewinds one tick, and clicking an earlier tick's header in the trace
rewinds to it. This is a real rewind, not a replay of a recording: the compiled program is
restarted and every input you gave is fed to it again up to that tick, so the diagram, the
trace and the watches show the model exactly as it was, and stepping forward from there can
take a different path if you change an input. A loaded `.ktrace` drives the inputs itself,
so its ticks cannot be rewound.

The diagram follows the editor cursor: place the cursor in a state, region or transition and
the diagram expands the regions around it and selects it. `keith-vscode.diagram.followCursor`
picks `focus` (default), `expand` (collapse the regions you are not in as well, unless you
expanded them yourself and the diagram remembers expansion states) or `off`. **Reveal Cursor
in Diagram** (Command Palette, editor context menu) does the same once, whatever the setting;
bind it to a key such as `ctrl+alt+r` if you use it often. Clicking an element in the diagram
selects its text in the editor (`keith-vscode.diagram.selectText`).

### Live diagnostics

SCCharts are analysed while you type. About half a second after the last edit the server runs
the model through the front half of the netlist compiler (normalisation, SCG, dependency and
loop analysis, scheduler) and shows what it finds as squiggles labelled **KIELER · live**:
scheduling cycles with the variables involved and the two operations that conflict,
instantaneous loops, clocks shared between concurrent regions, redeclared inherited variables
and regions, and every other located compiler finding. No code is generated and nothing is
written to disk. A compile you start yourself takes over the document until you edit it again.
`keith-vscode.liveDiagnostics.enabled` turns it off; `keith-vscode.liveDiagnostics.debounceMs`
changes the wait. The compiler's warnings can be hidden: the preview's "Compiled with N warnings"
panel has a **Hide warnings** button, the lightbulb on any **KIELER** warning offers **Hide
KIELER warnings**, and **Hide Compiler Warnings** is in the Command Palette and an SCChart's
editor menus. While they are hidden the panel reads "Compiled, N warnings hidden" with a **Show
warnings** button, and a status bar item counts them for the active model and shows them again
on click. Errors always show. The setting behind all of this is
`keith-vscode.diagnostics.showWarnings`. On a 300-line model the analysis takes about a second cold and a third of
that warm.

### Editor features

Hovering a name in an SCChart shows a card built from the model, not only from doc comments:
a declaration's kind, type, initial value, the scope it lives in, how often it is written and
read, and the comment above it (`// ...`, `/** ... */` before the element, or a trailing
`//* ...`). Hovering a state lists its regions, actions, outgoing transitions with their
triggers, and the states it is entered from; a transition shows its source and target,
priority, preemption (`go to`, `abort to`, `join to`), whether it is immediate, its trigger
and its effects; a region names its initial and final states. Hovering a reference (a
variable in a trigger, the target of a `go to`) shows the card of the declaration.
**Go to Definition**, **Find All References** and **Rename** work on variables and states,
and the Outline lists the chart's declarations, states and regions with their kinds.

Completion proposes the keywords that matter to a modeller with a one-line summary and a
Markdown card explaining what each does to the tick, the variables, signals and clocks in
scope inside triggers and effects (labelled `input bool`, `output int`, with the declaration's
comment), and the states of the enclosing region after `go to`, `abort to` and `join to`. The
shapes you write by hand come as snippets with tab stops: `scchart Name { }`, `state Name { }`,
`initial state Name`, `region Name { initial state S }`, `if cond go to Target` and
`entry do x = 0`. Bare operators are not proposed.

While a model compiles, the status bar shows the running processor and its place in the
pipeline (`SCG (12/38)`); afterwards it shows the wall time, with the number of processors
and the slowest one in the tooltip. **Stages** lists every processor's duration, flags the
slowest, and puts the total in its title. A failed compilation reports the stages that never
ran as skipped.

Compilation failures appear above the diagram and in VS Code Problems. Scheduler
conflicts link to the participating source operations and explain their circular
ordering. C compiler errors link to generated code and to SCCharts when their origin
is known. Use **Technical details** for the original output or **View scheduler graph**
(**View compiler stage** for other failures) to inspect the failed transformation.
**Highlight in diagram** returns to the original SCCharts diagram and selects the
involved operations. Source links reuse the model's existing editor tab.

For an internal compiler failure, use **Copy diagnostic report** in the preview or
**SCCharts: Copy Diagnostics Report** in the Command Palette. The report includes the
extension and Java versions, the server fingerprint, source version, failed processors,
timings and technical details, without exporting the model or generated files. It stays
with the selected model even when another editor is open. Syntax, reference and type
errors should be corrected in Problems before compiling again.

A **Potential instantaneous loop** warning comes from the compiler's loop analyzer: control
flow or a data dependency can return to the listed operations without crossing a tick
boundary. Timed transitions (`if elapsed >= t`) produce this warning on every cycle of
states, because the compiler tests each timeout in the tick its state is entered and the
analyzer cannot see that a clock reset on entry keeps the timeout from firing again. The
warning names the clock and the timed transitions; it is advisory as long as every state
on the loop resets the clock on entry and no timeout is 0. When the scheduler rejects the
model instead, its cycle error replaces the warning.

Source edits mark old diagnostics as stale until the next compilation. Compatible
fixed-size array assignments offer a **Copy array elements individually** quick fix
in the editor. Timing changes needed to resolve scheduler conflicts remain explicit
modeling decisions.

### Custom compilation systems

The compile menu is not limited to the built-in systems. Any `.kico` file in the workspace
defines a compilation system of its own and appears under a **Workspace** heading in
**Compile current model with...** the moment it is saved without errors; no server restart,
no registration. **New compilation system (.kico) in workspace** (command palette) creates
`kico/<id>.kico` from a commented template and opens it. A minimal system that reuses the
built-in netlist chain and generates C:

```
public system my.netlist
    label "My netlist (workspace)"

    system de.cau.cs.kieler.sccharts.netlist
```

Systems are sequences of processor ids and included systems, exactly like the built-in
`.kico` files; unknown processor or system ids, an id that shadows a built-in system, and
syntax errors are underlined in the `.kico` editor and reported in a warning, so a broken file is
never skipped silently. Folders outside the workspace (a shared team directory, say) are added
with `keith-vscode.compilationSystems.folders`, absolute or relative to the workspace folder.
Build output and dependency folders (`node_modules`, `target`, `out`, `dist`, `build`, `bin`,
`kieler-gen`, dot-folders) are not scanned.

### Generate C and Java

Open an `.sctx` model and use the **Generate Code** icon in the editor title, the **Code**
button above the diagram preview, **SCCharts: Generate Code...** from the Command Palette,
or the file's Explorer context menu. Choose **C**, **Java**, or **C and Java**. Unsaved edits
to the source model are saved before compilation. **Compile current model with...** and a
code-producing system (for example *Netlist-based Compilation*) opens the same tabs instead of
drawing the code as a diagram.

Generated `.c`/`.h` and `.java` files open as read-only virtual documents. Generated files
are not written to your project until you save them. Use VS Code's **Save As...** or the
editor's **Save Generated File As...** action for one file. **Save All Generated Files...**
saves a target's complete set (including C headers) to a chosen folder and asks before
replacing existing files. Each generation opens separate previews; closing them discards
the unsaved output. Save files you want to keep before closing the window.

Generation errors appear in Problems. Models with C-only host
code cannot generate Java without matching Java implementations, and vice versa.
Failed, cancelled, or stale results never open as generated files. When generating both
targets, a successful target remains available if the other fails.

This command generates source using KIELER's netlist compiler. It does not invoke GCC
or `javac`; compiling and linking the saved output, including host libraries, belongs to
your application's build. The generated model exposes `reset` and `tick`; your application
initializes it, supplies inputs, calls `tick`, and reads outputs each reaction.

The bundled SCCharts Lab server is required for virtual code generation. An older or
external server that does not return generated files produces an explicit error.

## Requirements

SCCharts Lab is incompatible with the original **KIELER VS Code** extension
(`kieler.keith-vscode`): both register the same commands and languages and each
starts its own language server. SCCharts Lab refuses to activate while that extension is
enabled. Disable or uninstall it, then reload the window.

**Nothing else to install on Windows x64, Apple Silicon or Linux x64** when the extension comes
from the Marketplace or Open VSX: those builds are platform-specific and ship their own Java
runtime, a 30 MB [jlink](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jlink.html)
image of Eclipse Temurin 21 with only the modules the language server uses. Other platforms
(Intel Macs, ARM Linux, ARM Windows) receive the universal package, which, like the universal
`.vsix` from GitHub releases and `yarn package`, carries no runtime and needs Java 21 or newer, found through
the `keith-vscode.javaHome` setting, `JDK_HOME`, `JAVA_HOME`, or `java` on PATH, in that order.
**SCCharts Lab: Show Java runtime and C compiler in use** tells you which one was picked.

C simulation compiles the generated program with a C compiler:

- **Windows**: the first C simulation offers to download [w64devkit](https://github.com/skeeto/w64devkit)
  (a portable GCC, 61 MB) into VS Code's storage folder for this extension; no installer, no
  PATH changes, removable with **SCCharts Lab: Remove downloaded C toolchain** and deleted when
  the extension is uninstalled. Windows on ARM
  runs the x64 toolchain through emulation. An existing MinGW or MSYS2 `gcc.exe` can be used
  instead through `keith-vscode.cCompilerPath`.
- **macOS**: install the Xcode Command Line Tools (`xcode-select --install`); their `gcc`
  command is Apple Clang and works.
- **Linux**: install `gcc` with your package manager (`sudo apt install build-essential`,
  `sudo dnf install gcc`, `sudo pacman -S gcc`).

Java simulation compiles with `javac`, which the bundled runtime does not include. Point
`keith-vscode.javaHome` at a JDK 21 or newer (or have one on PATH) to use it; C simulation does
not need this.

**Startup cache.** The language server starts from a class-data-sharing archive
([AppCDS](https://docs.oracle.com/en/java/javase/21/vm/class-data-sharing.html)) that is built
on your machine: the first start records which classes the server loads, a background
`java -Xshare:dump` (about 3 s, 65 MB in the extension's global storage) turns the list into
the archive when that server exits, and every later start maps it. Measured on the bundled
runtime, `initialize` drops from 1.5 s to 1.0 s and the Compile menu is ready after 1.8 s
instead of 2.6 s, with 140 MB less resident memory. The archive is keyed to the exact server
build and Java binary, so an update rebuilds it; a damaged file is skipped with a warning; a
server that crashes right after starting with it discards it. **SCCharts Lab: Clear language
server startup cache** deletes it, `keith-vscode.startupCache.enabled` turns it off.

Diagrams use KIELER's light palette whatever the editor theme; set
`keith-vscode.diagramColorTheme` to `editor` to let dark themes switch to the dark palette.

Some transformed operations have no source provenance. Those diagnostics retain
their compiler stage or generated-file location instead of guessing a source line.

## Building from source

The language server is [sccharts-lite](../../kieler-server-fork): KIELER's SCCharts compiler,
simulation and KLighD diagram server, with this extension's diagnostics built in, compiled with
plain Maven from a checkout of the upstream sources and shaded into one 31 MB JAR. It is not
tracked in this repository. `yarn build:server` builds it (JDK 21 and Maven required; the
checkout is taken from `SCCHARTS_SERVER_SRC`, by default a sibling `kieler-server-fork`
directory) and places `server/sccharts-lite-server.jar`, or copies a prebuilt JAR given as
`SCCHARTS_SERVER_JAR`.

CI and releases pin the server revision in `.github/workflows/ci.yml` and
`.github/workflows/release.yml`. Update both pins when shipping server changes so
the published extension uses the tested sources.

`yarn package` produces the universal `sccharts-lab.vsix`. `yarn package:platform
linux-x64` (any of `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`,
`win32-arm64`) first runs `scripts/build-jre.cjs`, which downloads the Temurin JDK pinned in
`server/runtime-manifest.json` for that platform (and for the build machine, since `jlink`
must match the target's `java.base` version), links `server/jre/` from the module list in the
manifest, and then packages `sccharts-lab-<target>.vsix` with it. `--pre-release` on either
command flags the package as a Marketplace pre-release. Any machine builds any target; downloads are cached in `out/runtime-cache/`. `node scripts/build-jre.cjs --refresh
jdk-21.0.x+y` moves the manifest to a newer Temurin release. `yarn build:jre` links the runtime
for the current machine, and `SCCHARTS_JAVA=server/jre/bin/java yarn test:server` runs the
server suites on it, which is how the module list is kept honest.

`node scripts/measure-startup.cjs --compile --config baseline,static,static+tiered1` times the
server start (`initialize`, first compilation systems, a compile, resident memory) under
different JVM options on the host JDK or, with `SCCHARTS_JAVA=server/jre/bin/java`, on the
linked runtime; it is how the startup cache's flags were chosen (see the changelog for 0.9.0).
`plan/native-launcher.md` records the jpackage and native-image assessment.

Releases are published by tagging `vX.Y.Z` (matching `package.json`) on GitHub; a `vX.Y.Z-pre`
tag publishes the same version as a pre-release (GitHub pre-release, Marketplace and Open VSX
pre-release channel). Either runs `.github/workflows/release.yml`: it builds the server, runs every check on the system JDK and on
the linked runtime (Linux and Windows, the latter with a downloaded w64devkit), packages the
four `.vsix` files (universal, linux-x64, darwin-arm64, win32-x64), attaches them to the GitHub
release and publishes them to the Marketplace and Open VSX, smallest first, retrying a package
whose upload the Marketplace gateway drops; a rerun skips packages that already arrived. CI checks the server sources out of the repository named by the
`SCCHARTS_SERVER_REPO` variable.

/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import { COMPARE_RUN, COMPARE_TRACES, LOAD_TRACE, RUN_MODELS_ON_TRACE, SAVE_TRACE } from './commands'
import { isTimeDelta } from './helper'
import { SimulationData, SimulationTableDataProvider } from './simulation-table-data-provider'
import { NamedTrace, compareTraces, comparisonCsv, comparisonMarkdown } from './trace-compare'
import {
    TRACE_FORMATS,
    TraceFormat,
    TraceRecord,
    formatTraceValue,
    inputsOnly,
    readTrace,
    traceFormatOf,
    writeTrace,
} from './trace-file'
import { MAX_TIMED_TICKS, TickMode, TimedSchedule } from './trace-timing'

const FORMAT_KEY = 'keith.trace.format'

const OPEN_FILTERS = { Traces: TRACE_FORMATS.map((entry) => entry.extension) }

/** A model's run on a sequence, with what the report should say about it. */
interface RunOutcome {
    trace: TraceRecord
    notes: string[]
}

/** How models without a clock tick; asked once per batch, at the first such model. */
interface TimingChoice {
    mode?: TickMode
}

/** A timed sequence runs for a time, any other for a number of ticks. */
async function askLength(sequence: TraceRecord): Promise<{ ticks: number } | { until: number } | undefined> {
    if (sequence.times) {
        const last = sequence.times[sequence.times.length - 1] ?? 0
        const text = await vscode.window.showInputBox({
            title: 'Run for how many seconds?',
            prompt: `The sequence's last input change is at ${last} s.`,
            value: String(last),
            validateInput: (value) =>
                Number.isFinite(Number(value)) && Number(value) > 0 ? undefined : 'Enter a time in seconds.',
        })
        return text === undefined ? undefined : { until: Number(text) }
    }
    const text = await vscode.window.showInputBox({
        title: 'How many ticks?',
        prompt: `The sequence has ${sequence.ticks.length} ticks; after its end the inputs keep their last values.`,
        value: String(sequence.ticks.length),
        validateInput: (value) =>
            /^\d+$/.test(value.trim()) && Number(value) > 0 && Number(value) <= 1000000
                ? undefined
                : 'Enter a whole number of ticks.',
    })
    return text === undefined ? undefined : { ticks: Number(text.trim()) }
}

/** Asks how a model without a clock keeps time: a periodic timer input, or only the sequence's moments. */
async function askTimer(label: string, inputs: SimulationData[], sequence: TraceRecord): Promise<TickMode | undefined> {
    const kind = await vscode.window.showQuickPick(
        [
            {
                label: '$(watch) Every few milliseconds, with a timer input',
                detail: 'Like a hardware timer: a tick every period, with a boolean input true on those ticks',
                timer: true,
            },
            {
                label: "$(debug-step-over) Only at the sequence's moments",
                detail: 'The model reacts when an input changes, and at no other time',
                timer: false,
            },
        ],
        { title: `${label} has no clock (deltaT). When should models without one tick?`, ignoreFocusOut: true }
    )
    if (!kind) return undefined
    if (!kind.timer) return { kind: 'events' }
    const period = await vscode.window.showInputBox({
        title: 'Timer period in milliseconds',
        value: '1000',
        ignoreFocusOut: true,
        validateInput: (value) => (Number(value) > 0 ? undefined : 'Enter a positive number of milliseconds.'),
    })
    if (period === undefined) return undefined
    const set = new Set(sequence.variables.map((variable) => variable.name))
    const candidates = inputs.filter((entry) => entry.type === 'bool' && !set.has(entry.id))
    const input =
        candidates.length > 0
            ? await vscode.window.showQuickPick(
                  candidates.map((entry) => entry.id),
                  { title: 'The input that is true on the timer’s ticks', ignoreFocusOut: true }
              )
            : await vscode.window.showInputBox({
                  title: 'The input that is true on the timer’s ticks',
                  value: 'Timer',
                  ignoreFocusOut: true,
              })
    return input ? { kind: 'timer', input, period: Number(period) / 1000 } : undefined
}

/**
 * Saving, replaying and comparing simulation traces: the commands behind the trace drawer's
 * Save, Replay and Compare, and the batch run of several models on one input sequence.
 */
export class TraceTools {
    constructor(
        private readonly simulation: SimulationTableDataProvider,
        private readonly context: vscode.ExtensionContext,
        /** The diagram preview: a batch run waits for its redraw when it shows the model being run. */
        private readonly diagrams?: { currentUri: vscode.Uri | undefined; nextModel(timeoutMs?: number): Promise<void> }
    ) {
        context.subscriptions.push(
            vscode.commands.registerCommand(SAVE_TRACE.command, () => this.save()),
            vscode.commands.registerCommand(LOAD_TRACE.command, (uri?: vscode.Uri) => this.replay(uri)),
            vscode.commands.registerCommand(COMPARE_RUN.command, () => this.compareRun()),
            vscode.commands.registerCommand(COMPARE_TRACES.command, (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
                this.compareFiles(uris && uris.length > 1 ? uris : undefined)
            ),
            vscode.commands.registerCommand(RUN_MODELS_ON_TRACE.command, (uri?: vscode.Uri) => this.runModels(uri))
        )
    }

    private get running(): boolean {
        return this.simulation.simulationRunning && this.simulation.phase === 'running'
    }

    /** Where dialogs start: next to the simulated model, else in the first workspace folder. */
    private folder(): vscode.Uri | undefined {
        if (this.simulation.modelUri) {
            const model = vscode.Uri.parse(this.simulation.modelUri)
            if (model.scheme === 'file') return vscode.Uri.file(path.dirname(model.fsPath))
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri
    }

    private async read(uri: vscode.Uri): Promise<TraceRecord> {
        const format = traceFormatOf(uri.path)
        if (!format) {
            throw new Error(`${path.basename(uri.path)} is not a trace. Use a .ktrace, .csv, .json or .xml file.`)
        }
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
        try {
            return readTrace(text, format)
        } catch (error) {
            throw new Error(`${path.basename(uri.path)}: ${error instanceof Error ? error.message : error}`)
        }
    }

    private async write(uri: vscode.Uri, trace: TraceRecord, format: TraceFormat): Promise<void> {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(writeTrace(trace, format)))
    }

    /** Asks what to save (the whole run or only its inputs) and where; the file extension picks the format. */
    async save(): Promise<void> {
        if (!this.running || this.simulation.simulationStep < 1) {
            vscode.window.showInformationMessage('Run at least one tick of a simulation first.')
            return
        }
        const kind = await vscode.window.showQuickPick(
            [
                {
                    label: '$(list-flat) Trace',
                    detail: "Inputs, outputs and the model's variables after every tick, for analysis or comparison",
                    inputs: false,
                },
                {
                    label: '$(record) Input sequence',
                    detail: 'Only the inputs, to replay into this model or another one',
                    inputs: true,
                },
            ],
            { title: `Save ${this.simulation.simulationStep} ticks as...` }
        )
        if (!kind) return
        const trace = kind.inputs ? inputsOnly(this.simulation.currentTrace()) : this.simulation.currentTrace()
        const remembered = this.context.workspaceState.get<TraceFormat>(FORMAT_KEY)
        const format = TRACE_FORMATS.find((entry) => entry.format === remembered) ?? TRACE_FORMATS[0]
        const model = (trace.model ?? 'trace').replace(/\.[^.]*$/, '')
        const folder = this.folder()
        const name = `${model}${kind.inputs ? '-inputs' : ''}.${format.extension}`
        // The remembered format comes first: dialogs select their first filter.
        const ordered = [format, ...TRACE_FORMATS.filter((entry) => entry !== format)]
        const uri = await vscode.window.showSaveDialog({
            title: kind.inputs ? 'Save the input sequence' : 'Save the trace',
            defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
            filters: Object.fromEntries(ordered.map((entry) => [entry.label, [entry.extension]])),
        })
        if (!uri) return
        const chosen = traceFormatOf(uri.path) ?? format.format
        const target = traceFormatOf(uri.path) ? uri : uri.with({ path: `${uri.path}.${format.extension}` })
        try {
            await this.write(target, trace, chosen)
            await this.context.workspaceState.update(FORMAT_KEY, chosen)
        } catch (error) {
            vscode.window.showErrorMessage(
                `The trace could not be saved: ${error instanceof Error ? error.message : error}`
            )
            return
        }
        const note =
            chosen === 'ktrace' && trace.variables.some((variable) => variable.role === 'local')
                ? ' KTrace holds only inputs and outputs; save as CSV, JSON or XML to keep the other variables.'
                : ''
        vscode.window.showInformationMessage(
            `Saved ${trace.ticks.length} ticks to ${path.basename(target.path)}.${note}`
        )
    }

    /** Replays a trace file into the running simulation's inputs, from the next tick on. */
    async replay(uri?: vscode.Uri): Promise<void> {
        if (!this.running) {
            vscode.window.showInformationMessage('Start a simulation first, then replay a trace into it.')
            return
        }
        const file =
            uri ??
            (
                await vscode.window.showOpenDialog({
                    title: 'Replay a trace into the inputs',
                    defaultUri: this.folder(),
                    canSelectMany: false,
                    filters: OPEN_FILTERS,
                })
            )?.[0]
        if (!file) return
        let trace: TraceRecord
        try {
            trace = await this.read(file)
        } catch (error) {
            vscode.window.showErrorMessage(
                `The trace could not be read. ${error instanceof Error ? error.message : error}`
            )
            return
        }
        const replay = this.simulation.startReplay(path.basename(file.path), trace)
        if (replay && replay.driven.length === 0) {
            this.simulation.stopReplay()
            const names = trace.variables.map((variable) => variable.name).join(', ')
            vscode.window.showWarningMessage(
                `${path.basename(file.path)} sets none of this model's inputs. It has ${names || 'no variables'}.`
            )
        }
    }

    private async pickTraces(title: string): Promise<vscode.Uri[] | undefined> {
        return vscode.window.showOpenDialog({
            title,
            defaultUri: this.folder(),
            canSelectMany: true,
            filters: OPEN_FILTERS,
        })
    }

    private async readAll(uris: vscode.Uri[]): Promise<NamedTrace[] | undefined> {
        try {
            const labels = uniqueLabels(uris)
            return await Promise.all(
                uris.map(async (uri, index) => ({ label: labels[index], trace: await this.read(uri) }))
            )
        } catch (error) {
            vscode.window.showErrorMessage(
                `The traces could not be read. ${error instanceof Error ? error.message : error}`
            )
            return undefined
        }
    }

    /** The running simulation against saved traces, with the run as the reference. */
    async compareRun(): Promise<void> {
        if (!this.running || this.simulation.simulationStep < 1) {
            vscode.window.showInformationMessage('Run at least one tick of a simulation first.')
            return
        }
        const run = this.simulation.currentTrace()
        const uris = await this.pickTraces('Compare this run with...')
        if (!uris || uris.length === 0) return
        const others = await this.readAll(uris)
        if (!others) return
        await showReport([{ label: `This run (${run.model ?? 'model'})`, trace: run }, ...others])
    }

    /** Two or more trace files; the first picked is the reference. */
    async compareFiles(preset?: vscode.Uri[]): Promise<void> {
        const uris = preset ?? (await this.pickTraces('Compare traces (pick two or more)'))
        if (!uris) return
        if (uris.length < 2) {
            vscode.window.showInformationMessage('Pick at least two traces to compare.')
            return
        }
        const traces = await this.readAll(uris)
        if (traces) await showReport(traces)
    }

    /**
     * Runs each picked model on one input sequence, saves every run as CSV and KTrace in a folder
     * next to the sequence, and opens a comparison of the runs.
     */
    async runModels(preset?: vscode.Uri): Promise<void> {
        if (this.simulation.phase === 'starting' || this.simulation.phase === 'stopping') {
            vscode.window.showInformationMessage('Wait until the simulation has started or stopped.')
            return
        }
        const sequenceUri =
            preset ??
            (
                await vscode.window.showOpenDialog({
                    title: 'Input sequence to run the models on',
                    defaultUri: this.folder(),
                    canSelectMany: false,
                    filters: OPEN_FILTERS,
                })
            )?.[0]
        if (!sequenceUri) return
        let sequence: TraceRecord
        try {
            sequence = await this.read(sequenceUri)
        } catch (error) {
            vscode.window.showErrorMessage(
                `The sequence could not be read. ${error instanceof Error ? error.message : error}`
            )
            return
        }
        const models = await this.pickModels()
        if (!models) return
        if (models.length === 0) {
            vscode.window.showInformationMessage('Tick at least one model to run on the sequence.')
            return
        }
        const length = await askLength(sequence)
        if (!length) return
        const sequenceName = path.basename(sequenceUri.path)
        const folder = vscode.Uri.joinPath(sequenceUri, '..', `${sequenceName.replace(/\.[^.]*$/, '')}-runs`)
        await vscode.workspace.fs.createDirectory(folder)

        const labels = uniqueLabels(models)
        const results: NamedTrace[] = []
        const notes: string[] = []
        const timing: TimingChoice = {}
        // Without systems loaded yet, the first model opens in an editor to load them, and its pick is used for all.
        const { simulationSystems } = this.simulation
        let systemId: string | undefined
        if (simulationSystems.length > 0) {
            const picked = await vscode.window.showQuickPick(
                simulationSystems.map((system) => ({ label: system.label, description: system.id, system })),
                { title: 'Build every model with' }
            )
            if (!picked) return
            systemId = picked.system.id
        }
        this.simulation.quiet = true
        try {
            await this.runAll(models, labels, sequenceName, sequence, length, timing, systemId, folder, results, notes)
        } finally {
            this.simulation.quiet = false
        }
        if (this.simulation.simulationRunning) await this.simulation.stopSimulation()
        await this.report(results, notes, length, sequenceName, folder, this.simulation.systemId)
    }

    private async runAll(
        models: vscode.Uri[],
        labels: string[],
        sequenceName: string,
        sequence: TraceRecord,
        length: { ticks: number } | { until: number },
        timing: TimingChoice,
        chosenSystem: string | undefined,
        folder: vscode.Uri,
        results: NamedTrace[],
        notes: string[]
    ): Promise<void> {
        let systemId = chosenSystem
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running on ${sequenceName}`, cancellable: true },
            async (progress, token) => {
                for (let index = 0; index < models.length && !token.isCancellationRequested; index++) {
                    const label = labels[index]
                    progress.report({ message: `${label} (${index + 1} of ${models.length})` })
                    const start = systemId
                        ? this.simulation.simulateWithoutEditor(models[index], systemId)
                        : this.simulation.compileAndSimulate(false, models[index])
                    // eslint-disable-next-line no-await-in-loop
                    const built = await start
                    // Without a system yet, a false start means the user closed the system picker.
                    if (!built && !systemId) return
                    // The start redraws a diagram that shows the model; the first tick must not overlap it.
                    const started = this.shows(models[index]) ? this.diagrams!.nextModel(2000) : undefined
                    // eslint-disable-next-line no-await-in-loop
                    const running = built && (await this.simulation.waitForRunning())
                    // eslint-disable-next-line no-await-in-loop
                    await started
                    if (!running) {
                        notes.push(`${label} did not start: ${this.simulation.lastError ?? 'the build failed'}.`)
                    } else {
                        systemId = systemId ?? this.simulation.systemId
                        const outcome =
                            'ticks' in length
                                ? // eslint-disable-next-line no-await-in-loop
                                  await this.runTicked(
                                      models[index],
                                      label,
                                      sequenceName,
                                      sequence,
                                      length.ticks,
                                      token
                                  )
                                : // eslint-disable-next-line no-await-in-loop
                                  await this.runTimed(models[index], label, sequence, length.until, timing, token)
                        if (!outcome) return
                        notes.push(...outcome.notes)
                        if (outcome.trace.ticks.length > 0) {
                            const base = label.replace(/\.sctx$/, '').replace(/[\\/]/g, '_')
                            // eslint-disable-next-line no-await-in-loop
                            await this.write(vscode.Uri.joinPath(folder, `${base}.csv`), outcome.trace, 'csv')
                            // eslint-disable-next-line no-await-in-loop
                            await this.write(vscode.Uri.joinPath(folder, `${base}.ktrace`), outcome.trace, 'ktrace')
                            results.push({ label, trace: outcome.trace })
                        }
                    }
                }
            }
        )
    }

    /** Opens the comparison of the runs, or says where the one run went. */
    private async report(
        results: NamedTrace[],
        notes: string[],
        length: { ticks: number } | { until: number },
        sequenceName: string,
        folder: vscode.Uri,
        systemId: string | undefined
    ): Promise<void> {
        if (results.length === 0) {
            if (notes.length > 0) vscode.window.showErrorMessage(notes.join(' '))
            return
        }
        const ran = 'ticks' in length ? `ran ${length.ticks} ticks` : `ran for ${length.until} s`
        const preamble = [
            `Each model ${ran} with its inputs from \`${sequenceName}\`` +
                `${systemId ? `, built with \`${systemId}\`` : ''}. The traces are in \`${path.basename(
                    folder.path
                )}\`.`,
            ...(notes.length > 0 ? ['', ...notes.map((note) => `- ${note}`)] : []),
        ]
        if (results.length < 2) {
            vscode.window
                .showInformationMessage(`Saved the run to ${path.basename(folder.path)}. ${notes.join(' ')}`, 'Reveal')
                .then((choice) => {
                    if (choice) vscode.commands.executeCommand('revealInExplorer', folder)
                })
            return
        }
        const comparison = compareTraces(results)
        const report = vscode.Uri.joinPath(folder, 'comparison.md')
        await vscode.workspace.fs.writeFile(
            report,
            new TextEncoder().encode(comparisonMarkdown(comparison, { preamble }))
        )
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(folder, 'comparison.csv'),
            new TextEncoder().encode(comparisonCsv(comparison))
        )
        await vscode.commands.executeCommand('markdown.showPreview', report)
    }

    /** One tick per row of the sequence (and on, with the last values, for longer runs). */
    private shows(model: vscode.Uri): boolean {
        return this.diagrams?.currentUri?.toString() === model.toString()
    }

    /** One tick; when the preview shows the model, waits for its redraw so redraws cannot pile up. */
    private async tick(model: vscode.Uri): Promise<boolean> {
        const redrawn = this.shows(model) ? this.diagrams!.nextModel(2000) : undefined
        const ran = await this.simulation.stepTimes(1)
        await redrawn
        return ran === 1
    }

    private async runTicked(
        model: vscode.Uri,
        label: string,
        sequenceName: string,
        sequence: TraceRecord,
        ticks: number,
        token: vscode.CancellationToken
    ): Promise<RunOutcome> {
        const replay = this.simulation.startReplay(sequenceName, sequence, false)
        let ran = 0
        // eslint-disable-next-line no-await-in-loop
        while (ran < ticks && !token.isCancellationRequested && (await this.tick(model))) ran++
        const trace = this.simulation.currentTrace()
        this.simulation.stopReplay()
        const notes: string[] = []
        if (replay?.unset.length) {
            const kept = replay.unset
                .map((name) => `\`${name}\` = ${formatTraceValue(trace.ticks[0]?.[name])}`)
                .join(', ')
            notes.push(`${label}: the sequence does not set ${kept} (the value at tick 1).`)
        }
        if (replay?.ignored.length) {
            notes.push(`${label} has no input ${replay.ignored.map((name) => `\`${name}\``).join(', ')}.`)
        }
        if (ran < ticks && !token.isCancellationRequested) {
            notes.push(`${label} stopped after ${ran} ticks: ${this.simulation.lastError ?? 'unknown error'}.`)
        }
        return { trace, notes }
    }

    /**
     * Ticks at the sequence's moments, and in between as the model keeps time: when its clock
     * wakes it (time delta and sleep), or on a timer the user describes once for all models.
     */
    private async runTimed(
        model: vscode.Uri,
        label: string,
        sequence: TraceRecord,
        until: number,
        timing: TimingChoice,
        token: vscode.CancellationToken
    ): Promise<RunOutcome | undefined> {
        const data = Array.from(this.simulation.simulationData.values())
        const inputs = data.filter((entry) => entry.input)
        const delta = inputs.find((entry) => isTimeDelta(entry))
        const sleep = data.find((entry) => /^[#_]*sleepT$/i.test(entry.id))
        const notes: string[] = []
        let mode: TickMode
        if (delta) {
            mode = { kind: 'clock', delta: delta.id, sleep: sleep?.id }
        } else {
            const chosen = timing.mode ?? (await askTimer(label, inputs, sequence))
            if (!chosen) return undefined
            timing.mode = chosen
            mode = chosen
            if (chosen.kind === 'timer' && !inputs.some((entry) => entry.id === chosen.input)) {
                notes.push(`${label} has no input \`${chosen.input}\`, so it ticked only at the sequence's moments.`)
                mode = { kind: 'events' }
            }
        }
        let schedule: TimedSchedule
        try {
            schedule = new TimedSchedule(sequence, mode, until)
        } catch (error) {
            notes.push(`${label}: ${error instanceof Error ? error.message : error}`)
            return { trace: { variables: [], ticks: [] }, notes }
        }
        const times: number[] = []
        const unfit = new Set<string>()
        let wake: unknown
        let failed = false
        for (let tick = schedule.next(); tick && !token.isCancellationRequested; tick = schedule.next(wake)) {
            this.simulation.queueInputs(tick.inputs).forEach((name) => unfit.add(name))
            // eslint-disable-next-line no-await-in-loop
            if (!(await this.tick(model))) {
                failed = true
                break
            }
            times.push(tick.time)
            wake = mode.kind === 'clock' && mode.sleep ? this.simulation.latestValue(mode.sleep) : undefined
        }
        const run = this.simulation.currentTrace()
        // A failed tick stops the simulation, and its data with it.
        const trace = { ...run, times: times.slice(0, run.ticks.length) }
        const set = new Set(
            sequence.variables
                .filter((variable) => variable.role !== 'output' && variable.role !== 'local')
                .map(({ name }) => name)
        )
        const how =
            mode.kind === 'clock'
                ? `at the sequence's moments and when its clock woke it${mode.sleep ? ` (\`${mode.sleep}\`)` : ''}`
                : mode.kind === 'timer'
                  ? `at the sequence's moments and every ${Number((mode.period * 1000).toFixed(6))} ms, with \`${
                        mode.input
                    }\` true on the timer's ticks`
                  : "only at the sequence's moments"
        notes.push(`${label} ticked ${times.length} times, ${how}.`)
        const ignored = Array.from(set).filter((name) => !inputs.some((entry) => entry.id === name))
        if (ignored.length > 0) notes.push(`${label} has no input ${ignored.map((name) => `\`${name}\``).join(', ')}.`)
        const own = new Set([delta?.id, mode.kind === 'timer' ? mode.input : undefined])
        const unset = inputs.filter((entry) => !set.has(entry.id) && !own.has(entry.id))
        if (unset.length > 0) {
            const kept = unset.map((entry) => `\`${entry.id}\` = ${formatTraceValue(trace.ticks[0]?.[entry.id])}`)
            notes.push(`${label}: the sequence does not set ${kept.join(', ')} (the value at the first tick).`)
        }
        if (unfit.size > 0) {
            notes.push(`${label}: the sequence's values for ${Array.from(unfit).join(', ')} do not fit its inputs.`)
        }
        if (failed)
            notes.push(`${label} stopped after ${times.length} ticks: ${this.simulation.lastError ?? 'unknown error'}.`)
        if (schedule.ticks >= MAX_TIMED_TICKS) notes.push(`${label} reached ${MAX_TIMED_TICKS} ticks and was stopped.`)
        return { trace, notes }
    }

    /** SCCharts in the workspace, the one being edited or simulated picked already. */
    private async pickModels(): Promise<vscode.Uri[] | undefined> {
        const found = await vscode.workspace.findFiles('**/*.sctx', '{**/node_modules/**,**/.build/**}', 2000)
        if (found.length === 0) {
            return vscode.window.showOpenDialog({
                title: 'Models to run',
                defaultUri: this.folder(),
                canSelectMany: true,
                filters: { SCCharts: ['sctx'] },
            })
        }
        const current = new Set(
            [this.simulation.modelUri, vscode.window.activeTextEditor?.document.uri.toString()].filter(Boolean)
        )
        found.sort((a, b) => a.path.localeCompare(b.path))
        const picked = await vscode.window.showQuickPick(
            found.map((uri) => ({
                label: path.basename(uri.path),
                // The folder within the workspace; nothing for the workspace's own top level.
                description: path.dirname(vscode.workspace.asRelativePath(uri, false)).replace(/^\.$/, ''),
                picked: current.has(uri.toString()),
                uri,
            })),
            { title: 'Models to run on the sequence', canPickMany: true, matchOnDescription: true }
        )
        return picked?.map((item) => item.uri)
    }
}

/** File names, or relative paths where two files share a name. */
function uniqueLabels(uris: vscode.Uri[]): string[] {
    const names = uris.map((uri) => path.basename(uri.path))
    return uris.map((uri, index) =>
        names.indexOf(names[index]) === names.lastIndexOf(names[index])
            ? names[index]
            : vscode.workspace.asRelativePath(uri)
    )
}

/** The comparison as an unsaved Markdown document, shown in the preview. */
async function showReport(traces: NamedTrace[]): Promise<void> {
    const comparison = compareTraces(traces)
    const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: comparisonMarkdown(comparison),
    })
    await vscode.commands.executeCommand('markdown.showPreview', document.uri)
}

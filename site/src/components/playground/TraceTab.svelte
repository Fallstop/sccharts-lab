<!--
  The bottom panel's Trace tab: save the run (KTrace, CSV, JSON, XML; the whole run or its inputs as a sequence),
  replay a trace file through the simulation panel (a tour of its inputs; the outputs checked after every tick, Run
  stopping at a difference and at the end of the file), and compare the run with saved traces (the extension's
  report). The files are the SCCharts Lab extension's. trace-actions.ts does the work; trace-tab.ts mounts this.
-->
<script lang="ts">
    import { TRACE_FORMATS, type NamedTrace, type TraceFormat, type TraceRecord } from '@sccharts-lab/trace'
    import { compareRun, planReplay, readTraceFile, replaySummary, runFile, traceFileName, TRACE_ACCEPT, TRACE_FILE, type ReplayPlan } from './trace-actions'
    import { reportHtml } from './report-md'
    import { downloadBlob } from './folder'
    import { recall, remember } from './app-types'
    import { inlineMd } from '../frame/inline-md'
    import TraceGrid from './TraceGrid.svelte'
    import type { PanelTabContext } from './panel-tabs'

    let { ctx, icons }: { ctx: PanelTabContext; icons: Record<string, string> } = $props()
    const model = ctx.model
    const FORMAT_KEY = 'sccharts-guide:playground:trace-format'

    let format = $state<TraceFormat>((recall(FORMAT_KEY) as TraceFormat) || 'ktrace')
    let inputsOnly = $state(false)
    let problem = $state('')
    let folderFiles = $state<string[]>([])
    let replay = $state.raw<{ plan: ReplayPlan; trace: TraceRecord }>()
    let compared = $state.raw<NamedTrace[]>([])
    let view = $state<'replay' | 'compare'>('replay')
    let running = $state(false)
    let picking: 'replay' | 'compare' = 'replay'
    let input = $state<HTMLInputElement>()

    const sim = $derived(model.simulation)
    const history = $derived(model.simView?.history ?? [])
    const chart = $derived(sim?.result.chart?.name ?? 'chart')
    const ran = $derived(history.filter(t => !t.error).length)
    const canSave = $derived(!!sim?.result.ok && ran > 0)
    /** The panel plays this tab's replay now. */
    const live = $derived(!!replay && model.tour?.kind === 'trace' && !!model.simView?.tour)
    const cursor = $derived(live ? (model.simView?.cursor ?? 0) : -1)

    $effect(() => remember(FORMAT_KEY, format))

    // The tab's badge: the ticks of the replay that differ from the file.
    $effect(() => {
        const n = replay?.plan.byTick.size ?? 0
        ctx.setBadge(n || undefined, n ? `${n} ${n === 1 ? 'tick differs' : 'ticks differ'} from the file` : undefined, n ? 'warning' : undefined)
    })

    // Run stops where the outputs first differ from the file (and, as every tour, at its end).
    let last = 0
    $effect(() => {
        const at = cursor
        const plan = replay?.plan
        if (at === last) return
        last = at
        if (!plan || at < 1) return
        if (plan.byTick.has(at) || at >= plan.state.length) {
            if (running && plan.byTick.has(at)) ctx.sim.pause()
            running = false
        }
    })

    // ----- Save -------------------------------------------------------------------------------------------

    function fileText(): string {
        return runFile(sim!.result, history, { format, inputs: inputsOnly, model: model.project.active })
    }

    function download() {
        if (!canSave) return
        const name = traceFileName(chart, format, inputsOnly)
        downloadBlob(new Blob([fileText()], { type: 'text/plain;charset=utf-8' }), name)
        ctx.toast(`Downloaded ${name} (${ran} ${ran === 1 ? 'tick' : 'ticks'}).`)
    }

    async function saveToFolder() {
        if (!canSave) return
        const folder = await ctx.folder()
        if (!folder) return ctx.toast('The browser did not allow writing to the folder.')
        let name: string
        try {
            // The listing is a hint (it stops at 200 files): the folder itself says whether a name is free.
            const listed = await folder.list(TRACE_FILE)
            name = await folder.create(seen => traceFileName(chart, format, inputsOnly, [...listed, ...seen]), fileText())
        } catch (e) {
            return ctx.toast(`Saving to ${folder.name} failed: ${(e as Error).message}`)
        }
        ctx.toast(`Saved ${name} in ${folder.name}.`)
        await listFolder()
    }

    async function listFolder() {
        const folder = model.project.folder && !model.project.disconnected ? await ctx.folder() : undefined
        folderFiles = folder ? await folder.list(TRACE_FILE) : []
    }
    $effect(() => {
        void model.project.folder
        void model.project.disconnected
        void listFolder()
    })

    // ----- Replay -----------------------------------------------------------------------------------------

    function startReplay(trace: TraceRecord, label: string, renames: Record<string, string> = {}) {
        const compiled = model.compiled
        if (!compiled?.result.ok || !compiled.result.chart) {
            problem = 'The chart in the editor has problems, so it cannot be driven by a trace. The Problems tab lists them.'
            return
        }
        problem = ''
        const plan = planReplay(compiled.result, trace, label, renames)
        replay = { plan, trace }
        view = 'replay'
        running = false
        const n = plan.scenario.ticks.length
        ctx.sim.tour({
            scenario: plan.scenario,
            name: 'Replay',
            title: `Step through the inputs of ${label}`,
            intro: `These are the inputs of **${label}** (${n} ${n === 1 ? 'tick' : 'ticks'}); its outputs are checked after every tick. Press **Next** to run tick 1, or **Take over** to set the inputs yourself.`,
        })
    }

    function rename(from: string, to: string) {
        if (replay) startReplay(replay.trace, replay.plan.label, { ...replay.plan.renames, [from]: to })
    }

    function run() {
        if (!live) return
        running = true
        ctx.sim.run()
    }

    function pause() {
        running = false
        ctx.sim.pause()
    }

    // ----- Compare ----------------------------------------------------------------------------------------

    const report = $derived.by(() => {
        if (!compared.length || !sim?.result.ok) return undefined
        const { markdown, csv } = compareRun(sim.result, history, 'This run', compared, model.project.active)
        return { markdown, csv, html: reportHtml(markdown) }
    })

    function downloadReport(kind: 'md' | 'csv') {
        if (!report) return
        const name = `${chart}-comparison.${kind}`
        downloadBlob(new Blob([kind === 'md' ? report.markdown : report.csv], { type: kind === 'md' ? 'text/markdown' : 'text/csv' }), name)
        ctx.toast(`Downloaded ${name}.`)
    }

    // ----- Files ------------------------------------------------------------------------------------------

    function pick(mode: 'replay' | 'compare') {
        picking = mode
        input?.click()
    }

    async function take(files: { name: string; text: () => Promise<string> }[], mode: 'replay' | 'compare') {
        const read: NamedTrace[] = []
        for (const f of files) {
            const r = readTraceFile(await f.text(), f.name)
            if ('error' in r) {
                problem = `${f.name} is not a trace file the playground reads: ${r.error}`
                return
            }
            read.push({ label: f.name, trace: r.trace })
        }
        if (!read.length) return
        problem = ''
        if (mode === 'replay') startReplay(read[0].trace, read[0].label)
        else {
            compared = [...compared.filter(c => !read.some(r => r.label === c.label)), ...read]
            view = 'compare'
        }
    }

    async function fromFolder(path: string, mode: 'replay' | 'compare') {
        const folder = await ctx.folder()
        if (folder) await take([{ name: path, text: () => folder.read(path) }], mode)
    }

    function onDrop(e: DragEvent) {
        const files = [...(e.dataTransfer?.files ?? [])].filter(f => TRACE_FILE.test(f.name))
        if (!files.length) return
        e.preventDefault()
        void take(files, view === 'compare' && compared.length ? 'compare' : 'replay')
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sc-pg-trace" ondragover={e => e.dataTransfer?.types.includes('Files') && e.preventDefault()} ondrop={onDrop}>
    <input type="file" accept={TRACE_ACCEPT} multiple hidden bind:this={input} onchange={async () => {
        const files = [...(input?.files ?? [])]
        if (input) input.value = ''
        await take(files, picking)
    }} />
    <div class="sc-pg-trace__side">
        <section class="sc-pg-trace__group" aria-labelledby="sc-pg-trace-save">
            <h3 id="sc-pg-trace-save">Save this run</h3>
            <div class="sc-pg-trace__row">
                <select aria-label="Format" bind:value={format}>
                    {#each TRACE_FORMATS as f (f.format)}<option value={f.format}>{f.label}{f.format === 'ktrace' ? " (KIELER's)" : ''}</option>{/each}
                </select>
                <label class="sc-pg-trace__check"><input type="checkbox" bind:checked={inputsOnly} />Inputs only</label>
            </div>
            <div class="sc-pg-trace__row">
                <button type="button" class="sc-btn sc-btn--sm" aria-disabled={!canSave} onclick={download}>{@html icons.download}Download</button>
                {#if model.project.folder}
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" aria-disabled={!canSave} onclick={saveToFolder} title={`Save the file in the folder ${model.project.folder}`}>{@html icons.folder}Save in folder</button>
                {/if}
            </div>
            <p class="sc-pg-trace__hint">{canSave ? `${ran} ${ran === 1 ? 'tick' : 'ticks'} of ${chart}${inputsOnly ? ', its inputs as a sequence' : ''}.` : 'Run the chart first: the file holds the ticks you run.'}</p>
        </section>
        <section class="sc-pg-trace__group" aria-labelledby="sc-pg-trace-open">
            <h3 id="sc-pg-trace-open">Open a trace</h3>
            <p class="sc-pg-trace__hint"><b>Replay</b> drives the chart with its inputs and checks its outputs after each tick; <b>Compare</b> sets it beside this run.</p>
            <div class="sc-pg-trace__row">
                <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={() => pick('replay')}>{@html icons.open}Replay…</button>
                <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={() => pick('compare')}>{@html icons.compare}Compare…</button>
            </div>
        </section>
        {#if folderFiles.length}
            <section class="sc-pg-trace__group" aria-labelledby="sc-pg-trace-folder">
                <h3 id="sc-pg-trace-folder">In {model.project.folder}</h3>
                <ul class="sc-pg-trace__files">
                    {#each folderFiles as f (f)}
                        <li><span title={f}>{f}</span><button type="button" onclick={() => fromFolder(f, 'replay')} aria-label={`Replay ${f}`}>Replay</button><button type="button" onclick={() => fromFolder(f, 'compare')} aria-label={`Compare with ${f}`}>Compare</button></li>
                    {/each}
                </ul>
            </section>
        {/if}
    </div>

    <div class="sc-pg-trace__main">
        {#if problem}<p class="sc-pg-trace__problem" role="alert">{problem}</p>{/if}
        {#if replay && compared.length}
            <div class="sc-pg-trace__views" role="group" aria-label="Show">
                <button type="button" aria-pressed={view === 'replay'} onclick={() => (view = 'replay')}>Replay of {replay.plan.label}</button>
                <button type="button" aria-pressed={view === 'compare'} onclick={() => (view = 'compare')}>Comparison</button>
            </div>
        {/if}
        {#if view === 'replay' && replay}
            {@const plan = replay.plan}
            <div class="sc-pg-trace__head">
                <div class="sc-pg-trace__transport" role="group" aria-label="Replay">
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" disabled={!live || cursor <= 0} onclick={() => ctx.sim.back()}>Previous</button>
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--initial" disabled={!live || cursor >= plan.state.length} onclick={() => ctx.sim.step()}>Next</button>
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" disabled={!live || cursor >= plan.state.length} onclick={() => (running ? pause() : run())} title="Runs the file's ticks; stops where the outputs differ from the file">{running ? 'Pause' : 'Run'}</button>
                    {#if !live}<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={() => startReplay(replay!.trace, plan.label, plan.renames)}>Replay again</button>{/if}
                </div>
                <p class="sc-pg-trace__status" role="status">
                    <span><b>{plan.label}</b>{live ? `, tick ${Math.max(0, cursor)} of ${plan.state.length}` : ''}</span>{#if plan.byTick.has(cursor)}<span class="sc-pg-trace__differs">differs</span>{/if}
                </p>
            </div>
            <p class="sc-pg-trace__summary" class:is-match={plan.byTick.size === 0 && plan.outputs.length > 0}>{@html inlineMd(replaySummary(plan))}</p>
            {#if plan.suggestions.length}
                <p class="sc-pg-trace__renames">
                    The file names some variables another way:
                    {#each plan.suggestions as s (s.from)}<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={() => rename(s.from, s.to)}>Read <code>{s.from}</code> as <code>{s.to}</code></button>{/each}
                </p>
            {/if}
            <p class="sc-pg-trace__facts">
                {#if plan.inputs.length}Inputs from the file: {#each plan.inputs as n, i (n)}{i ? ', ' : ''}<code>{n}</code>{/each}.{/if}
                {#if plan.state.ignored.length} Not in the chart: {#each plan.state.ignored as n, i (n)}{i ? ', ' : ''}<code>{n}</code>{/each}.{/if}
                {#if plan.state.unset.length} Not set by the file (they keep their values): {#each plan.state.unset as n, i (n)}{i ? ', ' : ''}<code>{n}</code>{/each}.{/if}
                {#each plan.state.problems as p (p)} {p}{/each}
                {#each plan.state.notes as n (n)} {n}{/each}
            </p>
            <TraceGrid {plan} {cursor} onpick={tick => (live && tick <= (model.simView?.history.length ?? 0) ? ctx.sim.goto(tick) : undefined)} />
        {:else if view === 'compare' && compared.length}
            <div class="sc-pg-trace__head">
                <ul class="sc-pg-trace__chips" aria-label="Compared">
                    <li class="is-reference">This run ({ran} {ran === 1 ? 'tick' : 'ticks'})</li>
                    {#each compared as c (c.label)}
                        <li>{c.label}<button type="button" aria-label={`Remove ${c.label}`} title="Remove it from the comparison" onclick={() => (compared = compared.filter(x => x !== c))}>{@html icons.close}</button></li>
                    {/each}
                </ul>
                <div class="sc-pg-trace__row">
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" aria-disabled={!report} onclick={() => downloadReport('md')}>{@html icons.download}.md</button>
                    <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" aria-disabled={!report} onclick={() => downloadReport('csv')}>{@html icons.download}.csv</button>
                </div>
            </div>
            {#if report}
                <article class="sc-pg-report">{@html report.html}</article>
            {:else}
                <p class="sc-pg-trace__empty">Run the chart: the comparison is of the run in the simulation.</p>
            {/if}
        {:else}
            <div class="sc-pg-trace__empty">
                <p>A trace is a run, tick by tick: save one as KTrace (KIELER's format), CSV, JSON or XML, and the SCCharts Lab extension for VS Code opens it too. Replay one to drive the chart with its inputs and check its outputs, or compare runs.</p>
                <p>Drop a trace file here to replay it.</p>
            </div>
        {/if}
    </div>
</div>

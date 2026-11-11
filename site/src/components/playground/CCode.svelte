<!--
  The bottom panel's C code tab: the chart in the editor as C (generateC: `<Chart>.h` and `<Chart>.c`, the shape of
  KIELER's netlist-based compilation), read only and highlighted, with a file switch, naming (default, prefix,
  suffix: KIELER's #code.naming) and source comments, Copy, Download (.zip: the two files and a main.c that builds
  with one command, c-project.ts), and the Interface: which struct member is which chart variable. It follows the
  chart while the tab is shown (after a pause in typing). c-code-tab.ts mounts it.
-->
<script lang="ts">
    import { onDestroy } from 'svelte'
    import { generateC, type GeneratedC } from '@sccharts-lab/engine'
    import { cProjectFiles, interfaceRows, buildCommand } from './c-project'
    import { createCView, type CView } from './c-view'
    import { downloadBlob, zipFiles } from './folder'
    import { recall, remember } from './app-types'
    import { inlineMd } from '../frame/inline-md'
    import type { PanelTabContext } from './panel-tabs'

    let { ctx, icons }: { ctx: PanelTabContext; icons: Record<string, string> } = $props()
    const model = ctx.model
    const KEY = 'sccharts-guide:playground:c-options'
    const saved = (() => {
        try {
            return JSON.parse(recall(KEY) ?? '{}') as { naming?: string; comments?: boolean }
        } catch {
            return {}
        }
    })()

    let naming = $state<'default' | 'prefix' | 'suffix'>(saved.naming === 'prefix' || saved.naming === 'suffix' ? saved.naming : 'default')
    let comments = $state(saved.comments !== false)
    let which = $state<'header' | 'source'>('source')
    let showInterface = $state(false)
    let generated = $state.raw<GeneratedC>()
    /** The chart in the editor has errors (its compile is not ok). */
    let broken = $state(false)
    let host = $state<HTMLDivElement>()
    let view: CView | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let stale = true

    $effect(() => remember(KEY, JSON.stringify({ naming, comments })))

    function regenerate() {
        stale = false
        const compiled = model.compiled
        if (!compiled) return
        broken = !compiled.result.ok
        generated = broken ? undefined : generateC(compiled.result, { naming, comments })
    }

    // The chart changed, or an option: regenerate after a pause, and only while the tab is shown.
    $effect(() => {
        void model.compiled
        void naming
        void comments
        clearTimeout(timer)
        if (!ctx.visible) {
            stale = true
            return
        }
        timer = setTimeout(regenerate, generated ? 250 : 0)
    })
    ctx.onShow(() => {
        if (stale) regenerate()
    })

    const name = $derived(generated ? (which === 'header' ? generated.header : generated.source) : '')
    const text = $derived(generated?.ok ? generated.files[name] ?? '' : '')
    const lines = $derived(text ? text.split('\n').length - 1 : 0)
    const rows = $derived(generated?.ok ? interfaceRows(generated) : [])
    const notes = $derived(generated?.diagnostics.filter(d => d.severity !== 'error') ?? [])
    const errors = $derived(generated?.diagnostics.filter(d => d.severity === 'error') ?? [])

    $effect(() => {
        if (!host || !generated?.ok) return
        view ??= createCView(host)
        view.show(text, name)
    })
    onDestroy(() => view?.destroy())

    async function copy() {
        if (!text) return
        try {
            await navigator.clipboard.writeText(text)
            ctx.toast(`Copied ${name}.`)
        } catch {
            ctx.toast('The browser did not let the playground copy.')
        }
    }

    async function download() {
        const g = generated
        if (!g?.ok) return
        const file = `${g.chart}-c.zip`
        downloadBlob(await zipFiles(g.chart, cProjectFiles(g)), file)
        ctx.toast(`Downloaded ${file}: ${g.header}, ${g.source} and main.c. ${buildCommand(g).split(' && ')[0]} builds it.`)
    }
</script>

<div class="sc-pg-c">
    <div class="sc-pg-c__bar">
        {#if generated?.ok}
            <div class="sc-pg-c__files" role="group" aria-label="File">
                <button type="button" aria-pressed={which === 'header'} onclick={() => (which = 'header')}>{generated.header}</button>
                <button type="button" aria-pressed={which === 'source'} onclick={() => (which = 'source')}>{generated.source}</button>
            </div>
        {/if}
        <label class="sc-pg-c__option">
            <span>Names</span>
            <select bind:value={naming} title="The names of the functions and the struct (KIELER's #code.naming)">
                <option value="default">tick, reset, TickData</option>
                <option value="prefix">Prefix: {model.compiled?.result.chart?.name ?? 'Chart'}tick</option>
                <option value="suffix">Suffix: tick{model.compiled?.result.chart?.name ?? 'Chart'}</option>
            </select>
        </label>
        <label class="sc-pg-c__option"><input type="checkbox" bind:checked={comments} />Source comments</label>
        <span class="sc-pg-c__fill"></span>
        <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-pg__simtool" aria-expanded={showInterface} aria-controls="sc-pg-c-interface" aria-disabled={!rows.length} onclick={() => rows.length && (showInterface = !showInterface)} title="Which member of the struct is which variable of the chart">{@html icons.variables}<span class="sc-pg__simtool-label">Interface</span></button>
        <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-pg__simtool" aria-disabled={!text} onclick={copy} title={`Copy ${name || 'the file'}`}>{@html icons.copy}<span class="sc-pg__simtool-label">Copy</span></button>
        <button type="button" class="sc-btn sc-btn--sm sc-pg__simtool" aria-disabled={!generated?.ok} onclick={download} title="The header, the C file and a main.c, ready to build">{@html icons.zip}<span class="sc-pg__simtool-label">Download .zip</span></button>
    </div>

    {#if broken}
        <div class="sc-pg-c__empty">
            <p>The chart has errors, so there is no C code for it yet.</p>
            <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={() => ctx.showTab('problems')}>Show the problems</button>
        </div>
    {:else if generated && !generated.ok}
        <div class="sc-pg-c__empty">
            <p>There is no C code for this chart:</p>
            <ul>{#each errors as d (d.message)}<li>{@html inlineMd(d.message)}{#if d.span} <span class="sc-pg-c__where">line {d.span.line}</span>{/if}</li>{/each}</ul>
        </div>
    {:else if generated}
        {#if generated.hostCode || !generated.simulated || notes.length}
            <div class="sc-pg-c__notes">
                {#if generated.hostCode}
                    <p class="is-feature">The chart's host code is in the C as written: the browser cannot run it, but this C does. Download the .zip and build it.</p>
                {:else if !generated.simulated}
                    <p class="is-feature">Only C runs this chart: download the .zip and build it.</p>
                {/if}
                {#each notes as d (d.message)}<p>{@html inlineMd(d.message)}</p>{/each}
            </div>
        {/if}
        <div class="sc-pg-c__body">
            <div class="sc-pg-c__code" bind:this={host}></div>
            {#if showInterface && rows.length}
                <section class="sc-pg-c__interface" id="sc-pg-c-interface" aria-labelledby="sc-pg-c-interface-title">
                    <h3 id="sc-pg-c-interface-title">Interface <span>{generated.names.struct}* d</span></h3>
                    <table>
                        <thead><tr><th scope="col">Variable</th><th scope="col">Member</th><th scope="col">C type</th><th scope="col">Is</th></tr></thead>
                        <tbody>
                            {#each rows as r (r.member)}
                                <tr class={`is-${r.role.split(' ')[0]}`}><th scope="row"><code>{r.name}</code></th><td><code>{r.member}</code></td><td><code>{r.ctype}</code></td><td>{r.role}</td></tr>
                            {/each}
                        </tbody>
                    </table>
                    <p>Set the inputs, call <code>{generated.names.tick}(d)</code> (after <code>{generated.names.reset}(d)</code> once), read the outputs. The .zip's main.c does that.</p>
                </section>
            {/if}
        </div>
        <p class="sc-pg-c__status">{name}: {lines} lines</p>
    {:else}
        <p class="sc-pg-c__empty">The chart's C code appears here.</p>
    {/if}
</div>

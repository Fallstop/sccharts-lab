<!--
  A replay, tick by tick (the Trace tab): a column per tick of the file, the file's inputs (a value carried from the
  tick before is muted, as in a KTrace that notes only changes), then the outputs checked, as the model computed them;
  a cell where the model differs from the file is marked (a heavy dashed outline and the file's value under the
  model's, not colour alone) and so is its tick. The tick the simulation panel shows is the shaded column; a tick's
  number shows it in the panel.
-->
<script lang="ts">
    import { formatTraceValue } from '@sccharts-lab/trace'
    import type { ReplayPlan } from './trace-actions'

    let { plan, cursor, onpick }: { plan: ReplayPlan; cursor: number; onpick: (tick: number) => void } = $props()

    /** Ticks drawn at most (a long file scrolls; the rest is in the panel's own timing diagram). */
    const MAX = 400
    const ticks = $derived(Array.from({ length: Math.min(plan.state.length, MAX) }, (_, i) => i + 1))
    const shown = (v: unknown) => (v === undefined ? '' : formatTraceValue(v) === '' ? '""' : formatTraceValue(v))

    /** Each row's values per tick, a value the file leaves out carried from the tick before. */
    function carried(rows: Record<string, unknown>[], name: string): { value: unknown; set: boolean }[] {
        let last: unknown
        return ticks.map(t => {
            const v = rows[t - 1]?.[name]
            if (v !== undefined) last = v
            return { value: v === undefined ? last : v, set: v !== undefined }
        })
    }
    const inputs = $derived(plan.inputs.map(name => ({ name, cells: carried(plan.file, name) })))
    const outputs = $derived(plan.outputs.map(name => ({ name, cells: carried(plan.model, name) })))
    const differs = (name: string, tick: number) => plan.byTick.get(tick)?.find(m => m.name === name)

    let wrap = $state<HTMLDivElement>()
    $effect(() => {
        const at = cursor
        const th = wrap?.querySelector<HTMLElement>(`thead th[data-tick="${at}"]`)
        if (th && wrap) {
            const left = th.offsetLeft - wrap.clientWidth / 2
            if (th.offsetLeft < wrap.scrollLeft + 120 || th.offsetLeft > wrap.scrollLeft + wrap.clientWidth - 60) wrap.scrollTo({ left: Math.max(0, left) })
        }
    })
</script>

<div class="sc-pg-grid" bind:this={wrap} role="group" aria-label={`The replay of ${plan.label}, tick by tick`} tabindex="-1">
    <table>
        <colgroup>
            <col class="sc-pg-grid__names" />
            {#each ticks as t (t)}<col class:is-now={t === cursor} />{/each}
        </colgroup>
        <thead>
            <tr>
                <th scope="col" class="sc-pg-grid__corner">Tick</th>
                {#each ticks as t (t)}
                    <th scope="col" data-tick={t} class:is-different={plan.byTick.has(t)} aria-current={t === cursor ? 'true' : undefined}>
                        <button type="button" onclick={() => onpick(t)} title={plan.byTick.has(t) ? `Tick ${t} differs: show it` : `Show tick ${t}`}>{t}{#if plan.byTick.has(t)}<span aria-hidden="true">≠</span><span class="sc-visually-hidden">, differs</span>{/if}</button>
                    </th>
                {/each}
            </tr>
        </thead>
        <tbody>
            {#each inputs as row (row.name)}
                <tr class="is-input">
                    <th scope="row"><code>{row.name}</code><span class="sc-pg-grid__role">file</span></th>
                    {#each row.cells as c, i (i)}<td class:is-held={!c.set}>{shown(c.value)}</td>{/each}
                </tr>
            {/each}
            {#each outputs as row (row.name)}
                <tr class="is-output">
                    <th scope="row"><code>{row.name}</code><span class="sc-pg-grid__role">checked</span></th>
                    {#each row.cells as c, i (i)}
                        {@const m = differs(row.name, i + 1)}
                        <td class:is-different={!!m} title={m ? `Tick ${i + 1}: the model has ${shown(m.actual)}, the file ${shown(m.expected)}` : undefined}>
                            {shown(m ? m.actual : c.value)}{#if m}<span class="sc-pg-grid__file"><span class="sc-visually-hidden">; the file has </span>{shown(m.expected)}</span>{/if}
                        </td>
                    {/each}
                </tr>
            {/each}
        </tbody>
    </table>
    {#if plan.state.length > MAX}<p class="sc-pg-grid__more">The first {MAX} of {plan.state.length} ticks; the simulation's timing diagram has them all.</p>{/if}
</div>

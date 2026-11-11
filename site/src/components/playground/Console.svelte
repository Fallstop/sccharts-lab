<!--
  The bottom panel's Console: what the simulated chart prints with print(...) (TickResult.printed), each line with
  the tick it was printed in. It follows the run: the lines of the tick shown are in view, and the lines of ticks
  after it (after Back) are dimmed, as the timing diagram dims them. Clear hides the lines printed so far; Copy copies
  the lines shown, each with its tick. console-tab.ts mounts it and puts Clear and Copy in the panel's head.
-->
<script lang="ts">
    import { tick as settled } from 'svelte'
    import type { PlaygroundModel } from './model.svelte'

    interface Line {
        tick: number
        text: string
        /** The first line printed in its tick (it carries the tick's number). */
        first: boolean
    }

    let { model, onchange }: { model: PlaygroundModel; onchange?: (s: { count: number; lines: Line[] }) => void } = $props()

    /** Lines of ticks up to this one are cleared. */
    let cleared = $state(0)
    let list = $state<HTMLOListElement>()

    const view = $derived(model.simView)
    const runs = $derived(!!model.simulation?.result.ok)
    const history = $derived(view?.history ?? [])
    const cursor = $derived(view?.cursor ?? 0)

    const lines = $derived.by(() => {
        const out: Line[] = []
        history.forEach((t, i) => {
            if (i + 1 <= cleared) return
            ;(t.printed ?? []).forEach((text, k) => out.push({ tick: i + 1, text, first: k === 0 }))
        })
        return out
    })
    /** Printed up to the tick shown. */
    const shown = $derived(lines.filter(l => l.tick <= cursor))

    // A shorter run (a reset, Back and another input, a new chart) keeps what was cleared cleared.
    $effect(() => {
        if (cleared > history.length) cleared = history.length
    })

    $effect(() => onchange?.({ count: shown.length, lines: shown }))

    // Follow the run: the last line of the tick shown in view.
    $effect(() => {
        void cursor
        void lines.length
        void settled().then(() => {
            const items = list?.querySelectorAll<HTMLElement>('li[data-now]')
            items?.[items.length - 1]?.scrollIntoView({ block: 'nearest' })
        })
    })

    export function clear() {
        cleared = history.length
    }

    export function text(): string {
        return shown.map(l => `tick ${l.tick}: ${l.text}`).join('\n')
    }
</script>

<div class="sc-pg-console">
    {#if !model.simulation}
        <p class="sc-pg-console__empty">The console shows what the chart prints once it runs.</p>
    {:else if !model.simulation.result.chart}
        <p class="sc-pg-console__empty">There is no chart to run yet.</p>
    {:else if !runs}
        <p class="sc-pg-console__empty">This chart does not run (the Problems tab says why), so it prints nothing.</p>
    {:else if !lines.length}
        <p class="sc-pg-console__empty">
            {#if cleared && cleared === history.length}
                Cleared. What the chart prints from tick {cleared + 1} on appears here.
            {:else if history.length}
                Nothing printed in {history.length === 1 ? 'tick 1' : `ticks 1 to ${history.length}`}. A chart prints with <code>print(…)</code>, in a method or an action.
            {:else}
                What the chart prints with <code>print(…)</code> appears here, with the tick it was printed in.
            {/if}
        </p>
    {:else}
        <ol class="sc-pg-console__lines" bind:this={list} aria-label="Printed by the chart">
            {#each lines as line, i (i)}
                <li class:is-later={line.tick > cursor} class:is-first={line.first} data-now={line.tick <= cursor ? '' : undefined}>
                    <span class="sc-pg-console__tick" aria-hidden={!line.first}>{line.first ? line.tick : ''}</span>
                    <span class="sc-visually-hidden">Tick {line.tick}{line.tick > cursor ? ', after the tick shown' : ''}: </span>
                    <span class="sc-pg-console__text">{line.text}</span>
                </li>
            {/each}
        </ol>
    {/if}
</div>

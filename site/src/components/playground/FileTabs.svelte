<!--
  The editor's tabs (/playground): the open files, the active one marked; a click shows a file, the cross (or a
  middle click) closes its tab (the file stays in the project). The left and right arrow keys move between them.
  The button before them shows or hides the files sidebar.
-->
<script lang="ts">
    import { baseOf } from './project'
    import type { PlaygroundModel } from './model.svelte'

    let { model, actions, icons }: { model: PlaygroundModel; actions: { open(path: string): void; close(path: string): void }; icons: Record<string, string> } = $props()

    const p = $derived(model.project)
    let strip = $state<HTMLUListElement>()

    // The active tab in view (a long row of tabs scrolls).
    $effect(() => {
        void p.active
        strip?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })

    function onkey(e: KeyboardEvent) {
        const buttons = [...(strip?.querySelectorAll<HTMLButtonElement>('button.sc-pg-tab') ?? [])]
        const i = buttons.indexOf(e.target as HTMLButtonElement)
        if (i < 0) return
        const j = e.key === 'ArrowRight' ? Math.min(buttons.length - 1, i + 1) : e.key === 'ArrowLeft' ? Math.max(0, i - 1) : -1
        if (j < 0) return
        e.preventDefault()
        buttons[j].focus()
    }
</script>

<button type="button" class="sc-pg__tool sc-pg-tabs__files" data-action="toggle-files" aria-label="Files" title="Show or hide the files" aria-controls="sc-pg-files">{@html icons.sidebar}<span class="sc-pg-tabs__count" aria-hidden="true">{p.files.length > 1 ? p.files.length : ''}</span></button>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ul class="sc-pg-tabs" bind:this={strip} aria-label="Open files" onkeydown={onkey}>
    {#each p.open as path (path)}
        {@const unsaved = p.unsaved.includes(path)}
        <li class="sc-pg-tabs__item" class:is-active={path === p.active}>
            <button type="button" class="sc-pg-tab" aria-current={path === p.active ? 'true' : undefined} aria-controls="sc-pg-editor-panel" title={path} onclick={() => actions.open(path)} onauxclick={e => e.button === 1 && p.open.length > 1 && actions.close(path)}>
                <span class="sc-pg-file__glyph" aria-hidden="true"></span>
                <span class="sc-pg-tab__name">{baseOf(path)}</span>
                {#if unsaved}<span class="sc-pg-file__dot"><span class="sc-visually-hidden">, {p.folder ? 'not saved' : 'edited'}</span></span>{/if}
            </button>
            {#if p.open.length > 1}
                <button type="button" class="sc-pg-tab__close" aria-label={`Close ${baseOf(path)}`} title="Close the tab (the file stays in the project)" onclick={() => actions.close(path)}>{@html icons.close}</button>
            {/if}
        </li>
    {/each}
</ul>

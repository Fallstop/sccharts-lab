<!--
  The files sidebar (/playground): the project's files, the active one marked; open one with a click or Enter; new
  file (the + button), rename (double click, F2 or the pencil) and delete (Delete or the bin) in place, with the name
  checked as it is typed (project.ts, checkName). A folder project shows its folder, Save with the number of unsaved
  files, or Reconnect after a reload. project-control.ts mounts it and does the work.
-->
<script lang="ts">
    import { tick } from 'svelte'
    import { baseOf, dirOf } from './project'
    import type { PlaygroundModel } from './model.svelte'

    interface Actions {
        open(path: string): void
        rename(path: string, name: string): string | undefined
        remove(path: string): void
        create(name: string): string | undefined
        suggest(): string
        save(): void
        reconnect(): void
    }

    let { model, actions, icons }: { model: PlaygroundModel; actions: Actions; icons: Record<string, string> } = $props()

    const p = $derived(model.project)
    /** The file being renamed, or '' for a new one. */
    let editing = $state<string | null>(null)
    let draft = $state('')
    let error = $state('')
    let list = $state<HTMLUListElement>()

    async function edit(path: string | '') {
        editing = path
        draft = path || actions.suggest()
        error = ''
        await tick()
        const input = list?.querySelector<HTMLInputElement>('input[data-name]')
        input?.focus()
        // The name without its folder and extension is selected, as file explorers do.
        const from = draft.lastIndexOf('/') + 1
        const to = draft.toLowerCase().endsWith('.sctx') ? draft.length - 5 : draft.length
        input?.setSelectionRange(from, to)
    }

    async function commit() {
        if (editing === null) return
        const was = editing
        const problem = was ? actions.rename(was, draft) : actions.create(draft)
        if (problem) {
            error = problem
            return
        }
        editing = null
        error = ''
    }

    async function cancel() {
        const was = editing
        editing = null
        error = ''
        await tick()
        focusFile(was || p.active)
    }

    function focusFile(path: string) {
        list?.querySelector<HTMLButtonElement>(`button.sc-pg-file[data-path="${CSS.escape(path)}"]`)?.focus()
    }

    function onkey(e: KeyboardEvent) {
        const target = e.target as HTMLElement
        if (target instanceof HTMLInputElement) {
            if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
            } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                void cancel()
            }
            return
        }
        const path = target.closest<HTMLElement>('[data-path]')?.dataset.path
        const buttons = [...(list?.querySelectorAll<HTMLButtonElement>('button.sc-pg-file') ?? [])]
        const i = buttons.indexOf(target as HTMLButtonElement)
        let next: HTMLButtonElement | undefined
        if (e.key === 'ArrowDown') next = buttons[Math.min(buttons.length - 1, i + 1)]
        else if (e.key === 'ArrowUp') next = buttons[Math.max(0, i - 1)]
        else if (e.key === 'Home') next = buttons[0]
        else if (e.key === 'End') next = buttons[buttons.length - 1]
        else if (e.key === 'F2' && path) {
            e.preventDefault()
            void edit(path)
            return
        } else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && path && p.files.length > 1) {
            e.preventDefault()
            actions.remove(path)
            return
        }
        if (!next || i < 0) return
        e.preventDefault()
        next.focus()
    }
</script>

<div class="sc-pg-files__head">
    <h2 class="sc-pg-files__title" id="sc-pg-files-title">Files</h2>
    <button type="button" class="sc-pg__tool" data-new-file aria-label="New file" title="New file" onclick={() => edit('')}>{@html icons.plus}</button>
    <button type="button" class="sc-pg__tool sc-pg-files__hide" data-action="toggle-files" aria-label="Hide the files" title="Hide the files" aria-expanded="true">{@html icons.sidebar}</button>
</div>
{#if p.folder}
    <div class="sc-pg-files__folder" class:is-off={p.disconnected}>
        <span class="sc-pg-files__folder-name" title={`The folder ${p.folder} on your computer`}>{@html icons.folder}<span>{p.folder}</span></span>
        {#if p.disconnected}
            <button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={actions.reconnect} title="The browser asks again before the playground may read and write the folder">Reconnect</button>
        {:else if p.unsaved.length}
            <button type="button" class="sc-btn sc-btn--sm" onclick={actions.save} title="Write the unsaved files to the folder">Save {p.unsaved.length}</button>
        {:else}
            <span class="sc-pg-files__saved">Saved</span>
        {/if}
    </div>
{/if}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ul class="sc-pg-files__list" bind:this={list} aria-labelledby="sc-pg-files-title" onkeydown={onkey}>
    {#each p.files as path (path)}
        {@const unsaved = p.unsaved.includes(path)}
        <li class="sc-pg-files__item" class:is-active={path === p.active} data-path={path}>
            {#if editing === path}
                <input class="sc-pg-files__input" data-name bind:value={draft} aria-label={`New name for ${path}`} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'sc-pg-files-error' : undefined} spellcheck="false" autocomplete="off" onblur={() => (error ? undefined : commit())} />
                {#if error}<p class="sc-pg-files__error" id="sc-pg-files-error" role="alert">{error}</p>{/if}
            {:else}
                <button type="button" class="sc-pg-file" data-path={path} aria-current={path === p.active ? 'true' : undefined} title={path} onclick={() => actions.open(path)} ondblclick={() => edit(path)}>
                    <span class="sc-pg-file__glyph" aria-hidden="true"></span>
                    <span class="sc-pg-file__name">{#if dirOf(path)}<span class="sc-pg-file__dir">{dirOf(path)}</span>{/if}{baseOf(path)}</span>
                    {#if unsaved}<span class="sc-pg-file__dot" title="Not saved to the folder"><span class="sc-visually-hidden">, not saved</span></span>{/if}
                </button>
                <span class="sc-pg-file__acts">
                    <button type="button" class="sc-pg__tool" aria-label={`Rename ${path}`} title="Rename (F2)" onclick={() => edit(path)}>{@html icons.pencil}</button>
                    <button type="button" class="sc-pg__tool" aria-label={`Delete ${path}`} title={p.files.length > 1 ? 'Delete' : 'A project keeps at least one file'} aria-disabled={p.files.length < 2 ? 'true' : undefined} onclick={() => p.files.length > 1 && actions.remove(path)}>{@html icons.trash}</button>
                </span>
            {/if}
        </li>
    {/each}
    {#if editing === ''}
        <li class="sc-pg-files__item is-new">
            <input class="sc-pg-files__input" data-name bind:value={draft} aria-label="Name of the new file" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'sc-pg-files-error' : undefined} spellcheck="false" autocomplete="off" onblur={() => (draft.trim() && !error ? commit() : cancel())} />
            {#if error}<p class="sc-pg-files__error" id="sc-pg-files-error" role="alert">{error}</p>{/if}
        </li>
    {/if}
</ul>
<p class="sc-pg-files__hint">A file uses another's charts after <code>import "name"</code>.</p>

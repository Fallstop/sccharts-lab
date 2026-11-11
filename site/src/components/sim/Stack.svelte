<!--
	Texts stacked in one grid cell: every one is laid out, one is shown and the others are hidden (invisible, inert
	and out of the accessibility tree). The box is as tall as the tallest text at the current width, so changing
	which one is shown moves nothing. `shown` -1 shows none (the box keeps its height).
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte'

	interface Props {
		items: T[]
		shown: number
		/** Renders one item; the second argument says whether it is the one shown. */
		item: Snippet<[T, boolean]>
		class?: string
	}
	let { items, shown, item, class: cls = '' }: Props = $props()
</script>

<div class="sc-stack {cls}">
	{#each items as it, i (i)}
		<div class="sc-stack__item" aria-hidden={i === shown ? undefined : 'true'} inert={i !== shown}>{@render item(it, i === shown)}</div>
	{/each}
</div>

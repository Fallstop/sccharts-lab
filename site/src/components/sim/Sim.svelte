<!--
	The <Sim> island: a SimPanel driving the diagram and code view that Astro rendered into the same frame
	(found by `link`, the key of [data-sc-diagram] / [data-sc-code] / script[data-sc-map]). The chart is
	compiled in the browser; the layout is not (it was done at build time).
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte'
	import type { Scenario } from '../frame/examples'
	import { compile } from './engine'
	import type { LineMap } from './lines'
	import { copyCounters, focusElements, markCode, markDiagram, pulseTransitions, readMap } from './link'
	import SimPanel from './SimPanel.svelte'

	interface Props {
		source: string
		/** Imported files by name (`compile(source, { files })`). */
		files?: Record<string, string>
		link: string
		scenario?: Scenario
		show?: string[]
		regions?: boolean
		variant?: 'full' | 'compact'
		autoplay?: number
		initialTicks?: number
		intro?: string
		handover?: string
	}
	let { source, files, link, scenario, show, regions = true, variant = 'full', autoplay, initialTicks = 0, intro, handover }: Props = $props()

	// An island's props never change: compile once.
	const compiled = untrack(() => compile(source, { files: files ?? {} }))
	// For-region copies are named by their counter on the diagram (`i = 2`, markCopies).
	let counters: Record<string, string> | undefined
	let host: HTMLElement | undefined = $state()
	let frame: HTMLElement | null = $state(null)
	let svg: Element | null = null
	let code: Element | null = null
	let map: LineMap | undefined

	onMount(() => {
		frame = host?.closest<HTMLElement>('.sc-frame') ?? null
		if (!frame) return
		svg = frame.querySelector(`[data-sc-diagram="${CSS.escape(link)}"] svg.sc-diagram`)
		code = frame.querySelector(`[data-sc-code="${CSS.escape(link)}"]`)
		map = readMap(frame, link)
		// Clicking anywhere in the frame focuses it, so the keyboard shortcuts work.
		if (!frame.hasAttribute('tabindex')) frame.tabIndex = -1
	})
</script>

<div class="sc-sim-host" data-link={link} bind:this={host}>
	<SimPanel
		{compiled}
		{source}
		{scenario}
		{show}
		{regions}
		{variant}
		{autoplay}
		{initialTicks}
		{intro}
		{handover}
		keys={frame}
		onhighlight={(classes, view) => {
			if (view.tick?.copies && !counters) counters = copyCounters(compiled)
			markDiagram(svg, classes, view.tick, { prev: view.cursor > 1 ? view.history[view.cursor - 2] : null, counters })
			markCode(code, view.lines)
		}}
		onfire={(ids) => pulseTransitions(svg, ids)}
		onfocus={(ids) => focusElements(svg, code, map, ids)}
	/>
</div>

<!--
	The <Predict> island: the reader answers questions about a scenario (the value of a variable, or whether a
	state is active, after tick n); "Run and check" plays the scenario on the diagram and marks each answer
	with what really happened. The questions are rendered on the server, so they read without JavaScript.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte'
	import { tickClasses } from '~diagram/highlight'
	import type { TickResult, VariableInfo } from '~engine/types'
	import type { Scenario } from '../frame/examples'
	import { icons } from '../frame/icons'
	import { inlineCode } from '../frame/inline-md'
	import { compile, createSimulation } from './engine'
	import { formatValue, initialInputs } from './inputs'
	import { stateName } from './lines'
	import { markDiagram, pulseTransitions, reducedMotion } from './link'
	import { Timeline } from './timeline'
	import { hasSuspension, lanesFor, traceSvg } from './trace'

	/** A question, resolved at build time: `state` is a state id. */
	export type Ask = { tick: number; value: string } | { tick: number; state: string }

	interface Props {
		source: string
		/** Imported files by name (`compile(source, { files })`). */
		files?: Record<string, string>
		link: string
		scenario: Scenario
		ask: Ask[]
		id: string
		/** KIELER's run of the scenario (its data pool after each tick), for a chart the guide's engine cannot
		 *  run: the answers about values are checked against it. */
		recorded?: { values: Record<string, unknown> }[]
		/** Why the guide's engine cannot run the chart (no final full stop). */
		notice?: string
	}
	let props: Props = $props()
	// An island's props never change: read them once.
	const { source, files, link, scenario, ask, id, recorded, notice } = untrack(() => ({ ...props }))

	const compiled = compile(source, { files: files ?? {} })
	/** The guide's engine runs the chart (otherwise the answers are checked against `recorded`, if given). */
	const runnable = !notice && compiled.ok && !!compiled.chart && !compiled.diagnostics.some((d) => d.code === 'unsupported')
	const checkable = runnable || (!!recorded && recorded.length >= Math.max(...ask.map((a) => a.tick)))
	const root = compiled.chart?.id ?? ''
	const lastTick = Math.max(...ask.map((a) => a.tick))
	const lanes = lanesFor(compiled.interface, compiled.chart)
	const varOf = (name: string): VariableInfo | undefined => compiled.interface.find((v) => v.name === name)

	type Kind = 'presence' | 'bool' | 'number' | 'text' | 'state'
	const kindOf = (a: Ask): Kind => {
		if ('state' in a) return 'state'
		const v = varOf(a.value)
		if (!v) {
			const r = recorded?.[0]?.values[a.value]
			return typeof r === 'boolean' ? 'bool' : typeof r === 'number' ? 'number' : 'text'
		}
		if (v.signal && !v.valued) return 'presence'
		if (v.type === 'bool') return 'bool'
		if (v.type === 'int' || v.type === 'float') return 'number'
		return 'text'
	}

	let answers = $state<string[]>(ask.map(() => ''))
	/** `unchecked`: KIELER's recording does not say (which states are active): no verdict. */
	let results = $state<{ right: boolean; actual: string; unchecked?: boolean }[] | undefined>()
	let history = $state<TickResult[]>([])
	let cursor = $state(0)
	let playing = $state(false)
	let failure = $state<string | undefined>()
	let width = $state(640)
	let host: HTMLElement | undefined = $state()
	let traceEl: HTMLElement | undefined = $state()
	let svg: Element | null = null
	let timer: ReturnType<typeof setTimeout> | undefined

	function actualOf(a: Ask, t: TickResult): string {
		if ('state' in a) return t.active.includes(a.state) ? 'yes' : 'no'
		const v = varOf(a.value)
		if (v?.signal && !v.valued) return t.present[a.value] ? 'true' : 'false'
		return formatValue(t.values[a.value] ?? null)
	}

	function same(kind: Kind, given: string, actual: string): boolean {
		if (kind === 'number') {
			const g = Number(given.trim())
			const r = Number(actual)
			return given.trim() !== '' && Number.isFinite(g) && Math.abs(g - r) <= 1e-6 * Math.max(1, Math.abs(r))
		}
		if (kind === 'text') return given.trim().replace(/^"|"$/g, '') === actual.replace(/^"|"$/g, '')
		return given === actual
	}

	/** The answer in KIELER's data pool after the tick (`V_val` is a valued signal's value). */
	function recordedOf(a: Ask): { actual: string; unchecked?: boolean } {
		if ('state' in a) return { actual: '', unchecked: true }
		const values = recorded?.[a.tick - 1]?.values ?? {}
		const v = varOf(a.value)
		const raw = v?.signal && v.valued ? values[`${a.value}_val`] : values[a.value]
		if (v?.signal && !v.valued) return { actual: raw ? 'true' : 'false' }
		return { actual: formatValue((raw ?? null) as never) }
	}

	function check() {
		if (timer) clearTimeout(timer)
		if (!runnable) {
			if (!checkable) return
			results = ask.map((a, i) => {
				const r = recordedOf(a)
				return { ...r, right: !r.unchecked && same(kindOf(a), answers[i], r.actual) }
			})
			return
		}
		// The run plays on the diagram: show it, unless the view shown has it already (Both).
		const frame = host?.closest('.sc-frame')
		const selected = frame?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
		const showsDiagram = !selected || selected.dataset.view === 'diagram' || (selected.dataset.show ?? '').split(' ').includes('diagram')
		const tab = frame?.querySelector<HTMLButtonElement>('[role="tab"][data-view="diagram"]')
		if (tab && !showsDiagram) tab.click()
		failure = undefined
		let ticks: TickResult[]
		try {
			const t = new Timeline(createSimulation(compiled), initialInputs(compiled.interface), scenario)
			for (let i = 0; i < lastTick; i++) t.step()
			ticks = t.history.slice(0, lastTick)
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
			return
		}
		history = ticks
		results = undefined
		const finish = () => {
			playing = false
			results = ask.map((a, i) => {
				const actual = actualOf(a, ticks[a.tick - 1])
				return { right: same(kindOf(a), answers[i], actual), actual }
			})
		}
		if (reducedMotion()) {
			cursor = lastTick
			show()
			finish()
			return
		}
		playing = true
		cursor = 0
		const next = () => {
			cursor++
			show(true)
			if (cursor >= lastTick) return finish()
			timer = setTimeout(next, 420)
		}
		timer = setTimeout(next, 120)
	}

	function show(fire = false) {
		const t = cursor ? history[cursor - 1] : undefined
		markDiagram(svg, t ? tickClasses(t) : {}, t)
		if (fire && t) pulseTransitions(svg, t.taken)
	}

	function goto(n: number) {
		if (playing) return
		cursor = n
		show()
	}

	function traceClick(e: MouseEvent) {
		const hit = [...(traceEl?.querySelectorAll<SVGRectElement>('.wv-hit') ?? [])].find((h) => {
			const r = h.getBoundingClientRect()
			return e.clientX >= r.left && e.clientX < r.right
		})
		if (hit?.dataset.tick) goto(Number(hit.dataset.tick))
	}

	function again() {
		results = undefined
		history = []
		cursor = 0
		show()
	}

	onMount(() => {
		svg = host?.closest('.sc-frame')?.querySelector(`[data-sc-diagram="${CSS.escape(link)}"] svg.sc-diagram`) ?? null
		const ro = new ResizeObserver(() => host?.clientWidth && (width = host.clientWidth))
		if (host) ro.observe(host)
		return () => {
			ro.disconnect()
			if (timer) clearTimeout(timer)
		}
	})

	/** "Right: `light` is `true` after tick 2." / "Not quite: after tick 5, `light` is `false`, not `true`." */
	function verdict(a: Ask, kind: Kind, right: boolean, actual: string, given: string, unchecked = false): string {
		// As the question put it: a valued signal's value is `val(V)`.
		const subject = 'state' in a ? `<code>${stateName(a.state, root)}</code>` : kind !== 'presence' && varOf(a.value)?.signal ? `<code>val(${a.value})</code>` : `<code>${a.value}</code>`
		const fact =
			kind === 'state' ? `${subject} is ${actual === 'yes' ? '<strong>active</strong>' : '<strong>not active</strong>'}`
			: kind === 'presence' ? `${subject} is <strong>${actual === 'true' ? 'present' : 'absent'}</strong>`
			: `${subject} is <strong><code>${actual === '' ? 'unset' : actual.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></strong>`
		if (unchecked) return `KIELER's recording of this run does not say which states are active, so this answer cannot be checked here.`
		if (right) return `Right: after tick ${a.tick}, ${fact}.`
		if (!given) return `After tick ${a.tick}, ${fact}. (You gave no answer.)`
		const yours = kind === 'state' ? '' : kind === 'presence' ? `, not ${given === 'true' ? 'present' : 'absent'}` : `, not <code>${given.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`
		return `Not quite: after tick ${a.tick}, ${fact}${yours}.`
	}

	const score = $derived(results ? results.filter((r) => r.right).length : 0)
	const checked = $derived(results ? results.filter((r) => !r.unchecked).length : 0)
	// The run is over once checked: only its ticks, no empty columns for ticks to come.
	const traceHtml = $derived(history.length ? traceSvg(lanes, { history, cursor, width, fill: false }, `Timing diagram of the scenario, ticks 1 to ${history.length}`) : '')
	const suspension = $derived(history.length > 0 && hasSuspension(lanes, history))
	// A valued signal's question is about its value (the check compares val(S), present or not).
	const question = (a: Ask) =>
		'state' in a
			? `is <code>${stateName(a.state, root)}</code> active?`
			: kindOf(a) === 'presence'
				? `is <code>${a.value}</code> present?`
				: varOf(a.value)?.signal
					? `what is <code>val(${a.value})</code>?`
					: `what is <code>${a.value}</code>?`
</script>

<div class="sc-predict__run" bind:this={host}>
	<form class="sc-predict__form" onsubmit={(e) => (e.preventDefault(), check())}>
		<ol class="sc-predict__asks">
			{#each ask as a, i (i)}
				{@const kind = kindOf(a)}
				{@const r = results?.[i]}
				<li class:is-right={r?.right} class:is-wrong={r && !r.right && !r.unchecked}>
					{#if kind === 'state'}
						<fieldset>
							<legend>After tick {a.tick}, {@html question(a)}</legend>
							<label><input type="radio" name={`${id}-${i}`} value="yes" bind:group={answers[i]} disabled={playing} /> Yes</label>
							<label><input type="radio" name={`${id}-${i}`} value="no" bind:group={answers[i]} disabled={playing} /> No</label>
						</fieldset>
					{:else}
						<label for={`${id}-${i}`}>After tick {a.tick}, {@html question(a)}</label>
						{#if kind === 'presence'}
							<select id={`${id}-${i}`} bind:value={answers[i]} disabled={playing}><option value="">Choose</option><option value="true">Present</option><option value="false">Absent</option></select>
						{:else if kind === 'bool'}
							<select id={`${id}-${i}`} bind:value={answers[i]} disabled={playing}><option value="">Choose</option><option value="true">true</option><option value="false">false</option></select>
						{:else}
							<input id={`${id}-${i}`} type={kind === 'number' ? 'text' : 'text'} inputmode={kind === 'number' ? 'decimal' : undefined} bind:value={answers[i]} disabled={playing} autocomplete="off" />
						{/if}
					{/if}
					{#if r}
						<p class="sc-predict__verdict" role="status">
							{#if !r.unchecked}<span class="sc-predict__mark" aria-hidden="true">{@html r.right ? icons.check : icons.cross}</span>{/if}
							<span>{@html verdict(a, kind, r.right, r.actual, answers[i], r.unchecked)}</span>
						</p>
					{/if}
				</li>
			{/each}
		</ol>
		<div class="sc-predict__actions">
			{#if results}
				<p class="sc-predict__score" role="status"><b>{score} of {checked}</b> right.{#if !runnable}&nbsp;Checked against KIELER's own run of this scenario.{/if}</p>
				<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" onclick={again}>Try again</button>
			{:else}
				<button type="submit" class="sc-btn sc-btn--sm sc-btn--initial" disabled={playing || !checkable}>{@html runnable ? icons.play : icons.check}{playing ? `Running tick ${cursor}` : runnable ? 'Run and check' : 'Check'}</button>
				<span class="sc-predict__note">{@html inlineCode(runnable ? (playing ? '' : 'Plays the scenario on the diagram, then marks each answer.') : checkable ? `${notice ?? 'The guide\'s simulator cannot run this chart'}: the answers are checked against KIELER's own run of the scenario.` : `${notice ?? compiled.diagnostics.find((d) => d.severity === 'error')?.message ?? 'The guide\'s simulator cannot run this chart'}, so it cannot check the answers here.`)}</span>
			{/if}
		</div>
		{#if failure}<p class="sc-sim__failure" role="alert">The guide's simulator failed on this chart: {failure}</p>{/if}
	</form>
	{#if traceHtml}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
		<div class="sc-predict__trace sc-trace" bind:this={traceEl} role="group" tabindex="0" aria-label="Timing diagram of the scenario (click a tick to show it on the diagram)" onclick={traceClick}>
			{@html traceHtml}
		</div>
		{#if suspension}
			<p class="sc-trace-legend sc-predict__legend"><svg class="sc-trace-legend__hatch" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M1 11L11 1M7 11L17 1M13 11L21 3" /></svg><span>Hatched: the region is suspended in that tick (frozen by a <code>suspend</code>).</span></p>
		{/if}
	{/if}
</div>

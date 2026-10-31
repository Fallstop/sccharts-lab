<!--
	The <Compare> island: two charts stepped together with the same inputs (the union of their inputs; each
	chart gets the ones it declares). Each chart keeps its own diagram (rendered at build time) and its own
	lanes in the timing diagram; outputs that both charts have are marked in the ticks where they differ.
	With a scenario it starts as a guided tour (as <Sim>): Next / Previous through the scripted ticks with their
	notes, both charts getting the scenario's inputs, until the reader takes over.
-->
<script lang="ts">
	import { onMount, tick, untrack } from 'svelte'
	import { tickClasses } from '~diagram/highlight'
	import type { TickResult, Value, VariableInfo } from '~engine/types'
	import type { Scenario } from '../frame/examples'
	import { icons } from '../frame/icons'
	import { errorLink } from '../frame/error-links'
	import { inlineCode, inlineMd } from '../frame/inline-md'
	import { describeTick, type DescribeContext } from './describe'
	import { compile, createSimulation, traceableVariables, type Simulation } from './engine'
	import Inputs from './Inputs.svelte'
	import { controlsFor, formatValue, initialInputs, type InputState } from './inputs'
	import { elementsOf, lineMap, tickLines } from './lines'
	import { copyCounters, focusElements, keepFocus, keepTickInView, markCode, markDiagram, pulseTransitions, reducedMotion, roving } from './link'
	import { pairStepper, unionInputs } from './pair'
	import { Timeline } from './timeline'
	import { compareSvg, differences, forCopiesIn, hasSuspension, lanesFor, resolveShow, terminationText, type ComparedChart, type ForCopies } from './trace'

	interface Side {
		source: string
		link: string
		/** Imported files by name (`compile(source, { files })`). */
		files?: Record<string, string>
	}
	interface Props {
		a: Side
		b: Side
		/** A guided tour: the same scripted inputs for both charts, with a note per tick. */
		scenario?: Scenario
		/** Variables to trace, as Sim's `show` (default: inputs and outputs; inner locals and members too): each
		 *  chart traces the names it declares; locals both charts have are compared like outputs. */
		show?: string[]
	}
	let props: Props = $props()
	// An island's props never change: read them once.
	const { a, b, scenario, show } = untrack(() => ({ ...props }))
	const tour = scenario && scenario.expect !== 'error' && scenario.ticks?.length ? scenario : undefined

	const ca = compile(a.source, { files: a.files ?? {} })
	const cb = compile(b.source, { files: b.files ?? {} })
	const runnable = (c: typeof ca) => c.ok && !!c.chart && !c.diagnostics.some((d) => d.code === 'unsupported')
	const ok = runnable(ca) && runnable(cb)
	const nameA = ca.chart?.name ?? 'A'
	const nameB = cb.chart?.name ?? 'B'
	const id = $props.id()

	// The union of the inputs, in order: A's, then B's that A does not have.
	const union: VariableInfo[] = unionInputs(ca.interface, cb.interface)
	const controls = controlsFor(union)

	let sa: Simulation | undefined
	let sb: Simulation | undefined
	let timeline: Timeline | undefined
	let failure = $state<string | undefined>()
	if (ok) {
		try {
			sa = createSimulation(ca)
			sb = createSimulation(cb)
			const { stepper, readPool } = pairStepper(sa, ca.interface, sb, cb.interface)
			timeline = new Timeline(stepper, initialInputs(union), tour, readPool)
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
		}
	}

	const own = (iface: VariableInfo[]) => (show ? show.filter((n) => iface.some((v) => v.name === n)) : undefined)
	const inputLanes = lanesFor(union, undefined, own(union))
	// Each chart traces what it can resolve: its own variables, inner locals and members (trace.ts, resolveShow).
	const traceableA = show ? traceableVariables(ca) : undefined
	const traceableB = show ? traceableVariables(cb) : undefined
	const ownOf = (c: typeof ca, traceable: typeof traceableA) => (show ? show.filter((n) => resolveShow([n], c.interface, c.chart, traceable).targets.length > 0) : undefined)
	const showA = ownOf(ca, traceableA)
	const showB = ownOf(cb, traceableB)
	const ctxA: DescribeContext | undefined = ca.chart ? { info: elementsOf(ca.chart), source: a.source, iface: ca.interface, program: ca.program } : undefined
	const ctxB: DescribeContext | undefined = cb.chart ? { info: elementsOf(cb.chart), source: b.source, iface: cb.interface, program: cb.program } : undefined
	const mapA = ca.chart ? lineMap(ca.chart, a.source) : undefined
	const mapB = cb.chart ? lineMap(cb.chart, b.source) : undefined

	let rev = $state(0)
	let mounted = $state(false)
	let running = $state(false)
	let live = $state('')
	let width = $state(640)
	let runTimer: ReturnType<typeof setTimeout> | undefined
	let traceEl: HTMLElement | undefined = $state()
	let root: HTMLElement | undefined = $state()

	const snap = $derived.by(() => {
		void rev
		const t = timeline
		const cursor = t?.cursor ?? 0
		return {
			cursor,
			end: t?.end ?? 0,
			state: t?.controls() ?? initialInputs(union),
			canReplay: t?.canReplay ?? false,
			edited: t?.dirty ?? false,
			tour: t?.tour ?? false,
			tourLength: t?.tourLength ?? 0,
			note: t?.note,
			ha: sa?.history ?? [],
			hb: sb?.history ?? [],
			ta: cursor ? sa?.history[cursor - 1] : undefined,
			tb: cursor ? sb?.history[cursor - 1] : undefined,
		}
	})

	const merged = (x: TickResult, y: TickResult | undefined): TickResult => ({ ...x, values: { ...y?.values, ...x.values }, present: { ...y?.present, ...x.present } })
	// Region lanes, one per for-region copy: from the compiler when it says (CompileResult.forCopies, so the lanes are
	// there before the first tick), else once the ticks report copies (trace.ts).
	const staticCopies = (c: typeof ca) => (c as typeof ca & { forCopies?: ForCopies[] }).forCopies
	const lanesA = $derived(lanesFor(ca.interface, ca.chart, showA, true, staticCopies(ca) ?? forCopiesIn(snap.ha), traceableA))
	const lanesB = $derived(lanesFor(cb.interface, cb.chart, showB, true, staticCopies(cb) ?? forCopiesIn(snap.hb), traceableB))
	const sideA: ComparedChart = $derived({ name: nameA, lanes: lanesA, history: snap.ha })
	const sideB: ComparedChart = $derived({ name: nameB, lanes: lanesB, history: snap.hb })
	const suspension = $derived(ok && (hasSuspension(lanesA, snap.ha) || hasSuspension(lanesB, snap.hb)))
	const traceHtml = $derived(ok ? compareSvg(inputLanes, snap.ha.map((t, i) => merged(t, snap.hb[i])), sideA, sideB, { cursor: snap.cursor, width }) : '')
	const storyA = $derived(snap.ta && ctxA ? describeTick(snap.ta, snap.cursor > 1 ? snap.ha[snap.cursor - 2] : undefined, ctxA) : undefined)
	const storyB = $derived(snap.tb && ctxB ? describeTick(snap.tb, snap.cursor > 1 ? snap.hb[snap.cursor - 2] : undefined, ctxB) : undefined)

	/** A run-time error stopped a chart and the other one has stopped too (an error, or termination), in the last tick
	 *  computed, which is shown: stepping again would only repeat it (KIELER's simulation stays stopped), so Step, Run,
	 *  Next and the inputs are off and the foot offers Restart; Back still goes back. */
	const stopped = (t: TickResult | undefined) => !!t && (!!t.error || t.terminated)
	const halted = $derived(snap.cursor > 0 && snap.cursor === snap.end && !!(snap.ta?.error || snap.tb?.error) && stopped(snap.ta) && stopped(snap.tb))
	/** Where Step, Run and Next send focus when a run-time error turns them off (keepFocus). */
	const restartButton = () => root?.querySelector<HTMLButtonElement>('.sc-sim__restart')

	/** How the two charts' termination compares in the tick shown (inline Markdown; '' when nothing to say). */
	const termText = $derived(terminationText({ name: nameA, history: snap.ha }, { name: nameB, history: snap.hb }, snap.cursor))

	/** The outputs that differ in the tick shown, and how the charts' termination differs, as inline Markdown. */
	const diffText = $derived.by(() => {
		if (!snap.ta || !snap.tb) return ''
		const outputs = outputText()
		return termText ? `${outputs} ${termText}` : outputs
	})

	function outputText(): string {
		const d = differences(sideA, sideB)
		const parts: string[] = []
		for (const [key, cols] of d) {
			if (!cols[snap.cursor - 1]) continue
			const la = lanesA.find((l) => l.key === key)!
			const lb = lanesB.find((l) => l.key === key)!
			// A pure signal is present or absent (as in the table beside this line), not true or false; each chart's
			// value is read with its own lane (the same name can be a pure signal in one and a variable in the other).
			const say = (lane: typeof la, v: unknown) =>
				typeof v === 'object' && v
					? `${(v as { present: boolean }).present ? 'present' : 'absent'}, ${formatValue((v as { value: Value }).value)}`
					: lane.presence && typeof v === 'boolean'
						? v ? 'present' : 'absent'
						: lane.array && typeof v === 'string'
							? v
							: formatValue(v as Value)
			parts.push(`\`${la.name}\` is \`${say(la, la.sample(snap.ta!))}\` in \`${nameA}\` but \`${say(lb, lb.sample(snap.tb!))}\` in \`${nameB}\``)
		}
		const shared = d.size
		if (!shared) return show ? 'The two charts have no traced variables in common to compare.' : 'The two charts have no outputs in common to compare.'
		if (!parts.length) return `The ${show ? 'traced values' : 'outputs'} agree in tick ${snap.cursor}.`
		return `They differ in tick ${snap.cursor}: ${parts.join('; ')}.`
	}

	function frameEl() {
		return root?.closest<HTMLElement>('.sc-frame') ?? null
	}
	let svgA: Element | null = null
	let svgB: Element | null = null
	let codeA: Element | null = null
	let codeB: Element | null = null

	$effect(() => {
		void rev
		if (!mounted) return
		const before = (h: TickResult[]) => (snap.cursor > 1 ? h[snap.cursor - 2] : null)
		markDiagram(svgA, snap.ta ? tickClasses(snap.ta) : {}, snap.ta, { prev: before(snap.ha), counters: snap.ta?.copies ? copyCounters(ca) : undefined })
		markDiagram(svgB, snap.tb ? tickClasses(snap.tb) : {}, snap.tb, { prev: before(snap.hb), counters: snap.tb?.copies ? copyCounters(cb) : undefined })
		if (mapA && ca.chart) markCode(codeA, tickLines(mapA, snap.ta, ca.chart.id))
		if (mapB && cb.chart) markCode(codeB, tickLines(mapB, snap.tb, cb.chart.id))
	})

	$effect(() => {
		// Keep the shown tick in view after each change (scrolling only when it is out of view).
		void traceHtml
		if (!traceEl) return
		tick().then(() => keepTickInView(traceEl))
	})

	/** A "What happened" line of one chart is pointed at or focused: mark its elements on that chart only. */
	function focusSide(side: number, ids: string[]) {
		focusElements(svgA, codeA, mapA, side === 0 ? ids : [])
		focusElements(svgB, codeB, mapB, side === 1 ? ids : [])
	}

	function changed(fire = false) {
		// The Restart button of a stopped run goes with the error (Restart, Back, R): focus moves on to Step rather
		// than dropping to the page.
		const fromHalted = !!root?.querySelector('.sc-sim__halted')?.contains(document.activeElement)
		rev++
		if (fromHalted) {
			tick().then(() => {
				const focus = document.activeElement
				if (!focus || focus === document.body) root?.querySelector<HTMLButtonElement>('.sc-simctl__step:not(:disabled)')?.focus()
			})
		}
		if (fire && !reducedMotion()) {
			if (snap.ta) pulseTransitions(svgA, snap.ta.taken)
			if (snap.tb) pulseTransitions(svgB, snap.tb.taken)
		}
		live = snap.cursor
			? `Tick ${snap.cursor}. ${snap.note ? `${snap.note.replace(/[`*\\]/g, '')} ` : ''}${nameA}: ${storyA?.summary.replace(/^Tick \d+\. /, '') ?? ''} ${nameB}: ${storyB?.summary.replace(/^Tick \d+\. /, '') ?? ''} ${diffText.replace(/[`*]/g, '')}${halted ? ' Step and Run are off: restart the simulation, or go back a tick and change an input.' : ''}`
			: 'Tick 0: nothing has run yet.'
	}

	function guard(fn: () => boolean | void, fire = false) {
		if (!timeline) return
		try {
			if (fn() !== false) changed(fire)
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
			stop()
		}
	}
	const step = () => (stop(), halted || guard(() => void timeline!.step(), true))
	const back = () => (stop(), guard(() => timeline!.back()))
	const reset = () => (stop(), guard(() => void timeline!.reset()))
	const goto = (n: number) => (stop(), guard(() => timeline!.goto(n)))
	const takeOver = () => (stop(), guard(() => void timeline!.takeOver(true)))
	const restartTour = () => (stop(), guard(() => void timeline!.reset(true)))

	function stop() {
		running = false
		if (runTimer) clearTimeout(runTimer)
		runTimer = undefined
	}
	function run() {
		if (halted) return
		running = true
		const tickOnce = () => {
			if (!running || !timeline) return
			const wasTour = timeline.tour
			guard(() => void timeline!.step(), true)
			// Stop when both charts have terminated, and at the end of the tour.
			if ((snap.ta?.terminated && snap.tb?.terminated) || halted || (wasTour && snap.cursor >= snap.tourLength)) return stop()
			runTimer = setTimeout(tickOnce, 500)
		}
		runTimer = setTimeout(tickOnce, 500)
	}

	function edit(next: InputState) {
		if (!timeline || halted) return
		stop()
		timeline.edit(next)
		rev++
	}

	// Timed charts (deltaT in, sleepT out): "Advance by sleepT" moves time to the earlier of the two charts' next
	// deadlines, as one environment running both would.
	const timed = union.some((v) => v.name === 'deltaT') && [...ca.interface, ...cb.interface].some((v) => v.name === 'sleepT' && v.output)
	const sleep = $derived.by(() => {
		const vs = [snap.ta, snap.tb].map((t) => (t && !t.error ? t.values.sleepT : undefined)).filter((v): v is number => typeof v === 'number')
		return timed && vs.length ? Math.min(...vs) : undefined
	})
	function advance() {
		if (!timeline || sleep === undefined || halted) return
		stop()
		const now = timeline.controls()
		timeline.edit({ levels: { ...now.levels, deltaT: sleep }, pulses: now.pulses })
		guard(() => void timeline!.step(), true)
	}

	function onKey(e: KeyboardEvent) {
		if (!timeline || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
		const target = e.target as HTMLElement
		if (target.closest('input:not([type="checkbox"]), select, textarea')) return
		const control = target.closest('button, a, summary, input, [role="tab"]')
		if ((e.key === ' ' || e.key === 'Enter') && !control) (e.preventDefault(), step())
		else if (e.key === 'ArrowRight' && !target.closest('[role="tablist"]')) (e.preventDefault(), step())
		else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && !target.closest('[role="tablist"]')) (e.preventDefault(), back())
		else if (e.key === 'r' || e.key === 'R') (e.preventDefault(), reset())
	}

	function traceClick(e: MouseEvent) {
		const hit = [...(traceEl?.querySelectorAll<SVGRectElement>('.wv-hit') ?? [])].find((h) => {
			const r = h.getBoundingClientRect()
			return e.clientX >= r.left && e.clientX < r.right
		})
		if (hit?.dataset.tick) goto(Number(hit.dataset.tick))
	}

	onMount(() => {
		mounted = true
		const frame = frameEl()
		if (frame) {
			svgA = frame.querySelector(`[data-sc-diagram="${CSS.escape(a.link)}"] svg.sc-diagram`)
			svgB = frame.querySelector(`[data-sc-diagram="${CSS.escape(b.link)}"] svg.sc-diagram`)
			codeA = frame.querySelector(`[data-sc-code="${CSS.escape(a.link)}"]`)
			codeB = frame.querySelector(`[data-sc-code="${CSS.escape(b.link)}"]`)
			if (!frame.hasAttribute('tabindex')) frame.tabIndex = -1
			frame.addEventListener('keydown', onKey)
		}
		const el = traceEl
		const ro = el && typeof ResizeObserver !== 'undefined'
			? new ResizeObserver(() => {
					const w = el.clientWidth
					if (w && Math.abs(w - width) > 8) width = w
				})
			: undefined
		if (el) ro?.observe(el)
		return () => {
			ro?.disconnect()
			frame?.removeEventListener('keydown', onKey)
			stop()
		}
	})

	// Not tied to `mounted`: a click made before hydration is replayed once the island is live (engage.ts).
	const disabled = $derived(!timeline)
</script>

<div class="sc-sim sc-sim--compare" data-state={ok && !failure ? 'ready' : 'rejected'} bind:this={root} role="group" aria-label={`${nameA} and ${nameB}, stepped together`}>
	{#if !ok || failure}
		<div class="sc-sim__errors" role="note">
			<p class="sc-diag__head"><span class="sc-diag__mark" aria-hidden="true"></span>{failure ? `The guide's simulator failed: ${failure}` : [...ca.diagnostics, ...cb.diagnostics].filter((d) => d.severity === 'error').length === 0 ? 'The guide\'s simulator cannot run one of these charts yet.' : 'One of the charts does not compile, so they cannot run together.'}</p>
			<ul class="sc-diag__list">
				{#each [...ca.diagnostics.map((d) => ({ d, n: nameA })), ...cb.diagnostics.map((d) => ({ d, n: nameB }))].filter((x) => x.d.severity === 'error' || x.d.code === 'unsupported') as x, i (i)}
					{@const about = x.d.code === 'unsupported' ? undefined : errorLink(x.d)}
					<li>
						<span class="sc-diag__where">{x.n}{x.d.span ? `, line ${x.d.span.line}` : ''}</span><span class="sc-diag__msg">{@html inlineCode(x.d.message)}</span>
						{#if x.d.kieler && x.d.kieler !== x.d.message}<span class="sc-diag__kieler">KIELER's wording: <q>{x.d.kieler}</q></span>{/if}
						{#if x.d.hint}<span class="sc-diag__hint">{@html inlineCode(x.d.hint)}</span>{/if}
						{#if about}<a class="sc-diag__about" href={about}>About this message</a>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{:else}
		<div class="sc-sim__controls">
			<div class="sc-simctl">
				<div class="sc-simctl__buttons" role="group" aria-label="Simulation controls">
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" aria-label="Reset" use:keepFocus title="Reset (R)" disabled={disabled || (snap.end === 0 && !snap.edited)} onclick={reset}>{@html icons.reset}</button>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" aria-label="Back one tick" use:keepFocus title="Back one tick (Backspace or Left)" disabled={disabled || snap.cursor === 0} onclick={back}>{@html icons.back}</button>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--initial sc-simctl__step" use:keepFocus={restartButton} title={halted ? 'The simulation stopped at a run-time error' : snap.canReplay ? `Replay tick ${snap.cursor + 1} (Space)` : 'Run one tick in both charts (Space)'} disabled={disabled || halted} onclick={step}>{@html icons.step}Step</button>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" aria-label={running ? 'Pause' : 'Run'} use:keepFocus={restartButton} aria-pressed={running} title={running ? 'Pause' : 'Run: step automatically'} disabled={disabled || (halted && !running)} onclick={() => (running ? stop() : run())}>{@html running ? icons.pause : icons.play}</button>
				</div>
				<output class="sc-simctl__tick" aria-label={`Tick ${snap.cursor}${snap.cursor < snap.end ? ` of ${snap.end}` : snap.tour ? ` of ${snap.tourLength}` : ''}`}>
					Tick <b>{snap.cursor}</b>{#if snap.cursor < snap.end}<span class="sc-simctl__of">&nbsp;of {snap.end}</span>{:else if snap.tour}<span class="sc-simctl__of">&nbsp;of {snap.tourLength}</span>{/if}
				</output>
				<Inputs {controls} state={snap.state} disabled={disabled || halted} {id} legend={snap.tour && snap.cursor > 0 ? `Inputs of tick ${snap.cursor} of the guided tour, for both charts` : `Inputs for tick ${snap.cursor + 1}, for both charts`} onedit={edit} advance={timed ? { sleep, onadvance: advance } : undefined} />
			</div>
		</div>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
		<div class="sc-sim__trace sc-trace" bind:this={traceEl} role="group" tabindex="0" aria-label={`Timing diagram of ${nameA} and ${nameB}`} aria-describedby={`${id}-trace-keys`} onclick={traceClick}>
			{@html traceHtml}
		</div>
		<span class="sc-visually-hidden" id={`${id}-trace-keys`}>Click a tick to show it, or use the Left and Right arrow keys to go back and step.</span>
		{#if suspension}
			<p class="sc-trace-legend"><svg class="sc-trace-legend__hatch" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M1 11L11 1M7 11L17 1M13 11L21 3" /></svg><span>Hatched: the region is suspended in that tick (frozen by a <code>suspend</code>).</span></p>
		{/if}
		<div class="sc-sim__foot">
			{#if failure}
				<p class="sc-sim__failure" role="alert">The guide's simulator failed: {failure}</p>
			{/if}
			{#if snap.tour}
				<div class="sc-tour">
					<span class="sc-tour__label">Guided tour, {snap.cursor === 0 ? `${snap.tourLength} ${snap.tourLength === 1 ? 'tick' : 'ticks'}` : `tick ${snap.cursor} of ${snap.tourLength}`}</span>
					{#if snap.cursor === 0}
						<span class="sc-tour__note">{@html inlineMd('Both charts get the same inputs. Press **Next** to run tick 1, or **Take over** to set the inputs yourself.')}</span>
					{:else if snap.note}
						<span class="sc-tour__note">{@html inlineMd(snap.note)}</span>
					{/if}
					{#if snap.cursor > 0}
						<span class="sc-compare__diff">{@html inlineMd(diffText)}</span>
					{/if}
					{#if snap.cursor >= snap.tourLength && snap.cursor > 0 && !halted}
						<span class="sc-tour__end">That is the end of the tour. Take over to try your own inputs, or press Step to keep going.</span>
					{/if}
					<div class="sc-tour__nav">
						<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" use:keepFocus disabled={disabled || snap.cursor === 0} onclick={back}>Previous</button>
						<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" use:keepFocus={restartButton} disabled={disabled || halted || snap.cursor >= snap.tourLength} onclick={step}>Next</button>
						<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-tour__take" {disabled} onclick={takeOver}>Take over</button>
					</div>
				</div>
			{:else if snap.cursor === 0}
				<p class="sc-what__idle">Both charts get the same inputs. Set them, then press <b>Step</b>; outputs that differ are marked in the timing diagram.</p>
			{:else}
				{#if snap.note}
					<p class="sc-what__note">{@html inlineMd(snap.note)}</p>
				{/if}
				<p class="sc-compare__diff">{@html inlineMd(diffText)}</p>
				<div class="sc-compare__what">
					{#each [{ n: nameA, s: storyA }, { n: nameB, s: storyB }] as side, i (i)}
						<div class="sc-what">
							<p class="sc-what__head">{side.n}</p>
							<ul class="sc-what__list" use:roving={'li[data-linked]'}>
								{#each side.s?.items ?? [] as item, j (j)}
									<li class={`sc-what__item is-${item.kind}`} data-linked={item.ids.length ? '' : undefined} onpointerenter={() => focusSide(i, item.ids)} onpointerleave={() => focusSide(i, [])} onfocus={() => focusSide(i, item.ids)} onblur={() => focusSide(i, [])}>{@html inlineMd(item.text)}</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			{/if}
			{#if halted}
				<!-- A run-time error stopped the run (as in KIELER): Step, Run and the inputs are off (keepFocus sends focus here). -->
				<div class="sc-sim__halted">
					{#if snap.tour}
						{#each [{ n: nameA, s: storyA }, { n: nameB, s: storyB }] as side, i (i)}
							{#each side.s?.items.filter((item) => item.kind === 'error') ?? [] as item, j (j)}
								<p class="sc-sim__halted-error">{@html inlineMd(`\`${side.n}\`: ${item.text}`)}</p>
							{/each}
						{/each}
					{/if}
					<p class="sc-sim__halted-text">Like KIELER's, this simulation stops at a run-time error, so Step and Run are off. Restart it, or go back a tick and change an input.</p>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--initial sc-sim__restart" title="Restart (R)" onclick={reset}>{@html icons.reset}Restart</button>
				</div>
			{/if}
			{#if tour && !snap.tour}
				<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-tour__restart" {disabled} onclick={restartTour}>Restart the guided tour</button>
			{/if}
		</div>
	{/if}
	<div class="sc-visually-hidden" aria-live="polite" aria-atomic="true">{live}</div>
</div>

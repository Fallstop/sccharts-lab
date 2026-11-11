<!--
	The simulation panel: inputs, controls, the timing diagram, "What happened" and the guided tour, for one
	compiled chart. It draws no diagram: the host gets highlight classes through `onhighlight` (and a list of
	transitions to pulse through `onfire`) and applies them to its own SVG. Props and markup: README.md.
-->
<script lang="ts">
	import { onMount, tick as nextFrame, untrack } from 'svelte'
	import type { ClassMap } from '@sccharts-lab/diagram/highlight'
	import { tickClasses } from '@sccharts-lab/diagram/highlight'
	import type { TickResult, Value } from '@sccharts-lab/engine/types'
	import type { Scenario } from '../frame/examples'
	import { icons } from '../frame/icons'
	import { errorLink } from '../frame/error-links'
	import { inlineCode, inlineMd, withoutLinkTo } from '../frame/inline-md'
	import { describeTick, explainTick, tickSummary, type DescribeContext } from './describe'
	import { createSimulation, traceableVariables, type CompileResult } from './engine'
	import { controlsFor, initialInputs, type InputState } from './inputs'
	import Inputs from './Inputs.svelte'
	import { elementsOf, errorClasses, errorLines, lineMap, tickLines, type LineMap } from './lines'
	import { keepFocus, keepTickInView, reducedMotion, roving } from './link'
	import { Fold, type FoldStart } from './fold.svelte'
	import Stack from './Stack.svelte'
	import { Timeline } from './timeline'
	import { forCopiesIn, hasSuspension, lanesFor, mightSuspend, traceSvg, type ForCopies } from './trace'

	export interface SimView {
		cursor: number
		tick?: TickResult
		history: TickResult[]
		tour: boolean
		lines: { active: number[]; taken: number[]; error: number[] }
	}

	interface Props {
		compiled: CompileResult
		/** The chart's source: the line map and the transitions' text in "What happened". */
		source?: string
		onhighlight?: (classes: ClassMap, view: SimView) => void
		onfire?: (transitions: string[]) => void
		onfocus?: (ids: string[]) => void
		scenario?: Scenario
		show?: string[]
		regions?: boolean
		recompile?: 'reset' | 'replay'
		keys?: HTMLElement | null
		variant?: 'full' | 'compact'
		autoplay?: number
		/** Run this many scripted ticks before the first render (SSR shows them too). */
		initialTicks?: number
		label?: string
		id?: string
		/** Shown in the foot before the first tick, instead of the default prompt (inline Markdown). */
		intro?: string
		/** Shown in the foot once the reader has control (after the tour or the autoplay), inline Markdown. */
		handover?: string
		/** Who says the chart is wrong, when it does not compile: 'recorded' (KIELER's recording of this very chart
		 *  says so: an example as written) or 'engine' (the default: only the guide's checker has seen it, as with
		 *  a chart the reader wrote or edited; the panel never claims that KIELER has). */
		verdict?: 'recorded' | 'engine'
		/** What the tour is called in its label, the inputs' legend and the restart button (the playground's test
		 *  run and shared runs have their own names). */
		tourName?: string
		/** How a tick's details ("What happened", "Explain this tick") start: folded under a one-line summary (the
		 *  guide's widgets) or unfolded (the playground, whose panel scrolls inside). The reader's own choice wins. */
		details?: FoldStart
	}

	let {
		compiled,
		source = '',
		onhighlight,
		onfire,
		onfocus,
		scenario,
		show,
		regions = true,
		recompile = 'reset',
		keys,
		variant = 'full',
		autoplay,
		initialTicks = 0,
		label,
		id: idProp,
		intro,
		handover,
		verdict = 'engine',
		tourName = 'Guided tour',
		details = 'folded',
	}: Props = $props()
	const tourWords = $derived(tourName.charAt(0).toLowerCase() + tourName.slice(1))
	const autoId = $props.id()
	const id = $derived(idProp ?? autoId)

	// ----- Model ------------------------------------------------------------------------------------------

	const SPEEDS = [
		{ ms: 1000, label: 'Slow' },
		{ ms: 500, label: 'Normal' },
		{ ms: 200, label: 'Fast' },
	]

	let rev = $state(0)
	let failure = $state<string | undefined>()
	let mounted = $state(false)
	let running = $state(false)
	let speed = $state(500)
	let traceWidth = $state(640)
	let live = $state('')
	let explainOpen = $state(false)
	const fold = new Fold(untrack(() => details))

	let timeline: Timeline | undefined
	let built: CompileResult | undefined
	let runTimer: ReturnType<typeof setTimeout> | undefined
	let autoplayingNow = $state(false)

	const tour = $derived(scenario && scenario.expect !== 'error' && scenario.ticks?.length ? scenario : undefined)
	const chart = $derived(compiled.chart)
	const ok = $derived(compiled.ok && !!chart && !compiled.diagnostics.some((d) => d.code === 'unsupported'))
	const controls = $derived(controlsFor(compiled.interface))
	const initial = $derived(initialInputs(compiled.interface))
	/** For-region copies: from the compiler when it says (CompileResult.forCopies), else from the ticks that report them. */
	const staticCopies = $derived((compiled as CompileResult & { forCopies?: ForCopies[] }).forCopies)
	const info = $derived(chart ? elementsOf(chart) : undefined)
	const map: LineMap | undefined = $derived(chart && source ? lineMap(chart, source) : undefined)
	const ctx: DescribeContext | undefined = $derived(info ? { info, source, iface: compiled.interface, program: compiled.program } : undefined)
	const errors = $derived(compiled.diagnostics.filter((d) => d.severity === 'error'))
	/** A construct the guide's engine does not support yet (an info, or an error in older engines): KIELER may
	 *  well accept the chart, but the panel cannot run it. */
	const unsupportedInfo = $derived(compiled.diagnostics.find((d) => d.code === 'unsupported'))
	const unsupported = $derived((errors.length > 0 && errors.every((d) => d.code === 'unsupported')) || (compiled.ok && !!unsupportedInfo))
	/** A timed chart: deltaT in, sleepT out (structure.md S-35): offer "Advance by sleepT". */
	const timed = $derived(compiled.interface.some((v) => v.name === 'deltaT' && v.input) && compiled.interface.some((v) => v.name === 'sleepT' && v.output))
	const name = $derived(chart?.name ?? 'chart')

	function build(c: CompileResult) {
		built = c
		failure = undefined
		stopRun()
		if (!c.ok || !c.chart || c.diagnostics.some((d) => d.code === 'unsupported')) {
			timeline = undefined
			return
		}
		try {
			const sim = createSimulation(c)
			const init = initialInputs(c.interface)
			if (timeline && recompile === 'replay') timeline = timeline.replace(sim, init, true)
			else if (timeline) timeline = timeline.replace(sim, init, false)
			else {
				timeline = new Timeline(sim, init, tour)
				for (let i = 0; i < Math.min(initialTicks, tour?.ticks.length ?? 0); i++) timeline.step()
				// The compact panel (the landing chart) has no tour controls: once the script has run, the reader has it.
				if (variant === 'compact' && initialTicks > 0) timeline.takeOver()
			}
		} catch (error) {
			timeline = undefined
			failure = error instanceof Error ? error.message : String(error)
		}
	}

	// Build at once (also during server rendering: the page then shows the initial ticks without JavaScript).
	untrack(() => build(compiled))

	$effect(() => {
		// A new compiled result from the host (the playground edits the source).
		if (compiled !== built) {
			untrack(() => build(compiled))
			fold.reset()
			rev++
			announce()
		}
	})

	interface Snapshot {
		cursor: number
		end: number
		shown?: TickResult
		prev?: TickResult
		history: TickResult[]
		tour: boolean
		tourLength: number
		note?: string
		state: InputState
		canReplay: boolean
		edited: boolean
		dirty: boolean
	}

	const snap: Snapshot = $derived.by(() => {
		void rev
		const t = timeline
		if (!t) {
			return { cursor: 0, end: 0, history: [], tour: false, tourLength: 0, state: initial, canReplay: false, edited: false, dirty: false }
		}
		return {
			cursor: t.cursor,
			end: t.end,
			shown: t.shown,
			prev: t.cursor > 1 ? t.history[t.cursor - 2] : undefined,
			history: t.history,
			tour: t.tour,
			tourLength: t.tourLength,
			note: t.note,
			state: t.controls(),
			canReplay: t.canReplay,
			edited: t.edited,
			dirty: t.dirty,
		}
	})

	const story = $derived(snap.shown && ctx ? describeTick(snap.shown, snap.prev, ctx) : undefined)
	const explained = $derived(snap.shown && ctx && explainOpen ? explainTick(snap.shown, ctx) : [])
	/** Inner locals and members `show` may name (only worked out when it names something outside the data pool). */
	const traceable = $derived(show?.some((n) => !compiled.interface.some((v) => v.name === n)) ? traceableVariables(compiled) : undefined)
	const lanes = $derived(lanesFor(compiled.interface, chart, show, regions, staticCopies ?? forCopiesIn(snap.history), traceable))
	const traceHtml = $derived(ok ? traceSvg(lanes, { history: snap.history, cursor: snap.cursor, width: traceWidth }, `Timing diagram of ${name}`) : '')
	// Shown from the start for a chart that can suspend, so the first hatched tick does not add it under the trace.
	const suspension = $derived(ok && (mightSuspend(compiled.program) || hasSuspension(lanes, snap.history)))
	const terminated = $derived(!!snap.shown?.terminated)
	/** The last tick computed stopped with a run-time error, and it is shown. KIELER's simulation stays stopped
	 *  after one (later steps only repeat the error), so Step, Run, Next and the inputs are off and the foot
	 *  offers Restart; Back still goes back, and an input changed there runs a new tick from that point. */
	const halted = $derived(!!snap.shown?.error && snap.cursor === snap.end)

	// ----- Highlights for the host ---------------------------------------------------------------------------

	function view(): SimView {
		const lines = map && chart ? tickLines(map, snap.shown, chart.id) : { active: [], taken: [] }
		return { cursor: snap.cursor, tick: snap.shown, history: snap.history, tour: snap.tour, lines: { ...lines, error: ok ? [] : errorLines(errors) } }
	}

	$effect(() => {
		void rev
		void compiled
		if (!mounted) return
		const classes = ok ? (snap.shown ? tickClasses(snap.shown) : {}) : unsupported ? {} : errorClasses(errors, map, chart?.id)
		onhighlight?.(classes, view())
	})

	// ----- Actions ------------------------------------------------------------------------------------------

	function changed(fire = false) {
		// The Restart button of a stopped simulation goes with the error (Restart, Back, R): focus moves on to Step
		// rather than dropping to the page.
		const fromHalted = typeof document !== 'undefined' && !!root?.querySelector('.sc-sim__halted')?.contains(document.activeElement)
		rev++
		if (fire && snap.shown && !reducedMotion()) onfire?.(snap.shown.taken)
		announce()
		if (fromHalted) {
			nextFrame().then(() => {
				const focus = document.activeElement
				if (!focus || focus === document.body) root?.querySelector<HTMLButtonElement>('.sc-simctl__step:not(:disabled)')?.focus()
			})
		}
	}

	function announce() {
		const s = snap
		if (!ok) {
			const first = (errors[0]?.message ?? 'it does not compile').replace(/`/g, '')
			live = unsupported
				? `${(errors[0] ?? unsupportedInfo)?.message.replace(/`/g, '')}.`
				: verdict === 'recorded'
					? `KIELER rejects ${name}: ${first}.`
					: `The guide's checker found a problem in ${name}: ${first}.`
			return
		}
		if (!s.shown) {
			live = 'Tick 0: nothing has run yet.'
			return
		}
		const text = story?.summary ?? `Tick ${s.cursor}.`
		live = s.cursor < s.end ? `Showing ${text}` : halted ? `${text} ${HALTED}` : text
	}

	const HALTED = 'Step and Run are off: restart the simulation, or go back a tick and change an input.'

	function userAction() {
		autoplayingNow = false
		stopRun()
	}

	export function step() {
		if (!timeline || halted) return
		userAction()
		doStep()
	}

	function doStep(): boolean {
		if (!timeline) return false
		try {
			timeline.step()
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
			rev++
			return false
		}
		changed(true)
		return true
	}

	/** Step without drawing (Run until): `rev` stays, so nothing re-renders until `settle()`. A stopped
	 *  simulation does not step (the cursor stays where it is). */
	export function stepQuietly(): Pick<SimView, 'cursor' | 'tick' | 'history'> | undefined {
		if (!timeline) return undefined
		const t = timeline
		if (!(t.shown?.error && t.cursor === t.end)) {
			userAction()
			try {
				t.step()
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error)
				rev++
			}
		}
		return { cursor: t.cursor, tick: t.shown, history: t.history }
	}

	/** Draws the tick the quiet steps reached. */
	export function settle() {
		changed(true)
	}

	export function back() {
		if (!timeline) return
		userAction()
		if (timeline.back()) changed()
	}

	export function forward() {
		if (!timeline) return
		userAction()
		if (timeline.forward()) changed(true)
	}

	export function goto(tick: number) {
		if (!timeline) return
		userAction()
		if (timeline.goto(tick)) changed()
	}

	export function reset() {
		if (!timeline) return
		userAction()
		timeline.reset()
		failure = undefined
		fold.reset()
		changed()
	}

	/** Where Step, Run and Next send focus when a run-time error turns them off (keepFocus). */
	const restartButton = () => root?.querySelector<HTMLButtonElement>('.sc-sim__restart')

	export function restartTour() {
		if (!timeline) return
		userAction()
		timeline.reset(true)
		fold.reset()
		changed()
	}

	/** `keepShown`: the reader pressed Take over, so the inputs shown before tick 1 stay (Timeline.takeOver). */
	export function takeOver(keepShown = false) {
		if (!timeline) return
		userAction()
		timeline.takeOver(keepShown === true)
		changed()
	}

	export function run() {
		if (!timeline || running || halted) return
		autoplayingNow = false
		running = true
		schedule()
	}

	export function pause() {
		stopRun()
	}

	function stopRun() {
		running = false
		if (runTimer) clearTimeout(runTimer)
		runTimer = undefined
	}

	function schedule(ms = speed) {
		if (runTimer) clearTimeout(runTimer)
		runTimer = setTimeout(() => {
			runTimer = undefined
			if (!running || !timeline) return
			const t = timeline
			const wasTour = t.tour
			if (!doStep()) return stopRun()
			const shown = t.shown
			// Stop at termination, at a run-time error and at the end of the tour.
			if (shown?.terminated || shown?.error || (wasTour && t.cursor >= t.tourLength)) return stopRun()
			schedule()
		}, ms)
	}

	function edit(next: InputState) {
		if (!timeline || halted) return
		userAction()
		timeline.edit(next)
		rev++
	}

	/** Sets inputs by KIELER's names (`A`, `V`, `V_val`), as if the reader had set them: the next Step runs with them
	 *  (the playground's embed API). Returns why not, if it cannot: a name that is not an input, a stopped run. */
	export function setInputs(values: Record<string, Value>): string | undefined {
		if (!timeline) return 'The chart cannot run.'
		if (halted) return 'The simulation stopped at a run-time error: reset it, or go back a tick first.'
		const known = Object.keys(initial.levels)
		const unknown = Object.keys(values).filter((k) => !known.includes(k))
		if (unknown.length) return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an input' : 'are not inputs'} of ${name}${known.length ? ` (its inputs: ${known.join(', ')})` : ', which has no inputs'}.`
		edit({ levels: { ...timeline.controls().levels, ...values }, pulses: timeline.controls().pulses })
		return undefined
	}

	/** The sleepT of the tick shown (a timed chart), for "Advance by sleepT". */
	const sleep = $derived.by(() => {
		const v = timed && snap.shown && !snap.shown.error ? snap.shown.values.sleepT : undefined
		return typeof v === 'number' ? v : undefined
	})

	/** Sets deltaT to the sleepT of the tick shown and steps: time advances to the chart's next deadline. */
	export function advance() {
		if (!timeline || sleep === undefined || halted) return
		userAction()
		const now = timeline.controls()
		timeline.edit({ levels: { ...now.levels, deltaT: sleep }, pulses: now.pulses })
		doStep()
	}

	function setSpeed(ms: number) {
		speed = ms
		try {
			localStorage.setItem('sc-sim-speed', String(ms))
		} catch {
			/* private mode: keep it for this page */
		}
		if (running) schedule()
	}

	// ----- Keyboard -----------------------------------------------------------------------------------------

	let root: HTMLElement | undefined = $state()

	function onKey(e: KeyboardEvent) {
		if (!timeline || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
		const target = e.target as HTMLElement
		const typing = target.closest('input:not([type="checkbox"]), select, textarea, [contenteditable]')
		if (typing) return
		const control = target.closest('button, a, summary, input, [role="tab"]')
		const k = e.key
		if ((k === ' ' || k === 'Enter') && !control) {
			e.preventDefault()
			step()
		} else if (k === 'ArrowRight' && !target.closest('[role="tablist"]')) {
			e.preventDefault()
			step()
		} else if ((k === 'Backspace' || k === 'ArrowLeft') && !target.closest('[role="tablist"]')) {
			e.preventDefault()
			back()
		} else if (k === 'r' || k === 'R') {
			e.preventDefault()
			reset()
		} else if ((k === 'Home' || k === 'End') && !control) {
			e.preventDefault()
			goto(k === 'Home' ? 0 : snap.end)
		}
	}

	$effect(() => {
		const el = keys ?? root
		if (!el || !mounted) return
		el.addEventListener('keydown', onKey)
		return () => el.removeEventListener('keydown', onKey)
	})

	// ----- Trace --------------------------------------------------------------------------------------------

	let traceEl: HTMLElement | undefined = $state()

	function traceClick(e: MouseEvent) {
		const hits = [...(traceEl?.querySelectorAll<SVGRectElement>('.wv-hit') ?? [])]
		const x = e.clientX
		const hit = hits.find((h) => {
			const r = h.getBoundingClientRect()
			return x >= r.left && x < r.right
		})
		if (hit?.dataset.tick) goto(Number(hit.dataset.tick))
	}

	function traceHover(e: PointerEvent) {
		const ref = (e.target as Element).closest?.('[data-ref]')?.getAttribute('data-ref')
		onfocus?.(ref ? [ref] : [])
	}

	$effect(() => {
		// Keep the shown tick in view after each change (scrolling only when it is out of view).
		void traceHtml
		if (!traceEl) return
		nextFrame().then(() => keepTickInView(traceEl))
	})

	// ----- Mount ----------------------------------------------------------------------------------------------

	onMount(() => {
		mounted = true
		fold.restore()
		try {
			const saved = Number(localStorage.getItem('sc-sim-speed'))
			if (SPEEDS.some((s) => s.ms === saved)) speed = saved
		} catch {
			/* no storage */
		}
		// Pause a running simulation that scrolls out of view (many widgets on one page stay cheap).
		const io = root
			? new IntersectionObserver((entries) => {
					if (!entries.some((en) => en.isIntersecting)) stopRun()
					else if (autoplay && tour && !reducedMotion() && !autoplayed) startAutoplay()
				}, { threshold: 0.4 })
			: undefined
		if (root) io!.observe(root)
		return () => {
			io?.disconnect()
			stopRun()
		}
	})

	// The trace's width decides how many tick columns are drawn. The trace block exists only while the chart
	// runs (the playground can start with a rejected chart and fix it later), so observe whichever block is there.
	$effect(() => {
		const el = traceEl
		if (!el || typeof ResizeObserver === 'undefined') return
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth
			if (w && Math.abs(w - traceWidth) > 8) traceWidth = w
		})
		ro.observe(el)
		return () => ro.disconnect()
	})

	let autoplayed = false
	function startAutoplay() {
		if (!timeline || !tour || autoplayed) return
		autoplayed = true
		autoplayingNow = true
		timeline.reset(true)
		fold.reset()
		changed()
		const total = Math.min(initialTicks || tour.ticks.length, tour.ticks.length)
		let i = 0
		const next = () => {
			if (!autoplayingNow || !timeline) return
			if (i >= total) {
				autoplayingNow = false
				timeline.takeOver()
				changed()
				return
			}
			i++
			doStep()
			runTimer = setTimeout(next, autoplay)
		}
		runTimer = setTimeout(next, Math.min(400, autoplay ?? 400))
	}

	// ----- Rendering helpers ------------------------------------------------------------------------------------

	// Not tied to `mounted`: the server-rendered controls look ready, and a click made before hydration is
	// replayed once the island is live (client:engage, engage.ts).
	const disabled = $derived(!timeline)
	const where = (d: { span?: { line: number; col: number } }) => (d.span ? `Line ${d.span.line}, column ${d.span.col}` : '')
	const problems = $derived(errors.length > 1 ? ` (${errors.length} problems)` : '')
	const rejectedHead = $derived(
		unsupported
			? 'The guide\'s simulator cannot run this chart'
			: verdict === 'recorded'
				? `KIELER rejects this chart, so it cannot run${problems}`
				: `The guide's checker found ${errors.length > 1 ? `${errors.length} problems` : 'a problem'} in this chart, so it cannot run`,
	)

	// ----- The foot -----------------------------------------------------------------------------------------------
	//
	// Stepping never changes its height. Its first line is the tour's label or what the tick did (`tickSummary`), cut
	// off with an ellipsis, with *Details* (the whole story, which only the reader opens or closes) at its end. The
	// texts known in advance (the tour's intro and notes, the end of the tour, the idle line, the notices) are stacked
	// in one cell under it, so the cell is as tall as the tallest. The compact panel has no first line: its notes and
	// the tick's summary are stacked, beside *Details*.

	type Entry = { kind: 'intro' | 'end' | 'idle' | 'free' | 'replay' | 'edited' } | { kind: 'note'; k: number }
	const full = $derived(variant === 'full')
	const entries: Entry[] = $derived([
		...(full && tour ? [{ kind: 'intro' } as const] : []),
		...(tour?.ticks.map((_, i) => ({ kind: 'note', k: i + 1 }) as const) ?? []),
		...(full && tour ? [{ kind: 'end' } as const] : []),
		{ kind: 'idle' },
		{ kind: 'free' },
		...(full ? [{ kind: 'replay' } as const, { kind: 'edited' } as const] : []),
	])
	const current: Entry = $derived.by(() => {
		const c = snap.cursor
		if (full && snap.tour) return c === 0 ? { kind: 'intro' } : c >= snap.tourLength && !halted ? { kind: 'end' } : { kind: 'note', k: c }
		if (c === 0 || !snap.shown) return { kind: 'idle' }
		if (full && snap.edited) return { kind: 'edited' }
		if (snap.note) return { kind: 'note', k: c }
		return full && snap.canReplay ? { kind: 'replay' } : { kind: 'free' }
	})
	const shownEntry = $derived(entries.findIndex((e) => e.kind === current.kind && (e.kind !== 'note' || (current.kind === 'note' && e.k === current.k))))
	const tourShown = $derived(full && snap.tour)
	const noteOf = (e: Entry) => tour?.ticks[(e.kind === 'note' ? e.k : tour.ticks.length) - 1]?.note
	const tourLabel = $derived(`${tourName}, ${snap.cursor === 0 ? `${snap.tourLength} ${snap.tourLength === 1 ? 'tick' : 'ticks'}` : `tick ${snap.cursor} of ${snap.tourLength}`}`)
	const summary = $derived(snap.shown && story ? tickSummary(story, snap.cursor) : 'Tick 0: nothing has run yet.')
	const idleText = $derived(intro && !tour ? intro : controls.length ? 'Set the inputs, then press **Step** to run tick 1.' : 'Press **Step** to run tick 1.')
	/** The details are open and have something to show, or keep their height for the ticks to come. */
	const showDetails = $derived(fold.open && (snap.cursor > 0 || fold.min > 0))
	const stepButton = () => root?.querySelector<HTMLButtonElement>('.sc-simctl__step')
</script>

{#snippet head()}
	{#if tourShown}
		<span class="sc-foot__head sc-tour__label">{tourLabel}</span>
	{:else}
		<span class="sc-foot__head sc-what__summary" class:is-idle={snap.cursor === 0}>{@html inlineMd(summary)}</span>
	{/if}
{/snippet}

{#snippet entry(e: Entry, on: boolean)}
	<div class="sc-foot__entry" class:sc-tour={on && tourShown}>
		{#if e.kind === 'idle'}
			<p class="sc-what__idle">{@html inlineMd(idleText)}</p>
		{:else if e.kind === 'free'}
			<!-- The compact panel's summary line (the full one has it above the stack). -->
			{#if !full}
				{#if on}{@render head()}{:else}<span class="sc-foot__head">&nbsp;</span>{/if}
			{/if}
		{:else}
			{#if e.kind === 'intro'}
				<p class="sc-tour__note">{@html inlineMd(intro ?? 'Press **Next** to run tick 1, or **Take over** to set the inputs yourself.')}</p>
			{:else if e.kind === 'note' || e.kind === 'end'}
				{#if noteOf(e)}<p class="sc-tour__note">{@html inlineMd(noteOf(e)!)}</p>{/if}
				{#if e.kind === 'end'}<p class="sc-tour__end">That is the end of the {tourWords}. Take over to try your own inputs, or press Step to keep going.</p>{/if}
			{:else if e.kind === 'replay'}
				<p class="sc-what__replay">Showing an earlier tick. Step replays the next one as it was; change an input to try something else from here.</p>
			{:else if e.kind === 'edited'}
				<p class="sc-what__replay">You changed an input: Step runs a new tick from here, in place of the later ones.</p>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet nav(k: string)}
	{#if k === 'nav'}
		<div class="sc-tour__nav">
			<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" use:keepFocus disabled={disabled || snap.cursor === 0} onclick={back}>Previous</button>
			<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" use:keepFocus={restartButton} disabled={disabled || halted || snap.cursor >= snap.tourLength} onclick={step}>Next</button>
			<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-tour__take" disabled={disabled} onclick={() => takeOver(true)}>Take over</button>
		</div>
	{:else}
		<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-tour__restart" disabled={disabled} onclick={restartTour}>Restart the {tourWords}</button>
	{/if}
{/snippet}

<div class="sc-sim" class:is-compact={variant === 'compact'} data-state={ok && !failure ? 'ready' : 'rejected'} bind:this={root} role="group" aria-label={label ?? `Simulation of ${name}`}>
	{#if !ok}
		<div class="sc-sim__errors" role="note">
			<p class="sc-diag__head"><span class="sc-diag__mark" class:sc-diag__mark--caution={unsupported} aria-hidden="true"></span>{rejectedHead}</p>
			{#if !unsupported && verdict !== 'recorded'}
				<p class="sc-diag__verdict">KIELER rejects charts with {errors.length > 1 ? 'these problems' : 'this problem'} too.</p>
			{/if}
			<ul class="sc-diag__list">
				{#each unsupported && unsupportedInfo && !errors.length ? [unsupportedInfo] : errors as d, i (i)}
					{@const about = unsupported ? undefined : errorLink(d)}
					<li>
						{#if where(d)}<span class="sc-diag__where">{where(d)}</span>{/if}
						<span class="sc-diag__msg">{@html inlineCode(d.message)}</span>
						{#if d.kieler && d.kieler !== d.message}<span class="sc-diag__kieler">{verdict === 'recorded' ? 'KIELER says:' : 'KIELER\'s wording:'} <q>{d.kieler}</q></span>{/if}
						{#if d.hint && withoutLinkTo(d.hint, about)}<span class="sc-diag__hint">{@html inlineCode(withoutLinkTo(d.hint, about))}</span>{/if}
						{#if about}<a class="sc-diag__about" href={about}>About this message</a>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{:else}
		<div class="sc-sim__controls">
			<div class="sc-simctl">
				<div class="sc-simctl__buttons" role="group" aria-label="Simulation controls">
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" aria-label="Reset" use:keepFocus title="Reset (R)" disabled={disabled || (snap.end === 0 && !snap.dirty)} onclick={reset}>{@html icons.reset}</button>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" aria-label="Back one tick" use:keepFocus title="Back one tick (Backspace or Left)" disabled={disabled || snap.cursor === 0} onclick={back}>{@html icons.back}</button>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--initial sc-simctl__step" use:keepFocus={restartButton} title={halted ? 'The simulation stopped at a run-time error' : snap.canReplay ? `Replay tick ${snap.cursor + 1} (Space)` : 'Run one tick (Space)'} disabled={disabled || halted} onclick={step}>{@html icons.step}Step</button>
					{#if variant === 'full'}
						<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-btn--icon" use:keepFocus={restartButton} aria-label={running ? 'Pause' : 'Run'} aria-pressed={running} title={running ? 'Pause' : 'Run: step automatically'} disabled={disabled || (halted && !running)} onclick={() => (running ? pause() : run())}>{@html running ? icons.pause : icons.play}</button>
						<label class="sc-simctl__speed">
							<span class="sc-visually-hidden">Speed</span>
							<select disabled={disabled} value={speed} onchange={(e) => setSpeed(Number((e.currentTarget as HTMLSelectElement).value))}>
								{#each SPEEDS as s (s.ms)}<option value={s.ms}>{s.label}</option>{/each}
							</select>
						</label>
					{/if}
				</div>
				<output class="sc-simctl__tick" aria-label={`Tick ${snap.cursor}${snap.cursor < snap.end ? ` of ${snap.end}` : ''}`}>
					Tick <b>{snap.cursor}</b>{#if snap.cursor < snap.end}<span class="sc-simctl__of">&nbsp;of {snap.end}</span>{:else if snap.tour}<span class="sc-simctl__of">&nbsp;of {snap.tourLength}</span>{/if}
				</output>
				<Inputs {controls} state={snap.state} disabled={disabled || halted} {id} legend={snap.tour && snap.cursor > 0 ? `Inputs of tick ${snap.cursor} of the ${tourWords}` : `Inputs for tick ${snap.cursor + 1}`} onedit={edit} advance={timed ? { sleep, onadvance: advance } : undefined} />
			</div>
		</div>
		<!-- The trace is one tab stop (it scrolls sideways; a group, not a landmark: a page has many): Left and Right go back and step, Home and End to the
		     first and last tick (the panel's keys); a table of the values is there for screen readers. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
		<div class="sc-sim__trace sc-trace" bind:this={traceEl} role="group" tabindex="0" aria-label={`Timing diagram of ${name}`} aria-describedby={`${id}-trace-keys`} onclick={traceClick} onpointerover={traceHover} onpointerleave={() => onfocus?.([])}>
			{@html traceHtml}
		</div>
		<span class="sc-visually-hidden" id={`${id}-trace-keys`}>Click a tick to show it, or use the Left and Right arrow keys to go back and step.</span>
		{#if suspension}
			<p class="sc-trace-legend"><svg class="sc-trace-legend__hatch" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M1 11L11 1M7 11L17 1M13 11L21 3" /></svg><span>Hatched: the region is suspended in that tick (frozen by a <code>suspend</code>).</span></p>
		{/if}
		<div class="sc-sim__foot">
			{#if failure}
				<p class="sc-sim__failure" role="alert">The guide's simulator failed on this chart: {failure}</p>
			{/if}
			<div class="sc-foot__top">
				{#if full}
					{@render head()}
				{:else}
					<Stack items={entries} shown={shownEntry} item={entry} class="sc-foot__text" />
				{/if}
				<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet sc-foot__toggle" aria-expanded={fold.open} aria-controls={`${id}-details`} title={fold.open ? 'Fold the details of the tick' : 'What happened in the tick, line by line'} disabled={snap.cursor === 0} use:keepFocus={stepButton} onclick={() => fold.toggle()}>{@html icons.chevron}<span>Details</span></button>
			</div>
			<div class="sc-foot__details" id={`${id}-details`} hidden={!showDetails} style:min-height={fold.min ? `${fold.min}px` : undefined}>
				{#if showDetails}
					<div class="sc-foot__detail" use:fold.ratchet>
						{#if snap.shown && story}
							<!-- Lines that name elements mark them on the diagram when pointed at or focused (Up and Down move). -->
							<ul class="sc-what__list" class:is-quiet={!!snap.note} use:roving={'li[data-linked]'}>
								{#each story.items as item, i (i)}
									<li class={`sc-what__item is-${item.kind}`} data-linked={item.ids.length ? '' : undefined} onpointerenter={() => onfocus?.(item.ids)} onpointerleave={() => onfocus?.([])} onfocus={() => onfocus?.(item.ids)} onblur={() => onfocus?.([])}>{@html inlineMd(item.text)}</li>
								{/each}
							</ul>
							{#if full && snap.shown.log.length}
								<details class="sc-explain" bind:open={explainOpen} ontoggle={() => fold.reset()}>
									<summary>Explain this tick</summary>
									<ol class="sc-explain__list" use:roving={'li[data-linked]'}>
										{#each explained as line, i (i)}
											<li class={`is-${line.kind}`} data-linked={line.ids.length ? '' : undefined} onpointerenter={() => onfocus?.(line.ids)} onpointerleave={() => onfocus?.([])} onfocus={() => onfocus?.(line.ids)} onblur={() => onfocus?.([])}>{@html inlineMd(line.text)}</li>
										{/each}
									</ol>
								</details>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
			{#if full}
				<Stack items={entries} shown={shownEntry} item={entry} class="sc-foot__text" />
			{/if}
			{#if tour && full}
				<Stack items={['nav', 'restart']} shown={snap.tour ? 0 : 1} item={nav} class="sc-foot__nav" />
			{/if}
			{#if halted}
				<!-- A run-time error stopped the simulation (as in KIELER): Step, Run and the inputs are off. Focus moves
				     here from Step, Run or Next when they turn off under it (keepFocus). -->
				<div class="sc-sim__halted">
					{#if !showDetails}
						<!-- The details are folded: say what stopped it. -->
						{#each story?.items.filter((item) => item.kind === 'error') ?? [] as item, i (i)}
							<p class="sc-sim__halted-error">{@html inlineMd(item.text)}</p>
						{/each}
					{/if}
					<p class="sc-sim__halted-text">Like KIELER's, this simulation stops at a run-time error, so Step and Run are off. Restart it, or go back a tick and change an input.</p>
					<button type="button" class="sc-btn sc-btn--sm sc-btn--initial sc-sim__restart" title="Restart (R)" onclick={reset}>{@html icons.reset}Restart</button>
				</div>
			{/if}
			{#if handover}
				<!-- Its room is kept while the tour or the opening plays, so it appears without moving anything. -->
				<p class="sc-what__handover" class:is-off={snap.tour || autoplayingNow} aria-hidden={snap.tour || autoplayingNow ? 'true' : undefined}>{@html inlineMd(handover)}</p>
			{/if}
		</div>
	{/if}
	<div class="sc-visually-hidden" aria-live="polite" aria-atomic="true">{live}</div>
</div>

<!--
	The input controls of a simulation (inputs.ts): a switch with a one-tick pulse button for every bool and
	pure signal, number and text fields for valued inputs. Calls `onedit` with the new state; the parent
	decides what it means (the next Step uses it).
-->
<script lang="ts">
	import type { Value } from '~engine/types'
	import { formatValue, parseArray, parseNumber, type InputControl, type InputState } from './inputs'

	interface Props {
		controls: InputControl[]
		state: InputState
		disabled?: boolean
		id: string
		legend: string
		onedit: (next: InputState) => void
		/** A timed chart (deltaT in, sleepT out): a button after the deltaT field that sets deltaT to the
		 *  sleepT of the tick shown and steps. `sleep` is undefined before the first tick. */
		advance?: { sleep: number | undefined; onadvance: () => void }
	}
	let { controls, state, disabled = false, id, legend, onedit, advance }: Props = $props()

	const levelOf = (key: string) => state.levels[key]
	const pulsed = (key: string) => state.pulses.includes(key)
	const valueText = (key: string) => formatValue(levelOf(key))
	const arrayText = (key: string) => formatValue(levelOf(key)).replace(/^\{|\}$/g, '')

	function setLevel(key: string, value: Value) {
		onedit({ levels: { ...state.levels, [key]: value }, pulses: state.pulses.filter((p) => p !== key) })
	}

	function togglePulse(key: string) {
		const pulses = state.pulses.includes(key) ? state.pulses.filter((p) => p !== key) : [...state.pulses, key]
		onedit({ levels: state.levels, pulses })
	}

	function onNumber(int: boolean, key: string, el: HTMLInputElement) {
		const v = parseNumber(el.value, int)
		if (v === undefined) {
			el.value = formatValue(state.levels[key])
			return
		}
		el.value = String(v)
		if (v !== state.levels[key]) setLevel(key, v)
	}

	function onArray(c: InputControl, el: HTMLInputElement) {
		const v = parseArray(el.value, c, state.levels[c.name])
		if (!v) {
			el.value = arrayText(c.name)
			return
		}
		setLevel(c.name, v)
	}

	const pulseTitle = (c: InputControl) =>
		levelOf(c.name)
			? `${c.name} is already on`
			: pulsed(c.name)
				? `${c.name} will be ${c.signal ? 'present' : 'true'} in the next tick only`
				: `Pulse: ${c.signal ? 'present' : 'true'} for the next tick only`
</script>

{#if controls.length}
	<fieldset class="sc-simctl__inputs" {disabled}>
		<legend class="sc-visually-hidden">{legend}</legend>
		{#each controls as c (c.name)}
			{#if c.kind === 'bool'}
				<span class="sc-input sc-input--bool" class:is-pulsed={pulsed(c.name)} data-input={c.name}>
					<label class="sc-input__switch">
						<input type="checkbox" role="switch" checked={!!levelOf(c.name)} aria-describedby={`${id}-${c.name}-d`} onchange={(e) => setLevel(c.name, e.currentTarget.checked)} />
						<span class="sc-input__name">{c.name}</span>
					</label>
					<span class="sc-visually-hidden" id={`${id}-${c.name}-d`}>{c.signal ? 'Input signal: present while on.' : 'Boolean input: true while on.'} It keeps its value until you change it.</span>
					<button type="button" class="sc-input__pulse" aria-pressed={pulsed(c.name)} disabled={!!levelOf(c.name)} title={pulseTitle(c)} aria-label={`Pulse ${c.name} for one tick`} onclick={() => togglePulse(c.name)}>
						<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><path d="M1 10h5V2h6v8h5" /></svg>
					</button>
				</span>
				{#if c.valued}
					<label class="sc-input sc-input--value" data-input={c.valueKey}>
						<span class="sc-input__name">val({c.name})</span>
						{#if c.valueKind === 'string'}
							<input type="text" value={levelOf(c.valueKey!) ?? ''} onchange={(e) => setLevel(c.valueKey!, e.currentTarget.value)} />
						{:else}
							<input type="number" step={c.type === 'int' ? 1 : 'any'} value={valueText(c.valueKey!)} onchange={(e) => onNumber(c.type === 'int', c.valueKey!, e.currentTarget)} />
						{/if}
					</label>
				{/if}
			{:else if c.kind === 'number'}
				<label class="sc-input sc-input--value" data-input={c.name}>
					<span class="sc-input__name">{c.name}</span>
					<input type="number" step={c.int ? 1 : 'any'} value={valueText(c.name)} onchange={(e) => onNumber(c.int, c.name, e.currentTarget)} />
				</label>
				{#if advance && c.name === 'deltaT'}
					<button
						type="button"
						class="sc-btn sc-btn--sm sc-btn--quiet sc-input__advance"
						disabled={advance.sleep === undefined}
						title={advance.sleep === undefined ? 'After the first tick: set deltaT to sleepT, the time the chart asks to wait, and step' : `Set deltaT to sleepT (${formatValue(advance.sleep)}), the time the chart asks to wait until something can happen, and step`}
						onclick={advance.onadvance}
					>Advance by sleepT{#if advance.sleep !== undefined}<span class="sc-input__advance-by">&nbsp;({formatValue(advance.sleep)})</span>{/if}</button>
				{/if}
			{:else if c.kind === 'string'}
				<label class="sc-input sc-input--value sc-input--string" data-input={c.name}>
					<span class="sc-input__name">{c.name}</span>
					<input type="text" value={levelOf(c.name) ?? ''} placeholder="unset" onchange={(e) => setLevel(c.name, e.currentTarget.value)} />
				</label>
			{:else}
				<label class="sc-input sc-input--value sc-input--array" data-input={c.name}>
					<span class="sc-input__name">{c.name}</span>
					<input type="text" value={arrayText(c.name)} title="Values separated by commas" onchange={(e) => onArray(c, e.currentTarget)} />
				</label>
			{/if}
		{/each}
	</fieldset>
{/if}

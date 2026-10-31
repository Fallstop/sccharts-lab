<!--
	"How KIELER reads it": the reader types an expression, an effect or a trigger; the island shows how KIELER's
	grammar groups it, fully parenthesised and as a tree, or the syntax error. Buttons load the classic traps.
	The reading is the engine's (reading.ts); the <HowKielerReads> wrapper puts it in a widget frame.
-->
<script lang="ts">
	import { untrack } from 'svelte'
	import { errorLink } from '../frame/error-links'
	import { inlineCode } from '../frame/inline-md'
	import { readExpression, type ReadMode, type Seed, type TreeNode } from './reading'

	interface Props {
		initial?: string
		mode?: ReadMode
		seeds?: Seed[]
		id?: string
	}

	const TRAPS: Seed[] = [
		{ label: 'Ternary', text: 'A > 2 ? A : 0' },
		{ label: '`->`', text: '0 -> I + 1' },
		{ label: '`fby`', text: '0 fby N + 1' },
		{ label: '`!`', text: '!A == B' },
		{ label: '`&`', text: 'A & 3 == 2' },
		{ label: 'Count delay', text: '3 -I > 0', mode: 'trigger' },
		{ label: '`==` chain', text: 'A == B == C' },
	]

	let { initial, mode: firstMode, seeds = TRAPS, id: idProp }: Props = $props()
	const autoId = $props.id()
	const id = $derived(idProp ?? autoId)
	let text = $state(untrack(() => initial ?? seeds[0]?.text ?? 'a + b * c'))
	let mode = $state<ReadMode>(untrack(() => firstMode ?? seeds.find((s) => s.text === initial)?.mode ?? (initial === undefined ? seeds[0]?.mode : undefined) ?? 'auto'))
	let input: HTMLInputElement | undefined = $state()

	const reading = $derived(readExpression(text, mode))
	const about = $derived(reading.error ? errorLink({ ...reading.error, code: reading.error.code ?? 'parse' }) : undefined)
	const what = $derived(reading.as === 'effect' ? 'this effect' : reading.as === 'trigger' ? 'this trigger' : 'this expression')
	const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

	// One sentence for screen readers, a moment after typing stops.
	let said = $state('')
	let timer: ReturnType<typeof setTimeout> | undefined
	$effect(() => {
		const r = reading
		const sentence = r.error
			? `Syntax error${r.error.col ? ` at column ${r.error.col}` : ''}: ${r.error.message.replace(/`/g, '')}`
			: `KIELER reads ${r.delay ? `a count delay of ${r.delay}, then ` : ''}${r.text}`
		clearTimeout(timer)
		timer = setTimeout(() => (said = sentence), 600)
		return () => clearTimeout(timer)
	})

	function seed(s: Seed) {
		text = s.text
		mode = s.mode ?? 'auto'
		input?.focus()
	}
</script>

{#snippet branch(node: TreeNode)}
	<li>
		<span class="sc-reads__node" class:is-op={node.children.length > 0}><code>{node.label}</code>{#if node.name}<span class="sc-reads__name">{node.name}</span>{/if}</span>
		{#if node.children.length}
			<ul>
				{#each node.children as child, i (i)}{@render branch(child)}{/each}
			</ul>
		{/if}
	</li>
{/snippet}

<div class="sc-reads">
	<div class="sc-reads__ask">
		<label class="sc-reads__label" for={`${id}-text`}>{#if mode === 'trigger'}A trigger: what follows <code>if</code>{:else}An expression or an effect{/if}</label>
		<input
			bind:this={input}
			bind:value={text}
			id={`${id}-text`}
			class="sc-reads__input"
			type="text"
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			aria-describedby={`${id}-result`}
		/>
		<fieldset class="sc-reads__mode">
			<legend class="sc-visually-hidden">Read it as</legend>
			<label><input type="radio" name={`${id}-mode`} value="auto" bind:group={mode} /> an expression or effect</label>
			<label><input type="radio" name={`${id}-mode`} value="trigger" bind:group={mode} /> a trigger, after <code>if</code></label>
		</fieldset>
		{#if seeds.length}
			<div class="sc-reads__seeds" role="group" aria-label="Try a trap">
				<span class="sc-reads__try" aria-hidden="true">Try:</span>
				{#each seeds as s, i (i)}
					<button type="button" class="sc-btn sc-btn--sm sc-btn--quiet" aria-pressed={text === s.text && mode === (s.mode ?? 'auto')} onclick={() => seed(s)}>{@html inlineCode(s.label)}</button>
				{/each}
			</div>
		{/if}
	</div>
	<div class="sc-reads__out" id={`${id}-result`}>
		{#if reading.error}
			<p class="sc-diag__head"><span class="sc-diag__mark" aria-hidden="true"></span>KIELER cannot read {what}</p>
			{#if reading.error.col && reading.error.col <= text.trim().length + 1}
				<pre class="sc-reads__caret" aria-hidden="true">{text.trim()}
{' '.repeat(reading.error.col - 1)}^</pre>
			{/if}
			<p class="sc-reads__msg">{#if reading.error.col}<span class="sc-diag__where">Column {reading.error.col}:</span>{' '}{/if}{@html inlineCode(reading.error.message)}</p>
			{#if reading.error.kieler}<p class="sc-diag__kieler">KIELER's wording: <q>{reading.error.kieler}</q></p>{/if}
			{#if reading.error.hint}<p class="sc-diag__hint">{@html inlineCode(reading.error.hint)}</p>{/if}
			{#if about}<a class="sc-diag__about" href={about}>About this message</a>{/if}
		{:else}
			<p class="sc-reads__head">KIELER reads {what} as</p>
			{#if reading.delay}
				<p class="sc-reads__delay">A <strong>count delay</strong> of <code>{reading.delay}</code>: the transition fires the {ordinal(reading.delay)} time this holds:</p>
			{/if}
			<p class="sc-reads__result"><code>{reading.text}</code></p>
			{#each reading.warnings as w, i (i)}
				<p class="sc-reads__warning">KIELER warns: <q>{w.kieler ?? w.message}</q></p>
			{/each}
			{#if reading.tree}
				<p class="sc-visually-hidden">As a tree, each operation with its operands under it:</p>
				<ul class="sc-reads__tree">{@render branch(reading.tree)}</ul>
			{/if}
		{/if}
	</div>
	<div class="sc-visually-hidden" aria-live="polite">{said}</div>
</div>

<style>
	.sc-reads {
		display: grid;
		font-size: var(--text-sm);
		line-height: 1.5;
	}
	.sc-reads__ask {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem var(--frame-pad, 1rem);
		background-color: var(--c-rail);
		border-bottom: 1px solid var(--c-rule);
	}
	.sc-reads__label {
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--c-muted);
	}
	.sc-reads__input {
		width: 100%;
		min-height: 2.5rem;
		padding: 0.375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: var(--text-md);
		color: var(--c-ink);
		background-color: var(--c-sheet);
		border: 1.5px solid var(--c-control);
		border-radius: var(--radius-sm, 6px);
	}
	.sc-reads__input:focus-visible {
		outline: 2px solid var(--c-accent-bright);
		outline-offset: 1px;
	}
	.sc-reads__mode {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		margin: 0;
		padding: 0;
		border: 0;
		color: var(--c-text);
	}
	.sc-reads__mode label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		cursor: pointer;
	}
	.sc-reads__mode input {
		accent-color: var(--c-accent);
	}
	.sc-reads__seeds {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
	}
	.sc-reads__try {
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--c-muted);
	}
	.sc-reads__seeds button[aria-pressed='true'] {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
	}
	.sc-reads :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--c-ink);
	}
	.sc-reads__out {
		display: grid;
		gap: 0.375rem;
		padding: 0.75rem var(--frame-pad, 1rem) 1rem;
		min-height: 9rem;
		align-content: start;
	}
	.sc-reads__out > p {
		margin: 0;
	}
	.sc-reads__head {
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--c-muted);
	}
	.sc-reads__result code {
		font-size: var(--text-lg);
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.sc-reads__delay,
	.sc-reads__msg {
		color: var(--c-ink);
	}
	.sc-reads__warning {
		color: var(--c-caution-ink);
		font-size: var(--text-xs);
	}
	.sc-reads__warning q {
		font-family: var(--font-mono);
		quotes: none;
	}
	.sc-reads__caret {
		margin: 0.125rem 0;
		padding: 0.375rem 0.625rem;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		line-height: 1.35;
		color: var(--c-ink);
		background-color: var(--c-code-bg);
		border-radius: var(--radius-xs);
		overflow-x: auto;
		white-space: pre;
	}
	/* The tree: each operation, its operands under it, joined by lines as in a file tree. */
	.sc-reads__tree,
	.sc-reads__tree ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.sc-reads__tree {
		margin-top: 0.375rem;
		overflow-x: auto;
	}
	.sc-reads__tree ul {
		margin-inline-start: 0.6875rem;
		padding-inline-start: 0.875rem;
	}
	.sc-reads__tree li {
		position: relative;
		padding-block: 0.125rem;
	}
	/* The line down the side of a node's operands, ending at the last one, and a stub to each. */
	.sc-reads__tree ul > li::before {
		content: '';
		position: absolute;
		inset-inline-start: -0.875rem;
		top: 0;
		bottom: 0;
		border-inline-start: 1.5px solid var(--c-rule-strong);
	}
	.sc-reads__tree ul > li:last-child::before {
		bottom: auto;
		height: 0.95em;
	}
	.sc-reads__tree ul > li::after {
		content: '';
		position: absolute;
		inset-inline-start: -0.875rem;
		top: 0.95em;
		width: 0.625rem;
		border-top: 1.5px solid var(--c-rule-strong);
	}
	.sc-reads__node {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		white-space: nowrap;
	}
	.sc-reads__node code {
		padding: 0.05em 0.35em;
		border-radius: var(--radius-xs);
		background-color: var(--c-code-bg);
	}
	.sc-reads__node.is-op code {
		font-weight: 700;
		color: var(--sc-keyword);
	}
	.sc-reads__name {
		font-size: var(--text-xs);
		color: var(--c-muted);
	}
</style>

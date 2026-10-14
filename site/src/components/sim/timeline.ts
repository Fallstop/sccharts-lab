// The model behind the simulation controls: the ticks computed so far, the tick being shown (the cursor),
// what the input controls hold, and the guided tour. Pure (no DOM, no Svelte), so it is unit-tested.
//
// Inputs work as in KIELER's simulator (docs-internal/semantics/basics.md B-9, B-10): the environment sends
// only the inputs it changes, and an input it does not send keeps its value from the end of the previous
// tick, including a value the chart wrote to it. So after each tick the controls show the inputs' values in
// the data pool (with one-tick pulses released), and a Step sends only what the reader changed. The guided
// tour sends exactly the inputs each scenario tick names, so it reproduces the oracle's run.
//
// Going back never throws ticks away: the later ticks stay in the trace (dimmed) and Step replays them as
// they were, until the reader changes an input; then the next Step branches (the engine rewinds to the
// cursor and runs the new inputs). Previous goes back through the tour, and changing an input (or Take over)
// hands control to the reader.

import type { TickResult, Value } from '~engine/types'
import { effectiveInputs, sameInputs, type InputState } from './inputs'

/** What the timeline needs from the engine's Simulation (Compare passes a pair of simulations). */
export interface Stepper {
    readonly tick: number
    readonly history: TickResult[]
    step(inputs?: Record<string, Value>): TickResult
    reset(): void
    rewind(toTick: number): void
}

export interface TourScript {
    ticks: { inputs?: Record<string, unknown>; note?: string }[]
}

export type StepOutcome = 'stepped' | 'replayed' | 'branched'

/** The inputs' values in the data pool after a tick, under the controls' keys (KIELER's names). The engine
 *  reports its pool as `pool`; without one, the inputs the tick ran with. */
export type PoolReader = (tick: TickResult, keys: string[]) => Record<string, Value>

const defaultPool: PoolReader = (tick, keys) => {
    const pool = (tick as TickResult & { pool?: Record<string, Value> }).pool ?? tick.inputs
    const out: Record<string, Value> = {}
    for (const k of keys) if (k in pool) out[k] = pool[k]
    return out
}

export class Timeline {
    /** The tick shown: 0 before the first tick, else 1..sim.tick. */
    cursor = 0
    /** The guided tour is in control. */
    tour: boolean
    /** For every computed tick (index tick-1): the controls it ran with, and what it sent to the engine. */
    private given: InputState[] = []
    private sent: Record<string, Value>[] = []
    /** Controls the reader edited since the last move (they win over recorded and scripted inputs). */
    private pending: InputState | undefined

    constructor(
        public sim: Stepper,
        readonly initial: InputState,
        readonly script?: TourScript,
        private readonly readPool: PoolReader = defaultPool
    ) {
        this.tour = !!script?.ticks.length
    }

    /** Ticks computed (the last one may be after the cursor). */
    get end(): number {
        return this.sim.tick
    }
    get history(): TickResult[] {
        return this.sim.history
    }
    /** The tick shown, or undefined before the first tick. */
    get shown(): TickResult | undefined {
        return this.cursor > 0 ? this.sim.history[this.cursor - 1] : undefined
    }
    get tourLength(): number {
        return this.script?.ticks.length ?? 0
    }
    /** How many ticks from the start ran with exactly the script's inputs (their notes still apply). */
    get scriptedPrefix(): number {
        let n = 0
        while (n < this.sent.length && n < this.tourLength && sameInputs(this.sent[n], this.scriptInputs(n))) n++
        return n
    }
    /** The tour note of the tick shown, as long as every tick up to it ran as scripted (tour or not). */
    get note(): string | undefined {
        if (this.cursor === 0 || this.cursor > this.scriptedPrefix) return undefined
        return this.script?.ticks[this.cursor - 1]?.note
    }
    /** The controls hold the reader's changes (not the recorded or scripted inputs). */
    get dirty(): boolean {
        return this.pending !== undefined
    }
    /** The reader changed the controls behind the end: the next Step runs a new tick and drops the later ones. */
    get edited(): boolean {
        return this.pending !== undefined && this.cursor < this.end
    }
    /** Ticks after the cursor that the next Step would replay (none once the reader edited an input). */
    get canReplay(): boolean {
        return this.cursor < this.end && !this.pending
    }
    /** The tour has a scripted tick after the cursor. */
    get tourHasNext(): boolean {
        return this.tour && this.cursor < this.tourLength
    }

    private scriptInputs(index: number): Record<string, Value> {
        return (this.script?.ticks[index]?.inputs ?? {}) as Record<string, Value>
    }

    /** The inputs' values after tick k (0: the initial values). */
    private pool(k: number): Record<string, Value> {
        if (k === 0) return this.initial.levels
        return { ...this.initial.levels, ...this.readPool(this.sim.history[k - 1], Object.keys(this.initial.levels)) }
    }

    /** The controls after tick k: the pool's values, with the inputs pulsed in tick k released again. */
    private after(k: number): InputState {
        if (k === 0) return this.initial
        const g = this.given[k - 1]
        // A tick that failed with a run-time error was not applied: keep what the reader had set.
        if (this.sim.history[k - 1]?.error && g) return { levels: g.levels, pulses: [] }
        const levels = { ...this.pool(k) }
        for (const p of g?.pulses ?? []) levels[p] = g.levels[p]
        return { levels, pulses: [] }
    }

    /**
     * What the input controls show. In the guided tour: the inputs of the tick shown (the one its note talks
     * about; before tick 1, the inputs tick 1 will run with). Otherwise the reader's edits, else the inputs
     * the next Step will use.
     */
    controls(): InputState {
        if (this.tour && !this.pending && this.cursor > 0 && this.given[this.cursor - 1]) return this.given[this.cursor - 1]
        return this.nextControls()
    }

    /** The inputs the next Step will use: the reader's edits, the recorded inputs of the tick after the
     *  cursor, the script's, or the inputs as they are after the tick shown. */
    private nextControls(): InputState {
        if (this.pending) return this.pending
        if (this.cursor < this.end) return this.given[this.cursor]
        const base = this.after(this.cursor)
        if (this.tour && this.cursor < this.tourLength) return { levels: { ...base.levels, ...this.scriptInputs(this.cursor) }, pulses: [] }
        return base
    }

    /** The reader changed an input: it applies to the next Step, and takes over from the tour. */
    edit(state: InputState): void {
        this.pending = state
        this.tour = false
    }

    /** One tick forward: replays a recorded tick, or runs a new one (branching when behind the end). */
    step(): StepOutcome {
        if (this.canReplay) {
            this.cursor++
            return 'replayed'
        }
        const controls = this.nextControls()
        const scripted = this.tour && !this.pending && this.cursor < this.tourLength
        let outcome: StepOutcome = 'stepped'
        if (this.cursor < this.end) {
            this.sim.rewind(this.cursor)
            this.given.length = this.cursor
            this.sent.length = this.cursor
            outcome = 'branched'
        }
        if (this.tour && this.cursor >= this.tourLength) this.tour = false
        const inputs = scripted ? { ...this.scriptInputs(this.cursor) } : this.changes(controls, this.pool(this.cursor))
        this.sim.step(inputs)
        this.given.push(controls)
        this.sent.push(inputs)
        this.cursor = this.sim.tick
        this.pending = undefined
        return outcome
    }

    /** The inputs whose control value differs from the pool (pulsed inputs count as present). */
    private changes(controls: InputState, pool: Record<string, Value>): Record<string, Value> {
        const out: Record<string, Value> = {}
        for (const [k, v] of Object.entries(effectiveInputs(controls))) if (JSON.stringify(v) !== JSON.stringify(pool[k] ?? null)) out[k] = v
        return out
    }

    back(): boolean {
        if (this.cursor === 0) return false
        this.cursor--
        this.pending = undefined
        return true
    }

    forward(): boolean {
        if (this.cursor >= this.end) return false
        this.cursor++
        this.pending = undefined
        return true
    }

    goto(tick: number): boolean {
        const to = Math.max(0, Math.min(this.end, Math.round(tick)))
        if (to === this.cursor) return false
        this.cursor = to
        this.pending = undefined
        return true
    }

    /** Back to tick 0. `tour` restarts the guided tour (default: keep the current mode). */
    reset(tour = this.tour): void {
        this.sim.reset()
        this.given = []
        this.sent = []
        this.cursor = 0
        this.pending = undefined
        this.tour = tour && this.tourLength > 0
    }

    /** Leave the tour at the current tick. The controls show the inputs as they are after it (they persist,
     *  so normally what the tour showed; before tick 1, see `keepShown`); behind the end, Step still replays the
     *  later ticks. */
    takeOver(keepShown = false): void {
        if (!this.tour) return
        // Before tick 1 the controls show the inputs tick 1 of the tour would run with. `keepShown` (the reader
        // pressed Take over, having seen them): they stay, as the reader's own for the next Step. Otherwise (free
        // play chosen elsewhere) the controls start from the initial values.
        if (keepShown && this.cursor === 0 && this.end === 0 && this.tourLength > 0) this.pending = this.nextControls()
        this.tour = false
    }

    /**
     * A new simulation of an edited chart. `replay`: send the recorded inputs again up to the cursor (the
     * ticks after it are dropped); otherwise start at tick 0, keeping the controls' values. Inputs the new
     * chart does not have are dropped; new inputs start at their initial values. Returns a new Timeline.
     */
    replace(sim: Stepper, initial: InputState, replay: boolean): Timeline {
        const keys = new Set(Object.keys(initial.levels))
        const fit = (s: InputState): InputState => {
            const levels = { ...initial.levels }
            for (const k of keys) if (k in s.levels) levels[k] = s.levels[k]
            return { levels, pulses: s.pulses.filter((p) => keys.has(p)) }
        }
        const next = new Timeline(sim, initial, undefined, this.readPool)
        if (replay) {
            for (let i = 0; i < this.cursor; i++) {
                const inputs = Object.fromEntries(Object.entries(this.sent[i]).filter(([k]) => keys.has(k)))
                sim.step(inputs)
                next.given.push(fit(this.given[i]))
                next.sent.push(inputs)
                next.cursor = sim.tick
            }
        }
        next.pending = fit(this.nextControls())
        return next
    }
}

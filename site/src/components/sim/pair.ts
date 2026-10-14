// Two simulations stepped together with the same inputs (<Compare>): each chart gets the inputs it declares,
// and after a tick the controls read each chart's own inputs from its own data pool. Pure (no DOM, no Svelte).

import type { TickResult, Value, VariableInfo } from '~engine/types'
import { initialInputs } from './inputs'
import type { PoolReader, Stepper } from './timeline'

interface Sim {
    readonly tick: number
    readonly history: TickResult[]
    step(inputs?: Record<string, Value>): TickResult
    reset(): void
    rewind(toTick: number): void
}

/** The union of two interfaces' inputs, in order: A's, then B's that A does not have. */
export function unionInputs(a: VariableInfo[], b: VariableInfo[]): VariableInfo[] {
    return [...a.filter((v) => v.input), ...b.filter((v) => v.input && !a.some((w) => w.input && w.name === v.name))]
}

const poolOf = (t: TickResult | undefined): Record<string, Value> =>
    (t as (TickResult & { pool?: Record<string, Value> }) | undefined)?.pool ?? t?.inputs ?? {}

/**
 * A Stepper over both simulations (its history is A's) and the PoolReader that goes with it: the inputs after
 * a tick come from both charts' data pools (A's win for inputs both have).
 */
export function pairStepper(simA: Sim, ifaceA: VariableInfo[], simB: Sim, ifaceB: VariableInfo[]): { stepper: Stepper; readPool: PoolReader } {
    const keysA = new Set(Object.keys(initialInputs(ifaceA).levels))
    const keysB = new Set(Object.keys(initialInputs(ifaceB).levels))
    const pick = (inputs: Record<string, Value>, keys: Set<string>) => Object.fromEntries(Object.entries(inputs).filter(([k]) => keys.has(k)))
    const stepper: Stepper = {
        get tick() {
            return simA.tick
        },
        get history() {
            return simA.history
        },
        step(inputs = {}) {
            simB.step(pick(inputs, keysB))
            return simA.step(pick(inputs, keysA))
        },
        reset() {
            simA.reset()
            simB.reset()
        },
        rewind(n) {
            simA.rewind(n)
            simB.rewind(n)
        },
    }
    const readPool: PoolReader = (t, keys) => {
        const pool = { ...poolOf(simB.history[t.tick - 1]), ...poolOf(t) }
        const out: Record<string, Value> = {}
        for (const k of keys) if (k in pool) out[k] = pool[k]
        return out
    }
    return { stepper, readPool }
}

// A deterministic fake of the engine's Simulation for testing the widgets' logic without the engine: each
// tick reports its inputs as values and counts in `n`. rewind() replays the recorded inputs, as the engine's.
import type { TickResult, Value, VariableInfo } from '../../src/engine/types'
import type { Stepper } from '../../src/components/sim/timeline'

export function fakeSim(iface: VariableInfo[] = []): Stepper & { calls: string[]; interface: VariableInfo[] } {
    let history: TickResult[] = []
    let log: Record<string, Value>[] = []
    const calls: string[] = []
    let held: Record<string, Value> = {}
    const step = (inputs: Record<string, Value> = {}): TickResult => {
        held = { ...held, ...inputs }
        log.push({ ...inputs })
        const tick = history.length + 1
        const t: TickResult = {
            tick, inputs: { ...held }, values: { ...held, n: tick }, present: {}, active: ['C', `C.S${tick % 2}`], entered: [], exited: [],
            taken: [], actions: [], terminated: false, log: [], printed: [],
        }
        history.push(t)
        return t
    }
    return {
        calls,
        get interface() { return iface },
        get tick() { return history.length },
        get history() { return history },
        step(inputs) { calls.push(`step ${JSON.stringify(inputs)}`); return step(inputs) },
        reset() { calls.push('reset'); history = []; log = []; held = {} },
        rewind(to) {
            calls.push(`rewind ${to}`)
            const keep = log.slice(0, to)
            history = []; log = []; held = {}
            for (const i of keep) step(i)
        },
    }
}

export const v = (name: string, type: VariableInfo['type'], extra: Partial<VariableInfo> = {}): VariableInfo => ({
    name, id: `C$${name}`, type, signal: false, valued: false, input: true, output: false, const: false, dims: [], ...extra,
})

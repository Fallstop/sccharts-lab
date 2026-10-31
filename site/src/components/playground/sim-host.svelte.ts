// Mounts the widgets' SimPanel (src/components/sim/SimPanel.svelte, see its README) for the playground and lets
// plain TypeScript drive its props. The compile result is passed as raw state: the model index keys maps by AST
// objects, so the result must not be wrapped in Svelte's deep proxies.

import { flushSync, mount, unmount } from 'svelte'
import SimPanel from '../sim/SimPanel.svelte'
import type { CompileResult } from '../../engine/index'
import type { ClassMap } from '../../diagram/highlight'
import type { TickResult } from '../../engine/types'
import type { Scenario } from '../frame/examples'

/** What SimPanel reports with each highlight (README, "SimView"). */
export interface SimView {
    cursor: number
    tick?: TickResult
    history: TickResult[]
    tour: boolean
    lines: { active: number[]; taken: number[]; error: number[] }
}

/** SimPanel's `verdict`: the chart is an example with KIELER's recording, or only the guide's engine runs it. */
export type Verdict = 'recorded' | 'engine'

export interface SimCallbacks {
    onhighlight: (classes: ClassMap, view: SimView) => void
    onfire?: (transitionIds: string[]) => void
    onfocus?: (ids: string[]) => void
}

export interface SimHost {
    /** A new chart (and its source, for the panel's line map and "What happened"). */
    setCompiled(result: CompileResult, source: string, recompile: 'reset' | 'replay'): void
    /** The variables the timing diagram traces (SimPanel's `show`; undefined: its default). */
    setShow(names: string[] | undefined): void
    /** Whether KIELER's recording backs the chart ('recorded') or only the guide's engine ('engine'). */
    setVerdict(verdict: Verdict): void
    step(): void
    /** Steps one tick and applies it at once: `onhighlight` has reported the tick when it returns (Run until). */
    stepNow(): void
    back(): void
    reset(): void
    run(): void
    pause(): void
    /** Leaves the guided tour (keeps the ticks so far). */
    takeOver(): void
    /** Starts the guided tour again from tick 0. */
    restartTour(): void
    destroy(): void
}


interface PanelExports {
    step?: () => void
    back?: () => void
    reset?: () => void
    run?: () => void
    pause?: () => void
    takeOver?: () => void
    restartTour?: () => void
}

export async function mountSim(
    target: HTMLElement,
    initial: CompileResult,
    initialSource: string,
    callbacks: SimCallbacks,
    options: {
        keys?: HTMLElement | null; variant?: 'full' | 'compact'; label?: string; id?: string
        /** A guided tour (SimPanel's `scenario`), with the ticks to run at once and the foot's texts. */
        scenario?: Scenario; initialTicks?: number; intro?: string; handover?: string
        /** What the tour is called ("Guided tour", "Test run", "Shared run"; SimPanel's `tourName`). */
        tourName?: string
        show?: string[]; verdict?: Verdict
    } = {},
): Promise<SimHost | null> {
    let compiled = $state.raw(initial)
    let source = $state.raw(initialSource)
    let recompile = $state<'reset' | 'replay'>('replay')
    let show = $state.raw(options.show)
    let verdict = $state<Verdict>(options.verdict ?? 'engine')
    const props = {
        get compiled() {
            return compiled
        },
        get source() {
            return source
        },
        get recompile() {
            return recompile
        },
        get show() {
            return show
        },
        get verdict() {
            return verdict
        },
        onhighlight: callbacks.onhighlight,
        onfire: callbacks.onfire,
        onfocus: callbacks.onfocus,
        keys: options.keys ?? null,
        variant: options.variant ?? 'full',
        label: options.label,
        id: options.id,
        scenario: options.scenario,
        initialTicks: options.initialTicks ?? 0,
        intro: options.intro,
        handover: options.handover,
        tourName: options.tourName,
    }
    const instance = mount(SimPanel, { target, props }) as unknown as PanelExports
    const call = (name: keyof PanelExports) => () => instance[name]?.()
    return {
        setCompiled(result, text, mode) {
            recompile = mode
            source = text
            compiled = result
        },
        setShow(names) {
            show = names
        },
        setVerdict(v) {
            verdict = v
        },
        step: call('step'),
        stepNow() {
            instance.step?.()
            flushSync()
        },
        back: call('back'),
        reset: call('reset'),
        run: call('run'),
        pause: call('pause'),
        takeOver: call('takeOver'),
        restartTour: call('restartTour'),
        destroy() {
            void unmount(instance as Record<string, unknown>)
        },
    }
}

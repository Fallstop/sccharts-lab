// Exercises. A TryIt link (/playground/?example=<starter>&solution=<id>) shows the exercise's task in a banner under
// the app bar: its title and text, as on the guide's page (exercises.ts collects them at build time), with a link
// back to that section; it folds to its title row (remembered; folded on a phone at first). When the solution has a
// scenario and KIELER's recording of it, the app bar offers "Compare with the model solution": the reader's chart
// (as it is now) runs on the scenario's inputs and every output of the solution is compared, tick by tick
// (compare.ts). The solution's source stays hidden until the reader asks for it. An exercise whose starter already
// behaves as its model solution (one that asks for a new structure) says "This is still the starter" while unchanged.

import { compile } from '@sccharts-lab/engine'
import { $, el, escapeHtml, recall, remember } from './app-types'
import { compareWithSolution, summary, type Comparison } from './compare'
import { exerciseFor, type Exercise } from './exercises'
import { loadExampleSource, loadImports, loadRecording, loadScenario, tourOf, type Recording } from './sources'
import { highlightLines } from './static-highlight'
import { inlineMd } from '../frame/inline-md'
import type { Scenario } from '../frame/examples'
import type { Playground } from './app'

const TASK_KEY = 'sccharts-guide:playground:task-open'

export class ExerciseControl {
    /** The model solution of the exercise, if the playground was opened with &solution=. */
    solution?: { id: string; scenario: Scenario; recording: Recording; source?: string; reveal: boolean }
    /** The exercise's task; `starter`: the starter's source, and whether it already behaves as the model solution. */
    private task?: { ex: Exercise; starter?: string; starterMatches?: boolean }

    constructor(private pg: Playground) {}

    private get pop() {
        return $<HTMLDetailsElement>(this.pg.root, '[data-pg-compare]')
    }

    get comparing() {
        return !!this.pop?.open
    }

    async setup(id: string) {
        this.showTask(id)
        const [scenario, recording] = await Promise.all([loadScenario(id), loadRecording(id)])
        const tour = tourOf(scenario)
        // Recorded with KIELER's netlist compiler, as the guide's simulator runs charts.
        const system = (scenario as { system?: string } | undefined)?.system
        const pop = this.pop
        if (!tour || (system && system !== 'netlist') || !recording?.ok || !recording.ticks?.length || !recording.interface) {
            if (pop) pop.hidden = true
            return
        }
        this.solution = { id, scenario: tour, recording, reveal: false }
        // An exercise starts in free play: the reader is about to edit.
        if (this.pg.sim.wantTour) this.pg.sim.setMode('free')
        void this.checkStarter()
        if (!pop) return
        pop.hidden = false
        if (!pop.dataset.wired) {
            pop.dataset.wired = ''
            pop.addEventListener('toggle', () => {
                if (pop.open) this.render()
            })
        }
    }

    drop() {
        this.solution = undefined
        this.showTask(undefined)
        const pop = this.pop
        if (pop) {
            pop.open = false
            pop.hidden = true
        }
    }

    /** The comparison of the chart as it is now, in the app bar's panel. */
    render(): Comparison | undefined {
        const panel = $(this.pg.root, '[data-pg-compare-panel]')
        const sol = this.solution
        const a = this.pg.latest
        if (!panel || !sol || !a) return undefined
        const c = compareWithSolution(a.result, sol.scenario, sol.recording)
        const parts: HTMLElement[] = []
        parts.push(el('p', 'sc-pg-compare__lead', inlineMd(`Runs your chart on the inputs of the model solution's test run (${sol.scenario.ticks.length} ticks) and compares the outputs, tick by tick, with what the model solution does in KIELER.`)))
        // An exercise that keeps the behaviour and changes the structure: the starter already "matches".
        const still = this.isStillStarter() && c.status === 'match'
        const result = el('div', `sc-pg-compare__result is-${still ? 'starter' : c.unsupported ? 'unsupported' : c.status}`)
        result.setAttribute('role', 'status')
        result.append(el('p', '', inlineMd(still ? `This is still the starter. It already behaves as the model solution does in all ${c.total} ticks of the test run: the exercise asks for the same behaviour, built another way.` : summary(c))))
        parts.push(result)
        if (c.errors?.length) {
            const list = el('ul', 'sc-pg-compare__errors')
            for (const d of c.errors.slice(0, 4)) list.append(el('li', '', `${d.span ? `<span class="sc-pg-compare__where">Line ${d.span.line}</span> ` : ''}${inlineMd(d.message)}`))
            parts.push(list)
        }
        if (c.interface.length) {
            parts.push(el('p', 'sc-pg-compare__subhead', 'Inputs and outputs'))
            const list = el('ul', 'sc-pg-compare__interface')
            for (const p of c.interface) list.append(el('li', '', inlineMd(p.message)))
            parts.push(list)
        }
        if (c.status !== 'cannot' && c.ticks.length) {
            const strip = el('ol', 'sc-pg-compare__ticks')
            strip.setAttribute('aria-label', 'Ticks of the test run')
            c.ticks.forEach((ok, i) => {
                const li = el('li', ok ? 'is-same' : 'is-different', `<span aria-hidden="true">${i + 1}</span><span class="sc-visually-hidden">Tick ${i + 1}: ${ok ? 'the same' : 'different'}</span>`)
                li.title = `Tick ${i + 1}: ${ok ? 'the same outputs' : 'different outputs'}`
                strip.append(li)
            })
            for (let i = c.ticks.length; i < c.total; i++) strip.append(el('li', 'is-not-run', `<span aria-hidden="true">${i + 1}</span><span class="sc-visually-hidden">Tick ${i + 1}: not run</span>`))
            parts.push(strip)
        }
        if (c.firstTick) {
            const table = el('table', 'sc-pg-compare__table', `<caption>Outputs in tick ${c.firstTick.tick}</caption><thead><tr><th scope="col">Output</th><th scope="col">Your chart</th><th scope="col">Model solution</th></tr></thead>`)
            const body = el('tbody')
            for (const r of c.firstTick.rows) body.append(el('tr', r.same ? '' : 'is-different', `<th scope="row"><code>${escapeHtml(r.name)}</code></th><td>${escapeHtml(r.yours)}</td><td>${escapeHtml(r.theirs)}</td>`))
            table.append(body)
            parts.push(table)
        }
        const actions = el('div', 'sc-pg-compare__actions')
        if (c.status !== 'cannot') {
            const replay = el('button', 'sc-btn sc-btn--sm', c.firstTick ? `Show tick ${c.firstTick.tick} in the simulator` : 'Replay the test run in the simulator')
            replay.type = 'button'
            replay.addEventListener('click', () => this.replay(c))
            actions.append(replay)
        }
        const show = el('button', 'sc-btn sc-btn--sm sc-btn--quiet', sol.reveal ? 'Hide the model solution' : 'Show the model solution')
        show.type = 'button'
        show.setAttribute('aria-expanded', String(sol.reveal))
        show.addEventListener('click', async () => {
            sol.reveal = !sol.reveal
            if (sol.reveal && sol.source === undefined) sol.source = (await loadExampleSource(sol.id)) ?? ''
            this.render()
            $<HTMLButtonElement>(this.pg.root, '.sc-pg-compare__actions .sc-btn--quiet')?.focus()
        })
        actions.append(show)
        parts.push(actions)
        if (sol.reveal && sol.source) {
            const box = el('div', 'sc-pg-compare__solution', `<pre class="sc-pg-static"><code>${highlightLines(sol.source).map(l => `<span class="sc-pg-static__line"><span class="sc-pg-static__text">${l || ' '}</span></span>`).join('')}</code></pre>`)
            const open = el('a', 'sc-pg-compare__open', 'Open the model solution in a new tab')
            open.href = `/playground/?example=${encodeURIComponent(sol.id).replace(/%2F/g, '/')}`
            open.target = '_blank'
            open.rel = 'noopener'
            box.append(open)
            parts.push(box)
        }
        parts.push(el('p', 'sc-pg-compare__note', 'A comparison, not a grade: another chart can solve the exercise its own way, and one run of inputs cannot show that a chart is right. Check what the exercise asks for, too.'))
        panel.replaceChildren(...parts)
        return c
    }

    /** Puts the comparison's inputs in the simulation panel, at the first tick that differs. */
    private replay(c: Comparison) {
        const sol = this.solution
        if (!sol) return
        const first = c.differences[0]
        const ticks = sol.scenario.ticks.map((t, i) => {
            const diffs = c.differences.filter(d => d.tick === i + 1)
            return { inputs: t.inputs, note: diffs.length ? diffs.map(d => d.message.replace(/^In tick \d+ y/, 'Y')).join(' ') : undefined }
        })
        this.pop!.open = false
        this.pg.sim.replayTest({ ticks, expect: 'ok' }, first ? first.tick : 0)
        this.pg.showTab('sim')
        this.pg.toast(first ? `The simulator shows tick ${first.tick} of the test run, where your outputs first differ.` : 'The simulator replays the test run: press Next.')
    }

    // ----- The task banner -------------------------------------------------------------------------------------------

    private allExercises(): Exercise[] {
        try {
            return JSON.parse($(this.pg.root, '[data-pg-exercises]')?.textContent ?? '[]') as Exercise[]
        } catch {
            return []
        }
    }

    /** Shows the task of the exercise with this model solution (or hides the banner). */
    private showTask(solution: string | undefined) {
        const box = $(this.pg.root, '[data-pg-task]')
        if (!box) return
        const ex = exerciseFor(this.allExercises(), this.pg.origin.id, solution)
        this.task = ex ? { ex } : undefined
        box.hidden = !ex
        if (!ex) return
        $(box, '[data-pg-task-title]')!.textContent = ex.title
        const text = $(box, '[data-pg-task-text]')!
        text.innerHTML = ex.task
        $(box, '[data-pg-task-page]')!.textContent = ex.page
        const back = $<HTMLAnchorElement>(box, '[data-pg-task-back]')!
        back.href = ex.href
        back.title = `The exercise on the guide's page ${ex.page}`
        const toggle = $<HTMLButtonElement>(box, '[data-pg-task-toggle]')!
        const saved = recall(TASK_KEY)
        const set = (on: boolean) => {
            toggle.setAttribute('aria-expanded', String(on))
            box.classList.toggle('is-open', on)
            text.hidden = !on
            // A long task scrolls inside: then it is a tab stop, for the keyboard.
            requestAnimationFrame(() => {
                if (on && text.scrollHeight > text.clientHeight + 1) text.tabIndex = 0
                else text.removeAttribute('tabindex')
            })
        }
        set(saved ? saved === 'open' : !matchMedia('(max-width: 40rem)').matches)
        if (!toggle.dataset.wired) {
            toggle.dataset.wired = ''
            toggle.addEventListener('click', () => {
                const on = toggle.getAttribute('aria-expanded') !== 'true'
                set(on)
                remember(TASK_KEY, on ? 'open' : 'closed')
            })
        }
        void this.checkStarter()
    }

    /** Finds out whether the exercise's starter already behaves as its model solution (once both are loaded). */
    private async checkStarter() {
        const task = this.task
        const sol = this.solution
        if (!task || (task.starter !== undefined && task.starterMatches !== undefined)) return
        if (task.starter === undefined) task.starter = (await loadExampleSource(task.ex.starter)) ?? ''
        if (this.task !== task || !sol || sol.id !== task.ex.solution || !task.starter) {
            this.updateState()
            return
        }
        const files = await loadImports(task.ex.starter, task.starter)
        if (this.task !== task) return
        const c = compareWithSolution(compile(task.starter, { files }), sol.scenario, sol.recording)
        task.starterMatches = c.status === 'match' && !c.interface.length
        this.updateState()
        if (this.comparing) this.render()
    }

    /** The reader's chart is the starter of an exercise whose starter already behaves as the model solution. */
    private isStillStarter(): boolean {
        const task = this.task
        const p = this.pg.project
        return !!task?.starterMatches && !!this.pg.view && p.active === p.mainFile && p.text(p.mainFile) === task.starter
    }

    updateState() {
        const pill = $(this.pg.root, '[data-pg-task-starter]')
        if (pill) pill.hidden = !this.isStillStarter()
    }
}

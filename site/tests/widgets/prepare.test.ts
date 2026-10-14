// What the widgets say about a chart (src/components/frame/prepare.ts): KIELER's verdict wins, the errors that
// make KIELER reject a chart come first with KIELER's own words, warnings are listed separately (also for
// accepted charts), and a chart KIELER accepts that the engine cannot run is never called rejected.
import { describe, expect, it } from 'vitest'
import { loadExample } from '../../src/components/frame/examples'
import { prepareChart } from '../../src/components/frame/prepare'
import { diagnosticKind, warningSummary } from '../../src/components/frame/diagnostics'
import { whoSays } from '../../src/components/frame/error-links'

const prepare = (id: string) => prepareChart(loadExample(id, 'test'))

describe('prepareChart', () => {
    it('shows KIELER\'s warnings for an accepted chart, with its wording', async () => {
        const p = await prepare('learn/transitions/stopwatch-unreachable')
        expect(p.rejected).toBe(false)
        expect(p.errors).toEqual([])
        expect(p.warnings.map((w) => w.kieler ?? w.message)).toContain('The transition is not reachable.')
    })

    it('lists the errors that make KIELER reject the chart first, warnings apart', async () => {
        const p = await prepare('learn/causality/retry')
        expect(p.rejected).toBe(true)
        expect(p.errors[0].code).toBe('instantaneous-loop')
        expect(p.errors[0].kieler).toBe('The SCG is NOT asc-schedulable!')
        expect(p.errors.every((e) => e.severity === 'error')).toBe(true)
        expect(p.warnings[0].kieler).toMatch(/^There is an immediate loop/)
    })

    it('gives KIELER\'s wording of parse errors', async () => {
        const p = await prepare('reference/errors/missing-to')
        expect(p.rejected).toBe(true)
        expect(p.errors[0].code).toBe('parse')
        expect(p.errors.map((e) => e.kieler ?? (e.kielerOnly ? e.message : ''))).toContain("missing 'to' at 'Done'")
    })

    it('shows KIELER\'s own messages when only KIELER rejects the chart (gcc on host code)', async () => {
        const p = await prepare('advanced/host-code/distance-no-include')
        expect(p.rejected).toBe(true)
        expect(p.errors.length).toBeGreaterThan(0)
        expect(p.errors.every((e) => e.kielerOnly)).toBe(true)
        expect(p.errors.some((e) => /abs/.test(e.message))).toBe(true)
        expect(p.errors.some((e) => /required feature/.test(e.message))).toBe(false)
    })

    it('compiles imports: a chart that imports another runs', async () => {
        const p = await prepare('advanced/references/import-main')
        expect(p.rejected).toBe(false)
        expect(p.cannotRun).toBeUndefined()
        expect(Object.keys(p.files)).toEqual(['push-switch.sctx'])
    })

    it('never calls a chart KIELER accepts rejected: the engine just cannot run it', async () => {
        const host = await prepare('advanced/host-code/backticks')
        expect(host.rejected).toBe(false)
        expect(host.cannotRun).toMatch(/cannot run in the browser/)
        const priority = await prepare('advanced/code-generation/burst-priority')
        expect(priority.rejected).toBe(false)
        expect(priority.cannotRun).toMatch(/priority-based compiler/)
    })

    it('leaves out internal compiler noise', async () => {
        const p = await prepare('advanced/history/menu-deep')
        expect(p.warnings.some((w) => /VariableStore/.test(w.message))).toBe(false)
    })

    it("counts the guide's own lints as notes, apart from KIELER's and the C compiler's warnings", async () => {
        // reference/operators, Grouping: the recording has gcc's warning only; the two `KIELER reads this as …` are the
        // guide's (reference/about: the warnings listed are KIELER's).
        const p = await prepare('reference/operators/grouping')
        expect(p.warnings.map((w) => [w.code ?? '', diagnosticKind(w)])).toEqual([
            ['ternary-grouping', 'Note'],
            ['ternary-grouping', 'Note'],
            ['', 'Warning'],
        ])
        expect(p.warnings[2].kielerOnly && whoSays(p.warnings[2].message)).toBe('The C compiler says')
        expect(warningSummary(p.warnings)).toBe('1 warning and 2 notes')
        // The guide's explanation of a KIELER bug (KIELER says nothing) is a note too.
        expect(diagnosticKind({ severity: 'warning', code: 'kieler-bug', message: 'KIELER runs this first-tick assignment before the inputs are read' })).toBe('Note')
    })
})

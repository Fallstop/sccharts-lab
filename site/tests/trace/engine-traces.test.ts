// The engine's runs as traces, checked against every scenario with a KIELER recording:
//
// - the engine runs the scenario's inputs, and traceFromRun gives the trace the SCCharts Lab extension saves for the
//   same run on KIELER's server (recordings.ts builds that trace from the recording alone): the same columns
//   (names, roles, types, order) and the same values, so the four files are byte for byte the same;
// - each of the four files reads back as the run (and as KIELER's values);
// - replaying each file into a fresh simulation gives the run again without a single mismatch. Where the chart
//   writes its own input (basics.md B-10, or past an array's end), the pool's input after the tick is not what the
//   tick read, so the extension's trace does not replay the run; the trace of what the ticks read
//   (`inputs: 'read'`) does.
//
// Left out, with the count printed: what tests/conformance/engine.test.ts leaves out (other systems, needs the
// engine does not emulate, KIELER bugs, unsupported charts, charts KIELER rejects).

import { afterAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { createSimulation, type PoolValue } from '@sccharts-lab/engine'
import { readTrace, replayTrace, sameTraceValue, traceFromRun, writeTrace, type TraceFormat, type TraceRecord } from '@sccharts-lab/trace'
import { compileCase, extensionTrace, recordedCases, tickCount, type Case } from './recordings'

const FORMATS: TraceFormat[] = ['ktrace', 'csv', 'json', 'xml']

/** Values of KIELER's data pool: a missing value and null are the same (an unset string). */
function same(a: unknown, b: unknown): boolean {
    if (a === undefined || a === null) return b === undefined || b === null
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
    }
    if (typeof a === 'object' || typeof b === 'object') {
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
        const keys = new Set([...Object.keys(a), ...Object.keys(b)])
        return [...keys].every((k) => same((a as Record<string, PoolValue>)[k], (b as Record<string, PoolValue>)[k]))
    }
    return a === b
}

/** Where `actual`'s values differ from `expected`'s, for the variables `expected` has (and `roles`, if given). */
function differences(actual: TraceRecord, expected: TraceRecord, equal: (a: unknown, b: unknown) => boolean, roles?: string[]): string[] {
    const out: string[] = []
    if (actual.ticks.length !== expected.ticks.length) out.push(`${actual.ticks.length} ticks, expected ${expected.ticks.length}`)
    expected.ticks.forEach((tick, index) => {
        for (const { name, role } of expected.variables) {
            if (roles && !roles.includes(role ?? '')) continue
            const value = actual.ticks[index]?.[name]
            if (!equal(value, tick[name])) out.push(`tick ${index + 1}: ${name} is ${JSON.stringify(value)}, expected ${JSON.stringify(tick[name])}`)
        }
    })
    return out.slice(0, 5)
}

const columns = (trace: TraceRecord) => trace.variables.map(({ name, role, type }) => `${name}:${role}:${type}`)

const stats = {
    cases: 0,
    skipped: new Map<string, number>(),
    run: 0,
    ticks: 0,
    printing: 0,
    sameColumns: 0,
    sameValues: 0,
    identical: Object.fromEntries(FORMATS.map((f) => [f, 0])) as Record<TraceFormat, number>,
    readBack: Object.fromEntries(FORMATS.map((f) => [f, 0])) as Record<TraceFormat, number>,
    replayed: Object.fromEntries(FORMATS.map((f) => [f, 0])) as Record<TraceFormat, number>,
    replayMismatches: 0,
    writesInputs: 0,
    replayErrors: 0,
}

/** The chart writes an input in some tick: the pool's value after the tick is not the one the tick read. */
function writesInputs(trace: TraceRecord, read: TraceRecord): boolean {
    return trace.variables.some(({ name, role }) => role === 'input' && trace.ticks.some((tick, i) => !same(tick[name], read.ticks[i][name])))
}

function check(c: Case): string[] {
    stats.cases++
    const { result, skip } = compileCase(c)
    const ticks = tickCount(c)
    if (!result || ticks === 0) {
        const reason = skip ?? 'no ticks before the runtime error'
        stats.skipped.set(reason, (stats.skipped.get(reason) ?? 0) + 1)
        return []
    }
    stats.run++
    stats.ticks += ticks
    const model = path.basename(c.chart)
    const simulation = createSimulation(result)
    for (let i = 0; i < ticks; i++) simulation.step(c.scenario.ticks[i].inputs ?? {})
    const engine = traceFromRun(result, simulation, { model })
    if (engine.printed) stats.printing++
    // KIELER's printed lines are not in the recordings; the rest of the file is compared.
    const run: TraceRecord = { ...engine, printed: undefined }
    const initialised = (name: string) => result.interface.find((v) => v.name === name)?.initialValue != null
    const kieler = extensionTrace(c, model, initialised)
    const problems: string[] = []

    if (columns(run).join(' ') === columns(kieler).join(' ')) stats.sameColumns++
    else problems.push(`columns: ${columns(run).join(' ')}\n  KIELER: ${columns(kieler).join(' ')}`)
    const valueProblems = differences(run, kieler, same)
    if (valueProblems.length === 0) stats.sameValues++
    else problems.push(...valueProblems.map((p) => `values: ${p}`))

    for (const format of FORMATS) {
        let text: string
        try {
            text = writeTrace(engine, format)
        } catch (error) {
            problems.push(`${format}: ${error instanceof Error ? error.message : error}`)
            continue
        }
        if (writeTrace(run, format) === writeTrace(kieler, format)) stats.identical[format]++
        else problems.push(`${format}: not the file the extension writes`)

        const back = readTrace(text, format)
        // KTrace holds inputs and outputs; CSV reads "7" as 7, so its values compare as printed.
        const roles = format === 'ktrace' ? ['input', 'output'] : undefined
        const equal = format === 'json' || format === 'xml' ? same : sameTraceValue
        const readProblems = [...differences(back, engine, equal, roles), ...differences(back, kieler, (a, b) => equal(a, b ?? undefined), roles)]
        if (format === 'json' || format === 'xml') {
            if (columns(back).join(' ') !== columns(engine).join(' ')) readProblems.push(`columns read back: ${columns(back).join(' ')}`)
        }
        if (readProblems.length === 0) stats.readBack[format]++
        else problems.push(...readProblems.map((p) => `${format} read back: ${p}`))

        let replayed = replayTrace(result, back, { label: `${model}.${format}`, model })
        stats.replayMismatches += replayed.mismatches.length
        if (replayed.error) stats.replayErrors++
        const read = traceFromRun(result, simulation, { model, inputs: 'read' })
        if ((replayed.mismatches.length > 0 || replayed.error) && writesInputs(engine, read)) {
            if (format === 'ktrace') stats.writesInputs++
            replayed = replayTrace(result, readTrace(writeTrace(read, format), format), { model })
        }
        const replayProblems = [
            ...replayed.mismatches.map((m) => `tick ${m.tick}: ${m.name} is ${JSON.stringify(m.actual)}, the trace has ${JSON.stringify(m.expected)}`),
            ...(replayed.error ? [`runtime error ${replayed.error.message}`] : []),
            ...replayed.state.problems,
            ...differences(replayed.run, engine, same),
        ]
        if (replayProblems.length === 0) stats.replayed[format]++
        else problems.push(...replayProblems.slice(0, 5).map((p) => `${format} replay: ${p}`))
    }
    return problems
}

describe('engine runs as the extension’s traces', () => {
    const cases = recordedCases()
    it('finds the recordings', () => expect(cases.length).toBeGreaterThan(1000))
    for (const c of cases) {
        it(c.id, () => {
            const problems = check(c)
            expect(problems, problems.join('\n')).toEqual([])
        })
    }
    afterAll(() => {
        const skipped = [...stats.skipped].map(([reason, n]) => `${n} ${reason}`).join(', ')
        const per = (counts: Record<TraceFormat, number>) => FORMATS.map((f) => `${f} ${counts[f]}`).join(', ')
        console.log(
            [
                `Trace proof: ${stats.cases} recorded scenarios; ${stats.run} run (${stats.ticks} ticks); left out: ${skipped}.`,
                `  columns as the extension's: ${stats.sameColumns}/${stats.run}; values as KIELER's: ${stats.sameValues}/${stats.run}; ${stats.printing} runs print.`,
                `  files identical to the extension's: ${per(stats.identical)}.`,
                `  read back as the run: ${per(stats.readBack)}.`,
                `  replayed without a mismatch: ${per(stats.replayed)}; ${stats.writesInputs} of them write an input and replay from`,
                `  the inputs the ticks read (the extension's trace: ${stats.replayMismatches} mismatches, ${stats.replayErrors} runtime errors).`,
            ].join('\n')
        )
    })
})

// The recorded scenarios (KIELER runs) the trace proofs use, and the trace the SCCharts Lab extension saves for
// such a run, built from the recording alone: KIELER's `#interface` (the oracle's `interface`) and data pool after
// each tick (its `values`), with the extension's rules (simulation-table-data-provider.ts: readDataPool,
// isInternal, currentTrace).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, type CompileResult, type PoolValue } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'
import type { TraceRecord, TraceRole, TraceVariable } from '@sccharts-lab/trace'

const here = path.dirname(fileURLToPath(import.meta.url))
export const site = path.resolve(here, '../..')

export interface Scenario {
    ticks: { inputs?: Record<string, Value> }[]
    system?: string
    imports?: string[]
    needs?: string[]
    kielerBug?: string
    runtimeError?: { tick: number; code: string; frozen?: boolean }
}

export interface Recording {
    ok: boolean
    interface?: Record<string, { type: string; properties: string[] }>
    ticks: { step: number; values: Record<string, PoolValue> }[]
}

export interface Case {
    id: string
    chart: string
    scenario: Scenario
    recording: Recording
}

function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

/** Every scenario with a KIELER recording, as tests/conformance/engine.test.ts finds them. */
export function recordedCases(): Case[] {
    const out: Case[] = []
    for (const root of ['tests/conformance', 'src/examples', 'tests/engine/kieler']) {
        for (const file of walk(path.join(site, root))) {
            if (!file.endsWith('.oracle.json')) continue
            const base = file.slice(0, -'.oracle.json'.length)
            const scenarioFile = `${base}.scenario.json`
            if (!fs.existsSync(`${base}.sctx`) || !fs.existsSync(scenarioFile)) continue
            out.push({
                id: path.relative(site, base).split(path.sep).join('/'),
                chart: `${base}.sctx`,
                scenario: JSON.parse(fs.readFileSync(scenarioFile, 'utf8')),
                recording: JSON.parse(fs.readFileSync(file, 'utf8')),
            })
        }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Features of KIELER's environment the engine emulates (scenario `needs`), as in the conformance test. */
const EMULATED_NEEDS = new Set(['c-strings', 'c-random'])

/** Compiles a case the engine runs as KIELER did, or says why it is left out (the conformance test's reasons). */
export function compileCase(c: Case): { result?: CompileResult; skip?: string } {
    const { scenario, recording } = c
    if (scenario.system && scenario.system !== 'netlist') return { skip: 'another system' }
    if ((scenario.needs ?? []).some((need) => !EMULATED_NEEDS.has(need))) return { skip: 'needs what the engine does not emulate' }
    if (!recording.ok) return { skip: 'KIELER rejects the chart' }
    if (scenario.kielerBug) return { skip: 'a KIELER bug the engine does not reproduce' }
    const files: Record<string, string> = {}
    for (const f of scenario.imports ?? []) files[path.basename(f)] = fs.readFileSync(path.join(path.dirname(c.chart), f), 'utf8')
    const result = compile(fs.readFileSync(c.chart, 'utf8'), { files })
    if (result.diagnostics.some((d) => d.code === 'unsupported')) return { skip: 'unsupported in the engine' }
    if (!result.ok) return { skip: 'the engine rejects the chart' }
    return { result }
}

/** The ticks of a case that ran to the end: before a runtime error, where KIELER's simulation stopped. */
export function tickCount(c: Case): number {
    const stop = c.scenario.runtimeError?.tick
    return Math.min(c.scenario.ticks.length, c.recording.ticks.length, stop ? stop - 1 : Infinity)
}

const internal = (name: string) => name.startsWith('_') || name.startsWith('#') || name.includes('_tickCounter')

/**
 * The trace the extension saves for the recorded run. Its columns: the start message's data pool (KIELER's pool
 * before tick 1, in `#interface` order), then the `#interface` names that pool lacks, then sorted by role. The pool
 * before tick 1 is not recorded: it lacks what is never in a tick's pool (member declarations of classes and
 * structs, strings that stay null), strings missing from tick 1, and string inputs without initialiser given in
 * tick 1 (null until then; `initialised` says which strings have an initialiser).
 */
export function extensionTrace(c: Case, model: string, initialised: (name: string) => boolean): TraceRecord {
    const declared = c.recording.interface ?? {}
    const ticks = c.recording.ticks.slice(0, tickCount(c))
    const first = ticks[0]?.values ?? {}
    const given = c.scenario.ticks[0]?.inputs ?? {}
    const roleOf = (properties: string[]): TraceRole =>
        properties.includes('input') ? 'input' : properties.includes('output') ? 'output' : 'local'
    const names = Object.keys(declared).filter((name) => !internal(name))
    const late = (name: string) => {
        if (!(name in first)) return true
        const { type, properties } = declared[name]
        return type === 'string' && properties.includes('input') && name in given && !initialised(name)
    }
    const order: TraceRole[] = ['input', 'output', 'local']
    const variables: TraceVariable[] = [...names.filter((n) => !late(n)), ...names.filter(late)]
        .map((name) => ({ name, role: roleOf(declared[name].properties), type: declared[name].type }))
        .sort((a, b) => order.indexOf(a.role!) - order.indexOf(b.role!))
    const last: Record<string, unknown> = {}
    return {
        model,
        variables,
        ticks: ticks.map(({ values }) =>
            Object.fromEntries(
                variables.map(({ name }) => {
                    if (values[name] !== undefined) last[name] = values[name]
                    return [name, last[name]]
                })
            )
        ),
    }
}

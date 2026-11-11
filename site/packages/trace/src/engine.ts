// SPDX-License-Identifier: EPL-2.0
//
// Runs of the in-browser engine (@sccharts-lab/engine) as traces: the same columns, names, roles, types and values
// as the SCCharts Lab extension saves for the same run on KIELER's server, so the two write the same files.
//
// The extension's columns are KIELER's data pool: the C simulation's variables in KIELER's VARIABLE_ORDER
// (VariableStore.xtend: inputs, then outputs, then the rest, each by name), without the compiler's helpers
// (`_` and `#` names). The client lists the pool's variables before tick 1 first and the ones the pool lacks then
// (unset strings, the member declarations of classes and structs) after them, and puts inputs first, then outputs,
// then locals. Values are the pool after each tick; a name missing from a tick's pool keeps its value.

import type { CompileResult, Simulation, SimTickResult } from '@sccharts-lab/engine'
import { allScopes } from '@sccharts-lab/engine/internal'
import type { CVar } from '@sccharts-lab/engine/internal'
import type { Declaration, Value } from '@sccharts-lab/engine/types'
import { compareTraces } from './trace-compare'
import type { TraceComparison } from './trace-compare'
import { printedOf } from './trace-record'
import type { TraceRecord, TraceRole, TraceVariable } from './trace-record'

/** A variable of KIELER's data pool for a compiled chart. */
export interface PoolVariable {
    name: string
    input: boolean
    output: boolean
    /** KIELER's type name: bool, int, float, string, class, struct. */
    type: string
    /** Array dimensions (empty for scalars), for an input's value before the first tick. */
    dims: number[]
    /** Not in the pool before the first tick: a string without a value, a member declaration of a class or struct. */
    late: boolean
}

/** A completed run: a Simulation, or the ticks it returned. */
export type EngineRun = Simulation | readonly SimTickResult[]

type Compiled = Pick<CompileResult, 'sim' | 'chart' | 'interface' | 'index'>

/** KIELER's VARIABLE_ORDER: inputs (pure ones before in-outs), then outputs, then the rest; then by name. */
function kielerOrder(a: PoolVariable, b: PoolVariable): number {
    if (a.input && b.input) {
        if (a.output !== b.output) return a.output ? 1 : -1
    } else if (a.input !== b.input) {
        return a.input ? -1 : 1
    } else if (a.output !== b.output) {
        return a.output ? -1 : 1
    }
    // Java's String.compareTo compares UTF-16 code units, as `<` does.
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function typeName(type: string | undefined, hostType?: string): string {
    if (type === 'pure' || type === undefined) return 'bool'
    if (type === 'clock' || type === 'clock-time') return 'float'
    if (type === 'host') return hostType ?? 'host'
    return type
}

/** The member declarations KIELER lists for a class or struct type: `Type.member`, nested types by their path. */
function memberDeclarations(prefix: string, members: Declaration[], out: PoolVariable[]): void {
    const member = (name: string, type: string): PoolVariable => ({ name, input: false, output: false, type, dims: [], late: true })
    for (const m of members) {
        if (m.declKind === 'method' || m.const) continue
        if (m.declKind === 'class' || m.declKind === 'struct') {
            if (m.className) memberDeclarations(`${prefix}.${m.className}`, m.members ?? [], out)
            for (const vo of m.valuedObjects) out.push(member(`${prefix}.${vo.name}`, m.declKind))
        } else if (m.declKind === 'variable') {
            for (const vo of m.valuedObjects) out.push(member(`${prefix}.${vo.name}`, typeName(m.type, m.hostType)))
        }
    }
}

/**
 * The member declarations of the types KIELER makes as it compiles: a chart used as a class (`ref C x`) becomes the
 * class `C1`, and a type declared in an inner state moves to the root with a `1` added (`Point1`, `C11`). The members
 * have the names KIELER gives them (an inherited private field: `<Base>_<field>`), which the engine's are.
 */
function generatedMemberDeclarations(result: Compiled, out: PoolVariable[]): void {
    const compiled = result.sim!
    for (const scope of allScopes(compiled.core)) {
        for (const v of scope.decls as CVar[]) {
            if (!v.member || v.declKind || v.const || v.tags.has('#const-member')) continue
            const { of } = v.member
            const nested = scope !== compiled.core
            let type: string | undefined
            if (of.declKind === 'reference' && of.instance) type = `${of.instance.target}1`
            else if (nested && (of.declKind === 'class' || of.declKind === 'struct')) type = result.index?.vos.get(of.decl ?? '')?.decl?.className
            if (!type) continue
            out.push({ name: `${type}${nested ? '1' : ''}.${v.member.name}`, input: false, output: false, type: typeName(v.type, v.hostType), dims: [], late: true })
        }
    }
}

/**
 * KIELER's data pool for the chart, in KIELER's order (its `#interface`), without the compiler's helpers. The names
 * are the engine's pool's (exec.ts builds it from the same declarations). Empty when the chart did not compile.
 */
export function poolVariables(result: Compiled): PoolVariable[] {
    const compiled = result.sim
    if (!compiled) return []
    const declared = new Map(result.interface.map((v) => [v.name, v]))
    const out = new Map<string, PoolVariable>()
    const add = (entry: PoolVariable) => {
        if (!out.has(entry.name)) out.set(entry.name, entry)
    }
    const instance = (v: CVar) => ({
        name: v.name, input: false, output: false, type: v.declKind === 'struct' ? 'struct' : 'class', dims: [], late: false,
    })
    for (const v of compiled.core.decls as CVar[]) {
        if (v.member && !v.const && !v.declKind) {
            if (!v.tags.has('#const-member')) add(instance(v.member.of))
            continue
        }
        if (v.const || v.declKind || v.name.startsWith('_')) continue
        const info = declared.get(v.name) ?? (v.of ? declared.get(v.of.name) : undefined)
        const type = typeName(v.type, v.hostType)
        const dims = info?.dims ?? []
        // An unset string is null, which the pool leaves out; KIELER's reset() sets constant initial values.
        const late = type === 'string' && dims.length === 0 && info?.initialValue == null
        add({ name: v.name, input: v.input, output: v.output, type, dims, late })
    }
    const instances = (compiled.core.ext.emptyInstances as string[] | undefined) ?? []
    for (const name of instances) {
        const v = (compiled.core.decls as CVar[]).find((d) => d.name === name)
        add(v ? instance(v) : { name, input: false, output: false, type: 'class', dims: [], late: false })
    }
    const members: PoolVariable[] = []
    for (const d of result.chart?.declarations ?? []) {
        // @UnpackClass makes the members plain variables (`<instance>_<member>`), which are in the pool.
        const unpacked = d.annotations.some((a) => a.name === 'UnpackClass')
        if ((d.declKind === 'class' || d.declKind === 'struct') && !d.host && !unpacked && d.className) {
            memberDeclarations(d.className, d.members ?? [], members)
        }
    }
    generatedMemberDeclarations(result, members)
    members.forEach(add)
    return Array.from(out.values())
        .filter(({ name }) => !name.startsWith('_') && !name.startsWith('#') && !name.includes('_tickCounter'))
        .sort(kielerOrder)
}

const ROLES: TraceRole[] = ['input', 'output', 'local']

function roleOf(variable: PoolVariable): TraceRole {
    if (variable.input) return 'input'
    return variable.output ? 'output' : 'local'
}

/** The pool's variables in the order the extension lists them: present before tick 1 first, then by role. */
function extensionOrder(variables: PoolVariable[]): PoolVariable[] {
    const listed = [...variables.filter((v) => !v.late), ...variables.filter((v) => v.late)]
    return listed.sort((a, b) => ROLES.indexOf(roleOf(a)) - ROLES.indexOf(roleOf(b)))
}

/** The columns of a trace of the chart's runs, as the extension saves them: name, role and KIELER's type. */
export function traceColumns(result: Compiled): TraceVariable[] {
    return extensionOrder(poolVariables(result)).map((v) => ({ name: v.name, role: roleOf(v), type: v.type }))
}

/** A value as KIELER's pool holds it: the members of an instance in KIELER's order, by name. */
function kielerValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(kielerValue)
    if (!value || typeof value !== 'object') return value
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, member]) => [key, kielerValue(member)]))
}

function ticksOf(run: EngineRun): readonly SimTickResult[] {
    return 'history' in run ? run.history : run
}

/** The ticks a trace holds: up to the first runtime error, after which KIELER's simulation has stopped. */
function completedTicks(run: EngineRun): readonly SimTickResult[] {
    const ticks = ticksOf(run)
    const failed = ticks.findIndex((tick) => tick.error)
    return failed < 0 ? ticks : ticks.slice(0, failed)
}

export interface TraceOptions {
    /** The file name the trace names (the extension: the simulated model's file name). */
    model?: string
    /**
     * `pool` (the default, as the extension): an input's value after the tick, as KIELER's data pool has it. `read`:
     * the value the tick read (`ranWith`), which differs where the chart writes its input (basics.md B-10); a trace
     * replays such a run only with these.
     */
    inputs?: 'pool' | 'read'
}

/**
 * The run as the trace the extension saves for the same run on KIELER's server: every variable of KIELER's data pool
 * after each tick, inputs, outputs and the chart's own locals, and what the chart printed. A tick with a runtime
 * error ends the trace.
 */
export function traceFromRun(result: Compiled, run: EngineRun, options: TraceOptions = {}): TraceRecord {
    const variables = traceColumns(result)
    const ticks = completedTicks(run)
    const read = options.inputs === 'read'
    const last: Record<string, unknown> = {}
    const values = ticks.map((tick) => {
        const row: Record<string, unknown> = {}
        for (const { name, role } of variables) {
            const value = read && role === 'input' ? tick.ranWith?.[name] : tick.pool[name]
            if (value !== undefined && value !== null) last[name] = kielerValue(value)
            row[name] = last[name]
        }
        return row
    })
    const printed = printedOf(ticks.map((tick) => [...tick.printed]))
    return {
        ...(options.model ? { model: options.model } : {}),
        variables,
        ticks: values,
        ...(printed ? { printed } : {}),
    }
}

/** Compares runs of the engine, the first being the reference (convenience over compareTraces). */
export function compareRuns(runs: ({ label: string; result: Compiled; run: EngineRun } & TraceOptions)[]): TraceComparison {
    return compareTraces(runs.map(({ label, result, run, ...options }) => ({ label, trace: traceFromRun(result, run, options) })))
}

/** An input's value before the first tick, in the form the extension edits it (an unset string is ''). */
export function initialValue(variable: PoolVariable): Value {
    const scalar = (): Value => {
        if (variable.type === 'bool') return false
        if (variable.type === 'string') return ''
        return 0
    }
    const build = (dims: number[]): Value => (dims.length === 0 ? scalar() : Array.from({ length: dims[0] }, () => build(dims.slice(1))))
    return build(variable.dims)
}

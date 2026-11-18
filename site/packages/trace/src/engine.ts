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
import { allScopes, typeKey } from '@sccharts-lab/engine/internal'
import type { CVar, PoolObject } from '@sccharts-lab/engine/internal'
import type { Declaration, State, Value, ValuedObject } from '@sccharts-lab/engine/types'
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

const unpacked = (d: Declaration): boolean =>
    (d.declKind === 'class' || d.declKind === 'struct') && !d.host && d.annotations.some((a) => a.name === 'UnpackClass')

/** What `@UnpackClass` adds to the instance's name for a member: `_<member>`, or its `@UnpackRenaming`. */
const unpackedSuffix = (vo: ValuedObject, m: Declaration): string =>
    [...(vo.annotations ?? []), ...m.annotations].find((a) => a.name === 'UnpackRenaming')?.values[0] ?? `_${vo.name}`

/**
 * The member declarations KIELER lists for a class or struct type: `Type.member`, nested types by their path. An
 * unpacked class inside it (`@UnpackClass`) gives its members to the type around it (`O.inn_v`). Without a `prefix`
 * the members are the chart's own variables (the class was unpacked into the chart): only the types inside are listed,
 * by their own name (`In.v`).
 */
function memberDeclarations(prefix: string | undefined, members: Declaration[], out: PoolVariable[], name: (vo: ValuedObject, m: Declaration) => string = (vo) => vo.name, depth = 1): void {
    const member = (name: string, type: string): PoolVariable => ({ name, input: false, output: false, type, dims: [], late: true })
    for (const m of members) {
        // KIELER replaces a const member by its value two levels deep (counted with the classes unpacked); one
        // further in stays a member.
        if (m.declKind === 'method' || (m.const && depth <= 2)) continue
        if (m.declKind === 'class' || m.declKind === 'struct') {
            if (unpacked(m) && m.valuedObjects.length === 1) {
                const instance = m.valuedObjects[0]
                memberDeclarations(prefix, m.members ?? [], out, (vo, mm) => `${name(instance, m)}${unpackedSuffix(vo, mm)}`, depth)
                continue
            }
            if (m.className) memberDeclarations(prefix === undefined ? m.className : `${prefix}.${m.className}`, m.members ?? [], out, undefined, depth + 1)
            if (prefix !== undefined) for (const vo of m.valuedObjects) out.push(member(`${prefix}.${name(vo, m)}`, m.declKind))
        } else if (m.declKind === 'variable' && prefix !== undefined && !m.hostType) {
            for (const vo of m.valuedObjects) out.push(member(`${prefix}.${name(vo, m)}`, typeName(m.type, m.hostType)))
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
    /** The class of a chart instance: the name KIELER's Reference processor gave its declaration (`<Chart>1`). */
    const classOf = (c: CVar) => c.className ?? `${c.instance!.target}1`
    const local = (c: CVar) => c.declKind === 'class' || c.declKind === 'struct'
    // The engine names KIELER's classes as KIELER does (classNames.ts in its sim/structure): the class of a chart
    // instance, and the name a class of an inner state gets when KIELER moves it to the root (`C` is `C1`, a chart
    // instance's class `Two1` in an inner state `Two11`).
    const typeNames = (compiled.core.ext.typeNames as Map<string, string> | undefined) ?? new Map<string, string>()
    const scopes = allScopes(compiled.core)
    /** The type of the instance `root` with members in `scope`: its class's name, the unique one in an inner state. */
    const rootType = (root: CVar, scope: { uid: number }): string | undefined =>
        typeNames.get(typeKey(root, scope)) ?? (root.declKind === 'reference' && root.instance ? classOf(root) : undefined)
    for (const scope of scopes) {
        for (const v of scope.decls as CVar[]) {
            if (!v.member || v.const || v.tags.has('#const-member')) continue
            const nested = scope !== compiled.core
            // A member of a class or struct instance declared inside a chart used by `ref C c`, or inside a class of an
            // inner state: the type, the classes on the way, the member (`Counter1.O.P.v`, `C1.D.x`; the instances
            // themselves too, `Counter1.os`, `C1.d`). A chart instance inside the chart is such a class
            // (`Mid1.Two1.a`, and the instance `Mid1.t`).
            const chain: CVar[] = []
            for (let c: CVar | undefined = v; c; c = c.member?.of) chain.unshift(c)
            const root = chain[0]
            const reference = root.declKind === 'reference' && !!root.instance
            if (chain.length > 2 || (v.declKind && chain.length === 2)) {
                // (A class of the chart itself is listed from its declaration, memberDeclarations.)
                if (!(reference || (nested && local(root))) || (v.declKind && !local(v))) continue
                const top = rootType(root, scope)
                if (!top) continue
                const classes = chain.slice(1, -1).map((c) => (c.declKind === 'reference' && c.instance
                    ? classOf(c)
                    : result.index?.vos.get((c.decl ?? '').split('/').pop()!)?.decl?.className ?? c.member!.name))
                chain.slice(1, -1).forEach((c, i) => {
                    if (c.declKind !== 'reference') return
                    out.push({ name: [top, ...classes.slice(0, i), c.member!.name].join('.'), input: false, output: false, type: 'class', dims: [], late: true })
                })
                out.push({
                    name: [top, ...classes, v.member.name].join('.'), input: false, output: false,
                    type: v.declKind ?? typeName(v.type, v.hostType), dims: [], late: true,
                })
                continue
            }
            if (v.declKind || v.type === 'host') continue
            const { of } = v.member
            const type = (of.declKind === 'reference' && of.instance) || (nested && local(of)) ? rootType(of, scope) : undefined
            if (!type) continue
            // An OO dataflow instance's inherited inputs and outputs are still listed as such.
            out.push({ name: `${type}.${v.member.name}`, input: v.tags.has('#port-input'), output: v.tags.has('#port-output'), type: typeName(v.type, v.hostType), dims: [], late: true })
        }
    }
    // An instance inside a chart instance is a member of the outer one's class, with or without fields of its own
    // (`Mid1.c`): the pool's objects know the ones without.
    for (const o of (compiled.core.ext.poolObjects as PoolObject[] | undefined) ?? []) {
        if (o.path.length < 2) continue
        const chain: CVar[] = []
        for (let c: CVar | undefined = o.v; c; c = c.member?.of) chain.unshift(c)
        const root = chain[0]
        if (root.declKind !== 'reference' || !root.instance) continue
        const top = rootType(root, compiled.core)
        if (!top) continue
        const classes = chain.slice(1, -1).map((c) => (c.declKind === 'reference' && c.instance
            ? classOf(c)
            : result.index?.vos.get((c.decl ?? '').split('/').pop()!)?.decl?.className ?? c.member!.name))
        out.push({ name: [top, ...classes, o.v.member!.name].join('.'), input: false, output: false, type: o.v.declKind === 'struct' ? 'struct' : 'class', dims: [], late: true })
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
            // The pool has the outermost instance (`l` for `l.a.x`).
            let root = v.member.of
            while (root.member) root = root.member.of
            if (!v.tags.has('#const-member')) add(instance(root))
            continue
        }
        if (v.const || v.declKind || v.name.startsWith('_') || v.type === 'host') continue
        const info = declared.get(v.name) ?? (v.of ? declared.get(v.of.name) : undefined)
        const type = typeName(v.type, v.hostType)
        const dims = info?.dims ?? []
        // An unset string is null, which the pool leaves out; KIELER's reset() sets constant initial values.
        const late = type === 'string' && dims.length === 0 && info?.initialValue == null
        add({ name: v.name, input: v.input, output: v.output, type, dims, late })
    }
    // The class objects of the pool, with or without fields (the engine's structure/poolShape.ts).
    for (const o of (compiled.core.ext.poolObjects as PoolObject[] | undefined) ?? []) if (o.path.length === 1) add(instance(o.v))
    const members: PoolVariable[] = []
    // The chart's own types and those of the charts it extends (their declarations are the chart's).
    const charts: State[] = []
    const inherit = (chart: State | undefined) => {
        if (!chart || charts.includes(chart)) return
        charts.push(chart)
        for (const b of chart.baseStates ?? []) inherit(result.index?.charts.find((c) => c.name === b.target))
    }
    inherit(result.chart)
    for (const d of charts.flatMap((c) => c.declarations)) {
        // @UnpackClass makes the members plain variables (`<instance>_<member>`), which are in the pool.
        if ((d.declKind === 'class' || d.declKind === 'struct') && !d.host && d.className) {
            memberDeclarations(unpacked(d) ? undefined : d.className, d.members ?? [], members, undefined, unpacked(d) ? 0 : 1)
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

/**
 * A value as KIELER's pool holds it: the members of an instance in KIELER's order, by name. `ports`: the members
 * KIELER still takes for inputs (0) and outputs (1), which come first (VARIABLE_ORDER).
 */
function kielerValue(value: unknown, ports?: Map<string, number>): unknown {
    if (Array.isArray(value)) return value.map((element) => kielerValue(element, ports))
    if (!value || typeof value !== 'object') return value
    const rank = (key: string) => ports?.get(key) ?? 2
    const entries = Object.entries(value).sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, member]) => [key, kielerValue(member)]))
}

/**
 * The inherited inputs and outputs of the chart's OO dataflow instances (`ref C g` of a chart that extends another):
 * KIELER's pool lists them before the instance's other members.
 */
function instancePorts(result: Compiled): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>()
    for (const v of (result.sim?.core.decls ?? []) as CVar[]) {
        const port = v.tags.has('#port-input') ? 0 : v.tags.has('#port-output') ? 1 : undefined
        if (port === undefined || !v.member || v.member.of.member) continue
        const name = v.member.of.name
        if (!out.has(name)) out.set(name, new Map())
        out.get(name)!.set(v.member.name, port)
    }
    return out
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
    const ports = instancePorts(result)
    const ticks = completedTicks(run)
    const read = options.inputs === 'read'
    // Keyed by the chart's names, which may be any identifier (`constructor`): no inherited keys.
    const last: Record<string, unknown> = Object.create(null)
    const own = (o: object | undefined, k: string) => (o && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined)
    const values = ticks.map((tick) => {
        const row: Record<string, unknown> = {}
        for (const { name, role } of variables) {
            const value = read && role === 'input' ? own(tick.ranWith, name) : own(tick.pool, name)
            if (value !== undefined && value !== null) last[name] = kielerValue(value, ports.get(name))
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

// The simulation's watch: an expression over the chart's variables (`count > 3 && !done`, `pre(x) != x`,
// `val(level) / 2`, `Outer.count == 11`, `home.count`, `speed == Speed.HIGH`), evaluated for the tick shown, and
// "Run until" it holds. Pure (no DOM).
//
// It is evaluated by the guide's engine itself, so that it means what it would mean in the chart (C's integer
// division, bools as 0 and 1, int and float mixing, `pre`): the expression is put into a chart of its own, with the
// variables and signals it names as inputs, as a chart-level `immediate during` action writing one output, and that
// chart is run on the values of the tick (and of the ticks before it, as inputs, for `pre`). It reads what a tick
// reports: KIELER's data pool (inputs, outputs and top-level locals, by name) and the engine's trace of the other
// variables (`SimTickResult.trace`, by `traceableVariables`' key): the locals of inner states, written `State.name`
// (as the widgets' `show` names them) or by their name alone when no other variable has it, and the members of
// instances, `pt.x`. An enum value (`Speed.HIGH`) is its position, as KIELER's Enum processor makes it (structure.md
// S-57). A `pre` needs the ticks before, so `pre(x)` has no value in tick 1 here; and strings cannot be read (C
// compares them as pointers).

import { compile, createSimulation, parseExpression, traceableVariables, type CompileResult, type Simulation, type TraceableVariable } from '../../engine/index'
import type { Expression, Reference, Value, VariableInfo } from '../../engine/types'
import { qualifiedName } from '../sim/trace'

/** The value of the watch in a tick, or why it has none. */
export type WatchValue = { value: Value } | { none: string } | { error: string }

/** What the watch reads of a tick: KIELER's data pool and the engine's trace (a SimTickResult has both). */
export interface WatchTick {
    pool?: Record<string, Value>
    trace?: Record<string, Value>
}

export interface Watch {
    /** The expression as typed. */
    text: string
    /** The value after tick `n` (1-based) of a run (`ticks[0]`: tick 1). */
    at(ticks: WatchTick[], n: number): WatchValue
}

type T = 'bool' | 'int' | 'float'

/** KIELER's C code compares strings by where they are stored (basics.md B-26), which the data pool does not show. */
const STRINGS = 'The watch cannot read strings: in KIELER\'s C code, `==` on strings compares where they are stored, not their text.'

const code = (s: string) => `\`${s}\``

/** A name the watch reads: one of the data pool (by its name), or of the trace (under a name of the watch's own). */
type Read = { pool: VariableInfo } | { trace: TraceableVariable; as: string; type: T; dims: number[] }

/** `a.b.c` as its names, and its last part (which carries the indices); undefined when a part before it has indices. */
function chain(r: Reference): { names: string[]; last: Reference } | undefined {
    const names = [r.name]
    let last = r
    while (last.sub) {
        if (last.indices.length) return undefined
        last = last.sub
        names.push(last.name)
    }
    return { names, last }
}

/** The watch for `text` on a compiled chart, or why it cannot be one. */
export function compileWatch(text: string, result: Pick<CompileResult, 'interface' | 'chart'> & Partial<Pick<CompileResult, 'index'>>): Watch | { error: string } {
    const source = text.trim()
    if (!source) return { error: 'Type an expression.' }
    if (/[;\n]/.test(source)) return { error: 'One expression, without a semicolon.' }
    const parsed = parseExpression(source, { as: 'expression' })
    const syntax = parsed.diagnostics.find(d => d.severity === 'error')
    if (syntax || !parsed.expression) return { error: syntax?.message ?? 'This is not an expression.' }
    const chart = result.chart
    const pool = new Map(result.interface.map(v => [v.name, v]))
    // The variables outside the data pool, by the name the widgets' `show` gives them (`Outer.count`, `pt.x`).
    const inner = chart ? traceableVariables({ chart, interface: result.interface, index: result.index }).filter(v => !v.inPool) : []
    const byQualified = new Map(inner.map(v => [qualifiedName(v, chart), v]))
    // The chart's enums: `Speed.HIGH` is its position in `Speed`.
    const enums = new Map<string, string[]>()
    for (const d of chart?.declarations ?? []) {
        if (d.declKind === 'enum' && !d.hostType && d.valuedObjects[0]) enums.set(d.valuedObjects[0].name, (d.members?.[0]?.valuedObjects ?? []).map(v => v.name))
    }
    const reads = new Map<string, Read>()
    const taken = new Set<string>(pool.keys())
    /** Replacements in `source` ([start, end, text], never overlapping): trace names, enum values, `val(` of inner signals. */
    const edits: [number, number, string][] = []
    let problem: string | undefined
    const fail = (message: string, pres: number) => {
        problem ??= message
        return { type: 'int' as T, depth: pres }
    }

    /** A variable outside the data pool, as an input of the watch's chart (`w1_Outer_count`), or why it cannot be. */
    const traced = (v: TraceableVariable, written: string, valueOnly: boolean): Extract<Read, { trace: unknown }> | string => {
        const known = reads.get(`trace:${v.key}`)
        if (known && 'trace' in known) return known
        const type = v.simulationType ?? v.type
        if (type === 'string') return STRINGS
        if (type === 'host') return `${code(written)} has a host type, which the watch cannot read.`
        if (v.dims.some(d => d < 0)) return `${code(written)} is an array whose size the watch cannot work out.`
        // A local signal is traced by its presence, a valued one by its value.
        if (v.signal && v.valued && !valueOnly) return `The watch can read the value of ${code(written)}, a valued signal of an inner state, as ${code(`val(${written})`)}, but not its presence.`
        let as = `w${reads.size + 1}_${written.replace(/\W+/g, '_')}`
        while (taken.has(as)) as = `${as}_`
        taken.add(as)
        const t: T = (v.signal && !v.valued) || type === 'bool' ? 'bool' : type === 'float' || type === 'clock' || type === 'clock-time' ? 'float' : 'int'
        const read = { trace: v, as, type: t, dims: v.dims }
        reads.set(`trace:${v.key}`, read)
        return read
    }

    /** What a reference names: a variable of the data pool, one of the trace, or an enum value. `valueOnly`: inside
     *  `val(...)`. */
    const resolve = (e: Reference, pres: number, valueOnly: boolean): { type: T; depth: number } => {
        const parts = chain(e)
        if (!parts) return fail(`The watch cannot read ${code(source.slice(e.span.start, e.span.end))}: a member of an element of an array.`, pres)
        const { names, last } = parts
        const written = names.join('.')
        let depth = pres
        for (const i of last.indices) depth = Math.max(depth, walk(i, pres).depth)
        // A name of the data pool (it wins over a variable of an inner state with the same name, as in the trace).
        if (names.length === 1 && pool.has(e.name)) {
            const v = pool.get(e.name)!
            if (v.type === 'host') return fail(`${code(e.name)} has a host type, which the watch cannot read.`, pres)
            if (v.type === 'string') return fail(STRINGS, pres)
            reads.set(`pool:${v.name}`, { pool: v })
            if (v.dims.length && e.indices.length !== v.dims.length) return fail(`${code(e.name)} is an array: give an index, as in ${code(`${e.name}[0]`)}.`, pres)
            // A signal on its own is its presence.
            return { type: v.signal && !valueOnly ? 'bool' : simple(v), depth }
        }
        // An enum value: its position.
        const values = names.length === 2 ? enums.get(names[0]) : undefined
        if (values) {
            const i = values.indexOf(names[1])
            if (i < 0) return fail(`${code(names[0])} has no value ${code(names[1])}: its values are ${values.map(code).join(', ')}.`, pres)
            if (last.indices.length) return fail(`${code(written)} is a value of an enum, not an array.`, pres)
            edits.push([e.span.start, e.span.end, String(i)])
            return { type: 'int', depth: pres }
        }
        // A variable of an inner state (`Outer.count`, or `count` when no other variable has that name) or a
        // member of an instance (`pt.x`).
        let v = byQualified.get(written)
        if (!v && names.length === 1) {
            const named = inner.filter(x => x.name === e.name)
            if (named.length > 1) return fail(`Several inner states have a variable ${code(e.name)}: write ${named.map(x => code(qualifiedName(x, chart))).join(' or ')}.`, pres)
            v = named[0]
        }
        if (!v) {
            if (names.length > 1) return fail(`${code(written)} is not a member of an instance, a variable of a state (written as \`State.name\`) or a value of an enum.`, pres)
            return fail(`${code(e.name)} is not one of the chart's inputs, outputs or variables.`, pres)
        }
        const read = traced(v, written, valueOnly)
        if (typeof read === 'string') return fail(read, pres)
        if (read.dims.length && last.indices.length !== read.dims.length) return fail(`${code(written)} is an array: give an index, as in ${code(`${written}[0]`)}.`, pres)
        edits.push([e.span.start, last.span.start + last.name.length, read.as])
        return { type: read.type, depth }
    }

    // The names, their types (as the engine will type them) and how many ticks back `pre` reaches.
    const walk = (e: Expression, pres: number): { type: T; depth: number } => {
        switch (e.kind) {
            case 'bool': return { type: 'bool', depth: pres }
            case 'int': return { type: 'int', depth: pres }
            case 'float': return { type: 'float', depth: pres }
            case 'string': return fail(STRINGS, pres)
            case 'ref': return resolve(e, pres, false)
            case 'op': {
                if (e.op === '->' || e.op === 'fby' || e.op === 'sfby') return fail(`${code(e.op)} belongs to dataflow regions, not to a watch.`, pres)
                if (e.op === 'pre') return walk(e.args[0], pres + 1)
                if (e.op === 'val') {
                    const arg = e.args[0]
                    const parts = arg?.kind === 'ref' ? chain(arg) : undefined
                    if (arg?.kind !== 'ref' || !parts) return fail(`${code('val')} reads the value of a valued signal.`, pres)
                    const v = parts.names.length === 1 ? pool.get(arg.name) : undefined
                    if (v) {
                        if (!v.signal || !v.valued) return fail(`${code('val')} reads the value of a valued signal.`, pres)
                        return { type: simple(v), depth: resolve(arg, pres, true).depth }
                    }
                    // A valued signal of an inner state: the trace has its value, which stands for the whole call.
                    const name = parts.names.join('.')
                    const t = byQualified.get(name) ?? (parts.names.length === 1 ? inner.find(x => x.name === arg.name) : undefined)
                    if (t && (!t.signal || !t.valued)) return fail(`${code('val')} reads the value of a valued signal.`, pres)
                    const inside = resolve(arg, pres, true)
                    edits.push([e.span.start, arg.span.start, ''], [arg.span.end, e.span.end, ''])
                    return inside
                }
                const args = e.args.map(a => walk(a, pres))
                const depth = Math.max(pres, ...args.map(a => a.depth))
                if (['||', '&&', '!', '==', '!=', '<', '<=', '>', '>='].includes(e.op)) return { type: 'bool', depth }
                if (e.op === '?:') {
                    const [, a, b] = args
                    return { type: a?.type === 'float' || b?.type === 'float' ? 'float' : a?.type ?? 'int', depth }
                }
                // Bitwise operators on bools are shown as a bool; everything else is a number.
                if (['|', '^', '&'].includes(e.op) && args.every(a => a.type === 'bool')) return { type: 'bool', depth }
                return { type: args.some(a => a.type === 'float') ? 'float' : 'int', depth }
            }
            default:
                return fail('The watch can use the chart\'s variables and signals, enum values, numbers, and the operators of a trigger (with pre and val); not calls, random() or host code.', pres)
        }
    }
    const { type, depth } = walk(parsed.expression, 0)
    if (problem) return { error: problem }
    // The expression with the trace's variables under the watch's own names, and enum values as numbers.
    let expression = source
    for (const [start, end, by] of [...edits].sort((a, b) => b[0] - a[0])) expression = expression.slice(0, start) + by + expression.slice(end)
    // The watch's own chart: the names it reads as inputs, and the result.
    let out = 'watch'
    while (taken.has(out)) out = `${out}_`
    const lines = [...reads.values()].map(declaration)
    const watchChart = `scchart Watch {\n${lines.map(l => `  ${l}\n`).join('')}  output ${type} ${out}\n  immediate during do ${out} = (${expression})\n  initial state Watching\n}\n`
    const compiled = compile(watchChart)
    if (!compiled.ok) {
        const first = compiled.diagnostics.find(d => d.severity === 'error')
        return { error: first?.message ?? 'The guide\'s checker cannot evaluate this expression.' }
    }
    let sim: Simulation | undefined
    // Each input of the watch's chart, and where its value is in a tick.
    const feeds = [...reads.values()].flatMap((r): { key: string; from: (t: WatchTick) => Value | undefined }[] =>
        'pool' in r
            ? (r.pool.signal && r.pool.valued ? [r.pool.name, `${r.pool.name}_val`] : [r.pool.name]).map(key => ({ key, from: t => t.pool?.[key] }))
            : [{ key: r.as, from: t => t.trace?.[r.trace.key] }],
    )
    return {
        text: source,
        at(ticks, n) {
            if (n < 1 || n > ticks.length) return { none: 'Run a tick first.' }
            if (n <= depth) return { none: `${code('pre')} has a value from tick ${depth + 1} on.` }
            sim ??= createSimulation(compiled)
            sim.reset()
            let tick
            for (let k = n - depth; k <= n; k++) {
                const row: Record<string, Value> = {}
                for (const f of feeds) {
                    const value = f.from(ticks[k - 1])
                    // A struct or class instance is an object in the pool: its members are read one by one (`pt.x`).
                    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { error: `The watch cannot read ${code(f.key)} as a whole (a struct or class instance): name a member, as in ${code(`${f.key}.x`)}.` }
                    if (value !== undefined) row[f.key] = value
                }
                tick = sim.step(row)
                if (tick.error) return { error: tick.error.message }
            }
            return { value: tick!.values[out] ?? null }
        },
    }
}

/** The watch's own declaration of a name it reads: an input of the same type (a signal, a valued signal); a variable
 *  of the trace as a plain input of its value's type. */
function declaration(r: Read): string {
    if ('trace' in r) return `input ${r.type} ${r.as}${r.dims.map(d => `[${d}]`).join('')}`
    const v = r.pool
    const dims = v.dims.map(d => `[${d}]`).join('')
    if (v.signal) return v.valued ? `input signal ${simple(v)} ${v.name}${dims}` : `input signal ${v.name}${dims}`
    return `input ${simple(v)} ${v.name}${dims}`
}

/** The C type the engine gives a variable's value (a clock is a float, or an int with @IntegerClockType). */
function simple(v: VariableInfo): T {
    return v.type === 'bool' ? 'bool' : v.type === 'float' || v.type === 'clock' || v.type === 'clock-time' ? 'float' : 'int'
}

/** A truthy watch value (Run until): true, or a number other than 0. */
export function holds(v: WatchValue): boolean {
    return 'value' in v && (v.value === true || (typeof v.value === 'number' && v.value !== 0))
}

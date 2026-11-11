// Public API of the in-browser SCCharts engine (see docs-internal/ARCHITECTURE.md).
//
//   parse(source)            syntax only: the Program (with element ids, resolved transition targets and
//                            references, so a diagram can be drawn) and the syntax diagnostics. Never throws.
//   compile(source, options) parse + name resolution + KIELER's validation rules, then the simulator's compilation
//                            of the chart (KIELER's transformations, causality and instantaneous-loop analysis,
//                            code generation checks): `ok` is false exactly when KIELER rejects the chart.
//   createSimulation(result) runs a compiled chart tick by tick (sim/index.ts); describeTick(tick, program) says
//                            in plain English what happened in a tick.
//   parseExpression(source)  one expression or effect on its own, with KIELER's grammar (for the operators page:
//                            formatExpressionParenthesised in format.ts shows how KIELER grouped it).
//
// Diagnostics carry a beginner-friendly message and hint, a stable `code`, and (for linking and validation
// problems) KIELER's own wording in `kieler`.

import type { Declaration, Diagnostic, Effect, Expression, ForCopies, ParseResult, Program, Region, State, ValuedObject, ValueType, VariableInfo } from './types'
import { assignIds } from './parser/ids'
import { constantValue, extractInterface } from './parser/interface'
import { parseProgram, parseStandalone, type StandaloneMode } from './parser/parser'
import { resolveProgram, type ModelIndex } from './parser/resolve'
import { LineMap } from './parser/source'
import { validateProgram } from './parser/validate'
import { kielerSyntaxWording } from './parser/kielerWording'
import { compileChart, type CompiledChart } from './sim/compile'
import { rememberImports } from './sim/describe'

export type { ModelIndex, VOEntry } from './parser/resolve'
export { extractInterface, constantValue } from './parser/interface'
export { lex, KEYWORDS } from './parser/lexer'
export { referenceName, type StandaloneMode } from './parser/parser'
export { formatExpressionParenthesised, formatEffectParenthesised, type ParenthesiseOptions } from './format'
export { createSimulation, describeTick, elementName, SIMULATOR_CODES, type DescribeOptions, type PoolValue, type Simulation, type SimTickResult } from './sim/index'

export interface CompileOptions {
    /** Name of the scchart to simulate (default: the first one in the file, as KIELER simulates rootStates.head). */
    chart?: string
    /** Other files, by file name (e.g. "Beep.sctx"), for `import` and references to charts in other files. */
    files?: Record<string, string>
}

export interface CompileResult {
    /**
     * false if KIELER would reject the chart (errors in diagnostics). Reading `ok`, `diagnostics` or `sim` runs the
     * simulator's compilation once (lazily): until then only the front end (parse, resolve, validate) has run.
     */
    ok: boolean
    /** Available whenever parsing produced a model, even if !ok (for diagrams). */
    program?: Program
    /** The root state that is simulated. */
    chart?: State
    diagnostics: Diagnostic[]
    /**
     * Variables of the simulated chart (inputs, outputs and its top-level locals) as KIELER's simulation has them: the
     * inherited ones in front, `deltaT`/`sleepT` of timed charts at the end, clocks with the clock type (float or int).
     */
    interface: VariableInfo[]
    /** Resolved model: declarations by id, parent links, transition targets (for the simulator). */
    index?: ModelIndex
    /** The simulator's compiled chart (when the front end accepted it): KIELER's core chart, SCG and analysis, for tools. */
    sim?: CompiledChart
    /**
     * The for-regions of the simulated chart and the counter values KIELER copies each one for (structure.md S-21,
     * S-22), when it has any; read like `ok` (it runs the simulator's compilation). Each tick's `copies` says what each
     * copy did. A for-region of a referenced chart is listed under the id the expanded reference gives it.
     */
    forCopies?: ForCopies[]
}

interface Parsed {
    program: Program
    syntax: Diagnostic[]
    lines: LineMap
}

function parseOnly(source: string): Parsed {
    const lines = new LineMap(source)
    const { program, diagnostics } = parseProgram(source, lines)
    assignIds(program)
    return { program, syntax: diagnostics, lines }
}

/** Parses SCTX. Never throws. Diagnostics are syntax errors (and lexical warnings) only. */
export function parse(source: string): ParseResult {
    let parsed: Parsed
    try {
        parsed = parseOnly(source)
    } catch (error) {
        return { diagnostics: [internalError(error)] }
    }
    try {
        resolveProgram(parsed.program)
    } catch (error) {
        // The model is still useful without resolved names (no transition targets).
        return { program: parsed.program, diagnostics: sortDiagnostics([...parsed.syntax, internalError(error)]) }
    }
    return { program: parsed.program, diagnostics: sortDiagnostics(parsed.syntax) }
}

export interface ExpressionParseResult {
    /** The rule the text was read with: KIELER's `Expression` (a trigger, an initial value) or `Effect` (after `do`). */
    as: 'expression' | 'effect'
    /** Set when `as` is 'expression' and the text parsed. */
    expression?: Expression
    /** Set when `as` is 'effect' and the text parsed. */
    effect?: Effect
    /** Syntax errors (code 'parse', spans in the given text) and lexical warnings; empty when it parsed cleanly. */
    diagnostics: Diagnostic[]
}

/**
 * Parses one expression or effect on its own, exactly as KIELER's grammar reads it inside a chart (same rules,
 * same backtracking, same messages). `as: 'auto'` (default) reads it as an expression if it is one, otherwise as an
 * effect (`x = a + b`, `x++`, `S(3)` is a call when read as an expression). Names are not resolved. Never throws.
 */
export function parseExpression(source: string, options: { as?: StandaloneMode } = {}): ExpressionParseResult {
    try {
        const out = parseStandalone(source, options.as ?? 'auto')
        // KIELER's words for the syntax error, where they are known (parser/kielerWording.ts): what KIELER says when
        // the text is the trigger of a transition (`if <text> go to S`) or its effect (`do <text> go to S`). A
        // trigger that starts with a number is a count delay there, so such an expression gets none.
        const error = out.diagnostics.find(d => d.severity === 'error' && d.code === 'parse')
        if (error && error.kieler === undefined && !(out.as === 'expression' && /^\s*[0-9.]/.test(source))) {
            const words = kielerSyntaxWording(source, out.as)
            if (words) error.kieler = words
        }
        return { ...out, diagnostics: sortDiagnostics(out.diagnostics) }
    } catch (error) {
        return { as: options.as === 'effect' ? 'effect' : 'expression', diagnostics: [internalError(error)] }
    }
}

/** Parses, resolves and validates a chart the way KIELER's front end does. Never throws. */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
    try {
        const main = parseOnly(source)
        const others: Program[] = []
        for (const [name, text] of Object.entries(options.files ?? {})) {
            if (text === source && !name) continue
            const p = parseOnly(text).program
            resolveProgram(p)
            others.push(p)
        }
        const externalCharts = others.flatMap(p => p.charts)
        const { index, diagnostics: linking } = resolveProgram(main.program, { externalCharts })
        index.programs.push(...others)
        // describeTick names the elements of an imported chart's copies from them.
        rememberImports(main.program, others)
        const validation = validateProgram(main.program, index, source, { files: options.files })
        // After a syntax error the model is partial. KIELER still links it and reports the names it cannot resolve
        // (a misspelt state, a variable whose declaration did not parse); so does the engine (on the corpus's
        // syntax-broken files the same ones as KIELER, tests/corpus/corpus.test.ts). Validation problems of a
        // partial model are mostly consequences of the syntax error and of how the parser recovered from it ("no
        // initial state" when the initial state did not parse, "unreachable" when a transition into the state was
        // lost): on the corpus's 112 syntax-broken files the engine's validation agrees with KIELER's in 83, with
        // 7 of its 15 unreachable states and 1 of its 5 missing initial states also KIELER's. They wait until the
        // syntax is fixed; only a broken import, which does not depend on the rest of the file, is reported at once.
        const syntaxBroken = main.syntax.some(d => d.severity === 'error')
        const diagnostics = syntaxBroken ? [...main.syntax, ...linking, ...validation.filter(d => d.code === 'broken-import')] : [...main.syntax, ...linking, ...validation]
        let chart: State | undefined
        if (options.chart !== undefined) {
            chart = main.program.charts.find(c => c.name === options.chart)
            if (!chart) {
                diagnostics.push({
                    severity: 'error', code: 'unknown-chart', message: `There is no scchart called ${options.chart} in this file`,
                    hint: main.program.charts.length ? `The file contains ${main.program.charts.map(c => c.name).join(', ')}.` : undefined,
                })
            }
        } else {
            chart = main.program.charts[0]
        }
        if (!main.program.charts.length && !main.syntax.some(d => d.severity === 'error')) {
            diagnostics.push({
                severity: 'error', code: 'no-chart', message: 'There is no scchart to run',
                kieler: 'There is no SCChart to compile. Add a scchart declaration first.',
                hint: 'A file needs at least one chart: `scchart Name { initial state Start }`.',
            })
        }
        const front = sortDiagnostics(diagnostics)
        const result: CompileResult = {
            ok: !front.some(d => d.severity === 'error'),
            program: main.program,
            chart,
            diagnostics: front,
            interface: chart ? simulationInterface(chart, index) : [],
            index,
        }
        if (chart && result.ok) attachSimulator(result, chart, index, front)
        return result
    } catch (error) {
        // Keep whatever parse can still give (the diagram can be drawn even if validation failed).
        const fallback = parse(source)
        return { ok: false, program: fallback.program, diagnostics: [...fallback.diagnostics, internalError(error)], interface: [] }
    }
}

/** A variable a reader may want to trace in a simulation (`traceableVariables`). */
export interface TraceableVariable {
    /**
     * Where the value is in each tick: a name of KIELER's data pool (`SimTickResult.values` / `present`; `inPool`),
     * else a key of `SimTickResult.trace` (a local's declaration id `Chart.S$c`, a member `pt.x`).
     */
    key: string
    /** The name as the reader wrote it: `x`, `c`, `pt.x`, `deltaT`. */
    name: string
    /** inputs, outputs, the chart's own and inner locals, members of instances, and time (clocks, deltaT, sleepT). */
    group: 'input' | 'output' | 'local' | 'member' | 'time'
    /** The type as declared (a clock is `clock`; `simulationType` has KIELER's float or int). */
    type: ValueType
    /** KIELER's simulation type, when it differs from `type` (a clock of a timed chart: float, or int). */
    simulationType?: ValueType
    signal: boolean
    valued: boolean
    input: boolean
    output: boolean
    dims: number[]
    /** Where it is declared: the chart itself, or a state or region inside it. */
    scope: { kind: 'chart' | 'state' | 'region'; id: string; name: string }
    /** In KIELER's data pool by this name (the simulation's interface): traced by default. */
    inPool: boolean
    /** Added by KIELER (deltaT and sleepT of a timed chart). */
    added?: boolean
    /** Member of a class or struct instance of the chart: the instance and the member. */
    member?: { instance: string; member: string }
    /**
     * A local of a state inside a for-region: each copy has its own, with a key of its own (`<declaration id>|<region
     * id>=<value>`) and the copy in its name (`k (i = 2)`): the region, its counter and the counter's value.
     */
    copy?: { region: string; counter: string; value: number }
}

/**
 * Every variable of the simulated chart a reader may want to trace (the playground's variables picker), in
 * declaration order: the simulation interface (inputs, outputs, the chart's own locals, inherited ones, clocks,
 * KIELER's deltaT and sleepT), the members of the chart's class and struct instances, and the locals of the states
 * and regions inside the chart, each with its scope and declared type. Values: `values` (or `present`) for the
 * ones `inPool`, `trace[key]` for the others. Constants, methods and the inside of referenced charts are left out.
 */
export function traceableVariables(result: Pick<CompileResult, 'chart' | 'index' | 'interface'>): TraceableVariable[] {
    const chart = result.chart
    if (!chart) return []
    const index = result.index
    const out: TraceableVariable[] = []
    const chartScope = { kind: 'chart' as const, id: chart.id, name: chart.name }
    for (const v of result.interface) {
        if (v.const) continue
        const entry = index?.vos.get(v.id)
        const declared = entry?.decl?.type
        const added = !entry && (v.name === 'deltaT' || v.name === 'sleepT')
        const clock = declared === 'clock' || declared === 'clock-time'
        const owner = entry?.owner
        out.push({
            key: v.name, name: v.name,
            group: added || clock ? 'time' : v.input ? 'input' : v.output ? 'output' : 'local',
            type: clock ? declared! : v.type, ...(clock && v.type !== declared ? { simulationType: v.type } : {}),
            signal: v.signal, valued: v.valued, input: v.input, output: v.output, dims: v.dims,
            // Inherited declarations belong to a base chart.
            scope: owner && owner.kind === 'state' && owner !== chart ? { kind: 'chart', id: owner.id, name: owner.name } : chartScope,
            inPool: true, ...(added ? { added: true } : {}),
        })
    }
    const dims = (vo: ValuedObject) => vo.cardinalities.map(c => {
        const n = constantValue(c, index)
        return typeof n === 'number' ? n : -1
    })
    // Members of the chart's own instances (`struct Pt { int x } pt`): the pool has the object `pt`.
    for (const d of chart.declarations) {
        if ((d.declKind !== 'class' && d.declKind !== 'struct') || d.host) continue
        for (const inst of d.valuedObjects) {
            if (inst.cardinalities.length) continue
            for (const m of d.members ?? []) {
                if (m.declKind !== 'variable' || m.const) continue
                for (const mvo of m.valuedObjects) {
                    const type = m.type ?? 'pure'
                    out.push({
                        key: `${inst.name}.${mvo.name}`, name: `${inst.name}.${mvo.name}`, group: 'member', type,
                        signal: m.signal, valued: m.signal && type !== 'pure', input: false, output: false, dims: dims(mvo),
                        scope: chartScope, inPool: false, member: { instance: inst.name, member: mvo.name },
                    })
                }
            }
        }
    }
    // Locals of inner states and regions (not of referenced charts: their states are another chart's).
    type Copy = NonNullable<TraceableVariable['copy']>
    const visitScope = (decls: Declaration[], scope: TraceableVariable['scope'], copies: Copy[] = []) => {
        for (const d of decls) {
            if (d.declKind !== 'variable' || d.const || d.input || d.output) continue
            for (const vo of d.valuedObjects) {
                const type = d.type ?? 'pure'
                const base = {
                    group: type === 'clock' || type === 'clock-time' ? 'time' as const : 'local' as const, type,
                    signal: d.signal, valued: d.signal && type !== 'pure', input: false, output: false, dims: dims(vo),
                    scope, inPool: false,
                }
                if (!copies.length) out.push({ key: vo.id, name: vo.name, ...base })
                for (const c of copies) out.push({ key: `${vo.id}|${c.region}=${c.value}`, name: `${vo.name} (${c.counter} = ${c.value})`, ...base, copy: c })
            }
        }
    }
    const visitState = (st: State, copies: Copy[]) => {
        if (st !== chart) visitScope(st.declarations, { kind: 'state', id: st.id, name: st.name }, copies)
        if (st.reference) return
        for (const r of st.regions) {
            // A for-region's own declarations are shared by its copies (KIELER moves them out of the region); its
            // states' are each copy's (structure.md S-21).
            visitScope(r.declarations, { kind: 'region', id: r.id, name: r.name ?? `a region of ${st.name}` }, copies)
            const values = r.forLoop ? forValues(r.forLoop, index) : undefined
            const inner = values ? values.map(value => ({ region: r.id, counter: r.forLoop!.variable, value })) : copies
            for (const c of r.states) visitState(c, inner)
        }
    }
    visitState(chart, [])
    return out
}

/** The counter values of a for-region in KIELER's order of its copies (passes/forRegion.ts range; S-22). */
function forValues(loop: NonNullable<Region['forLoop']>, index: ModelIndex | undefined): number[] {
    let first = 0
    let last = -1
    const from = constantValue(loop.from, index)
    const to = loop.to ? constantValue(loop.to, index) : undefined
    if (typeof from === 'number' && typeof to === 'number') {
        first = from
        last = to
    } else if (!loop.to && loop.from.kind === 'ref') {
        const vo = loop.from.decl ? index?.vos.get(loop.from.decl)?.vo : undefined
        const size = vo?.cardinalities[0] ? constantValue(vo.cardinalities[0], index) : undefined
        if (typeof size === 'number') last = size - 1
    } else {
        return []
    }
    const out: number[] = []
    if (first <= last) for (let i = first; i <= last; i++) out.push(i)
    else for (let i = first; i >= last; i--) out.push(i)
    return out
}

/**
 * A chart that extends others has their public declarations in front of its own (KIELER's Inheritance processor,
 * passes/inheritance.ts); a name the chart declares itself is its own.
 */
function inheritedInterface(chart: State, index: ModelIndex): VariableInfo[] {
    if (!chart.baseStates?.length) return []
    const own = new Set(chart.declarations.flatMap(d => d.valuedObjects.map(v => v.name)))
    const out: VariableInfo[] = []
    const seen = new Set<State>([chart])
    const work = [...(index.baseStates.get(chart) ?? [])]
    while (work.length) {
        const base = work.shift()!
        if (seen.has(base)) continue
        seen.add(base)
        const priv = new Set(base.declarations.filter(d => d.access === 'private' || d.access === 'protected').flatMap(d => d.valuedObjects.map(v => v.id)))
        for (const v of extractInterface(base, index)) {
            if (priv.has(v.id) || own.has(v.name)) continue
            own.add(v.name)
            out.push(v)
        }
        work.push(...(index.baseStates.get(base) ?? []))
    }
    return out
}

/**
 * The interface KIELER's simulation has: the inherited declarations, the chart's own, and what the Timed Automata
 * processor adds. In a timed chart, clocks (and `clock-time` variables) are of the clock type, float or, with
 * @IntegerClockType, int: KIELER's data pool and its interface say so, not `clock`.
 */
function simulationInterface(chart: State, index: ModelIndex): VariableInfo[] {
    const timing = timingOf(chart, index)
    const own = [...inheritedInterface(chart, index), ...extractInterface(chart, index)]
    if (!timing.timed) return own
    const clockType = timing.integer ? 'int' : 'float'
    return [...own.map(v => (v.type === 'clock' || v.type === 'clock-time' ? { ...v, type: clockType } as VariableInfo : v)), ...timedInterface(chart, timing)]
}

interface Timing {
    /** The chart, a chart it references or a `period` uses clocks. */
    timed: boolean
    /** @IntegerClockType (or @IntegralClockType) anywhere. */
    integer: boolean
    /** @NoSleep anywhere. */
    noSleep: boolean
}

/** What KIELER's Timed Automata processor sees: clocks and periods, and its annotations, anywhere in the chart. */
function timingOf(chart: State, index: ModelIndex): Timing {
    let timed = false
    let integer = false
    let noSleep = false
    const seen = new Set<State>()
    const visitChart = (c: State) => {
        if (seen.has(c)) return
        seen.add(c)
        const visit = (value: unknown) => {
            if (Array.isArray(value)) { value.forEach(visit); return }
            if (!value || typeof value !== 'object') return
            const obj = value as Record<string, unknown>
            if (obj.kind === 'declaration' && obj.type === 'clock' && obj.declKind === 'variable') timed = true
            if (obj.kind === 'period') timed = true
            if (obj.kind === 'annotation' && typeof obj.name === 'string') {
                const n = obj.name.toLowerCase()
                if (n === 'integerclocktype' || n === 'integralclocktype') integer = true
                if (n === 'nosleep') noSleep = true
            }
            if (obj.kind === 'scopeCall') {
                const target = index.scopeTargets.get(obj as never) ?? index.charts.find(x => x.name === obj.target)
                if (target && !obj.super) visitChart(target)
            }
            if (obj.kind === 'declaration' && obj.declKind === 'reference') {
                const target = index.refTargets.get(obj as never)
                if (target && target.kind === 'state') visitChart(target)
            }
            for (const [k, v] of Object.entries(obj)) if (k !== 'span' && v && typeof v === 'object') visit(v)
        }
        visit(c)
    }
    visitChart(chart)
    return { timed, integer, noSleep }
}

/**
 * KIELER's Timed Automata processor gives a chart with clocks (its own, its referenced charts', or a `period`'s) an
 * input `deltaT` and an output `sleepT` of the clock type (structure.md S-35): the simulation shows them like the
 * chart's own interface. A chart that declares them keeps its declarations; @NoSleep drops sleepT.
 */
function timedInterface(chart: State, { timed, integer, noSleep }: Timing): VariableInfo[] {
    if (!timed) return []
    const own = new Set(chart.declarations.flatMap(d => d.valuedObjects.map(v => v.name.toLowerCase())))
    const type = integer ? 'int' : 'float'
    const info = (name: string, input: boolean): VariableInfo => ({
        name, id: `${chart.id}$${name}`, type, signal: false, valued: false, input, output: !input, const: false, dims: [], initialValue: 0,
    })
    const out: VariableInfo[] = []
    if (!own.has('deltat')) out.push(info('deltaT', true))
    if (!own.has('sleept') && !noSleep) out.push(info('sleepT', false))
    return out
}

/**
 * The simulator's compilation (KIELER's transformations and acceptance test) runs on first use of `ok`,
 * `diagnostics` or `sim`, so parsing for a diagram stays cheap. The values are computed once.
 */
function attachSimulator(result: CompileResult, chart: State, index: ModelIndex, front: Diagnostic[]) {
    let done: { ok: boolean; diagnostics: Diagnostic[]; sim?: CompiledChart; forCopies?: ForCopies[] } | undefined
    const get = () => {
        if (done) return done
        let sim: CompiledChart | undefined
        const all = [...front]
        try {
            sim = compileChart(chart, index)
            all.push(...sim.diagnostics)
        } catch (error) {
            all.push(internalError(error))
        }
        const sorted = sortDiagnostics(all)
        const copies = sim?.shared.forCopies as ForCopies[] | undefined
        const forCopies = copies?.length ? copies.map(c => ({ region: c.region, counter: c.counter, values: [...c.values], ...(c.name ? { name: c.name } : {}) })) : undefined
        done = { ok: !sorted.some(d => d.severity === 'error'), diagnostics: sorted, sim, forCopies }
        return done
    }
    Object.defineProperty(result, 'ok', { get: () => get().ok, set: v => { get().ok = v }, enumerable: true, configurable: true })
    Object.defineProperty(result, 'diagnostics', { get: () => get().diagnostics, set: v => { get().diagnostics = v }, enumerable: true, configurable: true })
    Object.defineProperty(result, 'sim', { get: () => get().sim, set: v => { get().sim = v }, enumerable: true, configurable: true })
    Object.defineProperty(result, 'forCopies', { get: () => get().forCopies, set: v => { get().forCopies = v }, enumerable: true, configurable: true })
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
    return list
        .map((d, i) => ({ d, i }))
        .sort((a, b) => (a.d.span?.start ?? Infinity) - (b.d.span?.start ?? Infinity) || a.i - b.i)
        .map(x => x.d)
}

function internalError(error: unknown): Diagnostic {
    return {
        severity: 'error', code: 'internal',
        message: `The engine failed on this input: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'This is a bug in the guide\'s engine, not in your chart. The official KIELER tools may still accept it.',
    }
}

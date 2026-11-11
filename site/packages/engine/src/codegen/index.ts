// generateC: C code for a chart, in the shape of KIELER's netlist-based C code generation ("Netlist-based Compilation
// (C)", de.cau.cs.kieler.sccharts.netlist, scg/processors/codegen/c): a header with the `TickData` struct and the
// prototypes of `reset`, `logic` and `tick`, and a C file with their definitions. The code is generated from the
// same scheduled graph the simulator runs (sim/exec.ts), so it computes what the simulator shows, tick by tick
// (tools/cgen checks that with gcc on every recorded scenario and on random charts).

import type { CompileResult } from '../index'
import type { Diagnostic, State } from '../types'
import { compileChart, type CompiledChart } from '../sim/compile'
import { ExecutableChart } from '../sim/exec'
import { elementName } from '../sim/describe'
import type { CVar } from '../sim/model'
import type { SNode } from '../sim/scg'
import { effect, type ExprEnv } from './expr'
import { Layout, readVars, referencedVars } from './layout'
import { generateLogic } from './logic'
import { bodyExprs, calledMethods, functionCode, signature } from './methods'
import { resetNodes } from './reset'
import type { CNaming, GenerateCOptions, GeneratedC } from './types'

export type { CNaming, CVariable, GenerateCOptions, GeneratedC } from './types'

const DEFAULT_NAMES: CNaming = { tick: 'tick', reset: 'reset', logic: 'logic', struct: 'TickData' }

/** The function and struct names: the option, else the chart's `#code.naming` pragma (KIELER's rules). */
function namingOf(result: CompileResult, chart: string, option: GenerateCOptions['naming']): CNaming {
    let choice = option
    if (choice === undefined) {
        const pragma = result.program?.pragmas.find(p => p.name === 'code.naming')
        const values = pragma?.values ?? []
        if (values.length === 4) choice = { tick: values[0], reset: values[1], logic: values[2], struct: values[3] }
        else if (values.length === 1 && (values[0] === 'prefix' || values[0] === 'suffix')) choice = values[0]
    }
    if (choice === 'prefix' || choice === 'suffix') {
        const name = chart.replace(/[\s-]/g, '_')
        const add = (n: string) => (choice === 'prefix' ? name + n : n + name)
        return { tick: add('tick'), reset: add('reset'), logic: add('logic'), struct: add('TickData') }
    }
    return { ...DEFAULT_NAMES, ...(typeof choice === 'object' ? choice : {}) }
}

function failure(chart: string, names: CNaming, diagnostics: Diagnostic[]): GeneratedC {
    return { ok: false, chart, files: {}, header: `${chart}.h`, source: `${chart}.c`, names, variables: [], diagnostics, hostCode: false }
}

/** The compiled chart to generate from: the simulator's, or, for host code, one compiled with host code on. */
function compiledFor(result: CompileResult, chart: State): { compiled?: CompiledChart; hostCode: boolean; problem?: Diagnostic } {
    const sim = result.sim
    if (sim?.runnable) return { compiled: sim, hostCode: false }
    const unsupported = sim?.diagnostics.find(d => d.code === 'unsupported')
    const again = compileChart(chart, result.index, { hostCode: true })
    const still = again.diagnostics.find(d => d.code === 'unsupported')
    const error = again.diagnostics.find(d => d.severity === 'error')
    if (still || error || !again.runnable) {
        const d = still ?? error ?? unsupported
        return { hostCode: true, problem: { severity: 'error', code: 'unsupported', message: `The C code generator cannot translate this chart: ${d?.message ?? 'it cannot be compiled'}`, span: d?.span, related: d?.related } }
    }
    return { compiled: again, hostCode: true }
}

export function generateC(result: CompileResult, options: GenerateCOptions = {}): GeneratedC {
    const chart = result.chart
    const chartName = chart?.name ?? 'Chart'
    const names = namingOf(result, chartName, options.naming)
    if (!chart) return failure(chartName, names, [{ severity: 'error', code: 'no-chart', message: 'There is no scchart to generate code for' }])
    if (!result.ok) return failure(chartName, names, result.diagnostics.filter(d => d.severity === 'error'))
    const { compiled, hostCode, problem } = compiledFor(result, chart)
    if (!compiled) return failure(chartName, names, problem ? [problem] : [])

    const diagnostics: Diagnostic[] = []
    const exe = new ExecutableChart(compiled, result.interface)
    const fileName = options.fileName ?? chartName
    const comments = options.comments !== false
    const taken = options.takenTransitions ? compiled.lowered.takenOrder.length : undefined

    // Methods the code calls stay C functions; the frames of inlined ones get a place in the struct.
    const nodeExprs = exe.nodes.flatMap(x => [...(x.src.expr ? [x.src.expr] : []), ...effectExprsOf(x.src)])
    const methods = calledMethods(nodeExprs)
    const extra = referencedVars(exe.nodes.map(x => x.src), methods.map(m => m.method!.body))
    const frames = new Set(methods.flatMap(m => [...m.method!.params, ...m.method!.locals]))
    // KIELER's Const processor removes constants: their initialisations have no code (a constant still read after
    // the folding keeps a member and its initialisation).
    const read = readVars(exe.nodes.map(x => x.src), methods.map(m => m.method!.body))
    const constInits = new Set<number>()
    exe.nodes.forEach((x, i) => {
        const f = x.src.effect
        if (f?.k === 'assign' && f.ref.v.const && !read.has(f.ref.v)) constInits.add(i)
    })
    const layout = new Layout(compiled, chartName, taken, extra.filter(v => !frames.has(v) && (!v.const || read.has(v))), v => (v.decl ? result.index?.vos.get(v.decl)?.decl : undefined))

    const includes = new Set<string>()
    const problems: string[] = []
    const functionNames = new Map<CVar, string>()
    const methodName = (v: CVar) => {
        let n = functionNames.get(v)
        if (!n) functionNames.set(v, (n = layout.unique(`${chartName}_${v.name.replace(/[^A-Za-z0-9_]/g, '_')}`)))
        return n
    }
    const externs = externCodes(result)
    const env: ExprEnv = {
        access: v => {
            const m = layout.member(v)
            if (m === undefined) problems.push(`the variable ${v.name}`)
            return `d->${m ?? v.name}`
        },
        method: methodName,
        externCode: (name, target) => (target?.decl && externs.get(target.decl)) || externs.get(name) || name,
        structArg: 'd',
        includes,
        fail: what => problems.push(what),
    }
    methods.forEach(methodName)

    const inReset = resetNodes(exe).filter(i => !constInits.has(i))
    const describe = (id: string | undefined) => {
        if (!id || !result.program) return undefined
        const named = elementName(id, result.program)
        return named ? `/* ${named.name.replace(/→/g, '->')}${named.within ? ` (${named.within})` : ''} */`.replace(/\*\/(?=.)/g, '* /') : undefined
    }
    const logic = generateLogic({
        exe, env, name: base => layout.unique(base), skip: new Set([...inReset, ...constInits]), takenTransitions: !!options.takenTransitions,
        comment: comments ? (n: SNode) => describe(n.transition?.origin ?? n.effect?.o.by) : undefined,
    })
    const resetBody = inReset.flatMap(i => {
        const f = exe.nodes[i].src.effect!
        if (f.k === 'mark') return options.takenTransitions ? Array.from({ length: taken ?? 0 }, (_, k) => `d->_taken_transitions[${k}] = 0;`) : []
        return effect(f, env)
    })
    const functions = methods.map(v => functionCode(v, { env, name: methodName, structName: names.struct }))
    if (problems.length) {
        diagnostics.push({ severity: 'error', code: 'internal', message: `The C code generator cannot translate ${[...new Set(problems)].join(', ')}` })
        return failure(chartName, names, diagnostics)
    }

    // The struct: the chart's variables, then the netlist's guards in KIELER's order.
    const byNumber = (a: string, b: string) => (Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0)) || a.localeCompare(b)
    const members = [...layout.lines, ...[...logic.guards].sort(byNumber).map(g => `char ${g};`), 'char _GO;', ...logic.conditions.map(c => `char ${c};`),
        'char _TERM;', ...logic.registers.map(r => `char ${r.register};`)]
    const reset = [
        'd->_GO = 1;', 'd->_TERM = 0;', ...resetBody,
        ...logic.persistent.map(c => `d->${c} = 0;`), ...logic.registers.map(r => `d->${r.register} = 0;`),
    ]
    const tick = [`${names.logic}(d);`, '', ...logic.registers.filter(r => r.guard).map(r => `d->${r.register} = d->${r.guard};`), 'd->_GO = 0;']

    const hostcode = (kinds: string[]) => (result.program?.pragmas ?? []).filter(p => kinds.includes(p.name.toLowerCase())).map(p => p.values[0] ?? '')
    const banner = '/*\n * Automatically generated C code by SCCharts Lab\n * (the shape of KIELER\'s netlist-based compilation)\n */\n\n'
    const guard = `${fileName}.h`.toUpperCase().replace(/\W/g, '_')
    const headerExtras = [...hostcode(['hostcode', 'hostcode-c-header']), ...(env.usesNull ? ['#ifndef NULL\n#define NULL 0\n#endif'] : [])]
    const header = [
        `#ifndef ${guard}\n#define ${guard}\n`, banner,
        headerExtras.length ? headerExtras.join('\n') + '\n\n' : '',
        layout.typedefs.length ? layout.typedefs.join('\n') + '\n' : '',
        'typedef struct {\n', members.map(m => `  ${m}\n`).join(''), `} ${names.struct};\n\n`,
        `void ${names.reset}(${names.struct}* d);\nvoid ${names.logic}(${names.struct}* d);\nvoid ${names.tick}(${names.struct}* d);\n`,
        `\n#endif /* !${guard} */\n`,
    ].join('')
    const cExtras = [...[...includes].sort().map(i => `#include ${i}`), ...hostcode(['hostcode', 'hostcode-c'])]
    const source = [
        banner,
        cExtras.length ? cExtras.join('\n') + '\n\n' : '',
        `#include "${fileName}.h"\n\n`,
        functions.length ? methods.map(v => signature(v, { env, name: methodName, structName: names.struct }) + ';\n').join('') + '\n' : '',
        functions.map(f => f.join('\n') + '\n\n').join(''),
        `void ${names.logic}(${names.struct}* d) {\n`, logic.lines.map(l => l + '\n').join(''), '}\n\n',
        `void ${names.reset}(${names.struct}* d) {\n`, reset.map(l => `  ${l}\n`).join(''), '}\n\n',
        `void ${names.tick}(${names.struct}* d) {\n`, tick.map(l => (l ? `  ${l}\n` : '\n')).join(''), '}\n',
    ].join('')
    return {
        ok: true, chart: chartName, header: `${fileName}.h`, source: `${fileName}.c`,
        files: { [`${fileName}.h`]: header, [`${fileName}.c`]: source },
        names, variables: layout.variables, diagnostics, hostCode,
        takenTransitions: options.takenTransitions ? compiled.lowered.takenOrder : undefined,
    }
}

function effectExprsOf(n: SNode) {
    const f = n.effect
    if (!f) return []
    if (f.k === 'assign') return f.expr ? [f.ref, f.expr] : [f.ref]
    if (f.k === 'print') return f.args
    if (f.k === 'call') return [f.call]
    return []
}

/** `extern "abs" abs`: the C code of every extern declaration (the `@C` one when there are several), by id and name. */
function externCodes(result: CompileResult): Map<string, string> {
    const out = new Map<string, string>()
    for (const [id, entry] of result.index?.vos ?? []) {
        const list = entry.decl?.externs
        if (!list?.length) continue
        const code = (list.find(e => e.annotations.some(a => a.name === 'C')) ?? list[0]).code
        out.set(id, code)
        if (!out.has(entry.vo.name)) out.set(entry.vo.name, code)
    }
    return out
}

export { bodyExprs }

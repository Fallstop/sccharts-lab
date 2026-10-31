// Build-time preparation of an example for a widget: compile it with the guide's engine, lay out and render
// its diagram (so pages ship finished SVG: no layout flash, no elkjs in the browser), and work out what to show
// about it: whether KIELER rejects it and why, KIELER's warnings, and whether the guide's engine can run it.
// Runs in Astro frontmatter only (Node), never in the browser.
//
// KIELER's verdict wins: a chart is "rejected" only when its oracle recording says KIELER rejects it (or, for a
// chart without a recording, when the engine does, or its scenario says "expect": "error"). A chart KIELER
// accepts that the engine cannot run is "cannotRun": its diagram is shown, its simulation is not.

import { compile, type CompileResult } from '~engine/index'
import { layoutChart, renderSvg } from '~diagram/index'
import type { DiagramLayout } from '~diagram/types'
import type { Diagnostic, State } from '~engine/types'
import { errorClasses, errorLines, lineMap, type LineMap } from '../sim/lines'
import type { Example, OracleRecording } from './examples'

/** A diagnostic as the widgets show it. */
export interface ShownDiagnostic {
    severity: 'error' | 'warning' | 'info'
    /** The guide's message for a beginner, or KIELER's own words when only KIELER reports it (`kielerOnly`). */
    message: string
    line?: number
    col?: number
    hint?: string
    /** KIELER's own wording, when it differs from `message`. */
    kieler?: string
    /** The engine's diagnostic code (`instantaneous-loop`, `kieler-divergence`, ...). */
    code?: string
    /** Only KIELER's recording has this message: `message` is KIELER's wording. */
    kielerOnly?: boolean
}

export type ReferencesView = 'collapsed' | 'expanded'

export interface PreparedChart {
    compiled: CompileResult
    /** The simulated chart's name (the first scchart, as KIELER). */
    name: string
    layout?: DiagramLayout
    map?: LineMap
    /** KIELER rejects the chart: its oracle recording says so (or, without a recording, the engine or the
     *  scenario's `"expect": "error"`). */
    rejected: boolean
    /** KIELER accepts the chart but the guide's engine cannot run it (a construct it does not support yet, host
     *  code, another compiler, or a divergence from KIELER): the diagram is shown, the simulation is not. The
     *  sentence to show (no final full stop). */
    cannotRun?: string
    /** The engine's hint for `cannotRun`. */
    cannotRunHint?: string
    /** Why KIELER rejects the chart (empty unless `rejected`): the errors that make it fail, each with KIELER's
     *  wording, then KIELER's own messages that the engine has no counterpart for. */
    errors: ShownDiagnostic[]
    /** KIELER's warnings (validation and compiler) and the guide's notes about KIELER's behaviour, for accepted
     *  and rejected charts alike. Shown unobtrusively. */
    warnings: ShownDiagnostic[]
    /** Shown prominently: official KIELER fails on a chart that SCCharts Lab and the guide compile
     *  (`kieler-divergence`), or KIELER's verdict changes from run to run (`kieler-nondeterministic`). Never
     *  repeats an entry of `errors`. */
    notices: ShownDiagnostic[]
    /** `errors` when rejected, else `warnings` (the shape before `errors`/`warnings` existed). */
    diagnostics: ShownDiagnostic[]
    errorLines: number[]
    errorIds: Record<string, string[]>
    /** The files the chart was compiled with (its imports); the islands compile with them too. */
    files: Record<string, string>
    /** How reference states are drawn. */
    references: ReferencesView
}

const layouts = new Map<string, Promise<DiagramLayout | undefined>>()

/** Compiler messages that are internal noise, never shown: EMF's "required feature" errors after a syntax
 *  error (they name temporary files), and the variable store's bookkeeping. */
const NOISE = [/^\d+:\d+ The required feature '/, /^The required feature '/, /is contained in the model but not in VariableStore/]
const noise = (m: string) => NOISE.some((r) => r.test(m))
const firstLine = (m: string) => m.split('\n')[0].trim()
/** Notes worth showing next to KIELER's warnings (other infos are about the diagram or the engine). */
const NOTE_CODES = new Set(['kieler-loop-warning', 'kieler-quirk', 'kieler-bug'])
const PROMINENT = new Set(['kieler-divergence', 'kieler-nondeterministic'])

function show(d: Diagnostic): ShownDiagnostic {
    return {
        severity: d.severity,
        message: d.message,
        line: d.span?.line,
        col: d.span?.col,
        hint: d.hint,
        kieler: d.kieler && d.kieler !== d.message ? d.kieler : undefined,
        code: d.code,
    }
}

type Recorded = NonNullable<OracleRecording['diagnostics']>[number]

/** Pairs the engine's diagnostics with KIELER's recorded ones (the same text, else the same line for a message
 *  without KIELER's wording), so each problem is listed once with both wordings. Returns the recorded ones left. */
function pair(shown: ShownDiagnostic[], engine: Diagnostic[], recorded: Recorded[]): Recorded[] {
    const left = [...recorded]
    shown.forEach((s, i) => {
        const d = engine[i]
        let at = d.kieler !== undefined ? left.findIndex((r) => r.message === d.kieler) : -1
        if (at < 0 && d.kieler === undefined) at = left.findIndex((r) => r.line !== undefined && r.line === d.span?.line)
        // The same message apart from details after its first line (KIELER lists a loop's states in hash order).
        if (at < 0 && d.kieler !== undefined) at = left.findIndex((r) => r.line === d.span?.line && firstLine(r.message) === firstLine(d.kieler!))
        if (at < 0) return
        const r = left.splice(at, 1)[0]
        if (r.message !== s.message) s.kieler = r.message
    })
    return left
}

const fromRecorded = (r: Recorded, severity: ShownDiagnostic['severity']): ShownDiagnostic => ({
    severity,
    message: r.message,
    line: r.line,
    col: r.column,
    kielerOnly: true,
})

function unique<T>(list: T[], key: (t: T) => string): T[] {
    const seen = new Set<string>()
    return list.filter((t) => {
        const k = key(t)
        if (seen.has(k)) return false
        seen.add(k)
        return true
    })
}

/** What KIELER rejects the chart for, KIELER's warnings and the prominent notices (see PreparedChart). */
export function explain(
    compiled: CompileResult,
    oracle: OracleRecording | undefined,
    rejected: boolean
): Pick<PreparedChart, 'errors' | 'warnings' | 'notices'> {
    const recorded = (oracle?.diagnostics ?? []).filter((d) => !noise(d.message))
    const recErrors = recorded.filter((d) => d.severity === 1)
    const recWarnings = recorded.filter((d) => d.severity === 2)
    const all = compiled.diagnostics

    // Errors: the engine's account first (each with KIELER's words), then KIELER's own messages.
    let errors: ShownDiagnostic[] = []
    if (rejected) {
        const engine = all.filter((d) => d.severity === 'error' && d.code !== 'unsupported')
        errors = engine.map(show)
        const left = pair(errors, engine, recErrors)
        errors.push(...left.map((r) => fromRecorded(r, 'error')))
        if (!errors.length) {
            // The engine accepts what KIELER rejects (for example gcc fails on host code): KIELER's compiler output.
            const syntax = new Set(recErrors.map((r) => r.message))
            const messages = (oracle?.errors ?? []).filter((m) => !noise(m) && !syntax.has(m.replace(/^\d+:\d+ /, '')))
            errors = unique(messages, (m) => m).map((m) => {
                const at = /^(\d+):(\d+) ([\s\S]*)$/.exec(m)
                return at
                    ? { severity: 'error' as const, message: at[3], line: Number(at[1]), col: Number(at[2]), kielerOnly: true }
                    : { severity: 'error' as const, message: m, kielerOnly: true }
            })
        }
        if (!errors.length) errors = [{ severity: 'error', message: 'KIELER rejects this chart.', kielerOnly: true }]
    }

    // Warnings: the engine's warnings and notes about KIELER (with KIELER's words), KIELER's validation warnings
    // the engine has no counterpart for, then the compiler's warnings.
    const engineWarnings = all.filter((d) => !PROMINENT.has(d.code ?? '') && (d.severity === 'warning' || (d.severity === 'info' && NOTE_CODES.has(d.code ?? ''))))
    const warnings = engineWarnings.map(show)
    const leftWarnings = pair(warnings, engineWarnings, recWarnings)
    warnings.push(...leftWarnings.map((r) => fromRecorded(r, 'warning')))
    // The compiler's warnings of a chart it then rejects are part of the same failure: not listed again.
    const explainsLoops = all.some((d) => d.code === 'kieler-loop-warning' || d.code === 'immediate-loop' || d.code === 'instantaneous-loop')
    for (const m of rejected ? [] : unique(oracle?.warnings ?? [], (w) => w)) {
        if (noise(m)) continue
        if (explainsLoops && /^Potential instantaneous loop/.test(m)) continue
        if (warnings.some((w) => w.kieler === m || w.message === m)) continue
        warnings.push({ severity: 'warning', message: m, kielerOnly: true })
    }

    // Prominent notices: what official KIELER does differently, and verdicts that change from run to run.
    const notices = all.filter((d) => PROMINENT.has(d.code ?? '') && !(rejected && d.severity === 'error')).map(show)
    return { errors, warnings, notices }
}

export interface PrepareInput extends Pick<Example, 'source' | 'oracle' | 'scenario' | 'id'> {
    files?: Record<string, string>
    /** Draw reference states collapsed (KIELER's initial view, default) or with the referenced chart inside. */
    references?: ReferencesView
}

/** The diagram's other charts: those of imported files, for references to them. */
function importedCharts(compiled: CompileResult): State[] {
    const programs = (compiled.index as { programs?: { charts?: State[] }[] } | undefined)?.programs ?? []
    return programs.filter((p) => p !== (compiled.program as unknown)).flatMap((p) => p.charts ?? [])
}

/** Compiles and lays out an example (the layout is cached per source and view for the whole build). */
export async function prepareChart(ex: PrepareInput): Promise<PreparedChart> {
    const files = ex.files ?? {}
    const compiled = compile(ex.source, { files })
    const chart = compiled.chart
    const references = ex.references ?? 'collapsed'
    let layout: DiagramLayout | undefined
    if (chart) {
        const key = [references, ex.source, ...Object.entries(files).flat()].join('\u0000')
        let pending = layouts.get(key)
        if (!pending) {
            pending = layoutChart(chart, { program: compiled.program, charts: importedCharts(compiled), references }).catch((error: unknown) => {
                console.warn(`[widgets] ${ex.id}: the diagram could not be laid out: ${error instanceof Error ? error.message : error}`)
                return undefined
            })
            layouts.set(key, pending)
        }
        layout = await pending
    }
    const map = chart ? lineMap(chart, ex.source) : undefined
    const oracle = ex.oracle
    const allErrors = compiled.diagnostics.filter((d) => d.severity === 'error')
    const unsupported = compiled.diagnostics.find((d) => d.code === 'unsupported')
    const engineRejects = !compiled.ok && !(allErrors.length > 0 && allErrors.every((d) => d.code === 'unsupported'))
    // KIELER's verdict wins: an example recorded as accepted is never shown as rejected.
    const rejected = oracle ? !oracle.ok : engineRejects || ex.scenario?.expect === 'error'
    let cannotRun: string | undefined
    let cannotRunHint: string | undefined
    if (!rejected && (!compiled.ok || unsupported || !chart)) {
        if (unsupported) {
            cannotRun = unsupported.message
            // The recording says what the engine's hint cannot know: KIELER accepts this chart.
            cannotRunHint = oracle?.ok && unsupported.hint ? `${unsupported.hint.replace(/ Try the chart in SCCharts Lab or KIELER\.$/, '')} KIELER accepts this chart: open it in KIELER or SCCharts Lab to run it.` : unsupported.hint
        } else if (ex.scenario?.system && ex.scenario.system !== 'netlist') {
            cannotRun = `This chart is meant for KIELER's ${ex.scenario.system}-based compiler, which the guide's simulator does not implement`
        } else {
            const nondeterministic = allErrors.find((d) => d.code === 'kieler-nondeterministic')
            cannotRun = nondeterministic ? nondeterministic.message : 'The guide\'s simulator cannot run this chart'
            cannotRunHint = nondeterministic?.hint
            if (!nondeterministic) console.warn(`[widgets] ${ex.id}: KIELER accepts this chart, but the guide's engine rejects it: ${allErrors.map((d) => d.message).join('; ')}`)
        }
    }
    const { errors, warnings, notices } = explain(compiled, oracle, rejected)
    let lines: number[] = []
    let ids: Record<string, string[]> = {}
    if (rejected) {
        const engineErrors = allErrors.filter((d) => d.code !== 'unsupported')
        lines = [...new Set([...errorLines(engineErrors), ...errors.filter((d) => d.kielerOnly && d.line).map((d) => d.line!)])].sort((a, b) => a - b)
        ids = errorClasses(engineErrors, map, chart?.id)
        for (const d of errors) {
            if (!d.kielerOnly || !d.line) continue
            const id = map?.owners[d.line]
            if (id && id !== chart?.id && !ids[id]) ids[id] = ['is-error']
        }
    }
    return {
        compiled,
        name: chart?.name ?? 'Chart',
        layout,
        map,
        rejected,
        cannotRun,
        cannotRunHint,
        errors,
        warnings,
        notices,
        diagnostics: rejected ? errors : warnings,
        errorLines: lines,
        errorIds: ids,
        files,
        references,
    }
}

let svgCounter = 0

/** The diagram as SVG markup, with initial highlight classes. Each call gets its own id prefix. */
export function diagramSvg(p: PreparedChart, classes: Record<string, string[]> = {}, title?: string): string | undefined {
    if (!p.layout) return undefined
    svgCounter += 1
    return renderSvg(p.layout, {
        idPrefix: `scd${svgCounter.toString(36)}`,
        fit: 'natural',
        minScale: 0.6,
        classes,
        title: title ?? `Diagram of ${p.name}`,
    })
}

/** Ids of the elements drawn inside expanded reference states (`<reference state id>/<id>`). */
function innerIds(p: PreparedChart): string[] {
    const out = new Set<string>()
    const visit = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        const n = node as Record<string, unknown>
        if (typeof n.id === 'string' && n.id.includes('/') && typeof n.kind === 'string') out.add(n.id)
        for (const v of Object.values(n)) if (Array.isArray(v) || (v && typeof v === 'object' && 'kind' in (v as object))) visit(v)
    }
    visit(p.layout?.root)
    return [...out]
}

/**
 * Element ids from what a writer typed: full ids (`Toggle.On`, `Toggle.Off->1`), ids without the chart's name
 * (`On`, `Off->1`), or a state's plain name when only one state has it. Throws a build error naming the
 * valid choices otherwise. With `references="expanded"`, the elements drawn inside a reference state are
 * `<reference state id>/<id in the referenced chart>` (`Main.Left/Switch.On`, or without the chart's name
 * `Left/Switch.On`).
 */
export function resolveIds(p: PreparedChart, names: string[], usedBy: string): string[] {
    const chart = p.compiled.chart
    if (!chart || !p.map) return []
    const known = new Set([...Object.keys(p.map.spans), ...innerIds(p)])
    const states = new Map<string, string[]>()
    const walk = (s: NonNullable<typeof chart>) => {
        for (const r of s.regions) for (const c of r.states) {
            states.set(c.name, [...(states.get(c.name) ?? []), c.id])
            walk(c)
        }
    }
    walk(chart)
    return names.map((n) => {
        if (known.has(n)) return n
        const prefixed = `${chart.id}.${n}`
        if (known.has(prefixed)) return prefixed
        const byName = states.get(n)
        if (byName?.length === 1) return byName[0]
        const choices = [...known].filter((id) => !id.includes('$') && !id.includes('!')).join(', ')
        throw new Error(`${usedBy}: highlight "${n}" is not ${byName ? 'unique' : 'a state or transition'} of ${chart.name}. Use one of: ${choices}.`)
    })
}

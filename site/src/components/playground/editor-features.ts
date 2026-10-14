// What the editor knows about the chart: diagnostics as CodeMirror lint entries, completion (keywords, the
// names in scope, the states a transition can go to, snippets) and hover cards (a name's declaration, a state,
// a keyword). They read the last compile result through `AnalysisView`, which also maps offsets between the
// current text and the text that was compiled (the result can be a few keystrokes old).

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { Diagnostic as LintDiagnostic } from '@codemirror/lint'
import type { EditorView, Tooltip } from '@codemirror/view'
import type { CompileResult } from '../../engine/index'
import { createFormatContext, declarationSegments, type TextSegment } from '../../engine/format'
import type { Declaration, Diagnostic, State, ValuedObject } from '../../engine/types'
import { hitAt, namesInScope, ownerName, parentOf, targetRegionAt } from './analysis'
import { keywordDoc } from './keyword-docs'
import { errorLink, whoSays } from '../frame/error-links'
import { WORD_KEYWORDS } from './sctx-tokens'

export interface AnalysisView {
    result: CompileResult
    /** A position in the current text as a position in the compiled text; null if the text there is new. */
    toSource(pos: number, exact?: boolean): number | null
    /** A position in the compiled text as a position in the current text. */
    fromSource(pos: number): number
    /** 1-based line of a compiled-text offset, in the current text. */
    lineOf(pos: number): number
}

// ----- small DOM helpers -------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
}

/** Text with `code` spans. */
export function richText(parent: HTMLElement, text: string): HTMLElement {
    text.split(/(`[^`]+`)/).forEach(part => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(el('code', undefined, part.slice(1, -1)))
        else if (part) parent.append(document.createTextNode(part))
    })
    return parent
}

function segmentsDom(segments: TextSegment[]): HTMLElement {
    const code = el('code', 'sc-pg-decl')
    for (const s of segments) {
        if (s.format === 'keyword') code.append(el('span', 'sc-tok-kw', s.text))
        else code.append(document.createTextNode(s.text))
    }
    return code
}

// ----- Diagnostics -------------------------------------------------------------------------------------------------

/** A diagnostic for a tooltip or the problems list: the message, the hint, and KIELER's own wording. A problem only
 *  KIELER's recording has (`kielerOnly`, src/components/playground/recorded.ts) is KIELER's wording alone.
 *  `link`: end with "About this message" (a tooltip; the problems list puts the link beside its button). */
export function renderDiagnostic(d: Diagnostic & { kielerOnly?: boolean; recorded?: boolean }, options: { link?: boolean } = {}): HTMLElement {
    const box = el('div', 'sc-pg-diag')
    if (d.kielerOnly) {
        const k = el('p', 'sc-pg-diag__msg sc-pg-diag__kieler-only')
        const who = whoSays(d.message)
        k.append(el('span', 'sc-pg-diag__label', `${who} `), el('q', undefined, d.message))
        box.append(k, el('p', 'sc-pg-diag__hint', who === 'KIELER says' ? "KIELER reports this; the guide's own checker does not." : "SCCharts Lab passes on the C compiler's warning; the guide's own checker does not give it."))
    } else {
        box.append(richText(el('p', 'sc-pg-diag__msg'), d.message))
        if (d.hint) box.append(richText(el('p', 'sc-pg-diag__hint'), d.hint))
        if (d.kieler && d.kieler.trim() !== d.message.trim()) {
            const k = el('p', 'sc-pg-diag__kieler')
            // KIELER's words from its recording of this very chart, or the words KIELER uses for this problem.
            k.append(el('span', 'sc-pg-diag__label', d.recorded ? 'KIELER says ' : "KIELER's wording: "), el('q', undefined, d.kieler))
            box.append(k)
        }
    }
    const about = options.link ? problemLink(d) : undefined
    if (about) {
        const p = el('p', 'sc-pg-diag__about')
        p.append(about)
        box.append(p)
    }
    return box
}

/** A link from a problem to the section of the guide's error reference (/reference/errors/) about it, if it has
 *  one: by the engine's code, else by KIELER's words (a problem only KIELER reports is KIELER's words). */
export function problemLink(d: Diagnostic & { kielerOnly?: boolean }): HTMLAnchorElement | undefined {
    const href = d.kielerOnly ? errorLink({ message: d.message, kieler: d.message }) : errorLink(d)
    if (!href) return undefined
    // In a new tab: the playground keeps the reader's run.
    const a = el('a', 'sc-pg-about', 'About this message')
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    a.append(el('span', 'sc-visually-hidden', ' (opens in a new tab)'))
    return a
}

/** The replacement a diagnostic suggests (`suggestion`, or "Unknown name 'C' (did you mean 'A'?)"), if any. */
export function suggestionOf(d: Pick<Diagnostic, 'message' | 'suggestion'>): string | undefined {
    return d.suggestion ?? d.message.match(/\(did you mean '([^']+)'\?\)/)?.[1]
}

/** Applies a suggestion to the range of a diagnostic, if the range is still one word. */
export function applySuggestion(view: EditorView, from: number, to: number, word: string): boolean {
    const text = view.state.sliceDoc(from, to)
    if (!/^\^?[A-Za-z_]\w*$/.test(text)) return false
    view.dispatch({ changes: { from, to, insert: word }, selection: { anchor: from + word.length }, userEvent: 'input.fix' })
    return true
}

/** The engine's diagnostics as CodeMirror lint diagnostics, in the current text. */
export function toLintDiagnostics(list: Diagnostic[], view: Pick<AnalysisView, 'fromSource'>, docLength: number): LintDiagnostic[] {
    return list.map(d => {
        let from = d.span ? view.fromSource(d.span.start) : 0
        let to = d.span ? view.fromSource(d.span.end) : 0
        from = Math.max(0, Math.min(from, docLength))
        to = Math.max(from, Math.min(to, docLength))
        if (to === from && docLength > 0) {
            if (from >= docLength) from = Math.max(0, docLength - 1)
            to = from + 1
        }
        const word = suggestionOf(d)
        return {
            from,
            to,
            severity: d.severity === 'info' ? 'info' : d.severity,
            message: d.message,
            renderMessage: () => renderDiagnostic(d, { link: true }),
            actions: word ? [{ name: `Change to ${word}`, apply: (view: EditorView, f: number, t: number) => void applySuggestion(view, f, t, word) }] : undefined,
        }
    })
}

// ----- Completion --------------------------------------------------------------------------------------------------

/** Keywords offered by completion: the grammar's words without the ones only experts write. */
const COMPLETION_KEYWORDS = [...WORD_KEYWORDS].filter(
    k => !['annotated', 'json', 'expression', 'module', 'scope', 'seq', 'Pr', 'commuting', 'conflicting', 'schedule', 'policy', 'ode', 'nondeterministic', 'primitive', 'class', 'struct', 'enum', 'method', 'void', 'return', 'public', 'private', 'protected', 'override', 'extends', 'goto', 'while', 'undefined', 'auto', 'null', 'this', 'randomize', 'random', 'clock', 'period', 'host', 'extern', 'calls', 'ref', 'once', 'fby', 'sfby', 'violation', 'global', 'none'].includes(k),
)

function declarationDetail(decl: Declaration): string {
    const parts: string[] = []
    if (decl.input) parts.push('input')
    if (decl.output) parts.push('output')
    if (decl.const) parts.push('const')
    if (decl.static) parts.push('static')
    if (decl.signal) parts.push('signal')
    if (decl.type && decl.type !== 'pure') parts.push(decl.type === 'host' ? (decl.hostType ?? 'host') : decl.type)
    if (!decl.input && !decl.output && !decl.const) parts.unshift('local')
    if (decl.declKind === 'reference') parts.push('ref ' + (decl.referenceTarget ?? ''))
    return parts.join(' ')
}

function singleDeclaration(decl: Declaration, vo: ValuedObject): Declaration {
    return { ...decl, valuedObjects: [vo] }
}

function stateCompletion(s: State): Completion {
    const mods = [s.initial && 'initial', s.final && 'final', s.connector && 'connector'].filter(Boolean).join(' ')
    return { label: s.name, type: 'state', detail: mods ? `${mods} state` : 'state', boost: 2 }
}

const SNIPPETS: Completion[] = [
    snippetCompletion('scchart ${Name} {\n\tinput bool ${a}\n\toutput bool ${b} = false\n\n\tinitial state ${A}\n}', { label: 'scchart', detail: 'new chart', type: 'snippet' }),
    snippetCompletion('initial state ${A}', { label: 'initial state', type: 'snippet' }),
    snippetCompletion('final state ${Done}', { label: 'final state', type: 'snippet' }),
    snippetCompletion('state ${S} {\n\tinitial state ${A}\n}', { label: 'state { }', detail: 'superstate', type: 'snippet' }),
    snippetCompletion('if ${trigger} go to ${Target}', { label: 'if … go to', detail: 'transition', type: 'snippet' }),
    snippetCompletion('if ${trigger} do ${effect} go to ${Target}', { label: 'if … do … go to', detail: 'transition', type: 'snippet' }),
    snippetCompletion('immediate go to ${Target}', { label: 'immediate go to', detail: 'transition', type: 'snippet' }),
    snippetCompletion('if ${trigger} abort to ${Target}', { label: 'if … abort to', detail: 'strong abort', type: 'snippet' }),
    snippetCompletion('join to ${Target}', { label: 'join to', detail: 'termination', type: 'snippet' }),
    snippetCompletion('region ${R}:\n\tinitial state ${A}', { label: 'region', detail: 'concurrent region', type: 'snippet' }),
    snippetCompletion('entry do ${effect}', { label: 'entry do', detail: 'action', type: 'snippet' }),
    snippetCompletion('during do ${effect}', { label: 'during do', detail: 'action', type: 'snippet' }),
    snippetCompletion('immediate during do ${effect}', { label: 'immediate during do', detail: 'action', type: 'snippet' }),
    snippetCompletion('exit do ${effect}', { label: 'exit do', detail: 'action', type: 'snippet' }),
    snippetCompletion('input bool ${name}', { label: 'input bool', detail: 'declaration', type: 'snippet' }),
    snippetCompletion('output bool ${name} = false', { label: 'output bool', detail: 'declaration', type: 'snippet' }),
    snippetCompletion('input signal ${name}', { label: 'input signal', detail: 'declaration', type: 'snippet' }),
    snippetCompletion('output signal ${name}', { label: 'output signal', detail: 'declaration', type: 'snippet' }),
    snippetCompletion('int ${name} = 0', { label: 'int', detail: 'declaration', type: 'snippet' }),
]

const IDENT = /\^?[A-Za-z_][\w]*$/

/** A completion or hover source that never throws (a bug here must not break typing). */
function guarded<A extends unknown[], R>(f: (...args: A) => R | null): (...args: A) => R | null {
    return (...args: A) => {
        try {
            return f(...args)
        } catch {
            return null
        }
    }
}

export function completionSource(getAnalysis: () => AnalysisView | undefined) {
    return guarded((context: CompletionContext): CompletionResult | null => {
        const node = syntaxTree(context.state).resolveInner(context.pos, -1)
        if (/comment|string|Comment/i.test(node.name)) return null
        const word = context.matchBefore(IDENT)
        if (!word && !context.explicit) {
            // After `go to ` (with the space typed) offer the targets at once.
            const before = context.state.sliceDoc(Math.max(0, context.pos - 16), context.pos)
            if (!/\b(?:go|abort|join)\s+to\s+$/.test(before)) return null
        }
        const from = word ? word.from : context.pos
        const line = context.state.doc.lineAt(context.pos)
        const before = context.state.sliceDoc(line.from, from)
        const analysis = getAnalysis()
        const program = analysis?.result.program
        const at = analysis ? analysis.toSource(from) : null

        // Transition targets: the states of the region the transition is written in.
        if (/\b(?:go|abort|join)\s+to\s+$/.test(before)) {
            if (!program || at === null) return null
            const region = targetRegionAt(program, at)
            const states = region ? region.states : program.charts.flatMap(c => c.regions.flatMap(r => r.states))
            return { from, options: states.filter(s => s.name).map(stateCompletion), validFor: IDENT }
        }
        // `is` / `ref`: other charts.
        if (/\b(?:is|calls|ref)\s+$/.test(before) && program) {
            return { from, options: program.charts.map(c => ({ label: c.name, type: 'class', detail: 'scchart' })), validFor: IDENT }
        }

        const options: Completion[] = []
        const atLineStart = /^\s*$/.test(before)
        if (program && at !== null) {
            const ctx = createFormatContext(program)
            for (const { vo, decl, owner } of namesInScope(program, at)) {
                if (!vo.name) continue
                options.push({
                    label: vo.name,
                    type: decl.signal ? 'signal' : decl.const ? 'constant' : 'variable',
                    detail: declarationDetail(decl),
                    boost: atLineStart ? 0 : 3,
                    info: () => {
                        const box = el('div', 'sc-pg-info')
                        box.append(segmentsDom(declarationSegments(singleDeclaration(decl, vo), ctx)))
                        box.append(el('p', 'sc-pg-info__where', `Declared in ${ownerName(owner)}`))
                        if (decl.doc) box.append(el('p', 'sc-pg-info__doc', decl.doc))
                        return box
                    },
                })
            }
        }
        for (const k of COMPLETION_KEYWORDS) options.push({ label: k, type: 'keyword', boost: -1 })
        if (atLineStart) options.push(...SNIPPETS)
        else options.push(...['pre', 'val'].map(f => snippetCompletion(`${f}(\${x})`, { label: `${f}( )`, detail: f === 'pre' ? 'previous tick' : 'signal value', type: 'function' })))
        return { from, options, validFor: IDENT }
    })
}

// ----- Go to the declaration -----------------------------------------------------------------------------------

/** Where the name at `pos` is declared (a variable's or signal's declaration, a target state's name), in the current
 *  text; null if `pos` is not on such a name or already on its declaration. */
export function definitionAt(analysis: AnalysisView | undefined, pos: number): { from: number; to: number } | null {
    const result = analysis?.result
    if (!analysis || !result?.program) return null
    const at = analysis.toSource(pos, true)
    if (at === null) return null
    const hit = hitAt(result, at)
    if (!hit || hit.kind === 'chart' || hit.isDeclaration) return null
    const span = hit.kind === 'variable' ? (hit.entry.vo.nameSpan ?? hit.entry.vo.span) : hit.state.nameSpan
    if (!span) return null
    return { from: analysis.fromSource(span.start), to: analysis.fromSource(span.end) }
}

// ----- Hover -------------------------------------------------------------------------------------------------------

export function hoverSource(getAnalysis: () => AnalysisView | undefined, values?: () => Record<string, unknown> | undefined) {
    return guarded((view: EditorView, pos: number, side: -1 | 1): Tooltip | null => {
        const line = view.state.doc.lineAt(pos)
        const text = line.text
        let start = pos - line.from
        let end = start
        while (start > 0 && /[\w^]/.test(text[start - 1])) start--
        while (end < text.length && /\w/.test(text[end])) end++
        if (start === end) return null
        if ((start === pos - line.from && side < 0) || (end === pos - line.from && side > 0)) return null
        const word = text.slice(start, end)
        const node = syntaxTree(view.state).resolveInner(line.from + start + 1, 1)
        if (/comment|string|Comment/i.test(node.name)) return null

        const tooltip = (create: () => HTMLElement): Tooltip => ({
            pos: line.from + start,
            end: line.from + end,
            above: true,
            create: () => ({ dom: create() }),
        })

        if (WORD_KEYWORDS.has(word) || word === 'deep') {
            const doc = keywordDoc(word, text.slice(0, start), text.slice(end))
            if (!doc) return null
            return tooltip(() => {
                const box = el('div', 'sc-pg-info')
                box.append(el('code', 'sc-pg-decl', doc.syntax))
                box.append(richText(el('p', 'sc-pg-info__doc'), doc.text))
                return box
            })
        }

        const analysis = getAnalysis()
        const result = analysis?.result
        if (!analysis || !result?.program) return null
        const at = analysis.toSource(line.from + start, true)
        if (at === null) return null
        const hit = hitAt(result, at + 1)
        if (!hit) return null
        const ctx = createFormatContext(result.program)

        if (hit.kind === 'variable') {
            const { vo, decl, owner } = hit.entry
            return tooltip(() => {
                const box = el('div', 'sc-pg-info')
                if (decl) box.append(segmentsDom(declarationSegments(singleDeclaration(decl, vo), ctx)))
                else box.append(el('code', 'sc-pg-decl', vo.name))
                const where = el('p', 'sc-pg-info__where')
                where.textContent = hit.isDeclaration
                    ? `Declared here, in ${ownerName(owner)}.`
                    : `Declared in ${ownerName(owner)}, line ${analysis.lineOf(vo.span.start)}.`
                box.append(where)
                if (decl?.doc) box.append(el('p', 'sc-pg-info__doc', decl.doc))
                const now = values?.()
                if (now && Object.hasOwn(now, vo.name)) {
                    const v = el('p', 'sc-pg-info__value')
                    v.append('In the simulation now: ', el('code', undefined, formatValue(now[vo.name])))
                    box.append(v)
                }
                return box
            })
        }
        if (hit.kind === 'state' || hit.kind === 'chart') {
            const s = hit.state
            return tooltip(() => {
                const box = el('div', 'sc-pg-info')
                const head = el('code', 'sc-pg-decl')
                if (hit.kind === 'chart') head.append(el('span', 'sc-tok-kw', 'scchart '), s.name)
                else {
                    const mods = [s.initial && 'initial', s.final && 'final', s.connector && 'connector', 'state'].filter(Boolean).join(' ')
                    head.append(el('span', 'sc-tok-kw', mods + ' '), s.name)
                    if (s.label) head.append(' ', el('span', 'sc-tok-str', JSON.stringify(s.label)))
                }
                box.append(head)
                if (hit.kind === 'state') {
                    const region = parentOf(result, s)
                    const parent = region ? parentOf(result, region) : undefined
                    const where = el('p', 'sc-pg-info__where')
                    const inRegion = region && region.kind === 'region' && region.name ? `region ${region.name} of ` : ''
                    where.textContent = `${hit.isDeclaration ? 'In' : 'A state in'} ${inRegion}${ownerName(parent as State | undefined)}${hit.isDeclaration ? '' : `, line ${analysis.lineOf(s.span.start)}`}.`
                    box.append(where)
                    const kinds = [s.regions.length ? `${s.regions.length} region${s.regions.length > 1 ? 's' : ''}` : '', `${s.transitions.length} outgoing transition${s.transitions.length === 1 ? '' : 's'}`].filter(Boolean)
                    box.append(el('p', 'sc-pg-info__where', kinds.join(', ') + '.'))
                }
                if (s.doc) box.append(el('p', 'sc-pg-info__doc', s.doc))
                return box
            })
        }
        return null
    })
}

export function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '–'
    if (Array.isArray(v)) return `{${v.map(formatValue).join(', ')}}`
    if (typeof v === 'string') return JSON.stringify(v)
    return String(v)
}

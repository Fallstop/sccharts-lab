// describeTick: a tick in plain English, for the "what happened" panel. One sentence per item, in the order
// things happened: entries, transitions with the reason they fired, emitted signals, changed outputs,
// termination, errors. Sentences use the chart's own names, as plain text, or with `markdown: true` as inline
// Markdown with names, triggers and values in code spans. Elements inside the copy of a referenced chart are named
// by the reference ("Inside Left (a copy of PushSwitch): Off went to On because press was true"), also when the
// chart comes from an imported file.

import type { Expression, Program, State, TickResult, TraceEvent, TraceSeen, Transition, Value } from '../types'
import { formatExpression, stateDisplayName } from '../format'
import { abortClause, countPhrase, countSuffix, heldPhrase, noteSentences, seenPhrase, suspendedHere, suspendSentences } from './describePreemption'
import {
    copyPhrases, elementName as nameIn, instanceLeaves, MARKDOWN, PLAIN, resolveState, resolveTransition, stateInCopy, structureSentences,
    withinPhrase, withoutCopyNotes, type Fmt,
} from './describeStructure'

export interface DescribeOptions {
    /** Inline Markdown: state, variable, signal and chart names, triggers and values in code spans. */
    markdown?: boolean
}

interface Index {
    states: Map<string, State>
    transitions: Map<string, Transition>
    parents: Map<string, State>
    regions: Map<string, { name?: string; parent: State }>
    actions: Map<string, { kind: string; owner: State }>
    charts: Map<string, State>
}

const indexCache = new WeakMap<Program, Index>()
/** The programs of the files a program imports (compile() records them), whose charts its references may copy. */
const importsOf = new WeakMap<Program, Program[]>()

/** Records the imported programs of a compiled program, for the names of the elements of their charts' copies. */
export function rememberImports(program: Program, imported: Program[]) {
    importsOf.set(program, imported)
    indexCache.delete(program)
}

function indexProgram(program: Program): Index {
    const cached = indexCache.get(program)
    if (cached) return cached
    const index: Index = { states: new Map(), transitions: new Map(), parents: new Map(), regions: new Map(), actions: new Map(), charts: new Map() }
    const visit = (s: State) => {
        index.states.set(s.id, s)
        for (const t of s.transitions) index.transitions.set(t.id, t)
        for (const a of s.actions) index.actions.set(a.id, { kind: a.kind, owner: s })
        for (const r of s.regions) {
            index.regions.set(r.id, { name: r.name, parent: s })
            for (const a of r.actions) index.actions.set(a.id, { kind: a.kind, owner: s })
            for (const c of r.states) {
                index.parents.set(c.id, s)
                visit(c)
            }
        }
    }
    // The imported files' charts first: the program's own come last and win a clash of names.
    for (const p of [...(importsOf.get(program) ?? []), program]) {
        for (const c of p.charts) {
            index.charts.set(c.name, c)
            visit(c)
        }
    }
    indexCache.set(program, index)
    return index
}

/**
 * A readable name for an element id of a tick's result or log (a state, transition, region or local action), also
 * inside the copy of a referenced chart or of a for-region: `{ name: 'Off → On', within: 'inside Left (a copy of
 * PushSwitch)' }`; with `markdown`, names in code spans. Undefined for an id it does not know.
 */
export function elementName(id: string, program: Program, options: DescribeOptions = {}): { name: string; within?: string } | undefined {
    return nameIn(id, indexProgram(program), options.markdown ? MARKDOWN : PLAIN)
}

function show(v: Value): string {
    if (v === null) return 'null'
    if (Array.isArray(v)) return `{${v.map(show).join(', ')}}`
    if (typeof v === 'string') return JSON.stringify(v)
    return String(v)
}

function names(list: string[]): string {
    if (list.length <= 1) return list.join('')
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * Sentences describing a tick: what was entered, which transitions fired and why, which signals were emitted,
 * which outputs changed, and whether the chart terminated or stopped with an error. Plain text, or inline Markdown
 * with `markdown: true` (the same sentences, with names, triggers and values in code spans).
 */
export function describeTick(result: TickResult, program: Program, previous?: TickResult, options: DescribeOptions = {}): string[] {
    const f: Fmt = options.markdown ? MARKDOWN : PLAIN
    const idx = indexProgram(program)
    const out: string[] = []
    const stateName = (id: string) => {
        const s = resolveState(id, idx)
        return f.code(s ? stateDisplayName(s) : id)
    }
    if (result.error) {
        // A diagnostic's message and hint are inline Markdown: as they are in Markdown, without the code marks in plain.
        const text = (s: string) => (f.md ? s : s.replace(/`/g, ''))
        out.push(`The simulation stopped in tick ${result.error.tick ?? result.tick}: ${text(result.error.message)}${result.error.span ? ` (line ${result.error.span.line})` : ''}.`)
        if (result.error.hint) out.push(text(result.error.hint))
        return out
    }
    if (result.tick === 1) {
        const leaves = result.active.filter(id => {
            const s = idx.states.get(id)
            return s && !s.isRoot && !s.regions.some(r => r.states.some(c => result.active.includes(c.id)))
        })
        const inner = instanceLeaves(result, idx, f)
        const shown = leaves.filter(id => !inner.length || !idx.states.get(id)?.reference).map(id => {
            const s = idx.states.get(id)!
            return stateDisplayName(s) === '' ? '' : f.code(stateDisplayName(s))
        }).filter(n => n !== '')
        out.push(`The chart starts${shown.length + inner.length ? ` in ${names([...shown, ...inner])}` : ''}.`)
    }
    out.push(...suspendSentences(result, idx, f))
    const structure = structureSentences(result, program, f)
    out.push(...structure.before)
    const fired = result.taken
    const copies = copyPhrases(result, f)
    // The take events, in the order of `taken`: each says what its trigger read when it was checked (reasons.ts).
    const takes = result.log.filter((e): e is Extract<TraceEvent, { kind: 'take' }> => e.kind === 'take')
    for (const [i, ev] of takes.entries()) {
        const found = resolveTransition(ev.transition, idx)
        if (!found) continue
        const t = found.t
        const read = (ev.seen ?? []).map(s => s.name)
        const where = [found.within ? withinPhrase(found.within, f, read) : undefined, copies[i]?.replace(/^This was /, 'in ').replace(/\.$/, '')].filter(Boolean)
        const joined = where.join(', ')
        const lead = where.length ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}: ` : ''
        const from = stateName(t.source)
        const to = t.target ? stateName(t.target) : f.code(t.targetName ?? '')
        const verb = t.preemption === 'termination' ? `${from} finished and joined to ${to}` : t.preemption === 'strong' ? `${from} was aborted and went to ${to}` : `${from} went to ${to}`
        const why = f.md && ev.seen?.length ? seenPhrase(ev.seen, f) : ev.reason ?? ''
        const trigger = t.trigger ? f.code(formatExpression(t.trigger)) : ''
        const held = heldPhrase(t, from)
        const inside = abortClause(t, idx, f)
        const plain = t.trigger ? simpleReason(t.trigger, ev.seen, f) : undefined
        if (t.trigger && ev.unchecked) {
            // P-23: the superstate's last transition, taken after the exit actions without checking its trigger.
            out.push(lead + `${verb} without checking ${trigger}${inside}. When ${from} is left, KIELER picks its transition again after the inside has finished (and the exit actions have run): if none of the others applies then, it takes the last one regardless of its trigger.`)
            continue
        }
        // A trigger that is just `true` explains nothing (unless it is counted).
        const trivial = t.trigger?.kind === 'bool' && t.trigger.value && !(t.triggerDelay !== undefined && t.triggerDelay > 1)
        const because = plain ? `${plain}${countPhrase(t, from)}` : `${trigger}${why ? ` ${held} (${why})` : ` ${held}`}`
        out.push(lead + (t.trigger && !trivial ? `${verb} because ${because}${inside}.` : `${verb}${t.delay === 'immediate' || t.preemption === 'termination' ? ' immediately' : ''}${inside}.`))
    }
    out.push(...delayedSentences(result, idx, stateName, f))
    out.push(...noteSentences(withoutCopyNotes(result), f))
    out.push(...structure.after)
    const emitted = Object.entries(result.present).filter(([, p]) => p).map(([name]) => f.code(name))
    if (emitted.length) out.push(`${names(emitted)} ${emitted.length === 1 ? 'was' : 'were'} present.`)
    if (previous) {
        const changed = Object.keys(result.values).filter(k => !(k in result.present) && !(k in result.inputs) && !structure.quiet.has(k) && JSON.stringify(result.values[k]) !== JSON.stringify(previous.values[k]))
        if (changed.length) out.push(`${names(changed.map(k => `${f.code(k)} is now ${f.code(show(result.values[k]))}`))}.`)
    }
    if (!fired.length && result.tick > 1 && !structure.dataflow) {
        const waiting = result.log.filter(e => e.kind === 'check' && !e.result).map(e => (e.kind === 'check' ? e.transition : ''))
        const ts = [...new Set(waiting)].map(id => ({ id, t: resolveTransition(id, idx)?.t })).filter((x): x is { id: string; t: Transition } => !!x.t && !suspendedHere(x.t.source, result, idx))
        if (ts.length) {
            const parts = ts.slice(0, 3).map(({ id, t }) => {
                // The copy a state of a referenced chart is in: the transition's prefix with the state's own id.
                const source = id.includes('/') ? `${id.slice(0, id.lastIndexOf('/') + 1)}${t.source}` : t.source
                const what = t.trigger ? `${f.code(formatExpression(t.trigger))}${countSuffix(t)}` : t.preemption === 'termination' ? 'its inside to finish' : 'the next tick'
                return `${stateInCopy(source, idx, f) ?? stateName(t.source)} waits for ${what}`
            })
            out.push(`No transition fired: ${names(parts)}.`)
        } else if (!result.log.some(e => e.kind === 'suspend')) {
            out.push('No transition fired.')
        }
    }
    if (result.terminatedNow) out.push('Every top-level region reached a final state, so the chart terminated. Nothing happens in later ticks.')
    else if (result.terminated) out.push('The chart has terminated: nothing happens any more.')
    if (result.printed.length) out.push(`It printed ${names(result.printed.map(p => f.code(JSON.stringify(p))))}.`)
    return out
}

/**
 * A trigger that is one variable or signal, or its negation, said naturally from what it read: "button was true",
 * "S was absent". Undefined for anything else (the caller says "n == 0 held (n was 0)").
 */
function simpleReason(trigger: Expression, seen: TraceSeen[] | undefined, f: Fmt): string | undefined {
    const negated = trigger.kind === 'op' && trigger.op === '!' && trigger.args[0].kind === 'ref'
    const ref = negated ? (trigger as Extract<Expression, { kind: 'op' }>).args[0] : trigger
    if (ref.kind !== 'ref' || ref.indices.length || ref.sub) return undefined
    const s = seen?.find(x => x.name === ref.name)
    if (!s || typeof s.value !== 'boolean') return undefined
    if (s.signal) return `${f.code(ref.name)} was ${s.value ? 'present' : 'absent'}`
    return `${f.code(ref.name)} was ${f.code(String(s.value))}`
}

/**
 * Values at the end of the tick, by name, for checking a trigger that was not checked: a pure signal is its
 * presence, a valued one its value (`val(S)` and presence are told apart by `present`).
 */
function holdsNow(e: Expression, result: TickResult): boolean | number | undefined {
    const value = (x: Expression): Value | undefined => {
        switch (x.kind) {
            case 'bool': case 'int': case 'float': return x.value
            case 'ref': {
                if (x.indices.length || x.sub) return undefined
                // A signal on its own is its presence (a valued signal's value is val(S)).
                if (x.name in result.present) return result.present[x.name]
                const v = result.values[x.name]
                return v === undefined ? undefined : v
            }
            case 'op': {
                const args = x.args.map(value)
                if (args.some(a => a === undefined || a === null || typeof a === 'string' || Array.isArray(a))) return undefined
                const [a, b] = args as (number | boolean)[]
                const n = (v: number | boolean) => Number(v)
                switch (x.op) {
                    case '!': return !a
                    case '&&': return (args as (number | boolean)[]).every(Boolean)
                    case '||': return (args as (number | boolean)[]).some(Boolean)
                    case '==': return n(a) === n(b)
                    case '!=': return n(a) !== n(b)
                    case '<': return n(a) < n(b)
                    case '<=': return n(a) <= n(b)
                    case '>': return n(a) > n(b)
                    case '>=': return n(a) >= n(b)
                    default: return undefined
                }
            }
            default: return undefined
        }
    }
    const v = value(e)
    return typeof v === 'boolean' || typeof v === 'number' ? v : undefined
}

/**
 * States entered in this tick whose delayed transitions' triggers already hold: "coin is true, but Locked was entered
 * in this tick: its transitions are delayed, so they are first checked in tick 2." (A delayed transition is not
 * checked in the tick its state is entered.)
 */
function delayedSentences(result: TickResult, idx: Index, stateName: (id: string) => string, f: Fmt): string[] {
    const out: string[] = []
    const active = new Set(result.active)
    // A state left and entered again in this tick (a self-loop, a superstate's reset) was just checked: the sentence
    // after "Ready went to Ready because press was true" would only confuse.
    const left = new Set(result.exited)
    for (const id of result.entered) {
        if (!active.has(id) || id.includes('/') || left.has(id)) continue
        const s = idx.states.get(id)
        if (!s || s.isRoot || s.connector || s.reference) continue
        const delayed = s.transitions.filter(t => t.delay !== 'immediate' && t.trigger && !(t.triggerDelay !== undefined && t.triggerDelay > 1))
        const holding = delayed.find(t => holdsNow(t.trigger!, result) === true)
        if (!holding) continue
        const name = stateName(id)
        const many = s.transitions.filter(t => t.delay !== 'immediate').length > 1
        out.push(`${holdsText(holding.trigger!, result, f)}, but ${name} was entered in this tick: its ${many ? 'transitions are' : 'transition is'} delayed, so ${many ? 'they are' : 'it is'} first checked in tick ${result.tick + 1}.`)
    }
    return out
}

/** "coin is true", "S is present", "n > 2 holds" (at the end of the tick). */
function holdsText(trigger: Expression, result: TickResult, f: Fmt): string {
    const negated = trigger.kind === 'op' && trigger.op === '!' && trigger.args[0].kind === 'ref'
    const ref = negated ? (trigger as Extract<Expression, { kind: 'op' }>).args[0] : trigger
    if (ref.kind === 'ref' && !ref.indices.length && !ref.sub) {
        const signal = ref.name in result.present
        if (signal) return `${f.code(ref.name)} is ${negated ? 'absent' : 'present'}`
        return `${f.code(ref.name)} is ${f.code(negated ? 'false' : 'true')}`
    }
    return `${f.code(formatExpression(trigger))} holds`
}

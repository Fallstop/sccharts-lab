// "What happened" and "Explain this tick": a tick's result in words. The sentences are the engine's
// (describeTick in src/engine/sim/describe.ts, in its inline Markdown form: state names, identifiers, triggers
// and values as code) for the foot of a simulation; this module finds the model elements each sentence is
// about, so hovering a sentence marks them on the diagram. It also turns the tick's log into
// the numbered steps of "Explain this tick". Pure.

import { stateDisplayName } from '~engine/format'
import type { Program, TickResult, TraceEvent, VariableInfo } from '~engine/types'
import { describeTick as engineDescribe, elementName } from './engine'
import { formatValue } from './inputs'
import { sourceText, stateName, transitionName, type ElementInfo } from './lines'

export interface DescribeContext {
    info: ElementInfo
    source: string
    iface: VariableInfo[]
    program?: Program
}

export interface StoryItem {
    kind: 'enter' | 'take' | 'stay' | 'signal' | 'value' | 'term' | 'error' | 'print' | 'done' | 'note'
    /** Inline Markdown. */
    text: string
    /** Model elements the item is about (for is-focus on hover). */
    ids: string[]
}

export interface TickStory {
    /** One plain paragraph (no Markdown), for the aria-live announcement. */
    summary: string
    items: StoryItem[]
}

const code = (s: string) => '`' + s.replace(/`/g, "'") + '`'
/** A state name: an identifier, so code font like every other (DESIGN.md, writing conventions), never bold. */
const b = (s: string) => code(s)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Leaf states that are active (the ones the reader sees as "where the chart is"). */
export function activeLeaves(tick: Pick<TickResult, 'active'>, info: ElementInfo): string[] {
    const active = new Set(tick.active)
    return tick.active.filter((id) => {
        const s = info.states.get(id)
        if (!s || s.isRoot) return false
        return !s.regions.some((r) => r.states.some((c) => active.has(c.id)))
    })
}

function kindOf(sentence: string): StoryItem['kind'] {
    if (/^The simulation stopped/.test(sentence)) return 'error'
    if (/^The chart starts/.test(sentence)) return 'enter'
    if (/ (went|joined) to /.test(sentence)) return 'take'
    if (/^No transition fired/.test(sentence)) return 'stay'
    if (/terminated/.test(sentence)) return 'term'
    if (/ (was|were) present\.$/.test(sentence)) return 'signal'
    if (/ is now /.test(sentence)) return 'value'
    if (/^It printed/.test(sentence)) return 'print'
    return 'note'
}

/** Marks up one of the engine's sentences and finds the elements it names. */
export function annotate(sentence: string, tick: TickResult, ctx: DescribeContext): StoryItem {
    const { info, iface } = ctx
    const ids = new Set<string>()
    const kind = kindOf(sentence)

    // States by display name (several states may share one; prefer those involved in this tick).
    const byName = new Map<string, string[]>()
    for (const s of info.states.values()) {
        if (s.isRoot) continue
        const n = stateDisplayName(s)
        byName.set(n, [...(byName.get(n) ?? []), s.id])
    }
    const involved = new Set([...tick.active, ...tick.entered, ...tick.exited])
    const statesNamed = (n: string) => {
        const all = byName.get(n) ?? []
        const now = all.filter((id) => involved.has(id))
        return now.length ? now : all
    }
    const vars = new Map(iface.map((v) => [v.name, v.id]))

    // Code segments first (triggers, values), so names inside them are not marked twice.
    const segments: string[] = []
    const hold = (s: string) => {
        for (const [name, id] of vars) if (new RegExp(`(^|[^\\w])${escapeRe(name)}(?![\\w])`).test(s)) ids.add(id)
        segments.push(code(s))
        return `\u0000${segments.length - 1}\u0000`
    }
    let text = sentence
    text = text.replace(/because (.+?) held/, (_, e: string) => `because ${hold(e.replace(/^\((.*)\)$/, '$1'))} held`)
    text = text.replace(/(waits for )(.+?)(?=(, \S+ waits for | and \S+ waits for |\.$))/g, (_, w: string, e: string) => `${w}${e === 'the next tick' || e === 'its inside to finish' ? e : hold(e.replace(/^\((.*)\)$/, '$1'))}`)
    text = text.replace(/\b(was|is now) (true|false|null|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|"(?:[^"\\]|\\.)*"|\{[^}]*\})/g, (_, w: string, v: string) => `${w} ${hold(v)}`)
    text = text.replace(/printed (.+)\.$/, (_, list: string) => `printed ${list.replace(/"(?:[^"\\]|\\.)*"/g, (m) => hold(m))}.`)

    // Then state names and variable names (code), longest first.
    const names = [...new Set([...byName.keys(), ...vars.keys()])].sort((x, y) => y.length - x.length)
    if (names.length) {
        const re = new RegExp(`(^|[^\\w\\u0000])(${names.map(escapeRe).join('|')})(?![\\w])`, 'g')
        text = text.replace(re, (_, pre: string, n: string) => {
            if (byName.has(n)) {
                statesNamed(n).forEach((id) => ids.add(id))
                return `${pre}${b(n)}`
            }
            ids.add(vars.get(n)!)
            return `${pre}${code(n)}`
        })
    }
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => segments[Number(i)])

    // A sentence about a transition: the transitions of this tick between the two states it names.
    if (kind === 'take') {
        const m = /^(.+?) (?:went to|was aborted and went to|finished and joined to) (.+?)(?: because| immediately|\.)/.exec(sentence)
        if (m) {
            for (const id of tick.taken) {
                const t = info.transitions.get(id)
                if (!t?.target) continue
                const src = info.states.get(t.source)
                const dst = info.states.get(t.target)
                if (src && dst && stateDisplayName(src) === m[1] && stateDisplayName(dst) === m[2]) ids.add(id)
            }
        }
    }
    if (kind === 'error') for (const id of tick.error?.related ?? []) ids.add(id)
    return { kind, text, ids: [...ids] }
}

/**
 * What a tick did, for the foot of a simulation: the engine's sentences in its inline Markdown (names, triggers and
 * values in code spans), with the kind and the elements `annotate` finds in the plain form of each.
 */
export function describeTick(tick: TickResult, prev: TickResult | undefined, ctx: DescribeContext): TickStory {
    const sentences = ctx.program ? engineDescribe(tick, ctx.program, prev) : []
    const marked = ctx.program ? engineDescribe(tick, ctx.program, prev, { markdown: true }) : []
    const items = sentences.map((s, i) => {
        const item = annotate(s, tick, ctx)
        return marked.length === sentences.length ? { ...item, text: marked[i] } : item
    })
    const here = activeLeaves(tick, ctx.info).map((id) => stateName(id, ctx.info.root.id))
    const summary = [`Tick ${tick.tick}.`, ...sentences, here.length && !tick.terminated ? `Active: ${here.join(', ')}.` : ''].filter(Boolean).join(' ')
    return { summary, items }
}

/** One line per micro-step of the tick, in execution order ("Explain this tick"). */
export function explainTick(tick: TickResult, ctx: DescribeContext): { text: string; ids: string[]; kind: TraceEvent['kind'] }[] {
    const { info, source } = ctx
    const root = info.root.id
    // An element inside the copy of a referenced chart is not one of the chart's own (`info`): the engine names it
    // by the reference ("`Off` → `On` inside `Left` (a copy of `PushSwitch`)").
    const copied = (id: string) => {
        if (!ctx.program || info.states.has(id) || info.transitions.has(id)) return undefined
        const n = elementName(id, ctx.program, { markdown: true })
        return n && (n.within ? `${n.name} ${n.within}` : n.name)
    }
    const st = (id: string) => copied(id) ?? b(stateName(id, root))
    const tr = (id: string) => copied(id) ?? transitionName(info, id).split(' → ').map((s) => b(s)).join(' → ')
    const by = (id: string) => {
        if (info.transitions.has(id)) return tr(id)
        if (info.states.has(id)) return st(id)
        const action = /^(.*)!(entry|during|exit|suspend|period|ode)\d+$/.exec(id)
        if (action && info.states.has(action[1])) return `the ${action[2]} action of ${st(action[1])}`
        const inCopy = copied(id)
        if (inCopy) return inCopy
        if (action) return `the ${action[2]} action of ${st(action[1])}`
        return code(id)
    }
    const owner = (id: string) => {
        const action = /^(.*)!/.exec(id)
        return action ? [action[1]] : [id]
    }
    return tick.log.map((e) => {
        switch (e.kind) {
            case 'enter': return { kind: e.kind, text: `Enter ${st(e.state)}`, ids: [e.state] }
            case 'exit': return { kind: e.kind, text: `Leave ${st(e.state)}`, ids: [e.state] }
            case 'check': {
                const t = info.transitions.get(e.transition)
                const trig = t?.trigger ? sourceText(source, t.trigger.span) : ''
                const what = trig ? `the trigger ${code(trig)} of ${tr(e.transition)}` : tr(e.transition)
                return { kind: e.kind, text: `Check ${what}: ${e.result ? 'true' : 'false'}${e.reason ? ` (${e.reason})` : ''}`, ids: [e.transition] }
            }
            case 'take': return { kind: e.kind, text: `Take ${tr(e.transition)}`, ids: [e.transition] }
            case 'action': return { kind: e.kind, text: `${by(e.action).replace(/^the/, 'The')} ${e.fired ? 'runs' : 'does not run (its trigger is false)'}`, ids: owner(e.action) }
            case 'write': return { kind: e.kind, text: `${code(`${e.variable} = ${formatValue(e.value)}`)} (${e.how === 'init' ? 'initialisation' : 'by'}${e.how === 'init' ? '' : ` ${by(e.by)}`})`, ids: owner(e.by) }
            case 'emit': return { kind: e.kind, text: `Emit ${code(e.value === undefined ? e.signal : `${e.signal}(${formatValue(e.value)})`)} (by ${by(e.by)})`, ids: owner(e.by) }
            case 'pause': return { kind: e.kind, text: `${st(e.state)} waits for the next tick`, ids: [e.state] }
            case 'terminate': return { kind: e.kind, text: `${info.regions.get(e.region)?.name ? `Region ${code(info.regions.get(e.region)!.name!)}` : 'A region'} terminates (it reached a final state)`, ids: [e.region] }
            case 'suspend': return { kind: e.kind, text: `${st(e.state)} is suspended`, ids: [e.state] }
            case 'print': return { kind: e.kind, text: `Print ${code(e.text)}`, ids: owner(e.by) }
            case 'note': return { kind: e.kind, text: e.markdown ?? e.text, ids: e.related ?? [] }
        }
    })
}

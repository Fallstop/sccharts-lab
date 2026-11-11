// logic(): the scheduled SCG as netlist C code, node by node in the executor's order (sim/exec.ts walks the same
// table, ExecutableChart.nodes). Each node gets a guard, KIELER's `_g<n>`, that is true when control reaches it in
// this tick: the root entry's is `_GO` (the first tick), a depth's the register `_pg<n>` of its surface (the pause
// was reached in the tick before), a join's its synchronizer (KIELER's: some thread exits now and every other one
// has no pause reached now, or resumed now), every other node's the disjunction of what its predecessors pass on
// (a conditional passes `g && c` to its then branch and `g && !c` to its else branch). Effects run under their
// node's guard. Every condition is computed in every tick into a `char` guard `_cg<n>`, whether control reaches
// it or not (basics.md B-22), except a plain read of an input the chart never writes, which KIELER's copy
// propagation inlines. tick() saves the guards of the pauses into the registers.

import type { ExecutableChart, XNode } from '../sim/exec'
import type { SNode } from '../sim/scg'
import { droppedIndexRefs } from '../sim/guardIndices'
import { effect, expr, type ExprEnv } from './expr'

/** What the netlist needs to know besides the schedule. */
export interface LogicInput {
    exe: ExecutableChart
    env: ExprEnv
    /** The struct member of a guard name (unique among the chart's variables). */
    name(base: string): string
    /** Nodes whose effect has no code in logic(): it runs in reset() (KIELER's GO-init, reset.ts), or it initialises a
     *  constant (KIELER's Const processor removes them). */
    skip: Set<number>
    takenTransitions: boolean
    /** A comment for the node's source transition or action (undefined: none). */
    comment?(n: SNode): string | undefined
}

export interface LogicOutput {
    /** The body of logic(), one statement per line, indented by two spaces per level. */
    lines: string[]
    /** Guard members in KIELER's order: `_g`, then `_GO`, `_cg`, `_TERM`, `_pg`. */
    guards: string[]
    conditions: string[]
    /** Every pause's register and the guard tick() saves into it (none: the pause is never reached). */
    registers: { register: string; guard?: string }[]
    /** Guards that keep their value from tick to tick (conditions with a conditional without else). */
    persistent: string[]
}

type Term = string[]

interface GuardState {
    terms: Term[]
    /** The node's own guard, once its turn came (an atomic C expression). */
    value?: string
    after: Term[]
}

const isAtomic = (s: string) => /^!?[A-Za-z_][\w>.\-[\]]*$/.test(s) || s === '0' || s === '1'

function and(t: Term): string {
    if (t.some(x => x === '0')) return '0'
    const parts = t.filter(x => x !== '1')
    if (!parts.length) return '1'
    return parts.map(p => (grouped(p) ? p : `(${p})`)).join(' && ')
}

/** An operand that needs no parentheses: a name, a negated name, `(...)` or `!(...)`. */
const grouped = (s: string) => isAtomic(s) || (s.startsWith('(') && balanced(s)) || (s.startsWith('!(') && balanced(s.slice(1)))

/** `(a) && (b)` is not one parenthesised group: true only when the outer parentheses enclose everything. */
function balanced(s: string): boolean {
    let depth = 0
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++
        else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) return false }
    }
    return true
}

function or(terms: Term[]): string {
    const parts = terms.map(and).filter(x => x !== '0')
    if (parts.includes('1')) return '1'
    if (!parts.length) return '0'
    if (parts.length === 1) return parts[0]
    return parts.map(p => (grouped(p) ? p : `(${p})`)).join(' || ')
}

const not = (s: string) => (s === '0' ? '1' : s === '1' ? '0' : isAtomic(s) ? (s.startsWith('!') ? s.slice(1) : `!${s}`) : `!(${s})`)

export function generateLogic(input: LogicInput): LogicOutput {
    const { exe, env } = input
    const nodes = exe.nodes
    const out: LogicOutput = { lines: [], guards: [], conditions: [], registers: [], persistent: [] }
    const state: GuardState[] = nodes.map(() => ({ terms: [], after: [] }))
    const D = env.structArg ? `${env.structArg}->` : ''
    const GO = `${D}_GO`

    // A guard's value as a node reading it now sees it (exec.ts reads act[] whenever it gets there).
    const valueOf = (i: number): string => {
        if (i < 0) return '0'
        const s = state[i]
        if (s.value === undefined) return or(s.terms)
        return s.after.length ? or([[s.value], ...s.after]) : s.value
    }
    const pass = (to: number, term: Term) => {
        if (to < 0) return
        const s = state[to]
        if (and(term) === '0') return
        if (s.value === undefined) s.terms.push(term)
        else s.after.push(term)
    }
    // The depths start with their surface's register (exec.ts: paused[] of the tick before).
    const registerOf = new Map<number, string>()
    nodes.forEach((x, i) => {
        if (x.src.kind !== 'surface') return
        const reg = input.name(`_pg${x.src.id}`)
        registerOf.set(i, reg)
        out.registers.push({ register: reg })
    })
    nodes.forEach((x, i) => {
        if (x.src.kind === 'depth' && x.pair >= 0 && registerOf.has(x.pair)) state[i].terms.push([`${D}${registerOf.get(x.pair)}`])
    })
    if (exe.rootEntry >= 0) state[exe.rootEntry].terms.push([GO])

    // Effects under one guard are grouped into one `if`.
    let group: { guard: string; body: string[] } | undefined
    let lastNote: string | undefined
    const flush = () => {
        if (group && group.body.length) {
            if (group.guard === '1') out.lines.push(...group.body.map(l => `  ${l}`))
            else out.lines.push(`  if (${group.guard}) {`, ...group.body.map(l => `    ${l}`), '  }')
        }
        group = undefined
    }
    const emit = (line: string) => { flush(); out.lines.push(`  ${line}`) }
    const guardVar = (x: XNode, expression: string, own: boolean): string => {
        if (!own && isAtomic(expression)) return expression
        const name = input.name(`_g${x.src.id}`)
        out.guards.push(name)
        emit(`${D}${name} = ${expression};`)
        return `${D}${name}`
    }

    for (let i = 0; i < nodes.length; i++) {
        const x = nodes[i]
        const kind = x.src.kind
        const s = state[i]
        if (kind === 'join') {
            const fires = x.join ? joinGuard(x, valueOf) : '0'
            s.value = fires === '0' ? '0' : guardVar(x, fires, true)
            pass(x.next, [s.value])
            continue
        }
        let condition: string | undefined
        if (kind === 'cond') condition = conditionCode(x, input, out, emit)
        let active = or(s.terms)
        if ((kind === 'entry' || kind === 'depth') && x.preempt?.length && active !== '0') {
            // Abort regions: an earlier thread of the preemptive fork finished in this tick.
            active = and([active, not(or(x.preempt.map(e => [valueOf(e)])))])
        }
        if (active === '0') {
            s.value = '0'
            continue
        }
        switch (kind) {
            case 'entry': case 'depth':
                s.value = guardVar(x, active, false)
                pass(x.next, [s.value])
                break
            case 'exit':
                s.value = guardVar(x, active, false)
                if (x.rootExit) emit(`${D}_TERM = ${s.value};`)
                break
            case 'fork':
                s.value = guardVar(x, active, false)
                for (const e of x.entries!) pass(e, [s.value])
                break
            case 'surface':
                s.value = guardVar(x, active, true)
                out.registers.find(r => r.register === registerOf.get(i))!.guard = s.value.slice(D.length)
                break
            case 'cond': {
                s.value = guardVar(x, active, false)
                if (x.then === x.else) pass(x.then, [s.value])
                else {
                    pass(x.then, [s.value, condition!])
                    pass(x.else, [s.value, not(condition!)])
                }
                break
            }
            case 'assign': {
                s.value = guardVar(x, active, false)
                if (!input.skip.has(i)) {
                    const f = x.src.effect!
                    let body = f.k === 'mark' ? markCode(f.m, input, D) : effect(f, env)
                    const note = body.length && input.comment?.(x.src)
                    if (group?.guard !== s.value) flush()
                    if (!group) group = { guard: s.value, body: [] }
                    // A comment where the source transition or action changes.
                    if (note && note !== lastNote) body = [note, ...body]
                    if (note) lastNote = note
                    group.body.push(...body)
                }
                pass(x.next, [s.value])
                break
            }
        }
    }
    flush()
    // A par-or join that fired ends its threads: their pauses do not resume (exec.ts kills them after the tick).
    for (const x of nodes) {
        if (x.src.kind !== 'join' || !x.join?.kill) continue
        const j = state[nodes.indexOf(x)].value
        if (!j || j === '0') continue
        let first = true
        for (const k of x.join.kill) {
            const reg = out.registers.find(r => `${D}${r.guard}` === state[k].value)
            if (!reg) continue
            if (first && input.comment) emit('/* a region of a state with abort regions finished: the other regions stop */')
            first = false
            emit(`${D}${reg.guard} = ${D}${reg.guard} && ${not(j)};`)
        }
    }
    flush()
    return out
}

/** KIELER's synchronizer: when the join fires (exec.ts joinFires). */
function joinGuard(x: XNode, valueOf: (i: number) => string): string {
    const j = x.join!
    if (j.sync === 'instantaneous') return valueOf(j.first)
    const exits = j.threads.map(t => valueOf(t.exit))
    const any = or(exits.map(e => [e]))
    if (j.sync === 'any' || any === '0') return any
    // Every counted thread exits now or is empty: no pause reached now (surface) or resumed now (depth).
    const each = j.threads.map((t, k) => {
        const busy = or(t.watch.map(w => [valueOf(w)]))
        return busy === '0' ? '1' : or([[exits[k]], [not(busy)]])
    })
    return and([any, ...each])
}

/** `_cg<n> = <condition>;` (every tick), or the inlined read of an input; returns what the branches test. */
function conditionCode(x: XNode, input: LogicInput, out: LogicOutput, emit: (line: string) => void): string {
    const { env } = input
    const n = x.src
    const dropped = droppedIndexRefs(n.expr!)
    env.dropped = dropped.size ? dropped : undefined
    try {
        if (!x.char) return expr(n.expr!, env).text
        const D = env.structArg ? `${env.structArg}->` : ''
        const name = input.name(`_cg${n.id}`)
        out.conditions.push(name)
        if (x.mem !== undefined) out.persistent.push(name)
        // A conditional without else keeps the guard's previous value (KIELER's `__CONDSELF__`, basics.md B-24).
        const saved = env.self
        env.self = `${D}${name}`
        const text = expr(n.expr!, env).text
        env.self = saved
        emit(`${D}${name} = ${text};`)
        return `${D}${name}`
    } finally {
        env.dropped = undefined
    }
}

function markCode(m: Extract<NonNullable<SNode['effect']>, { k: 'mark' }>['m'], input: LogicInput, D: string): string[] {
    if (!input.takenTransitions) return []
    if (m.kind === 'take' && m.index >= 0) return [`${D}_taken_transitions[${m.index}] += 1;`]
    if (m.kind === 'ttsReset') return Array.from({ length: input.exe.compiled.lowered.takenOrder.length }, (_, i) => `${D}_taken_transitions[${i}] = 0;`)
    return []
}

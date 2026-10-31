// Tick execution, netlist style: every tick visits the SCG's nodes in the static schedule of analysis.ts, each
// at most once, and a node runs if control reached it in this tick (or, for a depth, if its pause was reached
// in the previous tick). Joins fire by KIELER's synchronizer rules. Everything a node does is recorded in
// source terms for TickResult.

import type { Diagnostic, Expression, Span, State, TickResult, TraceEvent, TraceSeen, Value, VariableInfo } from '../types'
import type { ModelIndex } from '../parser/resolve'
import type { CompiledChart } from './compile'
import type { JoinInfo } from './analysis'
import type { SNode, Thread } from './scg'
import { compileEffect, ExprCompiler, SimError, type EffectFn, type Fn, type Runtime, type VarInfo } from './eval'
import { Memory } from './memory'
import { addressOf, droppedIndexRefs, withAddresses } from './guardIndices'
import { threadNodes } from './analysis'
import { allScopes, walkExpr, type CExpr, type CRef, type CTransition, type CVar } from './model'
import { cloneRandState, newRandState } from './random'
import { Tracker, type TakeOptions, type TrackerSnapshot } from './tracker'
import { copyNotes, copyStates, trackView } from './structure/track'
import { historyRecordReader, hookEvents, isHook, StateNames, suspendEvents, takeNotes, takeOptions, type HookMark } from './preemptionLog'
import type { SuspendInfo } from './passes/suspend'
import type { HistoryRecord } from './passes/history'
import { lookupSource, readProbes, seenText, sourceElements, triggerProbes, type Probe } from './reasons'
import {
    cloneValue, convert, ctypeOf, defaultValue, doubleToInt, freshString, INT_MAX, INT_MIN, isCString, makeArray,
    toChar, type CType, type RValue,
} from './values'

/** A value in KIELER's data pool: a class or struct instance is an object of its members (`"c": {"count": 3}`). */
export type PoolValue = Value | { [member: string]: PoolValue }

/** TickResult plus KIELER's data pool (the oracle's `values`, with KIELER's names: S, V, V_val, V_curval). */
export interface SimTickResult extends TickResult {
    pool: Record<string, PoolValue>
    /**
     * Values a reader may trace that KIELER's data pool does not list by name, by the key `traceableVariables()`
     * gives them (../index.ts): the locals of states and regions inside the chart (key: the declaration id,
     * `Chart.S$c`; a local signal: its presence, a valued one its value) and the members of the chart's class and
     * struct instances (key `pt.x`; the pool has them as the object `pt`). A local of a for-region's states has one key
     * per copy, `Chart.R.W$k|Chart.R=2` (the declaration id, `|`, the region and the copy's counter value). Not inside
     * referenced charts.
     */
    trace: Record<string, Value>
}

const enum K { Entry, Exit, Assign, Cond, Fork, Join, Surface, Depth }

interface XNode {
    kind: K
    src: SNode
    next: number
    then: number
    else: number
    /** fork: entry node indices of its threads. */
    entries?: number[]
    run?: EffectFn
    test?: Fn
    /** join: guard evaluation. */
    join?: JoinGuard
    /** surface: index of its depth; depth: index of its surface. */
    pair: number
    /** The thread exit of the root. */
    rootExit?: boolean
    /** For the log. */
    log?: LogInfo
    /** Assignment that runs before tick 1 inputs are read (B-7). */
    goInit?: boolean
    /** A source trigger's references as this condition (or suspend flag update) reads them (reasons.ts). */
    probes?: Probe[]
    /** Abort regions: an entry or depth that does not run when one of these thread exits ran earlier in the tick. */
    preempt?: number[]
    /** cond: the slot of KIELER's guard variable `_c<g>` holding the condition's value since it was last computed
     *  (only for conditions with a conditional without else, which reads it; see the main loop). */
    mem?: number
    /** cond: the condition's value is stored in a `char` guard variable (all but plain reads of unwritten inputs). */
    char?: boolean
}

interface JoinGuard {
    sync: JoinInfo['sync']
    /** Counted threads: exit node index and the indices of their surfaces (surface sync) or depths (depth sync). */
    threads: { exit: number; watch: number[]; region?: string }[]
    first: number
    /** A par-or join (abort regions): the surfaces inside its threads, whose depths do not resume after it fired. */
    kill?: number[]
    /** A par-or join: the source state whose regions it ends. */
    state?: string
}

interface LogInfo {
    take?: string
    /** The tracker's id of the transition when it differs (a for-region copy's, structure/track.ts). */
    takeKey?: string
    /** The take mark's refinements by the preemption passes (history KIELER applies, deferred entry). */
    takeOptions?: TakeOptions
    /** A preemption pass's tracker hook (preemptionLog.ts). */
    hook?: HookMark
    action?: string
    check?: string
    /** Which fired transition a check is for: the take key of its transition (for-region copies), else `check`. */
    checkKey?: string
    /** The source transition of a take has a trigger. */
    triggered?: boolean
    /** A suspend flag update (`_enabled &= !c`): the flag, for the suspend event's reason. */
    suspendFlag?: CVar
    actionCheck?: string
    write?: { v: CVar; by?: string; how: 'init' | 'update'; emits?: CVar }
    pause?: { state: string }
    print?: string
    terminate?: string
}

interface PoolEntry {
    name: string
    v: CVar
    type: CType
    /** A member of a class or struct instance: the instance's name (the pool has an object for it). */
    of?: string
}

/** A traced value that is not a pool name (SimTickResult.trace). */
interface TraceEntry {
    key: string
    v: CVar
    type: CType
}

interface SimState {
    vals: RValue[]
    rand: ReturnType<typeof newRandState>
    paused: Uint8Array
    started: boolean
    dead: boolean
    terminated: boolean
    halted?: Diagnostic
    tracker: TrackerSnapshot
}

export class ExecutableChart {
    readonly nodes: XNode[] = []
    readonly slots = new Map<CVar, VarInfo>()
    readonly pool: PoolEntry[] = []
    readonly traced: TraceEntry[] = []
    /** Instances without fields: an empty object in the pool. */
    readonly emptyObjects: string[]
    readonly inputs: { v: CVar; name: string; type: CType }[] = []
    readonly goInits: number[] = []
    /** Slots of the conditions' guard variables (XNode.mem), which start at 0 like every member of KIELER's struct. */
    readonly guardSlots: number[] = []
    /** The padding bytes of KIELER's struct (memory.ts), zero at the start. */
    readonly padding: { slot: number; size: number }
    readonly varCount: number
    readonly rootEntry: number
    /** Names of every variable in the pool (inputs or not). */
    readonly knownNames = new Set<string>()
    private readonly signalValues = new Map<string, CVar>()
    private readonly presence = new Map<string, CVar>()
    private readonly plain = new Map<string, CVar>()

    constructor(readonly compiled: CompiledChart, readonly iface: VariableInfo[]) {
        // Variables: everything declared anywhere in the core chart.
        let slot = 0
        for (const scope of allScopes(compiled.core)) {
            for (const v of scope.decls) {
                if (this.slots.has(v) || v.const) continue
                this.slots.set(v, { slot: slot++, type: ctypeOf(v.type), dims: v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : 0)) })
            }
        }
        const ensure = (v: CVar): VarInfo => {
            let info = this.slots.get(v)
            if (!info) {
                info = { slot: slot++, type: ctypeOf(v.type), dims: v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : 0)) }
                this.slots.set(v, info)
            }
            return info
        }
        // KIELER's struct of the chart's variables, for indices outside an array (memory.ts); its padding in a slot.
        const rootVars = new Map<string, CVar>()
        for (const v of compiled.core.decls) if (v.decl && !v.generated && !v.role && !rootVars.has(v.decl)) rootVars.set(v.decl, v)
        const padding = slot++
        const memory = new Memory(compiled.chart, id => {
            const v = rootVars.get(id)
            const info = v ? this.slots.get(v) : undefined
            return v && info ? { v, slot: info.slot, dims: info.dims } : undefined
        }, padding, compiled.lowered.takenOrder.length)
        this.padding = { slot: padding, size: memory.size }
        const ec = new ExprCompiler({ info: ensure, label: v => v.display ?? v.name, memory })
        // The source triggers, for the values a check read (reasons.ts).
        const sources = sourceElements(compiled.chart, compiled.shared.index as ModelIndex | undefined)
        const probe = (core: CExpr | undefined, trigger: Expression | undefined) => {
            const list = triggerProbes(core, trigger, r => ec.compile(r).fn, r => {
                const type = ctypeOf(lowermost(r).v.type)
                return v => toValue(v, type, false)
            })
            return list.length ? list : undefined
        }

        // KIELER's data pool: the root's declarations, without constants and generated helpers.
        for (const v of compiled.core.decls) {
            if (v.member && !v.const && !v.declKind) {
                if (!v.tags.has('#const-member')) this.pool.push({ name: v.member.name, v, type: ctypeOf(v.type), of: v.member.of.name })
                continue
            }
            if (v.const || v.declKind || v.name.startsWith('_')) continue
            this.pool.push({ name: v.name, v, type: ctypeOf(v.type) })
            this.knownNames.add(v.name)
            if (v.input && !v.generated) this.inputs.push({ v, name: v.name, type: ctypeOf(v.type) })
            if (v.role === 'value' && v.of) this.signalValues.set(v.of.name, v)
            else if (v.role === 'presence') this.presence.set(v.name, v)
            else if (!v.role) this.plain.set(v.name, v)
        }

        this.emptyObjects = (compiled.core.ext.emptyInstances as string[] | undefined) ?? []
        // What a reader may trace beyond the pool: members of the root's instances, locals of inner scopes.
        const rootDecls = new Set(compiled.core.decls)
        const traceKeys = new Set<string>()
        const trace = (key: string, v: CVar) => {
            if (traceKeys.has(key) && v.role !== 'value') return
            const i = this.traced.findIndex(t => t.key === key)
            if (i >= 0) this.traced.splice(i, 1)
            traceKeys.add(key)
            this.traced.push({ key, v, type: ctypeOf(v.type) })
        }
        for (const [v] of this.slots) {
            if (v.const || v.declKind || !v.decl || v.decl.includes('/')) continue
            if (v.member && rootDecls.has(v)) { if (!v.tags.has('#const-member')) trace(`${v.member.of.name}.${v.member.name}`, v); continue }
            if (rootDecls.has(v) || v.member) continue
            // Source variables only (a region's declaration keeps its id when KIELER moves it to the parent state); a
            // local signal is its presence and, when valued, its value (which replaces it).
            if (!v.decl.includes('$') || (v.role && v.role !== 'value' && v.role !== 'presence')) continue
            // A local of a for-region copy's state: one key per copy (traceableVariables).
            trace(v.forCopy ? `${v.decl}|${v.forCopy.region}=${v.forCopy.value}` : v.decl, v)
        }

        // Inputs the chart writes (KIELER's copy propagation keeps the guard variable of a condition that reads one).
        const writtenInputs = new Set<CVar>()
        for (const n of compiled.scg.nodes) {
            const f = n.effect
            if (f?.k === 'assign' && lowermost(f.ref).v.input) writtenInputs.add(lowermost(f.ref).v)
        }
        // Nodes in schedule order.
        const order = compiled.analysis.order
        const index = new Map<SNode, number>()
        order.forEach((n, i) => index.set(n, i))
        const at = (n: SNode | undefined) => (n && index.has(n) ? index.get(n)! : -1)
        const rootExit = compiled.scg.root.exit
        for (const n of order) {
            const x: XNode = { kind: kindOf(n), src: n, next: at(n.next), then: at(n.then), else: at(n.else), pair: -1 }
            switch (n.kind) {
                case 'fork': x.entries = n.threads!.map(t => at(t.entry)); break
                case 'surface': x.pair = at(n.depth); x.log = surfaceLog(n); break
                case 'depth': x.pair = at(n.surface); break
                case 'exit': if (n === rootExit) x.rootExit = true; break
                case 'cond': {
                    // KIELER's C code drops some indices of a condition (guardIndices.ts): the array's address instead.
                    const dropped = droppedIndexRefs(n.expr!)
                    const condition = dropped.size ? withAddresses(n.expr!, dropped, v => addressOf(v, ensure(v).slot)) : n.expr!
                    // KIELER's guard `_c<g> = condition` is a char that keeps its value between ticks: a conditional
                    // without an else part (`c ? a` in a trigger) gives that value when `c` is false (ExprCompiler.selves).
                    if (hasConditionalWithoutElse(condition)) {
                        const mem = slot++
                        x.mem = mem
                        this.guardSlots.push(mem)
                        x.test = ec.withSelf({ fn: rt => rt.vals[mem], type: 'int' }, () => ec.compile(condition)).fn
                    } else {
                        x.test = ec.compile(condition).fn
                    }
                    // KIELER's copy propagation drops the guard variable of a plain read of an input the chart never
                    // writes (`_g3 = _g2 && n`); every other condition goes through the char (`if n` with n = 256 holds,
                    // but `if (c) ? n` with c true and n = 256 does not).
                    const e = n.expr!
                    x.char = !(e.k === 'ref' && !e.sub && lowermost(e).v.input && !writtenInputs.has(lowermost(e).v))
                    const t = n.transition
                    const check = t?.origin ?? t?.checks
                    // An `if` of a method body KIELER copied into the graph (n.method) tests the body, not the trigger.
                    if (check && !n.method) {
                        x.log = { check, checkKey: takeMark(t)?.key ?? check }
                        x.probes = probe(n.expr, lookupSource(sources.transitions, check)?.trigger)
                    } else if (t?.about && isActionId(t.about)) x.log = { actionCheck: t.about }
                    break
                }
                case 'assign': {
                    const f = n.effect!
                    x.run = compileEffect(f, ec)
                    if (f.k === 'mark') {
                        if (f.m.kind === 'take') x.log = { take: f.m.transition, takeKey: f.m.key, takeOptions: takeOptions(f.m), triggered: !!lookupSource(sources.transitions, f.m.transition)?.trigger }
                        else if (f.m.kind === 'action') x.log = { action: f.m.action }
                        else if (isHook(f.m)) x.log = { hook: f.m }
                    } else if (f.k === 'assign') {
                        const target = f.ref.v
                        const visible = !f.o.hidden && !target.generated
                        if (visible || f.o.emits) x.log = { write: { v: target, by: f.o.by, how: f.o.init ? 'init' : 'update', emits: f.o.emits } }
                        else if (target.role === 'enabled' && f.o.by && /!suspend\d+$/.test(f.o.by)) {
                            x.log = { suspendFlag: target }
                            x.probes = probe(f.expr, lookupSource(sources.actions, f.o.by)?.trigger)
                        }
                        if (compiled.goBlock.moved.has(n) && lowermost(f.ref).v.input) x.goInit = true
                    } else if (f.k === 'print') {
                        x.log = { print: f.o.by }
                    }
                    break
                }
                case 'join': {
                    const info = compiled.analysis.joins.get(n)
                    if (info && !info.dead) {
                        const any = info.sync === 'any'
                        x.join = {
                            sync: info.sync,
                            first: info.first ? at(info.first.exit) : -1,
                            threads: info.counted.map(t => ({
                                exit: at(t.exit), watch: any ? [] : watchNodes(compiled, t, info.sync).map(at).filter(i => i >= 0),
                                region: t.region?.origin ?? t.region?.about,
                            })),
                        }
                        if (any) {
                            const fork = n.fork!
                            x.join.kill = fork.threads!.flatMap(t => threadNodes(compiled.scg, t)).filter(m => m.kind === 'surface').map(at).filter(i => i >= 0)
                            x.join.state = fork.state?.origin ?? fork.state?.about
                        }
                    }
                    break
                }
            }
            const preempt = compiled.analysis.preemption?.get(n)
            if (preempt) x.preempt = preempt.map(at).filter(i => i >= 0)
            this.nodes.push(x)
        }
        // KIELER's reset(): the GO block's assignments without input reads, in order (only their effect on inputs is kept).
        for (const n of compiled.goBlock.nodes) {
            if (!compiled.goBlock.moved.has(n) || !index.has(n)) continue
            this.goInits.push(index.get(n)!)
        }
        this.rootEntry = at(compiled.scg.root.entry)
        this.varCount = slot
    }

    initialState(tracker: Tracker): SimState {
        const vals: RValue[] = new Array(this.varCount)
        for (const info of this.slots.values()) vals[info.slot] = makeArray(info.dims, () => defaultValue(info.type))
        for (const g of this.guardSlots) vals[g] = 0
        vals[this.padding.slot] = new Array(this.padding.size).fill(0)
        tracker.reset()
        return {
            vals, rand: newRandState(), paused: new Uint8Array(this.nodes.length), started: false, dead: false,
            terminated: false, tracker: tracker.snapshot(),
        }
    }

    // ----- reporting -----

    report(vals: RValue[], extra: Record<string, Value> = {}): { values: Record<string, Value>; present: Record<string, boolean>; pool: Record<string, PoolValue>; trace: Record<string, Value> } {
        const trace: Record<string, Value> = {}
        for (const t of this.traced) trace[t.key] = toValue(vals[this.slots.get(t.v)!.slot], t.type, false)
        const pool: Record<string, PoolValue> = { ...extra }
        for (const name of this.emptyObjects) pool[name] = {}
        for (const p of this.pool) {
            const value = toValue(vals[this.slots.get(p.v)!.slot], p.type, true)
            if (value === null) continue
            if (p.of) ((pool[p.of] ??= {}) as Record<string, PoolValue>)[p.name] = value
            else pool[p.name] = value
        }
        const values: Record<string, Value> = {}
        const present: Record<string, boolean> = {}
        for (const info of this.iface) {
            if (info.const) continue
            if (info.signal) {
                const pres = this.presence.get(info.name)
                const p = pres ? vals[this.slots.get(pres)!.slot] : 0
                present[info.name] = typeof p === 'number' ? p !== 0 : false
                if (info.valued) {
                    const vv = this.signalValues.get(info.name)
                    values[info.name] = vv ? toValue(vals[this.slots.get(vv)!.slot], ctypeOf(vv.type), false) : null
                } else {
                    values[info.name] = present[info.name]
                }
                continue
            }
            const v = this.plain.get(info.name)
            if (v) values[info.name] = toValue(vals[this.slots.get(v)!.slot], ctypeOf(v.type), false)
        }
        return { values, present, pool, trace }
    }

    /**
     * Every input's value in `vals`, by KIELER's names: a valued input signal V as `V` (its presence) and `V_val` (its
     * value); an unset string is null. Read right after applyInputs: the values a tick runs with (TickResult.ranWith).
     */
    inputValues(vals: RValue[]): Record<string, Value> {
        const out: Record<string, Value> = {}
        for (const input of this.inputs) {
            const key = input.v.role === 'value' && input.v.of ? input.v.of.name + '_val' : input.name
            out[key] = toValue(vals[this.slots.get(input.v)!.slot], input.type, false)
        }
        return out
    }

    /**
     * Applies the environment's inputs (B-9): missing keep their value, arrays are overwritten element-wise. Keys
     * that are not inputs of the chart stay in KIELER's data pool (`extra`), as KIELER's server keeps them.
     */
    applyInputs(vals: RValue[], given: Record<string, Value>, extra: Record<string, Value>) {
        const consumed = new Set<string>()
        for (const input of this.inputs) {
            consumed.add(input.name)
            if (input.v.of) consumed.add(input.v.of.name)
            const slot = this.slots.get(input.v)!.slot
            let name = input.name
            let value: Value | undefined = given[name]
            // A valued input signal V is set by its value (`V_val`, or the signal's name with a non-boolean).
            if (input.v.role === 'value' && input.v.of) {
                value = given[name] ?? (given[input.v.of.name] !== undefined && typeof given[input.v.of.name] !== 'boolean' ? given[input.v.of.name] : undefined)
                name = input.v.of.name
            }
            if (input.v.role === 'presence') {
                const g = given[name]
                value = typeof g === 'boolean' ? g : g === undefined || g === null ? undefined : true
            }
            if (value !== undefined) vals[slot] = fromInput(value, input.type, vals[slot])
            else if (input.type === 'string') vals[slot] = rematerialise(vals[slot])
        }
        for (const [k, v] of Object.entries(given)) if (!consumed.has(k) && !this.knownNames.has(k)) extra[k] = v
    }
}

function rematerialise(v: RValue): RValue {
    if (isCString(v)) return freshString(v.s)
    if (Array.isArray(v)) return v.map(rematerialise)
    return v
}

function kindOf(n: SNode): K {
    switch (n.kind) {
        case 'entry': return K.Entry
        case 'exit': return K.Exit
        case 'assign': return K.Assign
        case 'cond': return K.Cond
        case 'fork': return K.Fork
        case 'join': return K.Join
        case 'surface': return K.Surface
        case 'depth': return K.Depth
    }
}

function isActionId(id: string): boolean {
    return /![a-z]+\d+$/.test(id)
}

function surfaceLog(n: SNode): LogInfo | undefined {
    const s = n.state
    const state = s?.origin ?? s?.about
    return state ? { pause: { state } } : undefined
}

function watchNodes(compiled: CompiledChart, t: Thread, sync: JoinInfo['sync']): SNode[] {
    const kind = sync === 'surface' ? 'surface' : 'depth'
    const inside = (x: Thread): boolean => {
        for (let y: Thread | undefined = x; y; y = y.parent) if (y === t) return true
        return false
    }
    return compiled.scg.nodes.filter(n => n.kind === kind && inside(n.thread))
}

/** Converts a run-time value for reporting (bools as booleans; strings as text; `pool`: KIELER's JSON). */
function toValue(v: RValue, type: CType, pool: boolean): Value {
    if (Array.isArray(v)) return v.map(x => (pool && type === 'string' && x === null ? '' : toValue(x, type, pool)))
    if (v === null) return null
    if (isCString(v)) return v.s
    if (type === 'bool') return v !== 0
    return v
}

/** cJSON's valueint: a saturating conversion of the number to int. */
function jsonInt(n: number): number {
    if (n >= INT_MAX) return INT_MAX
    if (n <= INT_MIN) return INT_MIN
    return doubleToInt(n)
}

function fromInput(value: Value, type: CType, current: RValue): RValue {
    if (Array.isArray(value)) {
        const target = Array.isArray(current) ? current.map(cloneValue) : []
        value.forEach((x, i) => { if (i < target.length) target[i] = fromInput(x, type, target[i]) })
        return target
    }
    switch (type) {
        case 'string': return typeof value === 'string' ? freshString(value) : null
        case 'float': return typeof value === 'number' ? value : value === true ? 1 : 0
        case 'bool': return typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? toChar(jsonInt(value)) : 0
        default: return typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? jsonInt(value) : 0
    }
}

// ---------------------------------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------------------------------

export class SimRunner {
    private state: SimState
    /** Environment values for names that are not inputs (KIELER's server keeps them in its pool). */
    private extra: Record<string, Value> = {}
    private readonly tracker: Tracker
    private readonly takenIds: Set<string>
    private readonly names: StateNames
    private readonly regionNames = new Map<string, string>()
    private readonly abortRegions = new Set<string>()

    constructor(readonly exe: ExecutableChart, readonly chart: State) {
        // References and for-regions: the tracker follows the chart with its instances and copies (structure/track.ts).
        const view = trackView(exe.compiled, chart)
        this.tracker = new Tracker(view.root, view.report)
        for (const id of exe.compiled.scg.silentHops ?? []) this.tracker.autoTake.add(id)
        this.names = new StateNames(chart)
        const visit = (st: State) => {
            for (const r of st.regions) {
                if (r.name) this.regionNames.set(r.id, r.name)
                if (r.abort) this.abortRegions.add(r.id)
                r.states.forEach(visit)
            }
        }
        visit(chart)
        this.state = exe.initialState(this.tracker)
        this.takenIds = new Set(exe.compiled.lowered.takenOrder)
    }

    reset() {
        this.state = this.exe.initialState(this.tracker)
        this.extra = {}
    }

    snapshot(): SimState & { extra: Record<string, Value> } {
        const s = this.state
        return {
            extra: { ...this.extra },
            vals: s.vals.map(cloneValue), rand: cloneRandState(s.rand), paused: s.paused.slice(), started: s.started,
            dead: s.dead, terminated: s.terminated, halted: s.halted, tracker: this.tracker.snapshot(),
        }
    }

    restore(s: SimState & { extra?: Record<string, Value> }) {
        this.extra = { ...(s.extra ?? {}) }
        this.state = { ...s, vals: s.vals.map(cloneValue), rand: cloneRandState(s.rand), paused: s.paused.slice() }
        this.tracker.restore(s.tracker)
    }

    step(tick: number, given: Record<string, Value>): SimTickResult {
        const exe = this.exe
        const s = this.state
        const tracker = this.tracker
        tracker.restore(s.tracker)
        tracker.beginTick()
        const log: TraceEvent[] = []
        const printed: string[] = []
        const taken: string[] = []
        const actions: string[] = []
        let terminatedNow = false
        let error: Diagnostic | undefined

        const before = s.vals.map(cloneValue)
        const rt: Runtime = { vals: s.vals, rand: s.rand, printed }

        if (s.halted) {
            return this.result(tick, given, log, printed, taken, actions, false, s.halted, before, exe.inputValues(s.vals))
        }

        const nodes = exe.nodes
        const act = new Uint8Array(nodes.length)
        const condValue = new Uint8Array(nodes.length)
        let ranWith: Record<string, Value> | undefined
        try {
            if (!s.started && exe.goInits.length) {
                // KIELER's reset() runs the GO block's input-free assignments before the first inputs are read
                // (B-7). Only what they do to inputs matters here: the rest runs in tick 1, in written order.
                const scratch: Runtime = { vals: s.vals.map(cloneValue), rand: cloneRandState(s.rand) }
                for (const i of exe.goInits) nodes[i].run!(scratch, [])
                for (const input of exe.inputs) {
                    const slot = exe.slots.get(input.v)!.slot
                    s.vals[slot] = scratch.vals[slot]
                }
            }
            exe.applyInputs(s.vals, given, this.extra)
            ranWith = exe.inputValues(s.vals)
            if (!s.dead) {
                if (!s.started) {
                    if (exe.rootEntry >= 0) act[exe.rootEntry] = 1
                    for (const id of tracker.start()) log.push({ kind: 'enter', state: id })
                }
                for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === K.Depth && s.paused[nodes[i].pair]) act[i] = 1
                const paused = new Uint8Array(nodes.length)
                const checked = new Set<string>()
                // Per fired transition (take key): what its trigger read when it was last checked true in this tick.
                const checkedTrue = new Map<string, TraceSeen[]>()
                // Per suspend flag: what its suspend triggers read.
                const suspendSeen = new Map<CVar, TraceSeen[]>()
                // KIELER's history records, for history entries in the source-level configuration (passes/history.ts).
                const records = historyRecordReader(exe.compiled.core.ext.historyRecords as Map<string, HistoryRecord> | undefined, v => {
                    const info = exe.slots.get(v)
                    const value = info ? s.vals[info.slot] : 0
                    return typeof value === 'number' ? value : 0
                })
                const parOr: JoinGuard[] = []
                for (let i = 0; i < nodes.length; i++) {
                    const x = nodes[i]
                    if (x.kind === K.Join) {
                        if (x.join && joinFires(x.join, act)) {
                            if (x.next >= 0) act[x.next] = 1
                            if (x.join.kill) parOr.push(x.join)
                        }
                        continue
                    }
                    // KIELER's netlist computes every condition's guard `_c<g> = condition` in every tick, at its place in
                    // the schedule, whether control reaches the condition or not: a random() or a C function in the
                    // trigger of a state that is not active runs anyway, and a division by zero there stops the
                    // simulation (probes kieler/rare/probe-trigger-*).
                    if (x.kind === K.Cond) {
                        let raw: RValue
                        try {
                            raw = x.test!(rt)
                        } catch (e) {
                            // What C only gets wrong without crashing (a read outside an array the guide cannot lay out,
                            // a C function that returns nothing) does no harm where control does not go.
                            if (act[i] || !(e instanceof SimError) || (e.code !== 'index-out-of-range' && e.code !== 'missing-return')) throw e
                            continue
                        }
                        const value = x.char && typeof raw === 'number' ? toChar(raw) : raw
                        if (x.mem !== undefined) rt.vals[x.mem] = value
                        condValue[i] = typeof value === 'number' ? (value !== 0 ? 1 : 0) : value !== null ? 1 : 0
                    }
                    if (!act[i]) continue
                    switch (x.kind) {
                        case K.Entry:
                        case K.Depth:
                            // Abort regions: an earlier thread of a preemptive fork finished in this tick.
                            if (x.preempt && x.preempt.some(e => act[e])) {
                                act[i] = 0
                                break
                            }
                            if (x.next >= 0) act[x.next] = 1
                            break
                        case K.Exit:
                            if (x.rootExit) terminatedNow = true
                            break
                        case K.Fork:
                            for (const e of x.entries!) if (e >= 0) act[e] = 1
                            break
                        case K.Surface:
                            paused[i] = 1
                            break
                        case K.Cond: {
                            const yes = condValue[i] === 1
                            const target = yes ? x.then : x.else
                            if (target >= 0) act[target] = 1
                            const lg = x.log
                            if (lg?.check) {
                                const seen = x.probes ? readProbes(x.probes, rt) : undefined
                                const reason = seen?.length ? seenText(seen) : undefined
                                // Once per transition, result and values read (a generated condition that only tests a
                                // trigger flag adds nothing to a check already logged); each for-region copy's own.
                                const any = `${lg.checkKey ?? lg.check}:${yes}`
                                const key = reason ? `${any}:${reason}` : any
                                if (!checked.has(key) && (reason || !checked.has(`${any}:*`))) {
                                    checked.add(key)
                                    checked.add(`${any}:*`)
                                    log.push(reason ? { kind: 'check', transition: lg.check, result: yes, reason, seen } : { kind: 'check', transition: lg.check, result: yes })
                                }
                                if (yes) {
                                    // A later check without values (a generated condition) keeps what the trigger read.
                                    if (seen?.length || !checkedTrue.has(lg.checkKey!)) checkedTrue.set(lg.checkKey!, seen ?? [])
                                }
                            } else if (lg?.actionCheck && !yes) {
                                log.push({ kind: 'action', action: lg.actionCheck, fired: false })
                            }
                            break
                        }
                        case K.Assign: {
                            if (x.goInit && !s.started) {
                                // Ran in KIELER's reset(), before the environment's tick-1 inputs (B-7).
                                const f = x.src.effect
                                // (Not for deltaT's generated start value: the environment always gives deltaT.)
                                if (f?.k === 'assign' && !f.o.hidden && !lowermost(f.ref).v.tags.has('#deltaT')) {
                                    const name = lowermost(f.ref).v.display ?? lowermost(f.ref).v.name
                                    const say = (c: (s: string) => string) => `${c(name)} is an input: KIELER sets it before reading the first inputs, so the value the environment gives ${c(name)} in tick 1 wins.`
                                    log.push({ kind: 'note', text: say(n => n), markdown: say(n => '`' + n + '`'), related: f.o.by ? [f.o.by] : undefined })
                                }
                                if (x.next >= 0) act[x.next] = 1
                                break
                            }
                            const seenBefore = x.probes && x.log?.suspendFlag ? readProbes(x.probes, rt) : undefined
                            const w = x.run!(rt, printed)
                            if (rt.notes?.length) {
                                for (const n of rt.notes) log.push({ kind: 'note', text: n.text, markdown: n.markdown, related: x.src.effect?.o.by ? [x.src.effect.o.by] : undefined })
                                rt.notes = []
                            }
                            const lg = x.log
                            if (lg) {
                                if (lg.take) {
                                    taken.push(lg.take)
                                    const key = lg.takeKey ?? lg.take
                                    const seen = checkedTrue.get(key)
                                    checkedTrue.delete(key)
                                    log.push(seen?.length ? { kind: 'take', transition: lg.take, reason: seenText(seen), seen }
                                        : !seen && lg.triggered ? { kind: 'take', transition: lg.take, unchecked: true } : { kind: 'take', transition: lg.take })
                                    const moved = tracker.take(lg.takeKey ?? lg.take, lg.takeOptions && { ...lg.takeOptions, record: records })
                                    if (lg.takeKey) log.push(...copyNotes(lg.take, lg.takeKey, exe.compiled))
                                    for (const id of moved.exited) log.push({ kind: 'exit', state: id })
                                    for (const id of moved.entered) log.push({ kind: 'enter', state: id })
                                    if (lg.takeOptions) log.push(...takeNotes(lg.take, lg.takeOptions, moved.entered, this.names, tracker))
                                } else if (lg.hook) {
                                    log.push(...hookEvents(lg.hook, tracker, this.names, records))
                                } else if (lg.action) {
                                    actions.push(lg.action)
                                    log.push({ kind: 'action', action: lg.action, fired: true })
                                } else if (lg.write && w) {
                                    const value = toValue(w.value, ctypeOf(w.v.type), false)
                                    const name = lg.write.emits ? (lg.write.emits.display ?? lg.write.emits.name) : (w.v.display ?? w.v.name)
                                    if (lg.write.emits) {
                                        if (w.v.role === 'curval') log.push({ kind: 'emit', signal: name, value, by: lg.write.by ?? '' })
                                        else if (!hasValueEmission(log, name)) log.push({ kind: 'emit', signal: name, by: lg.write.by ?? '' })
                                    } else {
                                        log.push({ kind: 'write', variable: w.index ? `${name}[${w.index.join('][')}]` : name, value, by: lg.write.by ?? '', how: lg.write.how })
                                    }
                                } else if (lg.print !== undefined && printed.length) {
                                    log.push({ kind: 'print', text: printed[printed.length - 1], by: lg.print })
                                } else if (lg.suspendFlag && seenBefore?.length) {
                                    const list = suspendSeen.get(lg.suspendFlag) ?? []
                                    for (const x of seenBefore) if (!list.some(y => y.name === x.name)) list.push(x)
                                    suspendSeen.set(lg.suspendFlag, list)
                                }
                            }
                            if (x.next >= 0) act[x.next] = 1
                            break
                        }
                    }
                }
                // A par-or join fired: its state's regions stop. At the end of the tick, since the regions after the
                // one that finished still react in this tick (a weak abort).
                for (const j of parOr) log.push(...this.parOrEvents(j, act))
                for (let i = 0; i < nodes.length; i++) {
                    if (paused[i] && nodes[i].log?.pause) {
                        const state = nodes[i].log!.pause!.state
                        const region = tracker.regionOf(state)
                        if (region && tracker.activeIn(region) === state) log.push({ kind: 'pause', state, region })
                    }
                }
                const suspended = suspendEvents(exe.compiled.core.ext.suspends as SuspendInfo[] | undefined, new Set(tracker.activeStates()), v => {
                    const info = exe.slots.get(v)
                    const value = info ? s.vals[info.slot] : 0
                    return typeof value === 'number' ? value !== 0 : false
                }, this.names, flag => suspendSeen.get(flag))
                if (suspended.length) {
                    // At the start of the tick (after tick 1's entries): what the reader looks for first.
                    let at = 0
                    while (at < log.length && log[at].kind === 'enter') at++
                    log.splice(at, 0, ...suspended)
                }
                // After a par-or join fired, nothing inside its threads resumes in the next tick (`!pre(join)`).
                for (const j of parOr) for (const i of j.kill!) paused[i] = 0
                s.paused = paused
                s.started = true
                if (terminatedNow) {
                    s.dead = true
                    s.terminated = true
                    log.push({ kind: 'terminate', region: this.chart.id })
                }
            }
        } catch (e) {
            if (!(e instanceof SimError)) throw e
            error = { severity: 'error', code: e.code, message: e.message, span: e.span, hint: e.hint, tick }
            // The tick did not happen: KIELER's process dies and the previous values stay (B-20).
            s.vals = before
            s.halted = error
            tracker.restore(s.tracker)
            tracker.beginTick()
            return this.result(tick, given, log, printed, [], [], false, error, before, ranWith)
        }
        s.tracker = tracker.snapshot()
        return this.result(tick, given, log, printed, taken, actions, terminatedNow, error, undefined, ranWith)
    }

    private result(tick: number, given: Record<string, Value>, log: TraceEvent[], printed: string[], taken: string[], actions: string[], terminatedNow: boolean, error: Diagnostic | undefined, vals?: RValue[], ranWith?: Record<string, Value>): SimTickResult {
        const s = this.state
        const report = this.exe.report(vals ?? s.vals, this.extra)
        const inputs: Record<string, Value> = {}
        for (const input of this.exe.inputs) {
            const key = input.v.role === 'value' && input.v.of ? input.v.of.name + '_val' : input.name
            const v = report.pool[key]
            inputs[input.v.role === 'value' && input.v.of ? input.v.of.name : input.name] = v === undefined ? null : (v as Value)
        }
        for (const [k, v] of Object.entries(given)) if (!(k in inputs)) inputs[k] = v
        const r: SimTickResult = {
            tick,
            inputs,
            ranWith: ranWith ?? this.exe.inputValues(vals ?? s.vals),
            values: report.values,
            present: report.present,
            active: this.tracker.activeStates(),
            entered: [...this.tracker.entered],
            exited: [...this.tracker.exited],
            taken,
            actions,
            terminated: s.terminated,
            terminatedNow,
            log,
            printed,
            pool: report.pool,
            trace: report.trace,
        }
        const copies = copyStates(this.exe.compiled, this.tracker.activeInternal(), this.tracker.enteredInternal)
        if (copies) r.copies = copies
        if (error) r.error = error
        return r
    }

    /** A par-or join fired: the state's regions stop (abort regions, preemption.md P-62), in source terms. */
    private parOrEvents(j: JoinGuard, act: Uint8Array): TraceEvent[] {
        if (!j.state) return []
        const out: TraceEvent[] = []
        const done = j.threads.find(t => t.exit >= 0 && act[t.exit] === 1)
        const name = this.names.name(j.state)
        const region = done?.region ? this.regionNames.get(done.region) : undefined
        const abort = done?.region ? this.abortRegions.has(done.region) : false
        const exited = this.tracker.stopRegions(j.state)
        const say = (c: (s: string) => string) => !done?.region
            ? `The regions of ${c(name)} that are not abort regions all finished. ${c(name)} has abort regions, so it is done: they stop.`
            : abort
                ? `The abort region ${region ? `${c(region)} ` : ''}of ${c(name)} finished, so ${c(name)} is done: its other regions stop.`
                : `${region ? `Region ${c(region)}` : 'A region'} of ${c(name)} finished. ${c(name)} has abort regions, so it is done as soon as any of its regions finishes: the others stop.`
        out.push({ kind: 'note', related: [j.state, ...(done?.region ? [done.region] : [])], text: say(x => x), markdown: say(x => '`' + x + '`') })
        for (const id of exited) out.push({ kind: 'exit', state: id })
        return out
    }

    /** KIELER's taken-transition counts for a tick (index order of Taken Transition Signaling). */
    takenCounts(result: TickResult): number[] {
        const order = this.exe.compiled.lowered.takenOrder
        const counts = order.map(() => 0)
        for (const id of result.taken) {
            const i = order.indexOf(id)
            if (i >= 0) counts[i]++
        }
        return counts
    }

    get knownTransitions(): Set<string> {
        return this.takenIds
    }
}

/** The Taken Transition Signaling mark of a transition (its first effect, lower.ts). */
function takeMark(t: CTransition | undefined): Extract<import('./model').Mark, { kind: 'take' }> | undefined {
    const f = t?.effects.find(e => e.k === 'mark' && e.m.kind === 'take')
    return f?.k === 'mark' && f.m.kind === 'take' ? f.m : undefined
}

function lowermost(r: CRef): CRef {
    let x = r
    while (x.sub) x = x.sub
    return x
}

/** A conditional without an else part (`c ? a`) anywhere in the expression. */
function hasConditionalWithoutElse(e: CExpr): boolean {
    let found = false
    walkExpr(e, x => { if (x.k === 'op' && x.op === '?:' && x.args.length === 2) found = true })
    return found
}

function hasValueEmission(log: TraceEvent[], signal: string): boolean {
    const last = log[log.length - 1]
    return last?.kind === 'emit' && last.signal === signal
}

function joinFires(j: JoinGuard, act: Uint8Array): boolean {
    if (j.sync === 'instantaneous') return j.first >= 0 && act[j.first] === 1
    // ParOrSynchronizer: any live thread exit.
    if (j.sync === 'any') return j.threads.some(t => t.exit >= 0 && act[t.exit] === 1)
    let anyExit = false
    for (const t of j.threads) {
        if (t.exit >= 0 && act[t.exit]) {
            anyExit = true
            continue
        }
        // Not exiting now: the thread must be empty (no pause reached now / no pause resumed now).
        for (const w of t.watch) if (act[w]) return false
    }
    return anyExit
}

export { convert, type Span }

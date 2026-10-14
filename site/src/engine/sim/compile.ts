// From a resolved, validated chart to an executable model: lowering (lower.ts), KIELER's desugaring passes
// (passes/), the SCG (scg.ts), the dependency analysis (deps.ts) and KIELER's acceptance test and schedule
// (analysis.ts). Everything KIELER rejects at this stage becomes an error diagnostic in source terms.

import type { Declaration, Diagnostic, SclStatement, Span, State } from '../types'
import type { ModelIndex } from '../parser/resolve'
import { lowerChart, type LowerResult } from './lower'
import { PIPELINE, type PassContext } from './passes'
import { buildSCG, cloneSCG, successors, type SCG, type SNode } from './scg'
import { abortRegionsSCG } from './abortRegions'
import { concurrentThreads, dependencies, dependencyReach, type Access, type Dependency } from './deps'
import { analyse, liveNodes, type Analysis } from './analysis'
import { conditionalWithoutElse, checkCodegen } from './codegen'
import { removeSuperfluousForks } from './sfr'
import { constantIndexWarnings } from './memory'
import { droppedIndexDiagnostics, droppedIndexRefs } from './guardIndices'
import { inlineMethods, isInlined } from './structure/methods'
import { goBlock, goBlockDiagnostics, type GoBlock } from './goblock'
import { formatExpression } from '../format'
import { allActionSites, allScopes, allStates, effectExprs, readableName, walkExpr, type CEffect, type CExpr, type CState, type CStmt, type CVar } from './model'

export interface CompiledChart {
    /** KIELER accepts the chart (no error diagnostics). */
    ok: boolean
    /** The simulator can run it: accepted and no construct it does not support (code 'unsupported'). */
    runnable: boolean
    diagnostics: Diagnostic[]
    chart: State
    lowered: LowerResult
    /** The core chart after all passes. */
    core: CState
    scg: SCG
    deps: Dependency[]
    accesses: Map<SNode, Access[]>
    analysis: Analysis
    /** Tick 1's straight-line start (KIELER's GO block). */
    goBlock: GoBlock
    /** Milliseconds spent (for the performance targets). */
    timing: { lower: number; passes: number; scg: number; analysis: number }
    /** What the passes left for the executor (structure.md: the tracker's view of references and for-region copies). */
    shared: Record<string, unknown>
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function compileChart(chart: State, index: ModelIndex | undefined): CompiledChart {
    const diagnostics: Diagnostic[] = []
    const t0 = now()
    const lowered = lowerChart(chart, index)
    const t1 = now()
    for (const p of lowered.problems) {
        diagnostics.push({ severity: 'error', code: 'internal', message: p.message, span: p.span })
    }
    diagnostics.push(...lowered.reports)

    const ctx: PassContext = {
        root: lowered.root,
        config: { finalRegions: false },
        vars: lowered.vars,
        report: d => diagnostics.push(d),
        // The resolved model of every file (the Reference pass instantiates other charts).
        shared: { index },
    }
    for (const pass of PIPELINE) {
        if (pass.run) {
            pass.run(ctx)
            continue
        }
        const uses = pass.uses?.(lowered.root) ?? []
        if (uses.length) {
            const first = uses[0]
            diagnostics.push({
                // Not a rejection: KIELER runs this chart, only the guide's simulator cannot (yet).
                severity: 'info', code: 'unsupported',
                message: `The guide's simulator cannot run ${first.what} yet`,
                span: first.span,
                related: uses.flatMap(u => u.related ?? []),
                hint: `This needs KIELER's ${pass.name} transformation, which the simulator does not implement yet. The official KIELER tools can run this chart.`,
            })
        }
    }
    // An expression the lowering could not represent would only fail when a tick evaluates it: say so now.
    if (!diagnostics.some(d => d.severity === 'error' || d.code === 'unsupported')) diagnostics.push(...leftovers(lowered.root))
    const t2 = now()
    // Constructs the passes could not remove make everything after this unreliable: KIELER would analyse a different
    // graph. Report only that the chart cannot be simulated yet.
    const unsupported = diagnostics.some(d => d.code === 'unsupported')

    if (unsupported) {
        // What gcc is known to reject still rejects the chart, host code or not (S-72).
        diagnostics.push(...checkCodegen(lowered.root))
        const scg: SCG = { nodes: [], threads: [], root: undefined as never, stateNodes: new Map(), problems: [], seq: 0 }
        const analysis: Analysis = { pathTypes: new Map(), loops: [], cured: [], joins: new Map(), cycles: [], order: [], deps: [], lostTerminations: [], ambiguous: false, decisions: [], curedAt: [], preemption: new Map() }
        if (index) for (const d of diagnostics) if (!d.span) d.span = locate(d.related, index)
        return {
            ok: !diagnostics.some(d => d.severity === 'error'), runnable: false, diagnostics, chart, lowered, core: lowered.root,
            scg, deps: [], accesses: new Map(), analysis, goBlock: { nodes: [], moved: new Set() },
            timing: { lower: t1 - t0, passes: t2 - t1, scg: 0, analysis: 0 }, shared: ctx.shared,
        }
    }

    diagnostics.push(...checkCodegen(lowered.root))
    diagnostics.push(...randomizeInclude(chart, index))
    const clashes = labelClashes(chart)
    diagnostics.push(...constantIndexWarnings(lowered.root, chart, lowered.takenOrder.length))

    const scg = buildSCG(lowered.root, lowered.takenOrder.length)
    const sameBranches = scg.problems.find(p => p.message === 'same-branches')
    if (sameBranches) {
        const st = sameBranches.states[0]
        const id = st?.origin ?? st?.about
        const name = (id ? index?.states.get(id)?.name : undefined) ?? readableName(st)
        diagnostics.push({
            severity: 'warning', code: 'kieler-quirk', related: id ? [id] : undefined,
            message: `KIELER's compiled code for ${name ? `\`${name}\`` : 'this state'} only follows a transition without trigger when the transition before it (to the same place) holds, so that default path is never taken alone`,
            hint: 'This is a defect of KIELER\'s netlist compiler: a condition whose two branches lead to the same place keeps the condition on both. It shows up when a superstate has several delayed strong aborts and the last has no trigger. The guide shows what KIELER does; giving every abort a trigger avoids it.',
        })
    }
    for (const p of scg.problems) {
        if (p.message !== 'conditional-pattern') continue
        const state = p.states[0]
        const id = state.origin ?? state.about
        diagnostics.push({
            severity: 'error', code: 'kieler-crash', related: id ? [id] : undefined,
            message: 'KIELER\'s compiler crashes on this chart: after its rewriting, a state has four or more outgoing transitions starting with an immediate triggered one followed by an immediate default',
            kieler: p.kieler,
            hint: 'This comes from KIELER\'s Surface/Depth transformation. Reordering the transitions of the superstate (or of the state) usually avoids it.',
        })
        break
    }
    // KIELER's SCGAbortRegionProcessor, then its SCG clean-ups (superfluous threads and forks), before everything else
    // that looks at the SCG.
    const abortRegionProblems = abortRegionsSCG(scg, id => index?.states.get(id)?.name)
    diagnostics.push(...abortRegionProblems)
    diagnostics.push(...removeSuperfluousForks(scg, lowered.root))
    // KIELER's Methods processor (scg/processors/MethodProcessor.xtend) inlines simple methods into the SCG.
    diagnostics.push(...inlineMethods(scg))
    diagnostics.push(...crashingClashes(clashes, scg, lowered.root))
    diagnostics.push(...conditionalWithoutElse(scg.nodes))
    diagnostics.push(...conditionKeepsResult(scg))
    diagnostics.push(...droppedIndices(scg))
    diagnostics.push(...orderDependentUpdates(scg))
    const go = goBlock(scg)
    diagnostics.push(...goBlockDiagnostics(go))
    // KIELER's search for accesses ends at a flow into a state without nodes (deps.ts dependencyReach).
    const reach = dependencyReach(scg)
    const { deps, accesses } = dependencies(scg.nodes, reach?.stop ? reach.reached : undefined, isInlined)
    const unordered = reach ? lostDependencies(reach, deps, scg, index) : []
    if (reach?.crash) diagnostics.push(...unordered)
    // The curing changes the graph; keep a copy in case the order of cures needs a second look (nondeterminism).
    const pristine = scg.nodes.filter(n => n.kind === 'fork').length > 1 ? snapshot(scg, deps, accesses) : undefined
    const t3 = now()
    const analysis = analyse({ scg, deps })
    const t4 = now()

    // SimpleGuardTransformation orders the threads of a sequential fork (a state with abort regions) through their
    // guard nodes; a fork that can never be reached (dead: its state is entered only by a join that never fires) has
    // none, and KIELER throws (probes preemption/probe-abort-region-dead-*).
    const alive = liveNodes(scg)
    const deadSequential = scg.nodes.find(n => n.kind === 'fork' && n.preemptive && (n.threads?.length ?? 0) > 1 && !alive.has(n))
    if (deadSequential && !analysis.failure && !diagnostics.some(d => d.code === 'kieler-crash')) {
        const id = sourceState(deadSequential.state)
        const name = (id && index?.states.get(id)?.name) ?? readableName(deadSequential.state) ?? 'A state'
        diagnostics.push({
            severity: 'error', code: 'kieler-crash', related: id ? [id] : undefined,
            message: `KIELER's compiler crashes on this chart: \`${name}\` has abort regions but can never be entered`,
            kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.keffects.Linkable.getOutgoingLinks()" because "linkable" is null (SimpleGuardTransformation)',
            hint: `KIELER orders the regions of a state with abort regions in its compiled code, but \`${name}\` has no code: the only way into it is a \`join to\` that can never fire (a region without a final state) or a state that is never entered. Make \`${name}\` reachable, or remove its abort regions.`,
        })
    }
    // LoopAnalyzerV2: a sequential (preemptive) fork, a state with abort regions, in an instantaneous loop.
    const sequentialInLoop = analysis.loops.flat().find(n => n.kind === 'fork' && n.preemptive)
    if (sequentialInLoop) {
        const id = sequentialInLoop.state?.origin ?? sequentialInLoop.state?.about
        const name = (id && index?.states.get(id)?.name) ?? sequentialInLoop.state?.name ?? 'A state'
        diagnostics.push({
            severity: 'error', code: 'abort-region-loop', related: id ? [id] : undefined,
            message: `\`${name}\` has abort regions and can be left and entered again in the same tick: KIELER cannot compile that`,
            kieler: 'Sequential forks must not be schizophrenic!',
            hint: `KIELER runs the regions of a state with abort regions one after the other and cannot untangle such a state when it restarts within a tick. Make the transition that re-enters \`${name}\` delayed, or make the abort regions ordinary regions.`,
        })
    }
    diagnostics.push(...loopDiagnostics(analysis, accesses, lowered, index))
    for (const lost of dedupeLost(analysis.lostTerminations)) {
        const t = lost.node.transition!
        // The superstate the transition finishes: the source state's parent, in the chart as written.
        const source = index?.states.get(t.origin!.replace(/->\d+$/, ''))
        const region = source ? index?.parentRegion.get(source) : undefined
        const superstate = region ? index?.parentState.get(region) : undefined
        const name = superstate?.name ? `\`${superstate.name}\`` : 'the superstate'
        diagnostics.push({
            severity: 'warning', code: 'kieler-quirk', span: t.span,
            related: [t.origin!, ...(superstate ? [superstate.id] : [])],
            message: `If ${name} is entered again in the tick it was left (for example by a reset), KIELER does not let it finish in that tick through this transition`,
            hint: 'KIELER copies the superstate\'s first-tick behaviour to break the instantaneous loop, and the copy cannot reach the final state. The guide shows what KIELER does. Make the transition delayed, or reset with a delayed transition, to avoid it.',
        })
    }
    if (analysis.failure) {
        diagnostics.push({
            severity: 'error', code: 'kieler-crash', message: 'KIELER\'s compiler fails on this chart (it cannot untangle a superstate that is left and re-entered in the same tick)',
            kieler: analysis.failure,
        })
    }
    diagnostics.push(...nondeterminism(analysis, pristine, lowered, index))
    // (Not worth a warning when the chart is rejected anyway.)
    if (reach && !reach.crash && !diagnostics.some(d => d.severity === 'error')) diagnostics.push(...unordered)

    // P-20's note explains how KIELER runs a strong abort whose trigger the inside writes; when KIELER rejects the
    // chart for its trigger (abort-trigger-cycle), the note would contradict the error.
    if (diagnostics.some(d => d.code === 'abort-trigger-cycle')) {
        for (let i = diagnostics.length - 1; i >= 0; i--) if (diagnostics[i].code === 'kieler-quirk' && /^This strong abort reads /.test(diagnostics[i].message)) diagnostics.splice(i, 1)
    }
    if (index) for (const d of diagnostics) if (!d.span) d.span = locate(d.related, index)
    const ok = !diagnostics.some(d => d.severity === 'error')
    return {
        ok,
        runnable: ok && !diagnostics.some(d => d.code === 'unsupported'),
        diagnostics,
        chart,
        lowered,
        core: lowered.root,
        scg,
        deps,
        accesses,
        analysis,
        goBlock: go,
        timing: { lower: t1 - t0, passes: t2 - t1, scg: t3 - t2, analysis: t4 - t3 },
        shared: ctx.shared,
    }
}

// ---------------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------------

/**
 * KIELER looks up the label of a `goto` by name among the labels whose innermost named container (a state, a named
 * region, a class) is the goto's, in eAllContents order, and takes the first (Xtext's scoping, with qualified names
 * from SCTXQualifiedNameProvider; methods and code blocks have no name): two code blocks or methods of one state (its
 * methods, actions and outgoing transitions; the chart's for the chart's methods) with a label of the same name make a
 * later block's `goto` jump into the earlier block, whose label the later block's graph does not have, and KIELER's
 * compiler crashes on the flow without target (lab: "The compiler failed during compilation setup.", official 0.3.0
 * never answers). Probes kieler/rare/probe-label-*.
 */
function labelClashes(chart: State): LabelClash[] {
    type Body = { statements: SclStatement[]; owner: string; span: Span }
    const out: LabelClash[] = []
    const check = (bodies: Body[], container: string) => {
        const labels: { name: string; body: number }[] = []
        const gotos: { target: string; body: number; span: Span }[] = []
        const walk = (list: SclStatement[], body: number) => {
            for (const st of list) {
                switch (st.kind) {
                    case 'label': labels.push({ name: st.name, body }); break
                    case 'goto': gotos.push({ target: st.target, body, span: st.span }); break
                    case 'block': walk(st.statements, body); break
                    case 'if': walk(st.statements, body); if (st.else) walk(st.else.statements, body); break
                    case 'while': case 'for': walk(st.statements, body); break
                    default: break
                }
            }
        }
        bodies.forEach((b, i) => walk(b.statements, i))
        for (const g of gotos) {
            const first = labels.find(l => l.name === g.target)
            if (!first || first.body === g.body) continue
            out.push({
                body: bodies[g.body].span,
                diagnostic: {
                    severity: 'error', code: 'kieler-crash', span: g.span, related: [bodies[g.body].owner],
                    message: `KIELER's compiler crashes on this chart: \`goto ${g.target}\` finds the label \`${g.target}\` of another code block or method of \`${container}\``,
                    kieler: 'The compiler failed during compilation setup.',
                    hint: `KIELER looks a goto's label up among all labels of the state the block belongs to (its methods, actions and transitions) and takes the first one, which is in an earlier block. Give the labels of each block names of their own (\`${g.target}1\`, \`${g.target}2\`).`,
                },
            })
            return
        }
    }
    const methods = (decls: Declaration[], owner: string, into: Body[]) => {
        for (const d of decls) {
            if (d.declKind === 'method' && d.body) into.push({ statements: d.body.statements, owner, span: d.span })
            // A class is a named container of its own.
            if ((d.declKind === 'class' || d.declKind === 'struct') && d.members) {
                const own: Body[] = []
                methods(d.members, owner, own)
                check(own, d.className ?? d.valuedObjects[0]?.name ?? owner)
            }
        }
    }
    const codes = (effects: { kind: string; statements?: SclStatement[]; span?: Span }[], owner: string, into: Body[]) => {
        for (const f of effects) if (f.kind === 'code' && f.statements) into.push({ statements: f.statements, owner, span: (f as { span: Span }).span })
    }
    const visit = (st: State) => {
        const bodies: Body[] = []
        methods(st.declarations, st.id, bodies)
        for (const a of st.actions) codes(a.effects, a.id, bodies)
        for (const r of st.regions) {
            // An unnamed region is no container: its methods and actions are the state's.
            const rb: Body[] = r.name ? [] : bodies
            methods(r.declarations, r.id, rb)
            for (const a of r.actions) codes(a.effects, a.id, rb)
            if (r.name) check(rb, r.name)
            r.states.forEach(visit)
        }
        for (const t of st.transitions) codes(t.effects, t.id, bodies)
        check(bodies, st.name)
    }
    visit(chart)
    return out
}

/** A `goto` that finds another body's label (labelClashes), and the span of the body it is in. */
interface LabelClash {
    body: Span
    diagnostic: Diagnostic
}

/**
 * The label clashes KIELER crashes on: its ThreadAnalyzer meets the flow without target when it walks the graph from
 * a thread's entry, so a body copied into the graph crashes only where control can reach it (a block of a state that
 * is never entered does not: fuzz campaign 10); a method compiled as a C function has a graph of its own and always
 * does.
 */
function crashingClashes(clashes: LabelClash[], scg: SCG, root: CState): Diagnostic[] {
    if (!clashes.length) return []
    const methods = new Map<number, CVar>()
    for (const scope of allScopes(root)) for (const v of scope.decls) if (v.method?.span) methods.set(v.method.span.start, v)
    // Control flow from the root's entry (pauses included, as getAllThreadNodesAndThreads walks them).
    const reached = new Set<SNode>()
    const work: SNode[] = [scg.root.entry]
    while (work.length) {
        const n = work.pop()!
        if (reached.has(n)) continue
        reached.add(n)
        for (const m of [n.next, n.then, n.else, n.join, n.depth, ...(n.threads ?? []).map(t => t.entry)]) if (m && !reached.has(m)) work.push(m)
    }
    const out: Diagnostic[] = []
    for (const c of clashes) {
        const v = methods.get(c.body.start)
        if (!v?.method) continue
        if (!isInlined(v.method) || scg.nodes.some(n => n.method?.name === v.name && reached.has(n))) out.push(c.diagnostic)
    }
    return out.slice(0, 1)
}

/**
 * `x += (c) ? e` is `x += c ? e : x` in KIELER's C code, which reads x; KIELER's model has no such read, so it treats
 * the update as commuting with a concurrent update of x and orders the two as its scheduler happens to, and the
 * result depends on that order (fuzz campaign 11, polish-111-22: the guide's schedule and KIELER's differ there). A
 * kieler-quirk warning, since the guide cannot promise KIELER's order.
 */
function orderDependentUpdates(scg: SCG): Diagnostic[] {
    const out: Diagnostic[] = []
    const writes = scg.nodes.filter(n => n.kind === 'assign' && n.effect?.k === 'assign')
    for (const n of writes) {
        const f = n.effect as Extract<CEffect, { k: 'assign' }>
        if (f.op === '=' || !f.expr) continue
        let selfRead = false
        walkExpr(f.expr, x => { if (x.k === 'op' && x.op === '?:' && x.args.length === 2) selfRead = true })
        if (!selfRead) continue
        const other = writes.find(m => m !== n && (m.effect as typeof f).ref.v === f.ref.v && concurrentThreads(n.thread, m.thread))
        if (!other) continue
        const name = f.ref.v.display ?? f.ref.v.name
        const line = (other.effect as typeof f).o.span?.line
        out.push({
            severity: 'warning', code: 'kieler-quirk', span: f.o.span, related: f.o.by ? [f.o.by] : undefined,
            message: `KIELER's C code for this update reads \`${name}\` (the missing else part is \`${name}\`), but KIELER does not see the read: it orders it freely against the concurrent update of \`${name}\`${line ? ` (line ${line})` : ''}, and the result depends on that order`,
            hint: `The guide's simulation runs the two in the order it computes for KIELER's scheduler, which can differ from KIELER's in such a case. Write the else part (\`${name} ${f.op} (c) ? e : 0\`) so that the update does not read \`${name}\`.`,
        })
        break
    }
    return out
}

/** Conditions whose array indices KIELER's C code drops (guardIndices.ts): one diagnostic per source condition. */
function droppedIndices(scg: SCG): Diagnostic[] {
    const out: Diagnostic[] = []
    const seen = new Set<string>()
    const alive = liveNodes(scg)
    for (const n of scg.nodes) {
        if (n.kind !== 'cond' || !n.expr || !alive.has(n)) continue
        const dropped = droppedIndexRefs(n.expr)
        if (!dropped.size) continue
        const first = [...dropped][0]
        const key = `${first.span?.start ?? n.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const by = n.method ? undefined : n.transition?.origin ?? n.transition?.about
        out.push(...droppedIndexDiagnostics(n.expr, dropped, v => v.display ?? v.name, by ? [by] : undefined))
    }
    return out
}

/**
 * A conditional without an else part in a condition (a trigger, an `if` of a copied method body): KIELER keeps the
 * condition's previous result when the conditional's condition is false (exec.ts, ExprCompiler.selves; probes
 * kieler/rare/probe-cond-noelse-*). A kieler-quirk info per conditional.
 */
function conditionKeepsResult(scg: SCG): Diagnostic[] {
    const out: Diagnostic[] = []
    const seen = new Set<string>()
    const name = (e: CExpr): string | undefined => (e.k === 'ref' && !e.idx.length && !e.sub ? e.v.display ?? e.v.name : e.k === 'lit' ? String(e.v) : undefined)
    for (const n of scg.nodes) {
        if (n.kind !== 'cond' || !n.expr) continue
        walkExpr(n.expr, x => {
            if (x.k !== 'op' || x.op !== '?:' || x.args.length !== 2) return
            const key = x.span ? `${x.span.start}` : `${n.id}`
            if (seen.has(key)) return
            seen.add(key)
            const [c, a] = [name(x.args[0]), name(x.args[1])]
            const text = c && a ? `\`(${c}) ? ${a}\`` : 'This conditional without an else part'
            const cond = c ? `\`${c}\`` : 'its condition'
            const by = n.method ? undefined : n.transition?.origin ?? n.transition?.about
            out.push({
                severity: 'info', code: 'kieler-quirk', span: x.span, related: by ? [by] : undefined,
                message: `${text} has no else part, so when ${cond} is false KIELER keeps the result this ${n.method ? 'condition' : 'trigger'} had when it was last computed`,
                hint: `KIELER computes every trigger in every tick, also while its state is not active, and keeps each result in a variable of its own: without an else part, a false ${cond} leaves that variable as it was (false until ${cond} first holds). The guide's simulation does the same. Write the else part to say what you mean${c && a ? `, such as \`(${c}) ? ${a} : false\`` : ''}.`,
            })
        })
    }
    return out
}

interface Snapshot { scg: SCG; deps: Dependency[]; accesses: Map<SNode, Access[]> }

/** A copy of the graph and its dependencies before the analysis changes them. */
function snapshot(scg: SCG, deps: Dependency[], accesses: Map<SNode, Access[]>): Snapshot {
    const { scg: copy, map } = cloneSCG(scg)
    const m = (n: SNode) => map.get(n) ?? n
    const accessCopy = new Map<Access, Access>()
    const acc = (a: Access) => {
        let c = accessCopy.get(a)
        if (!c) accessCopy.set(a, (c = { ...a, node: m(a.node) }))
        return c
    }
    return {
        scg: copy,
        deps: deps.map(d => ({ ...d, from: m(d.from), to: m(d.to), a: acc(d.a), b: acc(d.b) })),
        accesses: new Map([...accesses].map(([n, list]) => [m(n), list.map(acc)])),
    }
}

/**
 * KIELER cures one schizophrenic superstate at a time; when several qualify, it takes the first in a hash map of EMF
 * objects (StructuralDepthJoinProcessor, ThreadData.forkMap), whose order is fixed within a run and changes from run
 * to run. The analysis follows node order; when it had such a choice, the other orders are tried too (analysis.ts
 * AnalysisInput.script: first each single change of one choice, then the paths through the choices depth first, up to
 * MAX_ORDERS analyses). If KIELER accepts the chart with
 * some orders and rejects it with others, the guide rejects it (it may fail in KIELER). If every order is accepted
 * but they untangle different superstates, KIELER's behaviour can change from run to run: an info says so.
 */
const MAX_ORDERS = 24

function nondeterminism(analysis: Analysis, pristine: Snapshot | undefined, lowered: LowerResult, index: ModelIndex | undefined): Diagnostic[] {
    if (!analysis.decisions.length || !pristine) return []
    const accepts = (a: Analysis) => !a.cycles.length && !a.failure
    const signature = (a: Analysis) => `${[...a.curedAt].sort((x, y) => x - y).join(',')}|${a.lostTerminations.length}`
    let other: Analysis | undefined
    let otherAccesses = pristine.accesses
    let differs: Analysis | undefined
    const tried = new Set<string>([''])
    const tryScript = (script: number[]) => {
        const key = script.join(',')
        if (tried.has(key)) return undefined
        tried.add(key)
        const run = snapshot(pristine.scg, pristine.deps, pristine.accesses)
        const result = analyse({ scg: run.scg, deps: run.deps, script })
        if (accepts(result) !== accepts(analysis)) {
            other = result
            otherAccesses = run.accesses
        } else if (!differs && accepts(result) && signature(result) !== signature(analysis)) {
            differs = result
        }
        return result
    }
    // First every single change of one choice, earliest first (which superstate is cured first matters most; with many
    // candidates the depth-first walk below would only reach the last choices), then the paths depth first.
    const first = analysis.decisions
    for (let k = 0; k < first.length && tried.size < MAX_ORDERS && !other; k++) {
        for (let alt = 1; alt < first[k] && tried.size < MAX_ORDERS && !other; alt++) tryScript([...Array.from({ length: k }, () => 0), alt])
    }
    let script: number[] = []
    let counts = analysis.decisions
    for (let guard = 0; tried.size < MAX_ORDERS && !other && guard < 10_000; guard++) {
        // The next path through the choices (depth first, in node order).
        let k = counts.length - 1
        while (k >= 0 && (script[k] ?? 0) + 1 >= counts[k]) k--
        if (k < 0) break
        script = [...Array.from({ length: k }, (_, i) => script[i] ?? 0), (script[k] ?? 0) + 1]
        const result = tryScript(script)
        if (result) counts = result.decisions
    }
    const sourceIds = (list: Analysis[]) => [...new Set(list.flatMap(a => a.cured).map(f => sourceState(f.state)).filter((x): x is string => !!x))]
    if (!other) {
        if (!differs) return []
        const ids = sourceIds([analysis, differs])
        const names = ids.map(id => index?.states.get(id)?.name).filter((x): x is string => !!x).map(n => `\`${n}\``)
        return [{
            severity: 'info', code: 'kieler-quirk', related: ids.length ? ids : undefined,
            message: 'KIELER may run this chart differently from one compilation to the next',
            hint: `${names.length > 1 ? `${names.join(' and ')} are` : 'Several superstates are'} left and entered again within one tick. KIELER untangles them one at a time, in an order that changes from run to run, and the orders give the chart different behaviour (for example an immediate transition that fires in some runs and not in others). The guide shows one of them. Making the transitions that re-enter these states delayed makes the chart reliable.`,
        }]
    }
    const ids = sourceIds([analysis, other])
    const names = ids.map(id => index?.states.get(id)?.name).filter((x): x is string => !!x).map(n => `\`${n}\``)
    const out: Diagnostic[] = [{
        severity: 'error', code: 'kieler-nondeterministic', related: ids.length ? ids : undefined,
        message: 'KIELER\'s compiler accepts this chart in some runs and rejects it in others',
        kieler: (accepts(analysis) ? other : analysis).failure ?? 'The SCG is NOT asc-schedulable! (in some runs)',
        hint: `${names.length > 1 ? `${names.join(' and ')} are` : 'Several superstates are'} left and entered again within one tick. KIELER untangles them one at a time, in an order that changes from run to run, and only some orders work. Making the transitions that re-enter them delayed (or giving them a trigger) makes the chart reliable.`,
    }]
    // The reason it fails in the runs that reject it.
    if (accepts(analysis)) out.push(...loopDiagnostics(other, otherAccesses, lowered, index).filter(d => d.severity === 'error'))
    return out
}

/**
 * randomize() is srand(time(NULL)), and current KIELER includes <stdlib.h> in its C code only for random() (basics.md
 * B-29, structure.md S-50): a chart that seeds without calling random() anywhere fails in gcc, unless a `#hostcode`
 * pragma includes the header.
 */
function randomizeInclude(chart: State, index: ModelIndex | undefined): Diagnostic[] {
    const programs = index?.programs ?? []
    let seed: Span | undefined
    let random = false
    const visit = (value: unknown) => {
        if (random) return
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (!value || typeof value !== 'object') return
        const obj = value as Record<string, unknown>
        if (obj.kind === 'random') { random = true; return }
        if (obj.kind === 'randomize' && !seed) seed = obj.span as Span
        for (const [k, v] of Object.entries(obj)) if (k !== 'span' && v && typeof v === 'object') visit(v)
    }
    visit(programs.length ? programs.flatMap(p => p.charts) : [chart])
    if (!seed || random) return []
    const included = programs.some(p => p.pragmas.some(pr => pr.name.toLowerCase().startsWith('hostcode') && pr.values.some(v => v.includes('stdlib.h'))))
    if (included) return []
    return [{
        severity: 'error', code: 'randomize-stdlib', span: seed,
        message: 'randomize() does not compile in KIELER here: its C code includes <stdlib.h> only for charts that also call random()',
        kieler: 'implicit declaration of function \u2018srand\u2019 [-Wimplicit-function-declaration]\nCompiler did not return success (exit value != 0)',
        hint: 'Add `#hostcode "#include <stdlib.h>"` at the top of the file, or call `random()` somewhere in the chart.',
    }]
}

/** Where to point a diagnostic that has no span of its own: the first related state (its name), region or transition. */
function locate(related: string[] | undefined, index: ModelIndex): Span | undefined {
    for (const id of related ?? []) {
        const state = index.states.get(id)
        if (state) return state.nameSpan ?? state.span
        const region = index.regions.get(id)
        if (region) return region.nameSpan ?? region.span
        const m = /^(.*)->(\d+)$/.exec(id)
        const t = m ? index.states.get(m[1])?.transitions[Number(m[2])] : undefined
        if (t) return t.span
    }
    // Inside a referenced chart's copy (`<reference state>/<id>`, structure/instance.ts): the reference state.
    const outer = (related ?? []).map(id => id.split('/')[0]).filter(id => !(related ?? []).includes(id))
    return outer.length ? locate(outer, index) : undefined
}

/** The source element a node implements: a source transition or action, or the state it belongs to. */
function nodeElement(n: SNode): string | undefined {
    const t = n.transition
    if (t?.origin) return t.origin
    if (t?.about) return t.about
    if (n.effect?.o.by) return n.effect.o.by
    return sourceState(n.state)
}

function sourceState(s: CState | undefined): string | undefined {
    return s?.origin ?? s?.about
}

/**
 * KIELER's search for accesses meets a flow into a state without nodes (deps.ts dependencyReach): it throws, or it
 * stops there and the variables whose concurrent accesses are left unordered get a warning (if there are any).
 */
function lostDependencies(reach: NonNullable<ReturnType<typeof dependencyReach>>, deps: Dependency[], scg: SCG, index: ModelIndex | undefined): Diagnostic[] {
    const id = sourceState(reach.into)
    const name = (id && index?.states.get(id)?.name) ?? reach.into?.name
    const state = name ? `the referenced chart's state \`${name}\`` : 'a state of a referenced chart'
    const dropped = 'In a referenced chart, KIELER drops a state whose first immediate transition goes back to it without a trigger (the transition has no take counter there), so that state has no code.'
    if (reach.crash) {
        return [{
            severity: 'error', code: 'kieler-crash', related: id ? [id] : undefined,
            message: `KIELER's compiler crashes on this chart: a transition leads into ${state}, which has no code`,
            kieler: 'java.lang.NullPointerException: Cannot invoke "de.cau.cs.kieler.kexpressions.keffects.Link.getTarget()" because "cf" is null (DependencyTransformationV2)',
            hint: `${dropped} Its dependency analysis then fails on the transition into it. Such a loop would not let the tick end anyway: give the transition a trigger, or make it delayed.`,
        }]
    }
    const key = (d: Dependency) => `${d.from.id}>${d.to.id}:${d.v.uid}:${d.kind}`
    const kept = new Set(deps.map(key))
    const lost = dependencies(scg.nodes, undefined, isInlined).deps.filter(d => !kept.has(key(d)))
    if (!lost.length) return []
    const vars = [...new Set(lost.map(d => say(d.v)))]
    const shown = vars.length > 3 ? `${vars.slice(0, 3).join(', ')} and others` : vars.length > 1 ? `${vars.slice(0, -1).join(', ')} and ${vars[vars.length - 1]}` : vars[0]
    return [{
        severity: 'warning', code: 'kieler-quirk', related: id ? [id] : undefined,
        message: `KIELER's dependency analysis stops at ${state}, so its compiled code leaves the accesses to ${shown} in concurrent regions unordered: a read may come before a write in another region and see the value from before it`,
        hint: `${dropped} Its dependency analysis walks the compiled graph and stops at the first region that starts in such a state; everything it has not reached by then is scheduled without dependencies. The guide shows what KIELER does. Giving that transition a trigger, or making it delayed, avoids it.`,
    }]
}

function varName(v: CVar): string {
    return v.display ?? v.name
}

/** A variable in a message or hint (inline Markdown): its name in code font, or what a compiler helper is for. */
function say(v: CVar): string {
    const shown = varName(v)
    return !v.generated || /^[\w$.'^[\]]+$/.test(shown) ? `\`${shown}\`` : shown
}

/** A list in a sentence: "a", "a and b", "a, b and c". */
function quote(lines: string[]): string {
    return lines.length < 2 ? lines.join('') : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`
}

function dedupeLost(list: Analysis['lostTerminations']): Analysis['lostTerminations'] {
    const seen = new Set<string>()
    return list.filter(l => {
        const key = `${l.thread.id}:${l.node.transition?.origin}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function loopDiagnostics(analysis: Analysis, accesses: Map<SNode, Access[]>, lowered: LowerResult, index?: ModelIndex): Diagnostic[] {
    const out: Diagnostic[] = []
    void lowered
    void accesses
    if (analysis.loops.length && !analysis.cycles.length) {
        const lost = analysis.lostTerminations.length > 0
        // The superstates that are left and entered again (the cured forks), else the states on the loop.
        const forks = analysis.cured.length ? analysis.cured : analysis.loops.flat().filter(n => n.kind === 'fork')
        const related = [...new Set((forks.length ? forks : analysis.loops.flat()).map(n => sourceState(n.state)).filter((x): x is string => !!x))]
        out.push({
            severity: 'info', code: 'kieler-loop-warning', related: related.length ? related : undefined,
            message: lost
                ? 'KIELER warns about a potential instantaneous loop here: a superstate can be left and entered again in the same tick'
                : 'KIELER warns about a potential instantaneous loop here, but compiles and runs the chart correctly',
            kieler: 'Instantaneous loop detected!',
            hint: lost
                ? 'KIELER compiles the chart by copying the superstate\'s first-tick behaviour; see the notes about the termination it loses.'
                : `${loopWarningReason(analysis, index)} The chart works as written. See [Instantaneous loop detected!](/reference/errors/#instantaneous-loop-detected).`,
        })
    }
    for (const cycle of analysis.cycles) out.push(cycleDiagnostic(cycle, analysis, index))
    return out
}

/**
 * Why KIELER's loop analysis warns about a chart that works: it looks at the compiled graph, in which count delays,
 * entry and exit actions, aborts of superstates and clocks are extra regions and transitions, and reports any
 * circle of control flow that one tick could go round, without looking at the triggers (or at the pauses that
 * delayed transitions add in the original chart). Names what the chart's loop goes through.
 */
function loopWarningReason(analysis: Analysis, index: ModelIndex | undefined): string {
    const nodes = analysis.loops.flat()
    const ids = new Set<string>()
    for (const n of nodes) {
        for (const id of [n.transition?.origin, n.transition?.about, n.transition?.checks, n.effect?.o.by, sourceState(n.state)]) if (id) ids.add(id)
    }
    const transitionOf = (id: string) => {
        const m = /^(.*)->(\d+)$/.exec(id)
        return m ? index?.states.get(m[1])?.transitions[Number(m[2]) - 1] : undefined
    }
    const kinds: string[] = []
    const add = (k: string) => { if (!kinds.includes(k)) kinds.push(k) }
    const sourceTransitions = [...ids].map(transitionOf).filter((t): t is NonNullable<typeof t> => !!t)
    if (sourceTransitions.some(t => (t.triggerDelay ?? 1) > 1)) add('count delays')
    const actionKinds = new Set([...ids].map(id => /!(entry|exit|during)\d+$/.exec(id)?.[1]).filter((k): k is string => !!k))
    if (actionKinds.size) add(`${[...actionKinds].sort((a, b) => ['entry', 'during', 'exit'].indexOf(a) - ['entry', 'during', 'exit'].indexOf(b)).join(' and ')} actions`)
    const vars = nodes.flatMap(n => (n.kind === 'assign' && n.effect?.k === 'assign' ? [n.effect.ref.v] : []))
    const timed = vars.some(v => v.name === 'sleepT' || v.type === 'clock' || v.display === 'the period\'s clock')
    if (vars.some(v => v.display === 'the period\'s clock')) add('periods')
    else if (timed) add('clocks (their timeouts and `sleepT`)')
    if (sourceTransitions.some(t => t.preemption === 'strong')) add('strong aborts')
    const name = (id: string | undefined) => (id ? index?.states.get(id) : undefined)
    const cured = [...new Set(analysis.cured.map(f => name(sourceState(f.state))).filter((s): s is State => !!s && !s.isRoot).map(s => `\`${s.name}\``))]
    const states = [...new Set([...ids].map(name).filter((s): s is State => !!s && !s.isRoot && !s.connector).map(s => `\`${s.name}\``))]
    if (cured.length && !kinds.length) {
        return `KIELER's loop check also warns about a superstate that a transition leaves and enters again in one tick, here ${quote(cured)}: in the compiled chart, leaving it and starting it again look like a circle, although the new start only enters its initial states and then waits for the next tick.`
    }
    const where = states.length && states.length <= 4 ? `: here the circle runs through ${quote(states)}` : ''
    const what = kinds.length ? `, in which ${quote(kinds)} are extra regions and transitions,` : ''
    return `KIELER's loop check works on the compiled chart${what} and warns whenever control could go round a circle there within one tick, without checking whether the triggers prevent it${where}.`
}

interface CycleEdge {
    from: SNode
    to: SNode
    v: CVar
    kind: Dependency['kind']
    a: Access
    b: Access
}

function cycleDiagnostic(cycle: SNode[], analysis: Analysis, index: ModelIndex | undefined): Diagnostic {
    const inCycle = new Set(cycle)
    const deps = analysisDeps(analysis).filter(d => inCycle.has(d.from) && inCycle.has(d.to))
    const related = [...new Set(cycle.map(nodeElement).filter((x): x is string => !!x))]
    const kieler = 'The SCG is NOT asc-schedulable!'
    const visible = deps.filter(d => !d.v.generated || d.v.of)
    // A backward `goto` in a body KIELER copied into the graph (structure/methods.ts inline): the jump is the circle.
    const back = cycle.find(n => n.method?.jumpsBack)?.method
    if (back?.jumpsBack) {
        const label = back.jumpsBack.label
        const block = back.name.startsWith('_effect') ? 'the code block' : `\`${back.name}\``
        return {
            severity: 'error', code: 'instantaneous-loop', span: back.jumpsBack.span, kieler, related,
            message: `\`goto ${label}\` jumps back to \`${label}\`, a loop within the tick that KIELER cannot schedule`,
            hint: `KIELER copies a short ${back.name.startsWith('_effect') ? 'code block' : 'method'} (no loop, no call, fewer than 28 statements) into the tick's code, and there a jump back is an instantaneous loop, which it rejects even when a condition ends it. To repeat something within a tick, write a \`for\` or \`while\` loop in ${block}: KIELER then compiles it as a C function, which may loop. To repeat it over several ticks, use a transition.`,
        }
    }
    if (!deps.length) {
        // Control flow only: a chain of immediate behaviour that can come back to where it started.
        const transitions = [...new Set(cycle.flatMap(n => (n.transition?.origin ? [n.transition.origin] : [])))]
        const states = [...new Set(cycle.map(n => sourceState(n.state)).filter((x): x is string => !!x))]
        const first = cycle.find(n => n.transition?.origin && n.transition.span)?.transition?.span ?? cycle.find(n => n.transition?.span)?.transition?.span ?? cycle.find(n => n.effect?.o.span)?.effect?.o.span
        const path = loopPath(transitions)
        return {
            severity: 'error', code: 'instantaneous-loop',
            message: path
                ? `The immediate transitions ${path} form a loop that could run for ever within one tick`
                : 'These immediate transitions form a loop that could run for ever within one tick',
            span: first,
            kieler,
            hint: 'Make one transition on the loop delayed (remove `immediate`): a tick must always end. KIELER rejects such a loop even if the triggers would stop it.',
            related: [...transitions, ...states].length ? [...transitions, ...states] : related,
        }
    }
    const conflict = visible.find(d => d.kind === 'write-write') ?? deps.find(d => d.kind === 'write-write')
    if (conflict) {
        const v = conflict.v.of ?? conflict.v
        const name = say(v)
        const plain = varName(v)
        const isSignal = conflict.v.role === 'curval' || conflict.v.role === 'value'
        const rel = [nodeElement(conflict.from), nodeElement(conflict.to)].filter((x): x is string => !!x)
        const spanA = conflict.a.span
        const spanB = conflict.b.span
        const relative = conflict.a.cls === 'relative' && conflict.b.cls === 'relative'
        // A declaration of a for-region: KIELER moves it out of the region, so every copy writes the same variable.
        const owner = v.decl ? index?.vos.get(v.decl)?.owner : undefined
        const forRegion = owner?.kind === 'region' && owner.forLoop ? owner : undefined
        if (forRegion && !relative && !isSignal) {
            const label = forRegion.name ? `the for-region \`${forRegion.name}\`` : 'the for-region'
            return {
                severity: 'error', code: 'write-conflict', span: spanA ?? spanB, kieler, related: [...new Set([...rel, ...related])],
                message: `The copies of ${label} assign different values to ${name}, which they share`,
                hint: `KIELER makes one copy of ${label} for each value of \`${forRegion.forLoop!.variable}\`, but a variable declared in the region is declared once, outside the copies: they all write the same ${name} in the same tick. Declare ${name} in a state inside the region (\`initial state W { int ${plain} = 0 ... }\`), or use an update such as \`${plain} += 1\`.`,
            }
        }
        // One side is inside a code block or method that KIELER calls as a C function (deps.ts innerAccesses).
        const inner = conflict.a.via !== undefined ? conflict.a : conflict.b.via !== undefined ? conflict.b : undefined
        if (inner && relative) {
            const block = inner.via!.startsWith('_effect') ? 'the code block' : `the method \`${inner.via}\``
            const other = inner === conflict.a ? conflict.b : conflict.a
            return {
                severity: 'error', code: 'update-conflict', span: inner.span ?? other.span, kieler, related: [...new Set([...rel, ...related])],
                message: `${name} is updated inside ${block}${inner.span ? ` (line ${inner.span.line})` : ''} and in a concurrent region${other.span ? ` (line ${other.span.line})` : ''}, and KIELER cannot combine the two`,
                hint: `KIELER does not copy ${block} into place (it has a loop, a call or too many statements) but calls it as a C function, and counts the call as one plain assignment of ${name}: that does not combine with \`${plain} ${other.op ?? '+='} ...\` in the other region. Write the update outside ${block === 'the code block' ? 'the block' : 'the method'}, on the transition itself, or let one region own ${name}.`,
            }
        }
        return {
            severity: 'error', code: relative ? 'update-conflict' : isSignal ? 'emission-conflict' : 'write-conflict',
            message: relative
                ? `${name} is updated in two concurrent regions with operators that do not combine (\`${conflict.a.op}\` and \`${conflict.b.op}\`)`
                : isSignal
                    ? `Two concurrent regions emit the valued signal ${name} with different values`
                    : `Two concurrent regions assign different values to ${name}`,
            span: spanA ?? spanB,
            kieler,
            hint: relative
                ? `Concurrent updates of one variable must commute: use only \`+=\` and \`-=\` (or only one operator) for ${name}.`
                : isSignal
                    ? `KIELER does not check whether the two emissions can happen in the same tick. Give ${name} a combine function (\`signal int ${plain} combine +\`), or emit it from one region only.`
                    : `KIELER does not check whether the two assignments can happen in the same tick: two regions that run side by side must not both assign ${name}. ${v.type === 'int' || v.type === 'float'
                        // Updates only cure a variable that adds up what the regions contribute (a count), not one that names an owner or a mode.
                        ? `Let one region own ${name}. If the regions add up contributions to ${name}, use an update such as \`${plain} += 1\` in both, or a valued signal with a combine function.`
                        : `Let one region own ${name}, and let the other regions send it requests with signals.`}`,
            related: [...new Set([...rel, ...related])],
        }
    }
    // A read/write cycle: each side waits for the other.
    const reads = deps.filter(d => d.kind === 'write-read' || d.kind === 'relative-read')
    const resetLoop = countDelayResetLoop(deps, index)
    if (resetLoop) return { severity: 'error', kieler, ...resetLoop, related: [...new Set([...(resetLoop.related ?? []), ...related])] }
    const span = reads.find(d => d.b.span)?.b.span ?? deps.find(d => d.b.span)?.b.span ?? deps[0]?.a.span
    const valued = deps.find(d => d.v.role === 'value')
    if (valued && valued.v.of) {
        const name = varName(valued.v.of)
        return {
            severity: 'error', code: 'val-cycle', span: valued.b.span ?? span, kieler, related,
            message: `\`val(${name})\` is read to emit \`${name}\` in the same tick, but \`val(${name})\` has to wait for every emission of \`${name}\``,
            hint: `To build on the value of \`${name}\`, use last tick's value: \`${name}(pre(val(${name})) + 1)\`.`,
        }
    }
    const preemption = preemptionCycle(cycle, deps, index)
    if (preemption) return { severity: 'error', kieler, related, ...preemption, span: preemption.span ?? span }
    const detail = describeAccesses(reads)
    // pre() only helps with a variable the reader wrote; a hidden one ("Cooking's suspend condition") has no pre.
    const first = deps.map(d => d.v.of ?? d.v).find(v => !v.generated)
    const breakIt = first ? `Break the cycle with \`pre(${varName(first)})\` (last tick's value), by making one side wait a tick,` : 'Break the cycle by making one side wait a tick,'
    const visibleNames = [...new Set(deps.map(d => d.v.of ?? d.v).filter(v => !v.generated).map(say))]
    const hiddenNames = [...new Set(deps.map(d => d.v.of ?? d.v).filter(v => v.generated).map(hiddenName))]
    // Name what the reader wrote; the compiler's helpers only when there is nothing else (at most two of them).
    const names = visibleNames.length ? visibleNames.slice(0, 4) : hiddenNames.slice(0, 2)
    const more = visibleNames.length ? (visibleNames.length > 4 ? ' and others' : '') : (hiddenNames.length > 2 ? ` (and ${hiddenNames.length - 2} more of the compiler's helpers)` : '')
    return {
        severity: 'error', code: 'causality-cycle',
        message: names.length === 1 && !more
            ? `${names[0]} is read before it can be written in the same tick (the writer depends on the reader)`
            : `${quote(names)}${more} depend on ${names.length > 2 || more ? 'one another' : 'each other'} within one tick: each waits for the other`,
        span,
        kieler,
        hint: `${detail ? detail + '. ' : ''}Within a tick every write of a variable, and every emission of a signal, comes before it is read. ${breakIt} or by moving the logic into one region.`,
        related,
    }
}

/**
 * A count delay inside a state with a self-loop (preemption.md P-36a): KIELER keeps the count in a variable of the
 * source's parent, and when the self-loop leaves and enters the state around it in one tick, resetting the count,
 * counting and its `pre` register wait for each other. KIELER rejects every such chart, however deep the count sits.
 */
function countDelayResetLoop(deps: Dependency[], index: ModelIndex | undefined): Pick<Diagnostic, 'code' | 'message' | 'hint' | 'span' | 'related'> | undefined {
    if (!index) return undefined
    const counter = deps.map(d => d.v.of ?? d.v).find(v => v.role === 'counter')
    const by = counter ? [...counter.tags].find(t => t.startsWith('#count-delay:'))?.slice('#count-delay:'.length) : undefined
    const m = by ? /^(.*)->(\d+)$/.exec(by) : null
    const source = m ? index.states.get(m[1]) : undefined
    const t = source?.transitions[Number(m?.[2]) - 1]
    if (!source || !t) return undefined
    // The nearest state around the count with a transition back to itself.
    let loop: { state: State; t: State['transitions'][number] } | undefined
    for (let r = index.parentRegion.get(source); r && !loop; ) {
        const p = index.parentState.get(r)
        if (!p) break
        const self = p.transitions.find(x => x.target === p.id)
        if (self) loop = { state: p, t: self }
        r = index.parentRegion.get(p)
    }
    if (!loop) return undefined
    const P = loop.state.name
    const kind = loop.t.preemption === 'strong' ? 'abort to' : loop.t.preemption === 'termination' ? 'join to' : 'go to'
    const loopText = `${loop.t.trigger ? `if ${formatExpression(loop.t.trigger)} ` : ''}${kind} ${P}`
    const count = `if ${t.triggerDelay} ${t.trigger ? formatExpression(t.trigger) : ''}`.trim()
    const target = t.target ? index.states.get(t.target)?.name ?? t.targetName : t.targetName
    return {
        code: 'count-delay-reset',
        span: t.trigger?.span ?? t.span,
        related: [by!, loop.t.id, loop.state.id],
        message: `KIELER cannot compile the count delay \`${count}\` on \`${source.name}\`'s transition to \`${target}\`: \`${P}\`, around it, has the self-loop \`${loopText}\``,
        hint: `KIELER keeps the count in a variable of the state around \`${source.name}\`, and in a tick in which \`${loopText}\` leaves \`${P}\` and enters it again, restarting the count and counting wait for each other. It rejects every count delay inside a state with a self-loop. Count by hand, with a variable declared outside \`${P}\`: \`entry do count = 0\` and \`during if ${t.trigger ? formatExpression(t.trigger) : 'x'} do count++\` on \`${source.name}\`, and \`if count == ${t.triggerDelay}\` on its transition.`,
    }
}

/** A generated variable as the reader can understand it (its display name; the compiler's names never leak). */
function hiddenName(v: CVar): string {
    return v.display ?? 'a variable the compiler adds'
}

/**
 * Cycles that come from preemption: a weak abort out of a state with a `period` (structure.md S-42a), a strong
 * abort out of a state with its own suspend (the suspend freezes the state's own transitions, so the abort waits for
 * the suspend condition, which the state's inside works out), and an abort whose trigger reads what the state's
 * inside writes in the same tick (which KIELER accepts in simple cases only: tests/engine/kieler/preemption/
 * probe-abort-trigger-inside-*).
 */
function preemptionCycle(cycle: SNode[], deps: Dependency[], index: ModelIndex | undefined): Pick<Diagnostic, 'code' | 'message' | 'hint' | 'span'> | undefined {
    if (!index) return undefined
    // A period guards the transitions out of its own state with its tick, which the state's inside works out
    // (structure.md S-42a): a weak abort out of such a state waits for the tick, and the tick for the abort.
    const tick = deps.map(d => d.v).find(v => v.role === 'tick')
    if (tick) {
        const state = tick.scope as CState | undefined
        const plain = readableName(state) ?? 'S'
        const name = readableName(state) ? `\`${readableName(state)}\`` : 'the state'
        const source = index.states.get(sourceState(state) ?? '')
        return {
            code: 'period-abort-cycle',
            span: source?.actions.find(a => a.kind === 'period')?.span ?? source?.transitions[0]?.span,
            message: `${name}'s period and the transitions out of ${name} depend on each other within the tick`,
            hint: `KIELER guards every transition inside a state with a \`period\` with the period's tick, the transitions out of ${name} included, and the tick is worked out inside ${name}. Put the period into a region inside ${name} (\`initial state ${plain} { region { period ... } }\`) and leave ${name} with a normal transition.`,
        }
    }
    const transitionOf = (id: string | undefined) => {
        const m = id ? /^(.*)->(\d+)$/.exec(id) : null
        const state = m ? index.states.get(m[1]) : undefined
        return state ? { state, t: state.transitions[Number(m![2]) - 1] } : undefined
    }
    const aborts = cycle.map(n => transitionOf(n.transition?.checks ?? n.transition?.origin)).filter(x => x?.t && x.t.preemption !== 'termination')
    const strong = aborts.find(x => x!.t.preemption === 'strong')
    // A strong abort out of a state with its own suspend: the flag of that state is in the cycle.
    if (strong && deps.some(d => d.v.role === 'enabled' && sourceState(d.v.scope as CState | undefined) === strong.state.id)) {
        const name = `\`${strong.state.name}\``
        return {
            code: 'suspend-abort-cycle',
            message: `The strong abort out of ${name} and ${name}'s own suspend depend on each other within the tick`,
            hint: `A strong abort is decided before anything inside ${name} runs, but ${name}'s \`suspend\` also freezes ${name}'s own transitions, so the abort waits for ${name}'s suspend condition, which is worked out inside ${name}. Move the abort to a state around ${name}: KIELER rejects every \`abort to\` out of a state that has its own \`suspend\`.`,
            span: strong.t.span,
        }
    }
    // An abort (weak or strong) whose trigger reads what the state's own inside writes in the same tick.
    for (const abort of aborts) {
        const S = abort!.state
        const inside = (id: string | undefined) => !!id && (id.startsWith(`${S.id}.`) || id.startsWith(`${S.id}!`) || id.startsWith(`${S.id}:`))
        const written = deps.filter(d => d.kind !== 'write-write' && inside(nodeElement(d.from)) && !(d.v.of ?? d.v).generated)
        const vars = [...new Set(written.map(d => say(d.v.of ?? d.v)))]
        if (!vars.length) continue
        const first = varName(written[0].v.of ?? written[0].v)
        const signal = written.some(d => d.v.role === 'presence' || d.v.role === 'curval' || (d.v.of ?? d.v).signal)
        const what = quote(vars)
        const verb = signal ? 'emitted' : 'set'
        const kind = abort!.t.preemption === 'strong' ? 'strong abort' : 'transition'
        const target = abort!.t.target ? index.states.get(abort!.t.target)?.name ?? abort!.t.targetName : abort!.t.targetName
        return {
            code: 'abort-trigger-cycle',
            message: `The ${kind} from \`${S.name}\` to \`${target}\` reads ${what}, which ${vars.length > 1 ? 'are' : 'is'} ${verb} inside \`${S.name}\` in the same tick, and KIELER cannot put the two in an order`,
            hint: `In each tick KIELER has to check this ${kind === 'transition' ? 'transition' : 'abort'} and run the inside of \`${S.name}\` in some order, and here each waits for the other. (KIELER accepts some charts whose transitions out of a superstate read a value written inside it, but not this one.) What always works: ${verb === 'emitted' ? 'emit' : 'set'} ${what} in a region next to \`${S.name}\`, outside it, or read last tick's value with \`pre(${first})\`.`,
            span: abort!.t.trigger?.span ?? abort!.t.span,
        }
    }
    return undefined
}

/** `A -> B -> A` from transition ids `X.A->1`, `X.B->1` (when they chain). */
function loopPath(transitions: string[]): string | undefined {
    const short = (id: string) => id.replace(/->\d+$/, '').split(/[.:]/).pop()!
    const sources = transitions.map(short)
    if (!sources.length || sources.length > 6) return undefined
    return [...sources.reverse(), sources[0]].map(s => `\`${s}\``).join(' → ')
}

/** "x is written on line 7 and read on line 12; ..." for the read dependencies of a cycle. */
function describeAccesses(reads: Dependency[]): string {
    const parts: string[] = []
    const seen = new Set<string>()
    for (const d of reads) {
        const name = say(d.v.of ?? d.v)
        const w = d.a.span?.line
        const r = d.b.span?.line
        if (w === undefined || r === undefined) continue
        const key = `${name}:${w}:${r}`
        if (seen.has(key)) continue
        seen.add(key)
        parts.push(`${name} is ${d.v.role === 'presence' || d.v.signal ? 'emitted' : 'set'} on line ${w} and read on line ${r}`)
        if (parts.length >= 3) break
    }
    return parts.join('; ')
}

/** The dependencies the final schedule used. */
function analysisDeps(analysis: Analysis): Dependency[] {
    return analysis.deps
}

export type { Span }
export { allStates }

/** The first expression, effect or statement the lowering left as `unsupported`, as an `unsupported` info. */
function leftovers(root: CState): Diagnostic[] {
    let found: { what: string; span?: Span } | undefined
    const expr = (e: CExpr | undefined) => walkExpr(e, x => { if (!found && x.k === 'unsupported') found = { what: x.what, span: x.span } })
    const stmts = (list: CStmt[]) => {
        for (const st of list) {
            if (found) return
            if (st.k === 'do') { if (st.f.k === 'unsupported') found = { what: st.f.what, span: st.f.o.span }; else effectExprs(st.f).forEach(expr) }
            else if (st.k === 'if') { expr(st.cond); stmts(st.then); if (st.else) stmts(st.else) }
            else if (st.k === 'while') { expr(st.cond); stmts(st.body) }
            else if (st.k === 'for') { stmts(st.init); expr(st.cond); stmts(st.update); stmts(st.body) }
            else if (st.k === 'return') expr(st.expr)
            else if (st.k === 'expr') expr(st.e)
            else if (st.k === 'unsupported') found = { what: st.what, span: st.span }
        }
    }
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        expr(holder.trigger)
        for (const f of holder.effects) {
            if (f.k === 'unsupported' && !found) found = { what: f.what, span: f.o.span }
            effectExprs(f).forEach(expr)
        }
    }
    for (const scope of allScopes(root)) {
        for (const v of scope.decls) {
            expr(v.init)
            v.dims.forEach(expr)
            if (v.method) stmts(v.method.body)
        }
    }
    if (!found) return []
    return [{
        severity: 'info', code: 'unsupported', span: found.span,
        message: `The guide's simulator cannot evaluate \`${found.what}\``,
        hint: 'This is a limit of the guide\'s simulator, not a mistake in the chart. The official KIELER tools may run it.',
    }]
}

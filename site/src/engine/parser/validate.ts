// KIELER's validation rules (SCTXValidator and the SCL, KExt, KEffects and KExpressions validators it extends),
// with the same severities, so the engine accepts and rejects exactly the charts the official tools do. Each
// diagnostic keeps KIELER's own message in `kieler` and gives a clearer message and a hint for beginners.
//
// Also two compile-time rejections that are certain from the source alone (reported by the KIELER fork's compiler
// rather than its validator): emitting a variable that is not a signal in reachable code, and a for region that
// starts at a number but does not end at one.

import type {
    Declaration, Diagnostic, Effect, Equation, Expression, LocalAction, Pragma, Program, Reference, Region, ScopeCall, SclStatement, Span,
    State, Transition, ValuedObject,
} from '../types'
import type { ModelIndex, VOEntry } from './resolve'
import { lowermost } from './resolve'
import { groupSpans, referenceName } from './parser'

type Severity = Diagnostic['severity']

const INFIX: Record<string, string> = { '+': '+=', '-': '-=', '*': '*=', '/': '/=', '%': '%=', '&': '&=', '|': '|=', '^': '^=', '<<': '<<=', '>>': '>>=', '>>>': '>>>=' }

export function validateProgram(program: Program, index: ModelIndex, source: string, options: { files?: Record<string, string> } = {}): Diagnostic[] {
    return new Validator(program, index, source, options).run()
}

class Validator {
    private readonly out: Diagnostic[] = []
    /** Reachability per state (KIELER's isStateReachable). */
    private readonly reachable = new Map<State, boolean>()
    /** Inside the body of a method declaration (KIELER allows `state(...)` only there). */
    private methodBodies = 0

    constructor(private readonly program: Program, private readonly index: ModelIndex, private readonly source: string, private readonly options: { files?: Record<string, string> }) {}

    run(): Diagnostic[] {
        this.checkPragmas(this.program.pragmas)
        this.checkImports()
        this.checkDuplicateCharts()
        for (const chart of this.program.charts) this.state(chart)
        return this.out
    }

    private add(severity: Severity, code: string, span: Span | undefined, message: string, kieler: string | undefined, hint?: string, related?: string[]) {
        const d: Diagnostic = { severity, code, message }
        if (kieler !== undefined) d.kieler = kieler
        if (span) d.span = span
        if (hint) d.hint = hint
        if (related?.length) d.related = related
        this.out.push(d)
    }

    private vo(id: string | undefined): VOEntry | undefined {
        return id ? this.index.vos.get(id) : undefined
    }

    private text(span: Span): string {
        return this.source.slice(span.start, span.end)
    }

    // ----- program level -----

    private checkPragmas(pragmas: Pragma[]) {
        for (const p of pragmas) {
            if (p.name === 'import') {
                this.add('error', 'deprecated-import', p.span, "The #import pragma is no longer supported: write import \"File\" instead",
                    'The import pragma is no longer supported. Use import keyword.')
            }
        }
    }

    private checkImports() {
        if (!this.program.imports.length) return
        const files = Object.keys(this.options.files ?? {}).map(f => f.replace(/\\/g, '/'))
        const has = (name: string) => {
            const want = name.endsWith('.sctx') ? name : `${name}.sctx`
            return files.some(f => f === want || f.endsWith('/' + want))
        }
        const span = this.program.span
        this.program.imports.forEach((name, i) => {
            const folder = name.endsWith('*')
            const ok = folder ? files.some(f => f.startsWith(name.slice(0, -1))) : has(name)
            if (!ok) {
                this.add('warning', 'broken-import', this.program.importSpans?.[i] ?? span, folder ? `No SCCharts files match the import "${name}"` : `There is no file \`${name.endsWith('.sctx') ? name : name + '.sctx'}\` to import`,
                    folder ? 'Broken Import: There are no SCCharts models in the given directory.' : 'Broken Import: There is no SCCharts model with the given name.',
                    'In this guide, imports only see the other files of the same example.')
            }
        })
    }

    private checkDuplicateCharts() {
        const seen = new Set<string>()
        for (const c of this.program.charts) {
            if (seen.has(c.name)) {
                this.add('warning', 'duplicate-chart', c.nameSpan, `There is already an scchart called \`${c.name}\` in this file`,
                    `There are multiple root states with the same name. '${c.name}'`, 'References (is, extends, ref) will use the first one.', [c.id])
            }
            seen.add(c.name)
        }
    }

    // ----- states -----

    private isReachable(state: State): boolean {
        const cached = this.reachable.get(state)
        if (cached !== undefined) return cached
        const visited = new Set<State>()
        const walk = (s: State): boolean => {
            if (visited.has(s)) return false
            visited.add(s)
            if (!this.index.parentRegion.get(state)) return true
            if (s.initial) return true
            for (const t of this.index.incoming.get(s) ?? []) {
                const src = this.index.states.get(t.source)
                if (src && walk(src)) return true
            }
            return false
        }
        const r = walk(state)
        this.reachable.set(state, r)
        return r
    }

    /** Reachable and all ancestors reachable (what code generation keeps). */
    private isLive(state: State): boolean {
        for (let s: State | undefined = state; s; ) {
            if (!this.isReachable(s)) return false
            const r = this.index.parentRegion.get(s)
            s = r ? this.index.parentState.get(r) : undefined
        }
        return true
    }

    private annotations(list: { name: string; type?: string; span: Span }[]) {
        for (const a of list) {
            if (a.name === 'layout' && a.type === undefined) {
                this.add('warning', 'layout-annotation', a.span, 'Layout annotations are written `@layout[option] value`',
                    "Layout annotations must have the format '@layout[id] value'", 'For example `@layout[elk.direction] RIGHT`.')
            }
        }
    }

    private state(state: State) {
        this.annotations(state.annotations)
        // Duplicate valued objects in this scope (warning), excluding methods.
        this.checkDuplicateVariables(state.declarations)
        this.declarations(state.declarations, state)
        for (const a of state.actions) this.action(a, state, undefined)

        if (!state.isRoot && !this.isReachable(state)) {
            this.add('warning', 'unreachable-state', state.span, `State \`${state.name}\` can never be entered`, 'The state is not reachable.',
                'No transition leads to it from a reachable state, and it is not initial. Add a transition to it, or delete it.', [state.id])
        }
        if (state.violation) {
            const director = [...this.program.pragmas].reverse().find(p => p.name === 'director')
            if (director && director.values[0] !== 'Enforcer') {
                this.add('error', 'violation-without-enforcer', state.nameSpan, 'Violation states need the Enforcer director', 'Violation states require enforcer director',
                    'Add the pragma #director Enforcer at the top of the file.', [state.id])
            }
        }

        this.checkDuplicateRegions(state)
        this.checkTransitionsReachable(state)
        if (state.connector) this.checkConnector(state)
        this.checkFinalStates(state)
        this.checkLowPriorityStrongAbort(state)
        if (state.regions.length > 0) {
            for (const t of state.transitions) {
                if ((t.preemption === 'weak' || t.preemption === 'strong') && !t.trigger) {
                    this.add('warning', 'abort-without-trigger', t.span, `This ${t.preemption === 'strong' ? 'abort' : 'transition'} has no trigger, so it leaves \`${state.name}\` in the first possible tick`,
                        'Abort transitions should have a trigger.',
                        `Superstate \`${state.name}\` is left before its inner behaviour can run. To wait until the inner regions finish, use \`join to ${t.targetName}\` instead.`, [t.id])
                }
            }
        }
        this.checkMethods(state)
        if (state.reference) this.checkScopeCall(state)
        if (state.baseStates?.length) this.checkInheritance(state)

        for (const t of state.transitions) this.transition(t, state)
        for (const r of state.regions) this.region(r, state)
        for (const p of state.policies ?? []) this.policy(p)
    }

    /** Policy regions: KIELER checks their states like other states (reachability, unreachable transitions). */
    private policy(region: Region) {
        for (const s of region.states) {
            if (!this.isReachable(s)) {
                this.add('warning', 'unreachable-state', s.span, `State \`${s.name}\` can never be entered`, 'The state is not reachable.',
                    'No transition leads to it from a reachable state, and it is not initial.', [s.id])
            }
            this.checkTransitionsReachable(s)
        }
    }

    /**
     * KIELER's checkMethods with getMethodInheritanceInfos (SCChartsInheritanceExtensions): signatures are name +
     * number of parameter declarations; an inherited method redefined without `override`, an override with another
     * return type or number of parameters, and an `override` with nothing to override are errors. Errors of an own
     * method are reported at its declaration, those of an inherited one at the `extends` reference it comes through.
     */
    private checkMethods(state: State) {
        interface Info { decl: Declaration; level: number; errors: string[]; overriding: boolean; via?: number }
        const infos: Info[] = []
        const effective = new Map<string, Info>()
        const name = (d: Declaration) => d.valuedObjects[0]?.name ?? ''
        const returnType = (d: Declaration) => (!d.returnType || d.returnType === 'pure' ? 'void' : d.returnType)
        for (const d of state.declarations) {
            if (d.declKind !== 'method') continue
            const info: Info = { decl: d, level: 0, errors: [], overriding: false }
            infos.push(info)
            const id = signature(d)
            if (effective.has(id)) info.errors.push(`Multiple definitions of methods with the same signature (${id}). Note that method overloading is currently only supported for parameters of different length, not type.`)
            else effective.set(id, info)
        }
        // The base references, breadth first, with their level (allInheritedStateReferencesHierachicallyLeveled).
        const direct = state.baseStates ?? []
        const targetOf = (c: ScopeCall) => this.index.scopeTargets.get(c) ?? this.index.charts.find(x => x.name === c.target)
        const levelled: { call: ScopeCall; level: number; via: number }[] = direct.map((call, via) => ({ call, level: 1, via }))
        for (let i = 0; i < levelled.length; i++) {
            const { call, level, via } = levelled[i]
            const target = targetOf(call)
            if (!target || target === state) continue
            for (const b of target.baseStates ?? []) {
                if (targetOf(b) && targetOf(b) !== state && !levelled.some(x => x.call === b)) levelled.push({ call: b, level: level + 1, via })
            }
        }
        for (const { call, level, via } of levelled) {
            const base = targetOf(call)
            if (!base || base === state) continue
            for (const d of base.declarations) {
                if (d.declKind !== 'method') continue
                const info: Info = { decl: d, level, errors: [], overriding: false, via }
                infos.push(info)
                if (d.access === 'private') continue
                const repl = effective.get(signature(d))
                if (!repl) {
                    effective.set(name(d), info) // KIELER keys the inherited ones by name (sic)
                    continue
                }
                const r = repl.decl
                if (info.level < repl.level) {
                    const msg = `Multiple definitions of the same method (${name(d)}) in the inheritance hierarchy but no overrider to solve this ambiguity (diamond problem).`
                    info.errors.push(msg)
                    repl.errors.push(msg)
                } else if (!r.override) {
                    info.errors.push(`Method (${name(d)}) was redefined in the inheritance hierarchy but not marked as override.`)
                    repl.errors.push(`Methods with the same signature is already inherited (${signature(d)}). Mark this declaration as override (keyword) to replace previous definitions. Note that method overloading is currently only supported for parameters of different length, not type.`)
                }
                if (r.override) {
                    if (returnType(d) !== returnType(r)) repl.errors.push(`Overriding methods must not declare a different return type (${returnType(d)} vs. ${returnType(r)}).`)
                    if ((d.parameters?.length ?? 0) !== (r.parameters?.length ?? 0)) repl.errors.push(`Overriding methods must not declare a parameter with a different length (${d.parameters?.length ?? 0} vs. ${r.parameters?.length ?? 0}).`)
                }
                repl.overriding = true
            }
        }
        for (const info of infos) {
            if (!info.decl.override) continue
            if (!info.overriding) info.errors.push('No matching or visible method found with this signature to override.')
            if (!info.decl.body) info.errors.push('An overriding method must provide an implementation!')
        }
        for (const info of infos) {
            if (!info.errors.length) continue
            const kieler = info.errors.join('\n')
            const first = info.errors[0]
            const n = name(info.decl)
            const message = first.startsWith('Multiple definitions of methods') ? `There is already a method \`${n}\` with ${info.decl.parameters?.length ?? 0} parameter${(info.decl.parameters?.length ?? 0) === 1 ? '' : 's'}`
                : first.startsWith('Methods with the same signature') ? `\`${n}\` is already inherited: write \`override method\` to replace it`
                : first.startsWith('Method (') ? `\`${state.name}\` redefines the inherited method \`${n}\` without \`override\``
                : first.startsWith('Overriding methods must not declare a different return type') ? `The override of \`${n}\` must keep the return type of the method it replaces`
                : first.startsWith('Multiple definitions of the same method') ? `\`${n}\` is inherited twice, and nothing overrides it`
                : first
            const hint = first.startsWith('Multiple definitions of methods') ? 'Methods are told apart by their number of parameters only. Rename one of them.'
                : first.startsWith('Methods with the same signature') || first.startsWith('Method (') ? `Mark the method in \`${state.name}\` \`override\` (\`override method ...\`), or give it another name.`
                : first.startsWith('Overriding methods must not declare a different return type') ? 'An override replaces the method everywhere, so callers must get the same kind of value.'
                : undefined
            if (info.via !== undefined) {
                const call = direct[info.via]
                this.add('error', 'method-signature', call.targetSpan ?? call.span, message, kieler, hint)
            } else {
                this.add('error', 'method-signature', info.decl.span, message, kieler, hint)
            }
        }
    }

    private checkDuplicateVariables(decls: Declaration[]) {
        const names = new Set<string>()
        for (const d of decls) {
            if (d.declKind === 'method') continue
            for (const vo of d.valuedObjects) {
                if (names.has(vo.name)) {
                    this.add('warning', 'duplicate-variable', vo.span, `\`${vo.name}\` is declared twice in this scope`,
                        'The variable is declared multiple times in this scope.', `Every use of \`${vo.name}\` refers to the first declaration. Rename or remove this one.`)
                } else names.add(vo.name)
            }
        }
    }

    private checkDuplicateRegions(state: State) {
        const names = new Set<string>()
        for (const r of state.regions) {
            if (!r.name) continue
            if (names.has(r.name)) {
                this.add('warning', 'duplicate-region', r.nameSpan ?? r.span, `There is already a region called \`${r.name}\` in \`${state.name}\``,
                    `There are multiple regions with the same name. '${r.name}'`, 'Give each region its own name.', [r.id])
            } else names.add(r.name)
        }
    }

    private implicitlyImmediate(t: Transition, source: State): boolean {
        return t.delay === 'immediate' || source.connector || (t.preemption === 'termination' && !t.trigger && t.delay !== 'delayed')
    }

    private checkTransitionsReachable(state: State) {
        let delayedWithoutTrigger = false
        let immediateWithoutTrigger = false
        for (const t of state.transitions) {
            const unreachable = () => this.add('warning', 'unreachable-transition', t.span, 'This transition can never fire',
                'The transition is not reachable.',
                'A transition without a trigger above it always fires first (it has a higher priority). Move this one up, or give the other one a trigger.', [t.id])
            if (this.implicitlyImmediate(t, state)) {
                if (immediateWithoutTrigger) unreachable()
                if (!immediateWithoutTrigger && !t.trigger && t.preemption !== 'termination') immediateWithoutTrigger = true
            } else {
                if (delayedWithoutTrigger || immediateWithoutTrigger) unreachable()
                if (!delayedWithoutTrigger && !t.trigger) delayedWithoutTrigger = true
            }
        }
    }

    private checkConnector(state: State) {
        let withoutTrigger = false
        let last: Transition | undefined
        for (const t of state.transitions) {
            if (t.delay !== 'immediate') {
                this.add('warning', 'connector-not-immediate', t.span, 'Transitions out of a connector should be immediate',
                    'Outgoing transitions of connector states should be marked as immediate.', 'A connector is passed through in the same tick: write immediate in front of its transitions.', [t.id])
            }
            if (!t.trigger) withoutTrigger = true
            last = t
        }
        if (!withoutTrigger) {
            this.add('warning', 'connector-no-default', last?.span ?? this.spanAt(0, 0), 'A connector needs a transition without a trigger',
                'Connector states should have an outgoing transition without trigger.', 'Otherwise the connector can get stuck. Add a final `immediate go to ...` without `if`.', [state.id])
        }
        if (!last) {
            this.add('error', 'connector-no-transition', state.span, `Connector \`${state.name}\` has no outgoing transition`,
                'Connector states must have an outgoing transition.', 'A connector only passes control on: add `immediate go to Target` below it.', [state.id])
        }
    }

    private checkFinalStates(state: State) {
        const terminations = state.transitions.filter(t => t.preemption === 'termination')
        if (!terminations.length) return
        const cf = state.regions.filter(r => r.regionType === 'controlflow')
        const df = state.regions.filter(r => r.regionType === 'dataflow')
        if (!cf.length && !state.reference && !df.length) {
            const t = terminations[0]
            this.add('error', 'termination-without-inner-behaviour', t.span, `\`join to\` needs a superstate: \`${state.name}\` has no inner states`,
                'A state with a termination transition must have inner behaviour.',
                `A termination transition (\`join to\`) fires when the inner regions of \`${state.name}\` have finished. Use \`go to\` for a simple state, or give \`${state.name}\` inner states with a final state.`, [t.id])
        }
        if (!state.actions.length) {
            // With abort regions (preemption.md P-62) the state finishes as soon as any region does: KIELER warns all
            // the same, the guide says what the warning means there.
            const abort = cf.find(r => r.abort)
            for (const r of cf) {
                if (!r.states.some(s => s.final)) {
                    const name = r.name ? `Region \`${r.name}\`` : 'This region'
                    this.add('warning', 'missing-final-state', r.nameSpan ?? r.span, abort
                        ? `${name} has no final state, so only another region finishing can end \`${state.name}\` (it has abort regions)`
                        : `${name} has no final state, so \`join to ${terminations[0].targetName}\` can never fire`,
                        'Every region should have a final state whenever its parent state has a termination transition.',
                        abort
                            ? `A state with abort regions is done as soon as any of its regions reaches a final state. KIELER warns about every region without one anyway; nothing needs to change if ${r.name ? `\`${r.name}\`` : 'this region'} is meant to run until another region ends it.`
                            : 'Mark the state where the region is done as final (`final state Done`).', [r.id])
                }
            }
        }
    }

    private checkLowPriorityStrongAbort(state: State) {
        let onlyStrongBefore = true
        for (const t of state.transitions) {
            if (onlyStrongBefore && t.preemption !== 'strong') onlyStrongBefore = false
            else if (!onlyStrongBefore && t.preemption === 'strong') {
                this.add('error', 'strong-abort-priority', t.span, 'A strong abort (`abort to`) must come before the other transitions of the state',
                    'Causality problem!\nStrong abort transitions must have a higher priority than weak abort or termination transitions.',
                    'A strong abort is checked before the state runs, so it needs a higher priority than `go to` and `join to` transitions: move it above them.', [t.id])
            }
        }
    }

    // ----- regions -----

    private region(region: Region, parent: State) {
        this.annotations(region.annotations)
        this.checkDuplicateVariables(region.declarations)
        this.declarations(region.declarations, region)
        for (const a of region.actions) this.action(a, undefined, region)
        if (region.regionType === 'controlflow') {
            this.checkInitialState(region, parent)
            this.checkAllHaveFinalStates(region, parent)
            this.checkImmediateLoops(region)
            if (region.actions.length && region.states.some(s => s.final)) {
                for (const a of region.actions) {
                    this.add('warning', 'region-action', a.span, 'Actions in regions are experimental', 'Actions in regions are highly experimental and may not produce the expected results.',
                        'Put the action on the enclosing state instead.', [a.id])
                }
            }
        }
        if (region.forLoop) this.checkForRegion(region)
        if (region.override) {
            if (!region.name) {
                this.add('error', 'override-anonymous', region.span, 'Only a named region can be overridden', 'Cannot override anonymous region.', undefined, [region.id])
            } else {
                const inherited = this.inheritedRegions(parent, false)
                if (!inherited.some(r => r.name === region.name)) {
                    this.add('error', 'override-nothing', region.span, `There is no inherited region \`${region.name}\` to override`, 'The is no region to override.',
                        parent.baseStates?.length ? undefined : 'override only makes sense in a chart that extends another one.', [region.id])
                }
            }
        } else if (parent.baseStates?.length && region.name) {
            if (this.inheritedRegions(parent, true).some(r => r.name === region.name)) {
                this.add('error', 'override-missing', region.nameSpan ?? region.span, `A base chart already has a region \`${region.name}\`: write \`override region ${region.name}\``,
                    'There is an inherited region with the same name, you may use the override keyword.', undefined, [region.id])
            }
        }
        for (const eq of region.equations) this.equation(eq)
        if (region.regionType === 'dataflow') this.checkDataflowVectorAssignment(region)
        for (const s of region.states) this.state(s)
    }

    private inheritedRegions(state: State, directOverride: boolean): Region[] {
        const bases = this.allInherited(state)
        const overridden = directOverride ? new Set(state.regions.filter(r => r.name && r.override).map(r => r.name!)) : new Set<string>()
        return bases.flatMap(b => b.regions).filter(r => !r.name || !overridden.has(r.name))
    }

    private allInherited(state: State): State[] {
        const out: State[] = []
        const work = [...(this.index.baseStates.get(state) ?? [])].filter(s => s !== state)
        while (work.length) {
            const s = work.pop()!
            if (out.includes(s)) continue
            out.push(s)
            for (const b of [...(this.index.baseStates.get(s) ?? [])].reverse()) if (b !== state && !out.includes(b) && !work.includes(b)) work.push(b)
        }
        return out
    }

    private checkInitialState(region: Region, parent: State) {
        let found = 0
        // KIELER: a state whose only region is an unnamed empty one (left by actions) counts as having an initial state.
        if (parent.actions.length > 0 && parent.regions.length === 1 && region.states.length === 0 && !region.name) found = 1
        if (region.reference) found = 1
        for (const s of region.states) if (s.initial) found++
        const where = region.implicit ? (parent.isRoot ? `the chart \`${parent.name}\`` : `state \`${parent.name}\``) : region.name ? `region \`${region.name}\`` : `this region of \`${parent.name}\``
        if (found === 0) {
            this.add('error', 'no-initial-state', region.span, `${capitalise(where)} has no initial state`,
                'Every region must have an initial state.',
                region.states.length ? `Mark the state where it starts with \`initial\`, for example \`initial state ${region.states[0].name || 'Start'}\`.` : 'Add a state such as `initial state Start`.', [region.id])
        } else if (found > 1) {
            const initials = region.states.filter(s => s.initial)
            this.add('error', 'multiple-initial-states', region.span, `${capitalise(where)} has ${found} initial states`,
                'Every region must not have more than one initial state.',
                `A region starts in exactly one state. Keep \`initial\` on one of ${initials.map(s => `\`${s.name}\``).join(', ')}; to start several states at once, put them into separate regions.`, [region.id, ...initials.map(s => s.id)])
        }
    }

    private checkAllHaveFinalStates(region: Region, parent: State) {
        const finals = region.states.filter(s => s.final)
        if (!finals.length) return
        for (const r of parent.regions) {
            if (r === region || r.regionType !== 'controlflow') continue
            if (!r.states.some(s => s.final)) {
                const abort = parent.regions.some(x => x.abort)
                for (const f of finals) {
                    this.add('warning', 'regions-cannot-terminate', f.nameSpan, abort
                        ? `${r.name ? `Region \`${r.name}\`` : 'Another region'} of \`${parent.name}\` has no final state (\`${parent.name}\` has abort regions, so it finishes when any region does)`
                        : `\`${parent.name}\` can never finish: ${r.name ? `region \`${r.name}\`` : 'another region'} has no final state`,
                        'All or none concurrent regions should have final states.',
                        abort
                            ? 'A state with abort regions finishes as soon as any of its regions reaches a final state; KIELER gives this warning anyway.'
                            : 'A superstate finishes (for `join to`) only when every region has reached a final state.', [f.id, r.id])
                }
            }
        }
    }

    /** KIELER's checkNoImmediateLoops: a depth-first search over immediate transitions (not terminations). */
    private checkImmediateLoops(region: Region) {
        const visited = new Map<State, number>()
        const find = (s: State): boolean => {
            const code = visited.get(s) ?? 0
            if (code === 2) return false
            if (code === 1) return true
            visited.set(s, 1)
            for (const t of s.transitions) {
                if (t.preemption !== 'termination' && this.implicitlyImmediate(t, s)) {
                    const target = this.index.targets.get(t)
                    // KIELER's search fails on an unresolved target and reports nothing for the region.
                    if (!target) throw new UnresolvedTarget()
                    if (find(target)) return true
                }
            }
            visited.set(s, 2)
            return false
        }
        for (const s of region.states) {
            let loop: boolean
            try {
                loop = find(s)
            } catch (e) {
                if (e instanceof UnresolvedTarget) return
                throw e
            }
            if (loop) {
                const loop = [...visited.entries()].filter(([, v]) => v === 1).map(([k]) => k)
                const names = loop.map(st => st.name)
                for (const st of loop) {
                    for (const t of st.transitions) {
                        const target = this.index.targets.get(t)
                        if (this.implicitlyImmediate(t, st) && target && loop.includes(target)) {
                            this.add('warning', 'immediate-loop', t.span, `These immediate transitions form a loop (${names.map(n => `\`${n}\``).join(' → ')})`,
                                `There is an immediate loop. The model is not SASC.\nInvolved states: [${names.join(', ')}]`,
                                'If all of them fire, the chart would run around the loop forever in one tick. Make at least one transition of the loop delayed (remove `immediate`).', loop.map(x => x.id))
                        }
                    }
                }
                return
            }
        }
    }

    private checkForRegion(region: Region) {
        const loop = region.forLoop!
        if (loop.from.kind === 'ref') {
            const entry = this.vo(loop.from.decl)
            let ok = false
            const card = entry?.vo.cardinalities[0]
            if (card?.kind === 'int') ok = true
            else if (card?.kind === 'ref') {
                const c = this.vo(card.decl)
                if (c?.vo.initialValue?.kind === 'int') ok = true
            }
            if (!ok && entry) {
                this.add('error', 'for-range', loop.span, `The for-region cannot loop over \`${loop.from.name}\`: its size is not a fixed number`,
                    'The range of the counter variable of the for region is not determinable. The array cardinalities of you array must be an int or a const int.',
                    `\`for ${loop.variable} : ${loop.from.name}\` loops over the indices of the array \`${loop.from.name}\`, whose size must be a number or a \`const int\`. To count from 0, write \`for ${loop.variable} : 0 to 3\`.`, [region.id])
            }
        } else if (loop.from.kind === 'int' && loop.to?.kind !== 'int') {
            // Reported by the KIELER fork's For processor (KIELER itself fails on this range).
            this.add('error', 'for-range', loop.to?.span ?? loop.span, loop.to ? `The end of a for range must be a number` : 'This for range has a start but no end',
                loop.to ? `The for-region range "${this.text(loop.span).replace(/^for\s*/, 'for ')}" ends at ${this.text(loop.to.span)}, which is not an integer literal.` : `The for-region range has a start value but no end value.`,
                `Write both bounds as integer literals, such as \`for ${loop.variable} : 0 to 2\`, or loop over an array \`x\` with \`for ${loop.variable} : x\` (indices 0 to its size - 1).`, [region.id])
        }
    }

    private checkDataflowVectorAssignment(region: Region) {
        for (const eq of region.equations) {
            if (eq.callArgs) continue
            const entry = this.vo(eq.target.decl)
            if (entry?.decl?.declKind === 'reference' && !eq.target.sub && eq.expression.kind !== 'vector') {
                this.add('error', 'dataflow-scalar-to-reference', eq.span, `\`${eq.target.name}\` is a referenced chart: assign one of its inputs (\`${eq.target.name}.input = ...\`) or a vector`,
                    'You are assigning a scalar value to a reference. You should specify the input variable of the reference or use a vector value instead of a scalar.')
            }
        }
    }

    // ----- declarations -----

    private declarations(decls: Declaration[], owner: State | Region | undefined) {
        for (const d of decls) this.declaration(d, owner)
    }

    private declaration(d: Declaration, owner: State | Region | undefined) {
        this.annotations(d.annotations)
        // KExt: array sizes are int literals or const ints with an int literal value; arrays are initialised with vectors.
        for (const vo of d.valuedObjects) {
            for (const card of vo.cardinalities) {
                let ok = card.kind === 'int'
                if (card.kind === 'ref' && !lowermost(card).decl) continue
                if (card.kind === 'ref') {
                    const target = this.vo(lowermost(card).decl)
                    const td = target?.decl
                    if (td && td.declKind === 'variable' && td.const && td.type === 'int' && target!.vo.initialValue?.kind === 'int') ok = true
                }
                if (card.kind === 'special' && card.sub) {
                    const target = this.vo(lowermost(card.sub).decl)
                    const td = target?.decl
                    if (td && td.declKind === 'variable' && td.const && td.type === 'int' && target!.vo.initialValue?.kind === 'int') ok = true
                }
                if (!ok) {
                    this.add('error', 'array-size', card.span, 'An array size must be a number or a const int',
                        'Array cardinalities must be an int literal or a reference to a constant int object.',
                        'Write `int a[3]`, or declare `const int N = 3` and write `int a[N]`.')
                }
            }
            if (vo.cardinalities.length && vo.initialValue && isLiteral(vo.initialValue) && vo.initialValue.kind !== 'vector') {
                this.add('error', 'array-initial-value', vo.initialValue.span, `The array \`${vo.name}\` needs a vector as its initial value`,
                    'Initial value of an array can not be a single value.', `Write the value of every element in braces, for example \`${vo.name}[3] = {0, 0, 0}\`.`)
            }
        }
        if (d.declKind === 'variable') {
            if (d.type === 'pure' && !d.signal) {
                this.add('error', 'pure-variable', d.span, "'pure' is only for signals", 'Pure types are only allowed if used in combination with signals.',
                    'Write `signal S` for a pure signal, or use a type such as `bool` for a variable.')
            }
            if (d.const && !d.input) {
                for (const vo of d.valuedObjects) {
                    if (!vo.initialValue) {
                        this.add('error', 'const-without-value', vo.span, `The constant \`${vo.name}\` needs a value`, 'A const declaration must have an initialization part!',
                            `Write \`const ${d.type ?? 'int'} ${vo.name} = ...\`.`)
                    }
                }
            }
            if ((d.input || d.output) && d.access !== undefined && d.access !== 'public') {
                this.add('error', 'private-interface', d.span, `An input or output cannot be ${d.access}`, 'A private declaration cannot be a public input output interface',
                    'Inputs and outputs are the public interface of the chart. Remove the access modifier.')
            }
            if (d.static) {
                for (const vo of d.valuedObjects) {
                    if (!vo.initialValue) this.add('warning', 'static-without-value', vo.span, `The static variable \`${vo.name}\` should have an initial value`, 'Static variables should be initialized.')
                }
            }
            if (d.signal && d.type && d.type !== 'pure') {
                for (const vo of d.valuedObjects) {
                    if (vo.combine === 'min' || vo.combine === 'max') {
                        this.add('warning', 'minmax-combine', vo.span, `The combine function \`${vo.combine}\` is not supported by KIELER's compiler`, 'Min or max combine operators are currently not supported.')
                    }
                }
            }
        }
        if (d.declKind === 'struct' || d.declKind === 'class') this.checkClass(d)
        if (d.declKind === 'reference' && !d.extern) this.checkReferenceDeclaration(d, owner)

        if (d.members) for (const m of d.members) this.declaration(m, undefined)
        for (const p of d.policies ?? []) this.policy(p)
        if (d.declKind === 'method') {
            for (const p of d.parameters ?? []) this.declaration(p, undefined)
            if (d.body) {
                this.methodBodies++
                this.block(d.body.declarations, d.body.statements, d)
                this.methodBodies--
            }
        }
    }

    private checkClass(d: Declaration) {
        if (!d.className) this.add('error', 'class-without-name', d.span, `A ${d.declKind} needs a name`, 'A class/struct must have a unique name.')
        if (!d.valuedObjects.length) {
            this.add('warning', 'class-without-variable', d.span, `This ${d.declKind} declares no variable`, 'A class/struct should have at least one variable defined (Type definitions are not supported).',
                `Write the variable name after the closing brace: \`${d.declKind} ${d.className ?? 'Name'} { ... } myVariable\`.`)
        }
        for (const vo of d.valuedObjects) {
            if (vo.initialValue && vo.initialValue.kind !== 'hostcode') {
                this.add('error', 'class-initial-value', vo.initialValue.span, `A ${d.declKind} cannot be initialised as a whole`, 'Composed types (class/struct) cannot be initialized. Please initialize each field individually.')
            }
        }
        if (d.declKind === 'struct') {
            for (const m of d.members ?? []) {
                if (m.access !== undefined && m.access !== 'public') this.add('error', 'struct-member', m.span, 'Struct members must be public', 'All members of a struct must be publicly accessible.')
                if (m.declKind !== 'variable' && m.declKind !== 'struct') this.add('error', 'struct-member', m.span, 'A struct may only contain variables and other structs', 'A struct may only contain primitive members or other structs.')
            }
        }
    }

    private checkReferenceDeclaration(d: Declaration, owner: State | Region | undefined) {
        const target = this.index.refTargets.get(d)
        if (!target) return
        if (target.kind === 'state') {
            for (const vo of d.valuedObjects) {
                if (vo.initialValue) this.add('error', 'reference-initial-value', vo.initialValue.span, 'A referenced chart cannot be given an initial value', 'Valued objects of referenced SCCharts cannot be initialized manually.')
            }
        } else if (target.declKind === 'class' || target.declKind === 'struct') {
            for (const vo of d.valuedObjects) {
                if (vo.initialValue && vo.initialValue.kind !== 'hostcode') {
                    this.add('error', 'class-initial-value', vo.initialValue.span, `A ${target.declKind} cannot be initialised as a whole`, 'Composed types (class/struct) cannot be initialized. Please initialize each field individually.')
                }
            }
        } else if (target.declKind === 'enum') {
            for (const vo of d.valuedObjects) {
                const init = vo.initialValue
                if (init && init.kind !== 'hostcode') {
                    const value = init.kind === 'ref' ? lowermost(init) : init.kind === 'special' && init.sub ? lowermost(init.sub) : undefined
                    const entry = value ? this.vo(value.decl) : undefined
                    if (!entry || entry.memberOf !== target) {
                        this.add('error', 'enum-initial-value', init.span, `\`${vo.name}\` can only start with a value of enum \`${target.className}\``, 'An enum typed variable can only be initialized with a value of the correct enum type.')
                    }
                }
            }
        }
        if (target.kind !== 'state' || d.annotations.some(a => a.name === 'noBindingCheck')) return
        if (d.input) {
            for (const vo of d.valuedObjects) if (vo.parameters?.length) this.add('error', 'input-reference-parameters', vo.span, 'An input reference cannot have parameters', 'An input reference must not have parameters!')
            return
        }
        // Valued objects instantiated by dataflow regions are not checked.
        const usedInDataflow = new Set<string>()
        const scanDataflow = (regions: Region[]) => {
            for (const r of regions) if (r.regionType === 'dataflow') for (const eq of r.equations) collectRefs(eq, ref => { if (ref.decl) usedInDataflow.add(ref.decl) })
        }
        if (owner?.kind === 'state') scanDataflow(owner.regions)
        else if (owner?.kind === 'region' && owner.regionType === 'dataflow') scanDataflow([owner])
        const check = d.valuedObjects.filter(vo => !usedInDataflow.has(vo.id))
        if (!check.length) return
        const first = check[0]
        const each = usedInDataflow.size > 0 || (d.valuedObjects.length > 1 && d.valuedObjects.some(v => v.parameters?.length))
        for (const vo of each ? check : [first]) {
            const errors = this.bindingErrors(target, vo.parameters ?? [], owner)
            if (errors.length) {
                // KIELER marks the referenced chart's name (referenceDeclaration_Reference).
                this.add('error', 'binding-error', d.referenceSpan ?? vo.span, `The bindings of \`${vo.name}\` to \`${target.name}\` are wrong: ${errors[0]}`,
                    'The referencing binding is erroneous!\n' + errors.join('\n'), errors.length > 1 ? errors.slice(1).join(' ') : undefined)
            }
        }
    }

    // ----- references to other charts -----

    private checkScopeCall(state: State) {
        const call = state.reference!
        if (call.super) {
            if (call.parameters.length) this.add('error', 'super-reference-parameters', call.span, 'A reference to a super scope cannot have parameters', 'A reference to a super scope must not have parameters!')
            return
        }
        const target = this.index.scopeTargets.get(call)
        if (!target) return
        const parentRegion = this.index.parentRegion.get(state)
        for (const p of call.parameters) {
            if (p.expression.kind === 'this') {
                // KIELER fails to compile this ("Unhandled parameter types: [ThisExpression]").
                this.add('error', 'this-parameter', p.span, "'this' cannot be passed to a referenced chart", 'Unhandled parameter types: [ThisExpression]',
                    'Pass variables or values as parameters.', [state.id])
                return
            }
        }
        // An explicit binding that does not resolve is reported by the linker only.
        if (call.parameters.some(p => p.binding !== undefined && !p.bindingDecl)) return
        const errors = this.bindingErrors(target, call.parameters, parentRegion ? state : undefined, state)
        if (errors.length) {
            this.add('error', 'binding-error', call.span, `The bindings of \`${state.name}\` to \`${target.name}\` are wrong: ${errors[0]}`,
                'The referencing binding is erroneous!\n' + errors.join('\n'), errors.length > 1 ? errors.slice(1).join(' ') : undefined, [state.id])
        } else {
            const implicit = this.implicitBindings(target, call.parameters)
            if (implicit.length) {
                this.add('warning', 'implicit-binding', call.span, `${implicit.map(n => `\`${n}\``).join(', ')} ${implicit.length === 1 ? 'is' : 'are'} bound by name`,
                    'Valued Objects are bound implicitly!\n' + implicit.map(n => n + ', ').join(''),
                    `${implicit.map(n => `\`${n}\``).join(', ')} of \`${target.name}\` ${implicit.length === 1 ? 'is' : 'are'} connected to the variable${implicit.length === 1 ? '' : 's'} of the same name here. Write them in the parameter list (\`${implicit[0]} to ${implicit[0]}\`) to make it explicit.`, [state.id])
            }
        }
        if (state.transitions.some(t => t.preemption === 'termination')) {
            const mayTerminate = target.regions.filter(r => r.regionType === 'controlflow').every(r => this.allFinalStates(r).length > 0)
            if (!mayTerminate) {
                this.add('warning', 'reference-never-terminates', call.span, `\`${target.name}\` never finishes, so \`join to\` cannot fire`,
                    'The referenced SCChart does not terminate, but you are using a termination to proceed.', undefined, [state.id])
            }
        }
    }

    private allFinalStates(region: Region): State[] {
        return region.states.filter(s => s.final)
    }

    /** Interface of a referenced chart in binding order: its inputs and outputs, then inherited ones. */
    private interfaceOf(target: State): ValuedObject[] {
        const out: ValuedObject[] = []
        for (const d of target.declarations) if (d.input || d.output) out.push(...d.valuedObjects)
        for (const base of this.allInherited(target)) for (const d of base.declarations) if ((d.input || d.output) && d.access !== 'private') out.push(...d.valuedObjects)
        return out
    }

    /** KIELER's createBindings (SCChartsReferenceExtensions) error messages. */
    private bindingErrors(target: State, parameters: State['reference'] extends infer _ ? NonNullable<State['reference']>['parameters'] : never, scopeState: State | Region | undefined, referencing?: State): string[] {
        const errors: string[] = []
        const targetVOs = this.interfaceOf(target)
        const bound = new Set<ValuedObject>()
        let ptr = 0
        for (const p of parameters) {
            let ok = true
            if (p.binding !== undefined) {
                const idx = targetVOs.findIndex(v => v.name === p.binding)
                if (idx < 0) {
                    errors.push(`Explicit binding could not be resolved! The valued object is unknown! ${p.binding}`)
                    ok = false
                } else ptr = idx
            }
            if (ok) {
                if (ptr > targetVOs.length - 1) {
                    errors.push(`A Valued Object is supposed to be bound, but there is no free Valued Object left in the referenced scope: ${this.text(p.expression.span)}`)
                    continue
                }
                const tvo = targetVOs[ptr]
                bound.add(tvo)
                ptr++
                errors.push(...this.typeCompatibility(p.expression, tvo))
            }
        }
        if (bound.size < targetVOs.length) {
            const names = this.nameMap(referencing ?? scopeState)
            for (const vo of targetVOs) {
                if (bound.has(vo)) continue
                const decl = this.vo(vo.id)?.decl
                if (names.has(vo.name)) {
                    const src = names.get(vo.name)!
                    errors.push(...this.typeCompatibility({ kind: 'ref', name: src.name, indices: [], span: vo.span, decl: src.id }, vo))
                } else if (decl && decl.access !== undefined && decl.access !== 'public') {
                    errors.push(`Valued object in the referenced scope was not bound properly: ${vo.name}`)
                } else {
                    errors.push(`Valued object in the referenced scope was not bound properly: ${vo.name}`)
                }
            }
        }
        return errors
    }

    private implicitBindings(target: State, parameters: NonNullable<State['reference']>['parameters']): string[] {
        const targetVOs = this.interfaceOf(target)
        const bound = new Set<ValuedObject>()
        let ptr = 0
        for (const p of parameters) {
            if (p.binding !== undefined) {
                const idx = targetVOs.findIndex(v => v.name === p.binding)
                if (idx < 0) continue
                ptr = idx
            }
            if (ptr < targetVOs.length) bound.add(targetVOs[ptr])
            ptr++
        }
        return targetVOs.filter(v => !bound.has(v)).map(v => v.name)
    }

    /** Valued objects visible from a scope by name (KIELER's valuedObjectNameMap: innermost first). */
    private nameMap(from: State | Region | undefined): Map<string, ValuedObject> {
        const map = new Map<string, ValuedObject>()
        let s: State | Region | undefined = from
        while (s) {
            for (const d of s.declarations) for (const vo of d.valuedObjects) if (!map.has(vo.name)) map.set(vo.name, vo)
            if (s.kind === 'state') {
                for (const base of this.allInherited(s)) for (const d of base.declarations) for (const vo of d.valuedObjects) map.set(vo.name, vo)
                const r = this.index.parentRegion.get(s)
                s = r
            } else {
                s = this.index.parentState.get(s)
            }
        }
        return map
    }

    private typeCompatibility(source: Expression, target: ValuedObject): string[] {
        if (source.kind === 'ref') {
            const sv = this.vo(source.decl)?.vo
            if (!sv) return []
            const isArrayRef = source.indices.length > 0
            if (isArrayRef) {
                if (!sv.cardinalities.length) return [`It is not possible to bind an array reference of the scalar ${sv.name}`]
            } else if (sv.cardinalities.length && !target.cardinalities.length) {
                return [`It is not possible to bind array ${sv.name} to scalar ${target.name}!`]
            }
            return []
        }
        if (isLiteral(source)) {
            const decl = this.vo(target.id)?.decl
            if (decl?.declKind === 'variable' && decl.output) return [`It is not possible to bind the literal ${this.text(source.span)} \n                    to the output ${target.name} !`]
        }
        return []
    }

    private checkInheritance(state: State) {
        // Cycles in the inheritance hierarchy (KIELER's getHierarchyCycles: a depth-first search from this state).
        const refs = state.baseStates ?? []
        const cycles = new Map<State, Set<number>>()
        const path: State[] = [state]
        const indexes: number[] = [-1]
        let rootIndex = -1
        while (path.length) {
            const s = path[path.length - 1]
            const idx = indexes.pop()! + 1
            const sRefs = s === state ? refs : s.baseStates ?? []
            if (sRefs.length <= idx) {
                path.pop()
                continue
            }
            indexes.push(idx)
            if (path.length === 1) rootIndex = idx
            const base = this.index.scopeTargets.get(sRefs[idx])
            if (!base) continue
            if (path.includes(base)) {
                const set = cycles.get(base) ?? new Set<number>()
                set.add(rootIndex)
                cycles.set(base, set)
            } else {
                path.push(base)
                indexes.push(-1)
            }
        }
        for (const [base, set] of cycles) {
            for (const i of set) {
                const ref = refs[i]
                this.add('error', 'inheritance-cycle', ref?.span ?? state.nameSpan, `\`${state.name}\` inherits from itself (through \`${base.name}\`)`,
                    `Inconsistent inheritance hierarchy! Cycle including base state: ${base.name}`, 'A chart cannot extend itself, directly or through other charts.', [state.id])
            }
        }
        // Reusing an inherited variable name.
        const inheritedNames = new Set(this.allInherited(state).flatMap(s => s.declarations).filter(d => d.declKind !== 'method').flatMap(d => d.valuedObjects).map(v => v.name))
        for (const d of state.declarations) {
            if (d.declKind === 'method') continue
            for (const vo of d.valuedObjects) {
                if (inheritedNames.has(vo.name)) {
                    this.add('error', 'inherited-name', vo.span, `\`${vo.name}\` is already declared in a base chart`, 'This variable name is already used in a base state.')
                }
            }
        }
    }

    // ----- transitions and actions -----

    private transition(t: Transition, source: State) {
        this.annotations(t.annotations)
        if (t.triggerDelay === 0 && t.trigger) {
            this.add('error', 'count-delay-zero', t.trigger.span, 'A count delay of 0 is not allowed', 'A count delay of 0 is not allowed on a trigger.',
                `\`if 0 ...\` would never be true. Leave the number out for "the first time" (\`if A\`), or use 2 or more.`, [t.id])
        }
        this.labelHides(t)
        this.actionLike(t, source, undefined)
    }

    /** KIELER's checkActionTriggerEffectsWithLabel: on local actions and transitions alike (a Transition is an Action). */
    private labelHides(a: LocalAction | Transition) {
        if (!a.label) return
        if (a.trigger) this.add('info', 'label-hides-trigger', a.trigger.span, 'The label is shown instead of the trigger in the diagram', 'The trigger of this action is hidden by the label.')
        if (a.effects.length) this.add('info', 'label-hides-effects', a.effects[0].span, 'The label is shown instead of the effects in the diagram', 'The effects of this action are hidden by the label.')
    }

    private action(a: LocalAction, state: State | undefined, region: Region | undefined) {
        this.annotations(a.annotations)
        this.labelHides(a)
        if (a.kind === 'during' && (a.triggerDelay ?? 1) > 1) {
            this.add('warning', 'during-count-delay', this.countDelaySpan(a) ?? a.span, 'KIELER ignores count delays on during actions',
                'Count Delays on During Actions are not supported yet. The valued will be ignored by the transformation.', `During actions fire on every tick in which the trigger holds; the count \`${a.triggerDelay}\` is dropped.`, [a.id])
        }
        this.actionLike(a, state, region)
    }

    /** Span of the count delay number in `during if 3 A` (KIELER marks the number). */
    private countDelaySpan(a: LocalAction | Transition): Span | undefined {
        const text = this.text(a.span)
        const m = /\bif\s+(\d+)/.exec(text)
        if (!m) return undefined
        const start = a.span.start + m.index + m[0].length - m[1].length
        return this.spanAt(start, start + m[1].length)
    }

    private spanAt(start: number, end: number): Span {
        const before = this.source.slice(0, start)
        const line = before.split('\n').length
        const col = start - before.lastIndexOf('\n')
        return { start, end, line, col, endLine: line, endCol: col + (end - start) }
    }

    /** Checks shared by transitions and local actions (KIELER's Action checks), and their effects. */
    private actionLike(a: Transition | LocalAction, state: State | undefined, _region: Region | undefined) {
        const trigger = a.trigger
        if (trigger && a.kind !== 'period') {
            if (trigger.kind === 'ref') {
                const entry = this.vo(trigger.decl)
                if (entry?.decl?.type === 'float' && entry.decl.declKind === 'variable') {
                    this.add('error', 'float-trigger', trigger.span, `A float cannot be a trigger on its own: compare it, as in \`${trigger.name} > 0\``,
                        'Float tests must have a comparison operator!', 'Only a bool variable or a signal can stand alone as a trigger.')
                }
            }
            if ((a.triggerDelay ?? 1) > 1 && trigger.kind === 'op' && hasLeftUnary(trigger)) {
                this.add('warning', 'count-delay-unary', a.span, `KIELER reads \`if ${a.triggerDelay} -...\` as a count delay followed by a negative number`,
                    'A count delay was recognized in front of an unary operation.\nIf this is not intended, use parentheses to surround your expression.',
                    'Put parentheses around the expression if the number belongs to it.')
            }
            // KIELER's checkMethodCall skips method references and calls in transition triggers (method observers).
            this.checkExpression(trigger, a.kind === 'transition')
        }
        const live = state ? this.isLive(state) : true
        for (const e of a.effects) this.effect(e, live)
        // checkOldStyleRelativeWriteSyntax: x = ... x ... (as an operand) is a relative write.
        for (const e of a.effects) {
            if (e.kind !== 'assign' || e.operator !== '=') continue
            // Unresolved names all count as the same (null) object, as in KIELER.
            const target = voKey(e.target)
            const reads = operandReads(e.expression, target)
            if (!reads) continue
            this.add('warning', 'relative-write', e.span, this.relativeWriteMessage(e).short, this.relativeWriteMessage(e).kieler, this.relativeWriteMessage(e).hint)
        }
    }

    private relativeWriteMessage(e: Extract<Effect, { kind: 'assign' }>): { short: string; kieler: string; hint: string } {
        const name = this.text(e.target.span)
        const reads = countReads(e.expression, voKey(e.target))
        if (reads !== 1) {
            return {
                short: `This assignment reads \`${name}\`, so KIELER treats it as an update of \`${name}\``,
                kieler: 'This assignment looks like old relative write SC syntax and is considered deprecated.\nIf you want to create a relative write in new syntax, please use an infix assignment operator.',
                hint: `It only matters when another region writes \`${name}\` in the same tick. Write the update with an operator such as \`${name} += ...\` to say so.`,
            }
        }
        const steps = this.infixSteps(e)
        return {
            short: `This assignment reads \`${name}\`, so the compiler treats it as an update of \`${name}\``,
            kieler: `This assignment reads ${name}, so the compiler treats it as an update of ${name} (a relative write, as in the deprecated old SC syntax).\n`
                + (steps ? `Write it as ${steps.join('; ')} to say so. In one region it means the same.\n` : `This expression has no infix assignment form. If you mean an update, write one, e.g. ${name} += 1.\n`)
                + `It only matters when another region also writes ${name} in the same tick: this assignment then runs after that write instead of conflicting with it.`,
            hint: steps ? `Write it as \`${steps.join('; ')}\`: in one region it means the same, and it says that it is an update.` : `It only matters when another region also writes \`${name}\` in the same tick.`,
        }
    }

    private infixSteps(e: Extract<Effect, { kind: 'assign' }>): string[] | undefined {
        const target = this.text(e.target.span)
        const steps: string[] = []
        let expression = e.expression
        while (expression.kind === 'op') {
            const op = INFIX[expression.op === 'neg' ? '' : expression.op]
            if (!op || expression.args.length < 2) return undefined
            for (const operand of expression.args.slice(1).reverse()) steps.unshift(`${target} ${op} ${this.text(groupSpans.get(operand) ?? operand.span)}`)
            expression = expression.args[0]
        }
        return expression.kind === 'ref' && this.text(expression.span) === target ? steps : undefined
    }

    private equation(eq: Equation) {
        this.checkExpression(eq.expression, false)
        if (!eq.callArgs) this.checkAssignmentTarget(eq.target, eq.span, true)
    }

    private effect(e: Effect | SclStatement, live: boolean) {
        switch (e.kind) {
            case 'assign':
                this.checkAssignmentTarget(e.target, e.span, false, e.expression)
                this.checkExpression(e.expression, false)
                break
            case 'postfix':
                this.checkAssignmentTarget(e.target, e.span, false)
                break
            case 'emit': {
                this.checkVOR(e.target, false)
                const entry = this.vo(e.target.decl)
                const d = entry?.decl
                if (d && d.declKind === 'variable' && !d.signal) {
                    const what = `${d.input ? 'an input ' : d.output ? 'an output ' : 'a '}${d.type === 'host' ? 'host' : d.type ?? ''} variable`
                    if (live) {
                        // KIELER's validator only warns ('Non-signals should not be used in an emission.'), but its code
                        // generator then fails on reachable code (the KIELER fork reports this message), so it is an error.
                        this.add('error', 'non-signal-emission', e.span, `\`${referenceName(e.target)}\` is ${what}, not a signal, so it cannot be emitted`,
                            `${referenceName(e.target)} is ${what}, not a signal, so it cannot be emitted.`,
                            `Write \`${referenceName(e.target)} = true\` to set it, or declare it as a signal (\`output signal ${referenceName(e.target)}\`).`)
                    } else {
                        this.add('warning', 'non-signal-emission', e.span, `\`${referenceName(e.target)}\` is not a signal, so it cannot be emitted`, 'Non-signals should not be used in an emission.',
                            `Emitting is for signals (\`signal S\`, \`output signal S\`). To set \`${referenceName(e.target)}\`, assign it: \`${referenceName(e.target)} = true\`.`)
                    }
                }
                if (d && d.declKind === 'variable' && d.signal && d.input && d.type && d.type !== 'pure') {
                    this.add('warning', 'valued-input-emission', e.span, `Emitting the valued input signal \`${e.target.name}\` is not supported`, 'Valued input signals currently do not support emission (overwriting).')
                }
                if (e.value) this.checkExpression(e.value, false)
                break
            }
            case 'call':
                this.checkCall(e)
                if (e.target) this.checkVOR(e.target, false, true)
                for (const a of e.args) this.checkExpression(a, false)
                break
            case 'print':
                if (e.args[0]?.kind === 'op') {
                    this.add('warning', 'print-calculation', e.span, 'A calculation inside print() may print differently in C and Java',
                        'You do a calculation inside a print call effect. You should use printf syntax to be safe on different code generators.', 'Use a format string: `print("%d", x + 1)` becomes `print("%d", y)` with `y = x + 1`.')
                }
                for (const a of e.args) this.checkExpression(a, false)
                break
            case 'randomize':
                for (const a of e.args) this.checkExpression(a, false)
                break
            case 'code':
                this.block(e.declarations ?? [], e.statements ?? [], undefined)
                break
            case 'hostcode':
                break
        }
    }

    private checkCall(e: { target?: Reference; args: Expression[]; extern?: boolean; span: Span }) {
        if (e.extern || !e.target) return
        const entry = this.vo(lowermost(e.target).decl)
        if (entry?.decl?.declKind === 'method') {
            const params = entry.decl.parameters ?? []
            if (params.length !== e.args.length) {
                // At the method's name (`add` in `c.add(1, 2)`), as KIELER.
                this.add('error', 'method-arguments', lowermost(e.target).span, `\`${entry.vo.name}\` takes ${params.length} argument${params.length === 1 ? '' : 's'}, not ${e.args.length}`,
                    'Number of arguments does not match required parameters in definition.')
            }
        }
    }

    private checkAssignmentTarget(target: Reference, span: Span, inDataflow: boolean, expression?: Expression) {
        this.checkVOR(target, false)
        const entry = this.vo(target.decl)
        const d = entry?.decl
        if (!d) return
        if (d.declKind === 'variable' && d.signal && !target.sub) {
            this.add('error', 'assignment-to-signal', span, `\`${target.name}\` is a signal: emit it instead of assigning it`, 'Non-variables cannot be used in an assignment.',
                `Signals are emitted, not assigned: write \`${target.name}\` for a pure signal, or \`${target.name}(value)\` for a valued one.`)
        }
        if (d.declKind === 'variable' && d.const) {
            this.add('error', 'assignment-to-const', span, `\`${target.name}\` is a constant and cannot be changed`, 'You cannot assign a value to a const object.',
                'Remove `const` from its declaration if it needs to change.')
        }
        if (!target.sub && expression?.kind !== 'hostcode') {
            // KIELER's isClass: classes and structs (KExpressionsDeclarationExtensions).
            if (d.declKind === 'class' || d.declKind === 'struct') this.add('error', 'assignment-to-class', target.span, `Assign a member of \`${target.name}\`, not the whole ${d.declKind}`, 'Assignments to class/struct types are not supported. Please specify a member.')
            if (d.declKind === 'reference' && !d.extern) {
                const rt = this.index.refTargets.get(d)
                if (rt?.kind === 'declaration' && (rt.declKind === 'class' || rt.declKind === 'struct')) {
                    this.add('error', 'assignment-to-class', target.span, `Assign a member of \`${target.name}\`, not the whole class`, 'Referencing class/struct types is not supported. Please specify a member.')
                }
                if (rt?.kind === 'state' && !inDataflow) {
                    this.add('error', 'assignment-to-reference', target.span, `\`${target.name}\` is a referenced chart and cannot be assigned`, 'Assignments to referenced SCCharts are not supported. Except with dataflow semantics (i.e. in a dataflow region).')
                }
            }
        }
        if (expression && d.declKind === 'reference' && !d.extern) {
            const rt = this.index.refTargets.get(d)
            if (rt?.kind === 'declaration' && rt.declKind === 'enum' && expression.kind !== 'hostcode') this.checkEnumAssignment(expression, rt)
        }
    }

    private checkEnumAssignment(expression: Expression, enumDecl: Declaration) {
        const value = expression.kind === 'ref' ? lowermost(expression) : expression.kind === 'special' && expression.sub ? lowermost(expression.sub) : undefined
        const entry = value ? this.vo(value.decl) : undefined
        let ok = false
        if (entry?.memberOf === enumDecl) ok = true
        else if (entry?.decl?.declKind === 'reference' && this.index.refTargets.get(entry.decl) === enumDecl) ok = true
        if (!ok) this.add('error', 'enum-assignment', expression.span, `Only values of enum \`${enumDecl.className}\` can be assigned here`, 'Cannot assign enum value of an incompatible type.')
    }

    /** checkMethodCall, checkClassReference, checkCorrectExternalReferenceObjects, checkFloatModulo, state access. */
    private checkExpression(e: Expression, inTrigger: boolean) {
        switch (e.kind) {
            case 'ref': this.checkVOR(e, inTrigger); return
            case 'op':
                this.checkTernaryGrouping(e)
                if (e.op === '%' && this.isFloat(e)) {
                    this.add('warning', 'float-modulo', e.span, 'Modulo with floats is not supported by most code generators',
                        'You are using modulo with floats. Most implemented code backend (such as C) will not support this. Use dedicated hostcode functions (such as fmod) to implement the behavior.')
                }
                for (const a of e.args) this.checkExpression(a, inTrigger)
                return
            case 'call':
                if (!inTrigger) this.checkCall(e)
                if (e.target) this.checkVOR(e.target, inTrigger, true)
                for (const a of e.args) this.checkExpression(a, inTrigger)
                return
            case 'vector': for (const v of e.values) this.checkExpression(v, inTrigger); return
            case 'special':
                if (e.access === 'state') {
                    if (!this.methodBodies) {
                        this.add('error', 'state-access', e.span, '`state(...)` can only be used inside a method body', 'State access expressions are only permissible in methods bodies.',
                            `Read it in a method: \`method bool active() { return ${e.text} }\`, then call \`active()\` here.`)
                    } else if (this.index.ambiguousStateAccess.has(e)) {
                        this.add('error', 'state-access', e.span, `Several anonymous regions here have a state called \`${e.target}\`, so \`${e.text}\` is ambiguous`,
                            'This state access is ambiguous as there are multiple anonymous regions with states with this ID. Use region IDs access the state via RegionID.StateID.',
                            `Name the regions (\`region Main:\`) and write \`state(Main.${e.target})\`.`)
                    }
                }
                return
            default: return
        }
    }

    /**
     * The checks KIELER runs on every ValuedObjectReference: checkMethodCall, checkClassReference and
     * checkCorrectExternalReferenceObjects. `isCall`: the reference is the target of a call (a ReferenceCall).
     */
    private checkVOR(ref: Reference, inTrigger: boolean, isCall = false) {
        for (const i of ref.indices) this.checkExpression(i, false)
        const visit = (r: Reference, isSub: boolean) => {
            const entry = this.vo(r.decl)
            if (entry?.decl?.declKind === 'method' && !isCall) {
                // A method used without parentheses: allowed only directly in a transition trigger (method observers).
                if (isSub || !inTrigger) {
                    this.add('error', 'method-without-call', r.span, `\`${r.name}\` is a method: call it with parentheses, as in \`${r.name}()\``, 'Methods must be used with call syntax using parenthesis.')
                }
            }
            if (entry?.decl && !r.sub && !isSub) {
                if (entry.decl.declKind === 'class' || entry.decl.declKind === 'struct') {
                    this.add('error', 'class-reference', r.span, `Use a member of \`${r.name}\`, not the whole ${entry.decl.declKind}`, 'Referencing class/struct types is not supported. Please specify a member.')
                }
                if (entry.decl.declKind === 'reference' && !entry.decl.extern) {
                    const rt = this.index.refTargets.get(entry.decl)
                    if (rt?.kind === 'declaration' && (rt.declKind === 'class' || rt.declKind === 'struct')) {
                        this.add('error', 'class-reference', r.span, `Use a member of \`${r.name}\`, not the whole class`, 'Referencing class/struct types is not supported. Please specify a member.')
                    }
                }
            }
            if (entry?.decl?.declKind === 'reference' && entry.decl.extern && !isCall) {
                this.add('warning', 'extern-without-call', r.span, `\`${r.name}\` is an external function: call it with parentheses`, 'You are using an external reference without call syntax. If you want to generate a call, you must add parentheses.')
            }
            if (r.sub) {
                for (const i of r.sub.indices) this.checkExpression(i, false)
                visit(r.sub, true)
            }
        }
        visit(ref, false)
    }

    /**
     * Engine-only warning: KIELER's conditional `c ? a : b` takes single values as its parts and binds tighter than
     * every binary operator, so `x > 0 ? 1 : 2` means `x > (0 ? 1 : 2)`. Warn when a conditional without parentheses
     * is the operand of another operator.
     */
    private checkTernaryGrouping(e: Extract<Expression, { kind: 'op' }>) {
        if (e.op === '?:' || e.op === 'pre' || e.op === 'val') return
        e.args.forEach((arg, i) => {
            if (arg.kind !== 'op' || arg.op !== '?:' || groupSpans.has(arg)) return
            const ternary = this.text(arg.span)
            const shown = e.args.map((a, j) => (j === i ? `(${ternary})` : this.text(a.span)))
            const op = e.op === 'neg' ? '-' : e.op
            const reading = e.args.length === 1 ? `${op}(${ternary})` : shown.join(` ${op} `)
            this.add('warning', 'ternary-grouping', e.span, `KIELER reads this as \`${reading}\``, undefined,
                i > 0 ? `The condition of \`? :\` is a single value, so the comparison is not part of it. Write \`(${this.text(e.args[i - 1].span)} ${op} ${this.text((arg as Extract<Expression, { kind: 'op' }>).args[0].span)}) ? ...\` with parentheses.`
                    : 'Put parentheses around the whole conditional, or around its parts, to say what you mean.')
        })
    }

    /** KIELER's isFloat: a float literal or variable, or an operation whose operands are all float. */
    private isFloat(e: Expression): boolean {
        if (e.kind === 'float') return true
        if (e.kind === 'ref') {
            const d = this.vo(lowermost(e).decl)?.decl
            return d?.declKind === 'variable' && d.type === 'float'
        }
        if (e.kind === 'op') return (e.op === '?:' ? e.args.slice(1) : e.args).every(a => this.isFloat(a))
        return false
    }

    private block(decls: Declaration[], statements: SclStatement[], method: Declaration | undefined) {
        this.declarations(decls, undefined)
        for (const s of statements) this.statement(s, method)
    }

    private statement(s: SclStatement, method: Declaration | undefined) {
        switch (s.kind) {
            case 'assign': case 'postfix': case 'call': case 'print': case 'randomize': case 'hostcode':
                this.effect(s, true)
                return
            case 'return':
                if (!method) this.add('error', 'return-outside-method', s.span, 'return can only be used inside a method', 'Return statements can only be used in method bodies.')
                else if (!method.returnType || method.returnType === 'void' || method.returnType === 'pure') {
                    this.add('error', 'return-without-type', s.span, `The method \`${method.valuedObjects[0]?.name}\` has no return type`, 'Return statement is used but no return type is declared in method signature.',
                        `Declare the type of the result: \`method int ${method.valuedObjects[0]?.name}() { ... }\`.`)
                }
                this.checkExpression(s.expression, false)
                return
            case 'expression': this.checkExpression(s.expression, false); return
            case 'block': case 'while':
                if (s.kind === 'while') this.checkExpression(s.condition, false)
                this.block(s.declarations, s.statements, method)
                return
            case 'if':
                this.checkExpression(s.condition, false)
                this.block(s.declarations, s.statements, method)
                if (s.else) this.block(s.else.declarations, s.else.statements, method)
                return
            case 'for':
                if (s.init?.kind === 'declaration') this.declaration(s.init, undefined)
                else if (s.init) this.statement(s.init, method)
                this.checkExpression(s.condition, false)
                if (s.update) this.statement(s.update, method)
                this.block(s.declarations, s.statements, method)
                return
            default: return
        }
    }
}

class UnresolvedTarget {}

/** Identity of the valued object a reference names: its id, or one shared key for every unresolved reference (in
 *  KIELER they all have a null valued object, so they compare equal). */
function voKey(r: Reference): string {
    return r.decl ?? '?'
}

function signature(d: Declaration): string {
    return `${d.valuedObjects[0]?.name}#${d.parameters?.length ?? 0}`
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
}

/** IntValue, FloatValue, BoolValue, StringValue, VectorValue (KExpressions' Value). */
function isLiteral(e: Expression): boolean {
    return e.kind === 'int' || e.kind === 'float' || e.kind === 'bool' || e.kind === 'string' || e.kind === 'vector' || e.kind === 'null'
}

function hasLeftUnary(e: Extract<Expression, { kind: 'op' }>): boolean {
    const first = e.args[0]
    if (first?.kind === 'op') {
        if (first.op === 'neg' && first.args.length === 1) return true
        return hasLeftUnary(first)
    }
    return false
}

/** Does the expression read `decl` as a direct operand of an operator with more than one operand? */
function operandReads(e: Expression, decl: string): boolean {
    let found = false
    const visit = (x: Expression, parentIsBinary: boolean) => {
        if (found) return
        if (x.kind === 'ref') {
            if (parentIsBinary && voKey(x) === decl) found = true
            visitRefChildren(x)
            return
        }
        if (x.kind === 'op') { for (const a of x.args) visit(a, x.args.length > 1); return }
        if (x.kind === 'call') { for (const a of x.args) visit(a, false); return }
        if (x.kind === 'vector') { for (const v of x.values) visit(v, false); return }
    }
    const visitRefChildren = (r: Reference) => {
        for (const i of r.indices) visit(i, false)
        if (r.sub) visitRefChildren(r.sub)
    }
    visit(e, false)
    return found
}

/** Number of references to `decl` in an expression (including the expression itself). */
function countReads(e: Expression, decl: string): number {
    let n = 0
    const visit = (x: Expression) => {
        if (x.kind === 'ref') {
            if (voKey(x) === decl) n++
            const walk = (r: Reference) => { r.indices.forEach(visit); if (r.sub) walk(r.sub) }
            walk(x)
        } else if (x.kind === 'op') x.args.forEach(visit)
        else if (x.kind === 'call') { x.args.forEach(visit); if (x.target) { const walk = (r: Reference) => { r.indices.forEach(visit); if (r.sub) walk(r.sub) }; walk(x.target) } }
        else if (x.kind === 'vector') x.values.forEach(visit)
    }
    visit(e)
    return n
}

function collectRefs(eq: Equation, fn: (r: Reference) => void) {
    const visitRef = (r: Reference) => { fn(r); r.indices.forEach(visit); if (r.sub) visitRef(r.sub) }
    const visit = (x: Expression) => {
        if (x.kind === 'ref') visitRef(x)
        else if (x.kind === 'op') x.args.forEach(visit)
        else if (x.kind === 'call') { x.args.forEach(visit); if (x.target) visitRef(x.target) }
        else if (x.kind === 'vector') x.values.forEach(visit)
    }
    visitRef(eq.target)
    visit(eq.expression)
    eq.callArgs?.forEach(visit)
}

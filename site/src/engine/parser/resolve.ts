// Name resolution (linking) with KIELER's scoping rules (SCTXScopeProvider, KExtScopeProvider):
//
// - A valued object reference sees the declarations of every enclosing declaration scope, innermost first:
//   code blocks and methods, then the state or region it is written in, then the enclosing regions and states up to
//   the scchart. A transition is contained in its source state, so its trigger and effects also see the source
//   state's own (inner) declarations. Within one scope the first declaration of a name wins; for regions the
//   for-loop counter is visible too. Declaration order does not matter (`int a[N]` may come before `const int N`).
// - A call `f(x)` in an expression only sees methods and extern declarations.
// - `a.b`: b is looked up among the members of a's type (referenced chart, class, struct, enum).
// - A transition can only target a state of its source state's own region (including the source itself).
// - `state S is Other(...)`, `extends Base`, `ref Other x` name a root state of this file or of the other files
//   given to compile().
//
// Sets Reference.decl, Transition.target, ScopeParameter.bindingDecl, and turns a valued emission `m(x)` of a
// method or reference into a call (KIELER's KEffectsEmissionReferenceCallConverter). Unresolved names become
// errors with KIELER's linking message in `kieler` and a beginner-oriented message and hint.

import type {
    Declaration, Diagnostic, Effect, Equation, Expression, LocalAction, Program, Reference, Region, ScopeCall, SclStatement,
    State, Transition, ValuedObject,
} from '../types'
import { counterId } from './ids'
import { referenceName } from './parser'

export interface VOEntry {
    vo: ValuedObject
    /** The declaration (undefined for for-loop counters). */
    decl?: Declaration
    /** The state or region that declares it (undefined for class members, method locals and code-block locals). */
    owner?: State | Region
    /** For-loop counter variable of a region. */
    counter?: boolean
    /** Member of a class, struct or enum (the type's declaration). */
    memberOf?: Declaration
}

/** Everything the validator and the simulator need to know about the resolved model. */
export interface ModelIndex {
    programs: Program[]
    charts: State[]
    vos: Map<string, VOEntry>
    states: Map<string, State>
    regions: Map<string, Region>
    /** Parent region of every non-root state. */
    parentRegion: Map<State, Region>
    /** Parent state of every region. */
    parentState: Map<Region, State>
    /** Resolved transition targets. */
    targets: Map<Transition, State>
    incoming: Map<State, Transition[]>
    /** Resolved `is` / `extends` / `ref` targets. */
    scopeTargets: Map<ScopeCall, State>
    baseStates: Map<State, State[]>
    refTargets: Map<Declaration, State | Declaration>
    /** `state(S)` without a region where several anonymous regions have a state S (an error, SCTXValidator). */
    ambiguousStateAccess: Set<Expression>
}

const isCallable = (d: Declaration | undefined) => !!d && (d.declKind === 'method' || (d.declKind === 'reference' && !!d.extern))
const isPublic = (d: Declaration) => d.access === undefined || d.access === 'public'
const isPrivate = (d: Declaration) => d.access === 'private' || (!isPublic(d) && d.access !== 'protected')

class Scope {
    readonly names = new Map<string, ValuedObject>()
    readonly callables = new Map<string, ValuedObject>()
    /** All callables per name, for overloads (methods differing in their number of parameters). */
    readonly overloads = new Map<string, { vo: ValuedObject; decl: Declaration }[]>()
    constructor(readonly parent: Scope | undefined, readonly owner: State | Region | undefined, readonly label: string) {}
    add(vo: ValuedObject, decl: Declaration | undefined) {
        if (!this.names.has(vo.name)) this.names.set(vo.name, vo)
        if (isCallable(decl) && !this.callables.has(vo.name)) this.callables.set(vo.name, vo)
        if (decl?.declKind === 'method') {
            const list = this.overloads.get(vo.name) ?? []
            list.push({ vo, decl })
            this.overloads.set(vo.name, list)
        }
    }
    /** KIELER's overloading-aware scope: among methods of one name, the one with as many parameters as arguments. */
    lookupCall(name: string, args: number): ValuedObject | undefined {
        for (let s: Scope | undefined = this; s; s = s.parent) {
            const list = s.overloads.get(name)
            if (list && list.length > 1) {
                const match = list.find(m => (m.decl.parameters?.length ?? 0) === args)
                if (match) return match.vo
            }
            const vo = s.callables.get(name)
            if (vo) return vo
        }
        return undefined
    }
    lookup(name: string, callable = false): ValuedObject | undefined {
        for (let s: Scope | undefined = this; s; s = s.parent) {
            const vo = (callable ? s.callables : s.names).get(name)
            if (vo) return vo
        }
        return undefined
    }
    visible(): string[] {
        const out = new Set<string>()
        for (let s: Scope | undefined = this; s; s = s.parent) for (const n of s.names.keys()) out.add(n)
        return [...out]
    }
}

export function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]
        row[0] = i
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
            prev = tmp
        }
    }
    return row[b.length]
}

export function closest(name: string, candidates: Iterable<string>): string | undefined {
    let best: string | undefined
    let bestD = Infinity
    for (const c of candidates) {
        if (c === name) continue
        const d = c.toLowerCase() === name.toLowerCase() ? 0.5 : editDistance(name, c)
        if (d < bestD) { bestD = d; best = c }
    }
    const limit = name.length <= 3 ? 1 : name.length <= 6 ? 2 : 3
    return best !== undefined && bestD <= limit ? best : undefined
}

interface ResolveOptions {
    /** Root states of other files (imports), visible to `is`, `extends` and `ref`. */
    externalCharts?: State[]
}

export function resolveProgram(program: Program, options: ResolveOptions = {}): { index: ModelIndex; diagnostics: Diagnostic[] } {
    return new Resolver(program, options).run()
}

class Resolver {
    private readonly diagnostics: Diagnostic[] = []
    private readonly index: ModelIndex
    /** Root states by name (first wins), this file first. */
    private readonly chartsByName = new Map<string, State>()
    private readonly stateScopes = new Map<State, Scope>()
    /** All declared names per owner, for "declared elsewhere" hints. */
    private readonly declaredIn = new Map<string, (State | Region)[]>()
    /** Names declared too late in a state (State.lateDeclarations): where, for the hint. */
    private readonly declaredLate = new Map<string, { owner: State; line: number }>()

    constructor(private readonly program: Program, options: ResolveOptions) {
        const charts = [...program.charts, ...(options.externalCharts ?? [])]
        for (const c of charts) if (!this.chartsByName.has(c.name)) this.chartsByName.set(c.name, c)
        this.index = {
            programs: [program], charts, vos: new Map(), states: new Map(), regions: new Map(), parentRegion: new Map(), parentState: new Map(),
            targets: new Map(), incoming: new Map(), scopeTargets: new Map(), baseStates: new Map(), refTargets: new Map(), ambiguousStateAccess: new Set(),
        }
    }

    run() {
        // Pass 1: register structure, valued objects and the charts' base states (inherited declarations need them).
        for (const chart of this.program.charts) this.register(chart, undefined)
        for (const chart of this.index.charts) if (!this.program.charts.includes(chart)) this.register(chart, undefined, true)
        for (const s of this.index.states.values()) this.resolveBaseStates(s)
        // Pass 2: resolve everything in this file.
        for (const chart of this.program.charts) this.resolveState(chart, undefined)
        return { index: this.index, diagnostics: this.diagnostics }
    }

    // ----- registration -----

    private register(state: State, parent: Region | undefined, external = false) {
        if (!external || !this.index.states.has(state.id)) this.index.states.set(state.id, state)
        if (parent) this.index.parentRegion.set(state, parent)
        if (!this.index.incoming.has(state)) this.index.incoming.set(state, [])
        this.registerDeclarations(state.declarations, state)
        for (const d of state.lateDeclarations ?? []) for (const vo of d.valuedObjects) if (!this.declaredLate.has(vo.name)) this.declaredLate.set(vo.name, { owner: state, line: d.span.line })
        for (const r of state.regions) {
            this.index.regions.set(r.id, r)
            this.index.parentState.set(r, state)
            this.registerDeclarations(r.declarations, r)
            if (r.forLoop) {
                const vo: ValuedObject = { kind: 'valuedObject', id: counterId(r), name: r.forLoop.variable, cardinalities: [], span: r.forLoop.span }
                this.index.vos.set(vo.id, { vo, owner: r, counter: true })
            }
            for (const s of r.states) this.register(s, r, external)
        }
        for (const p of state.policies ?? []) this.registerPolicy(p, state)
    }

    private registerPolicy(region: Region, owner: State | undefined) {
        this.index.regions.set(region.id, region)
        if (owner) this.index.parentState.set(region, owner)
        this.registerDeclarations(region.declarations, region)
        for (const s of region.states) {
            this.index.states.set(s.id, s)
            this.index.parentRegion.set(s, region)
            this.index.incoming.set(s, [])
        }
    }

    private registerDeclarations(decls: Declaration[], owner: State | Region | undefined, memberOf?: Declaration) {
        for (const d of decls) {
            for (const vo of d.valuedObjects) {
                this.index.vos.set(vo.id, { vo, decl: d, owner, memberOf })
                if (owner && !memberOf) {
                    const list = this.declaredIn.get(vo.name) ?? []
                    list.push(owner)
                    this.declaredIn.set(vo.name, list)
                }
            }
            if (d.members) this.registerDeclarations(d.members, undefined, d)
            for (const p of d.policies ?? []) this.registerPolicy(p, undefined)
            if (d.parameters) this.registerDeclarations(d.parameters, undefined)
            if (d.body) this.registerBlock(d.body.declarations, d.body.statements)
        }
    }

    private registerBlock(decls: Declaration[], statements: SclStatement[]) {
        this.registerDeclarations(decls, undefined)
        for (const s of statements) {
            if (s.kind === 'block' || s.kind === 'while') this.registerBlock(s.declarations, s.statements)
            else if (s.kind === 'if') {
                this.registerBlock(s.declarations, s.statements)
                if (s.else) this.registerBlock(s.else.declarations, s.else.statements)
            } else if (s.kind === 'for') {
                if (s.init && s.init.kind === 'declaration') this.registerDeclarations([s.init], undefined)
                this.registerBlock(s.declarations, s.statements)
            }
        }
    }

    private resolveBaseStates(state: State) {
        if (!state.baseStates?.length) return
        const bases: State[] = []
        for (const b of state.baseStates) {
            const target = this.chartsByName.get(b.target)
            if (target) {
                bases.push(target)
                this.index.scopeTargets.set(b, target)
            }
        }
        this.index.baseStates.set(state, bases)
    }

    /** All states a state inherits from (transitively, each once), KIELER's getAllInheritedStates. */
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

    // ----- diagnostics -----

    private unresolved(kind: 'ValuedObject' | 'State' | 'NamedObject' | 'EObject', name: string, span: Reference['span'], message: string, hint: string | undefined, code: string, related?: string[], suggestion?: string) {
        this.diagnostics.push({
            severity: 'error', code, message, hint, span,
            kieler: `Couldn't resolve reference to ${kind} '${name}'.`,
            ...(related?.length ? { related } : {}),
            ...(suggestion ? { suggestion } : {}),
        })
    }

    private unknownVariable(ref: Reference, scope: Scope, callable: boolean, span = ref.span) {
        const name = ref.name
        const nameSpan = { ...span, end: span.start + name.length, endLine: span.line, endCol: span.col + name.length }
        if (callable) {
            const plain = scope.lookup(name)
            if (plain) {
                this.unresolved('ValuedObject', name, nameSpan, `\`${name}\` cannot be called: it is not a method`,
                    `Only methods and extern functions can be called with parentheses. To use the value of \`${name}\`, write it without \`( )\`.`, 'not-callable')
                return
            }
        }
        const suggestion = closest(name, scope.visible())
        const elsewhere = this.declaredIn.get(name)
        const late = this.declaredLate.get(name)
        let hint: string
        if (late) {
            const where = late.owner.isRoot ? `scchart \`${late.owner.name}\`` : `state \`${late.owner.name}\``
            hint = `\`${name}\` is declared on line ${late.line}, after the states or actions of ${where}, where KIELER does not accept a declaration (so it does not exist). Move the declaration to the top of ${where}, before the first state.`
        } else if (elsewhere?.length) {
            const where = elsewhere[0]
            const whereText = where.kind === 'state' ? `inside state ${where.name ? `\`${where.name}\`` : '(unnamed)'}` : `inside ${where.name ? `region \`${where.name}\`` : 'a region'}`
            hint = `\`${name}\` is declared ${whereText}, so it is only visible there. Declare it in a scope that contains every use, for example at the top of the scchart.`
        } else if (suggestion) {
            hint = suggestion.toLowerCase() === name.toLowerCase() ? `Did you mean \`${suggestion}\`? Names are case-sensitive.` : `Did you mean \`${suggestion}\`?`
        } else {
            hint = `Declare it before using it, for example \`input bool ${name}\` or \`int ${name} = 0\` at the top of the scchart.`
        }
        this.unresolved('ValuedObject', name, nameSpan, suggestion && !elsewhere?.length ? `Unknown name \`${name}\` (did you mean \`${suggestion}\`?)` : `Unknown name \`${name}\``, hint, 'unknown-variable', undefined, suggestion && !elsewhere?.length ? suggestion : undefined)
    }

    // ----- states, regions -----

    private stateScope(state: State, parent: Scope | undefined): Scope {
        const scope = new Scope(parent, state, `state ${state.name}`)
        for (const d of state.declarations) for (const vo of d.valuedObjects) scope.add(vo, d)
        if (state.baseStates?.length) {
            for (const base of this.allInherited(state)) {
                for (const d of base.declarations) if (!isPrivate(d)) for (const vo of d.valuedObjects) scope.add(vo, d)
            }
        }
        this.stateScopes.set(state, scope)
        return scope
    }

    private resolveState(state: State, parent: Scope | undefined) {
        const scope = this.stateScope(state, parent)
        if (state.baseStates) {
            for (const b of state.baseStates) {
                const target = this.index.scopeTargets.get(b)
                if (!target) {
                    this.unresolved('State', b.target, b.targetSpan ?? b.span, `There is no scchart called \`${b.target}\` to extend`, this.chartHint(b.target), 'unknown-chart')
                    for (const p of b.parameters) this.resolveExpression(p.expression, scope)
                } else {
                    this.resolveScopeParameters(b, target, scope)
                }
            }
        }
        this.resolveDeclarations(state.declarations, scope)
        for (const a of state.actions) this.resolveAction(a, scope)
        if (state.reference) this.resolveScopeCall(state.reference, scope, state)
        for (const r of state.regions) this.resolveRegion(r, state, scope)
        for (const p of state.policies ?? []) this.resolvePolicy(p, scope)
    }

    /** A policy region: its transitions go to its own states; names are those of the region, the class and above. */
    private resolvePolicy(region: Region, parent: Scope) {
        const scope = new Scope(parent, region, `policy ${region.name ?? ''}`)
        for (const d of region.declarations) for (const vo of d.valuedObjects) scope.add(vo, d)
        this.resolveDeclarations(region.declarations, scope)
        for (const s of region.states) {
            this.stateScopes.set(s, scope)
            for (const t of s.transitions) this.resolveTransition(t, s, region)
        }
    }

    private chartHint(name: string): string {
        const s = closest(name, this.chartsByName.keys())
        return s ? `Did you mean \`${s}\`?` : 'The referenced chart must be another scchart in this file or in an imported file (`import "File"`).'
    }

    private resolveScopeCall(call: ScopeCall, scope: Scope, state: State) {
        if (call.super) {
            // `is super.X` only in regions; on a state it refers to an inherited state (rare): leave it.
            for (const p of call.parameters) this.resolveExpression(p.expression, scope)
            return
        }
        const target = this.chartsByName.get(call.target)
        if (!target) {
            this.unresolved('NamedObject', call.target, call.targetSpan ?? call.span, `There is no scchart called \`${call.target}\``, this.chartHint(call.target), 'unknown-chart')
            for (const p of call.parameters) {
                this.resolveExpression(p.expression, scope)
                if (p.binding !== undefined) this.unresolved('ValuedObject', p.binding, p.bindingSpan ?? p.span, `Cannot bind \`${p.binding}\`: the referenced chart is unknown`, undefined, 'unknown-binding')
            }
            return
        }
        if (target === state) return
        this.index.scopeTargets.set(call, target)
        this.resolveScopeParameters(call, target, scope)
    }

    /** Parameters of `is X(...)`, `extends X(...)` and `ref X x(...)`: expressions in the caller's scope, bindings in X's interface. */
    private resolveScopeParameters(call: { parameters: ScopeCall['parameters'] }, target: State, scope: Scope) {
        const io = new Map<string, ValuedObject>()
        const addIO = (d: Declaration) => {
            if (d.input || d.output) for (const vo of d.valuedObjects) if (!io.has(vo.name)) io.set(vo.name, vo)
        }
        target.declarations.forEach(addIO)
        for (const base of this.allInherited(target)) base.declarations.filter(d => !isPrivate(d)).forEach(addIO)
        for (const p of call.parameters) {
            this.resolveExpression(p.expression, scope)
            if (p.binding !== undefined) {
                const vo = io.get(p.binding)
                if (vo) p.bindingDecl = vo.id
                else {
                    const s = closest(p.binding, io.keys())
                    this.unresolved('ValuedObject', p.binding, p.bindingSpan ?? p.span, `\`${target.name}\` has no input or output called \`${p.binding}\``,
                        s ? `Did you mean \`${s}\`? After \`to\` comes the name of an input or output of \`${target.name}\`.` : `After \`to\` comes the name of an input or output of \`${target.name}\`${io.size ? ` (${[...io.keys()].slice(0, 6).map(n => `\`${n}\``).join(', ')})` : ''}.`, 'unknown-binding')
                }
            }
        }
    }

    private resolveRegion(region: Region, parentState: State, parentScope: Scope) {
        const scope = new Scope(parentScope, region, region.name ? `region ${region.name}` : 'region')
        for (const d of region.declarations) for (const vo of d.valuedObjects) scope.add(vo, d)
        if (region.forLoop) {
            const entry = this.index.vos.get(counterId(region))
            if (entry) scope.add(entry.vo, undefined)
            this.resolveExpression(region.forLoop.from, scope)
            if (region.forLoop.to) this.resolveExpression(region.forLoop.to, scope)
        }
        if (region.reference) {
            // `region R is X`: X names a region inherited by the next enclosing state that extends another chart
            // (KIELER's nextSuperStateWithBaseStates.getAllVisibleInheritedRegions).
            let holder: State | undefined = parentState
            while (holder && !holder.baseStates?.length) {
                const r = this.index.parentRegion.get(holder)
                holder = r ? this.index.parentState.get(r) : undefined
            }
            const inherited = holder ? this.allInherited(holder).flatMap(s => s.regions) : []
            const target = inherited.find(r => r.name === region.reference!.target)
            if (!target) {
                this.unresolved('NamedObject', region.reference.target, region.reference.targetSpan ?? region.reference.span, `There is no inherited region called \`${region.reference.target}\``,
                    holder ? '`region R is X` names a region of a base chart (`extends`).' : '`region ... is X` refers to a region of a base chart; this chart does not extend another one.', 'unknown-region')
            }
            for (const p of region.reference.parameters) this.resolveExpression(p.expression, scope)
        }
        this.resolveDeclarations(region.declarations, scope)
        for (const a of region.actions) this.resolveAction(a, scope)
        for (const eq of region.equations) this.resolveEquation(eq, scope)
        for (const s of region.states) {
            this.resolveState(s, scope)
        }
        // Transitions after all states of the region are known (targets may come later in the text).
        for (const s of region.states) for (const t of s.transitions) this.resolveTransition(t, s, region)
    }

    private resolveTransition(t: Transition, source: State, region: Region) {
        const scope = this.stateScopes.get(source)!
        const target = region.states.find(s => s.name === t.targetName && s.name !== '')
        if (target) {
            t.target = target.id
            this.index.targets.set(t, target)
            this.index.incoming.get(target)?.push(t)
        } else if (t.targetName) {
            const siblings = region.states.map(s => s.name).filter(Boolean)
            const s = closest(t.targetName, siblings)
            const elsewhere = [...this.index.states.values()].find(st => st.name === t.targetName && !st.isRoot)
            let hint: string
            if (elsewhere) {
                const er = this.index.parentRegion.get(elsewhere)
                const ep = er ? this.index.parentState.get(er) : undefined
                hint = `\`${t.targetName}\` is in another region${ep ? ` (inside ${ep.isRoot ? `scchart \`${ep.name}\`` : `state \`${ep.name}\``})` : ''}. A transition can only go to a state of the same region as \`${source.name}\`; to leave a superstate, add a transition to the superstate itself.`
            } else if (s) {
                hint = s.toLowerCase() === t.targetName.toLowerCase() ? `Did you mean \`${s}\`? State names are case-sensitive.` : `Did you mean \`${s}\`?`
            } else {
                hint = `Add a state \`${t.targetName}\` to this region, or go to one of ${siblings.slice(0, 6).map(n => `\`${n}\``).join(', ')}.`
            }
            this.unresolved('State', t.targetName, t.targetSpan, s && !elsewhere ? `There is no state \`${t.targetName}\` here (did you mean \`${s}\`?)` : `There is no state \`${t.targetName}\` in this region`, hint, 'unknown-state', [source.id, t.id], s && !elsewhere ? s : undefined)
        }
        if (t.trigger) this.resolveExpression(t.trigger, scope)
        this.resolveEffects(t.effects, scope)
    }

    private resolveAction(a: LocalAction, scope: Scope) {
        if (a.trigger) this.resolveExpression(a.trigger, scope)
        this.resolveEffects(a.effects, scope)
    }

    private resolveEquation(eq: Equation, scope: Scope) {
        if (eq.callArgs) {
            this.resolveReference(eq.target, scope, { callable: !eq.target.sub, dataflow: true })
            for (const a of eq.callArgs) this.resolveExpression(a, scope, true)
            if (eq.expression.kind !== 'call') this.resolveExpression(eq.expression, scope, true)
            return
        }
        this.resolveReference(eq.target, scope, { dataflow: true })
        this.resolveExpression(eq.expression, scope, true)
    }

    // ----- declarations -----

    private resolveDeclarations(decls: Declaration[], scope: Scope) {
        for (const d of decls) {
            for (const vo of d.valuedObjects) {
                for (const c of vo.cardinalities) this.resolveExpression(c, scope)
                if (vo.initialValue) this.resolveExpression(vo.initialValue, scope)
            }
            if (d.declKind === 'reference' && !d.extern && d.referenceTarget) this.resolveRefDeclaration(d, scope)
            if (d.declKind === 'primitive' && d.referenceTarget) {
                // `primitive T x` refers to a primitive generic type parameter of the root state: <T is primitive>.
                let root: State | undefined
                for (let s: Scope | undefined = scope; s; s = s.parent) if (s.owner?.kind === 'state' && s.owner.isRoot) root = s.owner
                const generic = root?.genericParameters?.map(g => /^\s*([A-Za-z_^][\w']*)\s*(?:is\s+(.*))?$/.exec(g)).find(m => m?.[1] === d.referenceTarget)
                const kind = generic?.[2]?.trim()
                if (!generic || !kind || !/^(primitive|pure|bool|int|float|string|clock|clock-time)$/.test(kind)) {
                    this.unresolved('EObject', d.referenceTarget, d.referenceSpan ?? d.span, `There is no primitive type parameter \`${d.referenceTarget}\``,
                        `\`primitive ${d.referenceTarget} x\` needs a generic parameter of the chart declared as \`<${d.referenceTarget} is primitive>\`.`, 'unknown-type')
                }
            }
            if (d.members) {
                const classScope = new Scope(scope, undefined, `class ${d.className ?? ''}`)
                for (const m of d.members) for (const vo of m.valuedObjects) classScope.add(vo, m)
                this.resolveDeclarations(d.members, classScope)
                for (const p of d.policies ?? []) this.resolvePolicy(p, classScope)
            }
            if (d.declKind === 'method') this.resolveMethod(d, scope)
        }
    }

    private resolveRefDeclaration(d: Declaration, scope: Scope) {
        let target: State | Declaration | undefined
        if (d.referenceContainer) {
            const container = this.chartsByName.get(d.referenceContainer)
            if (!container) {
                this.unresolved('EObject', d.referenceContainer, d.span, `There is no scchart called \`${d.referenceContainer}\``, this.chartHint(d.referenceContainer), 'unknown-chart')
                return
            } else {
                target = this.findType(container, d.referenceTarget!)
            }
        } else {
            target = this.chartsByName.get(d.referenceTarget!) ?? this.findTypeInScopeChain(scope, d.referenceTarget!)
        }
        if (!target) {
            this.unresolved('EObject', d.referenceTarget!, d.referenceSpan ?? d.span, `There is no scchart, class or enum called \`${d.referenceTarget}\``, this.chartHint(d.referenceTarget!), 'unknown-chart')
            return
        }
        this.index.refTargets.set(d, target)
        if (target.kind === 'state') {
            for (const vo of d.valuedObjects) if (vo.parameters) this.resolveScopeParameters({ parameters: vo.parameters }, target, scope)
        } else {
            for (const vo of d.valuedObjects) for (const p of vo.parameters ?? []) this.resolveExpression(p.expression, scope)
        }
    }

    /** Class or enum declared in a chart (the enum's type name or the class's name). */
    private findType(chart: State, name: string): Declaration | undefined {
        for (const d of [...chart.declarations, ...this.allInherited(chart).flatMap(s => s.declarations)]) {
            if ((d.declKind === 'class' || d.declKind === 'struct' || d.declKind === 'enum') && (d.className === name || (d.declKind === 'enum' && d.valuedObjects[0]?.name === name))) return d
        }
        return undefined
    }

    private findTypeInScopeChain(scope: Scope, name: string): Declaration | undefined {
        // KIELER looks in the root state's declarations (and inherited ones).
        let root: State | undefined
        for (let s: Scope | undefined = scope; s; s = s.parent) if (s.owner?.kind === 'state' && s.owner.isRoot) root = s.owner
        return root ? this.findType(root, name) : undefined
    }

    private resolveMethod(d: Declaration, scope: Scope) {
        const methodScope = new Scope(scope, undefined, `method ${d.valuedObjects[0]?.name ?? ''}`)
        for (const p of d.parameters ?? []) for (const vo of p.valuedObjects) methodScope.add(vo, p)
        for (const p of d.parameters ?? []) for (const vo of p.valuedObjects) if (vo.initialValue) this.resolveExpression(vo.initialValue, methodScope)
        if (d.body) this.resolveBlock(d.body.declarations, d.body.statements, methodScope)
    }

    /** `outer`: the labels of the enclosing blocks (a goto may jump to a label of an enclosing block, conformance
     *  structure/153). */
    private resolveBlock(decls: Declaration[], statements: SclStatement[], parent: Scope, outer: ReadonlySet<string> = new Set()) {
        const scope = new Scope(parent, undefined, 'block')
        for (const d of decls) for (const vo of d.valuedObjects) scope.add(vo, d)
        this.resolveDeclarations(decls, scope)
        const labels = new Set([...outer, ...statements.filter(s => s.kind === 'label').map(s => (s as { name: string }).name)])
        for (const s of statements) this.resolveStatement(s, scope, labels)
    }

    private resolveStatement(s: SclStatement, scope: Scope, labels: Set<string>) {
        switch (s.kind) {
            case 'assign': this.resolveReference(s.target, scope, {}); this.resolveExpression(s.expression, scope); break
            case 'postfix': this.resolveReference(s.target, scope, {}); break
            case 'call': case 'print': case 'randomize': case 'hostcode': this.resolveEffect(s, scope); break
            case 'return': this.resolveExpression(s.expression, scope); break
            case 'expression': this.resolveExpression(s.expression, scope); break
            case 'goto':
                if (!labels.has(s.target)) {
                    const end = s.span.end
                    const span = { start: end - s.target.length, end, line: s.span.endLine, col: s.span.endCol - s.target.length, endLine: s.span.endLine, endCol: s.span.endCol }
                    this.diagnostics.push({ severity: 'error', code: 'unknown-label', span, message: `There is no label \`${s.target}\` in this block`, kieler: `Couldn't resolve reference to Label '${s.target}'.` })
                }
                break
            case 'label': break
            case 'block': case 'while':
                if (s.kind === 'while') this.resolveExpression(s.condition, scope)
                this.resolveBlock(s.declarations, s.statements, scope, labels)
                break
            case 'if':
                this.resolveExpression(s.condition, scope)
                this.resolveBlock(s.declarations, s.statements, scope, labels)
                if (s.else) this.resolveBlock(s.else.declarations, s.else.statements, scope, labels)
                break
            case 'for': {
                const loopScope = new Scope(scope, undefined, 'for')
                if (s.init?.kind === 'declaration') {
                    for (const vo of s.init.valuedObjects) loopScope.add(vo, s.init)
                    this.resolveDeclarations([s.init], loopScope)
                } else if (s.init) this.resolveStatement(s.init, loopScope, labels)
                this.resolveExpression(s.condition, loopScope)
                if (s.update) this.resolveStatement(s.update, loopScope, labels)
                this.resolveBlock(s.declarations, s.statements, loopScope, labels)
                break
            }
        }
    }

    // ----- effects -----

    private resolveEffects(effects: Effect[], scope: Scope) {
        for (let i = 0; i < effects.length; i++) {
            const e = effects[i]
            const converted = this.resolveEffect(e, scope)
            if (converted) effects[i] = converted
        }
    }

    /** Resolves an effect; returns a replacement when a valued emission is really a call. */
    private resolveEffect(e: Effect | SclStatement, scope: Scope): Effect | undefined {
        switch (e.kind) {
            case 'assign':
                this.resolveReference(e.target, scope, {})
                this.resolveExpression(e.expression, scope)
                return
            case 'postfix':
                this.resolveReference(e.target, scope, {})
                return
            case 'emit': {
                this.resolveReference(e.target, scope, {})
                if (e.value) this.resolveExpression(e.value, scope)
                if (e.value) {
                    const low = lowermost(e.target)
                    const entry = low.decl ? this.index.vos.get(low.decl) : undefined
                    if (entry?.decl && (entry.decl.declKind === 'method' || entry.decl.declKind === 'reference')) {
                        // `c.add(10)` parsed as an emission is a call with one argument: resolve it again as one (overloads).
                        if (entry.decl.declKind === 'method') this.resolveReference(e.target, scope, { callable: !e.target.sub, args: 1 })
                        const call: Effect = { kind: 'call', name: referenceName(e.target), args: [e.value], target: e.target, span: e.span }
                        if (e.annotations) call.annotations = e.annotations
                        return call
                    }
                }
                return
            }
            case 'call':
                if (!e.extern && e.target) this.resolveReference(e.target, scope, { callable: !e.target.sub, args: e.args.length, super: e.super && !e.target.sub })
                for (const a of e.args) this.resolveExpression(a, scope)
                return
            case 'print': case 'randomize':
                for (const a of e.args) this.resolveExpression(a, scope)
                return
            case 'hostcode':
                return
            case 'code':
                this.resolveBlock(e.declarations ?? [], e.statements ?? [], scope)
                return
        }
    }

    // ----- expressions and references -----

    private resolveExpression(e: Expression, scope: Scope, dataflow = false) {
        switch (e.kind) {
            case 'ref': this.resolveReference(e, scope, { dataflow }); return
            case 'op': for (const a of e.args) this.resolveExpression(a, scope, dataflow); return
            case 'call':
                if (!e.extern && e.target) this.resolveReference(e.target, scope, { callable: !e.target.sub, dataflow, args: e.args.length, super: e.super && !e.target.sub })
                for (const a of e.args) this.resolveExpression(a, scope, dataflow)
                return
            case 'vector': for (const v of e.values) this.resolveExpression(v, scope, dataflow); return
            case 'special':
                if (e.access === 'state' && e.target) {
                    this.resolveStateAccess(e, scope)
                    return
                }
                if (e.access === 'scchart' && e.target) {
                    const chart = this.chartsByName.get(e.target)
                    if (!chart) {
                        this.unresolved('NamedObject', e.target, e.span, `There is no scchart called \`${e.target}\``, this.chartHint(e.target), 'unknown-chart')
                        if (e.sub) this.reportSubUnresolved(e.sub)
                    } else if (e.sub) {
                        const members = new Map<string, ValuedObject>()
                        for (const d of chart.declarations) {
                            const global = (d.declKind === 'variable' && !d.input && isPublic(d) && d.const) || ((d.declKind === 'class' || d.declKind === 'struct' || d.declKind === 'enum') && isPublic(d))
                            if (global) for (const vo of d.valuedObjects) if (!members.has(vo.name)) members.set(vo.name, vo)
                        }
                        this.resolveInMembers(e.sub, members, scope, dataflow)
                    }
                }
                return
            default: return
        }
    }

    /** `state(S)` / `state(R.S)`: a state of the enclosing scope (SCTXScopeProvider.getScopeForSpecialAccess). */
    private resolveStateAccess(e: Extract<Expression, { kind: 'special' }>, scope: Scope) {
        let owner: State | Region | undefined
        for (let s: Scope | undefined = scope; s && !owner; s = s.parent) owner = s.owner
        const nameSpan = (name: string, after = 0) => {
            const i = e.text.indexOf(name, after)
            const start = e.span.start + Math.max(0, i)
            return { start, end: start + name.length, line: e.span.line, col: e.span.col + Math.max(0, i), endLine: e.span.line, endCol: e.span.col + Math.max(0, i) + name.length }
        }
        let candidates: State[] = []
        if (e.container !== undefined) {
            const region = owner?.kind === 'state' ? owner.regions.find(r => r.name === e.container) : undefined
            if (!region) {
                this.unresolved('NamedObject', e.container, nameSpan(e.container, e.text.indexOf('(')), `There is no region \`${e.container}\` here`, undefined, 'unknown-region')
            } else if (region.regionType === 'controlflow') candidates = region.states
        } else if (owner?.kind === 'state') {
            candidates = owner.regions.filter(r => r.regionType === 'controlflow' && !r.name).flatMap(r => r.states)
        } else if (owner?.kind === 'region' && owner.regionType === 'controlflow') {
            candidates = owner.states
        }
        if (e.container !== undefined && !candidates.length && !(owner?.kind === 'state' && owner.regions.some(r => r.name === e.container))) return
        const target = candidates.find(s => s.name === e.target)
        if (!target) {
            const after = e.container !== undefined ? e.text.indexOf('.') : e.text.indexOf('(')
            this.unresolved('NamedObject', e.target!, nameSpan(e.target!, after), `There is no state \`${e.target}\` here`, undefined, 'unknown-state')
        } else {
            e.state = target.id
            if (e.container === undefined && owner?.kind === 'state' && candidates.filter(s => s.name === e.target).length > 1) this.index.ambiguousStateAccess.add(e)
        }
    }

    private reportSubUnresolved(r: Reference) {
        this.unresolved('ValuedObject', r.name, r.span, `Unknown member \`${r.name}\``, undefined, 'unknown-variable')
        for (const i of r.indices) void i
        if (r.sub) this.reportSubUnresolved(r.sub)
    }

    /** `super.m(...)`: only methods inherited by the enclosing states (KIELER's scope for super calls). */
    private lookupSuper(name: string, scope: Scope): ValuedObject | undefined {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
            if (s.owner?.kind !== 'state' || !s.owner.baseStates?.length) continue
            for (const base of this.allInherited(s.owner)) {
                for (const d of base.declarations) if (d.declKind === 'method' && !isPrivate(d)) for (const vo of d.valuedObjects) if (vo.name === name) return vo
            }
        }
        return undefined
    }

    private resolveReference(ref: Reference, scope: Scope, opts: { callable?: boolean; dataflow?: boolean; args?: number; super?: boolean }) {
        const vo = opts.super ? this.lookupSuper(ref.name, scope)
            : opts.callable && opts.args !== undefined ? scope.lookupCall(ref.name, opts.args) : scope.lookup(ref.name, !!opts.callable)
        for (const i of ref.indices) this.resolveExpression(i, scope, opts.dataflow)
        if (!vo) {
            this.unknownVariable(ref, scope, !!opts.callable)
            if (ref.sub) this.reportSubUnresolved(ref.sub)
            return
        }
        ref.decl = vo.id
        if (ref.sub) this.resolveSub(ref.sub, vo, scope, !!opts.dataflow, opts.args)
    }

    /** `args`: a call's number of arguments, for choosing among overloaded methods of the last member. */
    private resolveSub(sub: Reference, parentVO: ValuedObject, scope: Scope, dataflow: boolean, args?: number) {
        const members = this.membersOf(parentVO, dataflow)
        if (!members) {
            const entry = this.index.vos.get(parentVO.id)
            this.unresolved('ValuedObject', sub.name, sub.span, `\`${parentVO.name}\` has no members`,
                entry?.decl?.declKind === 'variable' ? `\`${parentVO.name}\` is a plain variable; \`.\` is only for referenced charts, classes, structs and enums.` : undefined, 'unknown-variable')
            if (sub.sub) this.reportSubUnresolved(sub.sub)
            for (const i of sub.indices) this.resolveExpression(i, scope, dataflow)
            return
        }
        this.resolveInMembers(sub, members, scope, dataflow, args, parentVO)
    }

    private resolveInMembers(sub: Reference, members: Map<string, ValuedObject>, scope: Scope, dataflow: boolean, args?: number, parentVO?: ValuedObject) {
        for (const i of sub.indices) this.resolveExpression(i, scope, dataflow)
        let vo = members.get(sub.name)
        // Methods of one name differ in their number of parameters (KIELER's overloading, structure.md S-62).
        if (vo && !sub.sub && args !== undefined && parentVO) {
            const overload = this.memberMethods(parentVO).find(m => m.vo.name === sub.name && (m.decl.parameters?.length ?? 0) === args)
            if (overload) vo = overload.vo
        }
        if (!vo) {
            const s = closest(sub.name, members.keys())
            this.unresolved('ValuedObject', sub.name, sub.span, `Unknown member \`${sub.name}\`${s ? ` (did you mean \`${s}\`?)` : ''}`,
                members.size ? `Available: ${[...members.keys()].slice(0, 8).map(n => `\`${n}\``).join(', ')}.` : undefined, 'unknown-variable', undefined, s)
            if (sub.sub) this.reportSubUnresolved(sub.sub)
            return
        }
        sub.decl = vo.id
        if (sub.sub) this.resolveSub(sub.sub, vo, scope, dataflow, args)
    }

    /** The methods reachable as members of `vo` (a class or struct instance, or a referenced chart). */
    private memberMethods(vo: ValuedObject): { vo: ValuedObject; decl: Declaration }[] {
        const d = this.index.vos.get(vo.id)?.decl
        if (!d) return []
        const target = d.declKind === 'reference' && !d.extern ? this.index.refTargets.get(d) : d
        if (!target) return []
        const decls = target.kind === 'declaration' ? target.members ?? [] : target.declarations
        return decls.filter(m => m.declKind === 'method').flatMap(m => m.valuedObjects.map(v => ({ vo: v, decl: m })))
    }

    /** Members visible through `vo.` (KExtScopeProvider.getScopeForReferencedDeclarationFromSubReference). */
    private membersOf(vo: ValuedObject, dataflow: boolean): Map<string, ValuedObject> | undefined {
        const entry = this.index.vos.get(vo.id)
        const d = entry?.decl
        if (!d) return undefined
        const out = new Map<string, ValuedObject>()
        const add = (decl: Declaration) => { for (const v of decl.valuedObjects) if (!out.has(v.name)) out.set(v.name, v) }
        const structMembers = (cls: Declaration) => {
            for (const m of cls.members ?? []) if (isPublic(m)) add(m)
            return out
        }
        if (d.declKind === 'reference' && !d.extern) {
            const target = this.index.refTargets.get(d)
            if (!target) return undefined
            if (target.kind === 'declaration') return structMembers(target)
            // A referenced chart: its methods, then its (public / input-output) declarations, then inherited ones.
            for (const m of target.declarations) if (m.declKind === 'method') add(m)
            for (const base of this.allInherited(target)) for (const m of base.declarations) if (!isPrivate(m)) add(m)
            for (const m of target.declarations) {
                if (m.declKind !== 'variable' && m.declKind !== 'reference') continue
                if (dataflow ? (m.input || m.output) : isPublic(m)) add(m)
            }
            return out
        }
        if (d.declKind === 'class' || d.declKind === 'struct' || d.declKind === 'enum') return structMembers(d)
        return undefined
    }
}

/** The innermost reference of a chain `a.b.c` (c). */
export function lowermost(r: Reference): Reference {
    return r.sub ? lowermost(r.sub) : r
}

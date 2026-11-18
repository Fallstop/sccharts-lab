// KIELER's replacement stack (kexpressions/kext/extensions/Replacements.xtend) and the Reference processor's walk
// that applies it (Reference.xtend replaceValuedObjectReferences*, replaceReferences). structure.md S-9, S-73.
//
// The stack is keyed by NAME: binding a referenced chart's interface or generic parameters pushes `name -> actual`,
// every scope the walk enters pushes its own declarations as themselves (so an inner declaration hides a binding of
// the same name) and pops them when it leaves, and a nested reference starts from a copy of the whole stack. The
// root of a copy does not push its declarations, so a name that is bound further out and declared at the top of a
// nested chart is taken for the outer one (a generic parameter is no declaration, so nothing renames it out of the
// way: structure.md S-73).
//
// What the walk visits is KIELER's: declarations (sizes, initial values, the arguments of a `ref` declaration's
// variables, method bodies), actions, outgoing transitions, reference arguments, regions with their states or
// equations. It does not visit the members of a class, the range of a for-region, the generic arguments of a
// reference or of a `ref` declaration, or the arguments of `print` and extern calls: a bound name left there points
// out of the model, which KIELER reports after the expansion (Reference.validate).

import type { Diagnostic } from '../../types'
import type { CEquation } from '../lower'
import {
    copyExpr, isRegion, type CArg, type CEffect, type CExpr, type CGenericArg, type CRef, type CRegion, type CState, type CStmt, type CVar,
    type Scope,
} from '../model'

export class Replacements {
    /** Type parameters by name (not passed on to nested references: KIELER's copy constructor leaves them out). */
    readonly types = new Map<string, CGenericArg>()
    private readonly stacks = new Map<string, CExpr[]>()

    constructor(parent?: Replacements) {
        // (An emptied stack is no key of the copy: KIELER's copy pushes what is there.)
        if (parent) for (const [name, stack] of parent.stacks) if (stack.length) this.stacks.set(name, [...stack])
    }

    push(name: string, e: CExpr) {
        const stack = this.stacks.get(name)
        if (stack) stack.push(e)
        else this.stacks.set(name, [e])
    }

    peek(name: string): CExpr | undefined {
        const stack = this.stacks.get(name)
        return stack?.length ? stack[stack.length - 1] : undefined
    }

    pop(name: string) {
        this.stacks.get(name)?.pop()
    }

    /** KIELER's containsKey: a name that was ever pushed stays a key, even with an empty stack. */
    has(name: string): boolean {
        return this.stacks.has(name)
    }

    names(): string[] {
        return [...this.stacks.keys()]
    }

    get empty(): boolean {
        return this.stacks.size === 0
    }
}

/** KIELER names the expression class it cannot substitute (S-8). */
const CLASS_NAMES: Partial<Record<CExpr['k'], string>> = {
    op: 'de.cau.cs.kieler.kexpressions.impl.OperatorExpressionImpl',
    random: 'de.cau.cs.kieler.kexpressions.impl.RandomCallImpl',
    host: 'de.cau.cs.kieler.kexpressions.impl.TextExpressionImpl',
    call: 'de.cau.cs.kieler.kexpressions.impl.ReferenceCallImpl',
}

export function expressionClass(e: CExpr): string {
    return CLASS_NAMES[e.k] ?? 'de.cau.cs.kieler.kexpressions.impl.ExpressionImpl'
}

/** A literal in KIELER's sense (a Value: also a vector and `null`). */
export function isValue(e: CExpr): boolean {
    return e.k === 'lit' || e.k === 'vector' || e.k === 'null'
}

export interface ReplaceOptions {
    report(d: Diagnostic): void
    /** The state the bindings were written at, for the diagnostics. */
    owner?: string
    /**
     * KIELER's `expand`: a referencing state met on the way is expanded there and then, with a copy of the stack as
     * it is at that point.
     */
    expand?(state: CState, replacements: Replacements): void
    /** The same for `region R is X`. */
    expandRegion?(region: CRegion, replacements: Replacements): void
    /** Variables whose declaration KIELER has replaced by one with a literal as its initial value (once each). */
    literals: Set<CVar>
    /** Bindings already reported as unusable. */
    reported: Set<string>
    /** Names whose assignment was reported: the target stays as it is and is no second error. */
    failed: Set<CVar>
}

/** A variable KIELER declares with a VariableDeclaration: a literal bound to it becomes its initial value. */
function hasVariableDeclaration(v: CVar): boolean {
    return !v.declKind && v.role !== 'frame'
}

export class Replacer {
    constructor(private readonly replacements: Replacements, private readonly options: ReplaceOptions) {}

    // ----- scopes (replaceValuedObjectReferences, ...InState, ...InRegion) -----

    /** A scope inside the copy: its own declarations hide the bindings of the same names while it is walked. */
    scope(scope: Scope) {
        const own = [...scope.decls]
        for (const v of own) this.replacements.push(v.name, { k: 'ref', v, idx: [] })
        if (isRegion(scope)) this.region(scope)
        else this.state(scope)
        for (const v of own) this.replacements.pop(v.name)
    }

    /** The root of a copy (or a state the walk has entered): KIELER's replaceValuedObjectReferencesInState. */
    state(state: CState) {
        this.declarations(state)
        for (const a of state.actions) {
            if (a.trigger) a.trigger = this.expr(a.trigger)
            a.effects = a.effects.map(f => this.effect(f))
        }
        for (const t of state.out) {
            if (t.trigger) t.trigger = this.expr(t.trigger)
            t.effects = t.effects.map(f => this.effect(f))
        }
        if (state.ext.reference !== undefined || state.ext.call !== undefined) {
            const args = state.ext.args as CArg[] | undefined
            if (args) state.ext.args = args.map(a => ({ ...a, expr: this.expr(a.expr) }))
            const call = state.ext.call as { args: CArg[] } | undefined
            if (call) call.args = call.args.map(a => ({ ...a, expr: this.expr(a.expr) }))
            this.options.expand?.(state, new Replacements(this.replacements))
        }
        for (const r of [...state.regions]) this.scope(r)
    }

    region(region: CRegion) {
        this.declarations(region)
        for (const a of region.actions) {
            if (a.trigger) a.trigger = this.expr(a.trigger)
            a.effects = a.effects.map(f => this.effect(f))
        }
        if (region.ext.reference !== undefined) {
            const args = region.ext.args as CArg[] | undefined
            if (args) region.ext.args = args.map(a => ({ ...a, expr: this.expr(a.expr) }))
            this.options.expandRegion?.(region, new Replacements(this.replacements))
        }
        if (region.dataflow) {
            const eqs = region.ext.eqs as CEquation[] | undefined
            if (eqs) {
                region.ext.eqs = eqs.map(eq => {
                    const target = this.ref(eq.target)
                    return { ...eq, expr: this.expr(eq.expr), target: target.k === 'ref' ? target : eq.target }
                })
            }
        } else {
            for (const s of [...region.states]) this.scope(s)
        }
    }

    private declarations(scope: Scope) {
        for (const v of [...scope.decls]) {
            // The members of a class are not visited (only a declaration's own variables are).
            if (v.member) continue
            if (v.method) this.method(v)
            v.dims = v.dims.map(d => this.expr(d))
            if (v.init) v.init = this.expr(v.init)
            if (v.instance) {
                v.instance = {
                    ...v.instance,
                    // `ref C g<N>`: the variable's own generic arguments; the declaration's (`ref C<N> g`) are not visited.
                    ...(v.instance.generics && !v.instance.declGenerics ? { generics: v.instance.generics.map(g => this.genericArg(g)) } : {}),
                    args: v.instance.args.map(a => ({ ...a, expr: this.expr(a.expr) })),
                }
            }
        }
    }

    private genericArg(g: CGenericArg): CGenericArg {
        return g.k === 'expr' ? { ...g, expr: this.expr(g.expr) } : g
    }

    /**
     * replaceValuedObjectReferencesInSclScope: every SCL scope (the body, an `if` branch, a loop, a plain block)
     * pushes its own declarations as themselves, all at once and for as long as it is walked, the body its
     * parameters too. So a local hides a bound name inside its block only (after a `for (int N = 0; ...)` the name
     * `N` is the binding again). A declaration's initial value is not visited (a bound name stays in it and points
     * out of the model), except that of a `for` loop's own declaration; an `if`'s condition is replaced before the
     * branch's declarations are pushed.
     */
    private method(v: CVar) {
        const m = v.method!
        // A body without block numbers (made by a pass): every local hides its name everywhere, as before.
        const own = (block: number | undefined) => (block === undefined ? [] : m.locals.filter(l => l.block === block))
        const frame = [...m.params, ...(m.scope === undefined ? m.locals : own(m.scope))]
        const within = <T>(locals: CVar[], walk: () => T): T => {
            for (const p of locals) this.replacements.push(p.name, { k: 'ref', v: p, idx: [] })
            const out = walk()
            for (const p of locals) this.replacements.pop(p.name)
            return out
        }
        const statements = (list: CStmt[]): CStmt[] => list.map(s => (s.blocks?.length ? within(s.blocks.flatMap(own), () => statement(s)) : statement(s)))
        const statement = (s: CStmt): CStmt => {
            switch (s.k) {
                case 'do': return s.init && m.scope !== undefined ? s : { ...s, f: this.effect(s.f) }
                case 'if': {
                    this.conditionNamesLocal(s.cond, own(s.scope))
                    const cond = this.expr(s.cond)
                    const then = within(own(s.scope), () => statements(s.then))
                    return { ...s, cond, then, else: s.else ? within(own(s.elseScope), () => statements(s.else!)) : undefined }
                }
                case 'while': return within(own(s.scope), () => ({ ...s, cond: this.expr(s.cond), body: statements(s.body) }))
                case 'for': return within(own(s.scope), () => {
                    // The loop's own declaration (one variable) is the only one whose initial value is visited.
                    const init = s.init.map((i): CStmt => (i.k === 'do' ? { ...i, f: this.effect(i.f) } : statement(i)))
                    return { ...s, init, cond: s.cond ? this.expr(s.cond) : undefined, update: statements(s.update), body: statements(s.body) }
                })
                case 'return': return { ...s, expr: s.expr ? this.expr(s.expr) : undefined }
                case 'expr': return { ...s, e: this.expr(s.e) }
                default: return s
            }
        }
        m.body = within(frame, () => statements(m.body))
    }

    /**
     * To KIELER the condition of an `if` is inside the scope of the branch's declarations, so a name declared there
     * is that local in the condition too, but the condition is replaced before the local is pushed: with a value
     * bound to the name, KIELER tries to give the local the value as its initial value and fails on its container.
     */
    private conditionNamesLocal(cond: CExpr, locals: CVar[]) {
        if (!locals.length) return
        const hit = (e: CExpr): CRef | undefined => {
            if (e.k === 'ref') {
                const bound = e.sub ? undefined : this.replacements.peek(e.v.name)
                if (bound && isValue(bound) && !(bound.k === 'lit' && bound.konst !== undefined) && locals.some(l => l.name === e.v.name)) return e
                return e.idx.map(hit).find(Boolean)
            }
            if (e.k === 'op') return e.args.map(hit).find(Boolean)
            if (e.k === 'vector') return e.values.map(hit).find(Boolean)
            if (e.k === 'call' && e.target && !e.extern) return e.args.map(hit).find(Boolean)
            return undefined
        }
        const r = hit(cond)
        if (!r) return
        this.options.report({
            severity: 'error', code: 'kieler-crash', span: r.span, related: this.options.owner ? [this.options.owner] : undefined,
            message: `KIELER's compiler crashes on \`${r.v.name}\` in this condition: the branch declares a variable \`${r.v.name}\` of its own, and the name stands for a value here`,
            kieler: 'java.lang.ClassCastException: class de.cau.cs.kieler.scl.impl.ConditionalImpl cannot be cast to class de.cau.cs.kieler.sccharts.Scope',
            hint: `To KIELER the condition of an \`if\` already belongs to the block that declares \`${r.v.name}\`. Give the variable declared in the block another name.`,
        })
    }

    // ----- effects and expressions (replaceReferences) -----

    effect(f: CEffect): CEffect {
        switch (f.k) {
            case 'assign': {
                const expr = f.expr ? this.expr(f.expr) : undefined
                const ref = this.ref(f.ref)
                if (ref.k !== 'ref') {
                    this.options.failed.add(f.ref.v)
                    const bound = this.replacements.peek(f.ref.v.name)
                    if (bound?.k === 'lit' && bound.konst !== undefined) {
                        // The name stands for a constant: KIELER's Const processor finds it on the left of an assignment.
                        this.options.report({
                            severity: 'error', code: 'bound-const-written', span: f.o.span ?? f.ref.span, related: this.options.owner ? [this.options.owner] : undefined,
                            message: `\`${f.ref.v.name}\` stands for the constant \`${bound.konst}\` here, which cannot be assigned`,
                            kieler: `Cannot replace left hand side of assignment by a value. (Trying to replace ${bound.konst} by ${describe(ref)})`,
                            hint: `Binding is substitution: inside the copy \`${f.ref.v.name}\` is \`${bound.konst}\` itself. Pass a variable if the referenced chart writes it.`,
                        })
                        return { ...f, expr }
                    }
                    // The target is replaced by the literal and KIELER casts it back to a reference.
                    this.options.report({
                        severity: 'error', code: 'kieler-crash', span: f.o.span ?? f.ref.span, related: this.options.owner ? [this.options.owner] : undefined,
                        message: `\`${f.ref.v.name}\` stands for the value ${describe(ref)} here and cannot be assigned: KIELER's compiler crashes on this assignment`,
                        kieler: `java.lang.ClassCastException: class ${valueClass(ref)} cannot be cast to class de.cau.cs.kieler.kexpressions.ValuedObjectReference`,
                        hint: `A generic parameter that is given a value (\`<4>\`) is that value wherever the chart names it. Pass a variable instead (\`<x>\`) if the chart writes it, or copy the parameter into a variable of the chart.`,
                    })
                    return { ...f, expr }
                }
                return { ...f, ref, expr }
            }
            case 'emit': {
                const value = f.value ? this.expr(f.value) : undefined
                const bound = f.ref.sub ? undefined : this.replacements.peek(f.ref.v.name)
                if (!bound) return { ...f, value }
                if (bound.k !== 'ref') {
                    this.options.report({
                        severity: 'error', code: 'binding-expression', span: f.o.span ?? f.ref.span, related: this.options.owner ? [this.options.owner] : undefined,
                        message: `\`${f.ref.v.name}\` is emitted here, so it must be bound to a signal, not to ${isValue(bound) ? 'a value' : 'an expression'}`,
                        kieler: `A binding for the valued object "${f.ref.v.name}" in an emission exists, but is not another valued object.\nThe type "${isValue(bound) ? valueClass(bound) : expressionClass(bound)}" is not supported.`,
                        hint: 'Pass a signal of this chart.',
                    })
                    return { ...f, value }
                }
                // Only the variable is taken over (an emission has no indices of its own to keep).
                return { ...f, value, ref: { ...f.ref, v: bound.v } }
            }
            case 'call': {
                const call = this.expr(f.call)
                return call.k === 'call' ? { ...f, call } : f
            }
            // print, host code and randomize are expression types the Reference processor does not know: ignored.
            default: return f
        }
    }

    expr(e: CExpr): CExpr {
        switch (e.k) {
            case 'ref': return this.ref(e)
            case 'op': return { ...e, args: e.args.map(a => this.expr(a)) }
            case 'vector': return { ...e, values: e.values.map(a => this.expr(a)) }
            case 'call': {
                // A call of a method (ReferenceCall): the method's reference, then the arguments. An extern function
                // call is an expression type the processor ignores, with its arguments.
                if (!e.target || e.extern) return e
                const target = this.ref(e.target)
                return { ...e, target: target.k === 'ref' ? target : e.target, args: e.args.map(a => this.expr(a)) }
            }
            default: return e
        }
    }

    /** A reference to a variable: KIELER's replaceReferences(ValuedObjectReference). */
    ref(r: CRef): CExpr {
        const idx = r.idx.map(i => this.expr(i))
        const sub = r.sub ? this.subIndices(r.sub) : undefined
        const plain: CRef = { ...r, idx, ...(sub ? { sub } : {}) }
        const bound = this.replacements.peek(r.v.name)
        if (!bound) return plain
        if (bound.k === 'ref') {
            if (bound.v === r.v && !bound.idx.length && !bound.sub) return plain
            // The actual's variable, its indices if the use has none (each looked up again), its members in front.
            const out: CRef = { ...plain, v: bound.v }
            if (bound.idx.length && !r.idx.length) out.idx = bound.idx.map(i => (isValue(i) ? copyExpr(i) : this.expr(copyExpr(i))))
            if (bound.sub) out.sub = chain(copyExpr(bound.sub) as CRef, sub)
            return out
        }
        if (isValue(bound)) {
            // replaceReferenceWithLiteral: a declared variable keeps its name and starts with the value; anything
            // else (a generic parameter) is the value where it is named.
            // (A constant's name is a reference to KIELER: plain substitution, the Const processor inlines it later.)
            if (hasVariableDeclaration(r.v) && !(bound.k === 'lit' && bound.konst !== undefined)) {
                if (!this.options.literals.has(r.v)) {
                    this.options.literals.add(r.v)
                    // A vector as the value of a single constant: KIELER's Const processor writes it where the
                    // constant is named, which is no C expression.
                    if (bound.k === 'vector' && r.v.const && !r.v.dims.length) {
                        this.options.report({
                            severity: 'error', code: 'binding-vector', span: bound.span ?? r.span, related: this.options.owner ? [this.options.owner] : undefined,
                            message: `\`${r.v.name}\` is a single constant, and a vector is bound to it`,
                            kieler: 'expected expression before \u2018{\u2019 token\nCompiler did not return success (exit value != 0)',
                            hint: `Bind one value to \`${r.v.name}\`. A vector gives every instance its own value only for an array of instances with one dimension (\`ref C c[2]({3, 8})\`).`,
                        })
                    }
                    r.v.input = false
                    r.v.output = false
                    r.v.signal = false
                    r.v.static = false
                    r.v.init = copyExpr(bound)
                }
                return plain
            }
            return bound.k === 'lit' ? { k: 'lit', t: bound.t, v: bound.v, span: r.span } : { ...copyExpr(bound), span: r.span }
        }
        const key = `${r.v.uid}`
        if (!this.options.reported.has(key)) {
            this.options.reported.add(key)
            this.options.report({
                severity: 'error', code: 'binding-expression', span: bound.span ?? r.span, related: this.options.owner ? [this.options.owner] : undefined,
                message: `\`${r.v.name}\` of the referenced chart is bound to an expression: only variables, array cells and values can be passed`,
                kieler: `A binding for the valued object reference "${r.v.name}" exists, but the type "${expressionClass(bound)}" is not supported.`,
                hint: `Compute the value into a variable of this chart first (for example \`t = ...\`) and pass that variable as \`${r.v.name}\`.`,
            })
        }
        return plain
    }

    /** A member access is not replaced, only the indices on the way. */
    private subIndices(r: CRef): CRef {
        return { ...r, idx: r.idx.map(i => this.expr(i)), ...(r.sub ? { sub: this.subIndices(r.sub) } : {}) }
    }
}

function chain(first: CRef, rest: CRef | undefined): CRef {
    if (!first.sub) return rest ? { ...first, sub: rest } : first
    return { ...first, sub: chain(first.sub, rest) }
}

function describe(e: CExpr): string {
    return e.k === 'lit' ? String(e.v) : e.k === 'vector' ? 'of a vector' : 'null'
}

/** KIELER's class of a value (in its exception texts). */
export function valueClass(e: CExpr): string {
    const name = e.k === 'lit' ? { bool: 'BoolValueImpl', int: 'IntValueImpl', float: 'FloatValueImpl', string: 'StringValueImpl' }[e.t] : e.k === 'vector' ? 'VectorValueImpl' : 'NullValueImpl'
    return `de.cau.cs.kieler.kexpressions.impl.${name}`
}

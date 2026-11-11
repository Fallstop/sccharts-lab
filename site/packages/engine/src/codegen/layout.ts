// The TickData struct: which C member holds which variable, in KIELER's order (CCodeGeneratorStructModule).
//
// KIELER keeps every variable of the chart in one struct: the chart's own top-level declarations in the order written
// (its Signal processor declares signals anew at the end, after the simulation's `_taken_transitions`), then what the
// transformations generate, then the locals of inner states, which its Valued Object Rise moves to the top as
// `_<Chart>_local_<name>` (made unique with a number), then the netlist's guards. sim/memory.ts relies on the same
// order for indices outside an array, so the C code reads and writes the same neighbours as the simulator.

import type { CompiledChart } from '../sim/compile'
import { allScopes, walkExpr, type CEffect, type CExpr, type CStmt, type CVar } from '../sim/model'
import type { CVariable } from './types'

export interface Slot {
    v: CVar
    /** The member of the struct (`count`, `_Chart_local_x`, `home.count`). */
    member: string
}

/** C's keywords and the names the generated code uses itself (KIELER rejects charts using them: codegen.ts). */
const RESERVED = new Set(['d', 'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
    'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static',
    'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'inline', 'restrict', 'bool'])

/** The C type of a variable (one element). */
export function ctypeOf(v: CVar): string {
    switch (v.type) {
        case 'bool': case 'pure': return 'char'
        case 'int': return 'int'
        case 'float': case 'clock': case 'clock-time': return 'double'
        case 'string': return 'char*'
        default: return v.hostType || 'int'
    }
}

export function simpleType(v: CVar): CVariable['type'] {
    switch (v.type) {
        case 'bool': case 'pure': return 'bool'
        case 'int': return 'int'
        case 'float': case 'clock': case 'clock-time': return 'float'
        case 'string': return 'string'
        default: return v.hostType ? 'host' : 'int'
    }
}

export const dimsOf = (v: CVar): number[] => v.dims.map(d => (d.k === 'lit' && typeof d.v === 'number' ? d.v : 0))

/** A C identifier made of the name (generated names are KIELER's already; this only guards against odd ones). */
function identifier(name: string): string {
    const s = name.replace(/[^A-Za-z0-9_]/g, '_')
    return /^[0-9]/.test(s) ? `_${s}` : s
}

export class Layout {
    readonly slots = new Map<CVar, Slot>()
    /** Struct members in order: the declaration lines (without indentation). */
    readonly lines: string[] = []
    /** `typedef struct { ... } <name>;` of the chart's classes and structs, before TickData. */
    readonly typedefs: string[] = []
    readonly variables: CVariable[] = []
    /** Instances of classes, structs and charts used as classes (KIELER's data pool reports each as an object). */
    readonly instances: { name: string; member: string; ctype: string; pool?: string }[] = []
    private readonly used = new Set<string>()
    private readonly maxSuffix = new Map<string, number>()

    /**
     * `declarationOf`: the source declaration of a variable, so that instances declared together share a line
     * (`Counter home, away;`).
     */
    constructor(readonly compiled: CompiledChart, readonly chartName: string, takenCount: number | undefined, extra: CVar[], declarationOf: (v: CVar) => object | undefined = () => undefined) {
        const core = compiled.core
        const rootDecls = core.decls
        // The leading source declarations (not signals): `_taken_transitions` comes right after them (memory.ts).
        let taken = takenCount !== undefined
        const placeTaken = () => {
            if (!taken) return
            taken = false
            this.lines.push(`int _taken_transitions[${Math.max(1, takenCount!)}];`)
            this.used.add('_taken_transitions')
        }
        const classes = new Map<string, string>()
        // Charts used as classes and `ref C g(...)` instances (passes/reference.ts): their fields are variables whose
        // instance is no declaration any more; one without fields is known by name only.
        const rootSet = new Set(rootDecls)
        const empty = new Set((core.ext.emptyInstances as string[] | undefined) ?? [])
        const chartInstanceOf = (v: CVar): string | undefined => {
            if (v.member && !rootSet.has(v.member.of)) return v.member.of.name
            const at = v.decl?.indexOf('$') ?? -1
            const slash = v.decl?.indexOf('/', at) ?? -1
            const inst = at >= 0 && slash > at ? v.decl!.slice(at + 1, slash) : undefined
            return inst !== undefined && empty.has(inst) ? inst : undefined
        }
        const placed = new Set<string>()
        for (let i = 0; i < rootDecls.length; i++) {
            const v = rootDecls[i]
            const inst = chartInstanceOf(v)
            if (inst !== undefined) {
                if (!placed.has(inst)) {
                    placed.add(inst)
                    this.chartInstance(inst, rootDecls, classes)
                }
                continue
            }
            if (v.const || v.extern || v.declKind === 'method' || v.declKind === 'enum' || v.member) continue
            if (v.generated || v.role === 'presence' || v.role === 'value' || v.role === 'curval') placeTaken()
            if (v.declKind === 'class' || v.declKind === 'struct') {
                if (this.slots.has(v)) continue
                // Instances of one declaration share a line, as KIELER declares them (`Counter home, away;`).
                const type = this.classType(v, rootDecls, classes)
                const decl = declarationOf(v)
                const group = [v, ...(decl ? rootDecls.slice(i + 1).filter(w => w.declKind === v.declKind && declarationOf(w) === decl) : [])]
                const names = group.map(w => {
                    const n = this.unique(identifier(w.name))
                    this.instance(w, n, rootDecls)
                    this.instances.push({ name: w.name, member: n, ctype: type })
                    return n
                })
                this.lines.push(`${type} ${names.join(', ')};`)
                continue
            }
            if (v.declKind) continue
            this.plain(v, this.unique(identifier(v.name)), true)
        }
        placeTaken()
        // Inner states' and regions' locals (KIELER's Valued Object Rise), then what only the code refers to (the frames
        // of inlined methods).
        for (const scope of allScopes(core).slice(1)) {
            for (const v of scope.decls) {
                if (this.slots.has(v) || v.const || v.extern || v.declKind === 'method' || v.declKind === 'enum') continue
                if (v.member) continue
                const name = this.unique(`_${chartName}_local_${identifier(v.name)}`)
                if (v.declKind === 'class' || v.declKind === 'struct') {
                    const type = this.classType(v, scope.decls, classes)
                    this.instance(v, name, scope.decls)
                    this.lines.push(`${type} ${name};`)
                    continue
                }
                if (v.declKind) continue
                this.plain(v, name, false)
            }
        }
        for (const inst of empty) if (!placed.has(inst)) this.chartInstance(inst, rootDecls, classes)
        for (const v of extra) if (!this.slots.has(v) && !v.declKind) this.plain(v, this.unique(identifier(v.name)), false)
    }

    /** An instance of a chart used as a class: `<Chart>_<Referenced>1 c;` (KIELER's naming) with the chart's fields. */
    private chartInstance(inst: string, decls: CVar[], classes: Map<string, string>) {
        const members = decls.filter(m => m.member?.of.name === inst && !m.declKind)
        // Ids inside the instance are `<Chart>$<instance>/<Referenced chart>[/<Base>]$<name>`.
        const id = decls.map(m => m.decl ?? '').find(d => d.includes(`$${inst}/`)) ?? ''
        const rest = id.slice(id.indexOf(`$${inst}/`) + inst.length + 2)
        const chart = rest ? rest.split(/[/$]/)[0] : inst
        const fields = members.map(m => `${ctypeOf(m)} ${identifier(m.member!.name)}${dimsOf(m).map(n => `[${n}]`).join('')};`)
        const key = `chart ${chart}|${fields.join(' ')}`
        let type = classes.get(key)
        if (!type) {
            type = this.unique(`${this.chartName}_${identifier(chart)}1`)
            classes.set(key, type)
            this.typedefs.push(`typedef struct {\n${fields.map(f => `  ${f}\n`).join('')}} ${type};\n`)
        }
        const name = this.unique(identifier(inst))
        this.lines.push(`${type} ${name};`)
        this.instances.push({ name: inst, member: name, ctype: type, pool: inst })
        for (const m of members) {
            const member = `${name}.${identifier(m.member!.name)}`
            this.slots.set(m, { v: m, member })
            if (m.tags.has('#const-member')) continue
            this.variables.push({
                name: `${inst}.${m.member!.name}`, member, ctype: ctypeOf(m), type: simpleType(m), dims: dimsOf(m),
                input: false, output: false, pool: m.member!.name, poolObject: inst,
            })
        }
    }

    /** Reserves a member name (KIELER's UniqueNameCache: `x`, then `x1`, `x2`, ...). */
    unique(base: string): string {
        let name = RESERVED.has(base) ? `${base}_` : base
        if (this.used.has(name)) {
            let n = this.maxSuffix.get(name) ?? 0
            do n++
            while (this.used.has(name + n))
            this.maxSuffix.set(name, n)
            name = name + n
        }
        this.used.add(name)
        return name
    }

    /** The C lvalue of a variable (`d->x`), or undefined for one the struct does not have. */
    member(v: CVar): string | undefined {
        return this.slots.get(v)?.member
    }

    private plain(v: CVar, name: string, root: boolean) {
        const dims = dimsOf(v)
        this.slots.set(v, { v, member: name })
        this.lines.push(`${ctypeOf(v)} ${name}${dims.map(n => `[${n}]`).join('')};`)
        // KIELER's data pool: the chart's top-level variables, without its helpers (names starting with `_`).
        const pool = root && !v.name.startsWith('_') ? v.name : undefined
        if (!pool && (v.generated || !v.decl)) return
        this.variables.push({
            name: root ? v.name : v.display ?? v.name, member: name, ctype: ctypeOf(v), type: simpleType(v), dims,
            input: v.input, output: v.output, pool,
            signal: v.role === 'presence' || v.role === 'value' || v.role === 'curval' ? v.role : undefined,
        })
    }

    /** The members of a class or struct instance: `<instance>.<member>`. */
    private instance(v: CVar, name: string, decls: CVar[]) {
        this.slots.set(v, { v, member: name })
        for (const m of decls) {
            if (m.member?.of !== v || m.declKind) continue
            const member = `${name}.${identifier(m.member.name)}`
            this.slots.set(m, { v: m, member })
            if (m.tags.has('#const-member')) continue
            this.variables.push({
                name: `${v.name}.${m.member.name}`, member, ctype: ctypeOf(m), type: simpleType(m), dims: dimsOf(m),
                input: false, output: false, pool: name === v.name ? m.member.name : undefined, poolObject: name === v.name ? v.name : undefined,
            })
        }
    }

    /** The typedef of an instance's class (`<Chart>_<Class>`), declared once per class. */
    private classType(v: CVar, decls: CVar[], classes: Map<string, string>): string {
        if (v.tags.has('#host') && v.hostType) return v.hostType
        const members = decls.filter(m => m.member?.of === v && !m.declKind)
        // The class's name: the member declarations' ids are `<Chart>$<Class>.<member>`.
        const id = members[0]?.decl ?? v.decl ?? v.name
        const cls = /\$([^.$]+)\.[^.]*$/.exec(id)?.[1] ?? v.name
        const key = `${cls}|${members.map(m => `${ctypeOf(m)} ${m.member!.name}${dimsOf(m).map(n => `[${n}]`).join('')}`).join(';')}`
        let type = classes.get(key)
        if (!type) {
            type = this.unique(`${this.chartName}_${identifier(cls)}`)
            classes.set(key, type)
            const body = members.map(m => `  ${ctypeOf(m)} ${identifier(m.member!.name)}${dimsOf(m).map(n => `[${n}]`).join('')};`)
            this.typedefs.push(`typedef struct {\n${body.map(b => `${b}\n`).join('')}} ${type};\n`)
        }
        return type
    }
}

/** Every variable the code refers to (to give the frames of inlined methods a place in the struct). */
export function referencedVars(nodes: { effect?: CEffect; expr?: CExpr }[], bodies: CStmt[][]): CVar[] {
    return [...accessed(nodes, bodies, true)]
}

/** Every variable the code reads (an assignment's target only through its indices, or with a compound operator). */
export function readVars(nodes: { effect?: CEffect; expr?: CExpr }[], bodies: CStmt[][]): Set<CVar> {
    return accessed(nodes, bodies, false)
}

function accessed(nodes: { effect?: CEffect; expr?: CExpr }[], bodies: CStmt[][], targets: boolean): Set<CVar> {
    const out = new Set<CVar>()
    const visit = (e: CExpr) => { if (e.k === 'ref') out.add(e.v) }
    const effect = (f: CEffect) => {
        if (f.k === 'assign') {
            if (targets || f.op !== '=') walkExpr(f.ref, visit)
            else f.ref.idx.forEach(i => walkExpr(i, visit))
            walkExpr(f.expr, visit)
        }
        else if (f.k === 'print') f.args.forEach(a => walkExpr(a, visit))
        else if (f.k === 'call') walkExpr(f.call, visit)
    }
    for (const n of nodes) {
        if (n.effect) effect(n.effect)
        walkExpr(n.expr, visit)
    }
    const stmts = (list: CStmt[]) => {
        for (const s of list) {
            if (s.k === 'do') effect(s.f)
            else if (s.k === 'if') { walkExpr(s.cond, visit); stmts(s.then); if (s.else) stmts(s.else) }
            else if (s.k === 'while') { walkExpr(s.cond, visit); stmts(s.body) }
            else if (s.k === 'for') { stmts(s.init); walkExpr(s.cond, visit); stmts(s.update); stmts(s.body) }
            else if (s.k === 'return') walkExpr(s.expr, visit)
            else if (s.k === 'expr') walkExpr(s.e, visit)
        }
    }
    bodies.forEach(stmts)
    return out
}

// What lies next to an array in KIELER's C simulation, for indices outside it (basics.md B-28). C does not check
// indices, and KIELER keeps every variable of the chart in one struct (TickData, scg/processors/codegen/c/
// CCodeGeneratorStructModule): the chart's own top-level declarations first, in the order written (constants and
// signals are not there: KIELER's Const processor removes the constants, its Signal processor declares signals anew
// at the end), then Taken Transition Signaling's `int _taken_transitions[n]`, then everything KIELER generates. So
// with `output int a[3]` and `output int z` next, `a[3] = 9` writes z, and `a[-1]` is whatever comes before a.
//
// The layout is the x86-64 one gcc uses: a bool is a `char` (1 byte), an int 4 bytes, a float a `double` (8), a
// string a pointer (8), each aligned to its size, with padding in between (which an out-of-range write can fill
// and a read give back). Only the part up to the taken counters is known; an access beyond it, or of a pointer
// that is not a whole pointer of a string variable, is a runtime error saying so. Probes kieler/rare/
// probe-overflow-*, checked byte by byte (an int written over two bools sets both).

import type { Declaration, Diagnostic, Span, State } from '../types'
import { allActionSites, effectExprs, walkExpr, type CEffect, type CExpr, type CRef, type CState, type CVar } from './model'
import { SimError, type Runtime } from './eval'
import type { RValue } from './values'

type Kind = 'int' | 'char' | 'double' | 'ptr'
const SIZE: Record<Kind, number> = { int: 4, char: 1, double: 8, ptr: 8 }

interface Member {
    v: CVar
    slot: number
    offset: number
    kind: Kind
    /** Elements (1 for a scalar). */
    count: number
    dims: number[]
}

/** The element at a byte offset: a member's element and the byte within it. */
interface Place { m: Member; element: number; byte: number }

const kindOf = (type: string | undefined): Kind | undefined => {
    switch (type) {
        case 'int': return 'int'
        case 'bool': return 'char'
        case 'float': return 'double'
        case 'string': return 'ptr'
        default: return undefined
    }
}

export class Memory {
    private readonly members: Member[] = []
    private readonly byVar = new Map<CVar, Member>()
    /** Where the part of the struct the guide knows ends (the taken counters start there). */
    private readonly known: number
    private readonly takenEnd: number

    /**
     * `chart` is the simulated chart as written; `slotOf` finds a top-level declaration's variable and slot.
     * `padding` is a slot for the padding bytes. `taken`: the number of transitions KIELER counts.
     */
    constructor(chart: State, slotOf: (id: string) => { v: CVar; slot: number; dims: number[] } | undefined, readonly padding: number, taken: number) {
        let offset = 0
        let stopped = !!chart.baseStates?.length
        for (const d of chart.declarations) {
            if (stopped) break
            if (d.declKind === 'method' || d.declKind === 'enum') continue
            if (!plain(d)) {
                if (d.declKind === 'variable' && (d.const || d.signal)) continue
                stopped = true
                break
            }
            const kind = kindOf(d.type)
            if (!kind) { stopped = true; break }
            for (const vo of d.valuedObjects) {
                const found = slotOf(vo.id)
                if (!found) { stopped = true; break }
                const count = found.dims.reduce((a, b) => a * b, 1)
                offset = align(offset, SIZE[kind])
                const m: Member = { v: found.v, slot: found.slot, offset, kind, count, dims: found.dims }
                this.members.push(m)
                this.byVar.set(found.v, m)
                offset += count * SIZE[kind]
            }
        }
        // Up to the counters (or, when something unknown comes first, up to that): padding included.
        this.known = stopped ? offset : align(offset, 4)
        this.takenEnd = stopped ? offset : this.known + 4 * taken
    }

    /** The struct's known part ends where the chart's variables end: an array outside it cannot be laid out. */
    has(v: CVar): boolean {
        return this.byVar.has(v)
    }

    /** Bytes of padding the struct's known part has (the padding slot's size). */
    get size(): number {
        return this.known
    }

    /** Reads element `flat` (outside its bounds) of array `v`, as C does. */
    read(rt: Runtime, v: CVar, flat: number, label: string, span: Span | undefined): RValue {
        const m = this.byVar.get(v)!
        const at = m.offset + flat * SIZE[m.kind]
        const whole = this.wholeElement(at, m.kind)
        if (whole) return this.get(rt, whole.m, whole.element)
        if (m.kind === 'ptr') throw this.unknown(v, flat, label, span, false, at)
        const bytes: number[] = []
        for (let i = 0; i < SIZE[m.kind]; i++) {
            const b = this.byteAt(rt, at + i)
            if (b === undefined) throw this.unknown(v, flat, label, span, false, at)
            bytes.push(b)
        }
        return decode(bytes, m.kind)
    }

    /** Writes element `flat` (outside its bounds) of array `v`, as C does; returns what it overwrote, for the log. */
    write(rt: Runtime, v: CVar, flat: number, value: RValue, label: string, span: Span | undefined): { names: string[] } {
        const m = this.byVar.get(v)!
        const at = m.offset + flat * SIZE[m.kind]
        const whole = this.wholeElement(at, m.kind)
        if (whole) {
            this.set(rt, whole.m, whole.element, value)
            return { names: [this.name(whole.m, whole.element)] }
        }
        if (m.kind === 'ptr' || typeof value !== 'number') throw this.unknown(v, flat, label, span, true, at)
        const bytes = encode(value, m.kind)
        for (let i = 0; i < bytes.length; i++) if (this.byteAt(rt, at + i) === undefined) throw this.unknown(v, flat, label, span, true, at)
        const names: string[] = []
        for (let i = 0; i < bytes.length; i++) {
            const place = this.placeAt(at + i)
            if (!place) {
                (rt.vals[this.padding] as number[])[at + i] = bytes[i]
                continue
            }
            const old = encode(this.get(rt, place.m, place.element) as number, place.m.kind)
            old[place.byte] = bytes[i]
            this.set(rt, place.m, place.element, decode(old, place.m.kind))
            const n = this.name(place.m, place.element)
            if (!names.includes(n)) names.push(n)
        }
        return { names }
    }

    /** What `v[flat]` is in KIELER's struct, for messages: the variables or elements there (none: padding), or
     *  undefined when it is outside the part the guide knows. */
    describe(v: CVar, flat: number): string[] | undefined {
        const m = this.byVar.get(v)
        if (!m) return undefined
        const at = m.offset + flat * SIZE[m.kind]
        const whole = this.wholeElement(at, m.kind)
        if (whole) return [this.name(whole.m, whole.element)]
        const names: string[] = []
        for (let i = 0; i < SIZE[m.kind]; i++) {
            if (at + i < 0 || at + i >= this.known) return undefined
            const place = this.placeAt(at + i)
            if (place?.m.kind === 'ptr' && m.kind !== 'ptr') return undefined
            const n = place ? this.name(place.m, place.element) : undefined
            if (n && !names.includes(n)) names.push(n)
        }
        return names
    }

    private wholeElement(at: number, kind: Kind): Place | undefined {
        const p = this.placeAt(at)
        return p && p.byte === 0 && p.m.kind === kind ? p : undefined
    }

    private placeAt(at: number): Place | undefined {
        for (const m of this.members) {
            const size = SIZE[m.kind]
            if (at >= m.offset && at < m.offset + m.count * size) {
                const rel = at - m.offset
                return { m, element: Math.floor(rel / size), byte: rel % size }
            }
        }
        return undefined
    }

    /** The byte at an offset of the known part (members and padding); undefined outside it or inside a pointer. */
    private byteAt(rt: Runtime, at: number): number | undefined {
        if (at < 0 || at >= this.known) return undefined
        const p = this.placeAt(at)
        if (!p) return (rt.vals[this.padding] as number[])[at] ?? 0
        if (p.m.kind === 'ptr') return undefined
        return encode(this.get(rt, p.m, p.element) as number, p.m.kind)[p.byte]
    }

    private get(rt: Runtime, m: Member, element: number): RValue {
        let v = rt.vals[m.slot]
        for (const i of path(m.dims, element)) v = (v as RValue[])[i]
        return v
    }

    private set(rt: Runtime, m: Member, element: number, value: RValue) {
        if (!m.dims.length) {
            rt.vals[m.slot] = value
            return
        }
        const p = path(m.dims, element)
        let v = rt.vals[m.slot] as RValue[]
        for (let k = 0; k < p.length - 1; k++) v = v[p[k]] as RValue[]
        v[p[p.length - 1]] = value
    }

    private name(m: Member, element: number): string {
        const n = m.v.display ?? m.v.name
        return m.dims.length ? `${n}[${path(m.dims, element).join('][')}]` : n
    }

    private unknown(v: CVar, flat: number, label: string, span: Span | undefined, writing: boolean, at: number): SimError {
        const m = this.byVar.get(v)!
        const where = at < 0
            ? 'before the chart\'s variables'
            : at < this.takenEnd ? 'where KIELER counts the transitions taken' : 'past the chart\'s own variables, where KIELER keeps its own bookkeeping'
        return new SimError(`Index ${flat} is outside the array ${label} (size ${m.dims.join(' × ')}): KIELER's C code would ${writing ? 'write into' : 'read'} memory ${where}`, span, 'index-out-of-range',
            `KIELER does not check array indices, and what lies there depends on its generated code, so the guide stops. Keep indices between 0 and ${m.count - 1}.`)
    }
}

function plain(d: Declaration): boolean {
    return d.declKind === 'variable' && !d.const && !d.signal && !d.static && !d.global && !d.extern && !d.hostType && !d.referenceTarget
}

const align = (n: number, a: number) => Math.ceil(n / a) * a

/** The index path of a flat (row-major) element. */
function path(dims: number[], flat: number): number[] {
    const out: number[] = new Array(dims.length)
    for (let k = dims.length - 1; k >= 0; k--) {
        out[k] = flat % dims[k]
        flat = Math.floor(flat / dims[k])
    }
    return out
}

function encode(v: number, kind: Kind): number[] {
    const buf = new DataView(new ArrayBuffer(8))
    switch (kind) {
        case 'int': buf.setInt32(0, v | 0, true); return [0, 1, 2, 3].map(i => buf.getUint8(i))
        case 'char': return [v & 0xff]
        case 'double': buf.setFloat64(0, v, true); return [0, 1, 2, 3, 4, 5, 6, 7].map(i => buf.getUint8(i))
        default: return []
    }
}

function decode(bytes: number[], kind: Kind): number {
    const buf = new DataView(new ArrayBuffer(8))
    bytes.forEach((b, i) => buf.setUint8(i, b))
    switch (kind) {
        case 'int': return buf.getInt32(0, true)
        case 'char': return buf.getInt8(0)
        case 'double': return buf.getFloat64(0, true)
        default: return 0
    }
}

/**
 * Constant indices outside their array (after constant folding and the for-region copies, whose counters are
 * constants): a warning that says what KIELER's C code reads or writes instead. KIELER itself says nothing.
 */
export function constantIndexWarnings(root: CState, chart: State, taken: number): Diagnostic[] {
    const vars = new Map<string, CVar>()
    for (const v of root.decls) if (v.decl && !v.generated && !v.role && !vars.has(v.decl)) vars.set(v.decl, v)
    const literal = (e: CExpr): number | undefined => {
        if (e.k === 'lit' && typeof e.v === 'number') return e.v
        if (e.k === 'op' && e.op === 'neg' && e.args.length === 1) { const v = literal(e.args[0]); return v === undefined ? undefined : -v }
        return undefined
    }
    const dimsOf = (v: CVar) => v.dims.map(literal)
    const memory = new Memory(chart, id => {
        const v = vars.get(id)
        const dims = v ? dimsOf(v) : []
        return v && dims.every(d => d !== undefined) ? { v, slot: -1, dims: dims as number[] } : undefined
    }, -1, taken)
    const out: Diagnostic[] = []
    const seen = new Set<string>()
    const check = (r: CRef, writing: boolean) => {
        const dims = dimsOf(r.v)
        if (!r.idx.length || r.idx.length !== dims.length || dims.some(d => d === undefined)) return
        const idx = r.idx.map(literal)
        if (idx.some(i => i === undefined)) return
        const n = dims as number[]
        if ((idx as number[]).every((i, k) => i >= 0 && i < n[k])) return
        const count = n.reduce((a, b) => a * b, 1)
        const flat = (idx as number[]).reduce((acc, i, k) => acc * n[k] + i, 0)
        const name = r.v.display ?? r.v.name
        const key = `${r.span?.start}:${flat}:${writing}`
        if (seen.has(key)) return
        seen.add(key)
        const written = `${name}[${(idx as number[]).join('][')}]`
        if (flat >= 0 && flat < count) {
            out.push({
                severity: 'warning', code: 'index-out-of-range', span: r.span,
                message: `\`${written}\` is outside the dimensions of \`${name}\` (${n.join(' × ')}), so it is the element \`${name}[${pathText(n, flat)}]\``,
                hint: 'C only computes an address from the indices and checks none of them. Write the element you mean.',
            })
            return
        }
        const what = memory.describe(r.v, flat)
        const list = (names: string[]) => names.map(x => `\`${x}\``).join(' and ')
        const into = what === undefined
            ? `memory KIELER uses for its own bookkeeping, so the guide's simulation stops with an error there`
            : !what.length ? `unused bytes next to \`${name}\` instead` : `${list(what)} instead, which ${what.length === 1 ? 'lies' : 'lie'} at that place in memory`
        out.push({
            severity: 'warning', code: 'index-out-of-range', span: r.span,
            message: `\`${written}\` is outside \`${name}\`, which has ${count} element${count === 1 ? '' : 's'}: KIELER's C code ${writing ? 'writes into' : 'reads'} ${into}`,
            hint: `KIELER does not check array indices: C reads and writes whatever lies at that place in the struct of the chart's variables. Keep indices between 0 and ${count - 1}.`,
        })
    }
    const expr = (e: CExpr | undefined) => walkExpr(e, x => { if (x.k === 'ref') check(x, false) })
    const effect = (f: CEffect) => {
        if (f.k === 'assign') { check(f.ref, true); f.ref.idx.forEach(expr); expr(f.expr) }
        else effectExprs(f).forEach(expr)
    }
    for (const site of allActionSites(root)) {
        const holder = site.transition ?? site.action!
        expr(holder.trigger)
        holder.effects.forEach(effect)
    }
    return out
}

function pathText(dims: number[], flat: number): string {
    return path(dims, flat).join('][')
}

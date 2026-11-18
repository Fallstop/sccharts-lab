// Where every variable lies in KIELER's struct (`TickData`), in bytes: what the address of an array is made of
// (pointers.ts). The struct is the one the C generator writes (codegen/layout.ts, KIELER's member order, with the
// simulation's `_taken_transitions`), laid out as gcc does on x86-64: a bool is a `char` (1 byte), an int 4, a float
// a `double` (8), a string a pointer (8), each aligned to its size; a class or struct instance is a struct of its own,
// aligned to its widest member. memory.ts knows the same order for the chart's own top-level declarations (indices
// outside an array); this is the whole struct, so that two arrays anywhere in it have a distance.

import type { CVar } from './model'
import type { CompiledChart } from './compile'
import type { SNode } from './scg'
import { Layout, referencedVars } from '../codegen/layout'
import { calledMethods } from '../codegen/methods'

/** A variable's place: the offset of its first element and, for each index a reference to it can have (those of the
 *  instance arrays it lies in first, then its own), the bytes one step of that index moves. */
export interface Place {
    offset: number
    strides: number[]
}

interface Field { name: string; type: Type; dims: number[]; offset: number }
interface Type { size: number; align: number; fields?: Field[] }

const BASIC: Record<string, Type> = {
    char: { size: 1, align: 1 }, int: { size: 4, align: 4 }, double: { size: 8, align: 8 }, 'char*': { size: 8, align: 8 },
}

const align = (n: number, a: number) => Math.ceil(n / a) * a

/** `int a[2], b;` as fields of a struct under construction. */
function declare(line: string, types: Map<string, Type>, fields: Field[], at: { offset: number; align: number }): void {
    const m = /^(.*?)\s+([^\s].*);$/.exec(line.trim())
    if (!m) return
    // A type KIELER's code only names (a host type): a pointer-sized guess keeps the rest of the layout going.
    const type = types.get(m[1].replace(/\s+/g, '')) ?? { size: 8, align: 8 }
    for (const d of m[2].split(',')) {
        const name = /^\s*([A-Za-z_]\w*)/.exec(d)?.[1]
        if (!name) continue
        const dims = [...d.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1]))
        at.offset = align(at.offset, type.align)
        fields.push({ name, type, dims, offset: at.offset })
        at.offset += type.size * dims.reduce((a, b) => a * b, 1)
        at.align = Math.max(at.align, type.align)
    }
}

function struct(lines: string[], types: Map<string, Type>): Type {
    const fields: Field[] = []
    const at = { offset: 0, align: 1 }
    for (const line of lines) declare(line, types, fields, at)
    return { size: align(at.offset, at.align), align: at.align, fields }
}

/** The place of a member path of the struct (`a`, `k.q`, `cs[].v`: each `[]` is an index the reference gives). */
function placeOf(path: string, root: Type): Place | undefined {
    let type = root
    let offset = 0
    const strides: number[] = []
    let own: number[] = []
    for (const step of path.split('.')) {
        const name = /^[A-Za-z_]\w*/.exec(step)?.[0]
        const field = type.fields?.find(f => f.name === name)
        if (!field) return undefined
        offset += field.offset
        // The indices written into the path (an instance array's) step over whole elements of the field.
        const given = (step.match(/\[\]/g) ?? []).length
        for (let k = 0; k < given; k++) strides.push(field.type.size * field.dims.slice(k + 1).reduce((a, b) => a * b, 1))
        own = field.dims.slice(given)
        type = field.type
    }
    own.forEach((_, k) => strides.push(type.size * own.slice(k + 1).reduce((a, b) => a * b, 1)))
    return { offset, strides }
}

/**
 * The places of the chart's variables in the struct of KIELER's simulation. `nodes` are the nodes that run (their
 * code decides which frames of copied methods the struct has).
 */
export function structPlaces(compiled: CompiledChart, nodes: SNode[]): { place(v: CVar): Place | undefined; size: number } {
    const exprs = nodes.flatMap(n => {
        const f = n.effect
        const own = !f ? [] : f.k === 'assign' ? (f.expr ? [f.ref, f.expr] : [f.ref]) : f.k === 'print' ? f.args : f.k === 'call' ? [f.call] : []
        return n.expr ? [n.expr, ...own] : own
    })
    const methods = calledMethods(exprs)
    const frames = new Set(methods.flatMap(m => [...m.method!.params, ...m.method!.locals]))
    const extra = referencedVars(nodes, methods.map(m => m.method!.body)).filter(v => !frames.has(v) && !v.const)
    const layout = new Layout(compiled, compiled.core.name, compiled.lowered.takenOrder.length, extra)
    const types = new Map(Object.entries(BASIC))
    for (const text of layout.typedefs) {
        const m = /^typedef struct \{\n([\s\S]*)\} (\w+);\n$/.exec(text)
        if (m) types.set(m[2], struct(m[1].split('\n').filter(l => l.trim()), types))
    }
    const root = struct(layout.lines, types)
    const cache = new Map<CVar, Place | undefined>()
    return {
        size: root.size,
        place(v) {
            if (!cache.has(v)) {
                const member = layout.member(v)
                cache.set(v, member === undefined ? undefined : placeOf(member, root))
            }
            return cache.get(v)
        },
    }
}

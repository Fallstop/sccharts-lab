// The C code generator's public types (index.ts: generateC).

import type { Diagnostic } from '../types'

/** KIELER's `#code.naming`: the names of the generated functions and of the struct. */
export interface CNaming {
    tick: string
    reset: string
    logic: string
    struct: string
}

export interface GenerateCOptions {
    /**
     * Names of the functions and the struct. `'prefix'` and `'suffix'` add the chart's name as KIELER's
     * `#code.naming "prefix"` / `"suffix"` do (`ABROtick`, `tickABRO`); an object sets any of them. Default: the chart's
     * own `#code.naming` pragma, else KIELER's `tick`, `reset`, `logic` and `TickData`.
     */
    naming?: 'default' | 'prefix' | 'suffix' | Partial<CNaming>
    /**
     * Count the fired transitions in `int _taken_transitions[n]`, as KIELER's simulation chain does (Taken Transition
     * Signaling: index order of `Simulation.takenCounts`). Off by default: KIELER's plain C chain has no counters.
     */
    takenTransitions?: boolean
    /** Comments naming the source states and transitions (default true). */
    comments?: boolean
    /** Base name of the two files (default: the chart's name): `<fileName>.h` and `<fileName>.c`. */
    fileName?: string
}

/** A variable of the chart as it lives in the generated struct. */
export interface CVariable {
    /** The name in the chart (`count`, `seconds`; a member as `home.count`). */
    name: string
    /** The member of the struct: `d->` + this is the C lvalue (`count`, `_Chart_local_seconds`, `home.count`). */
    member: string
    /** The C type of one element: `char` (bool), `int`, `double` (float), `char*` (string), or a host type. */
    ctype: string
    /** The simulator's type: 'bool', 'int', 'float', 'string' or 'host'. */
    type: 'bool' | 'int' | 'float' | 'string' | 'host'
    /** Array sizes (empty for a scalar). */
    dims: number[]
    input: boolean
    output: boolean
    /** The key under which KIELER's simulation reports it (its data pool), when it does. */
    pool?: string
    /** For a member of a class or struct instance in the pool: the instance's pool key. */
    poolObject?: string
    /** A valued signal's presence (`S`), value (`S_val`) or the value being emitted (`S_curval`). */
    signal?: 'presence' | 'value' | 'curval'
}

export interface GeneratedC {
    /** Code was generated (the chart compiles and the generator understood everything in it). */
    ok: boolean
    /** The generated chart's name. */
    chart: string
    /** File name -> contents: `<Chart>.h` and `<Chart>.c`. */
    files: Record<string, string>
    /** The header's and the C file's names (keys of `files`). */
    header: string
    source: string
    names: CNaming
    /** The chart's variables in the struct, in struct order (KIELER's helpers, `_g...`, are not listed). */
    variables: CVariable[]
    /**
     * Instances of classes, structs and charts used as classes: the struct member and its typedef. `pool`: KIELER's
     * data pool reports the instance as an object under this key even when it has no fields (`{}`).
     */
    instances: { name: string; member: string; ctype: string; pool?: string }[]
    /** Why there is no code (errors), or what to know about it (warnings, infos). */
    diagnostics: Diagnostic[]
    /** The chart uses host code (backticks, `extern`, host types, `#hostcode`): the C code carries it as written. */
    hostCode: boolean
    /**
     * The guide's simulator runs the chart too, and the code computes what the simulation shows (tools/cgen checks
     * that). False for host code and recursive methods, which only C can run (checked against KIELER's recordings).
     */
    simulated: boolean
    /** `_taken_transitions` has this many counters (takenTransitions option), in Taken Transition Signaling order. */
    takenTransitions?: string[]
}

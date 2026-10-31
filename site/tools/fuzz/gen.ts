// Random SCCharts for differential testing against KIELER (tools/fuzz/README.md). Deterministic for a seed.
//
// A chart is a random region tree: states (some superstates with regions, connectors, final states), transitions
// of every kind (delayed, immediate, weak and strong aborts, terminations, count delays, history, deferred), local
// actions (entry, during, exit, weak and strong, with triggers), suspensions, signals (pure, valued, combined),
// references to generated charts, for-regions, dataflow regions, abort regions, clocks (also with @ClocksUseSD) and a
// class instance with methods. A profile chooses which
// features a chart may use, and how often; the combination profiles stack the features whose interplay matters.
//
// Effects and triggers are drawn so that most charts are not trivially rejected: inside concurrent regions,
// writes are commuting updates (x += 1) and emissions; reads of variables written concurrently are rarer.

export type Feature =
    | 'hierarchy' | 'concurrency' | 'connectors' | 'immediate' | 'pre' | 'data'
    | 'signals' | 'valued' | 'actions' | 'aborts' | 'joins' | 'count' | 'suspend' | 'weakSuspend' | 'history'
    | 'deferred' | 'finalRegions' | 'abortRegions' | 'references' | 'forRegions' | 'dataflow' | 'locals'
    | 'clocks' | 'classes' | 'structs' | 'enums' | 'code' | 'labels'
    /** The cheat sheet's rare forms: `state(R.S)` in a method, `scchart(C).K`, primed and `^` names. Not in `mix`. */
    | 'rare'
    /** The final polish's forms: conditionals without else (`(a) ? b`), `pre(x, c)` next to `pre(x)`, gotos in code
     *  blocks (forward, and now and then back), writes outside an array (`ov[2]` is `ovz`). Not in `mix`. */
    | 'polish'

export const ALL_FEATURES: Feature[] = [
    'hierarchy', 'concurrency', 'connectors', 'immediate', 'pre', 'data', 'signals', 'valued', 'actions', 'aborts',
    'joins', 'count', 'suspend', 'weakSuspend', 'history', 'deferred', 'finalRegions', 'abortRegions', 'references',
    'forRegions', 'dataflow', 'locals', 'clocks', 'classes', 'structs', 'enums', 'code', 'labels',
]

export interface Profile {
    /** Features always on. */
    features: Feature[]
    /** Features each chart takes with probability `optionalRate`. */
    optional?: Feature[]
    optionalRate?: number
    /** Probability multipliers for some choices. */
    weights?: Partial<Record<'super' | 'immediate' | 'strong' | 'regions' | 'reference' | 'chain' | 'count', number>>
    /** Number of top-level regions (default: 1, or 2 with probability 0.35 when concurrency is on). */
    roots?: number[]
    /** Deepest level that has superstates (default 2: superstates inside superstates). */
    maxDepth?: number
}

const BASE: Feature[] = ['hierarchy', 'concurrency', 'data', 'immediate', 'joins', 'aborts']

/**
 * The profiles. `mix` takes a random subset of everything; the others focus on one area or on a combination
 * (the names the campaign reports use).
 */
export const PROFILES: Record<string, Profile> = {
    mix: { features: ['hierarchy'], optional: ALL_FEATURES, optionalRate: 0.45 },
    basics: { features: ['hierarchy', 'connectors', 'immediate', 'pre', 'data', 'locals'], weights: { immediate: 1.5 } },
    signals: { features: [...BASE, 'signals', 'valued', 'pre'], weights: { regions: 1.5 } },
    preemption: { features: [...BASE, 'actions', 'count', 'suspend', 'weakSuspend', 'history', 'deferred', 'finalRegions', 'connectors'] },
    structure: { features: [...BASE, 'references', 'forRegions', 'dataflow', 'signals'] },
    abortRegions: { features: [...BASE, 'abortRegions', 'actions'], optional: ['signals', 'count', 'suspend', 'history'], optionalRate: 0.3, weights: { regions: 1.6 } },
    // The combinations.
    refAborts: { features: [...BASE, 'references', 'actions'], optional: ['signals', 'abortRegions', 'count'], optionalRate: 0.3, weights: { reference: 2, strong: 1.5, regions: 1.4 } },
    historySuspend: { features: [...BASE, 'history', 'suspend', 'weakSuspend', 'actions'], optional: ['deferred', 'count'], optionalRate: 0.3 },
    countFor: { features: [...BASE, 'forRegions', 'count'], optional: ['actions', 'signals', 'suspend'], optionalRate: 0.3 },
    signalStrong: { features: [...BASE, 'signals', 'valued'], optional: ['actions', 'count', 'abortRegions'], optionalRate: 0.3, weights: { strong: 2, regions: 1.5 } },
    dataflowControl: { features: [...BASE, 'dataflow', 'pre'], optional: ['signals', 'actions', 'references'], optionalRate: 0.3 },
    immediateChains: { features: [...BASE, 'connectors', 'actions'], optional: ['signals', 'history', 'count', 'abortRegions'], optionalRate: 0.25, weights: { immediate: 2.5, chain: 2 } },
    timedClasses: { features: [...BASE, 'clocks', 'classes'], optional: ['actions', 'signals', 'abortRegions', 'references', 'count'], optionalRate: 0.3 },
    // What beginners write: signals, aborts, pre and count delays in two or three regions.
    beginner: { features: ['hierarchy', 'concurrency', 'data', 'signals', 'aborts', 'pre', 'count', 'joins'], optional: ['immediate', 'actions', 'valued', 'labels'], optionalRate: 0.35, weights: { count: 2, strong: 1.3, super: 0.7, immediate: 0.6 }, roots: [2, 2, 3], maxDepth: 1 },
    // The newest features: abort regions, classes, structs and enums, methods and code blocks with if/for/while, labels.
    objects: { features: [...BASE, 'classes', 'structs', 'enums', 'code', 'labels'], optional: ['abortRegions', 'signals', 'count', 'actions', 'pre'], optionalRate: 0.35 },
    abortObjects: { features: [...BASE, 'abortRegions', 'actions', 'labels'], optional: ['classes', 'structs', 'enums', 'code', 'signals', 'count'], optionalRate: 0.4, weights: { regions: 1.6 } },
    // The rare forms the cheat sheet lists, among ordinary behaviour.
    rare: { features: [...BASE, 'rare'], optional: ['signals', 'count', 'actions', 'pre', 'classes'], optionalRate: 0.35, roots: [1, 2, 2], maxDepth: 1 },
    // The final polish's forms (engine-5) among ordinary behaviour.
    polish: { features: [...BASE, 'polish', 'pre'], optional: ['signals', 'count', 'actions', 'code'], optionalRate: 0.35, roots: [1, 2, 2], maxDepth: 1 },
}

/** A small, fast, seedable PRNG (mulberry32). */
export class Rng {
    private s: number
    constructor(seed: number) {
        this.s = seed >>> 0
    }
    next(): number {
        let t = (this.s += 0x6d2b79f5)
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    chance(p: number): boolean {
        return this.next() < p
    }
    int(lo: number, hi: number): number {
        return lo + Math.floor(this.next() * (hi - lo + 1))
    }
    pick<T>(list: readonly T[]): T {
        return list[Math.floor(this.next() * list.length)]
    }
}

export interface Job {
    name: string
    model: string
    inputs: Record<string, boolean | number>[]
    profile: string
    features: Feature[]
}

interface Scope {
    /** Inside concurrent regions (or a dataflow's neighbour): conflicting writes would be rejected. */
    conc: boolean
    depth: number
    /** Variable names usable here (a referenced chart has its own interface). */
    bools: string[]
    ints: string[]
    outs: string[]
    signals: string[]
    valued: string[]
    /** for-region counter in scope. */
    counter?: string
    /** The chart's clock, and whether it may be shared (@ClocksUseSD). */
    clock?: string
    sharedClock?: boolean
    /** A class instance with inc() and get() (and, with code, bump(k), sum(k) and halve(k)). */
    object?: string
    /** A struct instance with members px and py. */
    struct?: string
    /** A `ref Mode` variable of an enum Mode { IDLE, RUN, HALT }. */
    mode?: string
    /** Rare forms: a method reading `state(R0.R0s1)`, a chart with constants (`scchart(FK).K`), a primed constant. */
    rare?: { at?: string; konst?: string; prime?: string }
}

class Generator {
    private readonly on: (f: Feature) => boolean
    private readonly w: (k: keyof NonNullable<Profile['weights']>) => number
    private children: string[] = []
    private childNames: string[] = []

    constructor(private readonly rng: Rng, readonly features: Set<Feature>, readonly profile: Profile) {
        this.on = f => features.has(f)
        this.w = k => profile.weights?.[k] ?? 1
    }

    trigger(s: Scope): string {
        const r = this.rng
        const opts: string[] = [...s.bools, ...s.bools.map(b => `!${b}`)]
        if (s.bools.length > 1) opts.push(`${s.bools[0]} && !${s.bools[1]}`, `${s.bools[0]} || ${s.bools[1]}`)
        for (const i of s.ints) opts.push(`${i} > 1`, `${i} == 2`)
        if (this.on('pre') && s.bools.length) opts.push(`pre(${r.pick(s.bools)})`, `${s.bools[0]} && !pre(${s.bools[0]})`)
        if (s.counter) opts.push(`${s.counter} == 1`)
        if (s.clock && (!s.conc || s.sharedClock)) opts.push(`${s.clock} >= 300`, `${s.clock} >= 500`, `${s.clock} > 200`)
        if (s.object) opts.push(`${s.object}.get() > 1`)
        if (s.object && this.on('code')) opts.push(`${s.object}.sum(n) > 2`, `${s.object}.halve(${s.object}.get()) == 2`)
        if (s.struct) opts.push(`${s.struct}.px > 1`, `${s.struct}.py == 0`)
        if (s.mode) opts.push(`${s.mode} == Mode.RUN`, `${s.mode} != Mode.IDLE`)
        if (s.rare?.at) opts.push(`${s.rare.at}()`, `!${s.rare.at}()`, `a && ${s.rare.at}()`)
        if (s.rare?.konst) opts.push(`scchart(${s.rare.konst}).ON && b`, `n > scchart(${s.rare.konst}).K`)
        if (s.rare?.prime) opts.push(`n == ${s.rare.prime}`)
        if (this.on('polish') && s.bools.length > 1) {
            const [p, q] = [r.pick(s.bools), r.pick(s.bools)]
            opts.push(`(${p}) ? ${q}`, `${q} && ((${p}) ? (!${q}))`, `pre(n, ${p}) > 1`, `pre(n) == pre(n, ${q})`, `ov[n % 3] > 0`)
        }
        // Reads of outputs and signals: dependencies on writers (more of them outside concurrency).
        const reads: string[] = []
        for (const o of s.outs) reads.push(`${o} > 2`, `${o} < 3`)
        if (this.on('pre')) for (const o of s.outs) reads.push(`pre(${o}) > 1`)
        if (this.on('signals')) for (const sig of s.signals) reads.push(sig)
        if (this.on('valued')) for (const v of s.valued) reads.push(`val(${v}) > 1`, v)
        if (reads.length && r.chance(s.conc ? 0.12 : 0.45)) return r.pick(reads)
        return r.pick(opts)
    }

    effect(s: Scope): string {
        const r = this.rng
        const n = r.chance(0.3) ? 2 : 1
        const out: string[] = []
        for (let i = 0; i < n; i++) {
            const opts: string[] = []
            for (const o of s.outs) opts.push(`${o} += 1`, `${o}++`)
            if (!s.conc && s.outs.length) {
                const [o1, o2] = [r.pick(s.outs), r.pick(s.outs)]
                opts.push(`${o1} = ${o2} + 1`, `${o1} = 0`)
                if (s.ints.length) opts.push(`${o1} = ${r.pick(s.ints)}`)
            }
            if (this.on('signals')) for (const sig of s.signals) opts.push(sig)
            if (this.on('valued')) for (const v of s.valued) opts.push(`${v}(1)`, s.ints.length ? `${v}(${s.ints[0]})` : `${v}(2)`)
            if (s.counter && this.on('forRegions')) opts.push(`arr[${s.counter}] += 1`)
            if (s.clock && (!s.conc || s.sharedClock)) opts.push(`${s.clock} = 0`)
            if (s.object) opts.push(`${s.object}.inc()`)
            if (s.object && this.on('code')) opts.push(`${s.object}.bump(n)`)
            if (s.struct) opts.push(`${s.struct}.px += 1`, ...(s.conc ? [] : [`${s.struct}.py = ${s.struct}.px + 1`, `${s.struct}.px = n`]))
            if (s.mode && !s.conc) opts.push(`${s.mode} = Mode.RUN`, `${s.mode} = Mode.HALT`, `${s.mode} = Mode.IDLE`)
            if (s.rare?.konst) for (const o of s.outs) opts.push(`${o} += scchart(${s.rare.konst}).K`)
            if (s.rare?.prime) for (const o of s.outs) opts.push(`${o} += ${s.rare.prime}`)
            if (this.on('polish') && s.outs.length) {
                const o = r.pick(s.outs)
                const p = r.pick(s.bools)
                opts.push(`${o} += (${p}) ? 1`, this.gotoEffect(s))
                if (!s.conc) opts.push(`${o} = (${p}) ? n`, `${o} = 1 + ((${p}) ? pre(n, ${r.pick(s.bools)}))`, `ov[2] = ${o}`, `ovz = ov[n % 3]`)
            }
            if (this.on('code') && s.outs.length && r.chance(0.3)) opts.push(this.codeEffect(s))
            if (opts.length) out.push(r.pick(opts))
        }
        return [...new Set(out)].join('; ')
    }

    /** A code effect `{ ...; }` with if/else or a for loop (only commuting updates inside concurrency). */
    codeEffect(s: Scope): string {
        const r = this.rng
        const [o1, o2] = [r.pick(s.outs), r.pick(s.outs)]
        const upd = (o: string) => (s.conc ? `${o} += 1;` : r.pick([`${o} += 1;`, `${o} = ${o2} + 1;`, `${o}++;`]))
        const cond = r.pick(s.ints.length ? [`${s.ints[0]} > 1`, `${s.ints[0]} == 2`] : ['true'])
        switch (r.int(0, 2)) {
            case 0: return `{ ${upd(o1)} }`
            case 1: return `{ if (${cond}) { ${upd(o1)} } else { ${upd(o2)} } }`
            default: return `{ for (int j = 0; j < ${r.pick(['2', s.ints[0] ?? '1'])}; j++) { ${upd(o1)} } }`
        }
    }

    /** A code block with a goto: forward (skipping an update), now and then backward (a loop KIELER rejects). */
    gotoEffect(s: Scope): string {
        const r = this.rng
        const [o1, o2] = [r.pick(s.outs), r.pick(s.outs)]
        const p = r.pick(s.bools)
        if (r.chance(0.04)) return `{ again: ${o1} += 1; if (${o1} < 3) { goto again } }`
        if (r.chance(0.3)) return `{ if (${p}) { goto skip; ${o1} += 1; skip: } ${o2} += 1 }`
        return `{ if (${p}) { goto skip } ${o1} += 1; skip: ${o2} += 1 }`
    }

    /** ` label "..."` on some transitions and actions. */
    label(): string {
        return this.on('labels') && this.rng.chance(0.3) ? ` label "${this.rng.pick(['go', 'step on', 'wait', 'count'])}"` : ''
    }

    /** A region's states; returns the lines and whether the region has a final state. */
    region(s: Scope, pad: string, prefix: string): { lines: string[]; final: boolean } {
        const r = this.rng
        const out: string[] = []
        const k = r.int(2, s.depth === 0 ? 4 : 3)
        const names = Array.from({ length: k }, (_, i) => `${prefix}s${i}`)
        const final = s.depth > 0 && r.chance(0.75)
        const conn = this.on('connectors') && k > 2 && r.chance(0.25)
        const supers = new Set<string>()
        for (let i = 0; i < k; i++) {
            const name = names[i]
            const isFinal = final && i === k - 1
            const isConn = conn && i === 1 && !isFinal
            const mods: string[] = []
            if (i === 0) mods.push('initial')
            if (isFinal) mods.push('final')
            if (isConn) mods.push('connector')
            const head = `${pad}${mods.length ? mods.join(' ') + ' ' : ''}state ${name}`
            // A reference to a generated chart.
            if (!isFinal && !isConn && this.on('references') && s.depth < 2 && r.chance(0.18 * this.w('reference'))) {
                out.push(`${head} is ${this.reference(s)}`)
                out.push(...this.transitions(s, pad, names, i, true, true, isConn))
                supers.add(name)
                continue
            }
            const sup = this.on('hierarchy') && s.depth < (this.profile.maxDepth ?? 2) && !isFinal && !isConn && r.chance((s.depth === 0 ? 0.45 : 0.28) * this.w('super'))
            const body: string[] = []
            let allFinal = true
            if (sup) {
                supers.add(name)
                const local = this.on('locals') && r.chance(0.25) ? `k${s.depth}` : undefined
                if (local) body.push(`${pad}  int ${local} = 0`)
                body.push(...this.actions(s, pad + '  ', true))
                const regions = this.on('concurrency') ? r.pick([1, 1, 2, 2, 3].map(x => Math.min(3, Math.round(x * (r.chance(0.3) ? this.w('regions') : 1))))) : 1
                const abort = this.on('abortRegions') && regions >= 2 && r.chance(0.45) ? r.pick(['first', 'last']) : undefined
                const inner: Scope = { ...s, depth: s.depth + 1, conc: s.conc || regions > 1 || body.some(b => b.includes('during')), outs: local ? [...s.outs, local] : s.outs }
                for (let ri = 0; ri < regions; ri++) {
                    const isAbort = (abort === 'first' && ri === 0) || (abort === 'last' && ri === regions - 1)
                    if (isAbort) {
                        body.push(...this.abortRegion(inner, pad + '  ', `${name}a`))
                        continue
                    }
                    if (this.on('forRegions') && !s.counter && r.chance(0.18)) {
                        body.push(`${pad}  region ${name}F${ri} for i : 0 to ${r.pick([1, 2])} {`)
                        const sub = this.region({ ...inner, counter: 'i', conc: true }, pad + '    ', `${name}f${ri}`)
                        allFinal = allFinal && sub.final
                        body.push(...sub.lines, `${pad}  }`)
                        continue
                    }
                    const fr = this.on('finalRegions') && ri === 1 && r.chance(0.3)
                    body.push(`${pad}  ${fr ? 'final ' : ''}region {`)
                    const sub = this.region(inner, pad + '    ', `${name}r${ri}`)
                    allFinal = allFinal && (sub.final || fr)
                    body.push(...sub.lines, `${pad}  }`)
                }
                if (!this.dataflowUsed && this.on('dataflow') && r.chance(0.2)) body.push(...this.dataflow(inner, pad + '  '))
            } else if (s.depth > 0 && this.on('actions') && r.chance(0.25)) {
                body.push(...this.actions(s, pad + '  ', false))
            }
            if (body.length) out.push(`${head} {`, ...body, `${pad}}`)
            else out.push(head)
            if (isFinal && r.chance(0.7)) continue
            out.push(...this.transitions(s, pad, names, i, sup, allFinal, isConn, supers))
        }
        return { lines: out, final }
    }

    private dataflowUsed = false

    /** Transitions out of state `i` of a region. */
    transitions(s: Scope, pad: string, names: string[], i: number, sup: boolean, allFinal: boolean, isConn: boolean, supers = new Set<string>()): string[] {
        const r = this.rng
        const name = names[i]
        const count = r.pick([1, 2, 2, 3])
        const list: { kind: string; line: string }[] = []
        for (let t = 0; t < count; t++) {
            let kind = 'go to'
            if (sup && this.on('aborts')) {
                const kinds = ['go to', 'abort to', ...(r.chance(0.3 * this.w('strong')) ? ['abort to'] : [])]
                if (this.on('joins') && allFinal) kinds.push('join to', 'join to')
                kind = r.pick(kinds)
            } else if (sup && this.on('joins') && allFinal && r.chance(0.4)) {
                kind = 'join to'
            }
            const immediate = isConn || (this.on('immediate') && r.chance(0.1 * this.w('immediate')))
            let target: string
            if (immediate) {
                // Forward only (mostly), so immediate loops stay rare.
                const forward = names.filter((_, j) => j > i)
                target = forward.length && !r.chance(0.08 * this.w('chain')) ? r.pick(forward) : r.pick(names)
            } else {
                target = r.chance(0.85) ? r.pick(names.filter(x => x !== name).length ? names.filter(x => x !== name) : names) : name
            }
            const last = t === count - 1
            const trig = last && r.chance(0.4) && !isConn ? undefined : this.trigger(s)
            const parts: string[] = []
            if (kind === 'join to' && r.chance(0.3)) parts.push('delayed')
            else if (immediate) parts.push('immediate')
            if (trig) {
                if (this.on('count') && kind !== 'join to' && r.chance(0.3 * this.w('count'))) parts.push(`if ${r.pick([2, 2, 3])} ${trig}`)
                else parts.push(`if ${trig}`)
            }
            if (r.chance(0.55)) {
                const e = this.effect(s)
                if (e) parts.push(`do ${e}`)
            }
            parts.push(`${kind} ${target}`)
            const mods: string[] = []
            if (this.on('deferred') && r.chance(0.15)) mods.push(r.pick(['deferred', 'deep deferred']))
            if (this.on('history') && supers.has(target) && r.chance(0.35)) mods.push(r.pick(['history', 'shallow history']))
            if (mods.length) parts.push(mods.join(' '))
            list.push({ kind, line: `${pad}${parts.join(' ')}${this.label()}` })
        }
        // KIELER wants strong aborts first (a strong abort after a weak one is rejected): mostly keep that order.
        if (r.chance(0.97)) list.sort((a, b) => (a.kind === 'abort to' ? 0 : 1) - (b.kind === 'abort to' ? 0 : 1))
        return list.map(x => x.line)
    }

    /** Local actions and suspensions of a state. */
    actions(s: Scope, pad: string, superstate: boolean): string[] {
        const r = this.rng
        const out: string[] = []
        if (this.on('actions')) {
            const kinds = superstate
                ? ['entry', 'during', 'immediate during', 'exit', 'weak entry', 'weak exit', 'strong exit']
                : ['entry', 'exit', 'during', 'immediate during']
            for (const kind of kinds) {
                if (!r.chance(superstate ? 0.16 : 0.12)) continue
                const conc = s.conc || kind.endsWith('during')
                const trig = r.chance(0.35) ? `if ${this.trigger({ ...s, conc })} ` : ''
                const e = this.effect({ ...s, conc })
                if (e) out.push(`${pad}${kind} ${trig}do ${e}${this.label()}`)
            }
        }
        if (superstate && this.on('suspend') && r.chance(0.28)) out.push(`${pad}${r.pick(['', 'immediate '])}suspend if ${this.trigger({ ...s, conc: true })}`)
        if (superstate && this.on('weakSuspend') && r.chance(0.14)) out.push(`${pad}${r.pick(['', 'immediate '])}weak suspend if ${this.trigger({ ...s, conc: true })}`)
        return out
    }

    abortRegion(s: Scope, pad: string, prefix: string): string[] {
        const r = this.rng
        const out = [`${pad}abort region ${prefix} {`, `${pad}  initial state ${prefix}W`]
        const immediate = this.on('immediate') && r.chance(0.2) ? 'immediate ' : ''
        out.push(`${pad}  ${immediate}if ${this.trigger(s)} ${r.chance(0.4) ? `do ${this.effect(s) || 'x += 1'} ` : ''}go to ${prefix}F`)
        if (r.chance(0.4)) out.push(`${pad}  if ${this.trigger(s)} do ${this.effect(s) || 'y += 1'} go to ${prefix}W`)
        out.push(`${pad}  final state ${prefix}F`, `${pad}}`)
        return out
    }

    dataflow(s: Scope, pad: string): string[] {
        const r = this.rng
        this.dataflowUsed = true
        const eqs: string[] = []
        const src = s.ints.length ? s.ints[0] : '1'
        eqs.push(r.pick([`d1 = ${src} + 1`, `d1 = ${r.pick(s.outs.length ? s.outs : ['n'])} * 2`, `d1 = ${src} > 1 ? 1 : 2`]))
        if (r.chance(0.6)) eqs.push(r.pick(['d2 = d1 + 1', 'd2 = pre(d2) + 1', `d2 = ${src} + d1`]))
        if (r.chance(0.4) && s.bools.length > 1) eqs.push(`db = ${s.bools[0]} && !${s.bools[1]}`)
        return [`${pad}dataflow {`, ...eqs.map(e => `${pad}  ${e}`), `${pad}}`]
    }

    /** A generated chart to reference (`C0(a, b, x)`); returns the call. */
    reference(s: Scope): string {
        const r = this.rng
        if (!this.childNames.length || (this.childNames.length < 2 && r.chance(0.4))) {
            const name = `C${this.childNames.length}`
            this.childNames.push(name)
            const sub = new Generator(r, new Set([...this.features].filter(f => f !== 'references' && f !== 'forRegions' && f !== 'dataflow')), { features: [] })
            // Its output is bound to a variable the referencing chart may update concurrently: commuting updates only.
            const scope: Scope = { conc: true, depth: 1, bools: ['p', 'q'], ints: [], outs: ['o'], signals: this.on('signals') ? ['T'] : [], valued: [] }
            const lines = [`scchart ${name} {`, '  input bool p, q', '  output int o = 0', ...(scope.signals.length ? ['  output signal T'] : [])]
            const body = sub.region(scope, '  ', `${name}x`)
            lines.push(...body.lines, '}')
            this.children.push(lines.join('\n'))
        }
        const child = r.pick(this.childNames)
        const [p, q] = [r.pick(s.bools), r.pick(s.bools)]
        const o = r.pick(s.outs.length ? s.outs : ['x'])
        const sig = this.on('signals') ? `, ${r.pick(s.signals.length ? s.signals : ['S'])}` : ''
        return r.chance(0.5) ? `${child}(${p}, ${q}, ${o}${sig})` : `${child}(${p} to p, ${q} to q, ${o} to o${sig ? `, ${sig.slice(2)} to T` : ''})`
    }

    chart(index: number): string {
        const r = this.rng
        const lines = [`scchart F${index} {`, '  input bool a, b, c, d', '  input int n', '  output int x = 0, y = 0, z = 0']
        const signals = this.on('signals') ? ['S'] : []
        const valued = this.on('valued') ? ['V'] : []
        if (signals.length) lines.push('  output signal S')
        if (valued.length) lines.push(`  output signal int V combine ${r.pick(['+', 'max', 'min', '+'])}`)
        if (this.on('forRegions')) lines.push('  output int arr[3] = {0, 0, 0}')
        // ov[2] is ovz in KIELER's struct of the chart's variables (basics.md B-28).
        if (this.on('polish')) lines.push('  output int ov[2] = {0, 0}', '  output int ovz = 0')
        if (this.on('dataflow')) lines.push('  output int d1 = 0, d2 = 0', '  output bool db = false')
        const shared = this.on('clocks') && r.chance(0.5)
        if (shared) lines.unshift('@ClocksUseSD')
        if (this.on('clocks')) lines.push('  clock t = 0')
        if (this.on('classes')) {
            lines.push('  class Cnt {', '    int v = 0', '    void inc() {', '      v = v + 1', '    }', '    int get() {', '      return v', '    }')
            if (this.on('code')) {
                lines.push(
                    '    void bump(int k) {', '      if (k > 1) {', '        v = v + k', '      } else {', '        v = v - 1', '      }', '    }',
                    '    int sum(int k) {', '      int s = 0', '      for (int j = 0; j < k; j++) {', '        s = s + j', '      }', '      return s', '    }',
                    '    int halve(int k) {', '      int q = k', '      while (q > 3) {', '        q = q / 2', '      }', '      return q', '    }')
            }
            lines.push('  } cnt')
        }
        if (this.on('structs')) lines.push('  struct Pt {', '    int px = 0', '    int py = 0', '  } pt')
        if (this.on('enums')) lines.push('  enum Mode { IDLE, RUN, HALT }', '  ref Mode m = Mode.IDLE')
        const rare: NonNullable<Scope['rare']> = {}
        if (this.on('rare')) {
            if (r.chance(0.6)) {
                rare.at = 'atR0s1'
                lines.push('  method bool atR0s1() {', '    return state(R0.R0s1)', '  }')
            }
            if (r.chance(0.6)) {
                rare.konst = `FK${index}`
                this.children.push(`scchart FK${index} {\n  const int K = ${r.pick([1, 2, 3])}\n  const bool ON = ${r.pick(['true', 'false'])}\n  initial state I\n}`)
            }
            if (r.chance(0.3)) {
                rare.prime = "K'"
                lines.push(`  const int K' = ${r.pick([1, 2])}`)
            }
            // A name that gcc rejects in KIELER's C code (both should reject the chart).
            if (r.chance(0.08)) lines.push(r.pick(["  output int w' = 0", '  output int ^count = 0', "  output signal S'"]))
        }
        const scope: Scope = {
            conc: false, depth: 0, bools: ['a', 'b', 'c', 'd'], ints: ['n'], outs: ['x', 'y', 'z'], signals, valued,
            clock: this.on('clocks') ? 't' : undefined, sharedClock: shared, object: this.on('classes') ? 'cnt' : undefined,
            struct: this.on('structs') ? 'pt' : undefined, mode: this.on('enums') ? 'm' : undefined,
            rare: this.on('rare') ? rare : undefined,
        }
        const roots = this.profile.roots ? r.pick(this.profile.roots) : this.on('concurrency') && r.chance(0.35) ? 2 : 1
        const rootDataflow = this.on('dataflow') && r.chance(0.6)
        const abortRoot = this.on('abortRegions') && roots === 2 && r.chance(0.2)
        for (let i = 0; i < roots; i++) {
            if (abortRoot && i === roots - 1) {
                lines.push(...this.abortRegion({ ...scope, conc: true, depth: 1 }, '  ', 'Ra'))
                continue
            }
            lines.push(`  region R${i} {`)
            const sub = this.region({ ...scope, conc: roots > 1 || rootDataflow }, '    ', `R${i}`)
            lines.push(...sub.lines, '  }')
        }
        if (rootDataflow && !this.dataflowUsed) lines.push(...this.dataflow({ ...scope, conc: true }, '  '))
        lines.push('}')
        return [lines.join('\n'), ...this.children].join('\n\n') + '\n'
    }
}

/** Inputs for `ticks` ticks (every input given in every tick, so KIELER's persistence does not matter). */
export function inputsFor(rng: Rng, ticks: number, timed = false): Record<string, boolean | number>[] {
    return Array.from({ length: ticks }, () => ({
        a: rng.chance(0.5), b: rng.chance(0.4), c: rng.chance(0.3), d: rng.chance(0.2), n: rng.int(0, 3),
        ...(timed ? { deltaT: rng.pick([0, 50, 100, 250, 400]) } : {}),
    }))
}

/** One random chart of a profile. */
export function generate(seed: number, profileName: string, index: number, ticks = 14): Job {
    const profile = PROFILES[profileName] ?? PROFILES.mix
    const rng = new Rng(seed * 7919 + index * 104729 + 17)
    const features = new Set<Feature>(profile.features)
    for (const f of profile.optional ?? []) if (rng.chance(profile.optionalRate ?? 0.4)) features.add(f)
    if (features.has('valued')) features.add('signals')
    const g = new Generator(rng, features, profile)
    const model = g.chart(index)
    return { name: `${profileName}-${seed}-${index}`, model, inputs: inputsFor(rng, ticks, features.has('clocks')), profile: profileName, features: [...features].sort() }
}
